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
 * ## One colour per group, a ramp inside it
 *
 * Each group takes **one** Catppuccin accent — its primary — and every member
 * draws a shade of that single hue. Depth in the containment tree drives the
 * ramp: the branch anchor at full strength, its children a step toward the
 * ground, their children a step further. A group therefore reads as one colour
 * family with its own internal structure, rather than as a set of unrelated
 * swatches that merely happen to sit together.
 *
 * Depth rather than kind drives the ramp because kind does not vary inside a
 * real group. Measured on this vault: colouring by kind gave every folder
 * exactly **two** distinct fills (the folder, and 300-odd identical notes),
 * which is why the result read as flat-but-arbitrary.
 *
 * ## A node that bridges groups shows both
 *
 * A note linking into another group is the interesting node on the canvas, and
 * painting it purely in its own colour hides that. {@link bridgeBlend} mixes a
 * measured share of each foreign group's primary into such a node, so a bridge
 * is visibly part-way between the two families it joins. Containment is
 * excluded — that is what put it in its group in the first place — so only
 * genuine `links-to` / `mentions` associations tint.
 *
 * ## Why these hexes are not in the stylesheet
 *
 * Every other colour in `graph.model.ts` is mirrored from `THEME_CSS` and
 * guarded by a drift test, because the sheet paints the same thing in CSS.
 * Nothing in the sheet paints a graph group, so there is nothing to mirror and
 * a mirror test would be theatre. The guarantee that matters here is
 * *contrast*, and that is asserted directly: every hue, at every depth of the
 * ramp, clears 3:1 against its scheme's ground (the WCAG non-text minimum).
 *
 * ## Tier rules (§2)
 *
 * `src/web/client/**`, no DOM, no npm — compiles under the root
 * `tsconfig.json` so its tests are ordinary ones.
 */

import type { WireEdgeKind, WireGraphEdge, WireGraphNode } from "../../shared/wire";
import type { ColorScheme } from "./graph.model";
import { GRAPH_PALETTE, blendHex } from "./graph.model";

function isContainment(kind: WireEdgeKind): boolean {
  return kind === "contains" || kind === "anchored-at";
}

/** First-containment-parent map, the spine every walk below shares. */
function parents(nodes: readonly WireGraphNode[], edges: readonly WireGraphEdge[]): Map<string, string> {
  const known = new Set(nodes.map((node) => node.id));
  const parent = new Map<string, string>();
  for (const edge of edges) {
    if (!isContainment(edge.kind)) continue;
    if (edge.source === edge.target) continue;
    if (!known.has(edge.source) || !known.has(edge.target)) continue;
    // A second containment parent (a cycle, a hand-edited index) must not turn
    // the walk into a diamond: first edge wins, like `layout.ts`'s `analyse`.
    if (parent.has(edge.target)) continue;
    parent.set(edge.target, edge.source);
  }
  return parent;
}

// --- which group a node belongs to, and how deep inside it ------------------------

/** Where a node sits: which group, and how far below that group's anchor. */
export interface GroupPlace {
  /** The depth-1 branch id this node hangs from — its group. */
  readonly key: string;
  /** 0 for the group's anchor, 1 for its children, and so on. */
  readonly depth: number;
}

/**
 * Node id → its group and depth, for every node.
 *
 * The key is the id of the depth-1 branch the node sits under, or the node's
 * own id when there is no branch between it and the top (a root itself, a
 * loose note, an isolated island). Every node gets a place, so a caller never
 * has to decide what an absent one means.
 *
 * The walk is bounded by a `seen` set, so a containment cycle terminates
 * rather than hanging the column.
 */
export function groupPlaces(
  nodes: readonly WireGraphNode[],
  edges: readonly WireGraphEdge[],
): Map<string, GroupPlace> {
  const parent = parents(nodes, edges);
  const out = new Map<string, GroupPlace>();
  for (const node of nodes) {
    // Walk to the root, remembering the last step before it: that step is the
    // depth-1 branch, and it is the group. Distance travelled past it is the
    // node's depth inside the group.
    let current = node.id;
    let previous = node.id;
    let steps = 0;
    const seen = new Set<string>([current]);
    for (;;) {
      const next = parent.get(current);
      if (next === undefined || seen.has(next)) break;
      seen.add(next);
      previous = current;
      current = next;
      steps++;
    }
    // `steps` counts hops to the root; the group anchor is one hop below it,
    // so depth inside the group is one less. A root itself is depth 0.
    out.set(node.id, { key: previous, depth: Math.max(0, steps - 1) });
  }
  return out;
}

/** Node id → group key. The projection most callers want. */
export function groupKeys(
  nodes: readonly WireGraphNode[],
  edges: readonly WireGraphEdge[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, place] of groupPlaces(nodes, edges)) out.set(id, place.key);
  return out;
}

/** Group key → how many nodes it holds. Biggest groups get the first hues. */
export function groupSizes(keys: ReadonlyMap<string, string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const key of keys.values()) out.set(key, (out.get(key) ?? 0) + 1);
  return out;
}

// --- the hues ---------------------------------------------------------------------

/**
 * The hue ring: Catppuccin's named accents, **in hue-wheel order**.
 *
 * Dark is **Macchiato** and light is **Latte**, the two flavours `THEME_CSS`
 * is already built from, so the graph reads as the same product even though
 * these particular swatches appear nowhere else in the sheet.
 *
 * Wheel order (pink → mauve → red → peach → yellow → green → teal → sapphire
 * → blue → lavender) is what makes the *walk* across it meaningful: the ring
 * is stepped by {@link HUE_STRIDE} rather than one at a time, so consecutive
 * groups land on opposite sides of the wheel and two adjacent blobs are never
 * two neighbouring blues. An arbitrary hand-ordered list gave no such
 * guarantee, which is what made the previous assignment look random.
 *
 * The light row is *deepened* from stock Latte, exactly as the stylesheet
 * deepens its own status colours (`--weave-ok:#28641b` is not Latte green).
 * Stock Latte accents sit at 2.3–3.0:1 on `#eff1f5`, under the 3:1 non-text
 * floor — pretty on a marketing page, invisible as a 6-pixel disc. Each was
 * darkened along its own hue until the **deepest step of the ramp** still
 * cleared 3:1, which is a stronger condition than the hue alone clearing it.
 */
export const GROUP_HUES: Readonly<Record<ColorScheme, readonly string[]>> = {
  dark: [
    "#f5bde6", // pink
    "#c6a0f6", // mauve — the shell's own accent
    "#ed8796", // red
    "#f5a97f", // peach
    "#eed49f", // yellow
    "#a6da95", // green
    "#8bd5ca", // teal
    "#7dc4e4", // sapphire
    "#8aadf4", // blue
    "#b7bdf8", // lavender
  ],
  light: [
    "#824171", // pink
    "#7832d4", // mauve
    "#d20f39", // red
    "#9f3e07", // peach
    "#7b4e10", // yellow
    "#28641b", // green
    "#106368", // teal
    "#14616e", // sapphire
    "#1853c8", // blue
    "#445198", // lavender
  ],
};

/**
 * How far to step along the hue wheel between consecutive groups.
 *
 * 3 against a 10-entry ring visits every slot before repeating (3 and 10 are
 * coprime) while putting roughly a third of the wheel between one group and
 * the next — so the two largest blobs, which is what the eye lands on first,
 * are always strongly separated in hue. A stride of 1 would hand the two
 * biggest groups adjacent, easily-confused colours.
 */
export const HUE_STRIDE = 3;

/**
 * Group key → its one primary hue, assigned **biggest group first**.
 *
 * Size order rather than id order, because the biggest blob is the one a
 * reader orients by and it should get the most distinct colours first. Ties
 * break on the key, so the assignment is a pure function of the graph and
 * never of insertion order.
 *
 * More groups than hues wraps the ring. Two groups then share a colour, which
 * is honest: at eleven simultaneous groups the colour channel is saturated and
 * position is doing the work anyway.
 */
export function groupColors(keys: ReadonlyMap<string, string>, scheme: ColorScheme): Map<string, string> {
  const ring = GROUP_HUES[scheme];
  const sizes = groupSizes(keys);
  const ordered = [...sizes.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const out = new Map<string, string>();
  ordered.forEach(([key], index) => out.set(key, ring[(index * HUE_STRIDE) % ring.length]!));
  return out;
}

// --- the ramp inside one group ------------------------------------------------------

/**
 * How far one level of depth steps the hue toward the ground.
 *
 * Small, and capped by {@link MAX_SHADE}: the ramp exists to show structure
 * *within* one colour family, and a step big enough to read as a different
 * colour would undo the grouping it is meant to express.
 */
export const DEPTH_SHADE = 0.11;

/**
 * The deepest any member may be shaded.
 *
 * This is the number the light ring is deepened against — every hue must still
 * clear 3:1 on its ground *at this shade*, which the contrast test asserts for
 * every hue at every depth.
 */
export const MAX_SHADE = 0.34;

/** A member's fill: its group's one hue, stepped back by its depth. */
export function shadeFor(hue: string, depth: number, scheme: ColorScheme): string {
  const steps = Number.isFinite(depth) && depth > 0 ? depth : 0;
  return blendHex(hue, GRAPH_PALETTE[scheme].ground, Math.min(MAX_SHADE, steps * DEPTH_SHADE));
}

// --- bridges between groups ----------------------------------------------------------

/**
 * How much of a foreign group's colour a bridging node takes on, per group it
 * reaches.
 *
 * Enough to be visible against its siblings, small enough that the node still
 * reads as a member of its own group rather than as a defector. Two foreign
 * groups tint twice, which is the intent — a node joining three families
 * should look like it.
 */
export const BRIDGE_SHARE = 0.26;

/** Total foreign tint, however many groups a node bridges. */
export const MAX_BRIDGE = 0.55;

/**
 * Mix the foreign groups' primaries into a node's own colour.
 *
 * Each foreign hue is blended in at {@link BRIDGE_SHARE}, in a fixed order
 * (the caller sorts), so the result is deterministic rather than dependent on
 * edge iteration order. The total is capped at {@link MAX_BRIDGE} so a
 * promiscuously-linked hub does not end up painted entirely in other people's
 * colours.
 */
export function bridgeBlend(own: string, foreign: readonly string[], scheme: ColorScheme): string {
  if (foreign.length === 0) return own;
  let out = own;
  let spent = 0;
  for (const hue of foreign) {
    const share = Math.min(BRIDGE_SHARE, MAX_BRIDGE - spent);
    if (share <= 0) break;
    spent += share;
    // Blend into the running colour, not into `own`: successive mixes
    // compound, which is what makes a three-way bridge read differently from
    // a two-way one. `scheme` is unused by the arithmetic but kept in the
    // signature so a future scheme-aware mix does not change every caller.
    out = blendHex(out, hue, share);
  }
  return out;
}

// --- the whole assignment --------------------------------------------------------------

/**
 * Node id → fill: group hue, depth shade, and any bridge tint.
 *
 * One call for the caller, and the only place the three steps are composed —
 * so a renderer cannot apply the ramp twice or skip the tint for one kind.
 */
export function groupNodeColors(
  nodes: readonly WireGraphNode[],
  edges: readonly WireGraphEdge[],
  scheme: ColorScheme,
): Map<string, string> {
  const places = groupPlaces(nodes, edges);
  const keys = new Map<string, string>();
  for (const [id, place] of places) keys.set(id, place.key);
  const hues = groupColors(keys, scheme);

  // Which foreign groups each node associates with. Containment is excluded:
  // it is what put the node in its group, so it can never be a bridge.
  const known = new Set(nodes.map((node) => node.id));
  const reaches = new Map<string, Set<string>>();
  const note = (from: string, to: string): void => {
    const here = places.get(from)?.key;
    const there = places.get(to)?.key;
    if (here === undefined || there === undefined || here === there) return;
    const set = reaches.get(from);
    if (set === undefined) reaches.set(from, new Set([there]));
    else set.add(there);
  };
  for (const edge of edges) {
    if (isContainment(edge.kind)) continue;
    if (edge.source === edge.target) continue;
    if (!known.has(edge.source) || !known.has(edge.target)) continue;
    note(edge.source, edge.target);
    note(edge.target, edge.source);
  }

  const out = new Map<string, string>();
  for (const node of nodes) {
    const place = places.get(node.id);
    if (place === undefined) continue;
    const hue = hues.get(place.key);
    if (hue === undefined) continue;
    const mine = shadeFor(hue, place.depth, scheme);
    // Sorted, so the blend order — and therefore the exact hex — is a function
    // of the graph rather than of the order edges happened to arrive in.
    const foreign = [...(reaches.get(node.id) ?? [])]
      .sort()
      .map((key) => hues.get(key))
      .filter((value): value is string => value !== undefined);
    out.set(node.id, bridgeBlend(mine, foreign, scheme));
  }
  return out;
}
