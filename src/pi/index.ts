import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  buildRepoIndex,
  findGitRoot,
  formatDashboard,
  formatStatusLine,
  getWorkspaceStatus,
  summarizeIndex,
  writeRepoIndex,
} from "../core";
import { registerNoteTool } from "./tools/noteTool";
import { registerRepoTool } from "./tools/repoTool";
import { deepScanRepository, formatDeepScanResult } from "./summarize";
import { openInBrowser } from "./viewer/browser";
import { startViewer, type ViewerServer } from "./viewer/server";

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

  pi.on("session_shutdown", async () => {
    const server = viewer;
    viewer = null;
    await server?.stop();
  });

  pi.on("session_start", async (_event, ctx) => {
    const status = await getWorkspaceStatus(ctx.cwd);
    ctx.ui.setStatus("weave", formatStatusLine(status));

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
    description: "Open the local knowledge-graph viewer in your browser (vault + repository)",
    handler: async (_args, ctx) => {
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
        ctx.ui.setStatus("weave", "🧵 deep scan: summarizing files with the session model…");
        const outcome = await deepScanRepository(root, ctx);
        if (outcome.kind === "no-model") {
          ctx.ui.notify(
            "pi-weave: deep scan needs an active session model — none configured. Light index only.",
            "warning",
          );
        } else if (outcome.kind === "ok") {
          ctx.ui.notify(`pi-weave: deep scan complete — ${formatDeepScanResult(outcome.result)}`, "info");
        }
      }

      const status = await getWorkspaceStatus(ctx.cwd);
      ctx.ui.setStatus("weave", formatStatusLine(status));
    },
  });
}
