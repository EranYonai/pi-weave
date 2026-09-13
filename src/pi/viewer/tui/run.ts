/**
 * runWeaveViewTui — wires the workspace explorer into a pi session
 * (weave-view-tui-design §2, §4.1, §3.2).
 *
 * Guards (interactive terminal only), builds the graph from disk in the
 * handler, then hands a ready workspace explorer to `ctx.ui.custom` so the
 * explorer owns input for its whole lifetime. After `done(null)` resolves,
 * the workspace status line is refreshed. Dependencies are injected so the
 * component never touches a real terminal directly.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  buildCurrentGraph,
  readNoteForView,
  readOkfFileForView,
  resolveVaultRoot,
} from "../../../core";
import { openNoteInEditor } from "./openNote";
import { WeaveWorkspace } from "./workspaceRoot";
import type { WeaveLoaders, WeaveTheme, WeaveTui } from "./surface/base";
import { getWorkspaceStatus, formatStatusLine } from "../../../core";

/** Open the in-terminal knowledge explorer. Returns when the explorer closes. */
export async function runWeaveViewTui(ctx: ExtensionCommandContext): Promise<void> {
  // Guard: the TUI needs an interactive terminal (design §2).
  if (!ctx.hasUI || ctx.mode !== "tui") {
    ctx.ui.notify(
      "pi-weave: '/weave-view' needs an interactive terminal to open the in-terminal explorer.",
      "warning",
    );
    return;
  }

  const cwd = ctx.cwd;
  const vaultRoot = resolveVaultRoot();
  const model = await buildCurrentGraph(cwd, vaultRoot);

  const loaders: WeaveLoaders = {
    loadNote: (slug) => readNoteForView(vaultRoot, slug),
    loadOkf: (rel) => readOkfFileForView(cwd, rel),
    openNote: (slug) => openNoteInEditor(vaultRoot, slug),
    rebuild: () => buildCurrentGraph(cwd, vaultRoot),
  };

  await ctx.ui.custom(
    (tui, theme, _keybindings, done) => {
      const explorer = new WeaveWorkspace({
        model,
        theme: theme as unknown as WeaveTheme,
        tui: tui as unknown as WeaveTui,
        loaders,
        done,
        rows: tui.terminal.rows,
      });
      return explorer;
    },
    // Full-screen, not an overlay (design §4.1).
  );

  // Refresh the status line after close (a /weave-scan may have landed meanwhile).
  const status = await getWorkspaceStatus(ctx.cwd);
  let theme: { fg?: (slot: string, text: string) => string } | undefined;
  try {
    theme = (ctx.ui as unknown as { theme?: { fg?: (slot: string, text: string) => string } })?.theme;
  } catch {
    // ignore
  }
  const indicator = theme?.fg ? theme.fg("dim", "○") : "○";
  ctx.ui.setStatus("weave", `${indicator} ${formatStatusLine(status)}`);
}
