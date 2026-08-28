/**
 * `RenderGraph` → graphology instance (weave-workspace §7.1).
 *
 * ```text
 * GraphModel (core, authoritative)
 *       │
 *       ▼  shared/layout.ts          positions
 *       ▼  graph/graph.model.ts      RenderGraph — every decision already made
 *       ▼  graph/project.ts          ← you are here
 *    graphology instance (render projection only)
 *       ▼
 *    sigma
 * ```
 *
 * §7.1 states the rule this file exists to obey: the projection is **never
 * edited and never a second source of truth**. Every mutation flows
 * `GraphModel → projection`; nothing flows back. Concretely that means:
 *
 * - Nothing here reads from the graphology instance in order to decide
 *   something. {@link project} writes; {@link syncPositions} writes.
 * - There is no `onNodeUpdated` handler, no drag writing back into a model, no
 *   "the graph knows best" path. A user drag re-runs `shared/layout.ts` from
 *   the model and re-projects, which is why {@link syncPositions} exists as a
 *   *write* rather than a merge.
 * - `graphology` exists solely because sigma consumes it (§0 V3). It is not
 *   the client's graph type; `RenderGraph` is.
 *
 * ## Why this file is thin, and testable anyway
 *
 * graphology is a plain in-memory data structure with no DOM dependency — it
 * is `sigma` that needs a canvas. So unlike `renderer.ts`, this module *is*
 * covered by ordinary unit tests, and it stays small only because
 * `graph.model.ts` has already made every decision. What is left is two loops
 * and the argument for `multi: false`.
 */

import Graph from "graphology";
import type { Point } from "../../shared/layout";
import type { RenderEdge, RenderGraph, RenderNode } from "./graph.model";

/**
 * Node attributes as sigma reads them.
 *
 * `x`, `y`, `size`, `label`, `color`, `type` and `zIndex` are sigma's own
 * reserved names — it reads them off the node attributes directly. `kind` and
 * `provenance` are ours, carried so the reducers can decide from the node's
 * data rather than by looking anything up.
 */
export type ProjectedNode = Omit<RenderNode, "id">;

/** Edge attributes as sigma reads them. */
export type ProjectedEdge = Omit<RenderEdge, "key">;

/** The graphology type the whole graph column is stated over. */
export type ProjectedGraph = Graph<ProjectedNode, ProjectedEdge>;

/**
 * A fresh, empty projection.
 *
 * `multi: true` and `type: "directed"`, both deliberate.
 *
 * **Multi**, because the model genuinely admits parallel edges. A note can
 * both `links-to` and `mentions` the same module — §4.4's mention pass runs
 * over the body independently of the wikilink pass — and `graph.model.ts`
 * dedupes on `(source, target, kind)`, not on the pair. Under `multi: false`
 * graphology *throws* on the second one, so a simple graph would mean either a
 * crash on real data or silently discarding a relationship, which is precisely
 * the retired viewer's bug: "a link from a hidden file to a visible note
 * simply vanished" (§7.4).
 *
 * The guard that `multi: false` looked like it was providing is not lost.
 * `addDirectedEdgeWithKey` still throws on a duplicate **key**, and
 * `edgeKey` is `(source, target, kind)` — so a genuinely duplicated edge is
 * still a mount-time failure, while two *different* relationships between the
 * same pair are still two edges. The key was always doing that work; `multi`
 * only ever governed the pair.
 *
 * **Directed.** Every edge kind in `WIRE_EDGE_KINDS` has a direction that
 * means something — `contains` is not symmetric, and neither is `mentions`.
 * The renderer draws them as plain lines today, but throwing the direction
 * away at the projection would make an arrowhead a re-derivation later.
 */
export function emptyProjection(): ProjectedGraph {
  return new Graph<ProjectedNode, ProjectedEdge>({ multi: true, type: "directed" });
}

/**
 * Build a graphology instance from a {@link RenderGraph}.
 *
 * Total on any `RenderGraph` produced by `renderGraph`, which guarantees the
 * three things graphology throws over: unique node ids, unique edge keys, and
 * both endpoints of every edge present. This function deliberately does *not*
 * re-check them — a second, quieter validation here would let a malformed
 * model reach sigma with some of its edges silently missing, and "the graph
 * drew but three links vanished" is a far worse failure than a stack trace
 * naming the id.
 *
 * `tests/web/client-graph.test.ts` runs the whole §8 repo fixture through
 * `renderGraph` and then through here, so "the invariants hold on the real
 * shape" is an assertion rather than a claim.
 */
export function project(model: RenderGraph): ProjectedGraph {
  const graph = emptyProjection();
  for (const node of model.nodes) {
    const { id, ...attributes } = node;
    graph.addNode(id, attributes);
  }
  for (const edge of model.edges) {
    const { key, source, target, ...rest } = edge;
    graph.addDirectedEdgeWithKey(key, source, target, { source, target, ...rest });
  }
  return graph;
}

/**
 * Write new positions onto an existing projection.
 *
 * The cheap path for a re-run of the simulation: the node and edge sets have
 * not changed, only where things are, so replacing the whole graph would make
 * sigma rebuild every WebGL buffer and lose the camera. Ids absent from
 * `positions` keep their current coordinates — a partial update is a partial
 * update, not an instruction to move everything else to the origin.
 *
 * Returns how many nodes moved, which is what makes it observable without a
 * renderer.
 */
export function syncPositions(graph: ProjectedGraph, positions: ReadonlyMap<string, Point>): number {
  let moved = 0;
  for (const [id, at] of positions) {
    if (!graph.hasNode(id)) continue;
    if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) continue;
    graph.mergeNodeAttributes(id, { x: at.x, y: at.y });
    moved++;
  }
  return moved;
}

/**
 * The projection's current positions, as `shared/layout.ts` wants them.
 *
 * This is the one read, and it is not an exception to the "never a second
 * source of truth" rule: it exists so a re-run can **warm-start** from where
 * the graph currently is (`LayoutOptions.initial`), which is what stops the
 * picture jumping on expand/collapse. The values still originated in
 * `computeLayout`; nothing user-authored ever enters the projection.
 */
export function positionsOf(graph: ProjectedGraph): Map<string, Point> {
  const out = new Map<string, Point>();
  graph.forEachNode((id, attributes) => {
    out.set(id, { x: attributes.x, y: attributes.y });
  });
  return out;
}
