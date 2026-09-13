/**
 * The controller: fetches, signals, and the polling loop joined up.
 *
 * Three modules already exist and none of them knows about the others —
 * `api.ts` fetches and `state.ts` holds. This is the seam that connects them,
 * and it is a plain `.ts` with every dependency injected so it is covered by
 * ordinary tests.
 *
 * Keeping it out of a component is what makes the shell's `useEffect` a
 * two-liner (`start`, return `stop`). A `.tsx` cannot be tested here, so any
 * decision that lands in one is a decision that ships uncovered.
 *
 * ## Refetch is ordered and conditional
 *
 * Every poll is conditional: the graph sends `If-None-Match` and a `304`
 * costs an empty body.
 *
 * ## Failures are absorbed, not thrown
 *
 * `api.ts` returns a discriminated result precisely so this layer never
 * catches. A failed refetch leaves the previous signal value in place — a
 * stale graph is strictly better than a blank workspace, and the next frame
 * or the `⟳` button retries.
 */

import type { GraphPayload } from "../shared/wire";
import type { ApiResult, FetchLike } from "./api";
import { fetchGraph, fetchNote } from "./api";
import { graphFailed, graph, noteBody, recentIds, selectedId } from "./state";

/** What {@link startWorkspace} needs. Everything injectable is injected. */
export interface WorkspaceOptions {
  fetch: FetchLike;
  /**
   * One-shot timer, injectable for tests. Defaults to `setTimeout`. Used
   * only to expire the recent-arrivals highlight ({@link RECENT_TTL_MS}).
   */
  defer?: (fn: () => void, ms: number) => () => void;
  /** Test seam for the fixed poll timer. */
  repeat?: (fn: () => void, ms: number) => () => void;
}

/** Two seconds is responsive enough for a local viewer and costs one 304. */
export const POLL_MS = 2_000;

/** How long a newly-arrived node stays flagged in the tree (the animation is shorter). */
export const RECENT_TTL_MS = 3_000;

const NO_IDS: ReadonlySet<string> = new Set();

/**
 * Node ids present in `next` but not in `previous`.
 *
 * The mount fetch passes `previous === null`, which yields the empty set —
 * a first load must not animate the entire tree as "new". A node that left
 * and returned is new again: from the reader's point of view it *is* a
 * fresh arrival.
 */
export function addedNodeIds(previous: GraphPayload | null, next: GraphPayload): ReadonlySet<string> {
  if (previous === null) return NO_IDS;
  const before = new Set(previous.model.nodes.map((node) => node.id));
  const added = new Set<string>();
  for (const node of next.model.nodes) {
    if (!before.has(node.id)) added.add(node.id);
  }
  return added;
}

/** A running workspace. */
export interface WorkspaceHandle {
  /** Force a full refetch — the header's `⟳`. */
  refresh(): void;
  /** Fetch the body for the current selection, or clear it. */
  syncNote(): Promise<void>;
  /** Stop polling. Idempotent. */
  stop(): void;
}

/**
 * Fetch the graph and publish it.
 *
 * A `304` arrives as `cached: true` with the caller's own payload, so
 * re-assigning the signal would be a no-op write that still wakes every
 * subscriber. Skipping it is the difference between an idle workspace doing
 * nothing and one re-rendering three columns every two seconds.
 */
async function loadGraph(
  fetchImpl: FetchLike,
  onPublished?: (previous: GraphPayload | null, next: GraphPayload) => void,
): Promise<ApiResult<unknown>> {
  // Captured before the fetch so the diff describes exactly what the reader
  // was looking at when the update landed.
  const previous = graph.value;
  const result = await fetchGraph(fetchImpl, graph.value);
  if (!result.ok) {
    // Only a *boot* failure is news: with a graph already published, the
    // stale value is deliberately left standing and the failure would be a
    // downgrade dressed as an error. The next frame or the ⟳ button retries.
    if (graph.value === null) graphFailed.value = true;
    return result;
  }
  graphFailed.value = false;
  if (!result.cached) {
    graph.value = result.data;
    onPublished?.(previous, result.data);
  }
  return result;
}

/**
 * Fetch the selected note's body, or clear it.
 *
 * The selection is a graph node id, and only *note* nodes have a body — the
 * repository, git-state and file nodes do not. `note:` is the prefix core's
 * graph builder gives them; anything else clears the column rather than
 * issuing a request the server would answer `404`.
 */
async function loadNote(fetchImpl: FetchLike): Promise<void> {
  const slug = noteSlug(selectedId.value);
  if (slug === null) {
    noteBody.value = null;
    return;
  }
  const result = await fetchNote(fetchImpl, slug);
  // A failed note fetch leaves the previous body on screen. The alternative —
  // blanking the column on a transient error — throws away readable content
  // to display nothing, and the note is usually still there.
  if (!result.ok) return;
  noteBody.value = result.data;
}

/**
 * The slug inside a `note:<slug>` node id, or `null` for any other node.
 *
 * Exported because it is the one piece of id-shape knowledge in this file and
 * it deserves a test of its own rather than being reached only through a
 * fetch. An empty slug (`"note:"`) is rejected: it would produce a request
 * for `/api/note/` and a 404 that means nothing to anyone.
 */
export function noteSlug(id: string | null): string | null {
  if (id === null || !id.startsWith("note:")) return null;
  const slug = id.slice("note:".length);
  return slug === "" ? null : slug;
}

/**
 * Boot the workspace: fetch immediately, then poll conditionally.
 */
export function startWorkspace(opts: WorkspaceOptions): WorkspaceHandle {
  let stopped = false;
  let cancelRecentExpiry: (() => void) | null = null;
  const defer =
    opts.defer ??
    ((fn: () => void, ms: number) => {
      const handle = setTimeout(fn, ms);
      return () => clearTimeout(handle);
    });

  /** Publish the frame's arrivals; the tree flashes them while they are new. */
  const onPublished = (previous: GraphPayload | null, next: GraphPayload): void => {
    const added = addedNodeIds(previous, next);
    recentIds.value = added;
    cancelRecentExpiry?.();
    cancelRecentExpiry = null;
    if (added.size > 0) {
      cancelRecentExpiry = defer(() => {
        cancelRecentExpiry = null;
        recentIds.value = NO_IDS;
      }, RECENT_TTL_MS);
    }
  };

  let polling = false;
  const poll = async (): Promise<void> => {
    if (stopped || polling) return;
    polling = true;
    try {
      const result = await loadGraph(opts.fetch, onPublished);
      if (result.ok && !result.cached && noteSlug(selectedId.value) !== null) await loadNote(opts.fetch);
    } finally {
      polling = false;
    }
  };
  const repeat = opts.repeat ?? ((fn, ms) => {
    const timer = setInterval(fn, ms);
    return () => clearInterval(timer);
  });
  const cancelPoll = repeat(() => void poll(), POLL_MS);
  void poll();

  return {
    refresh() {
      void poll();
    },
    syncNote() {
      return loadNote(opts.fetch);
    },
    stop() {
      stopped = true;
      cancelPoll();
      cancelRecentExpiry?.();
      cancelRecentExpiry = null;
      recentIds.value = NO_IDS;
    },
  };
}

/**
 * Select a node — the §1.3 context bus, in one function.
 *
 * Writing `selectedId` is the whole mechanism; the note fetch that follows is
 * a *consequence* of the write, not part of it, which is why the signal is
 * set before the fetch is issued. Every column that derives from the
 * selection updates on the synchronous write, so the UI responds immediately
 * and the body arrives when it arrives.
 */
export function select(fetchImpl: FetchLike, id: string | null): Promise<void> {
  selectedId.value = id;
  return loadNote(fetchImpl);
}

/** Reset every signal. The shell's unmount path, and every test's cleanup. */
export function resetWorkspace(): void {
  selectedId.value = null;
  graph.value = null;
  noteBody.value = null;
  graphFailed.value = false;
  recentIds.value = NO_IDS;
}
