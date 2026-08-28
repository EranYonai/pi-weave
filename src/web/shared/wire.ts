/**
 * The wire contract between the loopback server and the browser client
 * (weave-workspace §5.3).
 *
 * ## Why this file exists at all
 *
 * The client cannot import `src/core` (§2 tier table): core is
 * Node-flavoured TypeScript and a value import would drag `node:fs` into the
 * bundle. So everything both sides need is either a **type** here or a pure
 * function in `src/web/shared/`. This module is the type half — it is the
 * single place where the shape of an HTTP response or an SSE frame is
 * written down, and both the server that produces it and the client that
 * consumes it are typed from it.
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

// --- liveness ----------------------------------------------------------------

/**
 * Which half of the workspace an SSE frame is about.
 *
 * Deliberately coarser than the paths that produced it: macOS `fs.watch`
 * coalesces and can miss rapid bursts, so a frame means "something in this
 * scope changed, re-read it", never "here is the delta" (§6). A client that
 * treated frames as deltas would silently diverge the first time the OS
 * dropped one.
 */
export type ChangeScope = "vault" | "repo" | "git";

/** Every {@link ChangeScope}, for exhaustiveness checks and table tests. */
export const CHANGE_SCOPES: readonly ChangeScope[] = ["vault", "repo", "git"];

/**
 * One SSE frame.
 *
 * `stamp` is the graph's content digest at the moment the change was observed
 * — the same value `GET /api/graph` serves as its ETag (§5.3). It is the
 * dedupe key: a client that already holds this stamp has nothing to refetch,
 * which matters because the watcher's debounce window can still emit two
 * frames for one logical edit.
 *
 * Sharing one key with the ETag is load-bearing rather than tidy. While this
 * was `generatedAt`, an edit that did not advance the timestamp maximum
 * produced a frame the client deduped away against the stamp of the graph it
 * already held, so the refetch never happened (§15.6).
 */
export interface ChangeEvent {
  scope: ChangeScope;
  stamp: string;
}

/** The `event:` name carried by every {@link ChangeEvent} frame. */
export const CHANGE_EVENT_NAME = "change";

/**
 * Structural guard for a decoded SSE `data:` payload.
 *
 * The client parses frames off a socket that survives server restarts and
 * proxy interference, so "it is JSON" is not the same as "it is ours".
 * Narrow rather than validate-and-throw: a malformed frame should cost a
 * skipped refetch, not an unhandled rejection inside `EventSource`'s
 * callback.
 */
export function isChangeEvent(value: unknown): value is ChangeEvent {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { scope?: unknown; stamp?: unknown };
  if (typeof candidate.stamp !== "string") return false;
  return CHANGE_SCOPES.includes(candidate.scope as ChangeScope);
}

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
   * visible settling (§7.3). `null` when the server did not compute one —
   * which is the default, because the layout module imports `d3-force` and
   * the published package has zero runtime dependencies. The client then
   * runs the identical `src/web/shared/layout` code itself.
   */
  positions: Record<string, Point> | null;
  /**
   * A **content digest** of this payload. The ETag body and the SSE dedupe
   * key (§5.3, §6).
   *
   * Opaque: a truncated SHA-256 of the serialized payload, and nothing may
   * parse it or derive meaning from its value. The only defined operation is
   * equality, and it has exactly one guarantee — two payloads share a stamp
   * if and only if they serialize to the same bytes.
   *
   * This was `model.generatedAt` until §15.6. A max of input timestamps is
   * blind to any change that does not advance the maximum (a body edit, a
   * front-matter edit, deleting a note that is not the newest), so a
   * conditional GET answered `304` with stale content and the SSE dedupe
   * dropped the frame that would have corrected it.
   *
   * For a human-readable "data as of" marker, read {@link GraphModel.generatedAt},
   * which still carries it — the status bar does exactly that.
   */
  stamp: string;
}

/**
 * `GET /api/note/:slug`, and the note half of every write response.
 *
 * The route used to serve a bare {@link ViewNote}. It carries a `revision`
 * as of P5 because the editor cannot save safely without one: a save that
 * does not say *which* state it was editing is a last-write-wins save, and
 * the two writers a vault actually has — `$EDITOR` and an agent's
 * `weave_note` call — are both fast enough to lose a paragraph to it.
 *
 * Carried in the **body** rather than as an `ETag`, deliberately. `api.ts`'s
 * {@link HttpResponse} port exposes `ok`, `status` and `json()` and nothing
 * else, because it exists so a two-line fake can stand in for `fetch` in a
 * repository with no DOM (§10). Reading a header would mean widening that
 * port for one field, and the field is a *property of the note*, not of the
 * HTTP representation — unlike `/api/graph`'s stamp, which really is a cache
 * validator and really does belong in an `ETag`.
 */
export interface NotePayload {
  note: ViewNote;
  /**
   * Opaque version stamp for the file the note was read from.
   *
   * **Compare it, do not interpret it.** Core currently derives it from
   * `mtimeMs:size` and says in the same breath that the shape is not part of
   * the contract; a client that parsed a timestamp out of it would break the
   * day core upgrades it to a digest. The only defined operation is equality
   * against a later read of the same note.
   */
  revision: string;
}

/**
 * `POST /api/note/:slug` request body.
 *
 * Every field optional, and that is not laziness — it mirrors core's
 * `UpdateNoteInput`, where a metadata-only edit (retagging) and a body-only
 * edit (the textarea) are both first-class. A body of `{}` is a legal
 * request that bumps `updated` and nothing else.
 */
export interface SaveNoteRequest {
  /** Replacement Markdown body. Omit to change only metadata. */
  body?: string;
  /**
   * Metadata to merge over the note's current values.
   *
   * `created` is absent by construction: it records when the note came into
   * existence and an edit is not a re-creation. `updated` is absent because
   * the server owns it — a client that could set it could make an edit look
   * older than the state it overwrote.
   */
  meta?: {
    title?: string;
    tags?: string[];
    source?: WireNoteSource;
  };
  /**
   * The {@link NotePayload.revision} the client last read.
   *
   * Supply it and a stale save is refused with `409` and a
   * {@link ConflictPayload} carrying the note as it now is. Omit it and the
   * save is last-write-wins — which is a legitimate thing for the *user* to
   * choose after seeing a conflict, and is exactly how "overwrite" is
   * expressed: the same request, resent without this field.
   */
  expectedRevision?: string;
}

/** `POST /api/note/:slug/rename` request body. */
export interface RenameNoteRequest {
  /**
   * The destination. Passed through core's `slugify`, so a human title is
   * as acceptable as a slug and both land on the same file name.
   */
  slug: string;
}

/** `DELETE /api/note/:slug` response. Hard delete — there is no trash. */
export interface DeleteNoteResult {
  deleted: true;
}

/**
 * The `409` body for both write routes.
 *
 * A discriminated union rather than one shape with optional halves, because
 * the two cases carry genuinely different payloads and a client that has to
 * check `current !== undefined` before it can tell them apart is a client
 * that will one day forget to.
 *
 * The `conflict` arm carries the **whole current note**, not just its
 * revision. That is the difference between a UI that can offer
 * reload-or-overwrite immediately and one that has to issue a second request
 * before it can say anything useful — and the second request is one more
 * window in which the file moves again. Core hands the server this note as
 * part of the failure, so shipping it costs nothing.
 */
export type ConflictPayload =
  | {
      error: string;
      reason: "conflict";
      /** The note as it is on disk right now, with its current revision. */
      current: NotePayload;
    }
  | {
      error: string;
      reason: "collision";
      /** The destination slug that is already taken. */
      slug: string;
    };

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
  /** Absolute path of the vault root. */
  vaultRoot: string;
  /**
   * Random per-boot id. `EventSource` reconnects transparently across a
   * server restart, so without this a client cannot distinguish two cases it
   * must handle differently: "I missed some frames" (refetch) and "this is a
   * different server" (full reload).
   */
  session: string;
}
