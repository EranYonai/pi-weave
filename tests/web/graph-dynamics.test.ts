import { describe, expect, it } from "vitest";
import { createGraphSimulation } from "../../src/web/client/graph/dynamics";
import type { RenderGraph } from "../../src/web/client/graph/graph.model";
import type { Point } from "../../src/web/shared/layout";

function graph(
  nodes: Array<{ id: string; x: number; y: number }>,
  edges: Array<{ source: string; target: string }> = [],
): RenderGraph {
  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      x: node.x,
      y: node.y,
      size: 3,
      label: node.id,
      color: "#000000",
      kind: "note",
      provenance: "human",
      zIndex: 1,
      type: "circle",
    })),
    edges: edges.map((edge) => ({
      key: `${edge.source}\u0000${edge.target}\u0000links-to`,
      source: edge.source,
      target: edge.target,
      size: 1,
      color: "#000000",
      kind: "links-to",
      zIndex: 0,
      type: "line",
    })),
  };
}

const at = (sim: ReturnType<typeof createGraphSimulation>, id: string): Point =>
  sim?.positions().get(id) as Point;

const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

describe("graph dynamics", () => {
  it("returns null for an empty graph", () => {
    expect(createGraphSimulation({ nodes: [], edges: [] })).toBeNull();
  });

  it("moves a single node in layout units", () => {
    const sim = createGraphSimulation(graph([{ id: "a", x: 10, y: 20 }]));
    expect(sim).not.toBeNull();
    const before = at(sim, "a");
    sim?.tick();
    const after = at(sim, "a");
    expect(after).not.toEqual(before);
    expect(Number.isFinite(after.x)).toBe(true);
    expect(Number.isFinite(after.y)).toBe(true);
  });

  it("pins and releases a dragged node", () => {
    const sim = createGraphSimulation(graph([{ id: "a", x: 10, y: 20 }]));
    sim?.pin("a", { x: 5, y: 6 });
    sim?.tick();
    expect(at(sim, "a")).toEqual({ x: 5, y: 6 });
    sim?.release("a");
    sim?.tick();
    const after = at(sim, "a");
    expect(after).not.toEqual({ x: 5, y: 6 });
    expect(Number.isFinite(after.x)).toBe(true);
    expect(Number.isFinite(after.y)).toBe(true);
  });

  it("is a no-op to pin or release an id it does not have", () => {
    const sim = createGraphSimulation(graph([{ id: "a", x: 0, y: 0 }]));
    expect(() => {
      sim?.pin("missing", { x: 1, y: 1 });
      sim?.release("missing");
      sim?.tick();
    }).not.toThrow();
    expect(at(sim, "a")).toBeDefined();
  });

  it("treats drag movement as deterministic", () => {
    const make = () => {
      const sim = createGraphSimulation(graph([{ id: "a", x: 10, y: 20 }]));
      sim?.pin("a", { x: 1, y: 2 });
      for (let i = 0; i < 3; i++) sim?.tick();
      return sim?.positions();
    };
    expect(make()).toEqual(make());
  });

  it("reports a position for every node, as a fresh map each call", () => {
    const sim = createGraphSimulation(graph([{ id: "a", x: 0, y: 0 }, { id: "b", x: 1, y: 1 }]));
    sim?.tick();
    expect(sim?.positions().size).toBe(2);
    expect(sim?.positions().get("a")).toBeDefined();
    expect(sim?.positions().get("b")).toBeDefined();
    // Two reads must not alias the same map.
    expect(sim?.positions()).not.toBe(sim?.positions());
  });

  it("warm-starts from initial positions and falls back for ids it lacks", () => {
    const sim = createGraphSimulation(
      graph([{ id: "a", x: 100, y: 100 }, { id: "b", x: 200, y: 200 }]),
      new Map([["a", { x: 3, y: 4 }]]),
    );
    expect(at(sim, "a")).toEqual({ x: 3, y: 4 });
    // `b` has no warm position, so it keeps the laid-out one.
    expect(at(sim, "b")).toEqual({ x: 200, y: 200 });
  });

  it("refuses non-finite warm-start coordinates", () => {
    const sim = createGraphSimulation(
      graph([{ id: "a", x: 100, y: 100 }]),
      new Map([["a", { x: NaN, y: NaN }]]),
    );
    // Both poisoned coordinates fall back to the laid-out ones.
    expect(at(sim, "a")).toEqual({ x: 100, y: 100 });
  });

  it("separates two exactly-coincident nodes (the §7.2 freeze)", () => {
    const sim = createGraphSimulation(graph([{ id: "a", x: 0, y: 0 }, { id: "b", x: 0, y: 0 }]));
    expect(distance(at(sim, "a"), at(sim, "b"))).toBe(0);
    for (let i = 0; i < 30; i++) sim?.tick();
    // They must move apart, not freeze on top of each other.
    expect(distance(at(sim, "a"), at(sim, "b"))).toBeGreaterThan(0);
  });

  it("breaks the vertical-line freeze for nodes sharing an x", () => {
    // The retired viewer's exact failure: two nodes on the same x, pushed only
    // vertically, never able to spread horizontally.
    const sim = createGraphSimulation(graph([{ id: "a", x: 0, y: 10 }, { id: "b", x: 0, y: -10 }]));
    const x0 = at(sim, "a").x;
    for (let i = 0; i < 120; i++) sim?.tick();
    // The x of at least one node must have diverged from the shared 0.
    expect(at(sim, "a").x).not.toBe(x0);
    expect(at(sim, "b").x).not.toBe(0);
  });

  it("pulls two connected nodes toward their rest distance", () => {
    // `c` is deliberately isolated, so the link loop also walks its "not an
    // endpoint" branch without disturbing the a–b assertion.
    const sim = createGraphSimulation(
      graph(
        [{ id: "a", x: 0, y: 0 }, { id: "b", x: 500, y: 0 }, { id: "c", x: 250, y: 300 }],
        [{ source: "a", target: "b" }],
      ),
    );
    const before = distance(at(sim, "a"), at(sim, "b"));
    for (let i = 0; i < 30; i++) sim?.tick();
    const after = distance(at(sim, "a"), at(sim, "b"));
    expect(after).toBeLessThan(before);
  });

  it("separates two coincident *connected* nodes via the link jiggle", () => {
    const sim = createGraphSimulation(
      graph([{ id: "a", x: 0, y: 0 }, { id: "b", x: 0, y: 0 }], [{ source: "a", target: "b" }]),
    );
    for (let i = 0; i < 30; i++) sim?.tick();
    expect(distance(at(sim, "a"), at(sim, "b"))).toBeGreaterThan(0);
  });

  it("drops a link whose endpoint is not in the graph", () => {
    // A malformed edge (a→z with no node z) must not poison the simulation:
    // the filter discards it and the remaining node simply drifts under
    // centre-gravity.
    const sim = createGraphSimulation(graph([{ id: "a", x: 0, y: 0 }], [{ source: "a", target: "z" }]));
    expect(sim).not.toBeNull();
    expect(() => {
      for (let i = 0; i < 5; i++) sim?.tick();
    }).not.toThrow();
    expect(Number.isFinite(at(sim, "a").x)).toBe(true);
  });

  it("keeps a pinned node fixed even with a coincident neighbour", () => {
    const sim = createGraphSimulation(graph([{ id: "a", x: 0, y: 0 }, { id: "b", x: 0, y: 0 }]));
    sim?.pin("a", { x: 7, y: 8 });
    for (let i = 0; i < 30; i++) sim?.tick();
    // The pinned node never moves; the neighbour does all the separating.
    expect(at(sim, "a")).toEqual({ x: 7, y: 8 });
  });
});
