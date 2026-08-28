/**
 * The three-column layout, as pure data (weave-workspace §1.2).
 *
 * §1.2 is emphatic that there is exactly one layout: three resizable columns,
 * a context rail under the graph, widths in `localStorage`, and two
 * breakpoints. No panel engine, no presets. This module is that entire
 * "layout system" — and it is a `.model.ts` rather than logic inside a
 * component because there is no DOM test environment in this repository and
 * we may not add one (§10). Everything below is a pure function over plain
 * objects, so the drag arithmetic, the breakpoint table and the persistence
 * validation are all covered by ordinary unit tests; `Shell.tsx` is left with
 * nothing to do but render what these functions return.
 *
 * ## Widths are fractions, not pixels
 *
 * A stored pixel width is wrong the moment the window is resized, and worse,
 * it is wrong *silently* — restore a 1600 px session on a 1200 px laptop and
 * a column is simply off-screen. So the persisted unit is a fraction of the
 * available width, and pixels only ever exist inside {@link resolveColumns},
 * at the moment of rendering, where the viewport width is known.
 *
 * The invariant that makes this safe is {@link normalizeFractions}: the three
 * fractions always sum to exactly 1 and none is below its minimum share. It
 * is applied on *every* path into a {@link LayoutState} — construction,
 * drag, and deserialization alike — so no caller can produce a state that
 * violates it. That is deliberately stronger than validating at the edges: a
 * layout that has drifted to summing 0.97 renders a 3 % dead stripe that
 * nobody will trace back to a rounding bug three releases ago.
 *
 * ## Tier rules (§2)
 *
 * `src/web/client/**`: no `node:*`, no `src/core`. This file goes further and
 * touches no DOM type either — {@link LayoutStorage} is a two-method
 * interface, not `Storage`, and the viewport arrives as a number. That is
 * what lets the root `tsconfig.json` project (which has no `DOM` lib) compile
 * the tests that import it.
 */

// --- columns -----------------------------------------------------------------

/** The three columns of §1.2, left to right. */
export type ColumnId = "tree" | "note" | "graph";

/** Every {@link ColumnId}, in layout order. */
export const COLUMNS: readonly ColumnId[] = ["tree", "note", "graph"];

/** A width per column. The unit depends on the container: see below. */
export type Columns<T> = { readonly [K in ColumnId]: T };

/**
 * Minimum width per column, in CSS pixels.
 *
 * Not arbitrary: the tree must fit `▾ repository` plus a nested path without
 * ellipsis, the note column is the reading surface and gets the largest
 * floor, and the graph needs enough room for the legend row under the canvas
 * to stay on one line. Below these a column is not "small", it is useless,
 * which is why the drag clamps instead of allowing a 12 px sliver.
 */
export const MIN_WIDTHS: Columns<number> = { tree: 180, note: 320, graph: 260 };

/**
 * The default split.
 *
 * Note-heavy on purpose. §11's P2 exit criterion is that the workspace is
 * "genuinely useful with no graph at all", and the default arrangement should
 * say the same thing.
 */
export const DEFAULT_FRACTIONS: Columns<number> = { tree: 0.22, note: 0.46, graph: 0.32 };

// --- breakpoints --------------------------------------------------------------

/**
 * Which columns the viewport can afford (§1.2).
 *
 * `"wide"` shows all three; `"medium"` collapses the graph to a toggle;
 * `"narrow"` collapses the tree as well, leaving the note column — the
 * product — alone on screen.
 */
export type Breakpoint = "wide" | "medium" | "narrow";

/** §1.2: "Below 1100 px the graph column collapses to a toggle." */
export const BREAKPOINT_MEDIUM = 1100;

/** §1.2: "below 800 px the tree does too." */
export const BREAKPOINT_NARROW = 800;

/**
 * Classify a viewport width.
 *
 * Boundaries are inclusive at the top: exactly 1100 px is `"wide"`, because
 * the doc says "below 1100", and an off-by-one here is a column that
 * disappears one pixel early on a very common window size.
 *
 * A non-finite or negative width — which `window.innerWidth` will not
 * produce, but a test double or a detached iframe can — classifies as
 * `"narrow"` rather than throwing. Degrading to the single-column layout is
 * the safe direction: it renders something readable, where a thrown error at
 * render time renders nothing at all.
 */
export function breakpointFor(viewport: number): Breakpoint {
  if (!Number.isFinite(viewport) || viewport < BREAKPOINT_NARROW) return "narrow";
  if (viewport < BREAKPOINT_MEDIUM) return "medium";
  return "wide";
}

/** The columns a breakpoint renders inline, rather than behind a toggle. */
export function columnsAt(breakpoint: Breakpoint): readonly ColumnId[] {
  if (breakpoint === "wide") return COLUMNS;
  if (breakpoint === "medium") return ["tree", "note"];
  return ["note"];
}

/**
 * Whether a column is collapsed *by the viewport* at this breakpoint.
 *
 * Distinct from a user-toggled panel: this one is not a preference and is not
 * persisted, so a laptop user who widens their window gets their three
 * columns back without having to re-open anything.
 */
export function isCollapsed(breakpoint: Breakpoint, column: ColumnId): boolean {
  return !columnsAt(breakpoint).includes(column);
}

// --- state --------------------------------------------------------------------

/**
 * The persisted layout.
 *
 * `fractions` always satisfies the {@link normalizeFractions} invariant.
 * `revealed` records which viewport-collapsed columns the user has explicitly
 * opened via the toggle — it is separate from `fractions` so that opening the
 * graph on a narrow window does not disturb the widths a wide window will
 * restore.
 */
export interface LayoutState {
  readonly fractions: Columns<number>;
  readonly revealed: readonly ColumnId[];
}

/**
 * Force `fractions` to sum to 1 with every column above its minimum share.
 *
 * Three passes, in this order, because each depends on the previous:
 *
 *  1. **Sanitise.** Any non-finite or non-positive entry is replaced by its
 *     default. `NaN` is the interesting case — it propagates through every
 *     subsequent sum and would turn one bad stored value into three broken
 *     columns, so it must die here rather than being clamped later.
 *  2. **Scale.** Divide by the total. This is what makes the function
 *     idempotent and what lets {@link resizeAt} do naive arithmetic and hand
 *     the result back for repair.
 *  3. **Clamp and redistribute.** Lift anything under `minShare` up to it,
 *     then take the deficit back from the columns that are still above their
 *     floor, in proportion to their slack. If there is no slack anywhere —
 *     which happens when the minimums cannot all be honoured at this
 *     viewport — the minimums win and the sum is allowed to exceed 1. The
 *     alternative is a column below its declared floor, and a container that
 *     scrolls is a better failure than a column that cannot be read.
 *
 * @param fractions raw, possibly invalid shares
 * @param minShare per-column floor as a fraction, from {@link minShares}
 */
export function normalizeFractions(fractions: Columns<number>, minShare: Columns<number>): Columns<number> {
  return normalizeOver(COLUMNS, fractions, minShare);
}

/**
 * {@link normalizeFractions} over an arbitrary subset of columns.
 *
 * The subset parameter is not a generalisation for its own sake — it is what
 * {@link resolveColumns} needs, and getting it wrong once already produced a
 * real bug. Passing a collapsed column a share of `0` and hoping the
 * three-column normaliser would drop it does not work: pass 1 treats `0` as
 * corrupt and substitutes the default, so the hidden column comes back as
 * invisible padding. Columns outside `ids` are excluded from every pass and
 * emitted as `0`, which is the only formulation that cannot resurrect them.
 */
function normalizeOver(
  ids: readonly ColumnId[],
  fractions: Columns<number>,
  minShare: Columns<number>,
): Columns<number> {
  const clean: Record<ColumnId, number> = { tree: 0, note: 0, graph: 0 };
  for (const id of ids) {
    const raw = fractions[id];
    clean[id] = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_FRACTIONS[id];
  }

  let total = 0;
  for (const id of ids) total += clean[id];
  for (const id of ids) clean[id] = clean[id] / total;

  // Pass 3. `deficit` is how much we must borrow to satisfy the floors;
  // `slack` is how much the unclamped columns can spare.
  let deficit = 0;
  let slack = 0;
  const atFloor: Record<ColumnId, boolean> = { tree: false, note: false, graph: false };
  for (const id of ids) {
    const floor = minShare[id];
    if (clean[id] < floor) {
      deficit += floor - clean[id];
      clean[id] = floor;
      atFloor[id] = true;
    } else {
      slack += clean[id] - floor;
    }
  }
  if (deficit > 0 && slack > 0) {
    // Proportional to slack, so a column with room to spare gives up more
    // than one that is nearly at its own floor. Capped by `slack` so that
    // repaying an impossible deficit cannot push a donor below its minimum.
    const rate = Math.min(deficit, slack) / slack;
    for (const id of ids) {
      if (atFloor[id]) continue;
      clean[id] -= (clean[id] - minShare[id]) * rate;
    }
  }

  return { tree: clean.tree, note: clean.note, graph: clean.graph };
}

/**
 * {@link MIN_WIDTHS} expressed as fractions of an available width.
 *
 * When the viewport is too small to honour every minimum the shares are
 * scaled down to leave 10 % of the width unspoken for, rather than being
 * returned as-is summing above 1. Without that, `normalizeFractions` would
 * see three floors it can never satisfy, find zero slack, and return a state
 * that overflows by an unbounded amount. Scaling keeps the columns
 * proportional to their declared importance, which is the closest thing to
 * "right" available at 400 px.
 */
export function minShares(available: number): Columns<number> {
  const width = Number.isFinite(available) && available > 0 ? available : 1;
  const raw = {
    tree: MIN_WIDTHS.tree / width,
    note: MIN_WIDTHS.note / width,
    graph: MIN_WIDTHS.graph / width,
  };
  const total = raw.tree + raw.note + raw.graph;
  if (total <= 0.9) return raw;
  const scale = 0.9 / total;
  return { tree: raw.tree * scale, note: raw.note * scale, graph: raw.graph * scale };
}

/** A valid {@link LayoutState} from arbitrary shares. The only constructor. */
export function makeLayout(fractions: Columns<number>, available: number, revealed: readonly ColumnId[] = []): LayoutState {
  return {
    fractions: normalizeFractions(fractions, minShares(available)),
    revealed: COLUMNS.filter((id) => revealed.includes(id)),
  };
}

/** The §1.2 default, sized for a viewport. */
export function defaultLayout(available: number): LayoutState {
  return makeLayout(DEFAULT_FRACTIONS, available);
}

// --- resolution ---------------------------------------------------------------

/** A column's rendered width, in CSS pixels. */
export interface ResolvedColumn {
  readonly id: ColumnId;
  readonly width: number;
}

/**
 * Fractions → pixels, for the columns this breakpoint actually renders.
 *
 * Collapsed columns are dropped and their share is redistributed among the
 * survivors rather than left as a gap — at 900 px the tree and note should
 * fill the window, not sit in the left two-thirds of it. Redistribution
 * re-runs {@link normalizeFractions} over the visible subset so the minimums
 * are enforced against the *remaining* width, which is the only width that
 * matters once the graph is behind a toggle.
 *
 * @param available container width in CSS pixels, gutters already subtracted
 */
export function resolveColumns(state: LayoutState, available: number, breakpoint: Breakpoint): readonly ResolvedColumn[] {
  const visible = columnsAt(breakpoint);
  const width = Number.isFinite(available) && available > 0 ? available : 0;
  const shares = normalizeOver(visible, state.fractions, minShares(width));
  return visible.map((id) => ({ id, width: shares[id] * width }));
}

// --- dragging -----------------------------------------------------------------

/**
 * A divider, named by the column to its left.
 *
 * Two of them: `tree|note` and `note|graph`. A drag moves width between
 * exactly those two neighbours and leaves the third alone, which is what
 * makes the gesture feel local — the §1.2 sketch has no four-way splitter and
 * a divider that reflowed all three columns would be a different, worse
 * interaction.
 */
export type DividerId = "tree" | "note";

/** Both dividers, left to right. */
export const DIVIDERS: readonly DividerId[] = ["tree", "note"];

/** The pair of columns a divider sits between. */
export function dividerPair(divider: DividerId): readonly [ColumnId, ColumnId] {
  return divider === "tree" ? ["tree", "note"] : ["note", "graph"];
}

/**
 * Apply a drag: move `deltaPx` of width across `divider`.
 *
 * Positive `delta` widens the left column. The delta is **clamped before it
 * is applied**, against how much room each neighbour has above its floor —
 * not applied first and repaired afterwards. That ordering matters: a raw
 * overshoot drives the shrinking column to a negative share, which
 * {@link normalizeFractions} reads as corrupt and replaces with the default,
 * so the divider would snap to a position nowhere near the pointer. Clamping
 * first gives the behaviour a user pulling a divider into a wall expects:
 * the divider stops, the pointer keeps going, and releasing does not
 * teleport anything.
 *
 * Returns the input state unchanged when nothing moved, so a `mousemove`
 * storm at a clamped edge does not churn signal subscribers on every frame.
 */
export function resizeAt(state: LayoutState, divider: DividerId, deltaPx: number, available: number): LayoutState {
  const width = Number.isFinite(available) && available > 0 ? available : 0;
  if (width === 0 || !Number.isFinite(deltaPx) || deltaPx === 0) return state;

  const [left, right] = dividerPair(divider);
  const floors = minShares(width);
  // How far each neighbour can shrink. `max(0, …)` because a column can
  // already sit below its floor when the floors do not all fit; in that case
  // it simply cannot donate, rather than donating a negative amount.
  const leftRoom = Math.max(0, state.fractions[left] - floors[left]);
  const rightRoom = Math.max(0, state.fractions[right] - floors[right]);
  // Zero means the divider is against a wall — both when the pointer has not
  // moved and when the clamp consumed the whole delta. Returning the input
  // *identically* in both cases is what keeps a `mousemove` storm at a
  // stopped divider from waking every signal subscriber sixty times a second.
  const delta = Math.max(-leftRoom, Math.min(rightRoom, deltaPx / width));
  if (delta === 0) return state;

  const moved = { ...state.fractions, [left]: state.fractions[left] + delta, [right]: state.fractions[right] - delta };
  return { fractions: normalizeFractions(moved, floors), revealed: state.revealed };
}

// --- toggles ------------------------------------------------------------------

/**
 * Open or close a viewport-collapsed column.
 *
 * Only meaningful for a column the current breakpoint has collapsed — at
 * `"wide"` everything is already on screen and the toggle is not rendered.
 * The state is kept regardless of breakpoint so that narrowing the window,
 * opening the graph, widening, and narrowing again does not lose the
 * preference.
 */
export function toggleColumn(state: LayoutState, column: ColumnId): LayoutState {
  const revealed = state.revealed.includes(column)
    ? state.revealed.filter((id) => id !== column)
    : COLUMNS.filter((id) => id === column || state.revealed.includes(id));
  return { fractions: state.fractions, revealed };
}

/** Whether a column is on screen: inline at this breakpoint, or revealed. */
export function isVisible(state: LayoutState, breakpoint: Breakpoint, column: ColumnId): boolean {
  return !isCollapsed(breakpoint, column) || state.revealed.includes(column);
}

// --- persistence ---------------------------------------------------------------

/**
 * The slice of `Storage` this module uses.
 *
 * An interface rather than the global for two reasons. The obvious one is
 * testability without a DOM. The other is that `localStorage` *throws* on
 * access in a handful of real configurations — Safari private browsing
 * historically, and any embedding where storage is partitioned off — so the
 * call has to be wrapped somewhere, and a narrow injected port is a better
 * place for that wrapper than a component.
 */
export interface LayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The `localStorage` key. Namespaced; §1.2 puts widths in storage. */
export const LAYOUT_STORAGE_KEY = "pi-weave.layout.v1";

/**
 * Serialize for storage.
 *
 * Fractions are rounded to four decimals — about a quarter-pixel on a 4K
 * display, and far below what a drag can express — so that a stored value is
 * short and, more usefully, so that a hand-inspected entry is readable.
 */
export function serializeLayout(state: LayoutState): string {
  return JSON.stringify({
    v: 1,
    tree: round4(state.fractions.tree),
    note: round4(state.fractions.note),
    graph: round4(state.fractions.graph),
    revealed: [...state.revealed],
  });
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/**
 * Parse a stored layout, or `null`.
 *
 * Everything here is untrusted. The string is user-editable by construction —
 * it lives in a devtools pane that anyone can type into — and it also
 * outlives the schema, so a v1 reader will one day meet a v2 entry written by
 * a newer build the user ran yesterday. Both cases have the same correct
 * answer: return `null` and let the caller fall back to the default. There is
 * no repair path, because a partially-repaired layout is a bug report that
 * says "my columns are weird sometimes".
 *
 * Note what is *not* rejected: out-of-range or non-summing fractions. Those
 * go to {@link normalizeFractions}, which is total. Only structural nonsense —
 * not JSON, not an object, wrong version, a missing or non-numeric column —
 * is fatal.
 */
export function deserializeLayout(raw: string | null, available: number): LayoutState | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  if (record["v"] !== 1) return null;

  const fractions: Record<ColumnId, number> = { tree: 0, note: 0, graph: 0 };
  for (const id of COLUMNS) {
    const value = record[id];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
    fractions[id] = value;
  }

  const revealedRaw = record["revealed"];
  const revealed = Array.isArray(revealedRaw)
    ? COLUMNS.filter((id) => (revealedRaw as unknown[]).includes(id))
    : [];

  return makeLayout(fractions, available, revealed);
}

/**
 * Read the stored layout, falling back to the §1.2 default.
 *
 * Storage access is wrapped: see {@link LayoutStorage}. A throwing
 * `getItem` is indistinguishable from an absent entry as far as the layout is
 * concerned, and the workspace opening with default widths is not an error
 * worth surfacing.
 */
export function loadLayout(storage: LayoutStorage, available: number): LayoutState {
  let raw: string | null;
  try {
    raw = storage.getItem(LAYOUT_STORAGE_KEY);
  } catch {
    return defaultLayout(available);
  }
  return deserializeLayout(raw, available) ?? defaultLayout(available);
}

/**
 * Persist the layout, best-effort.
 *
 * Returns whether it stuck, rather than throwing. `setItem` fails on quota
 * exhaustion and in partitioned-storage contexts, and neither is a reason to
 * break a drag that has already been applied to the live layout — the user's
 * columns move, they just do not survive a reload.
 */
export function saveLayout(storage: LayoutStorage, state: LayoutState): boolean {
  try {
    storage.setItem(LAYOUT_STORAGE_KEY, serializeLayout(state));
    return true;
  } catch {
    return false;
  }
}

// --- rendering support ----------------------------------------------------------

/**
 * The CSS custom property carrying a column's width.
 *
 * **This is a CSP constraint, not a style preference.** §5.2 serves the page
 * with `style-src 'nonce-…'` and no `'unsafe-inline'`, so an inline
 * `style="width:340px"` attribute is *blocked by the browser* — Preact sets
 * that attribute via `dom.style.cssText` for string styles and via
 * `dom.style[key] = …` for object styles, and neither is subject to
 * `style-src`, because CSSOM mutation is not "inline style" in CSP terms.
 * Only a literal `style` attribute in markup is.
 *
 * We use the custom-property form anyway, via `el.style.setProperty`, for a
 * reason beyond CSP: the nonce'd stylesheet in `page.ts` can then own the
 * actual `grid-template-columns` declaration, and the client contributes one
 * number per column instead of a layout rule. That keeps the presentation in
 * CSS where it can be read, and keeps the bundle from carrying a second,
 * competing layout implementation.
 */
export function columnVar(column: ColumnId): string {
  return `--weave-col-${column}`;
}

/** A resolved width as a CSS length. Integral: subpixel columns blur text. */
export function columnValue(width: number): string {
  return `${Math.round(width)}px`;
}

/**
 * The full set of custom properties for a resolved layout.
 *
 * Returned as pairs rather than applied, so the caller — a `useLayoutEffect`
 * in the shell — is the only thing that touches an element, and this stays
 * testable without one.
 */
export function columnVars(resolved: readonly ResolvedColumn[]): readonly (readonly [string, string])[] {
  return resolved.map((column) => [columnVar(column.id), columnValue(column.width)] as const);
}
