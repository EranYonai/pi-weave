/**
 * Everything the graph column *decides* (weave-workspace §7, §10).
 *
 * §7.1's pipeline is four stages, and only two of them contain judgement:
 *
 * ```text
 * GraphModel ──▶ shared/layout ──▶ [this module] ──▶ project.ts ──▶ sigma
 *  (core)         (positions)       (what to draw)   (graphology)   (pixels)
 * ```
 *
 * `layout.ts` decides *where*; this module decides *what* — which nodes and
 * edges survive, what colour and size each gets, what its label reads, and
 * which of them are dimmed when something is selected. `project.ts` is then a
 * loop with no opinions, and `renderer.ts` is a wire.
 *
 * That split is forced rather than chosen. §10 forbids a DOM test environment
 * and sigma needs a real canvas and a WebGL context, so **any branch inside a
 * sigma-touching file is a branch no test can reach**. Every branch the graph
 * column needs therefore lives here, in a module that names no DOM type at all
 * and is covered by ordinary unit tests.
 *
 * ## Tier rules (§2)
 *
 * `src/web/client/**`: `src/web/shared` and browser deps only. View-models
 * arrive through `../../shared/view`, the one sanctioned door onto
 * `src/core/view` (§2.1). This file imports **no npm package** — not even
 * graphology — so it compiles under the root `tsconfig.json` (which has no
 * `DOM` lib) whenever a test imports it.
 *
 * ## Why the palette is duplicated from the stylesheet
 *
 * WebGL cannot read a CSS custom property. `sigma` needs a concrete `#rrggbb`
 * per node, and `getComputedStyle` is both a DOM global and an untestable
 * read. So {@link GRAPH_PALETTE} restates the six theme colours the graph
 * uses, and {@link KIND_SLOT} maps a node kind onto the *same slot vocabulary*
 * the TUI already uses (`src/pi/viewer/tui/theme.ts`'s `kindStyle`) rather
 * than inventing a second one.
 *
 * A copy drifts, so drift is a failing test: `tests/web/client-graph.test.ts`
 * asserts every hex in {@link GRAPH_PALETTE} literally appears in
 * `shell/theme.ts`'s `THEME_CSS`. Change a swatch in the stylesheet and the
 * graph's copy goes red on the same commit.
 */

import { COLLIDE_RADIUS, NODE_RADIUS } from "../../shared/layout";
import type { Point } from "../../shared/layout";
import { listLabel } from "../../shared/view";
import type { WireEdgeKind, WireGraphEdge, WireGraphNode, WireNodeKind, WireNoteSource } from "../../shared/wire";
import { provenanceGlyph } from "../tree/tree.model";

// --- the palette ----------------------------------------------------------------

/** Which theme colour a thing is painted in. The TUI's slot names, verbatim. */
export type ColorSlot = "accent" | "success" | "warning" | "dim" | "text" | "muted" | "line";

/** Dark or light. Chosen by the shell from `prefers-color-scheme`, never read here. */
export type ColorScheme = "dark" | "light";

/**
 * Slot → hex, per scheme.
 *
 * Every value is copied from `shell/theme.ts`'s `THEME_CSS`:
 * `accent`→`--weave-accent`, `success`→`--weave-ok`, `warning`→`--weave-warn`,
 * `dim`→`--weave-dim`, `text`→`--weave-fg`, `muted`→`--weave-faint`,
 * `line`→`--weave-line-strong`. The dark block is `:root`; the light block is
 * the `prefers-color-scheme: light` override.
 */
export const GRAPH_PALETTE: Readonly<Record<ColorScheme, Readonly<Record<ColorSlot, string>>>> = {
  dark: {
    accent: "#a48cff",
    success: "#4ade80",
    warning: "#fbbf24",
    dim: "#8f8a9c",
    text: "#e8e6ee",
    muted: "#5d5869",
    line: "#343141",
  },
  light: {
    accent: "#6d4aff",
    success: "#15803d",
    warning: "#b45309",
    dim: "#6f6b66",
    text: "#1c1b19",
    muted: "#9a958e",
    line: "#d2cec8",
  },
};

/**
 * Node kind → colour slot.
 *
 * The same assignment `kindStyle` makes in `src/pi/viewer/tui/theme.ts`, which
 * the client tier may not import. Restated rather than re-derived for the
 * reason `tree.model.ts`'s glyph table gives: someone who has used
 * `/weave-view tui` should recognise the graph, and a second vocabulary is a
 * cost with no benefit. `note` takes `text` there too — a note's identity is
 * carried by its provenance badge, not by its kind.
 */
export const KIND_SLOT: Readonly<Record<WireNodeKind, ColorSlot>> = {
  vault: "accent",
  note: "text",
  repository: "accent",
  module: "success",
  package: "success",
  entryPoint: "warning",
  gitState: "warning",
  external: "warning",
  file: "dim",
};

/** Edge kind → colour slot. Structure recedes; association is the accent. */
export const EDGE_SLOT: Readonly<Record<WireEdgeKind, ColorSlot>> = {
  contains: "line",
  "anchored-at": "line",
  "links-to": "accent",
  mentions: "warning",
};

/** The colour a node kind is drawn in. */
export function kindColor(kind: WireNodeKind, scheme: ColorScheme): string {
  return GRAPH_PALETTE[scheme][KIND_SLOT[kind]];
}

/** The colour an edge kind is drawn in. */
export function edgeColor(kind: WireEdgeKind, scheme: ColorScheme): string {
  return GRAPH_PALETTE[scheme][EDGE_SLOT[kind]];
}

// --- sizes ------------------------------------------------------------------------

/**
 * The smallest a node is ever drawn, in layout units.
 *
 * A leaf still has to be clickable, and sigma's hit test is the drawn radius.
 */
export const MIN_NODE_SIZE = 3;

/**
 * The degree at which a node reaches {@link NODE_RADIUS}.
 *
 * 32 rather than "the maximum degree in this graph": a size that depends on
 * the largest hub would make every other node shrink when one module gains a
 * file, so the same note would render at two sizes on two loads of the same
 * vault. A fixed ceiling keeps size comparable across graphs and across
 * sessions.
 */
export const DEGREE_AT_MAX_SIZE = 32;

/**
 * Node radius from incident-edge degree.
 *
 * **Never larger than `NODE_RADIUS`**, and that ceiling is load-bearing rather
 * than tasteful. `layout.ts` separates nodes with a collision radius of
 * `COLLIDE_RADIUS = NODE_RADIUS + 9` and its header states the contract: *"the
 * renderer must not draw larger than this"*. §8's gate then asserts
 * `minPairwiseDistance > 2 · NODE_RADIUS` on the computed positions — which is
 * a statement about *pixels not overlapping* only for as long as this function
 * honours the same bound. Draw a hub at 24 units and the dynamics gate is
 * still green while the screen is a hairball.
 *
 * Logarithmic, so a 60-child hub reads as bigger than a 6-child module without
 * a 3-node vault becoming invisible next to it.
 */
export function nodeSize(degree: number): number {
  const d = Number.isFinite(degree) && degree > 0 ? degree : 0;
  const share = Math.min(1, Math.log2(1 + d) / Math.log2(1 + DEGREE_AT_MAX_SIZE));
  return MIN_NODE_SIZE + (NODE_RADIUS - MIN_NODE_SIZE) * share;
}

/** Edge thickness by kind. Containment is scaffolding; a wikilink is content. */
export const EDGE_SIZE: Readonly<Record<WireEdgeKind, number>> = {
  contains: 0.8,
  "anchored-at": 0.8,
  "links-to": 1.4,
  mentions: 1,
};

// --- labels -------------------------------------------------------------------------

/**
 * The label sigma draws.
 *
 * `listLabel` is core's (§3) — the same function the tree column and the
 * context rail call, so a node cannot be named one thing in one column and
 * something else in another. The provenance badge is `tree.model.ts`'s glyph,
 * for the same reason and for AGENTS.md rule 4: agent-written content must
 * never look human-authored, and a filled/half/hollow shape survives
 * greyscale, colour-blindness and a WebGL colour ramp in a way a hue does not.
 *
 * ## Why a badge rather than the ring §7.4 sketches
 *
 * §7.4 lists "ring by provenance" as `node attributes + a custom node program
 * (**only if the default is insufficient**)". A ring needs a bordered node
 * program; sigma v3 ships none, `@sigma/node-border` is a new dependency that
 * §0.1's budget process would have to clear, and hand-writing a WebGL program
 * puts a few hundred untestable lines behind the §10 wall for a visual
 * refinement. The badge carries the same information, in the same vocabulary
 * as the other two columns, at zero bytes.
 */
export function nodeLabel(node: WireGraphNode): string {
  const badge = provenanceGlyph(node.provenance);
  const label = listLabel(node);
  return badge === "" ? label : `${badge} ${label}`;
}

// --- the render model -------------------------------------------------------------

/** A node, resolved to everything the projection needs. No decisions left. */
export interface RenderNode {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly label: string;
  readonly color: string;
  readonly kind: WireNodeKind;
  readonly provenance: WireNoteSource | null;
  /** Bigger nodes paint last, so a hub is never hidden under its own leaves. */
  readonly zIndex: number;
  /** sigma's node program key. */
  readonly type: "circle";
}

/** An edge, likewise resolved. */
export interface RenderEdge {
  /** Stable and unique across the edge set — see {@link edgeKey}. */
  readonly key: string;
  readonly source: string;
  readonly target: string;
  readonly size: number;
  readonly color: string;
  readonly kind: WireEdgeKind;
  readonly zIndex: number;
  readonly type: "line";
}

/**
 * The whole drawable graph.
 *
 * Its invariants are what let `project.ts` be a loop: every {@link RenderEdge}
 * names two distinct nodes that are both in `nodes`, and every `key` and every
 * node `id` is unique. graphology *throws* on a violation of any of those, so
 * a renderer handed a malformed model does not degrade — it dies at mount.
 */
export interface RenderGraph {
  readonly nodes: readonly RenderNode[];
  readonly edges: readonly RenderEdge[];
}

/** The empty graph. What the column renders before the first payload lands. */
export const EMPTY_RENDER_GRAPH: RenderGraph = { nodes: [], edges: [] };

/**
 * A stable, unique key for an edge.
 *
 * Includes the kind, so a `contains` and a `links-to` between the same pair
 * are two edges rather than a silently dropped one. `\u0000` as the separator
 * because it cannot occur in a node id (ids are slugs and paths).
 */
export function edgeKey(edge: WireGraphEdge): string {
  return `${edge.source}\u0000${edge.target}\u0000${edge.kind}`;
}

/**
 * Incident-edge degree for every node, in one pass.
 *
 * Not `degreeOf` from `src/core/view/focus` per node: that is O(nodes × edges)
 * and this is O(edges). Core's function answers one node's degree, which is
 * the question the context rail asks; this answers all of them at once, which
 * is the question a renderer asks. Only edges that survive
 * {@link renderGraph}'s filter are counted, so a node whose only edge points
 * at a missing id is correctly a degree-0 leaf rather than a phantom hub.
 */
export function degrees(edges: readonly WireGraphEdge[], known: ReadonlySet<string>): Map<string, number> {
  const out = new Map<string, number>();
  const seen = new Set<string>();
  for (const edge of edges) {
    if (edge.source === edge.target) continue;
    if (!known.has(edge.source) || !known.has(edge.target)) continue;
    const key = edgeKey(edge);
    if (seen.has(key)) continue;
    seen.add(key);
    out.set(edge.source, (out.get(edge.source) ?? 0) + 1);
    out.set(edge.target, (out.get(edge.target) ?? 0) + 1);
  }
  return out;
}

/**
 * Resolve nodes, edges and positions into a drawable graph.
 *
 * Defensive in exactly the places `layout.ts`'s `analyse` is, and for the same
 * reason: `buildGraph` should never emit a self-edge, a duplicate, an edge to
 * a missing id or a duplicate node id, but a hand-edited or partially-rebuilt
 * `.okf` index can, and the renderer must not be the thing that throws. A
 * degenerate *input* and a degenerate *output* are different failures.
 *
 * A node with no position is dropped rather than placed at the origin.
 * `computeLayout` returns a point for every node it was given, so a miss means
 * the caller laid out a *different* graph than it is now drawing — and a pile
 * of nodes stacked at (0, 0) is the exact hairball §7.2 exists to prevent.
 */
export function renderGraph(
  nodes: readonly WireGraphNode[],
  edges: readonly WireGraphEdge[],
  positions: ReadonlyMap<string, Point>,
  scheme: ColorScheme,
): RenderGraph {
  const placed = new Map<string, WireGraphNode>();
  for (const node of nodes) {
    if (placed.has(node.id)) continue;
    const at = positions.get(node.id);
    if (at === undefined || !Number.isFinite(at.x) || !Number.isFinite(at.y)) continue;
    placed.set(node.id, node);
  }

  const known = new Set(placed.keys());
  const degree = degrees(edges, known);

  const out: RenderNode[] = [];
  for (const [id, node] of placed) {
    const at = positions.get(id) as Point;
    const size = nodeSize(degree.get(id) ?? 0);
    out.push({
      id,
      x: at.x,
      y: at.y,
      size,
      label: nodeLabel(node),
      color: kindColor(node.kind, scheme),
      kind: node.kind,
      provenance: node.provenance,
      zIndex: Math.round(size),
      type: "circle",
    });
  }

  const drawn: RenderEdge[] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    if (edge.source === edge.target) continue;
    if (!known.has(edge.source) || !known.has(edge.target)) continue;
    const key = edgeKey(edge);
    if (seen.has(key)) continue;
    seen.add(key);
    drawn.push({
      key,
      source: edge.source,
      target: edge.target,
      size: EDGE_SIZE[edge.kind],
      color: edgeColor(edge.kind, scheme),
      kind: edge.kind,
      // Under every node, always: an edge painted over a hub reads as a line
      // through it. Node zIndexes start at `MIN_NODE_SIZE` rounded, i.e. 3.
      zIndex: 0,
      type: "line",
    });
  }

  return { nodes: out, edges: drawn };
}

// --- the highlight reducers (§7.4) ---------------------------------------------------

/** What sigma's `nodeReducer` may override, as far as this module is concerned. */
export interface NodeDisplayOverride {
  readonly color?: string;
  readonly label?: string | null;
  readonly zIndex?: number;
  readonly size?: number;
}

/** What sigma's `edgeReducer` may override. */
export interface EdgeDisplayOverride {
  readonly color?: string;
  readonly hidden?: boolean;
  readonly zIndex?: number;
}

/**
 * The colour everything outside the neighbourhood fades to.
 *
 * `muted` in both schemes — the faintest slot that is still a colour rather
 * than the background. Dimming to the background would *delete* the context
 * the highlight exists to place the selection inside.
 */
export function dimColor(scheme: ColorScheme): string {
  return GRAPH_PALETTE[scheme].muted;
}

/**
 * sigma's `nodeReducer`, as a pure function (§7.4).
 *
 * `highlight` is `null` when nothing is selected, and that is deliberately not
 * the same as an empty set: nothing selected means *everything* renders
 * normally, where an empty neighbourhood (a selection that is not in this
 * graph) means everything is outside it and dims. Collapsing the two would
 * make a stale selection silently blank the column.
 *
 * Nodes outside the neighbourhood keep their position and their size and lose
 * their colour and their label. Hiding them instead would make the graph
 * *move* on selection — sigma's autoscale reframes on the visible extent — and
 * a graph that reflows when you click it is unusable.
 */
export function nodeReducer(
  highlight: ReadonlySet<string> | null,
): (id: string, data: RenderNode, scheme: ColorScheme) => NodeDisplayOverride {
  return (id, data, scheme) => {
    if (highlight === null) return {};
    if (highlight.has(id)) return { zIndex: data.zIndex + HIGHLIGHT_Z_LIFT };
    return { color: dimColor(scheme), label: null, zIndex: 0 };
  };
}

/**
 * How far a highlighted node is lifted above the rest.
 *
 * Above every unhighlighted node's z (which is at most `NODE_RADIUS` rounded)
 * so the neighbourhood paints as one layer rather than interleaved with the
 * cloud it is standing out from.
 */
export const HIGHLIGHT_Z_LIFT = NODE_RADIUS + 1;

/**
 * sigma's `edgeReducer` (§7.4).
 *
 * An edge is inside the neighbourhood only when **both** endpoints are.
 * `focusNeighborhood` returns the selection plus its direct neighbours, so
 * "both endpoints inside" is exactly the set of edges incident on the
 * selection, plus any edge that happens to join two of its neighbours — which
 * is information about the selection's neighbourhood and belongs in it.
 *
 * Outside edges are `hidden`, not dimmed. An edge is one pixel wide: a dimmed
 * one is visually indistinguishable from a drawn one at any zoom where the
 * highlight matters, and the whole point is to empty the canvas around the
 * selection.
 */
export function edgeReducer(
  highlight: ReadonlySet<string> | null,
): (key: string, data: RenderEdge) => EdgeDisplayOverride {
  return (_key, data) => {
    if (highlight === null) return {};
    return highlight.has(data.source) && highlight.has(data.target) ? { zIndex: 1 } : { hidden: true };
  };
}

// --- sigma settings (§7.4) -------------------------------------------------------------

/**
 * The sigma settings this column sets, as plain data.
 *
 * Declared here rather than inline at the `new Sigma(...)` call so that the
 * semantic-zoom tuning is a value a test can assert on. A magic number inside
 * an untestable file is a magic number nobody can check against §7.4.
 */
export interface GraphSettings {
  readonly hideEdgesOnMove: boolean;
  readonly renderEdgeLabels: boolean;
  readonly labelDensity: number;
  readonly labelGridCellSize: number;
  readonly labelRenderedSizeThreshold: number;
  readonly labelFont: string;
  readonly labelSize: number;
  readonly labelColor: { readonly color: string };
  readonly defaultNodeColor: string;
  readonly defaultEdgeColor: string;
  readonly defaultNodeType: "circle";
  readonly defaultEdgeType: "line";
  readonly minEdgeThickness: number;
  readonly zIndex: boolean;
  readonly itemSizesReference: "positions";
  readonly zoomToSizeRatioFunction: (ratio: number) => number;
  readonly stagePadding: number;
  readonly allowInvalidContainer: boolean;
}

/**
 * Semantic zoom: the rendered size below which a label is suppressed (§7.4).
 *
 * Derived, not tuned. {@link nodeSize} maps degree 0 onto
 * {@link MIN_NODE_SIZE} and `DEGREE_AT_MAX_SIZE` onto `NODE_RADIUS`, so a
 * threshold placed at the midpoint of that range means "label the nodes that
 * are structurally significant at this zoom" — hubs first, leaves once you
 * have zoomed in far enough that their rendered size crosses the line.
 */
export const LABEL_SIZE_THRESHOLD = (MIN_NODE_SIZE + NODE_RADIUS) / 2;

/**
 * Label collision grid, in screen pixels.
 *
 * `COLLIDE_RADIUS` is the layout's own answer to "how much room does a node
 * plus the leading edge of its label need", so reusing it keeps the label
 * grid and the simulation talking about the same distance instead of two
 * numbers that drift apart.
 */
export const LABEL_GRID_CELL_SIZE = COLLIDE_RADIUS * 4;

/** How much of the grid may be filled before labels start being dropped. */
export const LABEL_DENSITY = 1;

/** The settings for a scheme. */
export function graphSettings(scheme: ColorScheme): GraphSettings {
  const palette = GRAPH_PALETTE[scheme];
  return {
    // §7.4. A pan over a few thousand edges is the one interaction that drops
    // frames, and the edges are the part nobody is reading mid-gesture.
    hideEdgesOnMove: true,
    renderEdgeLabels: false,
    labelDensity: LABEL_DENSITY,
    labelGridCellSize: LABEL_GRID_CELL_SIZE,
    labelRenderedSizeThreshold: LABEL_SIZE_THRESHOLD,
    // The shell's own stack, so the graph's labels match every other column.
    labelFont: "inherit",
    labelSize: 11,
    labelColor: { color: palette.text },
    defaultNodeColor: palette.dim,
    defaultEdgeColor: palette.line,
    defaultNodeType: "circle",
    defaultEdgeType: "line",
    minEdgeThickness: 0.6,
    // Required for `RenderNode.zIndex` to mean anything at all.
    zIndex: true,
    // Sizes are in **layout units**, not screen pixels. This is what ties
    // `nodeSize`'s `NODE_RADIUS` ceiling to §8's `minPairwiseDistance`
    // assertion: under the default (`"screen"`) a node keeps its pixel size as
    // you zoom out, so a provably non-overlapping layout still renders as a
    // solid blob at low zoom.
    itemSizesReference: "positions",
    zoomToSizeRatioFunction: (ratio) => ratio,
    stagePadding: COLLIDE_RADIUS,
    // The container is a real element by construction (the renderer is mounted
    // from a `ref`), but sigma also validates that it has a non-zero size —
    // and a column that is behind a `medium` breakpoint toggle legitimately
    // has none until it is revealed. Throwing there would take the whole
    // workspace down over a column the user cannot see.
    allowInvalidContainer: true,
  };
}
