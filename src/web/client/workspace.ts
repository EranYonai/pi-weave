/**
 * The controller: fetches, signals, and the SSE loop joined up
 * (weave-workspace §1.3, §6).
 *
 * Three modules already exist and none of them knows about the others —
 * `api.ts` fetches, `live.ts` listens, `state.ts` holds. This is the seam
 * that connects them, and it is a plain `.ts` with every dependency injected
 * so it is covered by ordinary tests: `fetch` comes in as a {@link FetchLike}
 * and the socket as an {@link EventSourceFactory}, exactly as those modules
 * were designed to allow.
 *
 * Keeping it out of a component is what makes the shell's `useEffect` a
 * two-liner (`start`, return `stop`). A `.tsx` cannot be tested here, so any
 * decision that lands in one is a decision that ships uncovered.
 *
 * ## Refetch is ordered and conditional
 *
 * A plan can ask for both endpoints; the graph is fetched first because it
 * carries the stamp that `seen()` records and therefore the dedupe key for
 * every subsequent frame. Both requests are conditional in the sense that
 * matters: the graph sends `If-None-Match` and a `304` costs an empty body,
 * so "refetch everything on reconnect" (§6) is genuinely cheap rather than
 * merely correct.
 *
 * ## Failures are absorbed, not thrown
 *
 * `api.ts` returns a discriminated result precisely so this layer never
 * catches. A failed refetch leaves the previous signal value in place — a
 * stale graph is strictly better than a blank workspace, and the next frame
 * or the `⟳` button retries. The connection indicator, driven separately by
 * the socket, is what tells the user something is wrong.
 */

import type { GraphPayload, NotePayload } from "../shared/wire";
import type { ApiResult, FetchLike } from "./api";
import { fetchGraph, fetchNote } from "./api";
import { graphFailed, recentIds } from "./state";
import type { EventSourceFactory, LiveHandle } from "./live";
import { startLive } from "./live";
import type { RefetchPlan } from "./live.model";
import { connection, graph, noteBody, selectedId } from "./state";

/** What {@link startWorkspace} needs. Everything injectable is injected. */
export interface WorkspaceOptions {
  fetch: FetchLike;
  /** Socket constructor. `domEventSource` at the real call site. */
  open: EventSourceFactory;
  /** Overrides the SSE path. Tests use it; the shell does not. */
  path?: string;
  /**
   * One-shot timer, injectable for tests. Defaults to `setTimeout`. Used
   * only to expire the recent-arrivals highlight ({@link RECENT_TTL_MS}).
   */
  defer?: (fn: () => void, ms: number) => () => void;
}

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

/**
 * Told about every note that arrives, so the editor can decide (§6, P5).
 *
 * A module-level hook rather than a parameter threaded through five call
 * sites, because a note reaches the column from three unrelated directions —
 * the mount fetch, a selection, and an SSE refetch — and the editor's
 * decision ("is this the note I am editing, at a revision I do not hold?")
 * has to be made on all three or it is made on none. The alternative was
 * `loadNote` taking a callback that every caller had to remember to pass.
 *
 * Set by the shell at mount and cleared on unmount, exactly like
 * `Shell.tsx`'s `fit` ref. `null` — the shape every test that does not care
 * about editing sees — means the load simply publishes and nothing else
 * happens.
 */
let onNoteLoaded: ((payload: NotePayload) => void) | null = null;

/** Register the editor's load hook. Returns an unsubscribe. */
export function observeNotes(hook: (payload: NotePayload) => void): () => void {
  onNoteLoaded = hook;
  return () => {
    // Only clear our own registration: two shells in one test process
    // unmounting out of order must not blank a live hook.
    if (onNoteLoaded === hook) onNoteLoaded = null;
  };
}

/** A running workspace. */
export interface WorkspaceHandle {
  /** Force a full refetch — the header's `⟳`. */
  refresh(): void;
  /** Fetch the body for the current selection, or clear it. */
  syncNote(): Promise<void>;
  /** Close the socket. Idempotent. */
  stop(): void;
}

/**
 * Fetch the graph and publish it.
 *
 * The stamp is handed to {@link LiveHandle.seen} only on success, which is
 * the invariant `live.model.ts` documents: a stamp recorded for a fetch that
 * failed would dedupe away the very frame that would have retried it.
 *
 * A `304` arrives as `cached: true` with the caller's own payload, so
 * re-assigning the signal would be a no-op write that still wakes every
 * subscriber. Skipping it is the difference between an idle workspace doing
 * nothing and one re-rendering three columns every time the watcher twitches.
 */
async function loadGraph(
  fetchImpl: FetchLike,
  live: LiveHandle | null,
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
  live?.seen(result.data.stamp);
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
  // After the signal, not before: the editor's decision may leave the draft
  // in place *while* the column's read-mode rendering shows the new version,
  // and the two are independent. Publishing second would let the editor see
  // a payload the rest of the workspace does not yet hold.
  onNoteLoaded?.(result.data);
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
 * Boot the workspace: first graph fetch, then the event stream.
 *
 * In that order, deliberately. The mount fetch seeds the stamp via `seen()`,
 * so the hello frame `sse.ts` sends every newly attached client is recognised
 * as already-held and deduped away. Opening the socket first would make the
 * first frame arrive before there is a stamp to compare it to, and the
 * workspace would fetch the same graph twice on every single load.
 */
export function startWorkspace(opts: WorkspaceOptions): WorkspaceHandle {
  let live: LiveHandle | null = null;
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

  const runPlan = (plan: RefetchPlan): void => {
    // Fire-and-forget: this is called from a socket callback, which cannot
    // await. Failures are values (`api.ts`), so there is nothing to reject —
    // `void` documents that rather than hiding a floating promise.
    void (async () => {
      if (plan.graph) await loadGraph(opts.fetch, live, onPublished);
      if (plan.note) await loadNote(opts.fetch);
    })();
  };

  live = startLive({
    open: opts.open,
    refetch: runPlan,
    hasSelection: () => noteSlug(selectedId.value) !== null,
    ...(opts.path === undefined ? {} : { path: opts.path }),
  });

  void loadGraph(opts.fetch, live, onPublished);

  return {
    refresh() {
      live?.refresh();
    },
    syncNote() {
      return loadNote(opts.fetch);
    },
    stop() {
      live?.stop();
      live = null;
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
  connection.value = "live";
  recentIds.value = NO_IDS;
}
