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
 * ## Why d3-force (§7.2)
 *
 * The retired simulation collapsed to a vertical line because repulsion and
 * collision derive their direction as `dx / d`: once two nodes share an `x`,
 * the x-component of the push is exactly zero forever, gravity pins x to W/2,
 * and damping freezes it there. d3-force injects `jiggle()` on exactly that
 * zero (`manyBody.js`, `collide.js`, `link.js`), drawn from a **seeded** LCG —
 * so we get symmetry breaking *and* reproducibility, which is what makes §8 a
 * stable CI gate rather than a flaky one.
 *
 * ## The four failure mechanisms, and what answers each
 *
 * | Mechanism                     | Answer here                                 |
 * | ----------------------------- | ------------------------------------------- |
 * | zero-direction repulsion      | d3's `jiggle`, in all three forces           |
 * | children seeded at the parent | {@link seedPositions} — hash-derived ring    |
 * | gravity pinning x to W/2      | `forceX`/`forceY` at 0.03 — positions, never pins |
 * | hub leaves crushed to a line  | ring-sized `contains` distance (below)       |
 *
 * ## Ring sizing — the one non-obvious formula
 *
 * A parent with `k` containment children wants those children on a ring. For
 * them to sit `RING_SPACING` apart without the collision force fighting the
 * link force, the ring's circumference must be at least `RING_SPACING * k`, so
 * its radius must be at least `RING_SPACING * k / 2π`. That is
 * {@link ringRadius}, and it is why a 60-child hub gets a ~380 unit link
 * distance while a 3-child node gets the 70 unit floor. Hairballs are a
 * *geometry* problem, not a tuning problem.
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
  /** Viewport width; the layout is centred on it. Default 1280. */
  width?: number;
  /** Viewport height; the layout is centred on it. Default 800. */
  height?: number;
  /**
   * Warm-start positions by node id. The client passes current positions when
   * re-running after a drag or an expand so the graph does not jump; the
   * dynamics gate passes coincident points to prove symmetry breaking. Ids
   * absent here fall back to {@link seedPositions}.
   */
  initial?: ReadonlyMap<string, Point>;
}

/** Visual node radius in layout units. The renderer must not draw larger than this. */
export const NODE_RADIUS = 9;

/** Collision radius: the node plus breathing room for the leading edge of its label. */
export const COLLIDE_RADIUS = NODE_RADIUS + 9;

/** Target arc between two siblings on a parent's ring — a collision diameter plus margin. */
const RING_SPACING = 2 * COLLIDE_RADIUS + 4;

/** Shortest a `contains` edge ever gets, for parents with one or two children. */
export const CONTAINS_DISTANCE = 70;

/** `links-to` / `mentions` are associative, not structural: longer and weaker. */
const RELATION_DISTANCE = 220;

/** Relation edges pull at this fraction of a containment edge's strength. */
const RELATION_STRENGTH_SCALE = 0.35;

/**
 * Clearance between the outer rings of two adjacent top-level clusters.
 *
 * Derived from Gestalt proximity, not chosen: a boundary only reads as a
 * boundary if it is emptier than anything *inside* a cluster. The largest
 * empty span within any cluster is the annulus between a hub and its own ring,
 * i.e. `max ringRadius(k)` over the roots — so the inter-cluster gap must be
 * at least that. This is why the gap scales with the graph (a 60-child hub
 * pushes its neighbours further away than a 3-child node does) instead of
 * being a pixel constant that would be wrong at either extreme.
 */
function clusterGap(roots: readonly string[], children: ReadonlyMap<string, string[]>): number {
  let widest = CONTAINS_DISTANCE;
  for (const id of roots) {
    const r = ringRadius(children.get(id)?.length ?? 0);
    if (r > widest) widest = r;
  }
  return widest;
}

/** Body repulsion. Negative is repulsive; scaled up from d3's -30 for our node sizes. */
const CHARGE_STRENGTH = -180;

/**
 * Gravity is **seed-anchored**, not centre-anchored, and that is a deliberate
 * correction of the third failure mechanism rather than a style preference.
 *
 * `forceX(W/2)` accelerates a node by `(W/2 - x)·s·α`, which grows *linearly*
 * with distance, while repulsion falls off as `1/d`. Past a few hundred units
 * centre-gravity therefore wins by orders of magnitude and drags every cluster
 * back onto the middle — measured here as a five-root separation collapsing
 * from 562 to 269 units between seeding and settling. "Gravity pins x to W/2"
 * is the post-mortem's own wording; a weak constant does not fix it, because
 * the problem is the *shape* of the term, not its coefficient.
 *
 * Anchoring each node to its own seeded slot keeps the restoring force bounded
 * by how far that node has actually moved, which is small. It still guarantees
 * no component escapes to infinity — the property centre-gravity was there for
 * — and it additionally makes re-runs stable, which the client needs on drag
 * and expand/collapse (§7.3).
 */
const ANCHOR_ROOT = 0.10;

/**
 * Non-roots are anchored an order of magnitude more weakly than roots: their
 * placement is the simulation's job, and at 0.02 this is 50× weaker than the
 * strength-1 link holding a leaf to its parent, so it bounds drift without
 * competing with the structure.
 */
const ANCHOR_CHILD = 0.02;

/** Fraction of velocity retained per tick. Below d3's 0.6 default: we want settling, not motion. */
const VELOCITY_DECAY = 0.4;

const DEFAULT_TICKS = 300;
const DEFAULT_SEED = 1;
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;

/** d3-force's own alpha floor (`simulation.js`); mirrored so `alphaDecay` can be derived from `ticks`. */
const ALPHA_MIN = 0.001;

const TAU = Math.PI * 2;

/**
 * Rotation applied to the root ring. Without it the accumulator starts at
 * angle 0 and a two-root graph lands at 90° and 270° — a vertical pair in a
 * landscape viewport. A quarter turn back puts the first boundary on the
 * horizontal, so few-root graphs spread along the wide axis.
 */
const ROOT_RING_PHASE = -Math.PI / 2;

interface SimNode extends SimulationNodeDatum {
  id: string;
  x: number;
  y: number;
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
 * FNV-1a (32-bit) followed by MurmurHash3's `fmix32` avalanche.
 *
 * The finalizer is not optional here, and its absence was a real bug caught by
 * the ring assertion. FNV-1a mixes its *low* bits well but its high bits
 * poorly for short, near-identical inputs — and `hashUnit` divides by 2³², so
 * the high bits become the most significant part of the angle. Raw FNV-1a over
 * `leaf001…leaf199` put 199 siblings into six of twelve compass sectors, three
 * of them holding over a third of the ring each. `fmix32` costs four lines and
 * makes every bit depend on every input bit.
 */
export function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** `hashId` folded into [0, 1). `salt` gives an independent stream per id. */
function hashUnit(id: string, salt: number): number {
  return hashId(`${salt}\u0000${id}`) / 0x100000000;
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

/**
 * Radius that fits `k` siblings `RING_SPACING` apart — see the module header.
 *
 * Capped at {@link RING_CAP}: past {@link RING_MAX_FAN} siblings one ring is
 * full, so the distance stops growing and surplus children shell-pack (the
 * collide force spreads them into a disc). Without the cap a 189-child
 * directory asked for a ~1200-unit ring — the whole graph became that ring,
 * and fit-zoom shrank every node to a few pixels. The cap preserves the
 * documented 60-child-hub case exactly: `ringRadius(60)` is unchanged.
 */
export function ringRadius(k: number): number {
  return Math.max(CONTAINS_DISTANCE, Math.min((RING_SPACING * k) / TAU, RING_CAP));
}

/**
 * The largest fan a *single* ring can hold at `RING_SPACING` while staying in
 * the regime the §8 fixture designed for — beyond it, children pack into
 * shells instead of pushing the ring (and with it the whole graph's scale)
 * outward without bound.
 */
export const RING_MAX_FAN = 64;

/** Link-distance ceiling for one hub — `ringRadius(RING_MAX_FAN)`, ~407. */
export const RING_CAP = (RING_SPACING * RING_MAX_FAN) / TAU;

interface Structure {
  /** Ids in `model.nodes` order, deduped. */
  ids: string[];
  /** Containment parent of each child (first winning edge, in edge order). */
  parent: Map<string, string>;
  /** Containment children, in edge order. */
  children: Map<string, string[]>;
  /** Nodes with no containment parent — the cluster anchors. */
  roots: string[];
  /** Edges with both endpoints present, no self-loops, deduped. */
  edges: GraphEdge[];
  /** Degree over that filtered edge set, both directions. */
  degree: Map<string, number>;
}

/**
 * Normalise the model into something a simulation can consume: drop self-edges
 * and edges pointing at ids that are not nodes (d3's `forceLink` throws on
 * those), dedupe, and derive the containment forest. Malformed input is the
 * caller's bug, but it must not be the layout's crash.
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
  const parent = new Map<string, string>();
  const children = new Map<string, string[]>();
  const degree = new Map<string, number>();
  for (const e of model.edges) {
    if (e.source === e.target) continue;
    if (!known.has(e.source) || !known.has(e.target)) continue;
    const key = `${e.source}\u0000${e.target}\u0000${e.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push(e);
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    if (!isContainment(e.kind) || parent.has(e.target)) continue;
    parent.set(e.target, e.source);
    const kids = children.get(e.source);
    if (kids) kids.push(e.target);
    else children.set(e.source, [e.target]);
  }

  // A containment cycle leaves every member parented, so no id in it is a root
  // and none is reachable from one. `seedPositions` sweeps up the survivors.
  const roots = ids.filter((id) => !parent.has(id));
  return { ids, parent, children, roots, edges, degree };
}

/**
 * Arc budget for one cluster: its own diameter plus the inter-cluster gap.
 * Proportional allocation matters here — a 60-child hub and a 3-child node
 * must not receive the same slice of the circle.
 */
function arcShare(id: string, children: ReadonlyMap<string, string[]>, gap: number): number {
  return 2 * ringRadius(children.get(id)?.length ?? 0) + gap;
}

/**
 * Radius of the ring the top-level cluster anchors sit on. Disc-packing on a
 * circle, derived — not tuned.
 *
 * Anchors get arc *proportional to their share* (see {@link seedPositions}),
 * so adjacent anchors i and i+1 are `2π·(sᵢ + sᵢ₊₁) / (2·Σs)` apart and the
 * chord between them is `2R·sin` of half that. Requiring the chord to clear
 * both clusters — exactly `(sᵢ + sᵢ₊₁) / 2`, since each share is a diameter
 * plus the gap — gives R for that pair:
 *
 *   2R·sin(π·s / (2·Σs)) ≥ s / 2   ⇒   R ≥ s / (4·sin(π·s / (2·Σs)))   , s = sᵢ + sᵢ₊₁
 *
 * Take the max over adjacent pairs, wrapping. The sine's argument is at most
 * π/2 (attained only at n = 2, where s = Σs), so it never folds back.
 */
function rootRingRadius(shares: readonly number[], total: number): number {
  let radius = 0;
  shares.forEach((share, i) => {
    const pair = share + (shares[(i + 1) % shares.length] as number);
    const need = pair / (4 * Math.sin((Math.PI * pair) / (2 * total)));
    if (need > radius) radius = need;
  });
  return radius;
}

/**
 * Angles for the root ring: each anchor at the centre of its own arc slice,
 * offset by {@link ROOT_RING_PHASE}, and nudged by a hash so two equal-sized
 * clusters never land on an identical angle after rounding.
 */
function rootAngles(roots: readonly string[], shares: readonly number[], total: number): number[] {
  let acc = 0;
  return shares.map((share, i) => {
    const angle = ROOT_RING_PHASE + TAU * ((acc + share / 2) / total) + (hashUnit(roots[i] as string, 3) - 0.5) * 0.05;
    acc += share;
    return angle;
  });
}

/**
 * Deterministic initial placement (§7.3).
 *
 * Roots are spread around a ring whose arc is allocated in proportion to each
 * cluster's own footprint, so the 60-child hub is not handed the same slice as
 * a 3-child node. Children go on a ring around their parent at ~70 % of the
 * radius the link force will settle them at — near equilibrium, so 300 ticks
 * is plenty — at an angle taken from a **hash of the child's own id**. Never
 * the parent's exact point: exact co-location was one of the four mechanisms
 * behind the retired viewer's vertical line, and a hash is the cheapest way to
 * guarantee two siblings never start on top of each other.
 */
export function seedPositions(model: GraphModel, width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT): Map<string, Point> {
  const { ids, children, roots } = analyse(model);
  const out = new Map<string, Point>();
  const cx = width / 2;
  const cy = height / 2;

  if (roots.length === 1) {
    out.set(roots[0] as string, { x: cx, y: cy });
  } else if (roots.length > 1) {
    const gap = clusterGap(roots, children);
    const shares = roots.map((id) => arcShare(id, children, gap));
    let total = 0;
    for (const s of shares) total += s;
    const ring = rootRingRadius(shares, total);
    const angles = rootAngles(roots, shares, total);
    roots.forEach((id, i) => {
      const angle = angles[i] as number;
      out.set(id, { x: cx + ring * Math.cos(angle), y: cy + ring * Math.sin(angle) });
    });
  }

  // Breadth-first, so a parent always has a point before its children read it.
  const queue = [...roots];
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head]!;
    const kids = children.get(id);
    if (kids === undefined) continue;
    const origin = out.get(id)!;
    const r = 0.7 * ringRadius(kids.length);
    for (const kid of kids) {
      const angle = TAU * hashUnit(kid, 1);
      // 0.85–1.15 of the ring: two ids that collide in angle still differ here.
      const jitter = 0.85 + 0.3 * hashUnit(kid, 2);
      out.set(kid, { x: origin.x + r * jitter * Math.cos(angle), y: origin.y + r * jitter * Math.sin(angle) });
      queue.push(kid);
    }
  }

  // Anything a containment cycle kept out of the BFS still needs a point.
  for (const id of ids) {
    if (out.has(id)) continue;
    const angle = TAU * hashUnit(id, 4);
    const r = CONTAINS_DISTANCE * (1 + hashUnit(id, 5));
    out.set(id, { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
  }
  return out;
}

/**
 * `forceLink` resolves string endpoints into node objects inside its own
 * `initialize`, which runs before the first tick — so by the time the
 * `distance` and `strength` accessors are called, both endpoints are already
 * `SimNode`s. The declared `string | SimNode` union describes only the
 * *pre-initialize* state, so narrowing it at call time would add a branch that
 * can never be taken.
 */

/**
 * Lay a graph out. Deterministic: the same model with the same `seed` produces
 * byte-identical output, in Node or the browser.
 *
 * The simulation is stepped **synchronously** — `stop()` then a manual `tick()`
 * loop — so it never touches `requestAnimationFrame` and works headless.
 */
export function computeLayout(model: GraphModel, options: LayoutOptions = {}): Map<string, Point> {
  const ticks = Math.max(0, Math.trunc(options.ticks ?? DEFAULT_TICKS));
  const seed = options.seed ?? DEFAULT_SEED;
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;

  const { ids, children, edges, degree, roots } = analyse(model);
  const out = new Map<string, Point>();
  if (ids.length === 0) return out;

  const seeds = seedPositions(model, width, height);
  const warm = options.initial;
  const nodes: SimNode[] = ids.map((id) => {
    const fallback = seeds.get(id)!;
    return { id, ...finiteOr(warm?.get(id), fallback), vx: 0, vy: 0 };
  });

  if (nodes.length > 1) {
    runSimulation(nodes, edges, children, degree, seeds, new Set(roots), { ticks, seed });
  }

  for (const n of nodes) {
    // Guarded on the way out as well as in: the contract is that no caller
    // ever receives a NaN, and a seeded fallback is always available.
    out.set(n.id, finiteOr(n, seeds.get(n.id) as Point));
  }
  return out;
}

/**
 * `candidate` when both its coordinates are finite, else `fallback`. Applied to
 * warm-start input and to simulation output, so a poisoned position can neither
 * enter the simulation nor leave it.
 */
function finiteOr(candidate: Point | undefined, fallback: Point): Point {
  if (candidate === undefined) return fallback;
  return {
    x: Number.isFinite(candidate.x) ? candidate.x : fallback.x,
    y: Number.isFinite(candidate.y) ? candidate.y : fallback.y,
  };
}

export interface ForceSimulationOptions<N> {
  nodes: N[];
  /** String endpoints are resolved by node id; dangling ids must be filtered out by the caller. */
  links: Array<{ source: string | N; target: string | N; kind: EdgeKind }>;
  /** Containment children per id — drives the ring-sized link distances. */
  children: ReadonlyMap<string, readonly string[]>;
  /** Degree over the caller's link set, both directions. */
  degree: ReadonlyMap<string, number>;
  /**
   * `forceX`/`forceY` targets by node id. **Re-read every tick**, so a live
   * driver can retarget a released drag without rebuilding the simulation.
   */
  anchors: ReadonlyMap<string, Point>;
  /** Ids anchored at the stronger root strength (§7.3's seed anchoring). */
  rootIds: ReadonlySet<string>;
  /** Seeds d3's jiggle LCG. Default 1 — deterministic in Node and browser. */
  seed?: number;
}

/**
 * The force configuration, as ONE definition shared by the static layout
 * ({@link computeLayout}) and the live driver (`dynamics.ts`).
 *
 * Both used to configure two independent physics. The live one drifted to its
 * own equilibrium — a flat-90-unit link distance versus the ring-sized one —
 * so every graph visibly re-laid itself after mount, and never stopped moving.
 * The forces live here now, once, so their equilibria cannot diverge: whatever
 * the static layout settles to is exactly what the live sim holds.
 *
 * The simulation is returned stopped; the driver owns the alpha policy —
 * the static path decays to {@link ALPHA_MIN} over its tick budget, the live
 * path re-heats on interaction and sleeps when the alpha floor is reached.
 */
export function createForceSimulation<
  N extends SimulationNodeDatum & { id: string },
>(opts: ForceSimulationOptions<N>): Simulation<N, undefined> {
  const childCount = (id: string): number => opts.children.get(id)?.length ?? 0;
  /** Ring geometry is set by whichever endpoint is the fan-out parent. */
  const fanOut = (l: { source: string | N; target: string | N }): number =>
    Math.max(childCount(typeof l.source === "string" ? l.source : l.source.id), childCount(typeof l.target === "string" ? l.target : l.target.id));
  // Every link endpoint is a node with at least this link incident on it, so
  // `degree` always has it and the floor of 1 is arithmetic, not a fallback.
  const deg = (endpoint: string | N): number =>
    opts.degree.get(typeof endpoint === "string" ? endpoint : endpoint.id) as number;
  const anchor = (n: N): number => (opts.rootIds.has(n.id) ? ANCHOR_ROOT : ANCHOR_CHILD);

  const link = forceLink<N, { source: string | N; target: string | N; kind: EdgeKind }>(opts.links)
    .id((n) => n.id)
    .distance((l) => (isContainment(l.kind) ? ringRadius(fanOut(l)) : RELATION_DISTANCE))
    // d3's default `1 / min(degree)` is what stops a degree-60 hub being
    // yanked 60 times a tick. Keep that shape; scale relations down from it.
    .strength((l) => {
      const base = 1 / Math.min(deg(l.source), deg(l.target));
      return isContainment(l.kind) ? base : base * RELATION_STRENGTH_SCALE;
    })
    .iterations(2);

  return forceSimulation<N>(opts.nodes)
    .randomSource(lcg(opts.seed ?? DEFAULT_SEED))
    .force("charge", forceManyBody<N>().strength(CHARGE_STRENGTH))
    .force("link", link)
    .force("collide", forceCollide<N>(COLLIDE_RADIUS).strength(1).iterations(3))
    .force("x", forceX<N>((n) => opts.anchors.get(n.id)!.x).strength(anchor))
    .force("y", forceY<N>((n) => opts.anchors.get(n.id)!.y).strength(anchor))
    .stop();
}

/** Configure and step the d3 simulation in place. Mutates `nodes`. */
function runSimulation(
  nodes: SimNode[],
  edges: readonly GraphEdge[],
  children: ReadonlyMap<string, string[]>,
  degree: ReadonlyMap<string, number>,
  seeds: ReadonlyMap<string, Point>,
  roots: ReadonlySet<string>,
  opts: { ticks: number; seed: number },
): void {
  const links: SimLink[] = edges.map((e) => ({ source: e.source, target: e.target, kind: e.kind }));
  const sim = createForceSimulation({ nodes, links, children, degree, anchors: seeds, rootIds: roots, seed: opts.seed });
  sim
    .alpha(1)
    .alphaMin(ALPHA_MIN)
    // Reach the same convergence at whatever tick budget the caller asked for.
    .alphaDecay(opts.ticks > 0 ? 1 - Math.pow(ALPHA_MIN, 1 / opts.ticks) : 0)
    .velocityDecay(VELOCITY_DECAY);

  for (let i = 0; i < opts.ticks; i++) sim.tick();
}
