/**
 * The loopback workspace server — bind, lifecycle, teardown
 * (weave-workspace §5.1, §5.4).
 *
 * This module owns three things and delegates everything else:
 *
 *  1. **Binding.** `listen(0, "127.0.0.1")` — loopback only, ephemeral port.
 *     Never a fixed port: a fixed port is a port another process can squat
 *     before us, and a port a malicious page can guess without scanning.
 *  2. **Composition.** It builds the {@link RouteDeps} — a
 *     {@link WorkspaceCache}, a {@link SecurityPolicy}, and whichever hub and
 *     watcher it was handed — and passes them to `handleRequest`.
 *  3. **Lifecycle.** Idle shutdown 30 minutes after the last SSE client
 *     disconnects, and a `close()` that actually releases the port.
 *
 * ## Why the hub and the watcher are constructor arguments
 *
 * `SseHub` and `Watcher` are declared in `routes.ts` (the consumer) and
 * arrive here as optional options. That is not ceremony: it means the server
 * can be booted with neither — which is exactly what the route tests do, so
 * they exercise the real socket and the real security policy without a file
 * watcher spinning up on a temp directory, and it means the SSE
 * implementation can be written, replaced, or omitted with no edit to this
 * file. With no hub, `/events` answers `503` and the server has no idle
 * timer to run, because nothing can be idle.
 *
 * ## Idle shutdown, precisely
 *
 * The timer starts when the SSE client count reaches zero and is cancelled
 * when a client attaches. A workspace with a tab open is never idle; a
 * workspace whose last tab closed is reclaimed after
 * {@link DEFAULT_IDLE_MS}. `setTimer` is injectable, so the test asserts the
 * transition rather than waiting thirty minutes for it, and
 * `timer.unref?.()` keeps a pending shutdown from holding the process open.
 */

import { randomBytes } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { WorkspaceCache } from "../../core/cache/workspace";
import { resolveVaultRoot } from "../../core/paths";
import { handleRequest, type RouteDeps, type SseHub, type Watcher } from "./routes";
import { createSecurityPolicy, type SecurityPolicy } from "./security";

export type { SseHub, Watcher } from "./routes";

/** §5.4: reclaim the port 30 minutes after the last SSE client disconnects. */
export const DEFAULT_IDLE_MS = 30 * 60 * 1000;

/**
 * The committed bundle, resolved relative to this module rather than to
 * `process.cwd()` — the server runs in whatever directory the user invoked
 * pi from, which is never the package root.
 */
export function defaultBundlePath(): string {
  return fileURLToPath(new URL("../client/dist/app.js", import.meta.url));
}

/** A `setTimeout` shaped seam, so the idle path is testable in microseconds. */
export interface TimerHandle {
  unref?(): unknown;
}
export type SetTimer = (fn: () => void, ms: number) => TimerHandle;
export type ClearTimer = (handle: TimerHandle) => void;

export interface StartWorkspaceServerOptions {
  cwd: string;
  /** Defaults to `resolveVaultRoot()`, which honours `PI_WEAVE_VAULT`. */
  vaultRoot?: string;
  /**
   * Live-update hub. Absent → `/events` answers `503` and the idle timer
   * never runs. Supplied by the caller that also constructs the watcher.
   */
  sse?: SseHub | undefined;
  /** File watcher. Started during boot, closed during teardown. */
  watcher?: Watcher | undefined;
  /** Pre-built cache. Defaults to a fresh one over `cwd` + `vaultRoot`. */
  cache?: WorkspaceCache | undefined;
  /** Fixed token, for tests that need to know it before the boot resolves. */
  token?: string | undefined;
  /** Cookie name override — the §5.1 footnote-1 fallback. */
  cookieName?: string | undefined;
  /** Absolute path to the client bundle. Defaults to the committed one. */
  bundlePath?: string | undefined;
  /** Test seam for `POST /api/open`. */
  openNote?: ((slug: string) => Promise<boolean>) | undefined;
  /** Test seam for the note read; see {@link RouteDeps.readNote}. */
  readNote?: RouteDeps["readNote"];
  /**
   * Self-write suppression (§6): tell the watcher to ignore a path it is
   * about to see us change.
   *
   * A separate option rather than a method on {@link Watcher}, because
   * `Watcher` here is the two-method lifecycle contract `routes.ts` declares
   * — start and close — and widening it would force every future watcher
   * (a poller, a remote FS) to implement suppression whether or not the
   * concept applies to it. The caller that constructs the real watcher knows
   * it has a `suppress`, and passes it.
   *
   * Defaults to {@link Watcher.suppress} when the injected watcher has one,
   * so the common wiring is automatic and the option exists for a caller
   * whose suppression lives somewhere else (or for a test that wants to
   * observe it). Absent on both means writes happen unsuppressed, which is
   * exactly right for a server booted with no watcher: there is nothing
   * listening to feed a loop.
   */
  suppress?: ((absPath: string) => void) | undefined;
  /** Idle shutdown delay. `0` disables it entirely. */
  idleMs?: number | undefined;
  setTimer?: SetTimer | undefined;
  clearTimer?: ClearTimer | undefined;
  /** Invoked when the idle timeout fires, after `close()`. */
  onIdleShutdown?: (() => void) | undefined;
}

export interface WorkspaceServer {
  /** Canonical base URL, e.g. `http://127.0.0.1:53217`. */
  url: string;
  /** The one-shot handoff URL: `url` plus `?t=TOKEN`. Give this to a browser. */
  entryUrl: string;
  port: number;
  token: string;
  security: SecurityPolicy;
  cache: WorkspaceCache;
  /** Random per-boot id, also embedded in the page bootstrap. */
  session: string;
  /**
   * Called by the SSE hub whenever a client attaches or detaches, so the
   * idle timer can be armed or cancelled. Exposed rather than inferred
   * because only the hub knows when a socket actually died.
   */
  noteActivity(): void;
  /** Release the port, the watcher and every stream. Idempotent. */
  close(): Promise<void>;
}

export async function startWorkspaceServer(opts: StartWorkspaceServerOptions): Promise<WorkspaceServer> {
  const vaultRoot = opts.vaultRoot ?? resolveVaultRoot();
  const cache = opts.cache ?? new WorkspaceCache({ cwd: opts.cwd, vaultRoot });
  const session = randomBytes(8).toString("hex");
  const setTimer: SetTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer: ClearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;

  // `deps` is assembled before `listen` because the request handler closes
  // over it, but the security policy needs the bound port — so the policy
  // slot is filled after binding and the handler reads it through the
  // mutable holder rather than capturing a stale value.
  // Explicit `suppress` first, else the watcher's own if it has one (§6).
  // Bound as a closure rather than passed as a method reference, so a
  // watcher implementing `suppress` as a class method keeps its `this`.
  const watcherSuppress = opts.watcher?.suppress;
  const suppress: ((absPath: string) => void) | null =
    opts.suppress ?? (watcherSuppress === undefined ? null : (absPath: string) => watcherSuppress.call(opts.watcher, absPath));

  let deps: RouteDeps | null = null;
  const server: Server = createHttpServer((req, res) => {
    // Unreachable in practice — `listen` resolves before any connection is
    // accepted — but a request arriving with no deps would be a `500` with
    // an incomprehensible stack, so answer honestly instead.
    /* c8 ignore next 5 */
    if (deps === null) {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      res.end("pi-weave: starting\n");
      return;
    }
    void handleRequest(deps, req, res);
  });

  await listen(server);
  const port = boundPort(server);
  const security = createSecurityPolicy({
    port,
    ...(opts.token !== undefined ? { token: opts.token } : {}),
    ...(opts.cookieName !== undefined ? { cookieName: opts.cookieName } : {}),
  });

  let closed = false;
  let idleHandle: TimerHandle | null = null;

  const cancelIdle = (): void => {
    if (idleHandle !== null) {
      clearTimer(idleHandle);
      idleHandle = null;
    }
  };

  const armIdle = (): void => {
    // No hub means `/events` answers 503, so there is no such thing as a
    // client here and nothing for a countdown to count. The server stays up
    // until its owner closes it.
    if (idleMs <= 0 || closed || opts.sse === undefined) return;
    const handle = setTimer(() => {
      idleHandle = null;
      void close().then(() => opts.onIdleShutdown?.());
    }, idleMs);
    // A pending shutdown must not be the reason the process stays alive.
    handle.unref?.();
    idleHandle = handle;
  };

  const noteActivity = (): void => {
    cancelIdle();
    // Zero clients right now means the countdown starts now. A hub that
    // reports a live client cancels it and says nothing more until that
    // client leaves. With no hub at all, `armIdle` is already a no-op — the
    // guard lives there rather than being repeated here.
    if (opts.sse === undefined || opts.sse.clientCount() === 0) armIdle();
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    cancelIdle();
    opts.sse?.close();
    await opts.watcher?.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Without this, an open SSE stream keeps the server's handle alive and
      // `close()` never resolves — the exact reason a pi session used to
      // hang on shutdown.
      server.closeAllConnections();
    });
  };

  deps = {
    cwd: opts.cwd,
    vaultRoot,
    session,
    cache,
    security,
    bundlePath: opts.bundlePath ?? defaultBundlePath(),
    ...(opts.sse !== undefined ? { sse: opts.sse } : {}),
    ...(opts.openNote !== undefined ? { openNote: opts.openNote } : {}),
    ...(opts.readNote !== undefined ? { readNote: opts.readNote } : {}),
    ...(suppress === null ? {} : { suppress }),
    onActivity: noteActivity,
  };

  await opts.watcher?.start();

  // A workspace nobody has connected to yet is already idle: if the browser
  // never opens, the port should still be reclaimed.
  if (opts.sse !== undefined) armIdle();

  return {
    url: security.origin,
    entryUrl: security.entryUrl,
    port,
    token: security.token,
    security,
    cache,
    session,
    noteActivity,
    close,
  };
}

/** Bind to an ephemeral loopback port, rejecting on a bind error. */
function listen(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function boundPort(server: Server): number {
  const address = server.address();
  /* c8 ignore next -- `address()` is only a string for a unix socket, which we never bind. */
  if (typeof address !== "object" || address === null) throw new Error("pi-weave: server did not bind a TCP port");
  return address.port;
}
