/**
 * The wire contract between the loopback server and the browser client
 * (weave-workspace §5.3, §10).
 *
 * ## Why this file exists at all
 *
 * The client cannot import `src/core` (§2 tier table): core is
 * Node-flavoured TypeScript and a value import would drag `node:fs` into the
 * bundle. So everything both sides need is either a **type** here or a pure
 * function in `src/web/shared/`. This module is the type half — it is the
 * single place where the shape of an HTTP response is written down, and both
 * the server that produces it and the client that consumes it are typed from
 * it.
 *
 * ## Tier rules
 *
 * `src/web/shared/**`: itself only. No `node:*`, no DOM globals, no
 * `src/pi`, and — as of the tier fix — **no `src/core`, not even as a type**.
 *
 * That last clause is stricter than the §2 table as originally written, and
 * it exists because "core types only" turned out not to be a real boundary.
 * `import type` erases from the *bundle*, but the compiler still has to
 * resolve it: pulling `GraphModel` in here made `tsc -p tsconfig.web.json`
 * load the entire core type graph, `node:fs` and all, and fail with 24
 * errors under a project that deliberately has no node lib. The type-only
 * distinction is one the bundler makes and the typechecker does not.
 *
 * The DTOs now live in `./graph`, declared structurally, with
 * `tests/web/wire.contract.test.ts` asserting they stay assignable to and
 * from their core counterparts. Drift is a compile error; the client is free
 * of core in every sense.
 *
 * ## The graph payload is not the core `GraphModel`
 *
 * The core model is lossy on purpose: tags are flattened into a comma-joined
 * display string and dangling link targets are counted then discarded
 * (weave-view handoff findings). {@link GraphPayload} therefore carries the
 * model *plus* the two structured indexes the model dropped, rather than
 * growing structure inside `WireGraphNode.detail`, which is display-only by
 * contract.
 */

import type { WireGraphModel, WireNoteSearchHit, WireNoteSource, WireViewNote } from "./graph";
import type { Point } from "./metrics";

/**
 * The wire DTOs, re-exported under the names the client and server already
 * use. Aliases rather than a second declaration, so there is exactly one
 * definition of each shape and `./graph` remains the place drift is caught.
 */
export type GraphModel = WireGraphModel;
export type ViewNote = WireViewNote;
export type NoteSearchHit = WireNoteSearchHit;
export type { Point };

export type {
  WireEdgeKind,
  WireGraphEdge,
  WireGraphModel,
  WireGraphNode,
  WireNodeKind,
  WireNoteMeta,
  WireNoteSearchHit,
  WireNoteSource,
  WireNoteSummary,
  WireStalenessReport,
  WireStalenessState,
  WireViewNote,
} from "./graph";
export { WIRE_EDGE_KINDS, WIRE_MODEL_OMITTED_KEYS, WIRE_NODE_KINDS } from "./graph";

// --- responses ---------------------------------------------------------------

/**
 * `GET /api/graph`.
 *
 * @see GraphModel for the authoritative node/edge data.
 */
export interface GraphPayload {
  /** Nodes, edges, staleness, `generatedAt`. The authoritative model. */
  model: GraphModel;
  /**
   * tag → slugs (§4.3).
   *
   * Built by core's `deriveTagIndex` from the notes the graph was built from
   * — *not* by re-parsing `WireGraphNode.detail.tags`, which is a
   * comma-joined display string and must never be turned back into
   * structure.
   *
   * Key order is meaningful and load-bearing: `deriveTagIndex` returns count
   * descending, then tag ascending, and `Object.fromEntries` preserves that
   * as JSON key insertion order. A client that wants the ranking can either
   * trust the order or re-derive it from the array lengths. A tag with no
   * notes cannot occur.
   *
   * Slugs, not node ids — `note:` is a graph-internal prefix.
   */
  tags: Record<string, string[]>;
  /**
   * slug → unresolved wikilink targets (§4.2).
   *
   * The ghost-node affordance: a `[[target]]` that matches no note is an
   * offer to create one. Populated from core's `GraphModel.danglingLinks`,
   * which the builder now retains instead of counting and discarding.
   *
   * Lives at the payload's top level rather than inside {@link GraphModel},
   * which is why `WireGraphModel` is declared one field narrower than its
   * core counterpart — the same map crossing the wire twice would give the
   * client two places to read one fact from. A note with nothing unresolved
   * is absent from the record, not present with an empty array.
   */
  dangling: Record<string, string[]>;
  /**
   * Server-precomputed layout, so the graph appears already laid out with no
   * visible settling (§8). `null` when the server did not compute one —
   * which is the default, because the layout module imports `d3-force` and
   * the published package has zero runtime dependencies. The client then
   * runs the identical `src/web/shared/layout` code itself.
   */
  positions: Record<string, Point> | null;
  /**
   * A **content digest** of this payload. The ETag body and polling cache key
   * (§15.6, §7.3).
   *
   * Opaque: a truncated SHA-256 of the serialized payload, and nothing may
   * parse it or derive meaning from its value. The only defined operation is
   * equality, and it has exactly one guarantee — two payloads share a stamp
   * if and only if they serialize to the same bytes.
   *
   * This was `model.generatedAt` until §15.6. A max of input timestamps is
   * blind to any change that does not advance the maximum (a body edit, a
   * front-matter edit, deleting a note that is not the newest), so a
   * conditional GET answered `304` with stale content and the client cache
   * kept the stale payload.
   *
   * For a human-readable "data as of" marker, read {@link GraphModel.generatedAt},
   * which still carries it — the status bar does exactly that.
   */
  stamp: string;
}

/** `GET /api/note/:slug`. */
export interface NotePayload {
  note: ViewNote;
}

/** `GET /api/okf/:rel`. */
export interface OkfFilePayload {
  /** The requested path, relative to `<cwd>/.okf`. Echoed, never resolved. */
  path: string;
  body: string;
}

/** `GET /api/search?q=`. */
export interface SearchPayload {
  query: string;
  hits: NoteSearchHit[];
}

/** `POST /api/open` request body. */
export interface OpenRequest {
  slug: string;
}

/** `POST /api/open` response. `false` for an unsafe slug or a missing note. */
export interface OpenResult {
  opened: boolean;
}

/**
 * Every non-2xx JSON response. One shape for all of them so the client has
 * exactly one error path.
 */
export interface ErrorPayload {
  error: string;
}

// --- page bootstrap ----------------------------------------------------------

/** `id` of the `<script type="application/json">` block in the HTML shell. */
export const BOOTSTRAP_ELEMENT_ID = "weave-bootstrap";

/**
 * The JSON block embedded in the shell, so the first paint knows where it is
 * without a round trip.
 */
export interface Bootstrap {
  /** Absolute path the workspace was started in. */
  cwd: string;
}
