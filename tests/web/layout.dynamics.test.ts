import { describe, expect, it } from "vitest";
import { COLLIDE_RADIUS, NODE_RADIUS, computeLayout, lcg } from "../../src/web/shared/layout";
import type { Point } from "../../src/web/shared/layout";
import { allFinite, angularOccupancy, minPairwiseDistance, variance } from "../../src/web/shared/metrics";
import {
  coincidentGraph,
  coincidentPositions,
  disconnectedGraph,
  emptyGraph,
  pathologicalGraph,
  repoLikeGraph,
  singleNodeGraph,
  starGraph,
} from "../fixtures/graphShapes";

const OPTS = { ticks: 300, seed: 1 } as const;
const NODE_DIAMETER = 2 * NODE_RADIUS;

function pointsOf(positions: ReadonlyMap<string, Point>): Point[] {
  return [...positions.values()];
}

describe("shared graph layout", () => {
  it("lays out the repository graph deterministically in two dimensions", () => {
    const graph = repoLikeGraph();
    const positions = computeLayout(graph, OPTS);
    expect(positions.size).toBe(graph.nodes.length);
    expect(allFinite(pointsOf(positions))).toBe(true);
    expect(variance(pointsOf(positions).map(({ x }) => x))).toBeGreaterThan(COLLIDE_RADIUS ** 2);
    expect(variance(pointsOf(positions).map(({ y }) => y))).toBeGreaterThan(COLLIDE_RADIUS ** 2);
    expect(computeLayout(repoLikeGraph(), OPTS)).toEqual(positions);
  });

  it("breaks coincident starts without overlapping nodes", () => {
    const graph = coincidentGraph(40);
    const positions = computeLayout(graph, { ...OPTS, initial: coincidentPositions(graph, { x: 0, y: 0 }) });
    const points = pointsOf(positions);
    expect(allFinite(points)).toBe(true);
    expect(minPairwiseDistance(points)).toBeGreaterThan(NODE_DIAMETER);
    expect(angularOccupancy({ x: 0, y: 0 }, points, 12)).toBeGreaterThanOrEqual(9);
    expect(computeLayout(graph, { ...OPTS, seed: 7, initial: coincidentPositions(graph, { x: 0, y: 0 }) })).not.toEqual(positions);
  });

  it("keeps a large star readable", () => {
    const graph = starGraph(200);
    const positions = computeLayout(graph, OPTS);
    const hub = positions.get("hub")!;
    const leaves = [...positions].filter(([id]) => id !== "hub").map(([, point]) => point);
    expect(angularOccupancy(hub, leaves, 12)).toBeGreaterThanOrEqual(9);
    expect(minPairwiseDistance(pointsOf(positions))).toBeGreaterThan(NODE_DIAMETER);
  });

  it("handles empty, malformed, duplicate and cyclic input", () => {
    expect(computeLayout(emptyGraph(), OPTS)).toEqual(new Map());
    expect(computeLayout(pathologicalGraph(), OPTS).size).toBe(3);
    expect(computeLayout({
      ...singleNodeGraph(),
      nodes: [
        { id: "dup", kind: "note", label: "first", provenance: "human", detail: {} },
        { id: "dup", kind: "note", label: "second", provenance: "agent", detail: {} },
        { id: "other", kind: "file", label: "other", provenance: null, detail: {} },
      ],
      edges: [{ source: "dup", target: "other", kind: "contains" }],
    }, OPTS).size).toBe(2);
    const cyclic = {
      ...singleNodeGraph(),
      nodes: [
        { id: "x", kind: "module" as const, label: "x", provenance: null, detail: {} },
        { id: "y", kind: "module" as const, label: "y", provenance: null, detail: {} },
      ],
      edges: [
        { source: "x", target: "y", kind: "contains" as const },
        { source: "y", target: "x", kind: "contains" as const },
      ],
    };
    expect(computeLayout(cyclic, OPTS).size).toBe(2);
  });

  it("uses stable defaults and ignores poisoned warm positions", () => {
    expect(computeLayout(repoLikeGraph())).toEqual(computeLayout(repoLikeGraph(), OPTS));
    expect(computeLayout(repoLikeGraph(), { ...OPTS, ticks: -5 })).toEqual(computeLayout(repoLikeGraph(), { ...OPTS, ticks: 0 }));
    expect(computeLayout(repoLikeGraph(), { ...OPTS, ticks: 10.9 })).toEqual(computeLayout(repoLikeGraph(), { ...OPTS, ticks: 10 }));
    const poisoned = new Map<string, Point>([["alpha", { x: Number.NaN, y: 0 }], ["beta", { x: 0, y: Infinity }]]);
    expect(allFinite(pointsOf(computeLayout(disconnectedGraph(), { ...OPTS, initial: poisoned })))).toBe(true);
  });

  it("preserves pinned warm positions", () => {
    const graph = disconnectedGraph();
    const first = computeLayout(graph, OPTS);
    const again = computeLayout(graph, { ...OPTS, initial: first, pinWarm: true });
    expect(again).toEqual(first);
  });
});

describe("layout primitives", () => {
  it("matches d3's LCG sequence", () => {
    const random = lcg(1);
    let state = 1;
    for (let i = 0; i < 5; i++) {
      state = (1664525 * state + 1013904223) % 4294967296;
      expect(random()).toBe(state / 4294967296);
    }
  });
});
