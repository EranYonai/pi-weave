import { platform as osPlatform } from "node:os";
import { resolveVaultRoot, WorkspaceCache } from "../../core";
import {
  startWorkspaceServer,
  type StartWorkspaceServerOptions,
  type WorkspaceServer,
} from "./server";

export type StartServerFn = (opts: StartWorkspaceServerOptions) => Promise<WorkspaceServer>;

export interface WorkspaceServerSession {
  server: WorkspaceServer;
  cache: WorkspaceCache;
  cwd: string;
}

export interface WorkspaceServerControllerDeps {
  startServer?: StartServerFn;
  vaultRoot?: () => string;
  onStateChange?: () => void;
}

/** Owns one browser-workspace server for one plugin instance. */
export class WorkspaceServerController {
  private session: WorkspaceServerSession | null = null;
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly deps: WorkspaceServerControllerDeps = {}) {}

  port(): number | null {
    return this.session?.server.port ?? null;
  }

  run(cwd: string): Promise<{ session: WorkspaceServerSession; started: boolean }> {
    return this.enqueue(async () => {
      const existing = this.session;
      if (existing?.cwd === cwd) return { session: existing, started: false };
      if (existing) await this.stop();
      const session = await this.bootOnce(cwd);
      this.session = session;
      this.deps.onStateChange?.();
      return { session, started: true };
    });
  }

  close(): Promise<void> {
    return this.enqueue(() => this.stop());
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.pending.then(task);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  private async stop(): Promise<void> {
    const session = this.session;
    if (!session) return;
    this.session = null;
    await session.server.close();
    this.deps.onStateChange?.();
  }

  private async bootOnce(cwd: string): Promise<WorkspaceServerSession> {
    const vaultRoot = (this.deps.vaultRoot ?? resolveVaultRoot)();
    const cache = new WorkspaceCache({ cwd, vaultRoot });
    const server = await (this.deps.startServer ?? startWorkspaceServer)({ cwd, vaultRoot, cache });
    return { server, cache, cwd };
  }
}

export function browserOpenCommand(
  url: string,
  os: NodeJS.Platform = osPlatform(),
): { command: string; args: string[] } {
  if (os === "darwin") return { command: "open", args: [url] };
  if (os === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}
