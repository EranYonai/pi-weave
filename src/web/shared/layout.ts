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
 * And one extension, because single-centre gravity has a failure the example
 * never has to face: **big sibling blobs interleave** (see
 * {@link branchAnchors}). A 195-node `module:.okf` and a 40-node
 * `vfolder:sessions` share an origin, share almost no edges, and tangle into
 * one hairball — measured gap 0 between their bounding boxes on this
 * repository. When a model has branches that big, the layout runs a second
 * pass with each branch's gravity re-targeted onto a ring slot sized from the
 * first pass, and the blobs hold apart with a guaranteed corridor between
 * them. Graphs without big branches skip the second pass entirely and keep
 * the exact single-pass behaviour the §8 gate was written against.
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
import { bbox } from "./metrics";
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

/**
 * A branch (a depth-1 subtree) with at least this many nodes earns its own
 * gravity slot. Below it, the branch is a twig that reads as part of its
 * root's cluster and joins the root group at the origin.
 *
 * 8 is the smallest arrangement that is a *blob* rather than a fringe: eight
 * collision discs already cover a 3×3 patch around their parent, which is the
 * shape two of them interleaving would wreck. It is a count, not a tuned
 * fraction, so the same graph gets the same groups on every machine.
 */
export const BIG_BRANCH_MIN = 8;

/**
 * The guaranteed corridor between separated groups, in layout units: one
 * collision diameter — two groups of collision-spaced nodes can never be
 * closer without their members overlapping anyway, so this is the minimum
 * distance that still reads as "separated" rather than "denser".
 */
export const BRANCH_GAP = 2 * COLLIDE_RADIUS;

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

// --- separating big sibling branches ---------------------------------------------

/**
 * The least a module must satisfy to describe a containment forest. Both
 * `GraphModel` and the client's `RenderGraph` satisfy it structurally, so the
 * static layout and the live driver ask the same question of the same shape.
 */
export interface ContainmentLike {
  nodes: readonly { readonly id: string }[];
  edges: readonly { readonly source: string; readonly target: string; readonly kind: EdgeKind }[];
}

/** One depth-1 subtree big enough to earn its own gravity slot. */
export interface Branch {
  readonly id: string;
  /** The branch node itself plus every containment descendant. */
  readonly members: readonly string[];
}

/** Children by containment edge: first parent only, so the result is a forest. */
function forestOf(model: ContainmentLike): { kids: ReadonlyMap<string, readonly string[]>; roots: readonly string[] } {
  const known = new Set(model.nodes.map((n) => n.id));
  const kids = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const e of model.edges) {
    if (!isContainment(e.kind)) continue;
    if (e.source === e.target) continue;
    if (!known.has(e.source) || !known.has(e.target)) continue;
    // A second containment parent (a cycle, or a hand-edited index) must not
    // turn the walk into a diamond: the first edge wins, like `analyse`.
    if (hasParent.has(e.target)) continue;
    hasParent.add(e.target);
    const list = kids.get(e.source);
    if (list === undefined) kids.set(e.source, [e.target]);
    else list.push(e.target);
  }
  const roots = model.nodes.filter((n) => !hasParent.has(n.id)).map((n) => n.id);
  return { kids, roots };
}

/**
 * The big branches of a model, in codepoint-id order.
 *
 * A branch is a depth-1 child of a root whose containment subtree holds at
 * least {@link BIG_BRANCH_MIN} nodes — the shape that reads as a blob of its
 * own. Depth 1 exactly: deeper groupings would shred a deep module tree into
 * ring slots, while the tangle being fixed is always *sibling* blobs pulling
 * at the same origin. Sorted by id so the ring geometry is a pure function of
 * structure, never of insertion order.
 */
export function bigBranches(model: ContainmentLike): readonly Branch[] {
  const { kids, roots } = forestOf(model);
  const membersOf = (id: string, seen: Set<string>): string[] => {
    if (seen.has(id)) return []; // containment cycle: stop, keep both walks finite
    seen.add(id);
    const out = [id];
    for (const k of kids.get(id) ?? []) for (const m of membersOf(k, seen)) out.push(m);
    return out;
  };
  const branches: Branch[] = [];
  for (const root of roots) {
    for (const kid of kids.get(root) ?? []) {
      const members = membersOf(kid, new Set());
      if (members.length >= BIG_BRANCH_MIN) branches.push({ id: kid, members });
    }
  }
  branches.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return branches;
}

/** Finite settled positions of a simulation's nodes, by id. */
function settledOf(nodes: readonly { id: string; x?: number; y?: number }[]): Map<string, Point> {
  const out = new Map<string, Point>();
  for (const n of nodes) {
    if (n.x !== undefined && n.y !== undefined && Number.isFinite(n.x) && Number.isFinite(n.y)) {
      out.set(n.id, { x: n.x, y: n.y });
    }
  }
  return out;
}

/** A set's spread around its own centroid: the disc the ring must house. */
function radiusOf(ids: readonly string[], settled: ReadonlyMap<string, Point>): number {
  const pts: Point[] = [];
  for (const id of ids) {
    const p = settled.get(id);
    if (p !== undefined) pts.push(p);
  }
  if (pts.length === 0) return COLLIDE_RADIUS;
  const box = bbox(pts);
  // The circumscribing radius, not half a side: a blob pulled toward its slot
  // keeps whatever shape it had, and the ring must house the widest turn of it.
  return Math.hypot(box.w, box.h) / 2;
}

/**
 * Per-node gravity anchors that keep big sibling branches apart.
 *
 * The tangle this fixes is structural: every node gravitates toward the
 * origin, so two blobs that share a root — measured on this repository, a
 * 195-node `module:.okf` and a 40-node `vfolder:sessions`, connected by almost
 * nothing — interleave at the same centre and read as one hairball. The
 * anchor map sends each big branch's gravity to its own slot on a ring instead:
 *
 * - Slots are sized from the branches' *measured* pass-1 spread (`settled`),
 *   allocated arc share proportional to disc size, on a ring whose radius
 *   clears the root group at the centre — so the geometry is a function of the
 *   graph, not of constants that would need retuning per vault.
 * - The root group — roots, single nodes and small twigs — keeps the origin,
 *   which preserves the recipe's no-component-escapes guarantee and the
 *   root-separation behaviour the §8 gate asserts on five-root fixtures.
 * - Absent ids mean the origin: only branch members appear in the map.
 *
 * Returned per node, so `createForceSimulation`'s `forceX`/`forceY` accessors
 * read it directly. Deterministic: same model, same settled positions, same
 * anchors — the sort is by id and the arithmetic is plain.
 */
export function branchAnchors(
  model: ContainmentLike,
  settled: ReadonlyMap<string, Point>,
  branches?: readonly Branch[],
): ReadonlyMap<string, Point> {
  const list = branches ?? bigBranches(model);
  if (list.length === 0) return new Map();

  const inBranch = new Set<string>();
  for (const b of list) for (const m of b.members) inBranch.add(m);
  const centerIds = model.nodes.filter((n) => !inBranch.has(n.id)).map((n) => n.id);
  const centerRadius = radiusOf(centerIds, settled);

  const radii = list.map((b) => radiusOf(b.members, settled));
  const arcs = radii.map((r) => 2 * r + BRANCH_GAP);
  const circumference = arcs.reduce((a, b) => a + b, 0);
  const ring = Math.max(
    circumference / (2 * Math.PI),
    // The ring must also clear the root group sitting at the origin — a slot
    // closer than this would park a branch on top of the centre blob.
    centerRadius + BRANCH_GAP + Math.max(...radii),
  );

  const anchors = new Map<string, Point>();
  let cursor = 0;
  for (let i = 0; i < list.length; i++) {
    const branch = list[i]!;
    const arc = arcs[i]!;
    // Mid-arc, clockwise from twelve o'clock: deterministic for a given model.
    const angle = -Math.PI / 2 + ((cursor + arc / 2) / circumference) * 2 * Math.PI;
    cursor += arc;
    const at = { x: Math.cos(angle) * ring, y: Math.sin(angle) * ring };
    for (const member of branch.members) anchors.set(member, at);
  }
  return anchors;
}

/**
 * Teleport every big branch onto its ring slot, as a rigid translation.
 *
 * Gravity alone does not get a blob to its slot on a sane tick budget —
 * measured on the sibling-blobs fixture, 150 anchored ticks moved the smallest
 * branch 40 % of the way, and the corridor the ring geometry guarantees only
 * exists once the blobs arrive. Physics is the wrong tool for transport: the
 * slot is exact, so the whole branch is simply *moved* there — centroid onto
 * slot, intra-branch geometry carried — and the relaxation that follows only
 * has to settle the neighbourhood, which converges at any budget. Without the
 * translation the tick budget would be a quality parameter, which §7.3
 * explicitly promises it is not.
 *
 * Pinned nodes (`fx`/`fy`, a warm expand) are skipped by the position write —
 * the sim holds them where they are anyway, and a warm arrangement already
 * has its blobs near their slots.
 */
function parkBranches(
  nodes: readonly SimNode[],
  branches: readonly Branch[],
  anchors: ReadonlyMap<string, Point>,
  settled: ReadonlyMap<string, Point>,
): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const branch of branches) {
    const slot = anchors.get(branch.id);
    if (slot === undefined) continue;
    let sumX = 0;
    let sumY = 0;
    let n = 0;
    for (const member of branch.members) {
      const p = settled.get(member);
      if (p === undefined) continue;
      sumX += p.x;
      sumY += p.y;
      n++;
    }
    if (n === 0) continue;
    const dx = slot.x - sumX / n;
    const dy = slot.y - sumY / n;
    for (const member of branch.members) {
      const node = byId.get(member);
      if (node === undefined || node.x === undefined || node.y === undefined) continue;
      // Pinned on either axis (`fx`/`fy`, a warm expand): d3 holds the node
      // where it is, so the translation would fight the pin on the free axis.
      // Pins always arrive as a pair (both `computeLayout`'s pinWarm and the
      // live drag set both), so this is one condition, not two.
      if (node.fx != null || node.fy != null) continue;
      node.x += dx;
      node.y += dy;
    }
  }
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
    const branches = bigBranches(model);
    if (branches.length === 0 || ticks === 0) {
      // No big branches — or no budget — the plain recipe at the full budget.
      // Zero ticks still constructs the simulation, which is what seeds d3's
      // deterministic phyllotaxis; skipping it would leave every node at the
      // origin instead. Byte-identical to the old single pass either way.
      runSimulation(nodes, edges, { ticks, seed, warm: warm !== undefined });
    } else {
      // Two passes. Pass 1 assembles the tree under origin gravity — the same
      // recipe — so the ring pass measures *actual* blob radii rather than
      // guessing them from head counts. Then every branch is teleported onto
      // its slot (see `parkBranches` for why transport is arithmetic and not
      // physics) and pass 2 relaxes the arrangement into place at d3's own
      // re-heat alpha, warm-started so nothing else re-arranges.
      const settle = Math.ceil(ticks / 2);
      runSimulation(nodes, edges, { ticks: settle, seed, warm: warm !== undefined });
      const settled = settledOf(nodes);
      const anchors = branchAnchors(model, settled, branches);
      parkBranches(nodes, branches, anchors, settled);
      runSimulation(nodes, edges, { ticks: ticks - settle, seed, warm: true, anchors });
    }
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
  anchors?: ReadonlyMap<string, Point> | undefined;
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
    // One collision pass per tick, not d3's three: at §8's expected ~240-node
    // scale it cuts a cold 300-tick run roughly in half (measured 325 ms →
    // 179 ms) and the non-degeneracy gate cannot tell the difference. The
    // link force keeps its own two passes — edge untangling is where the
    // quality actually lives.
    .force("collide", forceCollide<N>(COLLIDE_RADIUS).strength(1).iterations(1))
    .force("x", forceX<N>((n) => opts.anchors?.get(n.id)?.x ?? 0))
    .force("y", forceY<N>((n) => opts.anchors?.get(n.id)?.y ?? 0))
    .stop();
}

/** Configure and step the d3 simulation in place. Mutates `nodes`. */
function runSimulation(
  nodes: SimNode[],
  edges: readonly GraphEdge[],
  opts: { ticks: number; seed: number; warm: boolean; anchors?: ReadonlyMap<string, Point> | undefined },
): void {
  const links: SimLink[] = edges.map((e) => ({ source: e.source, target: e.target, kind: e.kind }));
  const sim = createForceSimulation({ nodes, links, seed: opts.seed, anchors: opts.anchors });
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