/** Deterministic force layout shared by the server, browser and tests. */

import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3-force";
import type { Simulation, SimulationNodeDatum } from "d3-force";
import type { WireEdgeKind as EdgeKind, WireGraphEdge as GraphEdge, WireGraphModel as GraphModel } from "./graph";
import type { Point } from "./metrics";

export type { Point } from "./metrics";

export interface LayoutOptions {
  ticks?: number;
  seed?: number;
  initial?: ReadonlyMap<string, Point>;
  pinWarm?: boolean;
}

export const NODE_RADIUS = 9;
export const MIN_NODE_SIZE = 6;
export const MAX_NODE_SIZE = 18;
export const DEGREE_AT_MAX_SIZE = 32;
export const LABEL_ROOM = 9;
export const COLLIDE_RADIUS = NODE_RADIUS + LABEL_ROOM;

export function nodeSize(degree: number): number {
  const d = Number.isFinite(degree) && degree > 0 ? degree : 0;
  const share = Math.min(1, Math.log2(1 + d) / Math.log2(1 + DEGREE_AT_MAX_SIZE));
  return MIN_NODE_SIZE + (MAX_NODE_SIZE - MIN_NODE_SIZE) * share;
}

export function collideRadius(drawnSize: number): number {
  return drawnSize + LABEL_ROOM;
}

const DEFAULT_TICKS = 300;
const DEFAULT_SEED = 1;
const ALPHA_MIN = 0.001;

/**
 * The force constants, as one **mutable** record.
 *
 * Mutable because picking these numbers is an act of taste, not of
 * derivation: the difference between "one hairball" and "legible groups" is a
 * ratio between containment cohesion, charge and centre gravity that is far
 * easier to *see* than to reason about. The hidden tuner (`?forces=1`, see
 * `client/graph/tuner.model.ts` and docs/weave-workspace.md §15.7) writes here
 * and re-lays out live, so a human can find the values by eye and they then
 * get frozen back into {@link FORCE_DEFAULTS}.
 *
 * Determinism is untouched: every production and test path only ever *reads*
 * this, so `computeLayout(model, { seed })` stays byte-identical. The tuner is
 * the one writer, and it is unreachable without the query flag.
 *
 * ponytail: module-level mutable state, fine at one graph per page — thread it
 * as a `LayoutOptions` field if a second concurrent consumer ever appears.
 */
export interface ForceConstants {
  /** Rest length of a `contains` / `anchored-at` spring: a rosette's radius. */
  containsRest: number;
  /** Stiffness of that spring. This is what makes a group *be* a group. */
  containsStrength: number;
  /** Rest length of a `links-to` / `mentions` spring: the inter-group reach. */
  relationDistance: number;
  /** Stiffness of that spring. Weak, so associations bend without merging. */
  relationStrength: number;
  /** `forceManyBody` strength. Negative is repulsion. */
  charge: number;
  /**
   * Distance past which charge is ignored (`forceManyBody.distanceMax`).
   *
   * A cap rather than `Infinity` is what keeps a strong charge from simply
   * inflating the whole graph uniformly: beyond it, neighbours stop pushing
   * and only the springs and centre gravity speak, so groups separate at
   * local scale without the picture growing without bound.
   */
  chargeMax: number;
  /** `forceX`/`forceY` pull toward the origin. The no-escape guarantee. */
  center: number;
}

/** The live constants. See {@link ForceConstants} for why this is mutable. */
export const FORCES: ForceConstants = {
  containsRest: 90,
  containsStrength: 0.02,
  relationDistance: 170,
  relationStrength: 0.05,
  charge: -50,
  chargeMax: Infinity,
  center: 0.09,
};

/** The shipped values, for the tuner's reset and for a test to restore from. */
export const FORCE_DEFAULTS: Readonly<ForceConstants> = { ...FORCES };

/** Overwrite the live constants in place. The tuner's one write. */
export function setForces(next: Partial<ForceConstants>): void {
  Object.assign(FORCES, next);
}

export function isContainment(kind: EdgeKind): boolean {
  return kind === "contains" || kind === "anchored-at";
}

/** d3's deterministic random source, with a caller-selected seed. */
export function lcg(seed: number): () => number {
  let state = Math.trunc(seed) >>> 0;
  return () => (state = (1664525 * state + 1013904223) % 4294967296) / 4294967296;
}

interface SimNode extends SimulationNodeDatum {
  id: string;
  r?: number;
}

function analyse(model: GraphModel): { ids: string[]; edges: GraphEdge[] } {
  const ids: string[] = [];
  const known = new Set<string>();
  for (const node of model.nodes) {
    if (!known.has(node.id)) {
      known.add(node.id);
      ids.push(node.id);
    }
  }

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const edge of model.edges) {
    if (edge.source === edge.target || !known.has(edge.source) || !known.has(edge.target)) continue;
    const key = `${edge.source}\u0000${edge.target}\u0000${edge.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push(edge);
  }
  return { ids, edges };
}

export interface CollideNode {
  r?: number;
}

export interface ForceSimulationOptions<N> {
  nodes: N[];
  links: Array<{ source: string | N; target: string | N; kind: EdgeKind }>;
  seed?: number;
}

/** One d3 recipe for both cold layout and live drag dynamics. */
export function createForceSimulation<N extends SimulationNodeDatum & { id: string; r?: number }>(
  opts: ForceSimulationOptions<N>,
): Simulation<N, undefined> {
  const link = forceLink<N, { source: string | N; target: string | N; kind: EdgeKind }>(opts.links)
    .id((node) => node.id)
    .distance((edge) => (isContainment(edge.kind) ? FORCES.containsRest : FORCES.relationDistance))
    .strength((edge) => (isContainment(edge.kind) ? FORCES.containsStrength : FORCES.relationStrength))
    .iterations(2);

  // Read out of `FORCES` here, at construction: a simulation is built fresh
  // per layout run and per live mount, so a tuner write lands on the next one.
  return forceSimulation<N>(opts.nodes)
    .randomSource(lcg(opts.seed ?? DEFAULT_SEED))
    .force("charge", forceManyBody<N>().strength(FORCES.charge).distanceMax(FORCES.chargeMax))
    .force("link", link)
    .force("collide", forceCollide<N>((node) => node.r ?? COLLIDE_RADIUS).strength(1))
    .force("x", forceX<N>(0).strength(FORCES.center))
    .force("y", forceY<N>(0).strength(FORCES.center))
    .stop();
}

function runSimulation(nodes: SimNode[], edges: readonly GraphEdge[], options: { ticks: number; seed: number; warm: boolean }): void {
  const simulation = createForceSimulation({
    nodes,
    links: edges.map(({ source, target, kind }) => ({ source, target, kind })),
    seed: options.seed,
  })
    .alpha(options.warm ? 0.3 : 1)
    .alphaMin(ALPHA_MIN)
    .alphaDecay(options.ticks > 0 ? 1 - Math.pow(ALPHA_MIN, 1 / options.ticks) : 0);
  for (let tick = 0; tick < options.ticks; tick++) simulation.tick();
}

/** Lay out a graph in one deterministic, synchronous d3-force pass. */
export function computeLayout(model: GraphModel, options: LayoutOptions = {}): Map<string, Point> {
  const ticks = Math.max(0, Math.trunc(options.ticks ?? DEFAULT_TICKS));
  const { ids, edges } = analyse(model);
  const nodes: SimNode[] = ids.map((id) => {
    const at = options.initial?.get(id);
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

  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  for (const node of nodes) node.r = collideRadius(nodeSize(degree.get(node.id) ?? 0));
  if (nodes.length > 1) runSimulation(nodes, edges, { ticks, seed: options.seed ?? DEFAULT_SEED, warm: options.initial !== undefined });

  const out = new Map<string, Point>();
  for (const node of nodes) {
    out.set(node.id, {
      x: Number.isFinite(node.x as number) ? (node.x as number) : 0,
      y: Number.isFinite(node.y as number) ? (node.y as number) : 0,
    });
  }
  return out;
}
