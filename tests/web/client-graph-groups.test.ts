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
  DEPTH_SHADE,
  GROUP_HUES,
  HUE_STRIDE,
  MAX_SHADE,
  bridgeBlend,
  groupColors,
  groupKeys,
  groupNodeColors,
  groupPlaces,
  groupSizes,
  shadeFor,
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
  it("is legible: every hue, at every depth of the ramp, clears 3:1", () => {
    // The WCAG non-text minimum, and the reason the light ring is deepened
    // from stock Latte (which sits at 2.3–3.0 and vanishes as a 6px disc).
    // Asserted at every depth, not just the hue, because the ramp is what
    // actually reaches the screen.
    for (const scheme of SCHEMES) {
      const ground = GRAPH_PALETTE[scheme].ground;
      for (const hue of GROUP_HUES[scheme]) {
        for (let depth = 0; depth < 12; depth++) {
          const drawn = shadeFor(hue, depth, scheme);
          expect(contrast(drawn, ground), `${scheme} ${hue} d${depth}`).toBeGreaterThanOrEqual(3);
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

  it("ramps by depth, monotonically, and stops at the cap", () => {
    for (const scheme of SCHEMES) {
      const hue = GROUP_HUES[scheme][0]!;
      // Depth 0 is the group's own colour, untouched.
      expect(shadeFor(hue, 0, scheme)).toBe(hue);
      // Each level is a further step toward the ground...
      expect(shadeFor(hue, 1, scheme)).not.toBe(shadeFor(hue, 2, scheme));
      // ...until the cap, past which nothing gets dimmer (or illegible).
      const capped = shadeFor(hue, Math.ceil(MAX_SHADE / DEPTH_SHADE) + 1, scheme);
      expect(shadeFor(hue, 99, scheme)).toBe(capped);
      // A nonsense depth is depth 0, never a NaN blend.
      expect(shadeFor(hue, -3, scheme)).toBe(hue);
      expect(shadeFor(hue, Number.NaN, scheme)).toBe(hue);
    }
  });
});

describe("assigning hues to groups", () => {
  it("gives the biggest group the shell's own accent", () => {
    const keys = new Map([["n1", "big"], ["n2", "big"], ["n3", "big"], ["n4", "small"]]);
    for (const scheme of SCHEMES) {
      const colors = groupColors(keys, scheme);
      expect(colors.get("big")).toBe(GROUP_HUES[scheme][0]);
      // The second group takes a *stride* along the wheel, not the next slot.
      expect(colors.get("small")).toBe(GROUP_HUES[scheme][HUE_STRIDE]);
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

  it("colours a whole graph: one hue per group, a ramp inside it", () => {
    const nodes = [node("vault", "vault"), node("f:a", "module"), node("f:b", "module"), node("n1"), node("n2")];
    const edges = [edge("vault", "f:a"), edge("vault", "f:b"), edge("f:a", "n1"), edge("f:b", "n2")];
    const fills = groupNodeColors(nodes, edges, "dark");
    expect(fills.size).toBe(5);
    const hue = groupColors(groupKeys(nodes, edges), "dark").get("f:a")!;
    // The anchor is the group's own hue; its child is one step down the ramp.
    expect(fills.get("f:a")).toBe(hue);
    expect(fills.get("n1")).toBe(shadeFor(hue, 1, "dark"));
    // Two different folders are two different hues.
    expect(fills.get("f:a")).not.toBe(fills.get("f:b"));
  });

  it("walks the wheel in strides, so the two biggest groups are far apart", () => {
    // The fix for "the colours look random": an arbitrary ring order put
    // neighbouring hues next to each other. A stride coprime with the ring
    // length visits every slot while keeping consecutive groups distant.
    for (const scheme of SCHEMES) {
      const ring = GROUP_HUES[scheme];
      const keys = new Map<string, string>();
      ring.forEach((_, i) => {
        // Descending sizes, so group `g00` is biggest and takes ring[0].
        for (let n = 0; n <= ring.length - i; n++) keys.set(`n${i}-${n}`, `g${String(i).padStart(2, "0")}`);
      });
      const colors = groupColors(keys, scheme);
      expect(colors.get("g00")).toBe(ring[0]);
      expect(colors.get("g01")).toBe(ring[HUE_STRIDE % ring.length]);
      // Coprime stride: every hue is used exactly once before any repeats.
      expect(new Set(colors.values()).size).toBe(ring.length);
    }
  });
});

// --- bridges between groups -----------------------------------------------------------

describe("a node that links into another group", () => {
  it("takes on a share of the foreign group's colour", () => {
    const nodes = [node("vault", "vault"), node("f:a", "module"), node("f:b", "module"), node("n1"), node("n2"), node("plain")];
    const edges = [
      edge("vault", "f:a"),
      edge("vault", "f:b"),
      edge("f:a", "n1"),
      edge("f:a", "plain"),
      edge("f:b", "n2"),
      edge("n1", "n2", "links-to"),
    ];
    const fills = groupNodeColors(nodes, edges, "dark");
    // `n1` and `plain` are siblings at the same depth in the same group, so
    // without the bridge they would be identical. The wikilink is the only
    // difference, and it must show.
    expect(fills.get("plain")).toBe(shadeFor(groupColors(groupKeys(nodes, edges), "dark").get("f:a")!, 1, "dark"));
    expect(fills.get("n1")).not.toBe(fills.get("plain"));
    // Both ends of the link tint — the relationship is symmetric.
    expect(fills.get("n2")).not.toBe(shadeFor(groupColors(groupKeys(nodes, edges), "dark").get("f:b")!, 1, "dark"));
  });

  it("does not tint on containment — that is what made it a member", () => {
    const nodes = [node("vault", "vault"), node("f:a", "module"), node("n1")];
    const edges = [edge("vault", "f:a"), edge("f:a", "n1")];
    const fills = groupNodeColors(nodes, edges, "dark");
    const hue = groupColors(groupKeys(nodes, edges), "dark").get("f:a")!;
    expect(fills.get("n1")).toBe(shadeFor(hue, 1, "dark"));
  });

  it("blends deterministically, and caps a promiscuous hub", () => {
    const own = "#c6a0f6";
    // Order-independent by construction: the caller sorts, and the same list
    // must always give the same hex or a node's colour would flicker.
    expect(bridgeBlend(own, ["#a6da95", "#8aadf4"], "dark")).toBe(bridgeBlend(own, ["#a6da95", "#8aadf4"], "dark"));
    // No foreign groups is the node's own colour, untouched.
    expect(bridgeBlend(own, [], "dark")).toBe(own);
    // A node reaching ten groups is still recognisably its own colour rather
    // than a mud of everyone else's.
    const many = bridgeBlend(own, Array.from({ length: 10 }, () => "#a6da95"), "dark");
    const three = bridgeBlend(own, Array.from({ length: 3 }, () => "#a6da95"), "dark");
    expect(many).toBe(three);
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
