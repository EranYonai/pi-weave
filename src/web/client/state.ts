import type { GraphPayload, NotePayload } from "../shared/wire";

/**
 * Which tree rows are open.
 *
 * Client-owned, deliberately: see the module header. An interface rather than
 * a bare array so that P2's filter text and provenance-cycling state have an
 * obvious home that does not change this state shape.
 */
export interface WorkspaceState {
  graph: GraphPayload | null;
  graphFailed: boolean;
  note: NotePayload | null;
  noteFailed: boolean;
  recentIds: ReadonlySet<string>;
  selectedId: string | null;
}

export function initialWorkspaceState(): WorkspaceState {
  return { graph: null, graphFailed: false, note: null, noteFailed: false, recentIds: new Set(), selectedId: null };
}
