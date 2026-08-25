/**
 * The context bus (weave-workspace §1.3).
 *
 * No event bus, no pub/sub — five Preact signals. Selecting in the tree,
 * clicking a graph node, following a wikilink and hitting a search result all
 * write {@link selectedId}; the note column, the graph highlight and the
 * context rail are computed from it.
 *
 * ## Tier rules (§2)
 *
 * This is `src/web/client/**`: it may import `src/web/shared` and browser
 * deps, and must **never** import `src/core` or `node:*`. Core is
 * Node-flavoured TypeScript that would drag `node:fs` into the bundle.
 *
 * ## What the P0 placeholders became
 *
 * This file used to declare three local interfaces behind `TODO(P1)` markers,
 * standing in for contracts that had not been written yet. Two of them are
 * now real and imported from `src/web/shared/wire.ts` — {@link graph} carries
 * a `GraphPayload` and {@link noteBody} a `ViewNote`, the exact values
 * `src/web/client/api.ts` returns. That removes a translation step that
 * existed only to satisfy a stale type: the fetchers already produce these
 * shapes, so anything narrower here was a downcast waiting to lose a field.
 *
 * The third resolved the other way. The TODO said to take `TreeState` from
 * the wire too, and that was simply wrong: which rows a user has expanded is
 * **not** a wire contract. It never crosses the network, the server has no
 * opinion about it, and putting it in `wire.ts` would have made the
 * client/server contract carry a purely local UI preference. So
 * {@link TreeState} stays here, declared where it is owned, with the marker
 * removed rather than carried forward.
 */

import { signal } from "@preact/signals";
import type { GraphPayload, NotePayload } from "../shared/wire";

/** Connection state shown in the status bar. */
export type ConnectionState = "live" | "reconnecting" | "offline";

/**
 * Which tree rows are open.
 *
 * Client-owned, deliberately: see the module header. An interface rather than
 * a bare array so that P2's filter text and provenance-cycling state have an
 * obvious home that does not change this signal's type.
 */
export interface TreeState {
  /** Ids of expanded tree rows. */
  readonly expanded: readonly string[];
}

/** The empty tree: nothing expanded. */
export function initialTreeState(): TreeState {
  return { expanded: [] };
}

/** The graph node id currently in context — everywhere. */
export const selectedId = signal<string | null>(null);

/** The whole graph, as delivered by the server. `null` until first load. */
export const graph = signal<GraphPayload | null>(null);

/**
 * Derived: fetched when {@link selectedId} names a note.
 *
 * A {@link NotePayload} rather than a bare `ViewNote` as of P5. The revision
 * travels **with** the body because the editor saves against it, and a
 * revision fetched separately would describe a state the draft was not typed
 * against — the exact window a conflict check exists to close. The note
 * column reads `.note` and is otherwise unchanged.
 */
export const noteBody = signal<NotePayload | null>(null);

/** Which tree rows are open. */
export const treeState = signal<TreeState>(initialTreeState());

/** SSE liveness (§6). */
export const connection = signal<ConnectionState>("live");
