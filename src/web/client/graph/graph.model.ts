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

import { COLLIDE_RADIUS, MAX_NODE_SIZE, MIN_NODE_SIZE, nodeSize } from "../../shared/layout";
import type { Point } from "../../shared/layout";
/* Re-exported for the renderer and the tests, under the render model's name.
   The definition stays in `shared/layout.ts` — see the sizes section below. */
export {
  DEGREE_AT_MAX_SIZE,
  MAX_NODE_SIZE,
  MIN_NODE_SIZE,
  NODE_RADIUS,
  nodeSize,
} from "../../shared/layout";
import { listLabel } from "../../shared/view";
import type { WireEdgeKind, WireGraphEdge, WireGraphNode, WireNodeKind, WireNoteSource } from "../../shared/wire";
import { provenanceGlyph } from "../tree/tree.model";

// --- the palette ----------------------------------------------------------------

/** Which theme colour a thing is painted in. The TUI's slot names, verbatim. */
export type ColorSlot = "accent" | "success" | "warning" | "dim" | "text" | "muted" | "line" | "ground";

/** Dark or light. Chosen by the shell from `prefers-color-scheme`, never read here. */
export type ColorScheme = "dark" | "light";

/**
 * Slot → hex, per scheme.
 *
 * Every value is copied from `shell/theme.ts`'s `THEME_CSS`:
 * `accent`→`--weave-accent`, `success`→`--weave-ok`, `warning`→`--weave-warn`,
 * `dim`→`--weave-dim`, `text`→`--weave-fg`, `muted`→`--weave-faint`,
 * `line`→`--weave-line-strong`, `ground`→`--weave-bg` (the canvas the WebGL
 * floats on, which no slot previously named because nothing painted it — the
 * recession blend below needs it as a *value*, not as a contrast judgement).
 * The dark block is `:root`; the light block is the
 * `prefers-color-scheme: light` override.
 */
export const GRAPH_PALETTE: Readonly<Record<ColorScheme, Readonly<Record<ColorSlot, string>>>> = {
  dark: {
    accent: "#c6a0f6",
    success: "#a6da95",
    warning: "#eed49f",
    dim: "#a5adcb",
    text: "#cad3f5",
    muted: "#939ab7",
    line: "#494d64",
    ground: "#24273a",
  },
  light: {
    accent: "#7113ec",
    success: "#28641b",
    warning: "#7c4f10",
    dim: "#56586a",
    text: "#4c4f69",
    muted: "#606274",
    line: "#bcc0cc",
    ground: "#eff1f5",
  },
};

/**
 * Node kind → colour slot.
 *
 * The shell's design language (shell/theme.ts) is **three greys doing the
 * structural work and one accent used sparingly** — success/warning are
 * status colours there (provenance badges, the connection dot), not
 * decoration. Mapping code kinds onto them painted the canvas green and
 * amber and read as a different app inside the workspace, so every kind
 * except the three that carry identity recedes into `dim`:
 *
 * - `vault` / `repository` keep `accent` — the two knowledge anchors, the
 *   same violet the note column's wikilinks are painted in.
 * - `note` keeps `text` — notes are the product (§1.1), and their identity
 *   is carried by the provenance badge, not by a hue.
 * - Generated code — modules, packages, entry points, git, externals, files
 *   — takes `dim`, the same grey a `generated` row takes in the tree. The
 *   TUI's `kindStyle` (src/pi/viewer/tui/theme.ts) still maps these kinds to
 *   success/warning; the two media disagree on purpose, because a pi theme
 *   has no dark/light stylesheet to violate and a terminal can restyle
 *   everything. Here the sheet decides, and the sheet says calm.
 */
export const KIND_SLOT: Readonly<Record<WireNodeKind, ColorSlot>> = {
  vault: "accent",
  note: "text",
  repository: "accent",
  module: "dim",
  package: "dim",
  entryPoint: "dim",
  gitState: "dim",
  external: "dim",
  file: "dim",
};

/**
 * Edge kind → colour slot. Structure recedes; association is the accent.
 *
 * "Recedes" used to mean `line` (`--weave-line-strong`), which read as
 * *absent* — 1.5:1 against either background, below the 3:1 non-text minimum,
 * and the reason the skeleton of the graph was invisible until something was
 * selected. The `dim` slot is 6.6:1 against the dark ground and 6.2:1
 * against the light one, so containment reads as the hairline scaffolding it
 * is without vanishing.
 *
 * `mentions` joins `links-to` on the accent. Both are content associations
 * between human knowledge and the rest of the graph — splitting them across
 * two hues is what put a rainbow on the canvas — and §1.3's rail is where
 * the two kinds are told apart, at reading size, with labels.
 */
export const EDGE_SLOT: Readonly<Record<WireEdgeKind, ColorSlot>> = {
  contains: "dim",
  "anchored-at": "dim",
  "links-to": "accent",
  mentions: "accent",
};

/** The colour a node kind is drawn in. */
export function kindColor(kind: WireNodeKind, scheme: ColorScheme): string {
  return GRAPH_PALETTE[scheme][KIND_SLOT[kind]];
}

/** The colour an edge kind is drawn in. */
export function edgeColor(kind: WireEdgeKind, scheme: ColorScheme): string {
  return GRAPH_PALETTE[scheme][EDGE_SLOT[kind]];
}

/**
 * The colour an edge kind is *painted* in — its slot colour, recessed toward
 * the ground when it is structural.
 *
 * Two edge populations share the canvas and they are not equally important.
 * The containment web is the skeleton — always on, one pixel wide, and at the
 * old full-strength `dim` the brightest thing on the stage when nothing was
 * selected, which is most of the time. So structure draws at
 * {@link EDGE_RECESS_STRENGTH} toward the ground: still a hairline you can
 * follow, no longer louder than the nodes it connects. Association keeps its
 * exact slot colour — the accent is the only chroma voice the sheet has, and
 * a wikilink is what the eye is here to find.
 */
export function edgeDrawColor(kind: WireEdgeKind, scheme: ColorScheme): string {
  return isStructuralEdge(kind) ? recessColor(edgeColor(kind, scheme), scheme, EDGE_RECESS_STRENGTH) : edgeColor(kind, scheme);
}

/** Containment and anchoring are the hairline scaffolding; the rest is content. */
function isStructuralEdge(kind: WireEdgeKind): boolean {
  return kind === "contains" || kind === "anchored-at";
}

// --- receding a colour, without changing its hue -----------------------------------

/**
 * How far an unrelated node recedes toward the ground, as a linear blend.
 *
 * 85 % toward the ground is what reads as "still there, but gone from the
 * conversation": 100 % would delete the context the highlight exists to place
 * a selection inside, and the old 0 % (a repaint to `muted`) *swapped the
 * hue* — every unrelated node turned the same grey, so the cloud lost the
 * colour identities that told you what you were looking past, and dimming
 * read as "different" rather than "further away". 15 % of a node's own colour
 * is a whisper of its identity from the ground it stands on.
 */
export const RECESS_STRENGTH = 0.85;

/**
 * Structural edges recede less than nodes do.
 *
 * An edge has no identity to lose (it is hairline scaffolding, drawn from the
 * same slot whether related or not) but it must keep the 3:1 non-text minimum
 * against the ground, or the skeleton disappears with the rest. The Catppuccin
 * palettes cap this per scheme: the light blend crosses the 3:1 non-text
 * minimum at 0.33 of the way to the `#eff1f5` ground, dark at 0.46, and one
 * constant serves both at **0.30** — light `dim` lands at 3.2:1, dark at
 * 4.0:1. Below this, see `edgeDrawColor` for what it buys.
 */
export const EDGE_RECESS_STRENGTH = 0.3;

/**
 * Hex `#rrggbb` → hex `#rrggbb`, each channel blended `t` of the way to
 * `toward`.
 *
 * RGB-channel (not HSL, not alpha) because the consumers are concrete
 * colours sigma feeds to WebGL — `renderGraph` pre-multiplies nothing, sigma
 * has no per-item alpha, and a hex is the one format every participant
 * already understands. Returns the input untouched when it is not a six-digit
 * hex, so the highlight's well-formed palette and a hand-mangled colour can
 * never meet in the middle.
 */
export function blendHex(color: string, toward: string, t: number): string {
  const parse = (hex: string): readonly [number, number, number] | null => {
    if (!/^#[0-9a-f]{6}$/.test(hex)) return null;
    return [
      Number.parseInt(hex.slice(1, 3), 16),
      Number.parseInt(hex.slice(3, 5), 16),
      Number.parseInt(hex.slice(5, 7), 16),
    ];
  };
  const from = parse(color);
  const to = parse(toward);
  if (from === null || to === null) return color;
  const clamped = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  const channel = (a: number, b: number): string => Math.round(a + (b - a) * clamped).toString(16).padStart(2, "0");
  return `#${channel(from[0], to[0])}${channel(from[1], to[1])}${channel(from[2], to[2])}`;
}

/**
 * Blend a colour toward its scheme's ground — the one direction "dimmer"
 * is allowed to mean here.
 *
 * WebGL has no per-node opacity to dial, so recession is arithmetic on the
 * concrete colour: the node keeps its hue, loses its contrast. The scheme
 * rather than the caller owns the destination because the ground is a
 * *palette* fact, and the palette-mirror test already ties this module's hexes
 * to the stylesheet's.
 */
export function recessColor(color: string, scheme: ColorScheme, t: number = RECESS_STRENGTH): string {
  return blendHex(color, GRAPH_PALETTE[scheme].ground, t);
}

// --- sizes ------------------------------------------------------------------------

/**
 * The degree → radius ramp lives in `shared/layout.ts` and is re-exported
 * under its render name, not copied.
 *
 * It has to be *one* function in one place, because the collision force and
 * the drawn circles are the same question: a size the layout did not reserve
 * room for makes §8's `minPairwiseDistance > 2 · NODE_RADIUS` assertion true
 * of the positions and false of the screen — the exact gap Tier 0 closed the
 * other way. The ramp moved there (leaf floor 6, base 9, hub ceiling 18 at
 * degree 32) when the Tier 6 "graph as hero" pass widened it; the renderer's
 * view of the decision is unchanged, and {@link renderGraph} still calls it
 * per node with its incident-edge degree.
 *
 * The re-export itself sits with the imports at the top of the file — the
 * render model's sizes section is a *pointer*, not a second definition.
 */

/** Edge thickness by kind. A wikilink keeps its weight; structure is hairline. */
export const EDGE_SIZE: Readonly<Record<WireEdgeKind, number>> = {
  contains: 1,
  "anchored-at": 1,
  "links-to": 1.4,
  mentions: 1,
};

/**
 * How much more presence an in-neighbourhood edge has when a selection dims
 * the rest, as a size multiplier.
 *
 * The neighbourhood's edges are the one thing a redraw is *about* — they are
 * what "related" means drawn — and a 1-unit hairline at the recessed rest
 * colour would tell that story at the same volume as the background. 1.6× plus
 * the full slot colour (the reducer's job) is a visible step at every zoom,
 * and it multiplies rather than adds so a wikilink keeps its 1.4 weight
 * advantage over the hairline it rides.
 */
export const EDGE_PRESENCE = 1.6;

// --- labels -------------------------------------------------------------------------

/**
 * The character budget a drawn node label may spend, provenance badge included.
 *
 * Sigma draws node labels whole and their canvas keeps painting past the
 * column edge, so a long note title was not truncated at all — it was *clipped
 * by the container's* `overflow:hidden` mid-word, which is how "…we are working
 * besides oth…" reached the screenshot. Budgeting here puts the cut where we
 * can make it a decision: 32 characters is about what a column-width overview
 * can read next to its node before the canvas edge starts doing the cutting,
 * short enough that a full row of labels stays inside the stage, and above
 * core's longest composite name (the disambiguated package, 29) so
 * `listLabel`'s one-name-everywhere contract survives the budget.
 */
export const LABEL_BUDGET = 32;

/** Half of the budget, kept as the floor of a word boundary's usefulness. */
const LABEL_MIN_KEEP = LABEL_BUDGET / 2;

/**
 * Truncate to `budget` characters on a **word boundary**.
 *
 * Sigma's own truncation (its edge-label helper) walks backwards one character
 * at a time — correct about the pixels, and the reason truncation reads as a
 * hard cut: it lands wherever the width runs out, which is mid-word as often
 * as not. Here the ellipsis is placed on the last word break inside the
 * budget, so the reader keeps whole words; only a label with no break at all
 * (a slug, a hash) falls back to the character cut, because half of an
 * unbroken token is the best reading there is.
 *
 * Guaranteed: the result is never longer than `budget` (the cut plus the
 * ellipsis character), it ends in `…`, and idempotent — truncating an already
 * truncated label cannot truncate again, because the ellipsis rides inside the
 * last budget.
 */
export function truncateLabel(text: string, budget: number = LABEL_BUDGET): string {
  if (budget <= 0) return text.length > 0 ? "…" : text;
  if (text.length <= budget) return text;
  // `budget - 1` for the ellipsis this result will carry, so the *whole*
  // drawn string stays inside the budget rather than the visible text alone.
  const room = budget - 1;
  const head = text.slice(0, room);
  const break_ = head.lastIndexOf(" ");
  const cutAt = break_ >= LABEL_MIN_KEEP ? break_ : room;
  return `${text.slice(0, cutAt).trimEnd()}…`;
}

/**
 * The label sigma draws.
 *
 * `listLabel` is core's (§3) — the same function the tree column and the
 * context rail call, so a node cannot be named one thing in one column and
 * something else in another. The provenance badge is `tree.model.ts`'s glyph,
 * for the same reason and for AGENTS.md rule 4: agent-written content must
 * never look human-authored, and a filled/half/hollow shape survives
 * greyscale, colour-blindness and a WebGL colour ramp in a way a hue does not.
 * The word-boundary budget keeps the canvas's clip from making that vocabulary
 * look mid-word — see {@link truncateLabel}.
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
  return truncateLabel(badge === "" ? label : `${badge} ${label}`);
}

// --- the hover label (§7.4) ---------------------------------------------------------

/**
 * The 2D canvas slice {@link hoverLabelPainter} writes to.
 *
 * Structural for the same reason `RenderContainer` is (see `renderer.ts`): a
 * test importing this module drags it into the root `tsconfig.json` project,
 * which has no `DOM` lib, so naming `CanvasRenderingContext2D` here would
 * break the typecheck for every core test. Every member is used below, so the
 * port cannot grow something nothing calls — and because it is a plain
 * object shape, the painter is covered by an ordinary unit test against a
 * recording fake rather than sitting behind §10's canvas wall.
 */
export interface HoverLabelContext {
  font: string;
  /**
   * `unknown` rather than `string`, and only because the real thing is
   * `string | CanvasGradient | CanvasPattern` — naming either of those DOM
   * types here is what this port exists to avoid, and narrowing to `string`
   * makes `CanvasRenderingContext2D` fail to satisfy the port. Written to, never
   * read, so nothing downstream has to widen.
   */
  fillStyle: unknown;
  textAlign: string;
  shadowColor: string;
  shadowBlur: number;
  save(): void;
  restore(): void;
  fillText(text: string, x: number, y: number): void;
}

/** The node attributes sigma hands a hover painter, narrowed to what is read. */
export interface HoverLabelNode {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly label: string | null;
}

/** The settings a hover painter reads. Both `GraphSettings` and sigma's satisfy it. */
export interface HoverLabelSettings {
  readonly labelSize: number;
  readonly labelFont: string;
}

/**
 * The gap between the bottom of the node and the cap height of its name, in
 * screen pixels.
 *
 * Far enough that the text is not touching the disc at the sizes the ramp
 * produces (leaf 6 → hub 18 layout units), close enough that the name still
 * reads as belonging to *that* node rather than floating between two of them.
 */
export const HOVER_LABEL_GAP = 6;

/**
 * How far the hover label's shadow spreads, in pixels.
 *
 * Not decoration — legibility. The label is drawn over whatever the graph
 * happens to have under the node (edges, a receded cloud, another label), and
 * a ground-coloured blur is what separates the glyphs from that without
 * putting an opaque box on the canvas. Sigma's own `drawDiscNodeHover` draws
 * the box instead, hardcoded `#FFF`, which is why it is replaced rather than
 * configured.
 */
export const HOVER_LABEL_SHADOW = 6;

/**
 * Sigma's `defaultDrawNodeHover`, as a scheme-bound pure function (§7.4).
 *
 * Obsidian's gesture, which is the reference: the hovered node's name floats
 * **centred underneath it**, in the theme's own text colour, with no
 * container. The alternative shipped by sigma is a white rounded box with the
 * text to the node's *right* — wrong colour in both schemes, and wrong place
 * when the neighbourhood highlight has just grown the node the label is
 * naming.
 *
 * Being the hover painter also fixes a second thing for free: sigma draws this
 * regardless of `labelRenderedSizeThreshold`, so a leaf too small to carry a
 * standing label still answers the pointer with its name.
 *
 * `save`/`restore` around the whole thing because `textAlign`, the shadow and
 * the fill are shared canvas state — sigma reuses the same context for every
 * other label in the frame, and a leaked `textAlign: "center"` would silently
 * re-align them all.
 */
export function hoverLabelPainter(
  scheme: ColorScheme,
): (context: HoverLabelContext, data: HoverLabelNode, settings: HoverLabelSettings) => void {
  return (context, data, settings) => {
    // `nodeReducer` blanks the label of everything outside the highlight, and
    // a node with no name has nothing to float.
    if (data.label === null || data.label === "") return;
    const palette = GRAPH_PALETTE[scheme];
    context.save();
    context.font = `${settings.labelSize}px ${settings.labelFont}`;
    context.textAlign = "center";
    context.shadowColor = palette.ground;
    context.shadowBlur = HOVER_LABEL_SHADOW;
    context.fillStyle = palette.text;
    // `data.size` is already the *scaled* radius sigma is about to draw, so the
    // baseline clears the disc at every zoom rather than at one of them.
    context.fillText(data.label, data.x, data.y + data.size + settings.labelSize + HOVER_LABEL_GAP);
    context.restore();
  };
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

/** The normalization box the renderer freezes the view to. See {@link frameBox}. */
export interface ViewBox {
  readonly x: readonly [number, number];
  readonly y: readonly [number, number];
}

/**
 * The box the graph is framed on — sigma's `customBBox`.
 *
 * ## Why a box is frozen at all
 *
 * Sigma's default `autoRescale` recomputes the graph→viewport normalization
 * from the **current extent on every refresh**, and a drag repaints every
 * frame. The consequence, measured on this repository's graph: the moment a
 * dragged node crosses the extent boundary — at the edge of the view — the
 * whole graph rescales under the cursor, so the view "suddenly makes a
 * distance" and the node ends up dragged very far from the centre while the
 * user chases it. A frozen box makes the coordinates stable for the whole
 * session: the node stays under the cursor, the canvas bounds the drag, and
 * `[fit]` re-frames onto whatever the current positions are.
 *
 * The box is the exact extent of the rendered positions — no padding of its
 * own, because sigma's `stagePadding` (in pixels) already insets the fit, and
 * the same box handed back on `fit()` re-frames dragged-apart graphs.
 *
 * `null` for an empty graph: there is nothing to frame, and the caller
 * clears the override so sigma falls back to its own behaviour.
 */
export function frameBox(points: readonly Point[]): ViewBox | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let seen = 0;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    seen++;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  if (seen === 0) return null;
  return { x: [minX, maxX], y: [minY, maxY] };
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
  /**
   * Per-node fills that override the kind palette — `groups.ts`'s
   * group-hue assignment, or absent for the kind-only colouring.
   *
   * Injected rather than computed here because it is a *policy* (§15.8's
   * `colors` setting) and this function is the mechanism. An id the map does
   * not name falls back to {@link kindColor}, so a partial map is safe.
   */
  groupFills?: ReadonlyMap<string, string>,
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
      color: groupFills?.get(id) ?? kindColor(node.kind, scheme),
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
      color: edgeDrawColor(edge.kind, scheme),
      kind: edge.kind,
      // Under every node, always: an edge painted over a hub reads as a line
      // through it. Node zIndexes start at the leaf floor rounded, i.e. 6.
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
  readonly zIndex?: number;
  readonly size?: number;
}

/**
 * sigma's `nodeReducer`, as a pure function (§7.4).
 *
 * `highlight` is `null` when nothing is selected, and that is deliberately not
 * the same as an empty set: nothing selected means *everything* renders
 * normally, where an empty neighbourhood (a selection that is not in this
 * graph) means everything is outside it and recedes. Collapsing the two would
 * make a stale selection silently blank the column.
 *
 * Outside nodes **recede, they do not change colour** (§8's P6.2): their own
 * colour is blended {@link RECESS_STRENGTH} toward the ground, so the cloud
 * keeps every node's identity at a whisper of its contrast instead of being
 * repainted to one grey — the old hue-swap made an unrelated module, note and
 * file three copies of the same grey, and "dim" read as "different" rather
 * than "further away". Position and size are untouched, and the label is gone:
 * hiding nodes outright would make the graph *move* on selection — sigma's
 * autoscale reframes on the visible extent — and a graph that reflows when you
 * click it is unusable.
 */
export function nodeReducer(
  highlight: ReadonlySet<string> | null,
  /**
   * The selected node itself, distinguished from its neighbours.
   *
   * `highlight` is `focusNeighborhood`'s answer — the selection *plus* its
   * direct neighbours — and painting the two identically loses the one fact
   * the gesture was about: which node was clicked. Optional, so a caller with
   * only a neighbourhood keeps the previous two-tier behaviour.
   */
  selectedId?: string | null,
  /**
   * How far the highlight has faded in, 0 → 1. Defaults to 1, so a caller
   * that does not animate gets the finished picture and nothing has to know
   * about the clock.
   */
  progress: number = 1,
): (id: string, data: RenderNode, scheme: ColorScheme) => NodeDisplayOverride {
  return (id, data, scheme) => {
    // `progress` at zero is indistinguishable from no highlight, and saying so
    // here is what lets the fade end by *returning* to the unhighlighted graph
    // rather than by approaching it.
    if (highlight === null || progress <= 0) return {};
    if (id === selectedId && highlight.has(id)) {
      // The subject of the gesture: lifted clear of its own neighbourhood and
      // grown by a ratio rather than to a fixed radius, so a hub still reads
      // as bigger than the leaf beside it while both read as "this one".
      return { zIndex: data.zIndex + HIGHLIGHT_Z_LIFT * 2, size: data.size * growth(SELECTED_GROWTH, progress) };
    }
    // A connected node: its own group colour at full strength, lifted above
    // the cloud, and grown a little. The step between "connected" and
    // "unrelated" used to be carried entirely by the *recession of everything
    // else*, which reads as the graph dimming rather than as a neighbourhood
    // being named — the difference matters most on a big canvas, where the
    // receded cloud is far off-screen and the only thing visible is a
    // neighbourhood that looks exactly like it did before the click.
    if (highlight.has(id)) return { zIndex: data.zIndex + HIGHLIGHT_Z_LIFT, size: data.size * growth(NEIGHBOUR_GROWTH, progress) };
    return {
      color: recessColor(data.color, scheme, RECESS_STRENGTH * progress),
      label: progress >= LABEL_DROP_AT ? null : data.label,
      zIndex: 0,
    };
  };
}

// --- the highlight fade (§7.4) -----------------------------------------------------

/**
 * The time constant of the highlight fade, in milliseconds.
 *
 * The highlight used to arrive and leave in **one frame**, and the frame that
 * hurt was the *leaving* one: 85 % of the canvas snapping from recessed back
 * to full contrast reads as the whole graph flashing, which is louder than
 * the dimming it is undoing. Sliding the recession in and out is what turns
 * two states into one gesture.
 *
 * A time *constant* rather than a duration because {@link fadeStep} is an
 * exponential approach, not a linear ramp — progress covers 63 % of the
 * remaining distance every `TAU` ms, so the motion is ease-out by
 * construction with no easing curve to pick, and it is frame-rate independent
 * for free. 60 ms puts the visible settle at roughly 200 ms, which is the
 * range a hover can afford: slower and pointing at a node feels unanswered.
 */
export const HIGHLIGHT_FADE_TAU = 60;

/**
 * How close to the target counts as arrived.
 *
 * An exponential approach never actually lands, so without a snap the clock
 * would run forever repainting changes below a rounding error. At 0.004 the
 * remaining recession is under half a colour step on an 8-bit channel —
 * invisible, and about five time constants in.
 */
export const FADE_EPSILON = 0.004;

/**
 * Advance a fade toward its target. Pure; the clock is the caller's.
 *
 * `progress` is how *present* the highlight is: 0 renders exactly as no
 * highlight at all, 1 is the full treatment. The target is therefore always
 * one of those two — what fades is the presence of the effect, never the
 * membership of the set. A neighbourhood that changes while the highlight is
 * already up (hover moves from one node to the next) swaps instantly and
 * stays at 1, because a cross-fade between two neighbourhoods is a picture of
 * neither.
 *
 * A backgrounded tab hands back a multi-second `elapsedMs`, and the
 * exponential handles it correctly by arriving: `exp(-big)` is 0.
 */
export function fadeStep(progress: number, target: number, elapsedMs: number): number {
  const elapsed = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  const next = target + (progress - target) * Math.exp(-elapsed / HIGHLIGHT_FADE_TAU);
  return Math.abs(target - next) < FADE_EPSILON ? target : next;
}

/** Interpolate a size multiplier by the fade's progress. 0 → untouched, 1 → `to`. */
function growth(to: number, progress: number): number {
  return 1 + (to - 1) * progress;
}

/**
 * The fade point at which the cloud's labels are dropped.
 *
 * Text is the one thing on this canvas that cannot fade — sigma draws labels
 * opaque, and there is no per-label alpha to ramp. So the drop is a step, and
 * the least visible place to put a step is the middle of the fade, where the
 * cloud is already half receded and the eye is following the neighbourhood
 * rather than the text it is losing.
 */
export const LABEL_DROP_AT = 0.5;

/**
 * How much the selected node grows, as a size multiplier.
 *
 * A ratio, not a fixed radius: the degree ramp's whole job is that a hub is
 * visibly bigger than a leaf, and selecting a leaf must not make it the
 * largest thing on the stage. 1.45× is a clear step at every zoom — sizes are
 * in layout units (`itemSizesReference: "positions"`), so it survives zooming
 * out, unlike a pixel bump.
 */
export const SELECTED_GROWTH = 1.45;

/** The same idea, one step down, for a directly connected node. */
export const NEIGHBOUR_GROWTH = 1.15;

/**
 * How far a highlighted node is lifted above the rest.
 *
 * Above every unhighlighted node's z (which is the degree ramp's ceiling
 * rounded) so the neighbourhood paints as one layer rather than interleaved
 * with the cloud it is standing out from.
 */
export const HIGHLIGHT_Z_LIFT = MAX_NODE_SIZE + 1;

/**
 * sigma's `edgeReducer` (§7.4).
 *
 * An edge is inside the neighbourhood only when **both** endpoints are.
 * `focusNeighborhood` returns the selection plus its direct neighbours, so
 * "both endpoints inside" is exactly the set of edges incident on the
 * selection, plus any edge that happens to join two of its neighbours — which
 * is information about the selection's neighbourhood and belongs in it.
 *
 * The two halves get a **step between them** rather than a binary presence:
 * in-neighbourhood edges lift their z above the background's and thicken by
 * {@link EDGE_PRESENCE}, while the rest recede to their own colour blended
 * toward the ground — the same recession the cloud's nodes take, so the
 * selection's story (its relationships) is the only thing at full contrast.
 * Hiding the background outright was tried; the highlight then deleted the
 * context it exists to place the selection inside, and a receded edge is
 * still the hairline it ever was.
 */
export function edgeReducer(
  highlight: ReadonlySet<string> | null,
  /** The selection, so an edge *touching* it outranks one merely near it. */
  selectedId?: string | null,
  /** The fade's progress — see {@link nodeReducer}'s. */
  progress: number = 1,
): (key: string, data: RenderEdge, scheme: ColorScheme) => EdgeDisplayOverride {
  return (_key, data, scheme) => {
    if (highlight === null || progress <= 0) return {};
    if (!highlight.has(data.source) || !highlight.has(data.target)) {
      return { color: recessColor(data.color, scheme, RECESS_STRENGTH * progress) };
    }
    // Incident on the selection itself — these are the node's actual links,
    // and they are what "connected" means drawn. Painted in the accent so a
    // containment hairline joining the selection stops reading as scaffolding
    // for as long as the selection stands, and thickened a step beyond the
    // neighbourhood's own edges.
    if (selectedId != null && (data.source === selectedId || data.target === selectedId)) {
      return {
        zIndex: 2,
        size: data.size * growth(EDGE_PRESENCE * 1.35, progress),
        // Blended rather than switched, so the link arrives *as* the accent
        // instead of flicking to it a frame before the rest of the fade.
        color: blendHex(data.color, GRAPH_PALETTE[scheme].accent, progress),
      };
    }
    // Between two neighbours, but not touching the selection: real context,
    // one step quieter.
    return { zIndex: 1, size: data.size * growth(EDGE_PRESENCE, progress) };
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
  readonly enableCameraPanning: boolean;
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
  /** Ours, not sigma's white box — see {@link hoverLabelPainter}. */
  readonly defaultDrawNodeHover: (context: HoverLabelContext, data: HoverLabelNode, settings: HoverLabelSettings) => void;
}

/**
 * Semantic zoom: the rendered size below which a label is suppressed (§7.4).
 *
 * Derived, not tuned. {@link nodeSize} maps degree 0 onto
 * {@link MIN_NODE_SIZE} and `DEGREE_AT_MAX_SIZE` onto {@link MAX_NODE_SIZE},
 * so a threshold placed at the midpoint of that range means "label the nodes
 * that are structurally significant at this zoom" — hubs first, leaves once
 * you have zoomed in far enough that their rendered size crosses the line.
 * The midpoint of the *widened* ramp (12 units, degree ≈ 5) labels
 * structurally significant nodes at overview, which is what the "hero" pass
 * wants the labels to say: names for the places, not every leaf.
 */
export const LABEL_SIZE_THRESHOLD = (MIN_NODE_SIZE + MAX_NODE_SIZE) / 2;

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
    // The renderer toggles this off while a node is being dragged, so the
    // gesture pins the node to the cursor instead of panning the camera.
    enableCameraPanning: true,
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
    // `nodeSize`'s ramp to §8's `minPairwiseDistance` assertion: under the
    // default (`"screen"`) a node keeps its pixel size as you zoom out, so a
    // provably non-overlapping layout still renders as a solid blob at low
    // zoom.
    itemSizesReference: "positions",
    zoomToSizeRatioFunction: (ratio) => ratio,
    stagePadding: COLLIDE_RADIUS,
    defaultDrawNodeHover: hoverLabelPainter(scheme),
    // The container is a real element by construction (the renderer is mounted
    // from a `ref`), but sigma also validates that it has a non-zero size —
    // and a column that is behind a `medium` breakpoint toggle legitimately
    // has none until it is revealed. Throwing there would take the whole
    // workspace down over a column the user cannot see.
    allowInvalidContainer: true,
  };
}
