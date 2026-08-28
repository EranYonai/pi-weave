/**
 * The graph column's state: highlight, clusters, controls
 * (weave-workspace §1.2, §1.3, §7.4, §11 P3).
 *
 * This is the suite that carries the **P3 exit criterion**:
 *
 * > the repo fixture renders as 5 distinct clusters with the 60-child hub on a
 * > wide ring; selecting anywhere highlights everywhere.
 *
 * §10 makes screenshots a permanent non-option, so it is verified the way §8
 * verifies the layout — by asserting on the **computed positions** and the
 * **derived render state**. The last two describe blocks are that criterion,
 * clause by clause.
 */

import { describe, expect, it } from "vitest";
import { CONTAINS_DISTANCE, NODE_RADIUS, ringRadius } from "../../src/web/shared/layout";
import { angularOccupancy, clusterSeparation, minPairwiseDistance, variance } from "../../src/web/shared/metrics";
import { clusterAggregate, focusNeighborhood } from "../../src/web/shared/view";
import type { GraphPayload, WireGraphEdge, WireGraphNode } from "../../src/web/shared/wire";
import {
  AUTO_COLLAPSE_ABOVE,
  DEPTHS,
  EMPTY_COLUMN,
  FIT_HINT,
  FIT_LABEL,
  LEGEND,
  allExpanded,
  clusterBadge,
  collapseAll,
  depthHint,
  depthLabel,
  effectiveView,
  expandAll,
  expandHint,
  expandLabel,
  graphClick,
  graphColumnModel,
  graphCountLabel,
  graphEmptyMessage,
  highlightFor,
  initialGraphView,
  nodeTooltip,
  parseDepth,
  setDepth,
  toggleCluster,
  toggleExpandAll,
} from "../../src/web/client/graph/column.model";
import type { Depth, GraphViewState } from "../../src/web/client/graph/column.model";
import type { PositionStorage } from "../../src/web/client/graph/positions";
import { LIGHT_QUERY, schemeOf } from "../../src/web/client/graph/scheme";
import { viewModel } from "../../src/web/client/tree/tree.model";
import { REPO_LIKE_ROOTS, repoLikeGraph } from "../fixtures/graphShapes";

// --- fixtures -------------------------------------------------------------------------

function node(id: string, kind: WireGraphNode["kind"] = "note", provenance: WireGraphNode["provenance"] = null): WireGraphNode {
  return { id, kind, label: id, provenance, detail: {} };
}

function edge(source: string, target: string, kind: WireGraphEdge["kind"] = "contains"): WireGraphEdge {
  return { source, target, kind };
}

function payloadOf(nodes: WireGraphNode[], edges: WireGraphEdge[]): GraphPayload {
  return {
    model: { generatedAt: "2026-08-25T09:00:00Z", staleness: null, nodes, edges },
    tags: {},
    dangling: {},
    positions: null,
    stamp: "digest",
  };
}

/**
 * A vault of three notes and a repository with a nested module.
 *
 * Shaped so every branch is reachable: two roots, a cluster inside a cluster
 * for strict collapse, and a cross-cluster `links-to` for the highlight.
 */
const SMALL = payloadOf(
  [
    node("vault", "vault"),
    node("note:a", "note", "human"),
    node("note:b", "note", "agent"),
    node("repository", "repository"),
    node("module:src", "module"),
    node("file:src/x.ts", "file"),
  ],
  [
    edge("vault", "note:a"),
    edge("vault", "note:b"),
    edge("repository", "module:src"),
    edge("module:src", "file:src/x.ts"),
    edge("note:a", "note:b", "links-to"),
    edge("note:a", "module:src", "mentions"),
  ],
);

const SMALL_MODEL = viewModel(SMALL);

/** A throwaway in-memory `PositionStorage`. */
function storage(): PositionStorage {
  let value: string | null = null;
  return {
    getItem: () => value,
    setItem: (_k, v) => {
      value = v;
    },
    removeItem: () => {
      value = null;
    },
  };
}

const ALL_OPEN: GraphViewState = { expanded: new Set(["vault", "repository", "module:src"]), depth: 1 };
const ALL_SHUT: GraphViewState = { expanded: new Set(), depth: 1 };

// --- the view state ---------------------------------------------------------------------

describe("initialGraphView", () => {
  it("opens a small graph whole", () => {
    // A collapsed nine-note vault shows two words and reads as an empty
    // column — the same reason `initialTreeView` expands the roots eagerly.
    const view = initialGraphView(SMALL_MODEL);
    expect(view.expanded.has("vault")).toBe(true);
    expect(view.expanded.has("module:src")).toBe(true);
    expect(view.depth).toBe(1);
  });

  it("opens a large graph as its clusters", () => {
    // Above the bound a force layout of a containment tree is a disc of
    // overlapping labels however you draw it, and the honest first frame is
    // the roots with their counts.
    const nodes = [node("repository", "repository")];
    const edges: WireGraphEdge[] = [];
    for (let i = 0; i <= AUTO_COLLAPSE_ABOVE; i++) {
      nodes.push(node(`file:f${i}`, "file"));
      edges.push(edge("repository", `file:f${i}`));
    }
    expect(nodes.length).toBeGreaterThan(AUTO_COLLAPSE_ABOVE);
    expect(initialGraphView(viewModel(payloadOf(nodes, edges))).expanded.size).toBe(0);
  });

  it("names the clusters rather than carrying an 'all' flag", () => {
    // `clusterAggregate` takes a set, and the first thing a user does is
    // collapse one cluster — which has to leave the others open.
    const view = initialGraphView(SMALL_MODEL);
    const after = toggleCluster(view, "vault");
    expect(after.expanded.has("vault")).toBe(false);
    expect(after.expanded.has("repository")).toBe(true);
  });

  it("gives a fresh set per call, so two mounts cannot alias", () => {
    const a = initialGraphView(SMALL_MODEL);
    const b = initialGraphView(SMALL_MODEL);
    expect(a.expanded).not.toBe(b.expanded);
  });
});

describe("effectiveView", () => {
  it("uses the payload's default until the user touches the expansion", () => {
    expect(effectiveView(SMALL, null).expanded.size).toBeGreaterThan(0);
  });

  it("keeps the user's expansion across a refetch", () => {
    // The rule that matters: the watcher fires on every file save and the
    // client refetches, so a payload arriving must not silently re-expand
    // clusters the user collapsed.
    const chosen: GraphViewState = { expanded: new Set(["vault"]), depth: 2 };
    expect(effectiveView(SMALL, chosen)).toBe(chosen);
  });

  it("has an answer before the first payload", () => {
    const view = effectiveView(null, null);
    expect(view.expanded.size).toBe(0);
    expect(view.depth).toBe(1);
  });
});

describe("expansion reducers", () => {
  const clusters = clusterAggregate(SMALL_MODEL, new Set()).clusters;

  it("toggles one cluster without disturbing the rest", () => {
    const opened = toggleCluster(ALL_SHUT, "vault");
    expect([...opened.expanded]).toEqual(["vault"]);
    expect(toggleCluster(opened, "vault").expanded.size).toBe(0);
  });

  it("returns a new set every time, so Preact re-renders", () => {
    // `useState` bails out on `Object.is`, so an in-place `expanded.add(id)`
    // produces a correct model and a frozen screen.
    const next = toggleCluster(ALL_SHUT, "vault");
    expect(next.expanded).not.toBe(ALL_SHUT.expanded);
    expect(next).not.toBe(ALL_SHUT);
  });

  it("expands every cluster at once, not one level", () => {
    // `clusters` holds every node with a containment child whether visible or
    // not, so one press opens the whole tree. A control that needed six
    // presses would be a worse version of the tree column.
    const opened = expandAll(ALL_SHUT, clusters);
    for (const id of clusters.keys()) expect(opened.expanded.has(id), id).toBe(true);
    expect(clusterAggregate(SMALL_MODEL, opened.expanded).nodes).toHaveLength(SMALL_MODEL.nodes.length);
  });

  it("collapses back to the roots", () => {
    expect(collapseAll(ALL_OPEN).expanded.size).toBe(0);
    expect(clusterAggregate(SMALL_MODEL, collapseAll(ALL_OPEN).expanded).nodes.map((n) => n.id)).toEqual(["vault", "repository"]);
  });

  it("preserves the depth across an expansion change", () => {
    const deep: GraphViewState = { expanded: new Set(), depth: 3 };
    expect(expandAll(deep, clusters).depth).toBe(3);
    expect(collapseAll(deep).depth).toBe(3);
    expect(toggleCluster(deep, "vault").depth).toBe(3);
  });
});

describe("depth", () => {
  it("sets and short-circuits", () => {
    expect(setDepth(ALL_SHUT, 2).depth).toBe(2);
    // Identity on a no-op, so a re-render is not triggered for nothing.
    expect(setDepth(ALL_SHUT, 1)).toBe(ALL_SHUT);
  });

  it("parses the <select>'s string rather than casting it", () => {
    // An `as Depth` on unvalidated input is exactly how a `depth 7` ends up in
    // state and the highlight silently covers the whole graph.
    expect(parseDepth("2", 1)).toBe(2);
    expect(parseDepth("3", 1)).toBe(3);
    for (const bad of ["7", "0", "-1", "", "two", "1.5", "NaN"]) {
      expect(parseDepth(bad, 2), bad).toBe(2);
    }
  });

  it("offers exactly 1, 2 and 3", () => {
    // Capped because on this repository's shape the 60-child hub is two hops
    // from most of the graph — depth 4 highlights everything, and a highlight
    // that covers everything conveys nothing.
    expect(DEPTHS).toEqual([1, 2, 3]);
  });
});

// --- the highlight (§1.3, §7.4) ---------------------------------------------------------

describe("highlightFor (§7.4)", () => {
  const edges = SMALL.model.edges;

  it("is null when nothing is selected", () => {
    // Deliberately not the empty set: the reducers read `null` as "render
    // everything normally" and an empty set as "everything dims".
    expect(highlightFor(edges, null, 1)).toBeNull();
  });

  it("is exactly core's focusNeighborhood at depth 1", () => {
    // The §3 no-drift claim, made concrete: the graph's highlight and the
    // context rail's "Related" are the same set because they are the same
    // function, not two that behave alike today.
    expect(highlightFor(edges, "note:a", 1)).toEqual(focusNeighborhood("note:a", edges));
  });

  it("grows by one hop per depth", () => {
    const one = highlightFor(edges, "file:src/x.ts", 1)!;
    const two = highlightFor(edges, "file:src/x.ts", 2)!;
    const three = highlightFor(edges, "file:src/x.ts", 3)!;
    expect(one).toEqual(new Set(["file:src/x.ts", "module:src"]));
    // module:src's own neighbours: repository, note:a (a `mentions` edge).
    expect(two.has("repository")).toBe(true);
    expect(two.has("note:a")).toBe(true);
    expect(two.size).toBeGreaterThan(one.size);
    expect(three.size).toBeGreaterThan(two.size);
    // Monotone: a deeper highlight never drops something a shallower one lit.
    for (const id of one) expect(two.has(id), id).toBe(true);
    for (const id of two) expect(three.has(id), id).toBe(true);
  });

  it("stops early once the connected component is covered", () => {
    // Otherwise depth 3 on a two-node graph would walk the same set twice for
    // nothing. Asserted through the result, which is the component itself.
    const tiny = [edge("a", "b")];
    expect(highlightFor(tiny, "a", 3)).toEqual(new Set(["a", "b"]));
  });

  it("includes the selection even when nothing links to it", () => {
    // An isolated node must still light, or selecting it would dim the entire
    // graph including the thing that was selected.
    expect(highlightFor(edges, "lonely", 2)).toEqual(new Set(["lonely"]));
  });

  it("is empty of the graph when the selection is not in it", () => {
    // A stale selection from a previous payload. Everything dims, which is a
    // true statement — nothing here is related to it.
    const highlight = highlightFor(edges, "note:gone", 1)!;
    expect(highlight.has("vault")).toBe(false);
  });
});

describe("the §1.3 context bus reaches the graph", () => {
  it("gives the identical highlight whichever column made the selection", () => {
    // "Selecting in the tree must highlight in the graph" is not code — it is
    // the *absence* of code. There is one signal, and the highlight is derived
    // from it, so a tree-driven and a graph-driven selection cannot differ.
    // This asserts that literally: same id, same edges, same set.
    const viaGraph = graphClick(ALL_OPEN, clusterAggregate(SMALL_MODEL, ALL_OPEN.expanded).clusters, "note:b");
    const fromTree = "note:b";
    expect(viaGraph.selectedId).toBe(fromTree);
    expect(highlightFor(SMALL.model.edges, viaGraph.selectedId, 1)).toEqual(highlightFor(SMALL.model.edges, fromTree, 1));
  });

  it("drives the column model from a selection the graph never made", () => {
    const model = graphColumnModel(SMALL, "note:a", ALL_OPEN, storage(), "dark");
    expect(model.highlight?.has("note:a")).toBe(true);
    expect(model.highlight?.has("note:b")).toBe(true);
    // …and something unrelated is outside it, so the highlight is doing work.
    expect(model.highlight?.has("file:src/x.ts")).toBe(false);
  });
});

// --- the control strip (§1.2) ----------------------------------------------------------------

describe("the control strip (§1.2)", () => {
  const clusters = clusterAggregate(SMALL_MODEL, new Set()).clusters;

  it("labels and explains the depth control", () => {
    expect(depthLabel(1)).toBe("depth 1");
    expect(depthLabel(3)).toBe("depth 3");
    expect(depthHint(1)).toContain("direct neighbours");
    expect(depthHint(2)).toContain("2 hops");
  });

  it("labels the expand control by what pressing it will do", () => {
    expect(expandLabel(false)).toBe("expand");
    expect(expandLabel(true)).toBe("collapse");
    expect(expandHint(false)).toContain("expand");
    expect(expandHint(true)).toContain("collapse");
  });

  it("knows when everything is open", () => {
    expect(allExpanded(ALL_OPEN, clusters)).toBe(true);
    expect(allExpanded(ALL_SHUT, clusters)).toBe(false);
    expect(allExpanded(toggleCluster(ALL_OPEN, "vault"), clusters)).toBe(false);
  });

  it("reports a graph with no clusters as not-all-expanded", () => {
    // Otherwise a flat graph would render a `collapse` button that does
    // nothing, which reads as broken.
    expect(allExpanded(ALL_SHUT, new Map())).toBe(false);
  });

  it("pairs the toggle's effect with its label, in one place", () => {
    // The label and the action read the same predicate, so they cannot
    // disagree — a `collapse` button that expands is the classic version of
    // this bug.
    expect(allExpanded(toggleExpandAll(ALL_SHUT, clusters), clusters)).toBe(true);
    expect(toggleExpandAll(ALL_OPEN, clusters).expanded.size).toBe(0);
  });

  it("names the fit control and the legend", () => {
    expect(FIT_LABEL).toBe("fit");
    expect(FIT_HINT).toContain("whole graph");
    // The §1.2 mock's `◉ selected  ● neighborhood`.
    expect(LEGEND.selected).toBe("selected");
    expect(LEGEND.neighborhood).toBe("neighborhood");
  });

  it("counts what is visible against what exists", () => {
    // "89 nodes" beside a canvas showing 5 is what makes a collapsed graph
    // look broken.
    expect(graphCountLabel(5, 89)).toBe("5 of 89 nodes");
    expect(graphCountLabel(89, 89)).toBe("89 nodes");
    expect(graphCountLabel(1, 1)).toBe("1 node");
    expect(graphCountLabel(0, 0)).toBe("0 nodes");
  });
});

describe("graphEmptyMessage", () => {
  it("distinguishes loading from empty from collapsed-to-nothing", () => {
    expect(graphEmptyMessage(null, 0)).toBe("Loading…");
    expect(graphEmptyMessage(payloadOf([], []), 0)).toContain("weave-scan");
    expect(graphEmptyMessage(SMALL, 0)).toContain("expansion");
    expect(graphEmptyMessage(SMALL, 6)).toBeNull();
  });
});

// --- clicking (§7.4) ---------------------------------------------------------------------------

describe("graphClick (§7.4)", () => {
  const clusters = clusterAggregate(SMALL_MODEL, ALL_SHUT.expanded).clusters;

  it("selects and expands a collapsed cluster, both", () => {
    // Dropping the selection in favour of the expansion would make clicking a
    // module the one gesture in the workspace that does not update the other
    // columns (§1.1).
    const click = graphClick(ALL_SHUT, clusters, "vault");
    expect(click.selectedId).toBe("vault");
    expect(click.state.expanded.has("vault")).toBe(true);
  });

  it("selects an already-expanded cluster without collapsing it", () => {
    // A second click closing it would make it impossible to select a cluster
    // and read it. Collapse is the `[expand]` control and the tree.
    const click = graphClick(ALL_OPEN, clusters, "vault");
    expect(click.selectedId).toBe("vault");
    expect(click.state).toBe(ALL_OPEN);
  });

  it("selects a leaf without touching the expansion", () => {
    const click = graphClick(ALL_OPEN, clusters, "note:a");
    expect(click.selectedId).toBe("note:a");
    expect(click.state).toBe(ALL_OPEN);
  });

  it("clears the selection on a click off any node", () => {
    const click = graphClick(ALL_OPEN, clusters, null);
    expect(click.selectedId).toBeNull();
    expect(click.state).toBe(ALL_OPEN);
  });
});

// --- tooltips ------------------------------------------------------------------------------------

describe("tooltips", () => {
  it("badges a cluster with what it is standing in for", () => {
    const reduced = clusterAggregate(SMALL_MODEL, new Set(["repository"]));
    // `module:src` is visible and collapsed, so it represents its own subtree.
    expect(clusterBadge(reduced.clusters.get("module:src"))).toBe("1 hidden");
  });

  it("counts members, not descendants, so nothing is counted twice", () => {
    // `descendants` overlaps freely between a cluster and its ancestors and
    // would report the same file under both `src/core` and `repository`.
    // `members` partitions the hidden set across the visible clusters.
    const reduced = clusterAggregate(SMALL_MODEL, new Set());
    const repository = reduced.clusters.get("repository")!;
    expect(repository.descendants).toHaveLength(2);
    expect(clusterBadge(repository)).toBe("2 hidden");
    // `module:src` is itself hidden, so it stands in for nothing.
    expect(clusterBadge(reduced.clusters.get("module:src"))).toBeNull();
  });

  it("has no badge for a leaf or an expanded cluster", () => {
    expect(clusterBadge(undefined)).toBeNull();
    expect(clusterBadge(clusterAggregate(SMALL_MODEL, ALL_OPEN.expanded).clusters.get("vault"))).toBeNull();
  });

  it("reads label, degree and hidden count", () => {
    const reduced = clusterAggregate(SMALL_MODEL, new Set());
    const repository = SMALL.model.nodes.find((n) => n.id === "repository")!;
    expect(nodeTooltip(repository, reduced.edges, reduced.clusters.get("repository"))).toBe("repository · 1 link · 2 hidden");
    const vault = SMALL.model.nodes.find((n) => n.id === "vault")!;
    expect(nodeTooltip(vault, SMALL.model.edges, undefined)).toBe("vault · 2 links");
  });
});

// --- the scheme port -------------------------------------------------------------------------------

describe("schemeOf", () => {
  it("reads prefers-color-scheme", () => {
    expect(schemeOf({ matchMedia: (q) => ({ matches: q === LIGHT_QUERY }) })).toBe("light");
    expect(schemeOf({ matchMedia: () => ({ matches: false }) })).toBe("dark");
  });

  it("defaults to dark, matching the sheet the user ends up looking at", () => {
    // `shell/theme.ts` is dark-first with a light override; `page.ts`'s
    // pre-paint block is still light-first (§15.1's known debt). A graph in
    // the wrong palette is legible; a graph that threw at mount is not.
    expect(schemeOf(null)).toBe("dark");
    expect(schemeOf(undefined)).toBe("dark");
    expect(schemeOf({} as never)).toBe("dark");
  });
});

// --- the column model end to end ---------------------------------------------------------------------

describe("graphColumnModel", () => {
  it("is empty before the first payload", () => {
    expect(graphColumnModel(null, null, ALL_SHUT, storage(), "dark")).toBe(EMPTY_COLUMN);
    expect(EMPTY_COLUMN.graph.nodes).toEqual([]);
    expect(EMPTY_COLUMN.highlight).toBeNull();
  });

  it("draws the reduced graph, not the full one", () => {
    // §7.4: "A renderer should never be handed nodes it is expected to hide."
    const collapsed = graphColumnModel(SMALL, null, ALL_SHUT, storage(), "dark");
    expect(collapsed.graph.nodes.map((n) => n.id).sort()).toEqual(["repository", "vault"]);
    expect(collapsed.visible).toBe(2);
    expect(collapsed.total).toBe(6);
  });

  it("draws everything when everything is expanded", () => {
    const open = graphColumnModel(SMALL, null, ALL_OPEN, storage(), "dark");
    expect(open.visible).toBe(6);
    expect(open.total).toBe(6);
    expect(open.empty).toBeNull();
  });

  it("retargets a boundary-crossing edge onto the cluster standing in for it", () => {
    // The retired viewer's bug, and the reason `clusterAggregate` is reduction
    // rather than masking: `note:a --mentions--> module:src` must survive a
    // collapsed `repository` as an edge to `repository`, not vanish.
    const state: GraphViewState = { expanded: new Set(["vault"]), depth: 1 };
    const model = graphColumnModel(SMALL, null, state, storage(), "dark");
    const mention = model.graph.edges.find((e) => e.kind === "mentions");
    expect(mention?.source).toBe("note:a");
    expect(mention?.target).toBe("repository");
  });

  it("highlights over the visible edges, so a hidden neighbour lights its cluster", () => {
    // Highlighting the hidden id would light nothing while leaving the cluster
    // that actually represents it dimmed.
    const state: GraphViewState = { expanded: new Set(["vault"]), depth: 1 };
    const model = graphColumnModel(SMALL, "note:a", state, storage(), "dark");
    expect(model.highlight?.has("repository")).toBe(true);
    expect(model.highlight?.has("module:src")).toBe(false);
  });

  it("gives each expansion its own layout cache entry", () => {
    // Every expand and collapse is a genuinely different graph, so it gets its
    // own shape key — which means collapsing and re-expanding returns the
    // arrangement the user had rather than a fresh one.
    const store = storage();
    const open = graphColumnModel(SMALL, null, ALL_OPEN, store, "dark");
    const shut = graphColumnModel(SMALL, null, ALL_SHUT, store, "dark");
    expect(open.key).not.toBe(shut.key);
    expect(graphColumnModel(SMALL, null, ALL_SHUT, store, "dark").cached).toBe(true);
  });

  it("lays out the reduced graph, not the full one with holes in it", () => {
    // Laying out everything and then hiding nodes would leave the visible ones
    // spread across the gaps the hidden ones left — the collapsed view would
    // have the geometry of the expanded one.
    const collapsed = graphColumnModel(SMALL, null, ALL_SHUT, storage(), "dark");
    const points = collapsed.graph.nodes.map((n) => ({ x: n.x, y: n.y }));
    expect(points).toHaveLength(2);
    // Two roots, placed on the seeding ring — far apart, and both finite.
    expect(minPairwiseDistance(points)).toBeGreaterThan(2 * NODE_RADIUS);
    for (const p of points) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
  });

  it("honours the colour scheme end to end", () => {
    const dark = graphColumnModel(SMALL, null, ALL_OPEN, storage(), "dark");
    const light = graphColumnModel(SMALL, null, ALL_OPEN, storage(), "light");
    expect(dark.graph.nodes[0]?.color).not.toBe(light.graph.nodes[0]?.color);
  });

  it("reports an empty payload honestly", () => {
    const model = graphColumnModel(payloadOf([], []), null, ALL_SHUT, storage(), "dark");
    expect(model.visible).toBe(0);
    expect(model.empty).toContain("weave-scan");
  });
});

// --- THE P3 EXIT CRITERION (§11) ------------------------------------------------------------------------

/**
 * > *Exit:* the repo fixture renders as 5 distinct clusters with the 60-child
 * > hub on a wide ring; selecting anywhere highlights everywhere.
 *
 * Verified the way §8 verifies the layout — on the computed positions and the
 * derived render state — because §10 makes screenshots a permanent
 * non-option. The thresholds are the dynamics gate's own, imported from
 * `shared/layout` and `shared/metrics` rather than restated, so this cannot
 * drift from the gate that proved the geometry.
 */
describe("P3 exit criterion — the repo fixture renders as 5 clusters (§11)", () => {
  const fixture = repoLikeGraph();
  const payload = payloadOf([...fixture.nodes], [...fixture.edges]);
  const model = viewModel(payload);
  const everything: GraphViewState = { expanded: new Set(clusterAggregate(model, new Set()).clusters.keys()), depth: 1 };
  const column = graphColumnModel(payload, null, everything, storage(), "dark");
  const positionOf = (id: string) => {
    const drawn = column.graph.nodes.find((n) => n.id === id);
    return drawn === undefined ? undefined : { x: drawn.x, y: drawn.y };
  };

  it("draws all 89 nodes of the fixture", () => {
    expect(column.graph.nodes).toHaveLength(fixture.nodes.length);
    expect(column.visible).toBe(column.total);
  });

  it("keeps the five clusters distinct", () => {
    // §8's `MIN_SEP`: two anchors at least one containment ring apart, so
    // their children's rings cannot interpenetrate.
    const positions = new Map(column.graph.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
    for (const root of REPO_LIKE_ROOTS) expect(positions.has(root), root).toBe(true);
    expect(clusterSeparation(positions, REPO_LIKE_ROOTS)).toBeGreaterThan(2 * CONTAINS_DISTANCE);
  });

  it("arranges the five clusters in two dimensions, not on a line", () => {
    // The literal reported symptom of the retired viewer, asserted on the
    // anchors specifically — whole-cloud variance stays healthy while the
    // anchors are squeezed onto one axis (§8's measured 5,000 vs 52,000).
    const anchors = REPO_LIKE_ROOTS.map((id) => positionOf(id)!);
    expect(anchors).toHaveLength(5);
    const minAxisVariance = Math.pow(800 / 10, 2);
    expect(variance(anchors.map((p) => p.x))).toBeGreaterThan(minAxisVariance);
    expect(variance(anchors.map((p) => p.y))).toBeGreaterThan(minAxisVariance);
  });

  it("puts the 60-child hub on a wide ring", () => {
    // "Wide" is `ringRadius(60)`, which is derived geometry — the radius whose
    // circumference holds 60 siblings a collision diameter apart — not a
    // tuned pixel count. Every leaf within a factor of two of it, and the ring
    // occupying at least nine of twelve compass sectors.
    const hub = positionOf("repository")!;
    const leaves = column.graph.nodes.filter((n) => n.id.startsWith("module:src/m")).map((n) => ({ x: n.x, y: n.y }));
    expect(leaves).toHaveLength(60);

    const target = ringRadius(60);
    expect(target).toBeGreaterThan(CONTAINS_DISTANCE);
    const radii = leaves.map((p) => Math.hypot(p.x - hub.x, p.y - hub.y));
    expect(Math.min(...radii)).toBeGreaterThan(target / 2);
    expect(Math.max(...radii)).toBeLessThan(target * 2);
    expect(angularOccupancy(hub, leaves, 12)).toBeGreaterThanOrEqual(9);
  });

  it("draws no two nodes on top of each other", () => {
    // §8 proves this of the positions; this proves it of what is *drawn*,
    // which additionally needs every rendered radius inside the same budget.
    const points = column.graph.nodes.map((n) => ({ x: n.x, y: n.y }));
    expect(minPairwiseDistance(points)).toBeGreaterThan(2 * NODE_RADIUS);
    for (const drawn of column.graph.nodes) expect(drawn.size, drawn.id).toBeLessThanOrEqual(NODE_RADIUS);
  });

  it("collapses to exactly the five clusters", () => {
    // The other half of "renders as 5 clusters": collapsed, the canvas holds
    // the five roots and nothing else, with every hidden node accounted for by
    // one of them.
    const collapsed = graphColumnModel(payload, null, { expanded: new Set(), depth: 1 }, storage(), "dark");
    expect(collapsed.graph.nodes.map((n) => n.id).sort()).toEqual([...REPO_LIKE_ROOTS].sort());
    const hidden = collapsed.total - collapsed.visible;
    const badged = REPO_LIKE_ROOTS.map((id) => clusterAggregate(model, new Set()).clusters.get(id))
      .map((c) => c?.members.length ?? 0)
      .reduce((a, b) => a + b, 0);
    expect(badged).toBe(hidden);
  });
});

describe("P3 exit criterion — selecting anywhere highlights everywhere (§11, §1.3)", () => {
  const fixture = repoLikeGraph();
  const payload = payloadOf([...fixture.nodes], [...fixture.edges]);
  const model = viewModel(payload);
  const everything: GraphViewState = { expanded: new Set(clusterAggregate(model, new Set()).clusters.keys()), depth: 1 };

  it("lights the selection and its neighbours, and dims the rest", () => {
    // The derived render state, not pixels: run the column's own reducers over
    // the drawn nodes and count what each one would be painted as.
    const column = graphColumnModel(payload, "note:n000", everything, storage(), "dark");
    const highlight = column.highlight!;
    // `note:n000` links to `note:n003`-ish, `module:src/m000`, and is
    // contained by `vault` — a genuinely cross-cluster neighbourhood.
    expect(highlight.has("note:n000")).toBe(true);
    expect(highlight.has("vault")).toBe(true);
    expect(highlight.has("module:src/m000")).toBe(true);
    // And it is a small fraction of an 89-node graph, so the dimming is doing
    // real work rather than lighting everything.
    expect(highlight.size).toBeGreaterThan(2);
    expect(highlight.size).toBeLessThan(column.graph.nodes.length / 4);
  });

  it("reaches across a cluster boundary, which is what 'everywhere' means", () => {
    // A highlight confined to one cluster would satisfy a naive reading of the
    // criterion. The fixture's three cross-cluster edges exist precisely so
    // this can be asserted: selecting a note lights a module.
    const column = graphColumnModel(payload, "note:n003", everything, storage(), "dark");
    expect(column.highlight?.has("module:src/m031")).toBe(true);
    const mention = graphColumnModel(payload, "note:n007", everything, storage(), "dark");
    expect(mention.highlight?.has("file:mod002.ts")).toBe(true);
  });

  it("gives the same answer whichever column originated the selection", () => {
    // §1.3 in one assertion. There is one signal; the tree writes it, the
    // graph writes it, and the highlight is derived from it — so a selection
    // made in the tree and the same selection made by clicking a node cannot
    // produce different render state.
    const clusters = clusterAggregate(model, everything.expanded).clusters;
    const fromGraph = graphClick(everything, clusters, "module:src/m031").selectedId;
    const fromTree = "module:src/m031";
    expect(fromGraph).toBe(fromTree);
    const a = graphColumnModel(payload, fromGraph, everything, storage(), "dark");
    const b = graphColumnModel(payload, fromTree, everything, storage(), "dark");
    expect(a.highlight).toEqual(b.highlight);
  });

  it("widens with depth, and covers more of the graph at 3 than at 1", () => {
    const at = (depth: Depth) => graphColumnModel(payload, "note:n000", { ...everything, depth }, storage(), "dark").highlight!;
    expect(at(2).size).toBeGreaterThan(at(1).size);
    expect(at(3).size).toBeGreaterThan(at(2).size);
  });

  it("lights a collapsed cluster when the selection's neighbour is inside it", () => {
    // With `repository` collapsed, `note:n000 --links-to--> module:src/m000`
    // has been retargeted onto `repository` — so selecting the note must light
    // the cluster standing in for the module, not nothing.
    const collapsed: GraphViewState = { expanded: new Set(["vault"]), depth: 1 };
    const column = graphColumnModel(payload, "note:n000", collapsed, storage(), "dark");
    expect(column.highlight?.has("repository")).toBe(true);
    expect(column.graph.nodes.some((n) => n.id === "module:src/m000")).toBe(false);
  });
});
