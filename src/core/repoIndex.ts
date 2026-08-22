import { promises as fs } from "node:fs";
import { basename, join, posix } from "node:path";
import {
  currentBranch,
  changedFiles,
  defaultBranch,
  excludeOkfLocally,
  findGitRoot,
  headSha,
  listFiles,
  remotes,
  snapshotGitState,
} from "./git";
import { languageForExtension } from "./languages";
import { OKF_DIR, OKF_MANIFEST, REPOSITORY_DIR } from "./paths";
import type {
  GitState,
  RepoIdentity,
  RepoIndex,
  RepoModule,
  RepoPackage,
  RepoStructure,
  StalenessReport,
} from "./types";

/**
 * Repository knowledge: the derived, disposable index under <repo>/.okf/.
 *
 * Scope of this module: Level 0 (structure) + light Level 1 (modules,
 * packages, entry points). Source code is the source of truth; this index is
 * a compiler artifact (design §4) — it can always be regenerated.
 */

const GENERATOR = "pi-weave";

export interface ScanOptions {
  /** Cap files considered (safety valve for huge repos, design §9). */
  maxFiles?: number;
  now?: Date;
}

const DEFAULT_MAX_FILES = 100_000;

const MANIFEST_KINDS: Record<string, RepoPackage["kind"]> = {
  "package.json": "npm",
  "pyproject.toml": "python",
  "Cargo.toml": "rust",
  "go.mod": "go",
  "Gemfile": "ruby",
};

const ENTRY_POINT_CANDIDATES: RegExp[] = [
  /^src\/(index|main|mod|lib|cli)\.[jt]sx?$/,
  /^(index|main)\.[jt]sx?$/,
  /^cmd\/[^/]+\/main\.go$/,
  /^(main|__main__|app)\.py$/,
  /^src\/main\.(py|go|rs|java|kt)$/,
  /^src\/lib\.rs$/,
  /^Sources\/.*\/main\.swift$/,
];

function extensionOf(path: string): string {
  const name = posix.basename(path).toLowerCase();
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return ".dockerfile";
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(idx) : "";
}

function detectLanguages(files: string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const file of files) {
    const lang = languageForExtension(extensionOf(file));
    if (!lang) continue;
    counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function detectPackages(files: string[]): RepoPackage[] {
  const packages: RepoPackage[] = [];
  for (const file of files) {
    const kind = MANIFEST_KINDS[posix.basename(file)];
    if (!kind) continue;
    const dir = posix.dirname(file);
    packages.push({ manifestPath: file, kind, name: dir === "." ? "(root)" : posix.basename(dir) });
  }
  return packages.sort((a, b) => a.manifestPath.localeCompare(b.manifestPath));
}

/**
 * Best-effort package names from npm/pyproject/rust manifests. Read failures
 * are fine: the directory-name fallback from detectPackages remains.
 */
async function enrichPackageNames(root: string, packages: RepoPackage[]): Promise<void> {
  for (const pkg of packages) {
    try {
      const text = await fs.readFile(join(root, pkg.manifestPath), "utf8");
      const name = readNameField(text, pkg.kind);
      if (name) pkg.name = name;
    } catch {
      // manifest unreadable — keep the directory-name fallback
    }
  }
}

function readNameField(text: string, kind: RepoPackage["kind"]): string | null {
  if (kind === "npm") {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object") {
        const name = (parsed as Record<string, unknown>).name;
        if (typeof name === "string" && name.length > 0) return name;
      }
    } catch {
      return null;
    }
    return null;
  }
  // TOML-ish manifests: first `name = "..."` line wins.
  const match = /^name\s*=\s*"([^"]+)"/m.exec(text);
  return match?.[1] ?? null;
}

function detectEntryPoints(files: string[]): string[] {
  return files.filter((f) => ENTRY_POINT_CANDIDATES.some((re) => re.test(f))).sort();
}

/** Module grouping: the first 1-2 meaningful path segments, file-counted. */
function detectModules(files: string[]): RepoModule[] {
  const SKIP_TOP = new Set(["node_modules", ".git"]);
  const counts = new Map<string, number>();
  for (const file of files) {
    const segments = file.split("/");
    const top = segments[0];
    if (!top || SKIP_TOP.has(top)) continue;
    let key: string;
    if (segments.length > 2 && (top === "src" || top === "packages" || top === "apps" || top === "lib")) {
      key = `${top}/${segments[1]}`;
    } else if (segments.length > 1) {
      key = top;
    } else {
      key = "(root)";
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([path, fileCount]) => ({ path, fileCount }))
    .sort((a, b) => b.fileCount - a.fileCount || a.path.localeCompare(b.path));
}

function detectTopLevel(files: string[]): { name: string; fileCount: number }[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const idx = file.indexOf("/");
    const name = idx === -1 ? "(root files)" : file.slice(0, idx);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, fileCount]) => ({ name, fileCount }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function buildStructure(files: string[], now: Date = new Date()): RepoStructure {
  return {
    capturedAt: now.toISOString(),
    fileCount: files.length,
    languages: detectLanguages(files),
    packages: detectPackages(files),
    modules: detectModules(files),
    entryPoints: detectEntryPoints(files),
    topLevel: detectTopLevel(files),
  };
}

/**
 * Build a repository index from git (file list, identity, staleness anchor).
 * Returns null when `root` is not a git repository or has no commits.
 */
export async function buildRepoIndex(root: string, options: ScanOptions = {}): Promise<RepoIndex | null> {
  const allFiles = await listFiles(root);
  if (allFiles === null) return null;

  const gitState: GitState | null = await snapshotGitState(root);
  if (!gitState) return null; // unborn HEAD / no commits yet — nothing to anchor to

  const capped = allFiles.slice(0, options.maxFiles ?? DEFAULT_MAX_FILES);
  const now = options.now ?? new Date();
  const structure = buildStructure(capped, now);
  await enrichPackageNames(root, structure.packages);

  const identity: RepoIdentity = {
    name: basename(root),
    root,
    remotes: await remotes(root),
    defaultBranch: await defaultBranch(root),
  };

  const timestamp = now.toISOString();
  return {
    okfVersion: 1,
    scope: "repository",
    generator: GENERATOR,
    created: timestamp,
    updated: timestamp,
    identity,
    git: gitState,
    structure,
  };
}

/**
 * Write an index to <root>/.okf/ (creating the directory). Also ensures the
 * index is excluded from git locally (Model A default, design §15) so the
 * derived knowledge never makes the worktree — or the staleness anchor —
 * dirty by itself.
 */
export async function writeRepoIndex(root: string, index: RepoIndex): Promise<string> {
  const dir = join(root, OKF_DIR);
  const repoDir = join(dir, REPOSITORY_DIR);
  await fs.mkdir(repoDir, { recursive: true });

  const manifest = {
    okfVersion: index.okfVersion,
    scope: index.scope,
    generator: index.generator,
    created: index.created,
    updated: index.updated,
  };

  await Promise.all([
    fs.writeFile(join(dir, OKF_MANIFEST), JSON.stringify(manifest, null, 2) + "\n", "utf8"),
    fs.writeFile(join(repoDir, "identity.json"), JSON.stringify(index.identity, null, 2) + "\n", "utf8"),
    fs.writeFile(join(repoDir, "git.json"), JSON.stringify(index.git, null, 2) + "\n", "utf8"),
    fs.writeFile(join(repoDir, "structure.json"), JSON.stringify(index.structure, null, 2) + "\n", "utf8"),
  ]);
  await excludeOkfLocally(root);
  return dir;
}

/** Read an existing index, or null when absent/malformed. */
export async function readRepoIndex(root: string): Promise<RepoIndex | null> {
  const dir = join(root, OKF_DIR);
  const repoDir = join(dir, REPOSITORY_DIR);
  try {
    const [manifest, identity, git, structure] = await Promise.all([
      fs.readFile(join(dir, OKF_MANIFEST), "utf8"),
      fs.readFile(join(repoDir, "identity.json"), "utf8"),
      fs.readFile(join(repoDir, "git.json"), "utf8"),
      fs.readFile(join(repoDir, "structure.json"), "utf8"),
    ]);
    const manifestJson = JSON.parse(manifest) as Record<string, unknown>;
    return {
      okfVersion: 1,
      scope: "repository",
      generator: typeof manifestJson.generator === "string" ? manifestJson.generator : GENERATOR,
      created: typeof manifestJson.created === "string" ? manifestJson.created : "",
      updated: typeof manifestJson.updated === "string" ? manifestJson.updated : "",
      identity: JSON.parse(identity) as RepoIdentity,
      git: JSON.parse(git) as GitState,
      structure: JSON.parse(structure) as RepoStructure,
    };
  } catch {
    return null;
  }
}

/**
 * Compare the stored index against live git state.
 * - missing: no index on disk
 * - fresh:   HEAD and worktree unchanged since capture
 * - stale:   HEAD moved or worktree diverged
 */
export async function assessStaleness(repoRoot: string): Promise<StalenessReport> {
  const index = await readRepoIndex(repoRoot);
  if (!index) return { state: "missing", reasons: ["no .okf index found"] };

  const gitRoot = await findGitRoot(repoRoot);
  if (!gitRoot) return { state: "stale", reasons: ["directory is no longer inside a git repository"] };

  const reasons: string[] = [];
  const sha = await headSha(gitRoot);
  if (!sha) {
    reasons.push("repository has no commits (unborn HEAD)");
  } else if (sha !== index.git.headSha) {
    reasons.push(`HEAD moved: ${index.git.headSha.slice(0, 7)} -> ${sha.slice(0, 7)}`);
  }

  const branch = await currentBranch(gitRoot);
  if (branch && branch !== index.git.branch) {
    reasons.push(`branch changed: ${index.git.branch} -> ${branch}`);
  }

  const changed = await changedFiles(gitRoot);
  const previous = new Set(index.git.changedFiles);
  const current = new Set(changed);
  const newlyChanged = changed.filter((f) => !previous.has(f));
  const resolved = [...previous].filter((f) => !current.has(f));
  if (newlyChanged.length > 0) {
    reasons.push(`${newlyChanged.length} new uncommitted change(s): ${newlyChanged.slice(0, 5).join(", ")}${newlyChanged.length > 5 ? ", …" : ""}`);
  }
  if (resolved.length > 0 && sha === index.git.headSha) {
    reasons.push(`${resolved.length} previously-changed file(s) resolved`);
  }

  return { state: reasons.length === 0 ? "fresh" : "stale", reasons };
}

/** Compact human/agent-readable summary of an index. */
export function summarizeIndex(index: RepoIndex): string[] {
  const { structure, identity, git } = index;
  const lines: string[] = [];
  lines.push(`Repository: ${identity.name}`);
  lines.push(`Git: ${git.branch} @ ${git.headSha.slice(0, 7)}${git.changedFiles.length > 0 ? ` (${git.changedFiles.length} uncommitted)` : ""}`);
  lines.push(`Files: ${structure.fileCount}`);
  const langs = Object.entries(structure.languages).slice(0, 6);
  if (langs.length > 0) {
    lines.push(`Languages: ${langs.map(([name, count]) => `${name} (${count})`).join(", ")}`);
  }
  if (structure.packages.length > 0) {
    lines.push(`Packages: ${structure.packages.map((p) => p.name).join(", ")}`);
  }
  const modules = structure.modules.slice(0, 12);
  if (modules.length > 0) {
    lines.push(`Modules: ${modules.map((m) => `${m.path} (${m.fileCount})`).join(", ")}`);
  }
  if (structure.entryPoints.length > 0) {
    lines.push(`Entry points: ${structure.entryPoints.join(", ")}`);
  }
  return lines;
}
