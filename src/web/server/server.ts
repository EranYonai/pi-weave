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
 *     {@link WorkspaceCache} and {@link SecurityPolicy} — and passes them to
 *     `handleRequest`.
 *  3. **Lifecycle.** `close()` releases the port.
 */

import { randomBytes } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { WorkspaceCache } from "../../core/cache/workspace";
import { resolveVaultRoot } from "../../core/paths";
import { handleRequest, type RouteDeps } from "./routes";
import { createSecurityPolicy, type SecurityPolicy } from "./security";

/**
 * The committed bundle, resolved relative to this module rather than to
 * `process.cwd()` — the server runs in whatever directory the user invoked
 * pi from, which is never the package root.
 */
export function defaultBundlePath(): string {
  return fileURLToPath(new URL("../client/dist/app.js", import.meta.url));
}

export interface StartWorkspaceServerOptions {
  cwd: string;
  /** Defaults to `resolveVaultRoot()`, which honours `PI_WEAVE_VAULT`. */
  vaultRoot?: string;
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
  /** Release the port. Idempotent. */
  close(): Promise<void>;
}

export async function startWorkspaceServer(opts: StartWorkspaceServerOptions): Promise<WorkspaceServer> {
  const vaultRoot = opts.vaultRoot ?? resolveVaultRoot();
  const cache = opts.cache ?? new WorkspaceCache({ cwd: opts.cwd, vaultRoot });
  const session = randomBytes(8).toString("hex");

  // `deps` is assembled before `listen` because the request handler closes
  // over it, but the security policy needs the bound port — so the policy
  // slot is filled after binding and the handler reads it through the
  // mutable holder rather than capturing a stale value.
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
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
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
    ...(opts.openNote !== undefined ? { openNote: opts.openNote } : {}),
  };

  return {
    url: security.origin,
    entryUrl: security.entryUrl,
    port,
    token: security.token,
    security,
    cache,
    session,
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
