/**
 * Where a note's append-only `## Raw` tail begins (weave-workspace §1.2).
 *
 * Pure and node-free on purpose: the vault uses it to keep the on-disk tail
 * whatever a save says, and the browser editor uses the same function,
 * through `src/web/shared/view.ts`, to keep the tail out of the textarea.
 * Two implementations would disagree about a fenced `## Raw` sample, and the
 * editor would then hide text the server is willing to overwrite.
 */

/**
 * The append-only tail heading.
 *
 * `../links/repair` and `../vault` re-export it, so their public API is
 * unchanged.
 */
export const RAW_NOTES_HEADING = "## Raw";

const FENCE_RE = /^[ \t]*(`{3,}|~{3,})(.*)$/gm;
/** A `## Raw` heading on a line of its own — not `## Rawhide`. */
const RAW_HEADING_RE = new RegExp(`^${RAW_NOTES_HEADING}[ \\t]*\\r?$`, "m");

/**
 * Half-open `[start, end)` ranges covering fenced code blocks.
 *
 * CommonMark, not "every third-backtick-line toggles": a fence is closed only
 * by the **same marker character**, at **at least the opening length**, and
 * with no info string. Treating fences as a blind alternation gets two cases
 * backwards — a `~~~` nested inside a ``` block would close it, and a ```
 * inside a ```` block would too — and each mistake ends the protected region
 * early, exposing example links in documentation to rewriting.
 */
export function fenceRanges(body: string): [number, number][] {
  const ranges: [number, number][] = [];
  let open: { at: number; marker: string; length: number } | null = null;
  for (const match of body.matchAll(FENCE_RE)) {
    const run = match[1]!;
    // Group 2 is `(.*)`, which always participates: the info string.
    const info = match[2]!;
    if (open === null) {
      open = { at: match.index, marker: run[0]!, length: run.length };
    } else if (run[0] === open.marker && run.length >= open.length && info.trim() === "") {
      ranges.push([open.at, match.index + match[0].length]);
      open = null;
    }
  }
  // An unterminated fence runs to the end of the body, the way a renderer
  // treats it.
  if (open !== null) ranges.push([open.at, body.length]);
  return ranges;
}

/**
 * The byte offset where the `## Raw` tail begins, or the body length when
 * there is none.
 *
 * The tail is append-only and verbatim — "NEVER edit below this line" is
 * written into every note that has one. A link inside a user's dictation is
 * *their* text, quoted; repairing it would edit words the vault promises not
 * to touch.
 *
 * Fence-aware, and for the opposite reason to everything else here: a note
 * *documenting* the raw-tail convention contains `## Raw` inside a code
 * sample, and treating that as the real tail would silently protect — and so
 * refuse to repair — every link below it. Matching a whole heading line also
 * keeps `## Rawhide` from starting a tail.
 */
export function rawTailStart(body: string, fences: readonly [number, number][]): number {
  let from = 0;
  for (;;) {
    const rest = body.slice(from);
    const hit = RAW_HEADING_RE.exec(rest);
    if (hit === null) return body.length;
    const at = from + hit.index;
    const fence = fences.find(([a, b]) => at >= a && at < b);
    if (fence === undefined) return at;
    from = fence[1]; // skip the whole fenced block and keep looking
  }
}

/** A `---` rule, alone on the line, with only blank space after it. */
const TAIL_RULE_RE = /(?:^|\n)-{3,}[ \t]*\r?\n\s*$/;

/**
 * Where the tail's text begins — the `---` rule, not the heading
 * `rawTailStart` returns. Splitting at the heading orphans the rule.
 * The body length when there is no tail.
 */
export function rawTailBoundary(body: string): number {
  const heading = rawTailStart(body, fenceRanges(body));
  if (heading === body.length) return heading;
  const rule = TAIL_RULE_RE.exec(body.slice(0, heading));
  if (rule === null) return heading;
  // `index` is the newline before the rule when there is one; step over it.
  return rule.index === 0 && !body.startsWith("\n") ? 0 : rule.index + 1;
}

/** A body split at its tail: the editable `head`, and the verbatim `tail` ("" when none). */
export interface RawTailSplit {
  head: string;
  tail: string;
}

/**
 * Split a body into the part a person may edit and the tail nobody may.
 *
 * The head loses only trailing whitespace, so the editor's cursor lands
 * right after the last word rather than on the blank lines before the rule.
 */
export function splitRawTail(body: string): RawTailSplit {
  const at = rawTailBoundary(body);
  return { head: body.slice(0, at).trimEnd(), tail: body.slice(at).trimEnd() };
}

/** Put a head back above its tail, the inverse of {@link splitRawTail}. */
export function joinRawTail(head: string, tail: string): string {
  if (tail === "") return head;
  // An emptied head leaves the tail alone, not a leading blank line.
  return head === "" ? tail : `${head}\n\n${tail}`;
}
