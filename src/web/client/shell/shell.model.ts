/**
 * Everything the shell *decides*, as pure functions (weave-workspace §1.2).
 *
 * The header's status summary, the per-column empty-state copy and the status
 * bar's text all live here rather than inside the components that render them.
 * That is not a stylistic
 * preference: §10 forbids adding a DOM test environment, so a conditional
 * inside a `.tsx` is a conditional that can never be covered, and §14 lists
 * "coverage gate blocks the UI work" as a live risk whose stated mitigation
 * is exactly this split. Each `.tsx` under `shell/` is therefore props-in,
 * JSX-out, with every branch it might have wanted resolved here first.
 *
 * Compiled by the root `tsconfig.json` when a test imports it, so: no DOM
 * types, no `node:*`, no `src/core`.
 */

import type { GraphPayload, WireNodeKind, WireStalenessState } from "../../shared/wire";
import { COLUMNS, type ColumnId } from "./layout.model";
export { COLUMNS };
export type { ColumnId };

// --- the header summary --------------------------------------------------------

/**
 * The `vault:34 · repo:fresh · 127 nodes` readout from the §1.2 sketch.
 *
 * Kept as three fields rather than one pre-joined string so the component can
 * put a separator between them without this module owning a `·`, and so a
 * test asserts the numbers rather than a formatting decision.
 */
export interface HeaderSummary {
  /** Note nodes in the vault. */
  readonly notes: number;
  /** Repository index freshness, or `null` when the repo is unindexed. */
  readonly repo: WireStalenessState | null;
  /** Every node, of every kind. */
  readonly nodes: number;
}

/** The summary before the first graph arrives. */
export const EMPTY_SUMMARY: HeaderSummary = { notes: 0, repo: null, nodes: 0 };

/**
 * Which node kinds count as "vault" for the header.
 *
 * Only `note`. The `vault` node itself is the container, and counting it
 * would make an empty vault read `vault:1` — a number that is technically
 * defensible and would still be read as "there is one note in there".
 */
const VAULT_KINDS: readonly WireNodeKind[] = ["note"];

/** Derive the header counts from a payload. */
export function summarize(payload: GraphPayload | null): HeaderSummary {
  if (payload === null) return EMPTY_SUMMARY;
  const nodes = payload.model.nodes;
  return {
    notes: nodes.filter((node) => VAULT_KINDS.includes(node.kind)).length,
    repo: payload.model.staleness?.state ?? null,
    nodes: nodes.length,
  };
}

/**
 * The repo segment's text.
 *
 * `"unindexed"` rather than `"missing"` for a null or `missing` staleness:
 * "missing" reads as an error, and a repository that has simply never been
 * scanned is the ordinary first-run state, not a fault. The word the user
 * needs is the one that implies an action they can take.
 */
export function repoLabel(repo: WireStalenessState | null): string {
  return repo === null || repo === "missing" ? "unindexed" : repo;
}

/** `vault:34 · repo:fresh · 127 nodes`, as the pieces to join. */
export function summaryParts(summary: HeaderSummary): readonly string[] {
  return [`vault:${summary.notes}`, `repo:${repoLabel(summary.repo)}`, `${summary.nodes} nodes`];
}

// --- empty states ------------------------------------------------------------------

/** The title used by a column heading and its `aria-label`. */
export interface EmptyStateCopy {
  readonly title: string;
}

const EMPTY_STATES: Readonly<Record<ColumnId, EmptyStateCopy>> = {
  tree: {
    title: "Tree",
  },
  note: {
    title: "Note",
  },
  graph: {
    title: "Graph",
  },
};

/** The empty-state copy for a column. */
export function emptyStateFor(column: ColumnId): EmptyStateCopy {
  return EMPTY_STATES[column];
}

/** The context rail's heading and `aria-label`. */
export const CONTEXT_EMPTY: EmptyStateCopy = {
  title: "Context",
};

// --- the status bar -------------------------------------------------------------------

/**
 * The status bar's segments, left to right.
 *
 * The selection is included because it is the one piece of state that is
 * otherwise invisible at P1: with all three columns showing empty states,
 * clicking something would have no observable effect at all, and a shell
 * whose context bus cannot be seen working is a shell nobody can tell is
 * wired up.
 */
export interface StatusBarModel {
  readonly cwd: string;
  readonly selection: string;
  /** `null` before the first successful graph fetch. */
  readonly stamp: string | null;
}

/** The `—` shown where a value is genuinely absent, not zero. */
export const NO_VALUE = "—";

/** Build the status bar's model. */
export function statusBarModel(
  cwd: string,
  selectedId: string | null,
  stamp: string | null,
): StatusBarModel {
  return {
    cwd: cwd === "" ? NO_VALUE : cwd,
    selection: selectedId ?? "nothing selected",
    stamp,
  };
}

/**
 * A `generatedAt` stamp, shortened for the status bar.
 *
 * Just the `HH:MM:SS`, because the date is almost always today and the whole
 * ISO string is 24 characters of mostly-constant noise in a bar that has
 * three other things to say. A stamp that does not look like an ISO timestamp
 * is passed through untouched rather than sliced blindly — the server derives
 * it from input timestamps and is free to change that derivation, and a
 * mangled substring would be a worse lie than the full value.
 */
export function shortStamp(stamp: string | null): string {
  if (stamp === null) return NO_VALUE;
  const match = /T(\d{2}:\d{2}:\d{2})/.exec(stamp);
  return match?.[1] ?? stamp;
}

// --- the refresh button ------------------------------------------------------------

/**
 * The refresh control's glyph, as SVG path data.
 *
 * A drawn icon replaces the `⟳` text character for the same reason §P6.4
 * retires the tree's glyph soup: a text arrow is whatever the platform's
 * fallback font draws it as, while these two strokes are the brand's own
 * weight everywhere. Stored as pure data here — §10 — so `Header.tsx` stays
 * props-in/JSX-out and the shape is testable without a DOM. 24×24 viewBox,
 * stroked, `currentColor`: the header recolours it on hover like any other
 * glyph.
 */
export const REFRESH_ICON_PATHS: readonly string[] = [
  "M21 12a9 9 0 1 1-2.64-6.36",
  "M21 3v6h-6",
];

/**
 * How often the shell re-renders on its own, in ms.
 *
 * Every relative time ("8h ago") is computed from a `now` the shell stamps
 * per render, and a resting workspace never re-renders — so without this tick
 * the minutes go stale ("2h ago" at 2:59 still reads "2h ago" at 3:20). One
 * 60 s tick is the smallest honest answer: finer-grained would re-render the
 * whole shell for pixels nobody reads, coarser makes every "8h ago" wrong for
 * most of an hour. The §7 register's "don't add a timer" refers to the graph's
 * RAF clock, which idles by construction; this is wall-clock copy, not physics.
 */
export const TICK_MS = 60_000;

// --- the search affordance ---------------------------------------------------------

/**
 * The `⌘K` control.
 *
 * Rendered **disabled** through P1–P3, with a title saying search arrived in
 * P4 — a deliberate choice over omitting it: the keyboard hint taught the
 * shortcut that would exist, and a `disabled` control explaining itself is
 * honest in a way that a working-looking box that does nothing is not.
 *
 * P4 made it live, and it is now a *button* rather than an `<input>`. The
 * palette owns the only text field, so a second one in the header would be
 * two places to type a query into and one of them would be a lie — clicking
 * it opens the overlay and whatever was typed into the header box would be
 * discarded. A button that looks like a search field and opens the real one
 * is the affordance the §1.2 sketch actually describes.
 */
export const SEARCH_PLACEHOLDER = "Search…";

/** The shortcut hint. `⌘K` on Apple platforms, `Ctrl K` elsewhere. */
export function searchShortcut(isApple: boolean): string {
  return isApple ? "⌘K" : "Ctrl K";
}

/** The `title=` on the live search button. Names the key that also opens it. */
export function searchHint(shortcut: string): string {
  return `Search notes and repository (${shortcut})`;
}

// --- overlays ------------------------------------------------------------------

/**
 * Which modal surface is open, if any.
 *
 * A single nullable id rather than one boolean per overlay, because the two
 * are **mutually exclusive** and two booleans can represent a state that is
 * not — help and search both open, stacked, each trapping focus against the
 * other. Making that unrepresentable costs nothing here and removes a whole
 * class of bug from the keyboard layer, which is the thing that opens them.
 */
export type OverlayId = "search" | "help" | null;

/**
 * Whether a platform string looks like an Apple one.
 *
 * Takes the string rather than reading `navigator`, so it is testable and so
 * the single DOM read happens at the one call site in the shell. Substring
 * matching on `Mac`, `iPhone` and `iPad` covers what `navigator.platform` and
 * `userAgent` produce; anything unrecognised gets the `Ctrl` spelling, which
 * is the right default because non-Apple is the larger population.
 */
export function looksApple(platform: string): boolean {
  return /mac|iphone|ipad/i.test(platform);
}
