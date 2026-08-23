/**
 * weave-view server — loopback-only node:http server (docs/weave-view.md §4).
 *
 * Harness-agnostic on purpose: it only uses core + node builtins, so a
 * future Claude Code / opencode adapter can reuse it as-is. Pi-specific bits
 * (commands, browser exec) live in `src/pi/index.ts`.
 */

import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { promisify } from "node:util";
import { platform } from "node:os";
import { getNote, resolveNotePath, resolveVaultRoot, type GraphModel } from "../../core";
import { renderPage } from "./page";

const execFileAsync = promisify(execFile);
import {
  buildCurrentGraph,
  readNoteForView,
  readOkfFileForView,
  type ViewNote,
} from "../../core";

// Re-export the moved readers so existing import sites (tests) keep passing.
export { buildCurrentGraph, readNoteForView, readOkfFileForView, type ViewNote } from "../../core";

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
  /**
   * Override the OS command used to open a note in the editor (test seam).
   * Defaults to openNoteCommand().
   */
  openCommand?: (notePath: string) => { command: string; args: string[] };
}

/**
 * The OS command used to open a note file in the user's editor. Respects
 * $EDITOR / $VISUAL (which may carry args, e.g. "code --wait"); falls back
 * to the platform default opener. Kept separate from the route so the
 * mapping is unit-testable without stubbing globals (mirrors browserCommand).
 */
export function openNoteCommand(
  notePath: string,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  const editor = (env.EDITOR || env.VISUAL || "").trim();
  if (editor) {
    const parts = editor.split(/\s+/).filter(Boolean);
    const command = parts[0] ?? "";
    return { command, args: [...parts.slice(1), notePath] };
  }
  if (platform() === "darwin") return { command: "open", args: [notePath] };
  if (platform() === "win32") return { command: "cmd", args: ["/c", "start", "", notePath] };
  return { command: "xdg-open", args: [notePath] };
}

/**
 * Open a note in the OS editor. The slug is validated against the vault
 * (traversal-safe) before any shell-out; returns false when the note does
 * not exist or the slug is unsafe.
 */
export async function openNoteInEditor(
  vaultRoot: string,
  slug: string,
  openCommand: (notePath: string) => { command: string; args: string[] } = openNoteCommand,
): Promise<boolean> {
  const path = resolveNotePath(vaultRoot, slug);
  if (path === null) return false; // traversal-safe
  const note = await getNote(vaultRoot, slug);
  if (note === null) return false;
  const { command, args } = openCommand(path);
  if (!command) return false;
  await execFileAsync(command, args);
  return true;
}

/**
 * CSP: page JS and CSS are inline by design (zero external resources), so
 * inline styles/scripts are allowed while everything else stays 'self'.
 * (Extends docs/weave-view.md §4's header, which blocked inline script and
 * would break the page.)
 */
const CSP = "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'";

// `readNoteForView`, `readOkfFileForView`, and `buildCurrentGraph` moved to
// core (src/core/graph/current.ts) and re-exported above; the HTTP route wires
// them in below.

function route(
  page: string,
  graph: () => Promise<GraphModel>,
  noteBySlug: (slug: string) => Promise<ViewNote | null>,
  okfBody: (rel: string) => Promise<{ path: string; body: string } | null>,
  openNote: (slug: string) => Promise<boolean>,
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
  if (req.method === "POST" && path.startsWith("/open/")) {
    openNote(path.slice("/open/".length))
      .then((ok) => {
        if (!ok) {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          res.end("no such note\n");
          return;
        }
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end("opened\n");
      })
      .catch(() => {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end("pi-weave viewer: failed to open note\n");
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
  if (req.method === "GET" && path.startsWith("/okffile/")) {
    okfBody(path.slice("/okffile/".length))
      .then((file) => {
        if (file === null) {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          res.end("no such okf file\n");
          return;
        }
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-security-policy": CSP });
        res.end(JSON.stringify(file));
      })
      .catch(() => {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end("pi-weave viewer: failed to read okf file\n");
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
  const openCommand = options.openCommand ?? openNoteCommand;
  const server: Server = createServer((req, res) => {
    route(
      page,
      () => buildCurrentGraph(cwd, vaultRoot),
      (slug) => readNoteForView(vaultRoot, slug),
      (rel) => readOkfFileForView(cwd, rel),
      (slug) => openNoteInEditor(vaultRoot, slug, openCommand),
      res,
      req,
    );
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
