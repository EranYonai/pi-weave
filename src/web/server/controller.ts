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
}

export interface WorkspaceServerControllerDeps {
  startServer?: StartServerFn;
  vaultRoot?: () => string;
  onStateChange?: () => void;
}

/** Owns one browser-workspace server for one plugin instance. */
export class WorkspaceServerController {
  private session: WorkspaceServerSession | null = null;
  private booting: Promise<WorkspaceServerSession> | null = null;

  constructor(private readonly deps: WorkspaceServerControllerDeps = {}) {}

  port(): number | null {
    return this.session?.server.port ?? null;
  }

  async run(cwd: string): Promise<{ session: WorkspaceServerSession; started: boolean }> {
    const existing = this.session;
    return { session: existing ?? await this.boot(cwd), started: existing === null };
  }

  async close(): Promise<void> {
    if (this.booting) await this.booting.catch(() => undefined);
    const session = this.session;
    if (!session) return;
    this.session = null;
    await session.server.close();
    this.deps.onStateChange?.();
  }

  private async boot(cwd: string): Promise<WorkspaceServerSession> {
    if (this.booting) return this.booting;
    this.booting = this.bootOnce(cwd);
    try {
      this.session = await this.booting;
      this.deps.onStateChange?.();
      return this.session;
    } finally {
      this.booting = null;
    }
  }

  private async bootOnce(cwd: string): Promise<WorkspaceServerSession> {
    const vaultRoot = (this.deps.vaultRoot ?? resolveVaultRoot)();
    const cache = new WorkspaceCache({ cwd, vaultRoot });
    const server = await (this.deps.startServer ?? startWorkspaceServer)({ cwd, vaultRoot, cache });
    return { server, cache };
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
