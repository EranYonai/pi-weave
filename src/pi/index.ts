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
import { runWeaveViewTui } from "./viewer/tui/run";
import { WebWorkspaceController } from "./viewer/web/run";

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

  // /weave-view opens the browser workspace by default (weave-workspace §13);
  // `tui` selects the in-terminal explorer. The browser workspace owns a
  // server, a file watcher and live SSE streams for the rest of the session,
  // so unlike the TUI it has a real teardown — see `session_shutdown` below.
  let lastCtx: ExtensionContext | ExtensionCommandContext | null = null;
  let lastStatusText: string | undefined = undefined;
  let isActive = false;

  const web = new WebWorkspaceController({
    exec: (command, args) => pi.exec(command, args),
    // A boot or an idle shutdown changes what the status line should say, and
    // neither happens inside a command handler that could refresh it itself.
    onStateChange: () => updateStatus(),
  });

  function updateStatus(ctx?: ExtensionContext | ExtensionCommandContext, text?: string): void {
    if (ctx) lastCtx = ctx;
    const c = ctx || lastCtx;
    if (!c?.ui?.setStatus) return;
    if (text !== undefined) {
      lastStatusText = text;
    }

    // A running browser workspace is a background process the user cannot
    // otherwise see — an open port on their machine — so it always gets a
    // marker. Resolved *before* the "nothing to show" test, because the port
    // is itself something to show.
    //
    // This ordering is the fix for a real bug: the early return used to sit
    // above this lookup, so a workspace started in a session that never
    // emitted `session_start` (no seeded `lastStatusText`) did not merely
    // fail to gain the marker — it actively cleared the status line while a
    // server was listening. The browser-launch-failure path is exactly that
    // shape, which is why it was the case that caught it.
    const port = web.port();
    const suffix = port === null ? "" : ` · web:${port}`;

    // Clear only when there is genuinely nothing to say: no base text *and*
    // no server.
    if (!lastStatusText && port === null) {
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
    // With no base text the marker stands alone (`○ web:51234`) rather than
    // rendering a leading ` · ` separator against nothing.
    const body = lastStatusText ? `${lastStatusText}${suffix}` : `web:${port}`;
    c.ui.setStatus("weave", `${indicator} ${body}`);
  }

  pi.on("session_shutdown", async () => {
    // The TUI explorer owns nothing session-scoped, but the browser workspace
    // owns an HTTP server, a recursive file watcher and any number of open SSE
    // streams. `close()` releases all three (server.ts closes the hub and
    // awaits the watcher); a leaked listener outliving the pi session is a
    // real bug, not a tidiness concern.
    await web.close();
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
    description: "Open the knowledge workspace in your browser ('tui' for the in-terminal explorer, '--no-open' to just print the URL)",
    handler: async (args, ctx) => {
      const parsed = parseWeaveViewArgs(args);
      if (parsed === null) {
        ctx.ui.notify(WEAVE_VIEW_USAGE, "warning");
        return;
      }
      if (parsed.surface === "tui") {
        await runWeaveViewTui(ctx);
        return;
      }
      const outcome = await web.run(ctx, { open: parsed.open });
      // A browser that would not launch on a machine that has a terminal
      // still leaves the user somewhere to go. The server stays up — the URL
      // in the notification remains valid — and the TUI opens on top of it.
      if (outcome.fallbackToTui && ctx.mode === "tui") await runWeaveViewTui(ctx);
      // Unconditionally, and last: the TUI writes its own status line on
      // close, which would otherwise drop the `· web:PORT` marker for a
      // server that is still running.
      updateStatus(ctx);
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
/* /weave-view argument parsing                                        */
/* ------------------------------------------------------------------ */

export const WEAVE_VIEW_USAGE = "usage: /weave-view [tui|web] [--no-open]";

/** Which explorer `/weave-view` was asked for. */
export interface WeaveViewArgs {
  surface: "tui" | "web";
  /** `false` for `--no-open`. Meaningless for `tui`, which never opens one. */
  open: boolean;
}

/**
 * Parse `/weave-view`'s argument string, or `null` for "print the usage".
 *
 * Bare `/weave-view` is the **browser** workspace (weave-workspace §13):
 * the default is the thing most people want most of the time, and `tui` is
 * one word away for the SSH case. `--no-open` is accepted on the web
 * surface only — silently ignoring it after `tui` would be a lie about what
 * happened.
 *
 * Exported because a parser is exactly the kind of thing that should be
 * tested as a table rather than through eight command invocations.
 */
export function parseWeaveViewArgs(args: string): WeaveViewArgs | null {
  const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let surface: "tui" | "web" = "web";
  let open = true;
  let sawSurface = false;
  for (const token of tokens) {
    if (token === "--no-open") {
      // Rejecting the repeat costs nothing and keeps "did I typo?" honest.
      if (!open) return null;
      open = false;
      continue;
    }
    if (sawSurface) return null;
    if (token !== "tui" && token !== "web") return null;
    surface = token;
    sawSurface = true;
  }
  if (surface === "tui" && !open) return null;
  return { surface, open };
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
      updateStatus(ctx, "🕸️ deep scan: starting…");
      const outcome = await deepScanRepository(root, ctx, {
        onProgress: ({ current, total, path }) => {
          const pct = total > 0 ? Math.round((current / total) * 100) : 100;
          updateStatus(ctx, `🕸️ deep scan: ${current}/${total} (${pct}%) — ${path}`);
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
