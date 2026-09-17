/**
 * Group colouring (docs/weave-workspace.md §15.8).
 *
 * Three questions. Does a node land in the group the *forces* separate — the
 * depth-1 containment branch — including for the shapes that have no such
 * branch? Is every hue actually legible, hue and shade together, on both
 * grounds? And is the assignment a pure function of the graph rather than of
 * insertion order, which is what stops a colour from changing under a user
 * because core reordered its output.
 */

import { describe, expect, it } from "vitest";
import {
  GROUP_HUES,
  KIND_SHADE,
  groupColors,
  groupKeys,
  groupNodeColor,
  groupNodeColors,
  groupSizes,
} from "../../src/web/client/graph/groups";
import { GRAPH_PALETTE, edgeReducer, nodeReducer, recessColor, renderGraph } from "../../src/web/client/graph/graph.model";
import type { ColorScheme } from "../../src/web/client/graph/graph.model";
import { WIRE_NODE_KINDS } from "../../src/web/shared/wire";
import type { WireGraphEdge, WireGraphNode, WireNodeKind } from "../../src/web/shared/wire";

const SCHEMES: readonly ColorScheme[] = ["dark", "light"];

const node = (id: string, kind: WireNodeKind = "note"): WireGraphNode => ({
  id,
  kind,
  label: id,
  provenance: null,
  detail: {},
});
const edge = (source: string, target: string, kind: WireGraphEdge["kind"] = "contains"): WireGraphEdge => ({
  source,
  target,
  kind,
});

/** WCAG relative luminance / contrast, so "legible" is measured not asserted. */
function contrast(a: string, b: string): number {
  const lum = (hex: string): number => {
    const channel = (i: number): number => {
      const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("which group a node is in", () => {
  it("groups by the depth-1 branch, not by the root and not by the parent", () => {
    // The shape the real vault has: one root, several folders, deep nesting.
    const nodes = [node("vault", "vault"), node("f:a", "module"), node("f:b", "module"), node("n1"), node("n2"), node("deep")];
    const edges = [
      edge("vault", "f:a"),
      edge("vault", "f:b"),
      edge("f:a", "n1"),
      edge("f:b", "n2"),
      edge("f:a", "deep"),
    ];
    const keys = groupKeys(nodes, edges);
    // A note is in its *folder's* group, not the vault's — that is the whole
    // point, since the folder is what the forces pull into its own blob.
    expect(keys.get("n1")).toBe("f:a");
    expect(keys.get("deep")).toBe("f:a");
    expect(keys.get("n2")).toBe("f:b");
    // The branch node itself belongs to its own group.
    expect(keys.get("f:a")).toBe("f:a");
    // A root has no branch above it: it is its own group.
    expect(keys.get("vault")).toBe("vault");
  });

  it("puts a loose child of the root in the root's own group", () => {
    // A note sitting directly under the vault has no depth-1 branch of its
    // own; it must join the root group rather than earn a private hue, or a
    // vault with 20 loose notes would exhaust the ring on singletons.
    const keys = groupKeys([node("vault", "vault"), node("loose")], [edge("vault", "loose")]);
    expect(keys.get("loose")).toBe("loose");
    expect(keys.get("vault")).toBe("vault");
  });

  it("gives every node a key, including islands and anchored children", () => {
    const nodes = [node("island"), node("repo", "repository"), node("git", "gitState")];
    const keys = groupKeys(nodes, [edge("repo", "git", "anchored-at")]);
    expect(keys.size).toBe(3);
    expect(keys.get("island")).toBe("island");
    // `anchored-at` is containment, like everywhere else in the codebase.
    expect(keys.get("git")).toBe("git");
  });

  it("survives a containment cycle, a self-edge and a dangling endpoint", () => {
    // `buildGraph` emits none of these; a hand-edited .okf can, and a hung
    // column is a much worse failure than a wrong colour.
    const nodes = [node("x"), node("y")];
    const keys = groupKeys(nodes, [edge("x", "y"), edge("y", "x"), edge("x", "x"), edge("ghost", "y")]);
    expect(keys.size).toBe(2);
    for (const key of keys.values()) expect(typeof key).toBe("string");
  });

  it("ignores association edges — only containment makes a group", () => {
    // Two islands joined by a wikilink are still two groups: `links-to` does
    // not nest, and colouring by it would merge every cross-linked folder.
    const keys = groupKeys([node("a"), node("b")], [edge("a", "b", "links-to")]);
    expect(keys.get("a")).toBe("a");
    expect(keys.get("b")).toBe("b");
  });

  it("counts group sizes", () => {
    const keys = new Map([["n1", "f:a"], ["n2", "f:a"], ["n3", "f:b"]]);
    expect(groupSizes(keys)).toEqual(new Map([["f:a", 2], ["f:b", 1]]));
  });
});

describe("the hues", () => {
  it("is legible: every hue, at every kind's shade, clears 3:1 on its ground", () => {
    // The WCAG non-text minimum, and the reason the light ring is deepened
    // from stock Latte (which sits at 2.3–3.0 and vanishes as a 6px disc).
    for (const scheme of SCHEMES) {
      const ground = GRAPH_PALETTE[scheme].ground;
      for (const hue of GROUP_HUES[scheme]) {
        for (const kind of WIRE_NODE_KINDS) {
          const drawn = groupNodeColor(hue, kind, scheme);
          expect(contrast(drawn, ground), `${scheme} ${hue} ${kind}`).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  it("offers the same number of distinct hues in both schemes", () => {
    for (const scheme of SCHEMES) {
      expect(new Set(GROUP_HUES[scheme]).size).toBe(GROUP_HUES[scheme].length);
      for (const hue of GROUP_HUES[scheme]) expect(hue).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(GROUP_HUES.dark.length).toBe(GROUP_HUES.light.length);
    // A copy-paste of one scheme into both would be legible in one and not
    // the other — the same guard the kind palette carries.
    expect(GROUP_HUES.dark).not.toEqual(GROUP_HUES.light);
  });

  it("shades every kind, and never past the legibility cap", () => {
    for (const kind of WIRE_NODE_KINDS) {
      expect(KIND_SHADE[kind], kind).toBeGreaterThanOrEqual(0);
      expect(KIND_SHADE[kind], kind).toBeLessThanOrEqual(0.35);
    }
    // The ordering that carries the meaning: anchors full, notes near-full,
    // derived artefacts stepped back.
    expect(KIND_SHADE.module).toBeLessThan(KIND_SHADE.note);
    expect(KIND_SHADE.note).toBeLessThan(KIND_SHADE.file);
  });
});

describe("assigning hues to groups", () => {
  it("gives the biggest group the shell's own accent", () => {
    const keys = new Map([["n1", "big"], ["n2", "big"], ["n3", "big"], ["n4", "small"]]);
    for (const scheme of SCHEMES) {
      const colors = groupColors(keys, scheme);
      expect(colors.get("big")).toBe(GROUP_HUES[scheme][0]);
      expect(colors.get("small")).toBe(GROUP_HUES[scheme][1]);
    }
  });

  it("is a pure function of the graph, not of insertion order", () => {
    // Core's output order is stable today; a colour that silently changed
    // when it stopped being would be a mystery bug, so ties break on the key.
    const forward = new Map([["a", "g1"], ["b", "g2"]]);
    const backward = new Map([["b", "g2"], ["a", "g1"]]);
    expect(groupColors(forward, "dark")).toEqual(groupColors(backward, "dark"));
  });

  it("wraps the ring when there are more groups than hues", () => {
    const keys = new Map<string, string>();
    const count = GROUP_HUES.dark.length + 2;
    for (let i = 0; i < count; i++) keys.set(`n${i}`, `g${String(i).padStart(2, "0")}`);
    const colors = groupColors(keys, "dark");
    expect(colors.size).toBe(count);
    // Saturated rather than throwing or leaving a group unpainted.
    for (const value of colors.values()) expect(GROUP_HUES.dark).toContain(value);
  });

  it("colours a whole graph: same group same hue, different groups different", () => {
    const nodes = [node("vault", "vault"), node("f:a", "module"), node("f:b", "module"), node("n1"), node("n2")];
    const edges = [edge("vault", "f:a"), edge("vault", "f:b"), edge("f:a", "n1"), edge("f:b", "n2")];
    const fills = groupNodeColors(nodes, edges, "dark");
    expect(fills.size).toBe(5);
    // `n1` is `f:a`'s hue at the note shade — same hue family, not same hex.
    expect(fills.get("n1")).toBe(groupNodeColor(groupColors(groupKeys(nodes, edges), "dark").get("f:a")!, "note", "dark"));
    // Two different folders are two different hues.
    expect(fills.get("f:a")).not.toBe(fills.get("f:b"));
  });
});

// --- the selection's three tiers (§15.8) ---------------------------------------------

describe("selected, connected, and the rest", () => {
  const nodes = [node("sel"), node("near"), node("far")];
  const edges = [edge("sel", "near", "links-to"), edge("near", "far", "links-to")];
  const model = renderGraph(nodes, edges, new Map([["sel", { x: 0, y: 0 }], ["near", { x: 10, y: 0 }], ["far", { x: 20, y: 0 }]]), "dark");
  const nodeOf = (id: string) => model.nodes.find((n) => n.id === id)!;
  const edgeOf = (s: string, t: string) => model.edges.find((e) => e.source === s && e.target === t)!;
  const highlight = new Set(["sel", "near"]);

  it("grows the selection more than its neighbours, and lifts it higher", () => {
    // The gesture's subject must be findable at a glance. Before this, the
    // selection and its neighbours were painted identically and the only
    // signal was everything *else* dimming — which reads as the graph fading,
    // not as a node being named.
    const reduce = nodeReducer(highlight, "sel");
    const selected = reduce("sel", nodeOf("sel"), "dark");
    const neighbour = reduce("near", nodeOf("near"), "dark");
    expect(selected.size!).toBeGreaterThan(neighbour.size!);
    expect(selected.zIndex!).toBeGreaterThan(neighbour.zIndex!);
    // Both keep their own (group) colour: the highlight lifts, it never repaints.
    expect(selected.color).toBeUndefined();
    expect(neighbour.color).toBeUndefined();
  });

  it("still recedes everything outside the neighbourhood", () => {
    const reduce = nodeReducer(highlight, "sel");
    const outside = reduce("far", nodeOf("far"), "dark");
    expect(outside.color).toBe(recessColor(nodeOf("far").color, "dark"));
    expect(outside.label).toBeNull();
  });

  it("treats every highlighted node alike when no selection is named", () => {
    // `setHighlight(set)` with no id is still a valid call — it must not
    // promote an arbitrary member of the set to the selected tier.
    const reduce = nodeReducer(highlight);
    const a = reduce("sel", nodeOf("sel"), "dark");
    const b = reduce("near", nodeOf("near"), "dark");
    expect(a.size! / nodeOf("sel").size).toBeCloseTo(b.size! / nodeOf("near").size);
    expect(a.zIndex! - nodeOf("sel").zIndex).toBe(b.zIndex! - nodeOf("near").zIndex);
  });

  it("paints the selection's own edges in the accent, above the rest", () => {
    const reduce = edgeReducer(highlight, "sel");
    const incident = reduce(edgeOf("sel", "near").key, edgeOf("sel", "near"), "dark");
    expect(incident.color).toBe(GRAPH_PALETTE.dark.accent);
    expect(incident.zIndex).toBe(2);
    // An edge leaving the neighbourhood still recedes rather than vanishing.
    const outside = reduce(edgeOf("near", "far").key, edgeOf("near", "far"), "dark");
    expect(outside.color).toBe(recessColor(edgeOf("near", "far").color, "dark"));
  });

  it("gives a between-neighbours edge presence without the accent", () => {
    // Two neighbours joined to each other is context about the selection, but
    // it is not one of the selection's own links — one step quieter.
    const both = new Set(["sel", "near", "far"]);
    const reduce = edgeReducer(both, "sel");
    const between = reduce(edgeOf("near", "far").key, edgeOf("near", "far"), "dark");
    expect(between.zIndex).toBe(1);
    expect(between.color).toBeUndefined();
    expect(between.size).toBeGreaterThan(edgeOf("near", "far").size);
  });
});
