/**
 * Browser opening for /weave-view (docs/weave-view.md §4).
 * Kept separate from the command so the per-platform command mapping is
 * unit-testable without stubbing globals.
 */

import { platform } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** The OS command used to open a URL in the default browser. */
export function browserCommand(
  url: string,
  os: NodeJS.Platform = platform(),
): { command: string; args: string[] } {
  if (os === "darwin") return { command: "open", args: [url] };
  if (os === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

/**
 * Open the viewer URL in the user's browser — only in TUI mode with UI
 * present; suppressible via PI_WEAVE_VIEW_NO_OPEN=1 (CI/headless/evals).
 */
export async function openInBrowser(pi: ExtensionAPI, ctx: ExtensionContext, url: string): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui") return;
  if (process.env.PI_WEAVE_VIEW_NO_OPEN === "1") return;
  const { command, args } = browserCommand(url);
  await pi.exec(command, args, { timeout: 5_000 });
}
