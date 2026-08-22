/**
 * weave-view server — loopback-only node:http server (docs/weave-view.md §4).
 *
 * Harness-agnostic on purpose: it only uses core + node builtins, so a
 * future Claude Code / opencode adapter can reuse it as-is. Pi-specific bits
 * (commands, browser exec) live in `src/pi/index.ts`.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  assessStaleness,
  buildGraph,
  DEFAULT_MAX_NOTES,
  findGitRoot,
  getNote,
  listNotes,
  noteCount,
  readRepoIndex,
  resolveNotePath,
  resolveVaultRoot,
  type BuildGraphInput,
  type GraphModel,
  type Note,
} from "../../core";
import { renderPage } from "./page";

export interface ViewerServer {
  /** Resolved base URL, e.g. http://127.0.0.1:53217 */
  url: string;
  port: number;
  /** Close the server. Idempotent — safe to call multiple times. */
  stop(): Promise<void>;
}

export interface StartViewerOptions {
  cwd: string;
  /** Vault override (defaults to resolveVaultRoot(), honoring PI_WEAVE_VAULT). */
  vaultRoot?: string;
  /** Explicit port; defaults to PI_WEAVE_VIEW_PORT or 0 (OS-assigned). */
  port?: number;
}

/**
 * CSP: page JS and CSS are inline by design (zero external resources), so
 * inline styles/scripts are allowed while everything else stays 'self'.
 * (Extends docs/weave-view.md §4's header, which blocked inline script and
 * would break the page.)
 */
const CSP = "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'";

/** Live-read one note for the viewer's side panel (read-only; never caches). */
export async function readNoteForView(
  vaultRoot: string,
  slug: string,
): Promise<Record<string, unknown> | null> {
  if (resolveNotePath(vaultRoot, slug) === null) return null; // traversal-safe
  const note = await getNote(vaultRoot, slug);
  if (note === null) return null;
  return {
    slug: note.slug,
    title: note.title,
    body: note.body,
    created: note.created,
    updated: note.updated,
    tags: note.tags,
    source: note.source,
  };
}

/** Assemble the fresh graph from disk — called on EVERY /graph.json request (no caching, docs/weave-view.md §2). */
export async function buildCurrentGraph(cwd: string, vaultRoot: string = resolveVaultRoot()): Promise<GraphModel> {
  const summaries = (await listNotes(vaultRoot)).slice(0, DEFAULT_MAX_NOTES);
  const loaded = await Promise.all(summaries.map((s) => getNote(vaultRoot, s.slug)));
  const notes = loaded.filter((n): n is Note => n !== null);

  const input: BuildGraphInput = {
    vault: { root: vaultRoot, exists: true, noteCount: await noteCount(vaultRoot) },
    notes,
    repository: null,
  };

  const repoRoot = await findGitRoot(cwd);
  if (repoRoot !== null) {
    const index = await readRepoIndex(repoRoot);
    if (index !== null) {
      input.repository = { index, staleness: await assessStaleness(repoRoot) };
    }
  }
  return buildGraph(input);
}

function route(
  page: string,
  graph: () => Promise<GraphModel>,
  noteBySlug: (slug: string) => Promise<Record<string, unknown> | null>,
  res: ServerResponse,
  req: IncomingMessage,
): void {
  const path = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
  if (req.method === "GET" && path === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP });
    res.end(page);
    return;
  }
  if (req.method === "GET" && path === "/graph.json") {
    graph()
      .then((model) => {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-security-policy": CSP });
        res.end(JSON.stringify(model));
      })
      .catch((err: unknown) => {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end(`pi-weave viewer: failed to build graph: ${err instanceof Error ? err.message : String(err)}`);
      });
    return;
  }
  if (req.method === "GET" && path.startsWith("/note/")) {
    noteBySlug(path.slice("/note/".length))
      .then((note) => {
        if (note === null) {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          res.end("no such note\n");
          return;
        }
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-security-policy": CSP });
        res.end(JSON.stringify(note));
      })
      .catch(() => {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end("pi-weave viewer: failed to read note\n");
      });
    return;
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found\n");
}

export async function startViewer(options: StartViewerOptions): Promise<ViewerServer> {
  const page = renderPage();
  const cwd = options.cwd;
  const vaultRoot = options.vaultRoot ?? resolveVaultRoot();
  const server: Server = createServer((req, res) => {
    route(page, () => buildCurrentGraph(cwd, vaultRoot), (slug) => readNoteForView(vaultRoot, slug), res, req);
  });

  const parsed = Number.parseInt(process.env.PI_WEAVE_VIEW_PORT ?? "", 10);
  const port = options.port ?? (Number.isFinite(parsed) ? parsed : 0);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;

  let closed = false;
  return {
    url: `http://127.0.0.1:${boundPort}`,
    port: boundPort,
    stop: () =>
      new Promise<void>((resolve) => {
        if (closed) {
          resolve();
          return;
        }
        closed = true;
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
