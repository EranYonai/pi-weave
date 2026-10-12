/**
 * The edit bar: the pure half (the refresh's E1).
 *
 * While a note is being edited, one bar under the title says so, carries the
 * formatting buttons, shows whether the edits are on disk yet, and offers
 * Discard and Done. Saving is automatic: a short pause in typing writes the
 * draft (see `drafts.ts`, `keepOpen`), so Done only has to catch up and close.
 *
 * Everything that can be decided without a DOM is here: what the status says,
 * and how a formatting button rewrites the text around the selection.
 */

import type { IconName } from "../shell/icons.model";

/** How long typing has to pause before the draft is written. */
export const AUTOSAVE_MS = 2500;

export const EDITING_LABEL = "Editing";
export const DISCARD_EDITS_LABEL = "Discard changes";
export const RETRY_LABEL = "Retry";
/** Asked before Discard writes the opening version back over autosaved edits. */
export const REVERT_PROMPT = "Put this note back the way it was when you started editing?";

/** What the status slot shows. */
export type EditStatusKind = "saving" | "failed" | "pending" | "saved" | "clean";

export interface EditStatus {
  kind: EditStatusKind;
  label: string;
}

/** The parts of a draft the status depends on. */
export interface EditStatusInput {
  saving: boolean;
  failed: boolean;
  /** Edits not yet on disk. */
  dirty: boolean;
  savedAt: number | null;
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** The status slot, in priority order: a write in flight, a failed one, waiting edits, the last save. */
export function editStatus(input: EditStatusInput): EditStatus {
  if (input.saving) return { kind: "saving", label: "Saving…" };
  if (input.failed) return { kind: "failed", label: "Not saved" };
  if (input.dirty) return { kind: "pending", label: "Unsaved changes" };
  if (input.savedAt !== null) return { kind: "saved", label: `Saved ${clock(input.savedAt)}` };
  return { kind: "clean", label: "No changes yet" };
}

/** The formatting buttons, in bar order. */
export type FormatKind = "heading" | "bold" | "italic" | "link" | "wikilink" | "task";

export interface FormatTool {
  kind: FormatKind;
  icon: IconName;
  label: string;
  /** The key that applies it with ⌘/Ctrl, if any. */
  key: string | null;
}

export const FORMAT_TOOLS: readonly FormatTool[] = [
  { kind: "heading", icon: "heading", label: "Heading", key: null },
  { kind: "bold", icon: "bold", label: "Bold", key: "b" },
  { kind: "italic", icon: "italic", label: "Italic", key: "i" },
  { kind: "link", icon: "link", label: "Link", key: "k" },
  { kind: "wikilink", icon: "wikilink", label: "Link to a note", key: null },
  { kind: "task", icon: "task", label: "Task", key: null },
];

/** The tool bound to a ⌘/Ctrl key, if any. */
export function formatForKey(key: string): FormatKind | null {
  return FORMAT_TOOLS.find((tool) => tool.key === key.toLowerCase())?.kind ?? null;
}

/** A textarea's value and selection. */
export interface TextEdit {
  value: string;
  start: number;
  end: number;
}

/** Wrap the selection, or insert a placeholder and select it so typing replaces it. */
function wrap(edit: TextEdit, before: string, after: string, placeholder: string): TextEdit {
  const selected = edit.value.slice(edit.start, edit.end);
  const inner = selected === "" ? placeholder : selected;
  const value = edit.value.slice(0, edit.start) + before + inner + after + edit.value.slice(edit.end);
  return { value, start: edit.start + before.length, end: edit.start + before.length + inner.length };
}

/** Rewrite every line the selection touches. */
function eachLine(edit: TextEdit, rewrite: (line: string) => string): TextEdit {
  const from = edit.value.lastIndexOf("\n", edit.start - 1) + 1;
  const newline = edit.value.indexOf("\n", edit.end);
  const to = newline === -1 ? edit.value.length : newline;
  const lines = edit.value.slice(from, to).split("\n").map(rewrite).join("\n");
  const value = edit.value.slice(0, from) + lines + edit.value.slice(to);
  return { value, start: from, end: from + lines.length };
}

const HEADING_RE = /^#{1,6}[ \t]+/;
const TASK_RE = /^([ \t]*)[-*+][ \t]+\[[ xX]\][ \t]+/;
const BULLET_RE = /^([ \t]*)[-*+][ \t]+/;

/** Apply one formatting button to the text around the selection. */
export function applyFormat(edit: TextEdit, kind: FormatKind): TextEdit {
  switch (kind) {
    case "bold":
      return wrap(edit, "**", "**", "bold text");
    case "italic":
      return wrap(edit, "_", "_", "italic text");
    case "wikilink":
      return wrap(edit, "[[", "]]", "note title");
    case "link": {
      const selected = edit.value.slice(edit.start, edit.end);
      if (selected === "") return wrap(edit, "[", "](https://)", "link text");
      // With text selected, the URL is what is left to type, so select that.
      const value = `${edit.value.slice(0, edit.start)}[${selected}](https://)${edit.value.slice(edit.end)}`;
      const url = edit.start + selected.length + 3;
      return { value, start: url, end: url + "https://".length };
    }
    case "heading":
      return eachLine(edit, (line) => (HEADING_RE.test(line) ? line.replace(HEADING_RE, "") : `## ${line}`));
    case "task":
      return eachLine(edit, (line) => {
        if (TASK_RE.test(line)) return line.replace(TASK_RE, "$1");
        if (BULLET_RE.test(line)) return line.replace(BULLET_RE, "$1- [ ] ");
        return `- [ ] ${line}`;
      });
  }
}
