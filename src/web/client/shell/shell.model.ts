/**
 * Everything the shell *decides*, as pure functions (weave-workspace §1.2).
 *
 * The Recent list, per-column empty-state copy and footer status text live
 * here rather than inside the components that render them.
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

import type { GraphPayload, WireNodeKind } from "../../shared/wire";
import { kindIcon } from "../tree/tree.model";
import type { IconName } from "./icons.model";
export const NOTE_DRAG_TYPE = "application/x-weave-note";

/** Pane drops open only note IDs that still exist in this workspace. */
export function noteDropId(graph: GraphPayload | null, id: string): string | null {
  return id.startsWith("note:") && graph?.model.nodes.some((node) => node.id === id && node.kind === "note") ? id : null;
}

export type ColumnId = "tree" | "note" | "graph";
export const COLUMNS: readonly ColumnId[] = ["tree", "note", "graph"];

/** Most recent selections in this window, independent of whether their tabs stay open. */
export function recordVisit(previous: readonly string[], id: string | null): readonly string[] {
  return id === null ? previous : [id, ...previous.filter((item) => item !== id)].slice(0, 100);
}

/** A selected graph node opens only after its preview has already been shown. */
export function graphClickOpensTab(previewId: string | null, id: string | null): id is string {
  return id !== null && id === previewId;
}

export interface RecentEntry {
  readonly id: string;
  readonly label: string;
  readonly icon: IconName;
  readonly selected: boolean;
}

/** Present a frozen visit order without changing it when selection moves. */
export function recentEntries(ids: readonly string[], graph: GraphPayload | null, selectedId: string | null): RecentEntry[] {
  return ids.map((id) => {
    const node = graph?.model.nodes.find((entry) => entry.id === id);
    const kind: WireNodeKind = node?.kind ?? (id.startsWith("vfolder:") ? "module" : id.startsWith("artifact:") ? "file" : "note");
    return { id, label: node?.label ?? id.replace(/^[^:]+:/, ""), icon: kindIcon(kind), selected: id === selectedId };
  });
}

// --- empty states ------------------------------------------------------------------

/** The title used by a column heading and its `aria-label`. */
export interface EmptyStateCopy {
  readonly title: string;
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
}

/** The `—` shown where a value is genuinely absent, not zero. */
export const NO_VALUE = "—";

/** Build the status bar's model. */
export function statusBarModel(
  cwd: string,
  selectedId: string | null,
): StatusBarModel {
  return {
    cwd: cwd === "" ? NO_VALUE : cwd,
    selection: selectedId ?? "nothing selected",
  };
}

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

/** The shortcut hint. `⌘K` on Apple platforms, `Ctrl K` elsewhere. */
export function searchShortcut(isApple: boolean): string {
  return isApple ? "⌘K" : "Ctrl K";
}

/** The search action's tooltip, including the key that also opens it. */
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
export type OverlayId = "search" | "help" | "settings" | "graph" | null;

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
