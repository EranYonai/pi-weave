/**
 * openNote — open a vault note in the user's editor (weave-view tui).
 *
 * Lifted out of the old browser viewer's `server.ts` when the in-browser
 * viewer was retired in favour of a pixi.js rewrite; the TUI's `openNote`
 * loader is the only remaining caller. The slug is validated against the
 * vault (traversal-safe) before any shell-out, so an unsafe or missing
 * note never reaches the editor.
 */

import { execFile } from "node:child_process";
import { platform } from "node:os";
import { promisify } from "node:util";
import { getNote, resolveNotePath } from "../../../core";

const execFileAsync = promisify(execFile);

/**
 * The OS command used to open a note file in the user's editor. Respects
 * $EDITOR / $VISUAL (which may carry args, e.g. "code --wait"); falls back
 * to the platform default opener. `env` and `os` are injectable so the
 * mapping is unit-testable on any host without stubbing globals.
 */
export function openNoteCommand(
  notePath: string,
  env: NodeJS.ProcessEnv = process.env,
  os: NodeJS.Platform = platform(),
): { command: string; args: string[] } {
  const editor = (env.EDITOR || env.VISUAL || "").trim();
  if (editor) {
    // editor is a trimmed non-empty string, so split+filter always yields a
    // first segment — assert it rather than leave a dead `?? ""` branch.
    const parts = editor.split(/\s+/).filter(Boolean);
    const command = parts[0] as string;
    return { command, args: [...parts.slice(1), notePath] };
  }
  if (os === "darwin") return { command: "open", args: [notePath] };
  if (os === "win32") return { command: "cmd", args: ["/c", "start", "", notePath] };
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