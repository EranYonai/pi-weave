/**
 * Replay: the pure half of the note history slider.
 *
 * The server sends every saved revision of a note, oldest first (see
 * `src/core/history.ts`). This module decides what one step of the slider
 * says ("Agent rewrote the summary · 10:05 · +120 −40") and which text that
 * step added, so the column can highlight it.
 *
 * ## Highlighting through Markdown
 *
 * The added text is found in the Markdown source, but it has to be shown in
 * the rendered HTML. So the source is marked with two private-use characters,
 * {@link MARK_OPEN} and {@link MARK_CLOSE}, before it is rendered, and the
 * column turns the marked text nodes into `<mark>` elements afterwards
 * ({@link splitMarked}). The markers are characters, not tags, so they pass
 * through the renderer and the sanitiser as plain text and cannot introduce
 * markup of their own.
 *
 * A marker must not change what the Markdown means, so {@link markChange}
 * puts one pair on each changed line, after any block syntax (`## `, `- `,
 * `> `), skips fence and rule lines, and widens a range to cover a whole link
 * rather than splitting `[[target]]` or `(url)`.
 */

import type { HistoryRevision } from "../../shared/wire";

export const MARK_OPEN = "";
export const MARK_CLOSE = "";

/** Milliseconds between steps while playing. */
export const PLAY_INTERVAL_MS = 900;

/** The smallest prefix/suffix-preserving edit from `from` to `to` (same rule as core's log). */
export function changedRange(from: string, to: string): { start: number; end: number; removed: number } {
  const max = Math.min(from.length, to.length);
  let head = 0;
  while (head < max && from.charCodeAt(head) === to.charCodeAt(head)) head++;
  let tail = 0;
  while (tail < max - head && from.charCodeAt(from.length - 1 - tail) === to.charCodeAt(to.length - 1 - tail)) tail++;
  return { start: head, end: to.length - tail, removed: from.length - tail - head };
}

const BLOCK_PREFIX_RE = /^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|(?:[*+-]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)*/;
const SKIP_LINE_RE = /^[ \t]*(?:`{3,}|~{3,}|<!--|(?:[-*_][ \t]*){3,}$)/;
const LINK_RE = /!?\[\[[^\]\n]*\]\]|!?\[[^\]\n]*\]\([^)\n]*\)|<[a-z][a-z0-9+.-]*:[^>\s]*>/gi;

/** Mark the text `body` gained over `previous` (the whole body for the first revision). */
export function markChange(previous: string | null, body: string): string {
  const { start, end } = changedRange(previous ?? "", body);
  if (start >= end) return body;
  const ranges: Array<[number, number]> = [];
  let lineStart = body.lastIndexOf("\n", start - 1) + 1;
  while (lineStart < end) {
    const newline = body.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? body.length : newline;
    const line = body.slice(lineStart, lineEnd);
    if (!SKIP_LINE_RE.test(line)) {
      const prefix = (BLOCK_PREFIX_RE.exec(line) as RegExpExecArray)[0].length;
      let from = Math.max(start - lineStart, prefix);
      let to = Math.min(end, lineEnd) - lineStart;
      for (const link of line.matchAll(LINK_RE)) {
        const linkEnd = (link.index as number) + link[0].length;
        if (from > (link.index as number) && from < linkEnd) from = link.index as number;
        if (to > (link.index as number) && to < linkEnd) to = linkEnd;
      }
      if (line.slice(from, to).trim() !== "") ranges.push([lineStart + from, lineStart + to]);
    }
    lineStart = lineEnd + 1;
  }
  let marked = body;
  for (const [from, to] of ranges.reverse()) {
    marked = marked.slice(0, from) + MARK_OPEN + marked.slice(from, to) + MARK_CLOSE + marked.slice(to);
  }
  return marked;
}

/**
 * Split one text node's text at the markers. `inside` carries over from the
 * previous text node, because a marked range can span elements
 * (`plain **bold** plain`).
 */
export function splitMarked(text: string, inside: boolean): { parts: Array<{ text: string; marked: boolean }>; inside: boolean } {
  const parts: Array<{ text: string; marked: boolean }> = [];
  let current = "";
  let state = inside;
  for (const char of text) {
    if (char === MARK_OPEN || char === MARK_CLOSE) {
      if (current !== "") parts.push({ text: current, marked: state });
      current = "";
      state = char === MARK_OPEN;
    } else {
      current += char;
    }
  }
  if (current !== "") parts.push({ text: current, marked: state });
  return { parts, inside: state };
}

const WHO: Record<HistoryRevision["by"], string> = {
  human: "You",
  agent: "Agent",
  outside: "Outside edit",
  system: "pi-weave",
};

const WHAT: Record<string, string> = {
  create: "created the note",
  edit: "edited",
  append: "added to the note",
  raw: "added words to Raw",
  finalize: "rewrote the summary",
  generate: "generated the note",
  repair: "fixed links",
  outside: "changed outside pi-weave",
  baseline: "earliest saved version",
};

/** One step of the slider, as the column shows it. */
export interface ReplayStep {
  /** "3 of 12". */
  position: string;
  /** "Agent rewrote the summary". */
  action: string;
  /** Short local time; the full ISO string goes in `atIso`. */
  at: string;
  atIso: string;
  /** "+120 −40", or "" when nothing changed in the text. */
  change: string;
  /** The body to render, with the added text marked. */
  marked: string;
  by: HistoryRevision["by"];
}

function shortTime(iso: string, previous: string | null): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const sameDay = previous !== null && new Date(previous).toDateString() === date.toDateString();
  return sameDay ? time : `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

/** Describe revision `index`. Clamped, so a stale index after a refetch still shows something. */
export function replayStep(revisions: readonly HistoryRevision[], index: number): ReplayStep | null {
  if (revisions.length === 0) return null;
  const i = Math.max(0, Math.min(revisions.length - 1, index));
  const revision = revisions[i] as HistoryRevision;
  const previous = i === 0 ? null : (revisions[i - 1] as HistoryRevision);
  const range = changedRange(previous?.body ?? "", revision.body);
  const added = range.end - range.start;
  const change = [added > 0 ? `+${added}` : "", range.removed > 0 ? `−${range.removed}` : ""].filter(Boolean).join(" ");
  const what = WHAT[revision.op] ?? revision.op;
  return {
    position: `${i + 1} of ${revisions.length}`,
    action: revision.op === "baseline" ? what[0]!.toUpperCase() + what.slice(1) : `${WHO[revision.by]} ${what}`,
    at: shortTime(revision.at, previous?.at ?? null),
    atIso: revision.at,
    change,
    marked: markChange(previous?.body ?? null, revision.body),
    by: revision.by,
  };
}

/** The next index while playing, or null at the end. */
export function nextStep(index: number, count: number): number | null {
  return index + 1 < count ? index + 1 : null;
}

export const HISTORY_LABEL = "History";
export const HISTORY_CLOSE_LABEL = "Close history";
export const HISTORY_OFF_HINT = "History is off, so new changes are not being saved. Turn it on in Settings → Editor.";
export const HISTORY_EMPTY = "No saved versions yet. Changes are saved from now on.";
