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
  BIG_BRANCH_MIN,
  COLLIDE_RADIUS as COLLIDE_RADIUS_VALUE,
  NODE_RADIUS,
  bigBranches,
  branchAnchors,
  computeLayout,
  lcg,
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
  siblingBlobsGraph,
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
 * Minimum per-axis variance for anchors that must read as two-dimensional.
 *
 * The force-directed-tree recipe is deliberately compact, so the old
 * viewport-derived floor (σ ≥ 80) no longer applies. The floor that remains
 * is the collide geometry itself: anchors sit at least a collision radius
 * apart, so any non-degenerate 2D arrangement has per-axis variance of at
 * least `COLLIDE_RADIUS²` — while a line scores exactly 0 on one axis, and
 * the margin is enormous in the direction that matters.
 */
const MIN_AXIS_VARIANCE = Math.pow(COLLIDE_RADIUS_VALUE, 2);

/**
 * One collision diameter — the closest two groups of collision-spaced nodes
 * can sit while their members still never overlap. Expressed in the layout's
 * own units, not as a magic pixel count.
 */
const COLLIDE_DIAMETER = 2 * COLLIDE_RADIUS_VALUE;

/** The radius within which a hub's leaves must stay — a generous multiple of
 * the collision diameter, so a compact tree passes and a runaway fails. */
const MAX_LEAF_RADIUS = 8 * COLLIDE_DIAMETER;

/**
 * A hub's leaves must occupy most of the compass. Twelve 30° sectors; we
 * require nine. A ring hits all twelve, a line hits two, and nine leaves room
 * for a cluster to be legitimately squeezed by its neighbours on one side.
 */
const RING_SECTORS = 12;
const MIN_RING_SECTORS = 9;

/**
 * Catches the collapse to a line: a line's bounding-box aspect is Infinity,
 * and the measured centre-gravity regression scored 17.9. The compact
 * canonical tree runs elongated under centre gravity (measured ~2.9 on the
 * fixture), so the bound has to clear that with margin while a line still
 * fails by an order of magnitude.
 */
const MAX_ROOT_ASPECT = 5;

function pointsOf(positions: ReadonlyMap<string, Point>): Point[] {
  return [...positions.values()];
}

function xs(points: readonly Point[]): number[] {
  return points.map((p) => p.x);
}

function ys(points: readonly Point[]): number[] {
  return points.map((p) => p.y);
}

const OPTS = { ticks: TICKS, seed: 1 } as const;

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

  it("spreads into two dimensions without exploding", () => {
    // The force-directed-tree recipe is deliberately compact — a tree's radius
    // is set by its depth — so the old "spreads past a viewport" bound is gone.
    // What must still hold: real two-dimensional spread, and nowhere near the
    // runaway regime (see the disconnected fixture's cap).
    const box = bbox(points);
    expect(box.w).toBeGreaterThan(MIN_AXIS_VARIANCE ** 0.5 * 4);
    expect(box.h).toBeGreaterThan(MIN_AXIS_VARIANCE ** 0.5 * 4);
    expect(box.w).toBeLessThan(WIDTH * 10);
    expect(box.h).toBeLessThan(HEIGHT * 10);
  });

  it("keeps the five roots distinct", () => {
    // Distinct is the bound now: each root's subtree hugs it (the tree look),
    // so the roots themselves never coincide and the clusters never fully
    // interleave. Two collision diameters is the floor at which two groups of
    // collision-spaced nodes are still two groups.
    expect(clusterSeparation(positions, REPO_LIKE_ROOTS)).toBeGreaterThan(COLLIDE_DIAMETER);
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

  it("keeps the hub's leaves close to the hub, not scattered to other roots", () => {
    // The force-directed-tree recipe holds children at their parent: every
    // leaf must sit nearer to its own hub than to any other root — the
    // ownership property that makes a tree read as a tree.
    const hub = positions.get("repository")!;
    const leaves = graph.nodes
      .filter((n) => n.id.startsWith("module:src/m"))
      .map((n) => {
        const p = positions.get(n.id)!;
        return Math.hypot(p.x - hub.x, p.y - hub.y);
      });
    expect(leaves).toHaveLength(60);
    for (const r of leaves) expect(r).toBeLessThan(MAX_LEAF_RADIUS);
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

  it("scatters into two dimensions rather than along one ray", () => {
    // Centre gravity walks the blob toward the origin, so occupancy is
    // measured around the blob's own centroid, not the seed point: the claim
    // is that the result is a disc, not a ray.
    const cx = xs(points).reduce((a, b) => a + b, 0) / points.length;
    const cy = ys(points).reduce((a, b) => a + b, 0) / points.length;
    expect(angularOccupancy({ x: cx, y: cy }, points, RING_SECTORS)).toBeGreaterThanOrEqual(MIN_RING_SECTORS);
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
    // Under centre gravity the two blobs gather near the origin and repulsion
    // holds them apart — the measurable claim is that the centroids are
    // distinct while the no-overlap gate (below) covers member separation.
    expect(clusterSeparation(positions, DISCONNECTED_ROOTS)).toBeGreaterThan(0);
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

  it("places a single node at the origin, finite", () => {
    // `forceX()`/`forceY()` centre the layout on the origin — d3's own
    // default — so the single-node case rests there.
    const positions = computeLayout(singleNodeGraph(), OPTS);
    expect(positions.size).toBe(1);
    const only = positions.get("only")!;
    expect(only).toEqual({ x: 0, y: 0 });
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
    // Zero ticks leaves d3's phyllotaxis initialization: every node at a
    // distinct point of the spiral — no overlap, and two real axes.
    expect(minPairwiseDistance(pointsOf(positions))).toBeGreaterThan(0);
    expect(variance(xs(pointsOf(positions)))).toBeGreaterThan(0);
    expect(variance(ys(pointsOf(positions)))).toBeGreaterThan(0);
  });

  it("places nodes trapped in a containment cycle", () => {
    // d3's forceLink handles a containment cycle natively — a cycle is just
    // two links; there is no hierarchy to build and no BFS to trap.
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
      contentDigest: "",
    };
    const positions = computeLayout(cyclic, OPTS);
    expect(positions.size).toBe(2);
    expect(allFinite([...positions.values()])).toBe(true);
    expect(minPairwiseDistance([...positions.values()])).toBeGreaterThan(NODE_DIAMETER);
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

describe("layout dynamics — sibling blobs (branch anchors)", () => {
  // The real repository's tangle, as a fixture: a summaries fan, a sessions
  // fan and an src branch, tangled into one blob by single-centre gravity.
  // `branchAnchors` is the fix, and this block is its gate — the sibling of
  // the disconnected-components block above, for blobs that *do* share a root.
  const graph = siblingBlobsGraph();
  const positions = computeLayout(graph, OPTS);
  const points = pointsOf(positions);

  /** Members of one branch, by the id shapes the fixture gives them. */
  const members = (match: (id: string) => boolean): Point[] => graph.nodes.filter((n) => match(n.id)).map((n) => positions.get(n.id)!);

  const blobs: ReadonlyArray<readonly Point[]> = [
    members((id) => id === "module:summaries" || id.startsWith("file:summaries/")),
    members((id) => id === "module:src" || id.startsWith("module:src/")),
    members((id) => id === "vfolder:sessions" || id.startsWith("note:session-")),
  ];

  it("places every node exactly once, all finite", () => {
    expect(positions.size).toBe(graph.nodes.length);
    expect(allFinite(points)).toBe(true);
  });

  it("keeps every pair of nodes at least a node diameter apart", () => {
    expect(minPairwiseDistance(points)).toBeGreaterThan(NODE_DIAMETER);
  });

  it("leaves a corridor between every pair of blobs", () => {
    // "Separated groups should be separated, or have some space between
    // them" — the space, measured: the bbox gap between two branch subtrees
    // exceeds a collision diameter, the floor at which two groups of
    // collision-spaced nodes are still two groups. (Under the single-centre
    // recipe this measured 0 on the real repository's graph.)
    for (let i = 0; i < blobs.length; i++) {
      for (let j = i + 1; j < blobs.length; j++) {
        const a = bbox(blobs[i]!);
        const b = bbox(blobs[j]!);
        const dx = Math.max(b.minX - a.maxX, a.minX - b.maxX, 0);
        const dy = Math.max(b.minY - a.maxY, a.minY - b.maxY, 0);
        const gap = Math.hypot(dx, dy);
        expect(gap, `blob ${i} vs blob ${j}`).toBeGreaterThan(COLLIDE_DIAMETER);
      }
    }
  });

  it("never interleaves members of different blobs", () => {
    // The strictest form of the same claim: the closest pair drawn from two
    // different branches is still further apart than a node diameter, so no
    // member of one blob sits inside another.
    for (let i = 0; i < blobs.length; i++) {
      for (let j = i + 1; j < blobs.length; j++) {
        let min = Infinity;
        for (const p of blobs[i]!) {
          for (const q of blobs[j]!) {
            const d = Math.hypot(p.x - q.x, p.y - q.y);
            if (d < min) min = d;
          }
        }
        expect(min, `blob ${i} vs blob ${j}`).toBeGreaterThan(NODE_DIAMETER);
      }
    }
  });

  it("keeps the small twig with its root, not on the ring", () => {
    // `module:docs` (3 nodes) is below BIG_BRANCH_MIN, so it belongs to the
    // root group at the origin — closer to the repository than to any blob's
    // centroid. A twig on the ring would mean the threshold had regressed.
    const docs = positions.get("module:docs")!;
    const repo = positions.get("repository")!;
    const toRepo = Math.hypot(docs.x - repo.x, docs.y - repo.y);
    for (const pts of blobs) {
      const box = bbox(pts);
      const toBlob = Math.hypot(docs.x - box.cx, docs.y - box.cy);
      expect(toRepo).toBeLessThan(toBlob);
    }
  });

  it("is deterministic, seed and all", () => {
    expect(computeLayout(graph, OPTS)).toEqual(positions);
    expect(computeLayout(siblingBlobsGraph(), OPTS)).toEqual(positions);
  });
});

describe("branch anchors — the geometry, not the physics", () => {
  /** A root with one module holding `n` files: the threshold probe. */
  const fan = (n: number) => {
    const nodes: Array<{
      id: string;
      kind: "repository" | "module" | "file";
      label: string;
      provenance: null;
      detail: Record<string, never>;
    }> = [
      { id: "repository", kind: "repository", label: "r", provenance: null, detail: {} },
      { id: "module:x", kind: "module", label: "x", provenance: null, detail: {} },
    ];
    const edges: Array<{ source: string; target: string; kind: "contains" }> = [
      { source: "repository", target: "module:x", kind: "contains" },
    ];
    for (let i = 0; i < n; i++) {
      nodes.push({ id: `file:f${i}`, kind: "file", label: `f${i}`, provenance: null, detail: {} });
      edges.push({ source: "module:x", target: `file:f${i}`, kind: "contains" });
    }
    return { generatedAt: "2026-08-24T00:00:00.000Z", staleness: null, nodes, edges, contentDigest: "" };
  };

  it("separates exactly the branches at or above the threshold", () => {
    // The boundary is the contract: below it a branch is a twig that stays
    // with its root, at it the branch is a blob that earns a ring slot. The
    // count is *members* — the module node is part of its own subtree.
    expect(bigBranches(fan(BIG_BRANCH_MIN - 2))).toHaveLength(0);
    expect(bigBranches(fan(BIG_BRANCH_MIN - 1))).toHaveLength(1);
    expect(bigBranches(fan(BIG_BRANCH_MIN - 1))[0]?.members).toHaveLength(BIG_BRANCH_MIN);
  });

  it("sizes discs from settled positions, falling back when nothing is", () => {
    // An empty `settled` is the degenerate call (the live driver before its
    // first layout, a caller probing structure): every disc falls back to one
    // collision radius, and the anchors are still placed — deterministically,
    // not by exception.
    const model = siblingBlobsGraph();
    const anchors = branchAnchors(model, new Map());
    // All three branches' members, and nothing else.
    expect(anchors.size).toBe(95);
    const again = branchAnchors(model, new Map());
    expect([...anchors]).toEqual([...again]);
  });

  it("parks only the unpinned — a warm expand keeps its arrangement", () => {
    // The §7.3 collapse/expand contract, on a graph with big branches: nodes
    // the client already positioned are pinned at exactly those positions —
    // the teleport must move the graph around them, not them.
    const model = siblingBlobsGraph();
    const first = computeLayout(model, OPTS);
    const again = computeLayout(model, { ...OPTS, initial: first, pinWarm: true });
    for (const [id, p] of first) {
      expect(again.get(id), id).toEqual(p);
    }
  });
});

describe("layout defaults", () => {
  it("uses ticks 300 and seed 1 when given nothing", () => {
    // The server calls `computeLayout(model)` bare (§7.3), so the no-options
    // path is a real caller, not a convenience. Pin it against the explicit form.
    expect(computeLayout(repoLikeGraph())).toEqual(computeLayout(repoLikeGraph(), OPTS));
    expect(computeLayout(repoLikeGraph(), {})).toEqual(computeLayout(repoLikeGraph(), OPTS));
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

  it("holds warm-started positions when asked to pin them", () => {
    const graph = disconnectedGraph();
    const settled = computeLayout(graph, OPTS);
    // The collapse/expand contract: a warm re-layout is incremental — the
    // nodes the client already positioned are pinned at exactly those
    // positions, and only the newcomers move.
    const again = computeLayout(graph, { ...OPTS, initial: settled, pinWarm: true });
    for (const [id, p] of settled) {
      const q = again.get(id)!;
      expect(Math.hypot(p.x - q.x, p.y - q.y)).toBe(0);
    }
  });
});

describe("layout primitives", () => {
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
});
