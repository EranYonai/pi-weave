/**
 * selection.storage.ts — the §1.3 context bus's memory across reloads.
 *
 * A manual refresh used to drop the open note: `selectedId` is a Preact
 * signal, and signals do not survive a page load. The layout already
 * persists (`shell/layout.model.ts`), and this is the same trick for the
 * one piece of selection state the user actually misses: which note they
 * were reading.
 *
 * ## Restore needs the graph
 *
 * A saved id is only offered back if it still names a node of the freshly
 * loaded graph — a note deleted in another window must not resurrect as a
 * selection pointing at nothing. That check needs the graph, which arrives
 * after mount, so the restore is deliberately a pure function of
 * `(graph, storage)` the shell calls once the first graph lands, not
 * something this module schedules itself.
 *
 * ## Tier rules (§2)
 *
 * `src/web/client/**`: storage arrives as a two-method port (same shape as
 * `LayoutStorage`) rather than the global, because the real `localStorage`
 * throws in partitioned-storage contexts and a module this small should be
 * testable without a DOM.
 */

import type { GraphPayload } from "../shared/wire";

/** The slice of `Storage` this module needs. */
export interface SelectionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Versioned like `pi-weave.layout.v1`: an id-shape change gets a new key. */
export const SELECTION_STORAGE_KEY = "pi-weave.selection.v1";

/**
 * Remember the selection; an empty string records "nothing open".
 * Reports failure as `false` instead of throwing — a quota or
 * partitioned-storage error must never break a selection.
 */
export function saveSelection(storage: SelectionStorage, id: string | null): boolean {
  try {
    storage.setItem(SELECTION_STORAGE_KEY, id ?? "");
    return true;
  } catch {
    return false;
  }
}

/**
 * The saved selection to restore, or `null`.
 *
 * `graph` gates the offer: the id must still name a node of the current
 * payload, so a note deleted elsewhere is quietly not restored. Reads are
 * failure-absorbing for the same reason writes are.
 */
export function restoreSelection(graph: GraphPayload | null, storage: SelectionStorage): string | null {
  if (graph === null) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(SELECTION_STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null || raw === "") return null;
  return graph.model.nodes.some((node) => node.id === raw) ? raw : null;
}