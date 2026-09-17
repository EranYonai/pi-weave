/**
 * Group identity as colour (weave-workspace §7.4, §15.8).
 *
 * The forces separate the graph into blobs; this decides what each blob is
 * *called* in colour. The two must agree on what a group is, or the picture
 * says one thing and the physics another — so a group here is exactly what
 * `FORCES` pulls apart: a **depth-1 containment branch**.
 *
 * ```text
 * vault                      ← a root: its own group
 * ├── vfolder:sessions       ← group A, with all 323 descendants
 * ├── vfolder:manager-digest ← group B, with all 159
 * └── note:loose             ← no branch of its own: joins the root's group
 * ```
 *
 * Depth 1 exactly, for the reason the retired `bigBranches` used it: deeper
 * groupings shred a nested module tree into a rainbow, and the tangle a reader
 * actually needs help with is always *sibling* blobs sharing a centre.
 *
 * ## Hue carries the group, shade carries the kind
 *
 * A flat fill per group would trade one lost distinction for another — the
 * kind vocabulary (`KIND_SLOT`) would go. So the group picks the **hue** and
 * the node's role within it picks the **shade**: a branch's own anchor node
 * draws at full strength, its contents a step back. Group identity at a
 * glance, internal structure on a second look, and provenance is untouched
 * because it was never a hue (AGENTS.md rule 4 — the badge glyph carries it,
 * and a glyph survives colour-blindness and greyscale in a way a fill does
 * not).
 *
 * ## Why these hexes are not in the stylesheet
 *
 * Every other colour in `graph.model.ts` is mirrored from `THEME_CSS` and
 * guarded by a drift test, because the sheet paints the same thing in CSS.
 * Nothing in the sheet paints a graph group, so there is nothing to mirror and
 * a mirror test would be theatre. The guarantee that matters here is
 * *contrast*, and that is asserted directly: every hue clears 3:1 against its
 * scheme's ground (WCAG non-text minimum), measured in
 * `tests/web/client-graph-groups.test.ts`.
 *
 * ## Tier rules (§2)
 *
 * `src/web/client/**`, no DOM, no npm — compiles under the root
 * `tsconfig.json` so its tests are ordinary ones.
 */

import type { WireEdgeKind, WireGraphEdge, WireGraphNode, WireNodeKind } from "../../shared/wire";
import type { ColorScheme } from "./graph.model";
import { GRAPH_PALETTE, blendHex } from "./graph.model";

// --- which group a node belongs to ------------------------------------------------

function isContainment(kind: WireEdgeKind): boolean {
  return kind === "contains" || kind === "anchored-at";
}

/**
 * Node id → group key, for every node.
 *
 * The key is the id of the depth-1 branch the node sits under, or the node's
 * own root when it has no branch between it and the top (a root itself, a
 * loose note, an isolated island). Every node gets a key, so a caller never
 * has to decide what an absent one means.
 *
 * First containment parent wins, exactly like `layout.ts`'s `analyse` and the
 * retired `forestOf`: a second parent (a cycle, a hand-edited index) must not
 * turn the walk into a diamond, and the walk is depth-bounded by a `seen` set
 * so a containment cycle terminates rather than hanging the column.
 */
export function groupKeys(
  nodes: readonly WireGraphNode[],
  edges: readonly WireGraphEdge[],
): Map<string, string> {
  const known = new Set(nodes.map((node) => node.id));
  const parent = new Map<string, string>();
  for (const edge of edges) {
    if (!isContainment(edge.kind)) continue;
    if (edge.source === edge.target) continue;
    if (!known.has(edge.source) || !known.has(edge.target)) continue;
    if (parent.has(edge.target)) continue;
    parent.set(edge.target, edge.source);
  }

  const out = new Map<string, string>();
  for (const node of nodes) {
    // Walk to the root, remembering the last step before it: that step is the
    // depth-1 branch, and it is the group. A node that *is* a root, or whose
    // parent is missing, is its own group.
    let current = node.id;
    let previous = node.id;
    const seen = new Set<string>([current]);
    for (;;) {
      const next = parent.get(current);
      if (next === undefined || seen.has(next)) break;
      seen.add(next);
      previous = current;
      current = next;
    }
    // `current` is the root; `previous` is the depth-1 branch under it (or the
    // root itself, when the node is the root).
    out.set(node.id, previous);
  }
  return out;
}

/** Group key → how many nodes it holds. Biggest groups get the strongest hues. */
export function groupSizes(keys: ReadonlyMap<string, string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const key of keys.values()) out.set(key, (out.get(key) ?? 0) + 1);
  return out;
}

// --- the hues ---------------------------------------------------------------------

/**
 * The hue ring, per scheme.
 *
 * Dark is Catppuccin **Macchiato**'s accent row and light is **Latte**'s,
 * matching the two palettes `THEME_CSS` is already built from — so the graph
 * reads as the same product even though these particular swatches appear
 * nowhere else.
 *
 * The light row is *deepened* from stock Latte, exactly as the stylesheet
 * deepens its own status colours (`--weave-ok:#28641b` is not Latte green).
 * Stock Latte accents sit at 2.3–3.0:1 on `#eff1f5`, under the 3:1 non-text
 * floor — pretty on a marketing page, invisible as a 6-pixel disc. Each was
 * darkened along its own hue until the **deepest per-kind shade** still
 * cleared 3:1, which is a stronger condition than the hue clearing it: the
 * test asserts hue × kind, not hue alone, and caught stock mauve at 2.98
 * under the `external` shade.
 *
 * Eleven entries, ordered so that adjacent groups are far apart in hue: the
 * ring is walked in order, and a vault with four folders should get four
 * obviously different colours rather than four neighbouring blues. Latte's
 * `sky` and `sapphire` are one entry, not two — deepened far enough to be
 * legible they converge on the same teal-blue, and two ring slots a reader
 * cannot tell apart are worse than eleven they can.
 */
export const GROUP_HUES: Readonly<Record<ColorScheme, readonly string[]>> = {
  dark: [
    "#c6a0f6", // mauve — the accent, so the first/biggest group keeps the shell's voice
    "#8bd5ca", // teal
    "#f5a97f", // peach
    "#8aadf4", // blue
    "#a6da95", // green
    "#f5bde6", // pink
    "#eed49f", // yellow
    "#7dc4e4", // sapphire
    "#ee99a0", // maroon
    "#b7bdf8", // lavender
    "#ed8796", // red
  ],
  light: [
    "#7632d0", // mauve
    "#0f6064", // teal
    "#9b3d07", // peach
    "#1851c3", // blue
    "#27621b", // green
    "#7d3f6c", // pink
    "#774b0f", // yellow
    "#025f83", // sapphire
    "#a7323c", // maroon
    "#424e93", // lavender
    "#d20f39", // red
  ],
};

/**
 * Group key → hue, assigned **biggest group first**.
 *
 * Size order rather than id order, because the ring's first entry is the
 * shell's own accent and the biggest blob is the one a reader orients by —
 * giving the vault's 323-note `sessions` folder the violet the rest of the
 * workspace already speaks in costs nothing and makes the canvas feel like
 * part of the app. Ties break on the key, so the assignment is a pure
 * function of the graph and never of insertion order.
 *
 * More groups than hues wraps the ring. Two groups then share a colour, which
 * is honest: at thirteen simultaneous groups the colour channel is saturated
 * and position is doing the work anyway.
 */
export function groupColors(keys: ReadonlyMap<string, string>, scheme: ColorScheme): Map<string, string> {
  const ring = GROUP_HUES[scheme];
  const sizes = groupSizes(keys);
  const ordered = [...sizes.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const out = new Map<string, string>();
  ordered.forEach(([key], index) => out.set(key, ring[index % ring.length]!));
  return out;
}

// --- shade within a group ----------------------------------------------------------

/**
 * How far a node's fill steps back from its group's hue, by kind.
 *
 * The anchors of a group — the folder, the repository, the vault — carry it at
 * full strength; the contents step back so the eye reads "these belong to
 * that" rather than a flat field of one colour. Notes step back least, because
 * notes are the product (§1.1); derived code artefacts step back most, the
 * same ordering `KIND_SLOT` expressed with its three slots.
 *
 * Capped at 0.35: past roughly 0.4 the deepened light hues drop under the 3:1
 * non-text floor, which is the whole reason the light ring is deepened to
 * 3.4:1 rather than to 3.0:1. The test asserts the *shaded* colours clear it,
 * not just the hues.
 */
export const KIND_SHADE: Readonly<Record<WireNodeKind, number>> = {
  vault: 0,
  repository: 0,
  module: 0,
  note: 0.12,
  file: 0.3,
  package: 0.3,
  entryPoint: 0.3,
  gitState: 0.3,
  external: 0.35,
};

/** A node's fill: its group's hue, stepped back by its kind. */
export function groupNodeColor(hue: string, kind: WireNodeKind, scheme: ColorScheme): string {
  return blendHex(hue, GRAPH_PALETTE[scheme].ground, KIND_SHADE[kind]);
}

/**
 * The whole assignment: node id → fill.
 *
 * One call for the caller, and the only place the three steps above are
 * composed — so a renderer cannot accidentally apply the shade twice or skip
 * it for one kind.
 */
export function groupNodeColors(
  nodes: readonly WireGraphNode[],
  edges: readonly WireGraphEdge[],
  scheme: ColorScheme,
): Map<string, string> {
  const keys = groupKeys(nodes, edges);
  const hues = groupColors(keys, scheme);
  const out = new Map<string, string>();
  for (const node of nodes) {
    const hue = hues.get(keys.get(node.id) ?? node.id);
    if (hue !== undefined) out.set(node.id, groupNodeColor(hue, node.kind, scheme));
  }
  return out;
}
