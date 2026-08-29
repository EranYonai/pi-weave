/**
 * Layout computation and position persistence (weave-workspace §7.3, §11 P3).
 *
 * Split from `client-graph.test.ts` because it is a different question. That
 * suite asks "what does the column draw"; this one asks "where does the layout
 * come from, and does it survive a reload" — which is the §11 P3 requirement
 * that the graph must not reshuffle between sessions.
 *
 * Pure Node throughout. `localStorage` arrives as a three-method port, so the
 * failure modes that matter — a throwing `getItem`, a full quota, a v2 entry
 * written by a newer build — are all reachable without a browser.
 */

import { describe, expect, it } from "vitest";
import { COLLIDE_RADIUS, computeLayout } from "../../src/web/shared/layout";
import { hashId } from "../../src/web/client/graph/positions";
import type { Point } from "../../src/web/shared/layout";
import type { WireGraphEdge, WireGraphNode } from "../../src/web/shared/wire";
import {
  LAYOUT_SEED,
  LAYOUT_TICKS,
  POSITIONS_STORAGE_KEY,
  clearPositions,
  deserializePositions,
  graphShapeKey,
  layoutFor,
  loadPositions,
  resolveLayout,
  savePositions,
  serializePositions,
  shouldRelayout,
} from "../../src/web/client/graph/positions";
import type { PositionStorage } from "../../src/web/client/graph/positions";
import { repoLikeGraph } from "../fixtures/graphShapes";

// --- fixtures ---------------------------------------------------------------------------

function node(id: string, kind: WireGraphNode["kind"] = "note"): WireGraphNode {
  return { id, kind, label: id, provenance: null, detail: {} };
}

function edge(source: string, target: string, kind: WireGraphEdge["kind"] = "contains"): WireGraphEdge {
  return { source, target, kind };
}

const NODES = [node("vault", "vault"), node("note:a"), node("note:b"), node("note:c")];
const EDGES = [edge("vault", "note:a"), edge("vault", "note:b"), edge("vault", "note:c"), edge("note:a", "note:b", "links-to")];

/** An in-memory `PositionStorage`, with the failure modes the real one has. */
function memoryStorage(initial: string | null = null) {
  let value = initial;
  const calls: string[] = [];
  const store: PositionStorage & { value: () => string | null; calls: string[] } = {
    getItem(key) {
      calls.push(`get:${key}`);
      return value;
    },
    setItem(key, next) {
      calls.push(`set:${key}`);
      value = next;
    },
    removeItem(key) {
      calls.push(`remove:${key}`);
      value = null;
    },
    value: () => value,
    calls,
  };
  return store;
}

/** A storage that throws on everything — Safari private browsing, historically. */
const hostileStorage: PositionStorage = {
  getItem() {
    throw new Error("SecurityError");
  },
  setItem() {
    throw new Error("QuotaExceededError");
  },
  removeItem() {
    throw new Error("SecurityError");
  },
};

// --- computing ---------------------------------------------------------------------------

describe("layoutFor (§7.3)", () => {
  it("uses the same budget and seed §8's gate asserts against", () => {
    // If these diverged, the dynamics gate would be a statement about a layout
    // nobody renders — green while the shipped graph degenerated.
    expect(LAYOUT_TICKS).toBe(300);
    expect(LAYOUT_SEED).toBe(1);
    const direct = computeLayout(
      { generatedAt: "", staleness: null, nodes: [...NODES], edges: [...EDGES], contentDigest: "" },
      { ticks: LAYOUT_TICKS, seed: LAYOUT_SEED },
    );
    expect(layoutFor(NODES, EDGES)).toEqual(direct);
  });

  it("places every node exactly once", () => {
    const positions = layoutFor(NODES, EDGES);
    expect(positions.size).toBe(NODES.length);
    for (const n of NODES) expect(positions.has(n.id)).toBe(true);
  });

  it("is deterministic across calls", () => {
    // The property the whole cache rests on: a miss and a later re-run over an
    // unchanged graph must agree, or the "cache" would be a source of drift.
    expect(layoutFor(NODES, EDGES)).toEqual(layoutFor(NODES, EDGES));
  });

  it("warm-starts near where it was told to, not from scratch", () => {
    // §7.3's "re-runs the sim only on user drag or expand/collapse" is only
    // usable if a re-run *moves* the picture rather than replacing it.
    const settled = layoutFor(NODES, EDGES);
    const again = layoutFor(NODES, EDGES, settled);
    for (const [id, before] of settled) {
      const after = again.get(id)!;
      expect(Math.hypot(before.x - after.x, before.y - after.y), id).toBeLessThan(2 * COLLIDE_RADIUS);
    }
  });

  it("places a node the warm start has never seen", () => {
    // The expand case: new nodes arrive with no cached position and must not
    // be dropped. `computeLayout` falls back to its own seeding per id.
    const settled = layoutFor(NODES, EDGES);
    const grown = [...NODES, node("note:d")];
    const positions = layoutFor(grown, [...EDGES, edge("vault", "note:d")], settled);
    expect(positions.size).toBe(grown.length);
    expect(Number.isFinite(positions.get("note:d")?.x)).toBe(true);
  });

  it("handles an empty graph", () => {
    expect(layoutFor([], []).size).toBe(0);
  });
});

// --- the shape key ----------------------------------------------------------------------------

describe("graphShapeKey (§11 P3)", () => {
  it("is stable for the same shape", () => {
    expect(graphShapeKey(NODES, EDGES)).toBe(graphShapeKey(NODES, EDGES));
  });

  it("ignores everything that does not move a node", () => {
    // The whole design of the key. A title edit, a tag, a provenance change,
    // `generatedAt` advancing — none of those change the layout, so none of
    // them may throw away an arrangement the user has a mental map of. Keying
    // on the payload `stamp` instead would invalidate on every keystroke,
    // which is the same as not caching at all.
    const relabelled = NODES.map((n) => ({ ...n, label: `${n.label} (edited)`, provenance: "agent" as const, detail: { tags: "x" } }));
    expect(graphShapeKey(relabelled, EDGES)).toBe(graphShapeKey(NODES, EDGES));
  });

  it("changes when a node is added or removed", () => {
    expect(graphShapeKey([...NODES, node("note:d")], EDGES)).not.toBe(graphShapeKey(NODES, EDGES));
    expect(graphShapeKey(NODES.slice(1), EDGES)).not.toBe(graphShapeKey(NODES, EDGES));
  });

  it("changes when an edge is added, removed or re-kinded", () => {
    expect(graphShapeKey(NODES, [...EDGES, edge("note:b", "note:c", "links-to")])).not.toBe(graphShapeKey(NODES, EDGES));
    expect(graphShapeKey(NODES, EDGES.slice(1))).not.toBe(graphShapeKey(NODES, EDGES));
    const rekinded = [edge("vault", "note:a", "mentions"), ...EDGES.slice(1)];
    expect(graphShapeKey(NODES, rekinded)).not.toBe(graphShapeKey(NODES, EDGES));
  });

  it("changes when an edge is reversed", () => {
    const reversed = [edge("note:a", "vault"), ...EDGES.slice(1)];
    expect(graphShapeKey(NODES, reversed)).not.toBe(graphShapeKey(NODES, EDGES));
  });

  it("is independent of node and edge order", () => {
    // A cache that silently invalidated when core reordered its output would
    // be a mystery to debug, and the layout genuinely does not depend on the
    // order — so XOR and sum rather than concatenation.
    expect(graphShapeKey([...NODES].reverse(), [...EDGES].reverse())).toBe(graphShapeKey(NODES, EDGES));
  });

  it("distinguishes a duplicate from a single, which XOR alone cannot", () => {
    // `x ^ x = 0`, so the count and the sum are what keep a doubled element
    // visible. Without them, two copies of one node would key like none.
    expect(graphShapeKey([...NODES, node("note:a")], EDGES)).not.toBe(graphShapeKey(NODES, EDGES));
  });

  it("distinguishes an empty graph from a populated one", () => {
    expect(graphShapeKey([], [])).not.toBe(graphShapeKey(NODES, EDGES));
    expect(graphShapeKey([], [])).toBe(graphShapeKey([], []));
  });

  it("is short and storage-safe", () => {
    // It goes into a JSON value and is compared as a string, so it must not
    // pick up a separator or grow with the graph.
    const key = graphShapeKey(repoLikeGraph().nodes, repoLikeGraph().edges);
    expect(key).toMatch(/^[0-9a-f]+(-[0-9a-f]+){3}$/);
    expect(key.length).toBeLessThan(48);
  });
});

describe("shouldRelayout", () => {
  it("re-runs on a first load and on a shape change", () => {
    expect(shouldRelayout(null, "abc")).toBe(true);
    expect(shouldRelayout("abc", "def")).toBe(true);
  });

  it("does not re-run when the shape is unchanged", () => {
    // The case that matters: the watcher fires on every file save, the client
    // refetches, and a picture the user is reading must not rearrange itself.
    expect(shouldRelayout("abc", "abc")).toBe(false);
  });
});

// --- serialization -------------------------------------------------------------------------------

describe("position serialization", () => {
  const positions = new Map<string, Point>([
    ["a", { x: 1.23456, y: -7.89 }],
    ["b", { x: 100, y: 200 }],
  ]);

  it("round-trips through storage", () => {
    const raw = serializePositions("k", positions);
    const back = deserializePositions(raw, "k");
    expect(back?.get("b")).toEqual({ x: 100, y: 200 });
  });

  it("rounds to a tenth of a layout unit", () => {
    // Far below one screen pixel at any usable zoom, and it roughly halves the
    // stored string. §8 pins that a pinned re-run from settled positions moves
    // nothing at all, which makes a tenth of a unit pure headroom.
    const back = deserializePositions(serializePositions("k", positions), "k");
    expect(back?.get("a")).toEqual({ x: 1.2, y: -7.9 });
  });

  it("stores pairs rather than objects", () => {
    // `localStorage` is a shared 5 MB budget and this is not its only
    // consumer. Same information, ~40% fewer bytes.
    expect(serializePositions("k", positions)).toContain('"a":[1.2,-7.9]');
  });

  it("carries the shape key, which is what makes invalidation one comparison", () => {
    expect(JSON.parse(serializePositions("shape-1", positions))).toMatchObject({ v: 2, key: "shape-1" });
  });
});

describe("deserializePositions rejects everything it should", () => {
  const good = serializePositions("k", new Map([["a", { x: 1, y: 2 }]]));

  it("returns null for an absent entry", () => {
    expect(deserializePositions(null, "k")).toBeNull();
  });

  it("returns null for a key mismatch — the §11 P3 invalidation", () => {
    // Discarded whole rather than merged. A partial merge would place the old
    // nodes and leave the new ones unpositioned, which `renderGraph` then
    // drops — a graph silently missing whatever is newest.
    expect(deserializePositions(good, "other")).toBeNull();
  });

  it("returns null for a future schema version", () => {
    // A v2 reader will meet a v3 entry written by a newer build the user ran
    // yesterday. There is no repair path worth having.
    expect(deserializePositions(JSON.stringify({ v: 3, key: "k", at: { a: [1, 2] } }), "k")).toBeNull();
  });

  it("returns null for a v1 entry — the tangled single-centre recipe", () => {
    // `v: 1` is the layout before branch anchors: blobs interleaved at one
    // centre. The shape key cannot tell the recipes apart (same nodes, same
    // edges), so the version is what makes the old arrangement a miss.
    expect(deserializePositions(JSON.stringify({ v: 1, key: "k", at: { a: [1, 2] } }), "k")).toBeNull();
  });

  it("returns null for structural nonsense", () => {
    for (const raw of ["", "not json", "null", "[]", '"a string"', "42", JSON.stringify({ v: 1, key: "k" }), JSON.stringify({ v: 1, key: "k", at: [] }), JSON.stringify({ v: 1, key: "k", at: null })]) {
      expect(deserializePositions(raw, "k"), raw).toBeNull();
    }
  });

  it("returns null for a malformed coordinate rather than half a layout", () => {
    const bad = [
      { a: [1] },
      { a: [1, 2, 3] },
      { a: { x: 1, y: 2 } },
      { a: ["1", "2"] },
      { a: [Number.NaN, 2] },
      { a: [1, null] },
    ];
    for (const at of bad) {
      expect(deserializePositions(JSON.stringify({ v: 1, key: "k", at }), "k"), JSON.stringify(at)).toBeNull();
    }
    // `Infinity` does not survive `JSON.stringify` — it becomes `null` — so
    // the non-finite guard is reached through the string form a browser would
    // actually store.
    expect(deserializePositions('{"v":1,"key":"k","at":{"a":[1e999,2]}}', "k")).toBeNull();
  });

  it("treats an empty map as a miss", () => {
    // Otherwise the caller believes it has a cache hit and warm-starts from
    // nowhere, which is strictly worse than laying out.
    expect(deserializePositions(JSON.stringify({ v: 1, key: "k", at: {} }), "k")).toBeNull();
  });
});

// --- storage --------------------------------------------------------------------------------------

describe("position storage", () => {
  it("saves under the namespaced, versioned key", () => {
    const storage = memoryStorage();
    expect(savePositions(storage, "k", new Map([["a", { x: 1, y: 2 }]]))).toBe(true);
    expect(storage.calls).toEqual([`set:${POSITIONS_STORAGE_KEY}`]);
    expect(POSITIONS_STORAGE_KEY).toBe("pi-weave.graph.positions.v2");
  });

  it("round-trips through the port", () => {
    const storage = memoryStorage();
    savePositions(storage, "k", new Map([["a", { x: 5, y: 6 }]]));
    expect(loadPositions(storage, "k")?.get("a")).toEqual({ x: 5, y: 6 });
  });

  it("misses on a different shape", () => {
    const storage = memoryStorage();
    savePositions(storage, "shape-1", new Map([["a", { x: 5, y: 6 }]]));
    expect(loadPositions(storage, "shape-2")).toBeNull();
  });

  it("keeps only one layout — last graph wins", () => {
    // A user with three repositories open over a week would otherwise
    // accumulate three multi-hundred-node maps in a 5 MB shared budget, to
    // save a few hundred milliseconds on a switch back.
    const storage = memoryStorage();
    savePositions(storage, "one", new Map([["a", { x: 1, y: 1 }]]));
    savePositions(storage, "two", new Map([["b", { x: 2, y: 2 }]]));
    expect(loadPositions(storage, "one")).toBeNull();
    expect(loadPositions(storage, "two")?.get("b")).toEqual({ x: 2, y: 2 });
  });

  it("clears on request", () => {
    const storage = memoryStorage();
    savePositions(storage, "k", new Map([["a", { x: 1, y: 1 }]]));
    expect(clearPositions(storage)).toBe(true);
    expect(loadPositions(storage, "k")).toBeNull();
  });

  it("survives a storage that throws on every method", () => {
    // Safari private browsing historically, and any partitioned-storage
    // embedding today. A workspace that lays out from scratch is not an error
    // worth surfacing; a workspace that fails to boot is.
    expect(loadPositions(hostileStorage, "k")).toBeNull();
    expect(savePositions(hostileStorage, "k", new Map([["a", { x: 1, y: 1 }]]))).toBe(false);
    expect(clearPositions(hostileStorage)).toBe(false);
  });
});

// --- resolveLayout ------------------------------------------------------------------------------------

describe("resolveLayout — cache first, simulation second (§11 P3)", () => {
  it("lays out and persists on a cold start", () => {
    const storage = memoryStorage();
    const resolved = resolveLayout(storage, NODES, EDGES);
    expect(resolved.cached).toBe(false);
    expect(resolved.positions).toEqual(layoutFor(NODES, EDGES));
    expect(storage.value()).not.toBeNull();
  });

  it("answers a second session from the cache, byte for byte", () => {
    // The §11 P3 requirement stated directly: the graph does not reshuffle
    // between sessions. A hit is used **verbatim** rather than re-simulated
    // from — even a perfect warm start moves every node slightly, and a user
    // reopening the workspace would watch it shuffle for no reason.
    const storage = memoryStorage();
    const first = resolveLayout(storage, NODES, EDGES);
    const second = resolveLayout(storage, NODES, EDGES);
    expect(second.cached).toBe(true);
    expect(second.key).toBe(first.key);
    for (const [id, point] of second.positions) {
      const before = first.positions.get(id)!;
      // Equal to the stored precision, which is a tenth of a layout unit.
      expect(Math.abs(point.x - before.x), id).toBeLessThanOrEqual(0.05);
      expect(Math.abs(point.y - before.y), id).toBeLessThanOrEqual(0.05);
    }
  });

  it("re-lays out when the shape changed, and re-persists", () => {
    const storage = memoryStorage();
    resolveLayout(storage, NODES, EDGES);
    const grown = [...NODES, node("note:d")];
    const resolved = resolveLayout(storage, grown, [...EDGES, edge("vault", "note:d")]);
    expect(resolved.cached).toBe(false);
    expect(resolved.positions.size).toBe(grown.length);
    // And the new layout is what a third session gets.
    expect(resolveLayout(storage, grown, [...EDGES, edge("vault", "note:d")]).cached).toBe(true);
  });

  it("ignores a cache that is missing a node", () => {
    // The shape key says the node set matches, so a gap means a truncated or
    // hand-edited entry. Falling through beats dropping the node, which is
    // what `renderGraph` does with a missing position.
    const key = graphShapeKey(NODES, EDGES);
    const partial = serializePositions(key, new Map([["vault", { x: 0, y: 0 }]]));
    const storage = memoryStorage(partial);
    const resolved = resolveLayout(storage, NODES, EDGES);
    expect(resolved.cached).toBe(false);
    expect(resolved.positions.size).toBe(NODES.length);
  });

  it("works with no usable storage at all", () => {
    // Every call throws, so this exercises the miss path and the failed write
    // together — the graph still lays out and still renders.
    const resolved = resolveLayout(hostileStorage, NODES, EDGES);
    expect(resolved.cached).toBe(false);
    expect(resolved.positions.size).toBe(NODES.length);
  });

  it("resolves the real repository shape and caches it", () => {
    // The §8 fixture end to end: 5 roots, a 60-child hub, 89 nodes.
    const fixture = repoLikeGraph();
    const storage = memoryStorage();
    const cold = resolveLayout(storage, fixture.nodes, fixture.edges);
    expect(cold.cached).toBe(false);
    expect(cold.positions.size).toBe(fixture.nodes.length);
    const warm = resolveLayout(storage, fixture.nodes, fixture.edges);
    expect(warm.cached).toBe(true);
    expect(warm.positions.size).toBe(fixture.nodes.length);
  });
});

describe("the shape digest's hash (positions.ts's cache key)", () => {
  it("hashes ids to unsigned 32-bit values", () => {
    for (const id of ["", "a", "note:one", "module:src/m059", "\u{1f9f5}"]) {
      const h = hashId(id);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(2 ** 32);
    }
  });

  it("is stable across calls and distinct for one-character differences", () => {
    expect(hashId("leaf042")).toBe(hashId("leaf042"));
    expect(hashId("a")).not.toBe(hashId("b"));
    expect(hashId("leaf041")).not.toBe(hashId("leaf042"));
  });

  it("avalanches — the property that turns a hash into a usable angle", () => {
    // Raw FNV-1a fails this: its high bits barely move between adjacent short
    // ids, and `seedPositions` reads the high bits as the ring angle. Bucket
    // 200 sequential ids by their top 4 bits; a good mixer fills all 16.
    const buckets = new Set<number>();
    for (let i = 0; i < 200; i++) buckets.add(hashId(`leaf${String(i).padStart(3, "0")}`) >>> 28);
    expect(buckets.size).toBe(16);
  });

});
