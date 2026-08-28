/**
 * The graph column's own state: what is expanded, what is highlighted, and
 * what the control strip says (weave-workspace §1.2, §1.3, §7.4, §10, P3).
 *
 * `graph.model.ts` decides how a *node* is drawn. This module decides what the
 * *column* is currently showing — which is a different question with a
 * different lifetime, and keeping them apart is what stops either becoming a
 * grab-bag:
 *
 * ```text
 * payload + selection + view state   ← this module
 *          │
 *          ▼  clusterAggregate (core)        which nodes exist right now
 *          ▼  positions.ts                   where they are
 *          ▼  graph.model.ts                 how each one looks
 *          ▼  project.ts → renderer.ts       drawn
 * ```
 *
 * Every branch lives here for §10's reason: sigma needs a canvas, so a
 * conditional inside the renderer is a conditional no test can reach.
 * `Graph.tsx` is left with a `useState`, three effects and four handlers.
 *
 * ## The §1.3 context bus, from the graph's side
 *
 * There is one signal, `selectedId`, and the graph both writes and reads it.
 * Clicking a node writes it — which drives the note column and the context
 * rail with no further wiring. Selecting *anywhere* (tree row, wikilink,
 * context rail) is read back here as {@link highlightFor}, so "selecting in
 * the tree highlights in the graph" needs no code beyond deriving the
 * neighbourhood from the same signal. That is §1.3's whole claim, and the
 * assertion that proves it is a test showing tree-driven and graph-driven
 * selection produce the identical highlight set.
 *
 * ## Tier rules (§2)
 *
 * `src/web/client/**`. Core view-models via `../../shared/view` — the one
 * sanctioned door (§2.1.1), through which P3 brings `clusterAggregate`,
 * `focusNeighborhood` and `degreeOf`. No DOM type is named and no npm package
 * is imported, so the root `tsconfig.json` project compiles the tests.
 */

import type { Point } from "../../shared/layout";
import type { ClusterAggregate, ClusterInfo, ViewGraphModel } from "../../shared/view";
import { clusterAggregate, degreeOf, focusNeighborhood } from "../../shared/view";
import type { GraphPayload, WireGraphEdge, WireGraphNode } from "../../shared/wire";
import { viewModel } from "../tree/tree.model";
import type { ColorScheme, RenderGraph } from "./graph.model";
import { EMPTY_RENDER_GRAPH, renderGraph } from "./graph.model";
import type { PositionStorage } from "./positions";
import { resolveLayout } from "./positions";

// --- the view state ------------------------------------------------------------------

/**
 * How many hops of neighbourhood the highlight covers.
 *
 * The `[depth 1 ▾]` control from the §1.2 mock. 1 is core's
 * `focusNeighborhood` verbatim; 2 and 3 are that set expanded by re-applying
 * it, which is the only definition that cannot disagree with the context
 * rail's at depth 1.
 *
 * Capped at 3 deliberately. On this repository's shape the 60-child hub is two
 * hops from most of the graph, so depth 4 highlights nearly everything and a
 * highlight that covers everything conveys nothing. A number rather than a
 * boolean because "just the neighbours" and "the neighbourhood around this
 * module" are genuinely different questions.
 */
export type Depth = 1 | 2 | 3;

/** Every depth the control offers, in order. */
export const DEPTHS: readonly Depth[] = [1, 2, 3];

/** The graph column's state. Owned by the column; never on the context bus. */
export interface GraphViewState {
  /**
   * Cluster ids the user has expanded (§7.4).
   *
   * Passed straight to `clusterAggregate`, whose contract is that a node is
   * visible when every containment ancestor between it and a root is
   * expanded. An empty set is therefore the maximally collapsed view — the
   * roots alone — which is the right first frame for a repository with
   * thousands of files and the wrong one for a vault with nine notes. See
   * {@link initialGraphView}.
   */
  readonly expanded: ReadonlySet<string>;
  /** How far the highlight reaches. */
  readonly depth: Depth;
}

/**
 * How many nodes a graph may have before it opens collapsed.
 *
 * Not a preference — a legibility bound. Above roughly this many, a
 * force-directed layout of a containment tree is a disc of overlapping labels
 * whichever way you draw it, and the honest first frame is the five clusters
 * with their counts. Below it, collapsing hides a graph the user could simply
 * have read.
 *
 * 120 is the point at which this repository's own fixture (89 nodes) still
 * opens whole while a real `src/` scan (hundreds of files) does not.
 */
export const AUTO_COLLAPSE_ABOVE = 120;

/**
 * The state a freshly loaded graph opens in.
 *
 * Everything expanded for a small graph, nothing for a large one. `expanded`
 * has to name the clusters explicitly rather than carry an "all" flag, because
 * `clusterAggregate` takes a set and the first thing a user does is collapse
 * one — which has to leave the others open.
 */
export function initialGraphView(model: ViewGraphModel): GraphViewState {
  const expanded =
    model.nodes.length > AUTO_COLLAPSE_ABOVE ? new Set<string>() : new Set(clusterAggregate(model, new Set()).clusters.keys());
  return { expanded, depth: 1 };
}

/**
 * The state to render with: the user's, or the default for this payload.
 *
 * The column holds `GraphViewState | null` and `null` means "the user has not
 * touched the expansion yet" — which is not the same as "nothing is expanded",
 * because {@link initialGraphView} opens a small graph whole. Resolving that
 * here rather than in the component keeps a real branch out of a `.tsx` (§10)
 * and, more importantly, makes the rule testable: a refetch must **not** reset
 * an expansion the user has chosen, and the watcher fires on every file save.
 */
export function effectiveView(payload: GraphPayload | null, state: GraphViewState | null): GraphViewState {
  if (state !== null) return state;
  if (payload === null) return { expanded: new Set(), depth: 1 };
  return initialGraphView(viewModel(payload));
}

/** Open or close one cluster. Returns a new state; see {@link expandAll}. */
export function toggleCluster(state: GraphViewState, id: string): GraphViewState {
  const expanded = new Set(state.expanded);
  if (!expanded.delete(id)) expanded.add(id);
  return { ...state, expanded };
}

/**
 * Open every cluster. The `[expand]` control from the §1.2 mock.
 *
 * `clusters` is `ClusterAggregate.clusters`, which holds **every** node with a
 * containment child whether or not it is currently visible — so one press
 * opens the whole tree rather than one level of it. That is deliberate: the
 * per-level walk is what the tree column is for, and a graph control that
 * needed six presses to show the graph would be a worse version of it.
 */
export function expandAll(state: GraphViewState, clusters: ReadonlyMap<string, ClusterInfo>): GraphViewState {
  return { ...state, expanded: new Set(clusters.keys()) };
}

/** Close every cluster, back to the roots. The other half of `[expand]`. */
export function collapseAll(state: GraphViewState): GraphViewState {
  return { ...state, expanded: new Set() };
}

/** Set the highlight depth. */
export function setDepth(state: GraphViewState, depth: Depth): GraphViewState {
  return state.depth === depth ? state : { ...state, depth };
}

// --- the highlight (§1.3, §7.4) ---------------------------------------------------------

/**
 * The set of ids that stay lit when `selectedId` is selected.
 *
 * Depth 1 is `focusNeighborhood` **exactly** — core's function, the same one
 * the context rail's "Related" is built from, reached through the §2.1.1 door
 * rather than reimplemented. Deeper is that operation applied again, which is
 * the only definition of "2 hops" that cannot disagree with "1 hop" at the
 * boundary.
 *
 * `null` in, `null` out: nothing selected means no highlight at all, which the
 * reducers treat as "render everything normally" — deliberately not the same
 * as an empty set (see `graph.model.ts`).
 *
 * Computed over the **currently visible** edges, not the full model. A
 * neighbour inside a collapsed cluster is not on screen, and `clusterAggregate`
 * has already retargeted the edge onto the cluster standing in for it — so
 * highlighting the hidden id would light nothing while leaving the cluster
 * that actually represents it dimmed.
 */
export function highlightFor(edges: readonly WireGraphEdge[], selectedId: string | null, depth: Depth): Set<string> | null {
  if (selectedId === null) return null;
  let frontier = focusNeighborhood(selectedId, edges);
  for (let hop = 1; hop < depth; hop++) {
    const next = new Set(frontier);
    for (const id of frontier) for (const neighbour of focusNeighborhood(id, edges)) next.add(neighbour);
    // A neighbourhood that stopped growing has reached its whole connected
    // component, so further hops cannot add anything and the loop is waste.
    if (next.size === frontier.size) break;
    frontier = next;
  }
  return frontier;
}

// --- the control strip (§1.2) ---------------------------------------------------------------

/** The `[depth 1 ▾]` control's label. */
export function depthLabel(depth: Depth): string {
  return `depth ${depth}`;
}

/** Its tooltip — says what the number means, not what it is. */
export function depthHint(depth: Depth): string {
  return depth === 1
    ? "highlighting direct neighbours of the selection"
    : `highlighting everything within ${depth} hops of the selection`;
}

/** The `[expand]` control's label, which is really a toggle. */
export function expandLabel(allExpanded: boolean): string {
  return allExpanded ? "collapse" : "expand";
}

/** Its tooltip. */
export function expandHint(allExpanded: boolean): string {
  return allExpanded ? "collapse every cluster back to the roots" : "expand every cluster";
}

/** Whether every cluster in the graph is currently open. */
export function allExpanded(state: GraphViewState, clusters: ReadonlyMap<string, ClusterInfo>): boolean {
  if (clusters.size === 0) return false;
  for (const id of clusters.keys()) if (!state.expanded.has(id)) return false;
  return true;
}

/**
 * What the `[expand]` control does when pressed.
 *
 * One function rather than a ternary in the component, for §10's reason: the
 * choice between expanding and collapsing is a branch, and a branch in a
 * `.tsx` is a branch no test can reach. It is also the *only* place the
 * toggle's two halves are paired, so its label and its effect cannot disagree
 * — {@link expandLabel} reads the same predicate.
 */
export function toggleExpandAll(state: GraphViewState, clusters: ReadonlyMap<string, ClusterInfo>): GraphViewState {
  return allExpanded(state, clusters) ? collapseAll(state) : expandAll(state, clusters);
}

/**
 * Parse the depth `<select>`'s value.
 *
 * A `<select>` yields a string and the component must not cast it — an
 * `as Depth` on unvalidated input is exactly how a `depth 7` ends up in state
 * and the highlight silently covers the whole graph. Anything unrecognised
 * falls back to the current depth, so a malformed event changes nothing.
 */
export function parseDepth(value: string, fallback: Depth): Depth {
  const parsed = Number(value);
  return (DEPTHS as readonly number[]).includes(parsed) ? (parsed as Depth) : fallback;
}

/** The `[fit]` control. Constant, but named here so the component holds no copy. */
export const FIT_LABEL = "fit";
export const FIT_HINT = "frame the whole graph";

/**
 * The legend under the canvas, from the §1.2 mock:
 * `◉ selected  ● neighborhood`.
 */
export const LEGEND = { selected: "selected", neighborhood: "neighborhood", dimmed: "not related" } as const;

/**
 * The count line: what is on screen out of what exists.
 *
 * Both numbers, always. "89 nodes" next to a canvas showing 5 is the reading
 * that makes a collapsed graph look broken; "5 of 89 nodes" makes it obvious
 * that there is more behind the clusters.
 */
export function graphCountLabel(visible: number, total: number): string {
  const noun = total === 1 ? "node" : "nodes";
  return visible === total ? `${total} ${noun}` : `${visible} of ${total} ${noun}`;
}

/** What the column says instead of a canvas. `null` means "there is a graph". */
export function graphEmptyMessage(payload: GraphPayload | null, visible: number): string | null {
  if (payload === null) return "Loading…";
  if (payload.model.nodes.length === 0) return "Nothing indexed yet — add a note or run /weave-scan.";
  // A payload with nodes but nothing visible cannot happen through the UI
  // (`clusterAggregate` always keeps the roots), but a truncated response
  // could produce it, and a blank canvas with no explanation reads as a crash.
  return visible === 0 ? "Nothing to draw at this expansion." : null;
}

// --- the whole column state -----------------------------------------------------------------

/** Everything the column needs to render one frame. */
export interface GraphColumnModel {
  /** What sigma draws. */
  readonly graph: RenderGraph;
  /** What the reducers dim outside of. `null` when nothing is selected. */
  readonly highlight: Set<string> | null;
  /** The layout's cache key, so the caller can tell one shape from another. */
  readonly key: string;
  /** True when the layout came from `localStorage` rather than the simulation. */
  readonly cached: boolean;
  /** Every cluster in the *unreduced* model — what `[expand]` operates on. */
  readonly clusters: ReadonlyMap<string, ClusterInfo>;
  /** Visible / total, for the count line. */
  readonly visible: number;
  readonly total: number;
  /** Non-null when there is nothing to draw. */
  readonly empty: string | null;
}

/** The column with nothing in it. What the first render produces. */
export const EMPTY_COLUMN: GraphColumnModel = {
  graph: EMPTY_RENDER_GRAPH,
  highlight: null,
  key: "",
  cached: false,
  clusters: new Map(),
  visible: 0,
  total: 0,
  empty: "Loading…",
};

/**
 * Reduce, lay out, resolve and highlight — one frame of the graph column.
 *
 * The order is the design, and each step depends on the one before it:
 *
 * 1. **Reduce** (`clusterAggregate`, core). Collapsed subtrees become their
 *    parent and boundary-crossing edges are retargeted onto it. The renderer
 *    is never handed a node it is expected to hide (§7.4).
 * 2. **Lay out** the *reduced* graph. Laying out the full model and then
 *    hiding nodes would leave the visible ones spread across the holes the
 *    hidden ones left — the collapsed view would have the geometry of the
 *    expanded one, which is the opposite of the point.
 * 3. **Resolve** to a `RenderGraph`.
 * 4. **Highlight** over the reduced edges, so a neighbour inside a collapsed
 *    cluster lights the cluster rather than nothing.
 *
 * Step 2 is also why the layout cache is keyed by shape: every expand and
 * collapse produces a genuinely different graph, gets its own key, and is
 * remembered independently — so collapsing and re-expanding returns the
 * arrangement the user had, rather than a fresh one.
 */
export function graphColumnModel(
  payload: GraphPayload | null,
  selectedId: string | null,
  state: GraphViewState,
  storage: PositionStorage,
  scheme: ColorScheme,
): GraphColumnModel {
  if (payload === null) return EMPTY_COLUMN;

  const model = viewModel(payload);
  const reduced: ClusterAggregate = clusterAggregate(model, state.expanded);
  const layout = resolveLayout(storage, reduced.nodes, reduced.edges);

  return {
    graph: renderGraph(reduced.nodes, reduced.edges, layout.positions, scheme),
    highlight: highlightFor(reduced.edges, selectedId, state.depth),
    key: layout.key,
    cached: layout.cached,
    clusters: reduced.clusters,
    visible: reduced.nodes.length,
    total: model.nodes.length,
    empty: graphEmptyMessage(payload, reduced.nodes.length),
  };
}

// --- clicking a node -------------------------------------------------------------------------

/** What a click on the canvas produced. */
export interface GraphClick {
  /** The next view state — changed only when a collapsed cluster was opened. */
  readonly state: GraphViewState;
  /** What to write to `selectedId`. Always set, even when a cluster expanded. */
  readonly selectedId: string | null;
}

/**
 * Apply a click on a node (or on empty stage, with `null`).
 *
 * A click does **two** things when it lands on a collapsed cluster: it selects
 * it *and* it expands it (§7.4, "expand on click"). Both, deliberately — the
 * selection is what drives the note column and the context rail, and dropping
 * it in favour of the expansion would make clicking a module the one gesture
 * in the workspace that does not update the other columns.
 *
 * A click on an already-expanded cluster selects without collapsing. Collapse
 * is the `[expand]` control and the tree; making a second click close a
 * cluster would make it impossible to select one and read it.
 */
export function graphClick(state: GraphViewState, clusters: ReadonlyMap<string, ClusterInfo>, id: string | null): GraphClick {
  if (id === null) return { state, selectedId: null };
  const cluster = clusters.get(id);
  if (cluster === undefined || state.expanded.has(id)) return { state, selectedId: id };
  return { state: toggleCluster(state, id), selectedId: id };
}

// --- tooltips ---------------------------------------------------------------------------------

/**
 * What a node says when it stands in for a collapsed subtree.
 *
 * `ClusterInfo.members` is exactly the hidden descendants this cluster is
 * currently representing — not `descendants`, which overlaps freely between a
 * cluster and its ancestors and would report the same file under both
 * `src/core` and `repository`. `members` partitions the hidden set across the
 * visible clusters, so the counts add up to the number of nodes that are not
 * on screen.
 */
export function clusterBadge(cluster: ClusterInfo | undefined): string | null {
  if (cluster === undefined || cluster.members.length === 0) return null;
  return cluster.members.length === 1 ? "1 hidden" : `${cluster.members.length} hidden`;
}

/**
 * A node's hover text: its label, its degree, and what it is standing in for.
 *
 * `degreeOf` is core's, reached through the §2.1.1 door. The bulk `degrees`
 * pass in `graph.model.ts` is a different algorithm for a different question
 * (every node at once, O(edges)); this is one node, which is what a tooltip
 * asks.
 */
export function nodeTooltip(node: WireGraphNode, edges: readonly WireGraphEdge[], cluster: ClusterInfo | undefined): string {
  const degree = degreeOf(node.id, edges);
  const parts = [node.label, degree === 1 ? "1 link" : `${degree} links`];
  const badge = clusterBadge(cluster);
  if (badge !== null) parts.push(badge);
  return parts.join(" · ");
}

/** Positions keyed by id, for a caller warm-starting a re-run. */
export type LayoutSnapshot = ReadonlyMap<string, Point>;
