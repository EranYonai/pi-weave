/**
 * The graph shapes as they appear **on the wire** (weave-workspace §5.3).
 *
 * ## Why these are declared here and not imported from core
 *
 * They used to be `import type { GraphModel } from "../../core/graph/model"`,
 * and that single line was an architectural violation with a build failure
 * attached to it.
 *
 * The reasoning that put it there was: "`import type` erases at compile time,
 * so it cannot drag `node:fs` into the browser bundle." That is true, and it
 * is also not the whole story. Type erasure protects the **bundle**; it does
 * nothing for the **typecheck**. To resolve `GraphModel`, TypeScript must load
 * `src/core/graph/model.ts`, which imports `../types`, and the compiler walks
 * that whole graph — under `tsconfig.web.json`, which deliberately has
 * `"types": []` and no node lib, so every `node:fs` in the transitive closure
 * is an error. The client tier was importing core in every sense that
 * mattered except the one the rule was written to check.
 *
 * So the tier rule is now literal rather than aspirational: **nothing under
 * `src/web/shared/` imports `src/core` at all**, not even as a type. That is
 * stricter than the §2 table as written (which permits core types here), and
 * it is the version worth having, because "types only" is a distinction the
 * compiler does not make when resolving a project.
 *
 * ## The contract is deliberately a copy, not an alias
 *
 * This is not duplication for its own sake — it is the wire format being
 * honest about what it is. `GraphModel` is an *internal* core type, free to
 * change shape when core needs it to. What crosses an HTTP boundary is a
 * *contract*, and a contract that silently reshapes itself whenever an
 * internal type is refactored is not a contract. Declaring it separately
 * means a core change that would break the client is a visible, deliberate
 * edit here rather than an invisible one.
 *
 * The obvious risk of a copy is drift, so drift is a **compile error**:
 * `tests/web/wire.contract.test.ts` asserts mutual assignability between
 * every type here and its core counterpart. That test is Node-side, where
 * importing core is legal and free. Add a field to `GraphNode` in core and
 * that test fails to compile until this file agrees — which is exactly the
 * moment a human should be deciding whether the new field belongs on the
 * wire.
 *
 * Isomorphic: no `node:*`, no DOM, no `src/core`, no `src/pi`.
 */

/**
 * Where a piece of knowledge came from. Drives trust display (design §13).
 *
 * Mirrors `NoteSource` in `src/core/types.ts`.
 */
export type WireNoteSource = "human" | "agent" | "generated";

/** Mirrors `StalenessState` in `src/core/types.ts`. */
export type WireStalenessState = "missing" | "fresh" | "stale";

/** Mirrors `StalenessReport` in `src/core/types.ts`. */
export interface WireStalenessReport {
  state: WireStalenessState;
  reasons: string[];
}

/** Mirrors `NodeKind` in `src/core/graph/model.ts`. */
export type WireNodeKind =
  | "vault"
  | "note"
  | "repository"
  | "module"
  | "package"
  | "entryPoint"
  | "gitState"
  | "external"
  | "file";

/** Mirrors `EdgeKind` in `src/core/graph/model.ts`. */
export type WireEdgeKind = "contains" | "anchored-at" | "links-to" | "mentions";

/**
 * Every node kind. The graph legend and the table tests iterate this.
 *
 * A runtime value, unlike everything else in this file, because a renderer
 * needs to enumerate kinds to build a legend and a `type` cannot be iterated.
 * The contract test pins it against core's `NODE_KINDS` element-for-element,
 * so a kind added to core and not here is a failing test rather than a
 * legend that quietly omits a colour.
 */
export const WIRE_NODE_KINDS: readonly WireNodeKind[] = [
  "vault",
  "note",
  "repository",
  "module",
  "package",
  "entryPoint",
  "gitState",
  "external",
  "file",
];

/** Every edge kind. Same reasoning as {@link WIRE_NODE_KINDS}. */
export const WIRE_EDGE_KINDS: readonly WireEdgeKind[] = ["contains", "anchored-at", "links-to", "mentions"];

/**
 * A single graph node. `id` is stable: derived from slugs and paths only.
 *
 * Mirrors `GraphNode` in `src/core/graph/model.ts`.
 */
export interface WireGraphNode {
  id: string;
  kind: WireNodeKind;
  label: string;
  /** Trust provenance for knowledge nodes; `null` for structural nodes. */
  provenance: WireNoteSource | null;
  /** Pre-formatted side-panel payload. Display-only by contract. */
  detail: Record<string, string>;
}

/** Mirrors `GraphEdge` in `src/core/graph/model.ts`. */
export interface WireGraphEdge {
  source: string;
  target: string;
  kind: WireEdgeKind;
}

/**
 * The authoritative node/edge data, as delivered to the browser.
 *
 * Mirrors `GraphModel` in `src/core/graph/model.ts`, **narrowed by one
 * field**: core's `danglingLinks` (§4.2) is not repeated here.
 *
 * §2.1 allows a wire type to be deliberately narrower than its core
 * counterpart provided the narrowing is *declared* rather than discovered,
 * and this is that declaration. The reason is `GraphPayload` (§5.3): the
 * payload already hoists that index to its own top level as `dangling`, so
 * mirroring it inside `model` as well would put the same map on the wire
 * twice and give the client two places to read one fact from.
 *
 * Two things keep the narrowing honest rather than aspirational.
 * `tests/web/wire.contract.test.ts` asserts
 * `Exact<WireGraphModel, Omit<GraphModel, "danglingLinks">>` — still mutual
 * assignability, merely against an explicitly reduced core type, so a
 * *second* core field added and forgotten still fails to compile. And
 * `toGraphPayload` strips the key at the single point that builds the
 * payload, because TypeScript's structural typing would otherwise let the
 * extra property ride along into `JSON.stringify`.
 */
export interface WireGraphModel {
  /**
   * Data-as-of marker derived from inputs (max note `updated` / index stamp),
   * so two builds of unchanged inputs produce byte-identical JSON. That is
   * the property `GraphPayload.stamp` and the `304` path depend on.
   */
  generatedAt: string;
  staleness: WireStalenessReport | null;
  nodes: WireGraphNode[];
  edges: WireGraphEdge[];
}

/**
 * The core `GraphModel` keys {@link WireGraphModel} deliberately omits.
 *
 * A runtime value rather than only a comment, for the same reason
 * {@link WIRE_NODE_KINDS} is one: the server has to actually delete these
 * keys before serializing, and a hand-written second list of them at the
 * emit site is a list that drifts. `toGraphPayload` iterates this.
 */
export const WIRE_MODEL_OMITTED_KEYS: readonly string[] = ["danglingLinks"];

/**
 * One note, read live for the note column.
 *
 * Mirrors `ViewNote` in `src/core/graph/current.ts`.
 */
export interface WireViewNote {
  slug: string;
  title: string;
  body: string;
  created: string;
  updated: string;
  tags: string[];
  source: WireNoteSource;
}

/** Mirrors `NoteMeta` in `src/core/types.ts`. */
export interface WireNoteMeta {
  title: string;
  /** ISO-8601 timestamps. */
  created: string;
  updated: string;
  tags: string[];
  source: WireNoteSource;
}

/** Mirrors `NoteSummary` in `src/core/types.ts`. */
export interface WireNoteSummary extends WireNoteMeta {
  /** File-name slug (no extension). Stable identity of the note. */
  slug: string;
  /** Size of the Markdown body in characters. */
  bodyLength: number;
}

/** Mirrors `NoteSearchHit` in `src/core/types.ts`. */
export interface WireNoteSearchHit {
  summary: WireNoteSummary;
  score: number;
  snippet: string;
}
