/**
 * Live force dynamics for the graph's current shape — the Obsidian-style
 * "the graph is alive" feel while the user drags.
 *
 * ## One physics, two drivers
 *
 * The static layout (`shared/layout.ts`) and this module now share ONE force
 * configuration: {@link createForceSimulation}. They used to be two
 * independent physics — the static path ring-sized its link distances per
 * fan-out and anchored every node to its seed; this one pulled at a flat 90
 * units toward its own equilibrium. Every graph therefore *visibly re-laid
 * itself* after mount (a 215-node repo graph migrated from a ~1200-unit ring
 * to the bespoke sim's ~300-unit cloud over about thirty seconds), and the
 * constant-alpha loop ticked at 60 fps forever, because a bespoke integrator
 * has no alpha to decay. Sharing the factory fixes both by construction: the
 * warm start is already at the shared equilibrium, so there is nothing to
 * migrate to, and d3's alpha decay is what says "settled".
 *
 * ## The lifecycle
 *
 * A new engine starts at {@link SETTLE_ALPHA} (an expand/collapse lands new
 * nodes already laid out; the brief settle is the "alive" response, not a
 * re-layout) and decays to d3's alpha floor, at which point {@link awake}
 * turns false and the component's clock puts itself to sleep — no frames are
 * spent on a graph that is holding still. `pin` re-heats to
 * {@link DRAG_ALPHA_TARGET} (d3's own drag pattern), so neighbours make room
 * while the user drags; `release` clears the pin AND retargets the node's
 * anchor to its drop point, so a dragged node stays where it was dropped
 * instead of springing back to its seed.
 *
 * ## The §7.2 vertical-line freeze
 *
 * Inherited from d3 itself: `manyBody`, `collide` and `link` all inject a
 * seeded `jiggle` into a zero axis component, so coincident or collinear
 * nodes always acquire a direction. The seeded LCG (`seed: 1`) keeps the
 * whole thing deterministic — the same graph, the same gestures, byte-identical
 * positions — which is what the test gate asserts.
 */

import type { Point } from "../../shared/layout";
import { branchAnchors, collideRadius, createForceSimulation, isContainment } from "../../shared/layout";
import type { WireEdgeKind } from "../../shared/graph";
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

interface SimLink {
  source: string | SimNode;
  target: string | SimNode;
  kind: WireEdgeKind;
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
  const links: SimLink[] = [];
  for (const edge of graph.edges) {
    if (edge.source === edge.target) continue;
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    const key = `${edge.source}\u0000${edge.target}\u0000${edge.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ source: edge.source, target: edge.target, kind: edge.kind });
  }

  // No invented seeding; centre gravity lives in the factory (`forceX()`/
  // `forceY()`). The anchors start as the **branch ring** (`branchAnchors`),
  // so a released graph holds the separated equilibrium the static layout
  // settled into instead of gliding back toward one centre — the live and
  // static paths share one physics, and that includes its gravity targets.
  // `release` then overrides a dropped node's entry with its drop point, so a
  // placement sticks (the anchor is five times stronger than the leaf
  // spring, so the node rests where the user left it).
  const settled = new Map<string, Point>();
  for (const node of graph.nodes) settled.set(node.id, { x: node.x, y: node.y });
  const anchors = new Map<string, Point>(branchAnchors(graph, settled));
  const sim = createForceSimulation({ nodes, links, anchors, seed: 1 })
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
      // Unfix, like d3's `dragended` — and retarget the node's centre-gravity
      // anchor to the drop point, so the graph reads the drop as a placement:
      // the node rests where the user left it instead of gliding back into
      // the tree.
      anchors.set(id, { x: node.x ?? 0, y: node.y ?? 0 });
      node.fx = null;
      node.fy = null;
      sim.alphaTarget(0);
    },
  };
}