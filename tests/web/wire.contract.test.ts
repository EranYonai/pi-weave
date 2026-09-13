/**
 * The wire DTOs vs. the core types they mirror — a **compile-time** gate
 * (weave-workspace §5.3, §2).
 *
 * ## What this file is defending against
 *
 * `src/web/shared/graph.ts` declares the graph shapes structurally instead of
 * importing them from `src/core`. That is what keeps the client tier free of
 * core: resolving a core type, even under `import type`, makes
 * `tsc -p tsconfig.web.json` load `node:fs` and fail, because type erasure
 * happens in the bundler and not in the typechecker.
 *
 * The cost of declaring a shape twice is drift, and drift in a serialization
 * boundary is the quiet kind: the server keeps sending a field, the client
 * keeps not knowing about it, and nothing fails until someone reads a column
 * that has been blank for a month. So drift is made a **build error** here.
 *
 * ## How it works, and why it is not a runtime test
 *
 * Almost nothing below executes. {@link Exact} asserts mutual assignability —
 * A extends B *and* B extends A — and `assertExact` only typechecks when that
 * holds. The enforcement is `tsc --noEmit`, which covers `tests/**` under the
 * root project (the one project where importing core is legal and free). The
 * `it()` blocks exist so the assertions appear in the run and so the couple of
 * genuinely runtime checks (the kind arrays) have a home.
 *
 * Add a field to core's `GraphNode` and this file stops compiling until
 * `graph.ts` agrees — which is precisely the moment a human should decide
 * whether that field belongs on the wire at all. Answering "no" is allowed:
 * make the wire type explicitly narrower and adjust the assertion to a
 * one-directional `Extends` with a comment saying why. What must never happen
 * is the two shapes diverging silently.
 */

import { describe, expect, it } from "vitest";

// Core — legal here: this is a Node-side test, not client-reachable code.
import type { EdgeKind, GraphEdge, GraphModel, GraphNode, NodeKind } from "../../src/core/graph/model";
import { EDGE_KINDS, NODE_KINDS } from "../../src/core/graph/model";
import type { ViewNote } from "../../src/core/graph/current";
import type { NoteMeta, NoteSearchHit, NoteSource, NoteSummary, StalenessReport, StalenessState } from "../../src/core/types";

// The wire mirrors.
import type {
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
} from "../../src/web/shared/graph";
import { WIRE_EDGE_KINDS, WIRE_MODEL_OMITTED_KEYS, WIRE_NODE_KINDS } from "../../src/web/shared/graph";
import type { NotePayload } from "../../src/web/shared/wire";

// --- the type-level machinery -------------------------------------------------

/**
 * `true` only when `A` and `B` are mutually assignable.
 *
 * Assignability rather than identity: the DTOs are allowed to differ in ways
 * that cannot affect a JSON payload — a `readonly` modifier, an alias, the
 * order fields are written in. What they may not differ in is the set of
 * fields and their types, which is what a serialization contract *is*.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * The core `GraphModel` fields the wire model deliberately does not mirror.
 *
 * `danglingLinks` (§4.2) is hoisted to `GraphPayload.dangling` instead of
 * being repeated inside `model`, so the same map does not cross the wire
 * twice. This is §2.1's sanctioned escape hatch — "narrow the wire type
 * deliberately and relax the assertion, with a comment saying why" — and it
 * is spelled as an `Omit` rather than a dropped assertion so the check stays
 * **mutual** against an explicitly reduced core type. Add a second field to
 * core's `GraphModel` and this still stops compiling; only the key named
 * here is exempt, and exempting another one is an edit in this list.
 */
type WireOmittedModelKeys = "danglingLinks";

/** Compiles only when its argument is the literal type `true`. */
function assertExact<T extends true>(_witness?: T): void {
  /* no runtime behaviour: the assertion is the type parameter */
}

// --- the assertions ------------------------------------------------------------

describe("wire DTOs mirror the core types (compile-time)", () => {
  it("scalar unions match", () => {
    assertExact<Exact<WireNoteSource, NoteSource>>();
    assertExact<Exact<WireStalenessState, StalenessState>>();
    assertExact<Exact<WireNodeKind, NodeKind>>();
    assertExact<Exact<WireEdgeKind, EdgeKind>>();
    expect(true).toBe(true);
  });

  it("graph structures match", () => {
    assertExact<Exact<WireStalenessReport, StalenessReport>>();
    assertExact<Exact<WireGraphNode, GraphNode>>();
    assertExact<Exact<WireGraphEdge, GraphEdge>>();
    assertExact<Exact<WireGraphModel, Omit<GraphModel, WireOmittedModelKeys>>>();
    // The narrowing is only legitimate if the omitted key genuinely exists on
    // core — otherwise the `Omit` above is a no-op that silently disarms the
    // assertion the day someone renames the field.
    assertExact<WireOmittedModelKeys extends keyof GraphModel ? true : false>();
    expect(true).toBe(true);
  });

  it("the runtime omit list matches the type-level one", () => {
    // `toGraphPayload` deletes these keys by iterating the runtime array, so
    // the array drifting from `WireOmittedModelKeys` would ship the field the
    // type says is absent (structural typing lets an extra property ride into
    // `JSON.stringify` without a murmur).
    const typeLevel: readonly WireOmittedModelKeys[] = ["danglingLinks"];
    expect(WIRE_MODEL_OMITTED_KEYS).toEqual(typeLevel);
    // …and every name in it is a real core field.
    const sample: GraphModel = {
      generatedAt: "",
      staleness: null,
      nodes: [],
      edges: [],
      danglingLinks: {},
      contentDigest: "",
    };
    for (const key of WIRE_MODEL_OMITTED_KEYS) expect(key in sample).toBe(true);
  });

  it("note structures match", () => {
    assertExact<Exact<WireViewNote, ViewNote>>();
    assertExact<Exact<WireNoteMeta, NoteMeta>>();
    assertExact<Exact<WireNoteSummary, NoteSummary>>();
    assertExact<Exact<WireNoteSearchHit, NoteSearchHit>>();
    expect(true).toBe(true);
  });

  it("NotePayload contains only the rendered note", () => {
    // A `Note` is assignable to a `ViewNote` (extra keys are allowed through
    // a variable), so the guard that matters is the runtime one in
    // `notePayload` — which builds the object field by field rather than
    // spreading. This pins the *shape* it must build.
    const view: NotePayload["note"] = {
      slug: "s",
      title: "t",
      body: "b",
      created: "c",
      updated: "u",
      tags: [],
      source: "human",
    };
    expect(Object.keys(view).sort()).toEqual(["body", "created", "slug", "source", "tags", "title", "updated"]);
  });

  it("a core value is assignable to its wire type, and back", () => {
    // The assertions above are structural; this one is a real value flowing
    // through the boundary, which is what the server actually does when it
    // puts a `GraphModel` into a `GraphPayload`.
    const core: GraphModel = {
      generatedAt: "2026-01-01T00:00:00.000Z",
      staleness: { state: "fresh", reasons: [] },
      nodes: [{ id: "vault", kind: "vault", label: "vault", provenance: null, detail: { notes: "1" } }],
      edges: [{ source: "vault", target: "note:a", kind: "contains" }],
      danglingLinks: { a: ["ghost"] },
      contentDigest: "",
    };
    // Core → wire is a widening-free assignment even with the extra key,
    // because the wire type is a strict subset. The reverse needs the key
    // supplied, which is exactly what `toGraphPayload` does not ship.
    const wire: WireGraphModel = core;
    const back: Omit<GraphModel, WireOmittedModelKeys> = wire;
    expect(back.nodes[0]!.id).toBe("vault");
    expect(back.edges[0]!.kind).toBe("contains");
  });
});

describe("the kind arrays stay in step", () => {
  // These two are runtime values, so unlike everything above they can drift
  // without a type error: core could gain a kind, the union assertion would
  // force `graph.ts` to add it, and the *array* could still be forgotten —
  // producing a legend with a missing colour and no failure anywhere.
  it("WIRE_NODE_KINDS equals NODE_KINDS, in order", () => {
    expect(WIRE_NODE_KINDS).toEqual(NODE_KINDS);
  });

  it("WIRE_EDGE_KINDS equals EDGE_KINDS, in order", () => {
    expect(WIRE_EDGE_KINDS).toEqual(EDGE_KINDS);
  });

  it("each array covers its whole union, with no duplicates", () => {
    // Guards the other direction: an array is only a faithful enumeration if
    // it has no repeats, and `toEqual` above would happily accept two lists
    // that were duplicated identically.
    expect(new Set(WIRE_NODE_KINDS).size).toBe(WIRE_NODE_KINDS.length);
    expect(new Set(WIRE_EDGE_KINDS).size).toBe(WIRE_EDGE_KINDS.length);
  });
});
