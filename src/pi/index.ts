import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  buildRepoIndex,
  findGitRoot,
  formatDashboard,
  formatStatusLine,
  getWorkspaceStatus,
  summarizeIndex,
  writeRepoIndex,
  type WorkspaceStatus,
} from "../core";
import { registerNoteTool } from "./tools/noteTool";
import { registerRepoTool } from "./tools/repoTool";
import { deepScanRepository, formatDeepScanResult } from "./summarize";
import { openInBrowser } from "./viewer/browser";
import { startViewer, type ViewerServer } from "./viewer/server";
import { runWeaveViewTui } from "./viewer/tui/run";

/**
 * pi-weave — an agent-native knowledge workspace (docs/design.md):
 *
 *  1. Smart notepad with AI skills  → the `weave_note` tool + skills/
 *  2. Repository exploration        → the `weave_repo` tool building .okf
 *  3. Humans and agents alike       → plain Markdown / JSON on disk
 *
 * All behavior lives in src/core (portable); this file only wires it into pi.
 */
export default function piWeave(pi: ExtensionAPI): void {
  registerNoteTool(pi);
  registerRepoTool(pi);

  // Session-scoped viewer: lazy start on first /weave-view, never from the
  // factory (extension rules); idempotent stop on session_shutdown.
  let viewer: ViewerServer | null = null;
  let lastCtx: ExtensionContext | ExtensionCommandContext | null = null;
  let lastStatusText: string | undefined = undefined;
  let isActive = false;

  function updateStatus(ctx?: ExtensionContext | ExtensionCommandContext, text?: string): void {
    if (ctx) lastCtx = ctx;
    const c = ctx || lastCtx;
    if (!c?.ui?.setStatus) return;
    if (text !== undefined) {
      lastStatusText = text;
    }
    if (!lastStatusText) {
      c.ui.setStatus("weave", undefined);
      return;
    }
    let theme: { fg?: (slot: string, text: string) => string } | undefined;
    try {
      theme = (c.ui as unknown as { theme?: { fg?: (slot: string, text: string) => string } })?.theme;
    } catch {
      // ignore
    }
    const indicator = (isActive || inFlightDeepScans.size > 0)
      ? (theme?.fg ? theme.fg("accent", "●") : "●")
      : (theme?.fg ? theme.fg("dim", "○") : "○");
    c.ui.setStatus("weave", `${indicator} ${lastStatusText}`);
  }

  pi.on("session_shutdown", async () => {
    const server = viewer;
    viewer = null;
    await server?.stop();
  });

  pi.on("agent_start", async (_event, ctx) => {
    isActive = true;
    updateStatus(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    isActive = false;
    updateStatus(ctx);
  });

  pi.on("session_start", async (_event, ctx) => {
    const status = await getWorkspaceStatus(ctx.cwd);
    updateStatus(ctx, formatStatusLine(status));

    if (!ctx.hasUI) return;
    const repo = status.repository;
    if (repo && !repo.indexed) {
      ctx.ui.notify(
        "pi-weave: this repository has no knowledge index yet — ask pi to explore it, or run /weave-scan.",
        "info",
      );
    } else if (repo && repo.staleness.state === "stale") {
      const reason = repo.staleness.reasons[0] ?? "index is stale";
      ctx.ui.notify(`pi-weave: repository index is stale (${reason}). Run /weave-scan to refresh.`, "warning");
    }
  });

  pi.registerCommand("weave", {
    description: "Show the pi-weave workspace dashboard (vault + repository knowledge)",
    handler: async (_args, ctx) => {
      const status = await getWorkspaceStatus(ctx.cwd);
      ctx.ui.notify(formatDashboard(status), "info");
    },
  });

  pi.registerCommand("weave-view", {
    description: "Open the local knowledge-graph viewer in your browser (vault + repository); '/weave-view tui' explores in-terminal",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "tui") {
        await runWeaveViewTui(ctx);
        return;
      }
      if (arg !== "") {
        ctx.ui.notify("usage: /weave-view [tui]", "warning");
        return;
      }
      viewer ??= await startViewer({ cwd: ctx.cwd });
      ctx.ui.notify(`pi-weave viewer: ${viewer.url} (reads from disk live; refresh the page any time)`, "info");
      await openInBrowser(pi, ctx, viewer.url);
    },
  });

  pi.registerCommand("weave-scan", {
    description: "Build or refresh the repository knowledge index (.okf); 'deep' also summarizes files with the session model",
    handler: async (args, ctx) => {
      const root = await findGitRoot(ctx.cwd);
      if (!root) {
        ctx.ui.notify("pi-weave: not inside a git repository.", "warning");
        return;
      }
      const index = await buildRepoIndex(root);
      if (!index) {
        ctx.ui.notify("pi-weave: cannot index — the repository has no commits yet.", "warning");
        return;
      }
      await writeRepoIndex(root, index);
      ctx.ui.notify(`pi-weave: index refreshed\n${summarizeIndex(index).join("\n")}`, "info");

      if (args.trim().toLowerCase() === "deep") {
        if (inFlightDeepScans.has(root)) {
          ctx.ui.notify("pi-weave: a deep scan is already running for this repository — run /weave-scan-cancel to stop it.", "warning");
        } else {
          // Compute the settled status here (no git-lock contention) and let
          // the background scan restore it when it finishes.
          const status = await getWorkspaceStatus(ctx.cwd);
          startDeepScan(root, ctx, status, updateStatus);
        }
        return; // the background scan owns the status line until it settles
      }

      const status = await getWorkspaceStatus(ctx.cwd);
      updateStatus(ctx, formatStatusLine(status));
    },
  });

  pi.registerCommand("weave-scan-cancel", {
    description: "Cancel an in-flight /weave-scan deep run",
    handler: async (_args, ctx) => {
      const root = await findGitRoot(ctx.cwd);
      const scan = root ? inFlightDeepScans.get(root) : undefined;
      if (!scan) {
        ctx.ui.notify("pi-weave: no deep scan is currently running.", "info");
        return;
      }
      scan.controller.abort();
      ctx.ui.notify("pi-weave: deep scan cancellation requested.", "info");
    },
  });
}

/* ------------------------------------------------------------------ */
/* In-flight deep scans (background, cancellable)                      */
/* ------------------------------------------------------------------ */

interface InFlightDeepScan {
  controller: AbortController;
  /** Resolves when the background scan settles (done, cancelled, or torn down). */
  done: Promise<void>;
}

/** In-flight deep scans keyed by repo root — the /weave-scan-cancel target. */
const inFlightDeepScans = new Map<string, InFlightDeepScan>();

/** Test seam: resolve when the in-flight deep scan for `root` settles. */
export async function deepScanDone(root: string): Promise<void | undefined> {
  const canonical = await findGitRoot(root).catch(() => null);
  return inFlightDeepScans.get(canonical ?? root)?.done;
}

/**
 * Kick off a deep scan in the background so the user keeps control of the
 * session (a blocking command can't be cancelled in the TUI — Esc only aborts
 * streaming/bash). Progress is pushed to the status line; completion or
 * cancellation is reported via a notification. `baseStatus` is the workspace
 * status captured before the scan and restored when it settles.
 */
function startDeepScan(
  root: string,
  ctx: ExtensionCommandContext,
  baseStatus: WorkspaceStatus,
  updateStatus: (ctx?: ExtensionContext | ExtensionCommandContext, text?: string) => void,
): void {
  const controller = new AbortController();
  let doneResolve: () => void;
  const done = new Promise<void>((resolve) => {
    doneResolve = resolve;
  });
  inFlightDeepScans.set(root, { controller, done });

  void (async () => {
    try {
      updateStatus(ctx, "🧵 deep scan: starting…");
      const outcome = await deepScanRepository(root, ctx, {
        onProgress: ({ current, total, path }) => {
          const pct = total > 0 ? Math.round((current / total) * 100) : 100;
          updateStatus(ctx, `🧵 deep scan: ${current}/${total} (${pct}%) — ${path}`);
        },
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        ctx.ui.notify("pi-weave: deep scan cancelled.", "warning");
      } else if (outcome.kind === "no-model") {
        ctx.ui.notify(
          "pi-weave: deep scan needs an active session model — none configured. Light index only.",
          "warning",
        );
      } else if (outcome.kind === "ok") {
        ctx.ui.notify(`pi-weave: deep scan complete — ${formatDeepScanResult(outcome.result)}`, "info");
      }
    } catch {
      // session ended or extension torn down — stop quietly
    } finally {
      // Restore the settled status before removing the map entry, so a caller
      // awaiting deepScanDone() observes the settled status line.
      inFlightDeepScans.delete(root);
      updateStatus(ctx, formatStatusLine(baseStatus));
      doneResolve!();
    }
  })();
}
