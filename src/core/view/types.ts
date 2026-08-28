/**
 * Shared row/meta types for the portable view-models (weave-workspace §3).
 *
 * These are *renderer-agnostic*: no terminal widths, no pre-truncation, no
 * DOM. The TUI and the browser workspace both consume them and each applies
 * its own formatting.
 */

/** A selectable row in any surface. `target` (when set) is the node id a row
 *  jumps to on activation (a link / neighbor). */
export interface SelectableRow {
  id: string;
  /** Node id this row jumps to on activation (links/backlinks/neighbors). */
  target?: string;
}

/**
 * The dim trailing annotation on a tree row, as structured data.
 *
 * Deliberately *not* a formatted string: a terminal column, an HTML `<span>`,
 * and a `<time>` element each want something different, and a relative time
 * has to be re-derived as the clock moves. `formatTreeMeta` (view/time.ts)
 * reproduces the terminal phrasing; other renderers are free to ignore it.
 */
export type TreeMeta =
  /** Relative timestamp, e.g. a note's `updated`. Rendered against a clock. */
  | { kind: "relTime"; iso: string }
  /**
   * A counted quantity. `phrasing` is a display hint, not a hard rule:
   * `"attribute"` reads as `unit=n` (a property of the row), `"prose"` reads
   * as `n unit` (a description of it).
   */
  | { kind: "count"; n: number; unit: string; phrasing: "attribute" | "prose" }
  /** A full commit sha; renderers abbreviate to taste. */
  | { kind: "commit"; sha: string }
  /** An opaque, already-human string (a package kind, a marker word). */
  | { kind: "text"; text: string }
  /** No annotation. */
  | null;
