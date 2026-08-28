/**
 * The graph column's pure model and its graphology projection
 * (weave-workspace §7, §10, P3).
 *
 * §10's split is sharper here than anywhere else in the client. Sigma needs a
 * real canvas and a WebGL context, so `graph/renderer.ts`'s `SigmaRenderer` is
 * *structurally* untestable in this repository — there is no DOM environment
 * and §10 forbids adding one. The response is not to lower the bar; it is to
 * make sure the untestable file decides nothing:
 *
 * | File | Testable | Why |
 * | --- | --- | --- |
 * | `graph/graph.model.ts` | ✅ every line | pure; names no DOM type, imports no npm |
 * | `graph/project.ts` | ✅ every line | graphology is a plain data structure |
 * | `graph/renderer.ts` | interface + `nullRenderer` only | `SigmaRenderer` needs WebGL |
 *
 * So this suite *is* the graph column's coverage of everything that makes a
 * decision, and the assertions below are deliberately about the numbers and
 * the sets — never about pixels, which §10 puts permanently out of scope.
 */

import { describe, expect, it } from "vitest";
import { COLLIDE_RADIUS, NODE_RADIUS, computeLayout } from "../../src/web/shared/layout";
import type { Point } from "../../src/web/shared/layout";
import type { WireGraphEdge, WireGraphNode, WireNodeKind } from "../../src/web/shared/wire";
import { WIRE_EDGE_KINDS, WIRE_NODE_KINDS } from "../../src/web/shared/wire";
import {
  DEGREE_AT_MAX_SIZE,
  EDGE_SIZE,
  EDGE_SLOT,
  EMPTY_RENDER_GRAPH,
  GRAPH_PALETTE,
  HIGHLIGHT_Z_LIFT,
  KIND_SLOT,
  LABEL_DENSITY,
  LABEL_GRID_CELL_SIZE,
  LABEL_SIZE_THRESHOLD,
  MIN_NODE_SIZE,
  degrees,
  dimColor,
  edgeColor,
  edgeKey,
  edgeReducer,
  graphSettings,
  kindColor,
  nodeLabel,
  nodeReducer,
  nodeSize,
  renderGraph,
} from "../../src/web/client/graph/graph.model";
import type {
  ColorScheme,
  EdgeDisplayOverride,
  GraphSettings,
  NodeDisplayOverride,
  RenderEdge,
  RenderGraph,
  RenderNode,
} from "../../src/web/client/graph/graph.model";
import { emptyProjection, positionsOf, project, syncPositions } from "../../src/web/client/graph/project";
import { nullRenderer, sigmaRenderer } from "../../src/web/client/graph/renderer";
import type { RenderContainer, SigmaFactory, SigmaLike } from "../../src/web/client/graph/renderer";
import { THEME_CSS } from "../../src/web/client/shell/theme";
import { repoLikeGraph } from "../fixtures/graphShapes";

// --- fixtures -----------------------------------------------------------------------

function node(id: string, kind: WireNodeKind, label = id, provenance: WireGraphNode["provenance"] = null): WireGraphNode {
  return { id, kind, label, provenance, detail: {} };
}

function edge(source: string, target: string, kind: WireGraphEdge["kind"] = "contains"): WireGraphEdge {
  return { source, target, kind };
}

function at(entries: Array<[string, number, number]>): Map<string, Point> {
  return new Map(entries.map(([id, x, y]) => [id, { x, y }]));
}

const SCHEMES: readonly ColorScheme[] = ["dark", "light"];

// --- the palette ---------------------------------------------------------------------

describe("the graph palette is the shell's palette (§7.4)", () => {
  it("uses only colours the stylesheet actually declares", () => {
    // The guard that makes duplication safe. WebGL cannot read a CSS custom
    // property, so the six theme colours the graph draws with have to exist as
    // literals in the bundle — and a literal copy of a stylesheet value is a
    // copy that drifts. Change `--weave-accent` in `theme.ts` and this goes
    // red on the same commit, which is the only reason the copy is allowed.
    for (const scheme of SCHEMES) {
      for (const [slot, hex] of Object.entries(GRAPH_PALETTE[scheme])) {
        expect(THEME_CSS, `${scheme}.${slot}`).toContain(hex);
      }
    }
  });

  it("gives dark and light genuinely different palettes", () => {
    // A copy-paste that duplicated one scheme into both would satisfy the
    // check above and produce an unreadable graph in one of the two.
    for (const slot of Object.keys(GRAPH_PALETTE.dark) as Array<keyof (typeof GRAPH_PALETTE)["dark"]>) {
      expect(GRAPH_PALETTE.dark[slot], slot).not.toBe(GRAPH_PALETTE.light[slot]);
    }
  });

  it("assigns every node kind and every edge kind a slot", () => {
    // `WIRE_NODE_KINDS` is pinned element-for-element against core's
    // `NODE_KINDS` by `wire.contract.test.ts`, so a kind added to core and
    // forgotten here fails as a missing colour rather than as a node drawn in
    // the default grey with nobody noticing.
    for (const kind of WIRE_NODE_KINDS) {
      expect(KIND_SLOT[kind], kind).toBeTypeOf("string");
      for (const scheme of SCHEMES) expect(kindColor(kind, scheme)).toMatch(/^#[0-9a-f]{6}$/);
    }
    for (const kind of WIRE_EDGE_KINDS) {
      expect(EDGE_SLOT[kind], kind).toBeTypeOf("string");
      for (const scheme of SCHEMES) expect(edgeColor(kind, scheme)).toMatch(/^#[0-9a-f]{6}$/);
      expect(EDGE_SIZE[kind], kind).toBeGreaterThan(0);
    }
  });

  it("uses the TUI's kind vocabulary rather than a second one", () => {
    // Mirrors `kindStyle` in `src/pi/viewer/tui/theme.ts`, which the client
    // tier may not import. Spot-checked on the assignments that carry meaning:
    // containers are the accent, code is success, plumbing is a warning, and a
    // note defers to its provenance badge.
    expect(KIND_SLOT.vault).toBe("accent");
    expect(KIND_SLOT.repository).toBe("accent");
    expect(KIND_SLOT.module).toBe("success");
    expect(KIND_SLOT.package).toBe("success");
    expect(KIND_SLOT.gitState).toBe("warning");
    expect(KIND_SLOT.external).toBe("warning");
    expect(KIND_SLOT.entryPoint).toBe("warning");
    expect(KIND_SLOT.file).toBe("dim");
    expect(KIND_SLOT.note).toBe("text");
  });

  it("dims to a colour, never to the background", () => {
    for (const scheme of SCHEMES) {
      expect(dimColor(scheme)).toBe(GRAPH_PALETTE[scheme].muted);
      // The background is `--weave-bg`, which is not in the palette at all —
      // dimming to it would delete the context the highlight exists to show.
      expect(dimColor(scheme)).not.toBe(GRAPH_PALETTE[scheme].text);
    }
  });
});

// --- sizes ---------------------------------------------------------------------------

describe("node size (§7.2, §8)", () => {
  it("never exceeds NODE_RADIUS — the contract §8's gate depends on", () => {
    // `layout.ts` separates nodes by `COLLIDE_RADIUS = NODE_RADIUS + 9` and
    // the dynamics gate asserts `minPairwiseDistance > 2 · NODE_RADIUS`. That
    // assertion is only a statement about *pixels not overlapping* while the
    // renderer honours the same ceiling. Draw a hub at 24 and the gate stays
    // green over a hairball.
    for (const degree of [0, 1, 2, 7, 32, 60, 200, 5000]) {
      expect(nodeSize(degree), `degree ${degree}`).toBeLessThanOrEqual(NODE_RADIUS);
      expect(nodeSize(degree), `degree ${degree}`).toBeGreaterThanOrEqual(MIN_NODE_SIZE);
    }
  });

  it("is monotonic in degree and reaches the ceiling at DEGREE_AT_MAX_SIZE", () => {
    expect(nodeSize(0)).toBe(MIN_NODE_SIZE);
    expect(nodeSize(DEGREE_AT_MAX_SIZE)).toBeCloseTo(NODE_RADIUS, 10);
    let previous = -Infinity;
    for (let d = 0; d <= 64; d++) {
      const size = nodeSize(d);
      expect(size, `degree ${d}`).toBeGreaterThanOrEqual(previous);
      previous = size;
    }
  });

  it("separates a hub from a leaf without making the leaf invisible", () => {
    // The point of the log curve: 60 children must read as bigger than 6, and
    // a degree-0 note must still be clickable.
    expect(nodeSize(60)).toBeGreaterThan(nodeSize(6));
    expect(nodeSize(6)).toBeGreaterThan(nodeSize(0));
    expect(nodeSize(0)).toBeGreaterThan(0);
  });

  it("treats a degenerate degree as zero rather than producing NaN", () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(nodeSize(bad), String(bad)).toBe(MIN_NODE_SIZE);
    }
  });
});

// --- labels ---------------------------------------------------------------------------

describe("node labels (§3, AGENTS.md rule 4)", () => {
  it("uses core's listLabel, so no node is named two things in two columns", () => {
    // `listLabel` disambiguates a package by its manifest; if this file had
    // its own labelling rule the graph would say `pkg` where the tree says
    // `pkg (packages/a/package.json)`.
    const pkg: WireGraphNode = {
      id: "package:a",
      kind: "package",
      label: "pkg",
      provenance: null,
      detail: { manifest: "packages/a/package.json" },
    };
    expect(nodeLabel(pkg)).toBe("pkg (packages/a/package.json)");
  });

  it("prefixes a provenance badge, so agent content never looks human-authored", () => {
    expect(nodeLabel(node("note:a", "note", "Alpha", "human"))).toBe("● Alpha");
    expect(nodeLabel(node("note:b", "note", "Beta", "agent"))).toBe("◐ Beta");
    expect(nodeLabel(node("note:c", "note", "Gamma", "generated"))).toBe("○ Gamma");
  });

  it("gives a structural node no badge at all", () => {
    expect(nodeLabel(node("module:src", "module", "src"))).toBe("src");
  });
});

// --- degrees ------------------------------------------------------------------------------

describe("degrees", () => {
  const known = new Set(["a", "b", "c"]);

  it("counts both directions", () => {
    const d = degrees([edge("a", "b"), edge("c", "a")], known);
    expect(d.get("a")).toBe(2);
    expect(d.get("b")).toBe(1);
    expect(d.get("c")).toBe(1);
  });

  it("ignores self-edges, duplicates and edges naming a missing node", () => {
    // Exactly the filter `renderGraph` applies, so a node whose only edge is
    // dropped is a degree-0 leaf rather than a phantom hub drawn large.
    const d = degrees(
      [edge("a", "a"), edge("a", "b"), edge("a", "b"), edge("a", "ghost"), edge("ghost", "b")],
      known,
    );
    expect(d.get("a")).toBe(1);
    expect(d.get("b")).toBe(1);
    expect(d.has("ghost")).toBe(false);
  });

  it("distinguishes two kinds between the same pair", () => {
    const d = degrees([edge("a", "b", "contains"), edge("a", "b", "links-to")], known);
    expect(d.get("a")).toBe(2);
  });

  it("returns an empty map for no edges", () => {
    expect(degrees([], known).size).toBe(0);
  });
});

describe("edgeKey", () => {
  it("is unique per (source, target, kind)", () => {
    expect(edgeKey(edge("a", "b", "contains"))).not.toBe(edgeKey(edge("a", "b", "links-to")));
    expect(edgeKey(edge("a", "b"))).not.toBe(edgeKey(edge("b", "a")));
    expect(edgeKey(edge("a", "b"))).toBe(edgeKey(edge("a", "b")));
  });

  it("cannot be forged by an id containing the separator's printable form", () => {
    // Ids are slugs and paths, so a NUL cannot occur in one — which is why it
    // is the separator. A colon or a slash could collide.
    expect(edgeKey(edge("a:b", "c", "contains"))).not.toBe(edgeKey(edge("a", "b:c", "contains")));
  });
});

// --- renderGraph ------------------------------------------------------------------------

describe("renderGraph", () => {
  const nodes = [node("a", "vault", "Vault"), node("b", "note", "Beta", "human"), node("c", "file", "c.ts")];
  const edges = [edge("a", "b"), edge("b", "c", "links-to")];
  const positions = at([
    ["a", 0, 0],
    ["b", 10, 20],
    ["c", -5, 7],
  ]);

  it("carries positions through verbatim", () => {
    // The projection must not "improve" a position. `layout.ts` is the only
    // thing that decides where a node is (§7.1).
    const model = renderGraph(nodes, edges, positions, "dark");
    expect(model.nodes.map((n) => [n.id, n.x, n.y])).toEqual([
      ["a", 0, 0],
      ["b", 10, 20],
      ["c", -5, 7],
    ]);
  });

  it("resolves colour, size, label and kind for every node", () => {
    const model = renderGraph(nodes, edges, positions, "dark");
    const beta = model.nodes.find((n) => n.id === "b");
    expect(beta?.color).toBe(kindColor("note", "dark"));
    expect(beta?.label).toBe("● Beta");
    expect(beta?.kind).toBe("note");
    expect(beta?.provenance).toBe("human");
    expect(beta?.size).toBe(nodeSize(2));
    expect(beta?.type).toBe("circle");
  });

  it("honours the colour scheme", () => {
    const dark = renderGraph(nodes, edges, positions, "dark");
    const light = renderGraph(nodes, edges, positions, "light");
    expect(dark.nodes[0]?.color).not.toBe(light.nodes[0]?.color);
    expect(dark.edges[0]?.color).not.toBe(light.edges[0]?.color);
  });

  it("paints bigger nodes later and every edge under every node", () => {
    // A hub hidden under its own leaves, or an edge drawn through a node, are
    // both z-order bugs no test can see in a screenshot we are not allowed to
    // take. They are visible here as numbers.
    const model = renderGraph(nodes, edges, positions, "dark");
    const minNodeZ = Math.min(...model.nodes.map((n) => n.zIndex));
    const maxEdgeZ = Math.max(...model.edges.map((e) => e.zIndex));
    expect(maxEdgeZ).toBeLessThan(minNodeZ);
    const hub = model.nodes.find((n) => n.id === "a");
    const leaf = model.nodes.find((n) => n.id === "c");
    expect(hub?.zIndex).toBeGreaterThanOrEqual(leaf?.zIndex ?? 0);
  });

  it("drops a node with no position rather than stacking it at the origin", () => {
    // `computeLayout` returns a point for every node it was given, so a miss
    // means the caller laid out a different graph than it is drawing. A pile
    // at (0, 0) is the exact hairball §7.2 exists to prevent.
    const model = renderGraph(nodes, edges, at([["a", 1, 1]]), "dark");
    expect(model.nodes.map((n) => n.id)).toEqual(["a"]);
    expect(model.edges).toEqual([]);
  });

  it("drops a node whose position is not finite", () => {
    const poisoned = new Map<string, Point>([
      ["a", { x: Number.NaN, y: 0 }],
      ["b", { x: 0, y: Number.POSITIVE_INFINITY }],
      ["c", { x: 3, y: 4 }],
    ]);
    const model = renderGraph(nodes, edges, poisoned, "dark");
    expect(model.nodes.map((n) => n.id)).toEqual(["c"]);
  });

  it("survives the degenerate edges buildGraph should never emit", () => {
    // A degenerate *input* and a degenerate *output* are different failures —
    // the same distinction `pathologicalGraph` makes for the layout. Every one
    // of these makes graphology throw if it reaches the projection.
    const model = renderGraph(
      nodes,
      [edge("a", "a"), edge("a", "b"), edge("a", "b"), edge("a", "ghost"), edge("ghost", "b")],
      positions,
      "dark",
    );
    expect(model.edges).toHaveLength(1);
    expect(model.edges[0]?.source).toBe("a");
    expect(model.edges[0]?.target).toBe("b");
  });

  it("collapses a duplicate node id to the first occurrence", () => {
    const model = renderGraph(
      [node("dup", "note", "First", "human"), node("dup", "note", "Second", "agent"), node("other", "file")],
      [],
      at([
        ["dup", 0, 0],
        ["other", 5, 5],
      ]),
      "dark",
    );
    expect(model.nodes.map((n) => n.id)).toEqual(["dup", "other"]);
    expect(model.nodes[0]?.label).toBe("● First");
  });

  it("keeps two kinds between the same pair as two edges", () => {
    const model = renderGraph(nodes, [edge("a", "b", "contains"), edge("a", "b", "links-to")], positions, "dark");
    expect(model.edges.map((e) => e.kind)).toEqual(["contains", "links-to"]);
    expect(new Set(model.edges.map((e) => e.key)).size).toBe(2);
  });

  it("is empty for an empty input", () => {
    expect(renderGraph([], [], new Map(), "dark")).toEqual(EMPTY_RENDER_GRAPH);
  });
});

// --- the reducers (§7.4) -----------------------------------------------------------------

describe("the highlight reducers (§7.4)", () => {
  const model = renderGraph(
    [node("a", "vault"), node("b", "note", "B", "human"), node("c", "file")],
    [edge("a", "b"), edge("b", "c"), edge("a", "c")],
    at([
      ["a", 0, 0],
      ["b", 10, 0],
      ["c", 0, 10],
    ]),
    "dark",
  );
  const nodeOf = (id: string) => model.nodes.find((n) => n.id === id)!;
  const edgeOf = (source: string, target: string) => model.edges.find((e) => e.source === source && e.target === target)!;

  it("changes nothing when there is no selection", () => {
    // `null` is not the empty set, and conflating them would make a fresh load
    // render an entirely dimmed graph.
    const nodes = nodeReducer(null);
    const edges = edgeReducer(null);
    expect(nodes("a", nodeOf("a"), "dark")).toEqual({});
    expect(edges(edgeOf("a", "b").key, edgeOf("a", "b"))).toEqual({});
  });

  it("dims everything when the selection is not in this graph", () => {
    // The other half of that distinction: an empty neighbourhood is a real
    // answer — "nothing here is related to what you have selected".
    const nodes = nodeReducer(new Set());
    expect(nodes("a", nodeOf("a"), "dark").color).toBe(dimColor("dark"));
  });

  it("lifts the neighbourhood above the cloud and drops the cloud's labels", () => {
    const nodes = nodeReducer(new Set(["a", "b"]));
    const inside = nodes("a", nodeOf("a"), "dark");
    const outside = nodes("c", nodeOf("c"), "dark");
    expect(inside.zIndex).toBe(nodeOf("a").zIndex + HIGHLIGHT_Z_LIFT);
    expect(inside.color).toBeUndefined();
    expect(outside.label).toBeNull();
    expect(outside.zIndex).toBe(0);
  });

  it("keeps a dimmed node on screen at its own position and size", () => {
    // Hiding it would make sigma reframe on the visible extent, so the graph
    // would *move* when you click it. Overriding neither x/y nor size is the
    // assertion that it cannot.
    const nodes = nodeReducer(new Set(["a"]));
    const dimmed = nodes("c", nodeOf("c"), "dark");
    expect(dimmed.size).toBeUndefined();
    expect(Object.keys(dimmed).sort()).toEqual(["color", "label", "zIndex"]);
  });

  it("dims by scheme", () => {
    const nodes = nodeReducer(new Set(["a"]));
    expect(nodes("c", nodeOf("c"), "light").color).toBe(dimColor("light"));
  });

  it("keeps an edge only when both endpoints are in the neighbourhood", () => {
    const edges = edgeReducer(new Set(["a", "b"]));
    expect(edges(edgeOf("a", "b").key, edgeOf("a", "b"))).toEqual({ zIndex: 1 });
    expect(edges(edgeOf("b", "c").key, edgeOf("b", "c"))).toEqual({ hidden: true });
    expect(edges(edgeOf("a", "c").key, edgeOf("a", "c"))).toEqual({ hidden: true });
  });
});

// --- settings (§7.4) ----------------------------------------------------------------------

describe("sigma settings (§7.4)", () => {
  it("sets every §7.4 semantic-zoom lever", () => {
    const settings = graphSettings("dark");
    expect(settings.labelRenderedSizeThreshold).toBe(LABEL_SIZE_THRESHOLD);
    expect(settings.labelDensity).toBe(LABEL_DENSITY);
    expect(settings.labelGridCellSize).toBe(LABEL_GRID_CELL_SIZE);
  });

  it("hides edges while moving, per §7.4", () => {
    expect(graphSettings("dark").hideEdgesOnMove).toBe(true);
  });

  it("derives the label threshold from the size range rather than tuning it", () => {
    // Between a leaf and a hub: the nodes that are structurally significant at
    // this zoom get a label first, the rest as you zoom in. A tuned constant
    // would stop tracking `nodeSize` the moment either bound moved.
    expect(LABEL_SIZE_THRESHOLD).toBeGreaterThan(nodeSize(0));
    expect(LABEL_SIZE_THRESHOLD).toBeLessThan(nodeSize(DEGREE_AT_MAX_SIZE));
    expect(LABEL_GRID_CELL_SIZE).toBe(COLLIDE_RADIUS * 4);
  });

  it("measures sizes in layout units, which is what ties §8 to the screen", () => {
    // Under sigma's default (`"screen"`) a node keeps its pixel size as the
    // camera zooms out, so a provably non-overlapping layout still renders as
    // a blob. `"positions"` is what makes `nodeSize`'s ceiling mean anything.
    const settings = graphSettings("dark");
    expect(settings.itemSizesReference).toBe("positions");
    expect(settings.zoomToSizeRatioFunction(2)).toBe(2);
    expect(settings.zIndex).toBe(true);
  });

  it("takes its label and default colours from the scheme", () => {
    expect(graphSettings("dark").labelColor.color).toBe(GRAPH_PALETTE.dark.text);
    expect(graphSettings("light").labelColor.color).toBe(GRAPH_PALETTE.light.text);
    expect(graphSettings("light").defaultEdgeColor).toBe(GRAPH_PALETTE.light.line);
    expect(graphSettings("dark").defaultNodeColor).toBe(GRAPH_PALETTE.dark.dim);
  });

  it("tolerates a container with no size", () => {
    // A column behind the `medium` breakpoint's toggle legitimately has none
    // until it is revealed; throwing there would take the workspace down over
    // a column the user cannot see.
    expect(graphSettings("dark").allowInvalidContainer).toBe(true);
    expect(graphSettings("dark").stagePadding).toBe(COLLIDE_RADIUS);
  });
});

// --- the projection (§7.1) -------------------------------------------------------------------

describe("the graphology projection (§7.1)", () => {
  const model: RenderGraph = renderGraph(
    [node("a", "vault"), node("b", "note", "B", "agent"), node("c", "file")],
    [edge("a", "b"), edge("a", "c"), edge("b", "c", "links-to")],
    at([
      ["a", 0, 0],
      ["b", 10, 0],
      ["c", 0, 10],
    ]),
    "dark",
  );

  it("is empty until something is projected into it", () => {
    const graph = emptyProjection();
    expect(graph.order).toBe(0);
    expect(graph.size).toBe(0);
  });

  it("reproduces the render model node for node and edge for edge", () => {
    const graph = project(model);
    expect(graph.order).toBe(3);
    expect(graph.size).toBe(3);
    for (const rendered of model.nodes) {
      expect(graph.hasNode(rendered.id)).toBe(true);
      const attributes = graph.getNodeAttributes(rendered.id);
      const { id, ...expected } = rendered;
      expect(attributes, id).toEqual(expected);
    }
  });

  it("carries sigma's reserved attribute names onto the node", () => {
    // sigma reads `x`, `y`, `size`, `label`, `color`, `type` and `zIndex` off
    // the attributes directly. A rename here is a silently unrendered graph.
    const graph = project(model);
    const attributes = graph.getNodeAttributes("b");
    for (const key of ["x", "y", "size", "label", "color", "type", "zIndex"]) {
      expect(attributes, key).toHaveProperty(key);
    }
  });

  it("keeps two different relationships between one pair as two edges", () => {
    // Real data: §4.4's mention pass runs over the body independently of the
    // wikilink pass, so a note can both link to and mention the same module.
    // A simple graph throws on the second one, and the alternative — dropping
    // it — is the retired viewer's "a link simply vanished" bug (§7.4).
    const two = renderGraph(
      [node("a", "note", "A", "human"), node("b", "module")],
      [edge("a", "b", "links-to"), edge("a", "b", "mentions")],
      at([
        ["a", 0, 0],
        ["b", 1, 1],
      ]),
      "dark",
    );
    const graph = project(two);
    expect(graph.size).toBe(2);
    expect(graph.edges().length).toBe(2);
  });

  it("still throws on a genuinely duplicated edge", () => {
    // The guard `multi: false` looked like it was providing. It was always the
    // *key* doing that work: `edgeKey` is `(source, target, kind)`, so a real
    // duplicate is a mount-time failure while two distinct kinds are not.
    // `renderGraph` dedupes upstream, so reaching this needs a hand-built
    // model — which is exactly the malformed input this asserts is loud.
    const forged: RenderGraph = {
      nodes: [
        { id: "a", x: 0, y: 0, size: 3, label: "a", color: "#000000", kind: "note", provenance: null, zIndex: 3, type: "circle" },
        { id: "b", x: 1, y: 1, size: 3, label: "b", color: "#000000", kind: "note", provenance: null, zIndex: 3, type: "circle" },
      ],
      edges: [
        { key: "dup", source: "a", target: "b", size: 1, color: "#000000", kind: "links-to", zIndex: 0, type: "line" },
        { key: "dup", source: "a", target: "b", size: 1, color: "#000000", kind: "links-to", zIndex: 0, type: "line" },
      ],
    };
    expect(() => project(forged)).toThrow();
  });

  it("is directed, because no edge kind is symmetric", () => {
    const graph = project(model);
    expect(graph.type).toBe("directed");
    expect(graph.hasDirectedEdge("a", "b")).toBe(true);
    expect(graph.hasDirectedEdge("b", "a")).toBe(false);
  });

  it("round-trips positions", () => {
    const graph = project(model);
    expect(positionsOf(graph)).toEqual(
      at([
        ["a", 0, 0],
        ["b", 10, 0],
        ["c", 0, 10],
      ]),
    );
  });

  it("moves nodes in place without disturbing the graph", () => {
    const graph = project(model);
    const moved = syncPositions(graph, at([["a", 100, 200]]));
    expect(moved).toBe(1);
    expect(graph.getNodeAttribute("a", "x")).toBe(100);
    expect(graph.getNodeAttribute("a", "y")).toBe(200);
    // A partial update is partial: everything else stays where it was, rather
    // than being reset to the origin.
    expect(graph.getNodeAttribute("b", "x")).toBe(10);
    expect(graph.order).toBe(3);
    expect(graph.size).toBe(3);
  });

  it("preserves the rest of a node's attributes when it moves", () => {
    const graph = project(model);
    syncPositions(graph, at([["b", 1, 2]]));
    expect(graph.getNodeAttribute("b", "label")).toBe("◐ B");
    expect(graph.getNodeAttribute("b", "color")).toBe(kindColor("note", "dark"));
  });

  it("ignores a position for a node it does not have", () => {
    const graph = project(model);
    expect(syncPositions(graph, at([["ghost", 1, 1]]))).toBe(0);
  });

  it("refuses a non-finite position rather than poisoning a node", () => {
    const graph = project(model);
    const moved = syncPositions(
      graph,
      new Map<string, Point>([
        ["a", { x: Number.NaN, y: 1 }],
        ["b", { x: 1, y: Number.POSITIVE_INFINITY }],
      ]),
    );
    expect(moved).toBe(0);
    expect(graph.getNodeAttribute("a", "x")).toBe(0);
    expect(graph.getNodeAttribute("b", "y")).toBe(0);
  });
});

// --- the renderer seam (§7.5) ----------------------------------------------------------------

describe("the renderer seam (§7.5)", () => {
  it("nullRenderer satisfies the whole interface and draws nothing", () => {
    // Not a test double — a production path. The column renders before its
    // container exists, and may never mount at all when the `medium`
    // breakpoint collapses it. A null object removes the `renderer === null`
    // check from every call site, which is the check that is always missing
    // from exactly one of them.
    const renderer = nullRenderer();
    expect(() => {
      renderer.mount({ clientWidth: 0, clientHeight: 0 });
      renderer.setGraph(EMPTY_RENDER_GRAPH);
      renderer.setPositions(new Map());
      renderer.setHighlight(null);
      renderer.onSelect(() => {});
      renderer.fit();
      renderer.destroy();
    }).not.toThrow();
    expect(renderer.positions().size).toBe(0);
  });
});

/**
 * A recording `SigmaLike`.
 *
 * This is why `new Sigma(...)` is a parameter rather than a call. Sigma cannot
 * be imported in Node at all — it evaluates `WebGL2RenderingContext.BOOL` at
 * module scope — so a renderer that constructed it directly would be a file
 * reporting 0 % that no test could even load. Against the port, everything
 * except the constructor call itself is ordinary covered code.
 */
function fakeSigma() {
  const calls: string[] = [];
  let nodes: ((id: string, data: RenderNode) => NodeDisplayOverride) | null = null;
  let edges: ((key: string, data: RenderEdge) => EdgeDisplayOverride) | null = null;
  const handlers: {
    node?: (payload: { node: string }) => void;
    stage?: () => void;
    downNode?: (payload: { node: string }) => void;
    moveBody?: (payload: { event: { x: number; y: number } }) => void;
    upNode?: () => void;
    upStage?: () => void;
  } = {};
  let graph: ReturnType<typeof project> | null = null;
  let resets = 0;
  const panning: boolean[] = [];

  const instance: SigmaLike = {
    on(event: string, handler: unknown) {
      calls.push(`on:${event}`);
      if (event === "clickNode") handlers.node = handler as (payload: { node: string }) => void;
      if (event === "clickStage") handlers.stage = handler as () => void;
      if (event === "downNode") handlers.downNode = handler as (payload: { node: string }) => void;
      if (event === "moveBody") handlers.moveBody = handler as (payload: { event: { x: number; y: number } }) => void;
      if (event === "upNode") handlers.upNode = handler as () => void;
      if (event === "upStage") handlers.upStage = handler as () => void;
      return instance;
    },
    setSetting(key: string, value: unknown) {
      calls.push(`setSetting:${key}`);
      if (key === "nodeReducer") nodes = value as (id: string, data: RenderNode) => NodeDisplayOverride;
      if (key === "edgeReducer") edges = value as (key: string, data: RenderEdge) => EdgeDisplayOverride;
      if (key === "enableCameraPanning") panning.push(value as boolean);
      return instance;
    },
    setGraph(next) {
      calls.push("setGraph");
      graph = next;
      return instance;
    },
    refresh() {
      calls.push("refresh");
      return instance;
    },
    viewportToGraph(position) {
      return position;
    },
    getCamera() {
      calls.push("getCamera");
      return {
        animatedReset() {
          resets++;
          return Promise.resolve();
        },
      };
    },
    kill() {
      calls.push("kill");
    },
  } as SigmaLike;

  const created: Array<{ graph: ReturnType<typeof project>; container: RenderContainer; settings: GraphSettings }> = [];
  const factory: SigmaFactory = (g, container, settings) => {
    created.push({ graph: g, container, settings });
    graph = g;
    return instance;
  };

  return {
    factory,
    calls,
    created,
    resets: () => resets,
    graph: () => graph,
    panning: () => panning,
    nodeReducer: () => nodes,
    edgeReducer: () => edges,
    clickNode: (id: string) => handlers.node?.({ node: id }),
    clickStage: () => handlers.stage?.(),
    downNode: (id: string) => handlers.downNode?.({ node: id }),
    // The renderer derives the dragged id from its own `downNode` state, so
    // the id argument here is ignored; only the coordinates reach `moveBody`.
    moveBody: (_id: string, x: number, y: number) => handlers.moveBody?.({ event: { x, y } }),
    upNode: () => handlers.upNode?.(),
    upStage: () => handlers.upStage?.(),
  };
}

describe("sigmaRenderer over the injected constructor (§7.5)", () => {
  const model = renderGraph(
    [node("a", "vault"), node("b", "note", "B", "human"), node("c", "file")],
    [edge("a", "b"), edge("b", "c")],
    at([
      ["a", 0, 0],
      ["b", 10, 0],
      ["c", 0, 10],
    ]),
    "dark",
  );
  const container: RenderContainer = { clientWidth: 400, clientHeight: 300 };

  it("constructs nothing until it is mounted", () => {
    // The column renders before its container exists, so a renderer that
    // built a `Sigma` eagerly would either crash or leak one per render.
    const fake = fakeSigma();
    const renderer = sigmaRenderer(fake.factory, "dark");
    renderer.setGraph(model);
    renderer.setHighlight(new Set(["a"]));
    expect(fake.created).toHaveLength(0);
  });

  it("mounts with the model's projection and the scheme's settings", () => {
    const fake = fakeSigma();
    const renderer = sigmaRenderer(fake.factory, "light");
    renderer.setGraph(model);
    renderer.mount(container);
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]?.container).toBe(container);
    // Field-by-field rather than a deep equal: `zoomToSizeRatioFunction` is a
    // fresh closure per call, so `toEqual` compares two identical settings
    // objects and reports "no visual difference" while failing.
    const settings = fake.created[0]?.settings as GraphSettings;
    const expected = graphSettings("light");
    expect(settings.labelColor).toEqual(expected.labelColor);
    expect(settings.labelRenderedSizeThreshold).toBe(expected.labelRenderedSizeThreshold);
    expect(settings.hideEdgesOnMove).toBe(true);
    expect(settings.defaultNodeColor).toBe(GRAPH_PALETTE.light.dim);
    expect(fake.created[0]?.graph.order).toBe(3);
  });

  it("is idempotent on mount", () => {
    // A second `Sigma` over the same container is two WebGL contexts and two
    // sets of listeners on one element.
    const fake = fakeSigma();
    const renderer = sigmaRenderer(fake.factory, "dark");
    renderer.mount(container);
    renderer.mount(container);
    expect(fake.created).toHaveLength(1);
  });

  it("routes a node click and a stage click to the §1.3 bus", () => {
    const fake = fakeSigma();
    const renderer = sigmaRenderer(fake.factory, "dark");
    const seen: Array<string | null> = [];
    renderer.onSelect((id) => seen.push(id));
    renderer.setGraph(model);
    renderer.mount(container);
    fake.clickNode("b");
    fake.clickStage();
    expect(seen).toEqual(["b", null]);
  });

  it("survives a click before any handler is registered", () => {
    // The default handler is a no-op rather than `null`, so the mount path has
    // no ordering requirement against `onSelect`.
    const fake = fakeSigma();
    sigmaRenderer(fake.factory, "dark").mount(container);
    expect(() => fake.clickNode("a")).not.toThrow();
    expect(() => fake.clickStage()).not.toThrow();
  });

  it("routes drag events through the renderer's own callbacks", () => {
    const fake = fakeSigma();
    const renderer = sigmaRenderer(fake.factory, "dark");
    const seen: Array<{ id: string; at: Point | null; ended: boolean }> = [];
    renderer.onDragStart((id) => seen.push({ id, at: null, ended: false }));
    renderer.onDragMove((id, at) => seen.push({ id, at, ended: false }));
    renderer.onDragEnd((id) => seen.push({ id, at: null, ended: true }));
    renderer.setGraph(model);
    renderer.mount(container);
    fake.downNode("a");
    fake.moveBody("a", 10, 20);
    fake.upNode();
    expect(seen).toEqual([
      { id: "a", at: null, ended: false },
      { id: "a", at: { x: 10, y: 20 }, ended: false },
      { id: "a", at: null, ended: true },
    ]);
  });

  it("holds the camera still while dragging a node, then releases it", () => {
    // A node drag is a pin, not a pan: if sigma's captor moved the camera on
    // the same gesture that is moving the node, the node would slide away
    // from the cursor. Panning is disabled on `downNode` and restored on
    // release — the Obsidian feel of a node staying under your pointer.
    const fake = fakeSigma();
    const renderer = sigmaRenderer(fake.factory, "dark");
    renderer.setGraph(model);
    renderer.mount(container);
    fake.downNode("a");
    fake.moveBody("a", 5, 6);
    fake.upNode();
    expect(fake.panning()).toEqual([false, true]);
  });

  it("treats a release with no active drag as a no-op", () => {
    // A stray `upStage` / `upNode` without a matching `downNode` must not
    // toggle panning or fire a drag-end — the renderer is in no drag state.
    const fake = fakeSigma();
    const renderer = sigmaRenderer(fake.factory, "dark");
    renderer.setGraph(model);
    renderer.mount(container);
    expect(() => {
      fake.upNode();
      fake.upStage();
    }).not.toThrow();
    expect(fake.panning()).toEqual([]);
  });

  it("installs reducers that carry the model's own attributes through", () => {
    // The reducers spread the node's data before the override, so sigma keeps
    // every attribute `project.ts` wrote and only the override wins.
    const fake = fakeSigma();
    const renderer = sigmaRenderer(fake.factory, "dark");
    renderer.setGraph(model);
    renderer.mount(container);
    const reduce = fake.nodeReducer();
    const drawn = model.nodes.find((n) => n.id === "b")!;
    expect(reduce?.("b", drawn)).toEqual(drawn);
  });

  it("re-installs the reducers on every highlight change", () => {
    // `setSetting` is what schedules a repaint. Mutating a captured variable
    // would change the answer and redraw nothing until an unrelated frame.
    const fake = fakeSigma();
    const renderer = sigmaRenderer(fake.factory, "dark");
    renderer.setGraph(model);
    renderer.mount(container);
    const before = fake.calls.filter((c) => c === "setSetting:nodeReducer").length;
    renderer.setHighlight(new Set(["a", "b"]));
    expect(fake.calls.filter((c) => c === "setSetting:nodeReducer").length).toBe(before + 1);

    const reduce = fake.nodeReducer();
    const outside = model.nodes.find((n) => n.id === "c")!;
    expect(reduce?.("c", outside).color).toBe(dimColor("dark"));
    const inside = model.nodes.find((n) => n.id === "a")!;
    expect(reduce?.("a", inside).color).toBe(inside.color);
  });

  it("hides edges leaving the neighbourhood", () => {
    const fake = fakeSigma();
    const renderer = sigmaRenderer(fake.factory, "dark");
    renderer.setGraph(model);
    renderer.mount(container);
    renderer.setHighlight(new Set(["a", "b"]));
    const reduce = fake.edgeReducer();
    const kept = model.edges.find((e) => e.source === "a")!;
    const dropped = model.edges.find((e) => e.source === "b")!;
    expect(reduce?.(kept.key, kept).hidden).toBeUndefined();
    expect(reduce?.(dropped.key, dropped).hidden).toBe(true);
  });

  it("accepts a highlight before mount and applies it when mounted", () => {
    const fake = fakeSigma();
    const renderer = sigmaRenderer(fake.factory, "dark");
    renderer.setGraph(model);
    renderer.setHighlight(new Set(["a"]));
    renderer.mount(container);
    const reduce = fake.nodeReducer();
    expect(reduce?.("c", model.nodes.find((n) => n.id === "c")!).color).toBe(dimColor("dark"));
  });

  it("replaces the graph on setGraph and refreshes on setPositions", () => {
    // The distinction that keeps the camera: a re-run of the simulation over
    // an unchanged node set must not rebuild every WebGL buffer.
    const fake = fakeSigma();
    const renderer = sigmaRenderer(fake.factory, "dark");
    renderer.setGraph(model);
    renderer.mount(container);
    fake.calls.length = 0;

    renderer.setPositions(at([["a", 99, 98]]));
    expect(fake.calls).toEqual(["refresh"]);
    expect(renderer.positions().get("a")).toEqual({ x: 99, y: 98 });

    renderer.setGraph(model);
    expect(fake.calls).toContain("setGraph");
  });

  it("keeps positions available before and after mount", () => {
    const fake = fakeSigma();
    const renderer = sigmaRenderer(fake.factory, "dark");
    expect(renderer.positions().size).toBe(0);
    renderer.setGraph(model);
    expect(renderer.positions().size).toBe(3);
  });

  it("fits by resetting the camera, and does nothing before mount", () => {
    const fake = fakeSigma();
    const renderer = sigmaRenderer(fake.factory, "dark");
    renderer.fit();
    expect(fake.resets()).toBe(0);
    renderer.mount(container);
    renderer.fit();
    expect(fake.resets()).toBe(1);
  });

  it("kills the instance once and can be re-mounted afterwards", () => {
    const fake = fakeSigma();
    const renderer = sigmaRenderer(fake.factory, "dark");
    renderer.mount(container);
    renderer.destroy();
    renderer.destroy();
    expect(fake.calls.filter((c) => c === "kill")).toHaveLength(1);
    // A destroyed renderer is inert rather than broken: the column may unmount
    // and remount when the breakpoint toggles its column back on.
    renderer.mount(container);
    expect(fake.created).toHaveLength(2);
  });

  it("tolerates every method before mount and after destroy", () => {
    const fake = fakeSigma();
    const renderer = sigmaRenderer(fake.factory, "dark");
    expect(() => {
      renderer.setGraph(model);
      renderer.setPositions(new Map());
      renderer.setHighlight(new Set());
      renderer.fit();
      renderer.destroy();
      renderer.setPositions(at([["a", 1, 1]]));
      renderer.setHighlight(null);
      renderer.fit();
    }).not.toThrow();
  });
});

// --- the whole pipeline, on the real repository shape (§8, §11 P3) ------------------------------

describe("the P3 pipeline on the repo fixture (§7.1, §11)", () => {
  // The §8 fixture is this repository's actual shape: 5 roots, a 60-child hub,
  // a sparse wiki-link web and 3 cross-cluster edges. Running it through the
  // whole pipeline is the closest a unit test gets to the P3 exit criterion,
  // and every assertion is on the computed positions and the derived render
  // state — never on pixels, which §10 rules out permanently.
  const fixture = repoLikeGraph();
  const positions = computeLayout(fixture, { ticks: 300, seed: 1, width: 1280, height: 800 });
  const model = renderGraph(fixture.nodes, fixture.edges, positions, "dark");

  it("draws every node in the fixture", () => {
    expect(model.nodes).toHaveLength(fixture.nodes.length);
  });

  it("projects without graphology rejecting anything", () => {
    // The real assertion: `multi: false` throws on a duplicate key and
    // `addEdge` throws on a missing endpoint, so a clean projection of the
    // full fixture is a proof that `renderGraph`'s invariants hold on it.
    const graph = project(model);
    expect(graph.order).toBe(fixture.nodes.length);
    expect(graph.size).toBe(model.edges.length);
  });

  it("draws the 60-child hub larger than its leaves", () => {
    const hub = model.nodes.find((n) => n.id === "repository")!;
    const leaves = model.nodes.filter((n) => n.id.startsWith("module:src/m"));
    expect(leaves).toHaveLength(60);
    for (const leaf of leaves) expect(hub.size).toBeGreaterThan(leaf.size);
  });

  it("keeps every drawn radius inside the layout's collision budget", () => {
    // The join between §8's position assertions and what is actually painted:
    // the gate proves `minPairwiseDistance > 2 · NODE_RADIUS`, and this proves
    // no node is drawn wider than that.
    for (const drawn of model.nodes) expect(drawn.size).toBeLessThanOrEqual(NODE_RADIUS);
  });
});
