/** Live d3-force dynamics used while a node is dragged. */

import type { Point } from "../../shared/layout";
import { collideRadius, createForceSimulation } from "../../shared/layout";
import type { RenderGraph } from "./graph.model";

interface SimNode {
  id: string;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  index?: number;
  fx?: number | null;
  fy?: number | null;
  /** The node's collision disc, from its drawn size (`CollideNode`). */
  r?: number;
}

export interface GraphSimulation {
  tick(): void;
  positions(): Map<string, Point>;
  pin(id: string, at: Point): void;
  release(id: string): void;
  /** `false` once the alpha floor is reached — the graph is holding still, and the clock can sleep. */
  awake(): boolean;
}

/** Re-heat on creation (mount, expand, collapse): brief and local, never a re-layout. */
const SETTLE_ALPHA = 0.06;
/**
 * The drag alpha target. The balance the user feels: too low and the
 * neighbours read as stiff and lazy while the node moves; too high and the
 * whole tree thrashes (measured: the hub drag peaks at ~950px/s of per-node
 * ripple at 0.3 with rigid links, ~174px/s at 0.2 with the soft springs —
 * lively, and an order of magnitude inside the crazy regime).
 */
const DRAG_ALPHA_TARGET = 0.2;
/** d3-force's alpha floor. */
const ALPHA_MIN = 0.001;

/**
 * Build a live simulation over a {@link RenderGraph}.
 *
 * `initial`, when given, is the warm start: existing ids keep their current
 * positions (so a drag or an expand does not make the graph jump), and ids it
 * does not name fall back to the graph's own laid-out positions. Those warm
 * positions are also the anchor targets, so the graph rests exactly where the
 * layout left it.
 *
 * Returns `null` for an empty graph — there is nothing to simulate, and an
 * empty `Map` every frame is work for nothing.
 */
export function createGraphSimulation(graph: RenderGraph, initial?: ReadonlyMap<string, Point>): GraphSimulation | null {
  if (graph.nodes.length === 0) return null;

  const nodes: SimNode[] = graph.nodes.map((node) => {
    const at = initial?.get(node.id);
    return {
      id: node.id,
      x: at !== undefined && Number.isFinite(at.x) ? at.x : node.x,
      y: at !== undefined && Number.isFinite(at.y) ? at.y : node.y,
      vx: 0,
      vy: 0,
      // The live physics reserves the same room per node the static layout
      // did — the drawn radius plus label room — so a drag never lets a hub
      // overlap the cloud it lifts. One formula, two drivers.
      r: collideRadius(node.size),
    };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));

  // Dangling endpoints and self-edges are a degenerate *input*; forceLink
  // would throw on them, so they are dropped here and the layout's own
  // `pathologicalGraph` fixture remains the gate for degenerate *outputs*.
  const seen = new Set<string>();
  const links: { source: string; target: string; kind: RenderGraph["edges"][number]["kind"] }[] = [];
  for (const edge of graph.edges) {
    if (edge.source === edge.target) continue;
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    const key = `${edge.source}\u0000${edge.target}\u0000${edge.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ source: edge.source, target: edge.target, kind: edge.kind });
  }

  const sim = createForceSimulation({ nodes, links, seed: 1 })
    .alpha(SETTLE_ALPHA)
    .alphaMin(ALPHA_MIN);

  return {
    tick() {
      sim.tick();
    },

    awake() {
      // A held alpha target is motion about to happen — the clock must stay
      // armed even while alpha itself is still converging up to the target.
      return sim.alphaTarget() > ALPHA_MIN || sim.alpha() > ALPHA_MIN;
    },

    positions() {
      return new Map(nodes.map((node) => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }]));
    },

    pin(id, at) {
      const node = byId.get(id);
      if (!node) return;
      // d3's canonical drag, from the force-directed graph example: fix the
      // subject at the pointer and hold the alpha target up so the neighbours
      // make room, then cool on release. A pinned node is immune to every
      // force — the drag must not fight the sim, or the node would shudder
      // under its own neighbours.
      node.fx = at.x;
      node.fy = at.y;
      sim.alphaTarget(DRAG_ALPHA_TARGET);
    },

    release(id) {
      const node = byId.get(id);
      if (!node) return;
      node.fx = null;
      node.fy = null;
      sim.alphaTarget(0);
    },
  };
}
