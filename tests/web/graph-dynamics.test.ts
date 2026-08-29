import { describe, expect, it } from "vitest";
import { createGraphSimulation } from "../../src/web/client/graph/dynamics";
import type { GraphSimulation } from "../../src/web/client/graph/dynamics";
import { renderGraph } from "../../src/web/client/graph/graph.model";
import type { RenderGraph } from "../../src/web/client/graph/graph.model";
import { COLLIDE_RADIUS, computeLayout, type Point } from "../../src/web/shared/layout";
import { bbox } from "../../src/web/shared/metrics";
import { repoLikeGraph, siblingBlobsGraph } from "../fixtures/graphShapes";

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

const at = (sim: GraphSimulation | null, id: string): Point => sim?.positions().get(id) as Point;

const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Tick until the engine sleeps (the component's clock does the same). */
const settle = (sim: GraphSimulation | null, max = 4000): number => {
  let ticks = 0;
  while (sim?.awake() && ticks < max) {
    sim.tick();
    ticks++;
  }
  return ticks;
};

/** Largest any node moved between two position snapshots. */
const displacement = (before: Map<string, Point>, after: Map<string, Point>): number => {
  let max = 0;
  for (const [id, p] of after) {
    const q = before.get(id);
    if (q) max = Math.max(max, Math.hypot(p.x - q.x, p.y - q.y));
  }
  return max;
};

describe("graph dynamics — branch anchors (the live half)", () => {
  it("holds the separated equilibrium the static layout settled into", () => {
    // The engine's gravity targets are the branch ring, so mounting the live
    // sim over an already-separated layout cannot glide it back toward one
    // centre — the failure that made the static and live paths diverge before
    // they shared one physics.
    const model = siblingBlobsGraph();
    const positions = computeLayout(model, { ticks: 300, seed: 1 });
    const rendered = renderGraph(model.nodes, model.edges, positions, "dark");
    const sim = createGraphSimulation(rendered)!;
    settle(sim);

    const after = sim.positions();
    const members = (match: (id: string) => boolean): Point[] =>
      model.nodes.filter((n) => match(n.id)).map((n) => after.get(n.id)!);
    const blobs = [
      members((id) => id === "module:summaries" || id.startsWith("file:summaries/")),
      members((id) => id === "module:src" || id.startsWith("module:src/")),
      members((id) => id === "vfolder:sessions" || id.startsWith("note:session-")),
    ];
    for (let i = 0; i < blobs.length; i++) {
      for (let j = i + 1; j < blobs.length; j++) {
        const a = bbox(blobs[i]!);
        const b = bbox(blobs[j]!);
        const dx = Math.max(b.minX - a.maxX, a.minX - b.maxX, 0);
        const dy = Math.max(b.minY - a.maxY, a.minY - b.maxY, 0);
        expect(Math.hypot(dx, dy), `blob ${i} vs ${j}`).toBeGreaterThan(2 * COLLIDE_RADIUS);
      }
    }
  });
});

describe("graph dynamics", () => {
  it("returns null for an empty graph", () => {
    expect(createGraphSimulation({ nodes: [], edges: [] })).toBeNull();
  });

  it("lets an isolated node rest toward the origin, then stay put", () => {
    // The canonical forces carry centre gravity (`forceX()`/`forceY()`), so an
    // isolated node drifts gently toward the origin — d3's own resting place —
    // and freezes when the alpha floor is reached. No perpetual motion: the
    // old bespoke sim kept everything "gently moving" forever.
    const sim = createGraphSimulation(graph([{ id: "a", x: 10, y: 20 }]))!;
    const before = Math.hypot(at(sim, "a").x, at(sim, "a").y);
    let ticks = 0;
    while (sim.awake() && ticks < 4000) {
      sim.tick();
      ticks++;
    }
    const after = at(sim, "a");
    expect(Number.isFinite(after.x)).toBe(true);
    expect(Math.hypot(after.x, after.y)).toBeLessThan(before);
    // Asleep: settled for good.
    const frozen = at(sim, "a");
    for (let i = 0; i < 100; i++) sim.tick();
    expect(Math.hypot(at(sim, "a").x - frozen.x, at(sim, "a").y - frozen.y)).toBeLessThan(0.5);
  });

  it("pins and releases a dragged node", () => {
    const sim = createGraphSimulation(graph([{ id: "a", x: 10, y: 20 }]))!;
    sim?.pin("a", { x: 5, y: 6 });
    sim?.tick();
    expect(at(sim, "a")).toEqual({ x: 5, y: 6 });
    sim?.release("a");
    sim?.tick();
    const after = at(sim, "a");
    expect(Number.isFinite(after.x)).toBe(true);
    expect(Number.isFinite(after.y)).toBe(true);
    // The anchor retargets to the drop point, so the node stays put.
    expect(distance(after, { x: 5, y: 6 })).toBeLessThan(1);
  });

  it("is a no-op to pin or release an id it does not have", () => {
    const sim = createGraphSimulation(graph([{ id: "a", x: 0, y: 0 }]))!;
    expect(() => {
      sim?.pin("missing", { x: 1, y: 1 });
      sim?.release("missing");
      sim?.tick();
    }).not.toThrow();
    expect(at(sim, "a")).toBeDefined();
  });

  it("treats drag movement as deterministic", () => {
    const make = () => {
      const sim = createGraphSimulation(graph([{ id: "a", x: 10, y: 20 }, { id: "b", x: 30, y: 40 }]))!;
      sim?.pin("a", { x: 1, y: 2 });
      for (let i = 0; i < 3; i++) sim?.tick();
      return sim?.positions();
    };
    expect(make()).toEqual(make());
  });

  it("reports a position for every node, as a fresh map each call", () => {
    const sim = createGraphSimulation(graph([{ id: "a", x: 0, y: 0 }, { id: "b", x: 1, y: 1 }]))!;
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
    )!;
    expect(at(sim, "a")).toEqual({ x: 3, y: 4 });
    // `b` has no warm position, so it keeps the laid-out one.
    expect(at(sim, "b")).toEqual({ x: 200, y: 200 });
  });

  it("refuses non-finite warm-start coordinates", () => {
    const sim = createGraphSimulation(
      graph([{ id: "a", x: 100, y: 100 }]),
      new Map([["a", { x: NaN, y: NaN }]]),
    )!;
    // Both poisoned coordinates fall back to the laid-out ones.
    expect(at(sim, "a")).toEqual({ x: 100, y: 100 });
  });

  it("separates two exactly-coincident nodes (the §7.2 freeze)", () => {
    const sim = createGraphSimulation(graph([{ id: "a", x: 0, y: 0 }, { id: "b", x: 0, y: 0 }]))!;
    expect(distance(at(sim, "a"), at(sim, "b"))).toBe(0);
    for (let i = 0; i < 30; i++) sim.tick();
    // They must move apart, not freeze on top of each other.
    expect(distance(at(sim, "a"), at(sim, "b"))).toBeGreaterThan(0);
  });

  it("breaks the vertical-line freeze for nodes sharing an x", () => {
    // The retired viewer's exact failure: two nodes on the same x, pushed only
    // vertically, never able to spread horizontally.
    const sim = createGraphSimulation(graph([{ id: "a", x: 0, y: 10 }, { id: "b", x: 0, y: -10 }]))!;
    for (let i = 0; i < 120; i++) sim.tick();
    // The x of at least one node must have diverged from the shared 0.
    expect(at(sim, "a").x).not.toBe(0);
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
    )!;
    const before = distance(at(sim, "a"), at(sim, "b"));
    for (let i = 0; i < 30; i++) sim.tick();
    const after = distance(at(sim, "a"), at(sim, "b"));
    expect(after).toBeLessThan(before);
  });

  it("separates two coincident *connected* nodes via the link jiggle", () => {
    const sim = createGraphSimulation(
      graph([{ id: "a", x: 0, y: 0 }, { id: "b", x: 0, y: 0 }], [{ source: "a", target: "b" }]),
    )!;
    for (let i = 0; i < 30; i++) sim.tick();
    expect(distance(at(sim, "a"), at(sim, "b"))).toBeGreaterThan(0);
  });

  it("drops a link whose endpoint is not in the graph", () => {
    // A malformed edge (a→z with no node z) must not poison the simulation.
    const sim = createGraphSimulation(graph([{ id: "a", x: 0, y: 0 }], [{ source: "a", target: "z" }]))!;
    expect(sim).not.toBeNull();
    expect(() => {
      for (let i = 0; i < 5; i++) sim?.tick();
    }).not.toThrow();
    expect(Number.isFinite(at(sim, "a").x)).toBe(true);
  });

  it("keeps a pinned node fixed even with a coincident neighbour", () => {
    const sim = createGraphSimulation(graph([{ id: "a", x: 0, y: 0 }, { id: "b", x: 0, y: 0 }]))!;
    sim?.pin("a", { x: 7, y: 8 });
    for (let i = 0; i < 30; i++) sim.tick();
    // The pinned node never moves; the neighbour does all the separating.
    expect(at(sim, "a")).toEqual({ x: 7, y: 8 });
  });

  it("goes to sleep when settled and stays frozen", () => {
    const sim = createGraphSimulation(graph([{ id: "a", x: 0, y: 0 }, { id: "b", x: 300, y: 0 }]))!;
    // The settle re-heat runs out: the clock may then sleep.
    let ticks = 0;
    while (sim.awake() && ticks < 4000) {
      sim.tick();
      ticks++;
    }
    expect(sim.awake()).toBe(false);
    const settled = sim.positions();
    for (let i = 0; i < 600; i++) sim.tick();
    // Sub-pixel stillness at usable zoom: d3 keeps integrating at the alpha
    // floor, but the drift per second is a fraction of a layout unit — and the
    // clock is asleep, so no frame is spent on it (the retired live sim
    // sloshed forever at 60 fps).
    expect(displacement(settled, sim.positions())).toBeLessThan(4);
  });

  it("wakes a sleeping engine when a drag pins a node", () => {
    const sim = createGraphSimulation(graph([{ id: "a", x: 0, y: 0 }, { id: "b", x: 300, y: 0 }]))!;
    let ticks = 0;
    while (sim?.awake() && ticks < 4000) {
      sim.tick();
      ticks++;
    }
    expect(sim.awake()).toBe(false);
    sim?.pin("a", { x: 50, y: 50 });
    expect(sim?.awake()).toBe(true);
  });

  it("does not migrate a laid-out graph (the huge-circle regression)", () => {
    // The bespoke live sim had its own equilibrium: a graph mounted from the
    // static layout visibly re-laid itself over ~30 s (a 215-node repo graph
    // migrated ~1200 → ~300 units) and never stopped moving. The live sim now
    // shares the layout's exact forces, so a warm start is already at
    // equilibrium: settling must move nothing at cluster scale.
    const fixture = repoLikeGraph();
    const layout = computeLayout(fixture, { ticks: 300 });
    const nodes = fixture.nodes.map((n) => ({ ...n, ...layout.get(n.id)! }));
    const sim = createGraphSimulation(graph(nodes, fixture.edges.map((e) => ({ source: e.source, target: e.target }))))!;
    const warm = sim.positions();
    let ticks = 0;
    while (sim.awake() && ticks < 4000) {
      sim.tick();
      ticks++;
    }
    // Bounded by geometry, not tuned to this run: the whole settle may not
    // move any node further than a few collision diameters — a local breathe,
    // not a re-layout.
    expect(displacement(warm, sim.positions())).toBeLessThan(6 * 2 * COLLIDE_RADIUS);
  });
});