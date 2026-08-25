/**
 * `/weave-view` — the browser workspace, wired into a pi session
 * (weave-workspace §5.4, §6, §13).
 *
 * This is the adapter half of the browser workspace: everything portable
 * already lives in `src/core` (the cache) and `src/web/server` (the server,
 * the SSE hub, the watcher). What is left here is the wiring those three
 * cannot do for themselves, because it is session-shaped:
 *
 *  1. **Composition.** Build one {@link WorkspaceCache} over `ctx.cwd` +
 *     the resolved vault root, one {@link SseHub}, one {@link Watcher}, and
 *     hand the last two to `startWorkspaceServer` so it owns their teardown.
 *  2. **The liveness loop.** `watcher.onPath → cache.invalidate` (evict
 *     precisely) and `watcher.onChange → cache.graph() → sse.broadcast`
 *     (one frame per scope). §6's diagram, in code.
 *  3. **Singleton per session.** A second `/weave-view` must reuse the
 *     running server — a second server would mean a second port, a second
 *     watcher on the same directories, and a browser tab pointed at a
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
import { graphStamp, type Watcher as ServerWatcher } from "../../../web/server/routes";
import {
  startWorkspaceServer,
  type StartWorkspaceServerOptions,
  type WorkspaceServer,
} from "../../../web/server/server";
import { SseHub } from "../../../web/server/sse";
import { Watcher } from "../../../web/server/watcher";
import type { ChangeScope } from "../../../web/shared/wire";

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

/**
 * The §6 liveness loop, as three callbacks over a cache and a hub.
 *
 * Extracted from the boot closure so it can be driven directly in a test
 * instead of through a real filesystem event: "a change arrives, the cache
 * is evicted, the graph is rebuilt, one frame per scope goes out" is the
 * behaviour worth asserting, and waiting on `fs.watch` to assert it would
 * be slow, platform-dependent and flaky for no gain.
 */
export interface LivenessBridge {
  /** One call per accepted path, immediately — precise eviction. */
  onPath(absPath: string): void;
  /** One call per debounce window — rebuild once, broadcast per scope. */
  onChange(scopes: readonly ChangeScope[]): void;
  /** The stamp a newly attached SSE client is told about. */
  currentStamp(): string | null;
  /** Test seam: resolves when the in-flight rebuild settles. */
  settled(): Promise<void>;
}

export function createLivenessBridge(cache: WorkspaceCache, sse: SseHub): LivenessBridge {
  // The last stamp we broadcast, or `null` before the first change. Held
  // rather than derived because `currentStamp` is synchronous (sse.ts) and
  // `cache.snapshot()` is not.
  let lastStamp: string | null = null;
  let inFlight: Promise<void> = Promise.resolve();

  return {
    onPath: (absPath) => cache.invalidate(absPath),
    onChange: (scopes) => {
      const done = (async () => {
        // A rebuild can fail — the vault was deleted mid-session — and a
        // failed broadcast must cost one missed frame, not an unhandled
        // rejection inside a filesystem callback.
        const snapshot = await cache.snapshot().catch(() => null);
        if (snapshot === null) return;
        // The *same* key `/api/graph` puts in its ETag (§5.3, §6): a content
        // digest, not `generatedAt`.
        //
        // This is the half of §15.6 that was easy to miss. The client dedupes
        // frames on `stamp` (`live.model.ts`) and already holds the stamp of
        // the graph it last fetched, so while this broadcast a timestamp max,
        // an edit that did not advance that maximum produced a frame the
        // client discarded *before* issuing the conditional GET. The stale
        // `304` was the second line of defence; this was the first, and it
        // failed for the same three cases. Sharing one key fixes both.
        //
        // `snapshot()`, not `graph()`, because the payload — and therefore
        // the digest — depends on the notes as well as the model (§4.3).
        const stamp = graphStamp(snapshot);
        lastStamp = stamp;
        for (const scope of scopes) sse.broadcast({ scope, stamp });
      })();
      inFlight = inFlight.then(() => done);
    },
    currentStamp: () => lastStamp,
    settled: () => inFlight,
  };
}

/** Everything one running workspace owns. Closed as a unit. */
export interface WebWorkspaceSession {
  server: WorkspaceServer;
  cache: WorkspaceCache;
  sse: SseHub;
  watcher: Watcher;
  liveness: LivenessBridge;
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

  /** Stop the workspace: server, watcher and every SSE stream. Idempotent. */
  async close(): Promise<void> {
    // A close arriving mid-boot must still close what that boot produced,
    // or `session_shutdown` during a slow start leaks the whole stack.
    const booting = this.booting;
    if (booting !== null) await booting.catch(() => undefined);
    const session = this.session;
    if (session === null) return;
    this.session = null;
    // `server.close()` closes the hub and awaits the watcher — it was handed
    // both at construction and owns their teardown (server.ts §5.4).
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
    const sse = new SseHub({ currentStamp: () => liveness.currentStamp() });
    const liveness = createLivenessBridge(cache, sse);

    const watcher = new Watcher({
      cwd,
      vaultRoot,
      // Per-path, immediately: eviction wants every path (§6).
      onPath: (absPath) => liveness.onPath(absPath),
      // Per debounce window: one frame per scope, whatever the path count.
      onChange: (scopes) => liveness.onChange(scopes),
    });

    const startServer = this.deps.startServer ?? startWorkspaceServer;
    const server = await startServer({
      cwd,
      vaultRoot,
      cache,
      sse,
      watcher: asServerWatcher(watcher),
      // The idle timeout closed the server behind our back; forget it so the
      // next `/weave-view` boots a fresh one instead of handing out a dead port.
      onIdleShutdown: () => {
        this.session = null;
        this.deps.onStateChange?.();
      },
    });

    return { server, cache, sse, watcher, liveness };
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

/**
 * Adapt the concrete {@link Watcher} to the promise-shaped contract
 * `server.ts` owns. The class is synchronous because `fs.watch` is; the
 * interface is async because a future watcher (a `chokidar`-style poller, a
 * remote FS) would not be.
 */
function asServerWatcher(watcher: Watcher): ServerWatcher {
  return {
    start: async () => {
      watcher.start();
    },
    close: async () => {
      watcher.close();
    },
  };
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
