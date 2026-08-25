/**
 * The dynamics smoke test (weave-workspace §8) — the gate this rewrite exists for.
 *
 * The retired viewer shipped 671 green tests and a visually broken layout:
 * five cluster nodes collapsed onto a vertical line at exactly x = W/2.
 * Nothing tested the *output* of the simulation, so nothing caught it. This
 * file tests the output, on this repository's real shape plus four adversarial
 * ones, and it lands before any UI code.
 *
 * Pure Node. No DOM, no browser, and — a hard project constraint — no
 * screenshots. Every assertion is a number computed from the position map.
 *
 * ## The thresholds
 *
 * Each is derived from geometry that is true before the simulation runs, not
 * reverse-engineered from a passing run. A threshold you tuned until it passed
 * is a threshold that will pass the next bug too.
 */

import { describe, expect, it } from "vitest";
import {
  CONTAINS_DISTANCE,
  NODE_RADIUS,
  computeLayout,
  hashId,
  lcg,
  ringRadius,
  seedPositions,
} from "../../src/web/shared/layout";
import type { Point } from "../../src/web/shared/layout";
import { allFinite, angularOccupancy, bbox, clusterSeparation, minPairwiseDistance, variance } from "../../src/web/shared/metrics";
import {
  DISCONNECTED_ROOTS,
  REPO_LIKE_ROOTS,
  coincidentGraph,
  coincidentPositions,
  disconnectedGraph,
  emptyGraph,
  pathologicalGraph,
  repoLikeGraph,
  singleNodeGraph,
  starGraph,
} from "../fixtures/graphShapes";

const WIDTH = 1280;
const HEIGHT = 800;
const TICKS = 300;

/**
 * Two nodes may never visually overlap, so the closest pair must exceed one
 * node diameter. This is the renderer's contract, stated in layout units.
 */
const NODE_DIAMETER = 2 * NODE_RADIUS;

/**
 * Minimum per-axis spread. A layout that has genuinely spread over a viewport
 * has a standard deviation on the order of a quarter of that viewport's
 * smaller dimension; we demand only a *tenth* of the smaller dimension, which
 * is a floor no healthy layout approaches and no collapsed one can reach.
 *
 *   σ ≥ 800 / 10 = 80  ⇒  variance ≥ 6400
 *
 * The degenerate case scores exactly 0 on one axis, so the margin is enormous
 * in the direction that matters.
 */
const MIN_AXIS_VARIANCE = Math.pow(Math.min(WIDTH, HEIGHT) / 10, 2);

/**
 * Two top-level cluster anchors must stay at least one containment ring apart —
 * i.e. their children's rings cannot interpenetrate at the anchor. Expressed
 * in the layout's own units (`CONTAINS_DISTANCE`), not as a magic pixel count.
 */
const MIN_SEP = 2 * CONTAINS_DISTANCE;

/**
 * A hub's leaves must occupy most of the compass. Twelve 30° sectors; we
 * require nine. A ring hits all twelve, a line hits two, and nine leaves room
 * for a cluster to be legitimately squeezed by its neighbours on one side.
 */
const RING_SECTORS = 12;
const MIN_RING_SECTORS = 9;

/**
 * The cluster anchors are seeded on a circle, so their bounding box is square
 * by construction and any elongation is the simulation squeezing one axis. A
 * factor of 2 tolerates real asymmetry from unequal cluster sizes while
 * catching the collapse: a perfect line scores Infinity, and the measured
 * centre-gravity regression scored 17.9.
 */
const MAX_ROOT_ASPECT = 2;

function pointsOf(positions: ReadonlyMap<string, Point>): Point[] {
  return [...positions.values()];
}

function xs(points: readonly Point[]): number[] {
  return points.map((p) => p.x);
}

function ys(points: readonly Point[]): number[] {
  return points.map((p) => p.y);
}

const OPTS = { ticks: TICKS, seed: 1, width: WIDTH, height: HEIGHT } as const;

describe("layout dynamics — the real repository shape", () => {
  const graph = repoLikeGraph();
  const positions = computeLayout(graph, OPTS);
  const points = pointsOf(positions);

  it("places every node exactly once", () => {
    expect(positions.size).toBe(graph.nodes.length);
  });

  it("produces only finite coordinates", () => {
    expect(allFinite(points)).toBe(true);
  });

  it("does not collapse onto a vertical line", () => {
    // The exact failure of the retired viewer: every node at x = W/2.
    expect(variance(xs(points))).toBeGreaterThan(MIN_AXIS_VARIANCE);
  });

  it("does not collapse onto a horizontal line", () => {
    expect(variance(ys(points))).toBeGreaterThan(MIN_AXIS_VARIANCE);
  });

  it("keeps every pair of nodes at least a node diameter apart", () => {
    expect(minPairwiseDistance(points)).toBeGreaterThan(NODE_DIAMETER);
  });

  it("spreads past a single viewport", () => {
    const box = bbox(points);
    expect(box.w).toBeGreaterThan(WIDTH);
    expect(box.h).toBeGreaterThan(HEIGHT);
  });

  it("keeps the five roots distinct", () => {
    expect(clusterSeparation(positions, REPO_LIKE_ROOTS)).toBeGreaterThan(MIN_SEP);
  });

  it("arranges the five roots in two dimensions, not on a line", () => {
    // The literal reported symptom: "5 cluster nodes collapsed onto a vertical
    // line at exactly x = W/2". Asserted on the roots themselves, because the
    // whole-cloud variance can stay healthy on the children while the anchors
    // are squeezed onto one axis — measured at 5,000 for a centre-gravity
    // regression whose overall x-variance was still 52,000.
    const anchors = REPO_LIKE_ROOTS.map((id) => positions.get(id)!);
    expect(anchors).toHaveLength(5);
    expect(variance(xs(anchors))).toBeGreaterThan(MIN_AXIS_VARIANCE);
    expect(variance(ys(anchors))).toBeGreaterThan(MIN_AXIS_VARIANCE);
    // …and the arrangement is not merely non-degenerate but roughly circular.
    const box = bbox(anchors);
    expect(Math.max(box.w, box.h) / Math.min(box.w, box.h)).toBeLessThan(MAX_ROOT_ASPECT);
  });

  it("rings the 60-child hub rather than stacking it", () => {
    const hub = positions.get("repository")!;
    const leaves = graph.nodes.filter((n) => n.id.startsWith("module:src/m")).map((n) => positions.get(n.id)!);
    expect(leaves).toHaveLength(60);
    expect(angularOccupancy(hub, leaves, RING_SECTORS)).toBeGreaterThanOrEqual(MIN_RING_SECTORS);
  });

  it("keeps the hub's leaves near their ring radius, not in a hairball", () => {
    const hub = positions.get("repository")!;
    const target = ringRadius(60);
    const radii = graph.nodes
      .filter((n) => n.id.startsWith("module:src/m"))
      .map((n) => {
        const p = positions.get(n.id)!;
        return Math.hypot(p.x - hub.x, p.y - hub.y);
      });
    // Every leaf within a factor of two of the ring the geometry asked for.
    expect(Math.min(...radii)).toBeGreaterThan(target / 2);
    expect(Math.max(...radii)).toBeLessThan(target * 2);
  });

  it("is deterministic for the same seed", () => {
    expect(computeLayout(graph, OPTS)).toEqual(positions);
    // …and via a freshly built, structurally identical model.
    expect(computeLayout(repoLikeGraph(), OPTS)).toEqual(positions);
  });

  it("is unaffected by the seed on a well-separated graph", () => {
    // `seed` drives d3's jiggle LCG, and jiggle only fires on an exactly-zero
    // separation. On a graph whose seeding already guarantees distinct points,
    // the seed is correctly a no-op. The coincident fixture is where it bites.
    expect(computeLayout(graph, { ...OPTS, seed: 7 })).toEqual(positions);
  });
});

describe("layout dynamics — coincident seeding", () => {
  const graph = coincidentGraph(40);
  const at = { x: WIDTH / 2, y: HEIGHT / 2 };
  const positions = computeLayout(graph, { ...OPTS, initial: coincidentPositions(graph, at) });
  const points = pointsOf(positions);

  it("breaks symmetry on both axes", () => {
    expect(variance(xs(points))).toBeGreaterThan(0);
    expect(variance(ys(points))).toBeGreaterThan(0);
  });

  it("separates every node despite the shared start", () => {
    expect(minPairwiseDistance(points)).toBeGreaterThan(NODE_DIAMETER);
  });

  it("stays finite", () => {
    expect(allFinite(points)).toBe(true);
  });

  it("scatters around the seed point rather than along one ray", () => {
    expect(angularOccupancy(at, points, RING_SECTORS)).toBeGreaterThanOrEqual(MIN_RING_SECTORS);
  });

  it("is deterministic, and the seed selects which way symmetry breaks", () => {
    const again = computeLayout(graph, { ...OPTS, initial: coincidentPositions(graph, at) });
    expect(again).toEqual(positions);
    // This is the only fixture where `seed` can matter: jiggle fires only on an
    // exactly-zero separation, which is precisely what coincident seeding
    // creates. If this passed with the seed ignored, "seeded LCG" would be a
    // claim rather than a fact.
    const other = computeLayout(graph, { ...OPTS, seed: 7, initial: coincidentPositions(graph, at) });
    expect(other).not.toEqual(positions);
    // …and the alternative must be just as valid a layout, not merely different.
    expect(minPairwiseDistance([...other.values()])).toBeGreaterThan(NODE_DIAMETER);
    expect(allFinite([...other.values()])).toBe(true);
  });
});

describe("layout dynamics — disconnected components", () => {
  const graph = disconnectedGraph();
  const positions = computeLayout(graph, OPTS);
  const points = pointsOf(positions);

  it("separates the two components", () => {
    expect(clusterSeparation(positions, DISCONNECTED_ROOTS)).toBeGreaterThan(MIN_SEP);
  });

  it("lets neither component escape to infinity", () => {
    // Unbounded repulsion is the classic disconnected-graph failure. Cap the
    // spread at a generous multiple of the viewport: big enough that a healthy
    // layout never trips it, small enough that a runaway always does.
    const box = bbox(points);
    expect(box.w).toBeLessThan(WIDTH * 10);
    expect(box.h).toBeLessThan(HEIGHT * 10);
    expect(allFinite(points)).toBe(true);
  });

  it("still keeps nodes apart", () => {
    expect(minPairwiseDistance(points)).toBeGreaterThan(NODE_DIAMETER);
  });
});

describe("layout dynamics — a 200-node star", () => {
  const graph = starGraph(200);
  const positions = computeLayout(graph, OPTS);
  const points = pointsOf(positions);
  const hub = positions.get("hub")!;
  const leaves = [...positions.entries()].filter(([id]) => id !== "hub").map(([, p]) => p);

  it("rings the hub instead of forming a line", () => {
    expect(angularOccupancy(hub, leaves, RING_SECTORS)).toBe(RING_SECTORS);
  });

  it("keeps the leaves off each other", () => {
    expect(minPairwiseDistance(points)).toBeGreaterThan(NODE_DIAMETER);
  });

  it("has real spread on both axes", () => {
    expect(variance(xs(points))).toBeGreaterThan(MIN_AXIS_VARIANCE);
    expect(variance(ys(points))).toBeGreaterThan(MIN_AXIS_VARIANCE);
  });

  it("stays finite and deterministic", () => {
    expect(allFinite(points)).toBe(true);
    expect(computeLayout(graph, OPTS)).toEqual(positions);
  });
});

describe("layout dynamics — degenerate input", () => {
  it("returns an empty map for an empty graph", () => {
    expect(computeLayout(emptyGraph(), OPTS).size).toBe(0);
  });

  it("places a single node at the centre, finite", () => {
    const positions = computeLayout(singleNodeGraph(), OPTS);
    expect(positions.size).toBe(1);
    const only = positions.get("only")!;
    expect(only).toEqual({ x: WIDTH / 2, y: HEIGHT / 2 });
    expect(allFinite([only])).toBe(true);
  });

  it("survives self-edges and edges referencing missing ids", () => {
    const positions = computeLayout(pathologicalGraph(), OPTS);
    expect(positions.size).toBe(3);
    expect(allFinite(pointsOf(positions))).toBe(true);
    expect(minPairwiseDistance(pointsOf(positions))).toBeGreaterThan(NODE_DIAMETER);
  });

  it("collapses duplicate node ids to one position", () => {
    // `buildGraph` derives ids from slugs and paths, so a slug collision would
    // surface here as a duplicate. d3 would happily simulate both copies and
    // then fight over which one the renderer draws.
    const dup = {
      ...singleNodeGraph(),
      nodes: [
        { id: "dup", kind: "note" as const, label: "First", provenance: "human" as const, detail: {} },
        { id: "dup", kind: "note" as const, label: "Second", provenance: "agent" as const, detail: {} },
        { id: "other", kind: "file" as const, label: "Other", provenance: null, detail: {} },
      ],
      edges: [{ source: "dup", target: "other", kind: "contains" as const }],
    };
    const positions = computeLayout(dup, OPTS);
    expect([...positions.keys()]).toEqual(["dup", "other"]);
    expect(allFinite(pointsOf(positions))).toBe(true);
  });

  it("tolerates a zero tick budget without NaN", () => {
    const positions = computeLayout(repoLikeGraph(), { ...OPTS, ticks: 0 });
    expect(allFinite(pointsOf(positions))).toBe(true);
    // Zero ticks means the seeding alone, so it must already be non-degenerate.
    expect(variance(xs(pointsOf(positions)))).toBeGreaterThan(MIN_AXIS_VARIANCE);
  });

  it("ignores non-finite warm-start positions", () => {
    const graph = disconnectedGraph();
    const poisoned = new Map<string, Point>([
      ["alpha", { x: Number.NaN, y: 0 }],
      ["beta", { x: 0, y: Number.POSITIVE_INFINITY }],
    ]);
    const positions = computeLayout(graph, { ...OPTS, initial: poisoned });
    expect(allFinite(pointsOf(positions))).toBe(true);
  });
});

describe("layout seeding", () => {
  it("never co-locates a child with its parent", () => {
    const graph = repoLikeGraph();
    const seeds = seedPositions(graph, WIDTH, HEIGHT);
    for (const e of graph.edges) {
      if (e.kind !== "contains" && e.kind !== "anchored-at") continue;
      const a = seeds.get(e.source)!;
      const b = seeds.get(e.target)!;
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(0);
    }
  });

  it("never co-locates two siblings", () => {
    const seeds = seedPositions(starGraph(200), WIDTH, HEIGHT);
    const leaves = [...seeds.entries()].filter(([id]) => id !== "hub").map(([, p]) => p);
    expect(minPairwiseDistance(leaves)).toBeGreaterThan(0);
  });

  it("defaults the viewport when none is given", () => {
    const seeds = seedPositions(singleNodeGraph());
    expect(seeds.get("only")).toEqual({ x: 640, y: 400 });
  });

  it("places nodes trapped in a containment cycle", () => {
    // Every node parented ⇒ no roots ⇒ the BFS never starts. The sweep must
    // still produce a finite, distinct point for each of them.
    const cyclic = {
      generatedAt: "2026-08-24T00:00:00.000Z",
      staleness: null,
      nodes: [
        { id: "x", kind: "module" as const, label: "x", provenance: null, detail: {} },
        { id: "y", kind: "module" as const, label: "y", provenance: null, detail: {} },
      ],
      edges: [
        { source: "x", target: "y", kind: "contains" as const },
        { source: "y", target: "x", kind: "contains" as const },
      ],
    };
    const seeds = seedPositions(cyclic, WIDTH, HEIGHT);
    expect(seeds.size).toBe(2);
    expect(allFinite([...seeds.values()])).toBe(true);
    expect(minPairwiseDistance([...seeds.values()])).toBeGreaterThan(0);
    expect(allFinite(pointsOf(computeLayout(cyclic, OPTS)))).toBe(true);
  });
});

describe("layout defaults", () => {
  it("uses ticks 300, seed 1 and a 1280×800 viewport when given nothing", () => {
    // The server calls `computeLayout(model)` bare (§7.3), so the no-options
    // path is a real caller, not a convenience. Pin it against the explicit form.
    expect(computeLayout(repoLikeGraph())).toEqual(computeLayout(repoLikeGraph(), OPTS));
    expect(computeLayout(repoLikeGraph(), {})).toEqual(computeLayout(repoLikeGraph(), OPTS));
  });

  it("honours a non-default viewport", () => {
    const wide = computeLayout(repoLikeGraph(), { ...OPTS, width: 3000, height: 200 });
    expect(allFinite(pointsOf(wide))).toBe(true);
    // Centred on the given viewport, so the centroid tracks it.
    const box = bbox(pointsOf(wide));
    expect(box.cx).toBeGreaterThan(WIDTH);
  });

  it("clamps a negative tick budget to zero rather than looping forever", () => {
    const positions = computeLayout(repoLikeGraph(), { ...OPTS, ticks: -50 });
    expect(positions).toEqual(computeLayout(repoLikeGraph(), { ...OPTS, ticks: 0 }));
  });

  it("truncates a fractional tick budget", () => {
    expect(computeLayout(repoLikeGraph(), { ...OPTS, ticks: 10.9 })).toEqual(
      computeLayout(repoLikeGraph(), { ...OPTS, ticks: 10 }),
    );
  });

  it("warm-starts from supplied positions", () => {
    const graph = disconnectedGraph();
    const settled = computeLayout(graph, OPTS);
    // Re-running from the settled state must be a near-fixed-point: this is
    // what stops the graph jumping when the client re-runs after a drag.
    const again = computeLayout(graph, { ...OPTS, initial: settled });
    for (const [id, p] of settled) {
      const q = again.get(id)!;
      expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeLessThan(CONTAINS_DISTANCE);
    }
  });
});

describe("layout primitives", () => {
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

  it("reproduces d3-force's LCG stream for seed 1", () => {
    // d3's own lcg() starts at s = 1; ours must match it exactly for seed 1,
    // otherwise "seeded" would mean something different here than in d3.
    const ours = lcg(1);
    let s = 1;
    const theirs = (): number => (s = (1664525 * s + 1013904223) % 4294967296) / 4294967296;
    for (let i = 0; i < 5; i++) expect(ours()).toBe(theirs());
  });

  it("emits unit-interval values for any seed", () => {
    const r = lcg(123456789);
    for (let i = 0; i < 100; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("sizes rings so siblings fit on the circumference", () => {
    expect(ringRadius(0)).toBe(CONTAINS_DISTANCE);
    expect(ringRadius(2)).toBe(CONTAINS_DISTANCE);
    // 60 children × the sibling arc, divided by 2π.
    expect(ringRadius(60)).toBeGreaterThan(CONTAINS_DISTANCE);
    expect(ringRadius(200)).toBeGreaterThan(ringRadius(60));
    // Circumference actually holds them: 2πr ≥ spacing × k.
    expect(2 * Math.PI * ringRadius(60)).toBeGreaterThanOrEqual(60 * 2 * NODE_RADIUS);
  });
});
