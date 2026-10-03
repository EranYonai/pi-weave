import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { findGitRoot } from "../../core/git";
import { withMutationQueue } from "../../core/mutex";
import { parseWorkspaceLayout, type WorkspaceLayout } from "../shared/workspace";

const MAX_SNAPSHOTS = 8;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isWorkspaceViewId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

interface Snapshot {
  viewId: string;
  savedAt: number;
  layout: WorkspaceLayout;
}

interface SnapshotFile {
  version: 1;
  viewId: string;
  layout: WorkspaceLayout;
}

export interface WorkspaceStateStore {
  readLatest(): Promise<WorkspaceLayout | null>;
  write(viewId: string, layout: WorkspaceLayout): Promise<void>;
}

export function defaultWorkspaceStateDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "pi-weave", "presentation");
}

export function createWorkspaceStateStore(
  cwd: string,
  vaultRoot: string,
  stateDir = defaultWorkspaceStateDir(),
): WorkspaceStateStore {
  let directoryPromise: Promise<string> | null = null;
  const directory = (): Promise<string> => {
    directoryPromise ??= (async () => {
      const [vault, repo] = await Promise.all([canonical(vaultRoot), findGitRoot(cwd)]);
      const workspaceRoot = await canonical(repo ?? cwd);
      const id = createHash("sha256").update(JSON.stringify([vault, workspaceRoot])).digest("hex");
      return join(stateDir, id);
    })();
    return directoryPromise;
  };

  return {
    async readLatest() {
      return (await readSnapshots(await directory()))[0]?.layout ?? null;
    },
    async write(viewId, layout) {
      if (!isWorkspaceViewId(viewId)) throw new Error("viewId must be a UUID");
      const dir = await directory();
      const file = join(dir, `${viewId}.json`);
      await withMutationQueue(file, async () => {
        await writeSnapshot(dir, file, { version: 1, viewId, layout });
      });
    },
  };
}

async function canonical(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await fs.realpath(absolute);
  } catch {
    return absolute;
  }
}

async function readSnapshots(directory: string): Promise<Snapshot[]> {
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const snapshots = await Promise.all(names.filter((name) => UUID.test(name.slice(0, -5)) && name.endsWith(".json")).map(async (name) => {
    const file = join(directory, name);
    try {
      const [text, info] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file)]);
      const raw = JSON.parse(text) as SnapshotFile;
      const layout = raw.version === 1 && raw.viewId === name.slice(0, -5) ? parseWorkspaceLayout(raw.layout) : null;
      return layout ? { viewId: raw.viewId, savedAt: info.mtimeMs, layout } : null;
    } catch {
      return null;
    }
  }));
  return snapshots.filter((item): item is Snapshot => item !== null).sort((a, b) => b.savedAt - a.savedAt).slice(0, MAX_SNAPSHOTS);
}

async function writeSnapshot(directory: string, file: string, state: SnapshotFile): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(state), { encoding: "utf8", flag: "wx", mode: 0o600 });
    await fs.rename(temporary, file);
    const entries = await Promise.all((await fs.readdir(directory)).filter((name) => name.endsWith(".json")).map(async (name) => {
      const path = join(directory, name);
      try {
        return { path, mtime: (await fs.stat(path)).mtimeMs };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    }));
    const existing = entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    existing.sort((a, b) => b.mtime - a.mtime);
    await Promise.all(existing.slice(MAX_SNAPSHOTS).map(({ path }) => fs.rm(path, { force: true })));
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}
