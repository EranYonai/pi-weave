/**
 * Force-directed layout: `GraphModel` → `Map<id, Point>` (weave-workspace §7).
 *
 * Isomorphic by contract (§2 tier table): this module runs in Node — the
 * server precomputes positions for `GraphPayload.positions`, and the dynamics
 * gate exercises it headless — and in the browser, where the client re-runs it
 * on drag and expand/collapse. It therefore imports **only** `d3-force` and
 * the wire DTOs from `./graph`. No `node:*`, no DOM, no `src/pi`, no
 * `src/core`.
 *
 * It used to take its graph types from `src/core/graph/model` as `import
 * type`. That was legal under the §2 table and still wrong: §7.1 has
 * `src/web/client/graph/project.ts` consuming this module, and the day that
 * lands, resolving a core type would drag the whole `node:fs`-flavoured core
 * type graph into `tsconfig.web.json` — the identical failure `wire.ts` hit.
 * Fixed here pre-emptively rather than left as a tripwire for P3.
 *
 * ## The recipe — d3's own force-directed tree, not ours
 *
 * This module used to carry ~250 lines of derived geometry: a ring-radius
 * formula per hub fan-out, hash-angled seed rings, a disc-packed root ring,
 * and seed-anchored gravity. All of it existed to shape a force simulation
 * into a readable tree. d3's own force-directed-tree example does that in five
 * lines:
 *
 * ```js
 * const root = d3.hierarchy(data);
 * const links = root.links();
 * const nodes = root.descendants();
 *
 * const simulation = d3.forceSimulation(nodes)
 *     .force("link", d3.forceLink(links).id(d => d.id).distance(0).strength(1))
 *     .force("charge", d3.forceManyBody().strength(-50))
 *     .force("x", d3.forceX())
 *     .force("y", d3.forceY());
 * ```
 *
 * The containment tree wants children at their parent with full strength, and
 * the picture emerges from gentle repulsion and collision. The property that
 * matters: a tree's radius is set by its **depth**, not by any single node's
 * fan-out — a 188-child directory shares the angular space with its siblings
 * instead of defining a ring that the whole graph has to fit inside. That is
 * why the retired ring-radius family (`ringRadius`, `RING_CAP`,
 * `seedPositions`, `clusterGap`, `rootRingRadius`, `arcShare`, `rootAngles`
 * and the seed-anchored gravity) is deleted rather than tuned: it was a wheel
 * d3 already ships.
 *
 * Two deviations from the example, both stated rather than hidden:
 *
 * 1. **`forceCollide`** — the example draws 3.5-pixel dots with no labels; we
 *    draw 9-unit nodes with zoomed labels, so nodes keep a collision radius
 *    (`NODE_RADIUS + label room`) and siblings never overlap.
 * 2. **Relation edges** (`links-to` / `mentions`) are not part of the tree.
 *    They ride along at a longer distance and a fraction of the strength, so
 *    they decorate the structure instead of distorting it.
 *
 * `forceX()`/`forceY()` (d3 defaults: target 0, no accessor) replace the
 * seed-anchored gravity — they pull every component toward the origin, which
 * is the no-component-escapes-to-infinity guarantee the anchors existed for,
 * and they mean a released drag needs no anchor bookkeeping at all.
 *
 * ## Why d3-force (§7.2)
 *
 * The retired simulation collapsed to a vertical line because repulsion and
 * collision derive their direction as `dx / d`: once two nodes share an `x`,
 * the x-component of the push is exactly zero forever, and damping freezes it
 * there. d3-force injects `jiggle()` on exactly that zero (`manyBody.js`,
 * `collide.js`, `link.js`), drawn from a **seeded** LCG — so we get symmetry
 * breaking *and* reproducibility, which is what makes §8 a stable CI gate
 * rather than a flaky one. d3 also fills nodes without positions on a
 * deterministic phyllotaxis spiral, so cold starts need no invented seeding.
 */

import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3-force";
import type { Simulation, SimulationLinkDatum, SimulationNodeDatum } from "d3-force";
import type { WireEdgeKind as EdgeKind, WireGraphEdge as GraphEdge, WireGraphModel as GraphModel } from "./graph";
import type { Point } from "./metrics";

export type { Point } from "./metrics";

export interface LayoutOptions {
  /** Simulation steps. Alpha decay is derived from this, so the budget stays meaningful. Default 300. */
  ticks?: number;
  /** Seeds d3's jiggle LCG. Default 1. */
  seed?: number;
  /**
   * Warm-start positions by node id. The client passes current positions when
   * re-running after a drag or an expand so the graph does not jump; the
   * dynamics gate passes coincident points to prove symmetry breaking. Ids
   * absent here start on d3's own deterministic phyllotaxis spiral.
   */
  initial?: ReadonlyMap<string, Point>;
  /**
   * Hold the warm-started nodes in place while the simulation integrates the
   * newcomers (d3's `fx`/`fy`). The collapse/expand pattern: an expand must
   * hand its new children to the layout without shoving everything else out
   * of the way — the existing arrangement is the user's, and the collide
   * force packs the newcomers around it. Ignored without `initial`.
   */
  pinWarm?: boolean;
}

/** Visual node radius in layout units. The renderer must not draw larger than this. */
export const NODE_RADIUS = 9;

/** Collision radius: the node plus breathing room for the leading edge of its label. */
export const COLLIDE_RADIUS = NODE_RADIUS + 9;

/** `links-to` / `mentions` are associative, not structural: longer and weak. */
const RELATION_DISTANCE = 220;

/** Relation edges pull at a fraction of the containment link's strength — decoration, not structure. */
const RELATION_STRENGTH = 0.05;

/** Body repulsion — the force-directed-tree example's own value. */
const CHARGE_STRENGTH = -50;

/**
 * The containment tree's spring: rest length and stiffness.
 *
 * The example's `distance(0).strength(1)` is rigid — correct for 3.5-pixel
 * dots with no collide, and violent here: with a collision radius and a
 * 189-child hub, dragging the hub yanked every child at full strength and the
 * whole tree thrashed (measured: >9000 units of other-node motion per tick on
 * this repository's real graph). Springs with real rest length and low
 * stiffness keep every drag a local ripple while collide still packs the
 * cluster; the shape stays a tree because every node is *in* the tree, not
 * because the links are rigid.
 */
const CONTAINS_REST = 90;
const CONTAINS_STRENGTH = 0.02;

const DEFAULT_TICKS = 300;
const DEFAULT_SEED = 1;

/** d3-force's own alpha floor (`simulation.js`); mirrored so `alphaDecay` can be derived from `ticks`. */
const ALPHA_MIN = 0.001;

interface SimNode extends SimulationNodeDatum {
  id: string;
  x?: number;
  y?: number;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  source: string | SimNode;
  target: string | SimNode;
  kind: EdgeKind;
}

/** Containment edges define the hierarchy; everything else is an association. */
export function isContainment(kind: EdgeKind): boolean {
  return kind === "contains" || kind === "anchored-at";
}

/**
 * d3-force's LCG (`lcg.js`: a = 1664525, c = 1013904223, m = 2³²), re-exposed
 * so `seed` actually selects a stream — d3 always builds its own with s = 1,
 * and `simulation.randomSource()` is the documented way to replace it.
 */
export function lcg(seed: number): () => number {
  let s = Math.trunc(seed) >>> 0;
  return () => (s = (1664525 * s + 1013904223) % 4294967296) / 4294967296;
}

interface Structure {
  /** Ids in `model.nodes` order, deduped. */
  ids: string[];
  /** Edges with both endpoints present, no self-loops, deduped. */
  edges: GraphEdge[];
}

/**
 * Normalise the model into something a simulation can consume: drop self-edges
 * and edges pointing at ids that are not nodes (d3's `forceLink` throws on
 * those), and dedupe. Malformed input is the caller's bug, but it must not be
 * the layout's crash.
 */
function analyse(model: GraphModel): Structure {
  const ids: string[] = [];
  const known = new Set<string>();
  for (const n of model.nodes) {
    if (known.has(n.id)) continue;
    known.add(n.id);
    ids.push(n.id);
  }

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const e of model.edges) {
    if (e.source === e.target) continue;
    if (!known.has(e.source) || !known.has(e.target)) continue;
    const key = `${e.source}\u0000${e.target}\u0000${e.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push(e);
  }
  return { ids, edges };
}

/**
 * Lay a graph out. Deterministic: the same model with the same `seed` produces
 * byte-identical output, in Node or the browser.
 *
 * The simulation is stepped **synchronously** — `stop()` then a manual `tick()`
 * loop — so it never touches `requestAnimationFrame` and works headless.
 * Warm ids keep their positions; ids without one start on d3's deterministic
 * phyllotaxis spiral, which is why a cold start needs no invented seeding.
 */
export function computeLayout(model: GraphModel, options: LayoutOptions = {}): Map<string, Point> {
  const ticks = Math.max(0, Math.trunc(options.ticks ?? DEFAULT_TICKS));
  const seed = options.seed ?? DEFAULT_SEED;

  const { ids, edges } = analyse(model);
  const out = new Map<string, Point>();
  if (ids.length === 0) return out;

  const warm = options.initial;
  const nodes: SimNode[] = ids.map((id) => {
    const at = warm?.get(id);
    const node: SimNode = { id, vx: 0, vy: 0 };
    if (at !== undefined && Number.isFinite(at.x) && Number.isFinite(at.y)) {
      node.x = at.x;
      node.y = at.y;
      if (options.pinWarm === true) {
        node.fx = at.x;
        node.fy = at.y;
      }
    }
    return node;
  });

  if (nodes.length > 1) {
    runSimulation(nodes, edges, { ticks, seed, warm: warm !== undefined });
  }
  // A pinned run leaves the pins behind; clear them so the returned map is
  // positions, not a promise to keep standing there forever.
  if (options.pinWarm === true) for (const n of nodes) { n.fx = null; n.fy = null; }

  for (const n of nodes) {
    // Guarded on the way out as well as in: the contract is that no caller
    // ever receives a NaN. d3 fills every node during `initialize`, so the
    // fallback is unreachable in practice — but the contract is the contract.
    out.set(n.id, { x: Number.isFinite(n.x as number) ? (n.x as number) : 0, y: Number.isFinite(n.y as number) ? (n.y as number) : 0 });
  }
  return out;
}

export interface ForceSimulationOptions<N> {
  nodes: N[];
  /** String endpoints are resolved by node id; dangling ids must be filtered out by the caller. */
  links: Array<{ source: string | N; target: string | N; kind: EdgeKind }>;
  /**
   * Per-node `forceX`/`forceY` targets, re-read every tick. Absent (or an id
   * missing from the map) targets the origin — d3's own default — which is the
   * no-component-escapes guarantee. A live driver mutates the map on drag
   * release so a dropped node rests where the user put it.
   */
  anchors?: ReadonlyMap<string, Point>;
  /** Seeds d3's jiggle LCG. Default 1 — deterministic in Node and browser. */
  seed?: number;
}

/**
 * The force configuration, as ONE definition shared by the static layout
 * ({@link computeLayout}) and the live driver (`dynamics.ts`).
 *
 * It is d3's force-directed-tree recipe: the containment tree holds children
 * at their parent with full strength, and the arrangement emerges from gentle
 * repulsion and collision; `forceX()`/`forceY()` pull every component toward
 * the origin at d3's default strength, so nothing drifts to infinity.
 *
 * The forces live here once so the static and live equilibria cannot diverge:
 * whatever the static layout settles to is exactly what the live sim holds.
 * The simulation is returned stopped; the driver owns the alpha policy — the
 * static path decays to the alpha floor over its tick budget, the live path
 * re-heats on interaction and sleeps when the floor is reached. Velocity
 * decay stays at d3's own default, exactly like the example.
 */
export function createForceSimulation<
  N extends SimulationNodeDatum & { id: string },
>(opts: ForceSimulationOptions<N>): Simulation<N, undefined> {
  const link = forceLink<N, { source: string | N; target: string | N; kind: EdgeKind }>(opts.links)
    .id((n) => n.id)
    .distance((l) => (isContainment(l.kind) ? CONTAINS_REST : RELATION_DISTANCE))
    .strength((l) => (isContainment(l.kind) ? CONTAINS_STRENGTH : RELATION_STRENGTH))
    .iterations(2);

  return forceSimulation<N>(opts.nodes)
    .randomSource(lcg(opts.seed ?? DEFAULT_SEED))
    .force("charge", forceManyBody<N>().strength(CHARGE_STRENGTH))
    .force("link", link)
    .force("collide", forceCollide<N>(COLLIDE_RADIUS).strength(1).iterations(3))
    .force("x", forceX<N>((n) => opts.anchors?.get(n.id)?.x ?? 0))
    .force("y", forceY<N>((n) => opts.anchors?.get(n.id)?.y ?? 0))
    .stop();
}

/** Configure and step the d3 simulation in place. Mutates `nodes`. */
function runSimulation(nodes: SimNode[], edges: readonly GraphEdge[], opts: { ticks: number; seed: number; warm: boolean }): void {
  const links: SimLink[] = edges.map((e) => ({ source: e.source, target: e.target, kind: e.kind }));
  const sim = createForceSimulation({ nodes, links, seed: opts.seed });
  sim
    // A cold start assembles from d3's phyllotaxis at full alpha; a warm start
    // relaxes what is already on screen — d3's own re-heat value — so the
    // graph does not re-arrange itself under the user on every expand.
    .alpha(opts.warm ? 0.3 : 1)
    .alphaMin(ALPHA_MIN)
    // Reach the same convergence at whatever tick budget the caller asked for.
    // Velocity decay stays at d3's own default — the example sets neither.
    .alphaDecay(opts.ticks > 0 ? 1 - Math.pow(ALPHA_MIN, 1 / opts.ticks) : 0);

  for (let i = 0; i < opts.ticks; i++) sim.tick();
}