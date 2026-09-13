/** Fetching and polling for the browser workspace. */

import type { GraphPayload } from "../shared/wire";
import type { ApiResult, FetchLike } from "./api";
import { fetchGraph, fetchNote } from "./api";
import type { WorkspaceState } from "./state";

export interface WorkspaceOptions {
  fetch: FetchLike;
  state: WorkspaceState;
  setState: (state: WorkspaceState) => void;
  defer?: (fn: () => void, ms: number) => () => void;
  repeat?: (fn: () => void, ms: number) => () => void;
}

export const POLL_MS = 2_000;
export const RECENT_TTL_MS = 3_000;

const NO_IDS: ReadonlySet<string> = new Set();

export function addedNodeIds(previous: GraphPayload | null, next: GraphPayload): ReadonlySet<string> {
  if (previous === null) return NO_IDS;
  const before = new Set(previous.model.nodes.map((node) => node.id));
  return new Set(next.model.nodes.filter((node) => !before.has(node.id)).map((node) => node.id));
}

export interface WorkspaceHandle {
  refresh(): void;
  select(id: string | null): Promise<void>;
  syncNote(): Promise<void>;
  stop(): void;
}

export function noteSlug(id: string | null): string | null {
  if (id === null || !id.startsWith("note:")) return null;
  const slug = id.slice("note:".length);
  return slug === "" ? null : slug;
}

export function startWorkspace(opts: WorkspaceOptions): WorkspaceHandle {
  let state = opts.state;
  let stopped = false;
  let polling = false;
  let cancelRecentExpiry: (() => void) | null = null;
  const update = (patch: Partial<WorkspaceState>): void => {
    if (Object.entries(patch).every(([key, value]) => state[key as keyof WorkspaceState] === value)) return;
    state = { ...state, ...patch };
    opts.setState(state);
  };
  const defer = opts.defer ?? ((fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  });
  const loadNote = async (): Promise<void> => {
    const slug = noteSlug(state.selectedId);
    if (slug === null) {
      update({ note: null });
      return;
    }
    const result = await fetchNote(opts.fetch, slug);
    if (result.ok) update({ note: result.data });
  };
  const loadGraph = async (): Promise<ApiResult<unknown>> => {
    const previous = state.graph;
    const result = await fetchGraph(opts.fetch, state.graph);
    if (!result.ok) {
      if (state.graph === null) update({ graphFailed: true });
      return result;
    }
    if (!result.cached) {
      const added = addedNodeIds(previous, result.data);
      update({ graph: result.data, graphFailed: false, recentIds: added });
      cancelRecentExpiry?.();
      cancelRecentExpiry = null;
      if (added.size > 0) {
        cancelRecentExpiry = defer(() => {
          cancelRecentExpiry = null;
          update({ recentIds: NO_IDS });
        }, RECENT_TTL_MS);
      }
    }
    return result;
  };
  const poll = async (): Promise<void> => {
    if (stopped || polling) return;
    polling = true;
    try {
      const result = await loadGraph();
      if (result.ok && !result.cached && noteSlug(state.selectedId) !== null) await loadNote();
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
    refresh: () => void poll(),
    select: async (id) => {
      update({ selectedId: id });
      await loadNote();
    },
    syncNote: loadNote,
    stop: () => {
      if (stopped) return;
      stopped = true;
      cancelPoll();
      cancelRecentExpiry?.();
      cancelRecentExpiry = null;
    },
  };
}
