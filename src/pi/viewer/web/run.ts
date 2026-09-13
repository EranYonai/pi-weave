/**
 * `/weave-view` — the browser workspace, wired into a pi session
 * (weave-workspace §5.4, §6, §13).
 *
 * This is the adapter half of the browser workspace: everything portable
 * already lives in `src/core` (the cache) and `src/web/server` (the server).
 * What is left here is the wiring those two
 * cannot do for themselves, because it is session-shaped:
 *
 *  1. **Composition.** Build one {@link WorkspaceCache} over `ctx.cwd` +
 *     the resolved vault root and hand it to `startWorkspaceServer`.
 *  2. **Singleton per session.** A second `/weave-view` must reuse the
 *     running server — a second server would mean a second port, a second
 *     second browser tab pointed at a
 *     workspace nobody is going to close (§5.4).
 *  4. **Browser handoff**, with an honest fallback when there is no browser
 *     to hand off to.
 *
 * ## Why the browser opener is not `openNoteCommand`
 *
 * `src/core/openInEditor.ts` prefers `$EDITOR`/`$VISUAL` before the platform
 * opener, which is exactly right for a *file* and exactly wrong for a *URL*:
 * a user with `EDITOR=vim` would get vim staring at `http://127.0.0.1:…`.
 * Only the platform-opener tail generalises, and that tail is three lines,
 * so {@link browserOpenCommand} restates it rather than growing a mode flag
 * through core's editor path.
 *
 * ## Why the browser is spawned through `pi.exec` and not `execFile`
 *
 * The harness already owns subprocess policy (cancellation, timeouts, the
 * user's trust prompts) and, pragmatically, it is the seam the mock harness
 * records — so the test asserts the exact command the user's machine would
 * run, rather than that some private function was called.
 */

import { platform as osPlatform } from "node:os";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { resolveVaultRoot, WorkspaceCache } from "../../../core";
import {
  startWorkspaceServer,
  type StartWorkspaceServerOptions,
  type WorkspaceServer,
} from "../../../web/server/server";

/** The slice of `ExtensionAPI.exec` this module uses. */
export type ExecFn = (command: string, args: string[]) => Promise<{ code: number; stderr: string }>;

/** `startWorkspaceServer`, as a seam so tests can pin `idleMs` and the bundle. */
export type StartServerFn = (opts: StartWorkspaceServerOptions) => Promise<WorkspaceServer>;

/**
 * The command that hands a URL to the desktop's default browser.
 *
 * `os` is injectable so the whole mapping is unit-testable on any host
 * without stubbing globals — the same convention as `openNoteCommand`.
 */
export function browserOpenCommand(
  url: string,
  os: NodeJS.Platform = osPlatform(),
): { command: string; args: string[] } {
  if (os === "darwin") return { command: "open", args: [url] };
  // The empty string is `start`'s title argument. Without it, a URL that
  // happens to be quoted is consumed as the window title and nothing opens.
  if (os === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

/** Everything one running workspace owns. Closed as a unit. */
export interface WebWorkspaceSession {
  server: WorkspaceServer;
  cache: WorkspaceCache;
}

export interface WebWorkspaceDeps {
  /** `ExtensionAPI.exec`. Used only to launch the browser. */
  exec: ExecFn;
  /** Defaults to {@link startWorkspaceServer}. */
  startServer?: StartServerFn | undefined;
  /** Defaults to {@link browserOpenCommand} on the host platform. */
  openCommand?: ((url: string) => { command: string; args: string[] }) | undefined;
  /** Defaults to {@link resolveVaultRoot}, which honours `PI_WEAVE_VAULT`. */
  vaultRoot?: (() => string) | undefined;
  /** Called whenever the running/​stopped state changes, so the status line can follow. */
  onStateChange?: (() => void) | undefined;
}

/** What {@link WebWorkspaceController.run} was asked to do. */
export interface RunWebOptions {
  /** `false` for `--no-open`: print the URL, launch nothing. */
  open: boolean;
}

/** Outcome of one `/weave-view` invocation, for the caller's next move. */
export interface RunWebOutcome {
  session: WebWorkspaceSession;
  /** True when this call booted the server rather than reusing one. */
  started: boolean;
  /** True when a browser was actually launched successfully. */
  opened: boolean;
  /**
   * True when the caller should fall back to the in-terminal explorer:
   * a browser was wanted, was attempted, and did not launch. The server
   * stays up regardless — the URL is still the user's way back in.
   */
  fallbackToTui: boolean;
}

/**
 * Owns the at-most-one workspace server for a pi session.
 *
 * A class rather than module state so that two extension instances in one
 * test process (or, one day, two pi sessions in one host) do not share a
 * server. It holds a lifetime and open OS handles; that is what a class is
 * for here, and it mirrors {@link WorkspaceCache}'s reasoning.
 */
export class WebWorkspaceController {
  private readonly deps: WebWorkspaceDeps;
  private session: WebWorkspaceSession | null = null;
  /** The single in-flight boot, so two fast `/weave-view`s do not race. */
  private booting: Promise<WebWorkspaceSession> | null = null;

  constructor(deps: WebWorkspaceDeps) {
    this.deps = deps;
  }

  /** Bound port while a workspace is running, else `null`. Drives the status line. */
  port(): number | null {
    return this.session?.server.port ?? null;
  }

  /**
   * Start (or reuse) the workspace and hand the URL to the user.
   *
   * The URL is notified on **every** path — `--no-open`, a headless
   * session, and a failed browser launch all leave the user a working link
   * rather than a server they cannot find.
   */
  async run(ctx: ExtensionCommandContext, opts: RunWebOptions): Promise<RunWebOutcome> {
    const existing = this.session;
    const session = existing ?? (await this.boot(ctx));
    const started = existing === null;

    // Only a session with a UI has a browser worth spawning: over `--mode
    // rpc` or a plain SSH pipe there is no desktop on this side of the
    // connection, and `xdg-open` would fail (or worse, succeed on the
    // wrong machine).
    const wantsBrowser = opts.open && ctx.hasUI;
    const opened = wantsBrowser ? await this.launch(session.server.entryUrl) : false;

    ctx.ui.notify(describe({ url: session.server.entryUrl, started, opened, wantsBrowser }), "info");

    return { session, started, opened, fallbackToTui: wantsBrowser && !opened };
  }

  /** Stop the workspace server. Idempotent. */
  async close(): Promise<void> {
    // A close arriving mid-boot must still close what that boot produced,
    // or `session_shutdown` during a slow start leaks the whole stack.
    const booting = this.booting;
    if (booting !== null) await booting.catch(() => undefined);
    const session = this.session;
    if (session === null) return;
    this.session = null;
    await session.server.close();
    this.deps.onStateChange?.();
  }

  // --- internals --------------------------------------------------------------

  private async boot(ctx: ExtensionCommandContext): Promise<WebWorkspaceSession> {
    if (this.booting !== null) return this.booting;
    const boot = this.bootOnce(ctx);
    this.booting = boot;
    try {
      const session = await boot;
      this.session = session;
      this.deps.onStateChange?.();
      return session;
    } finally {
      this.booting = null;
    }
  }

  private async bootOnce(ctx: ExtensionCommandContext): Promise<WebWorkspaceSession> {
    const cwd = ctx.cwd;
    const vaultRoot = (this.deps.vaultRoot ?? resolveVaultRoot)();
    const cache = new WorkspaceCache({ cwd, vaultRoot });
    const startServer = this.deps.startServer ?? startWorkspaceServer;
    const server = await startServer({
      cwd,
      vaultRoot,
      cache,
    });

    return { server, cache };
  }

  /** Spawn the browser, reporting failure rather than throwing it. */
  private async launch(url: string): Promise<boolean> {
    const open = this.deps.openCommand ?? ((u: string) => browserOpenCommand(u));
    const { command, args } = open(url);
    try {
      const result = await this.deps.exec(command, args);
      return result.code === 0;
    } catch {
      // No such binary (a container with no `xdg-open`), or the harness
      // refused the spawn. Either way the user gets the URL and a reason.
      return false;
    }
  }
}

/** The one notification, worded for whichever path got us here. */
function describe(facts: { url: string; started: boolean; opened: boolean; wantsBrowser: boolean }): string {
  const where = facts.started ? "workspace running at" : "workspace already running at";
  if (facts.opened) return `pi-weave: ${where} ${facts.url} — opened in your browser.`;
  if (facts.wantsBrowser) {
    return `pi-weave: ${where} ${facts.url} — could not launch a browser; open the URL yourself (falling back to the in-terminal explorer).`;
  }
  return `pi-weave: ${where} ${facts.url} — open it in a browser.`;
}
