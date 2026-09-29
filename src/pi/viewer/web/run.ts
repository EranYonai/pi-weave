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

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  browserOpenCommand,
  WorkspaceServerController,
  type StartServerFn,
  type WorkspaceServerSession,
} from "../../../web/server/controller";

/** The slice of `ExtensionAPI.exec` this module uses. */
export type ExecFn = (command: string, args: string[]) => Promise<{ code: number; stderr: string }>;

export { browserOpenCommand };
export type WebWorkspaceSession = WorkspaceServerSession;

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
  private readonly server: WorkspaceServerController;

  constructor(deps: WebWorkspaceDeps) {
    this.deps = deps;
    this.server = new WorkspaceServerController({
      ...(deps.startServer ? { startServer: deps.startServer } : {}),
      ...(deps.vaultRoot ? { vaultRoot: deps.vaultRoot } : {}),
      ...(deps.onStateChange ? { onStateChange: deps.onStateChange } : {}),
    });
  }

  /** Bound port while a workspace is running, else `null`. Drives the status line. */
  port(): number | null {
    return this.server.port();
  }

  /**
   * Start (or reuse) the workspace and hand the URL to the user.
   *
   * The URL is notified on **every** path — `--no-open`, a headless
   * session, and a failed browser launch all leave the user a working link
   * rather than a server they cannot find.
   */
  async run(ctx: ExtensionCommandContext, opts: RunWebOptions): Promise<RunWebOutcome> {
    const { session, started } = await this.server.run(ctx.cwd);

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
    await this.server.close();
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
