/**
 * Everything the tree column *decides* (weave-workspace §1.2, §3, §10).
 *
 * The column itself is `treeRows` with a different renderer — that is §3's
 * whole claim, and this module is what makes it true in the browser: it holds
 * the view state the TUI keeps in `ExplorerState`, the reducers that move it,
 * and the presentation mapping from a `TreeRow` to something a `<li>` can
 * render. `Tree.tsx` is left with a `useState`, a `map` and four handlers.
 *
 * That split is not stylistic. §10 forbids a DOM test environment, so a branch
 * inside a `.tsx` is a branch no test can reach; every branch the tree needs
 * lives here, where an ordinary unit test covers it.
 *
 * ## Tier rules (§2)
 *
 * `src/web/client/**`: `src/web/shared` and browser deps only. The view-models
 * arrive through `../../shared/view`, the one sanctioned door onto
 * `src/core/view` (§2.1) — never from `src/core` directly, even though the
 * modules behind the door are proven node-free. This file also touches no DOM
 * type at all, which is what lets the root `tsconfig.json` project (no `DOM`
 * lib) compile the tests that import it.
 */

import type { TreeRow, TreeState, ViewGraphModel } from "../../shared/view";
import { formatTreeMeta, treeEmptyHint, treeRows } from "../../shared/view";
import type { GraphPayload, WireNodeKind, WireNoteSource } from "../../shared/wire";
import type { IconName } from "../shell/icons.model";

// --- the view state ------------------------------------------------------------

/**
 * The tree's own state — core's {@link TreeState}, verbatim.
 *
 * Deliberately an alias rather than a parallel interface. `treeRows` reads
 * `expanded`, `showInternals`, `provFilter` and `query`; a client-side copy
 * with the same four fields would be a second declaration of one contract, and
 * the first time core added a fifth the browser would silently stop honouring
 * it.
 *
 * It is **not** `src/web/client/state.ts`'s `TreeState`. That one is a P1
 * placeholder carrying only an expanded-id list, and it stays where it is:
 * this state is owned by the tree column, lives in the component that renders
 * it, and never crosses the context bus. §1.3's bus is `selectedId` — which
 * rows happen to be open is not something the note column or the graph has any
 * business reacting to.
 */
export type TreeViewState = TreeState;

/**
 * The provenance filter cycle: all → human → agent → generated → all.
 *
 * The same order as the TUI's `p` key (`src/pi/viewer/tui/theme.ts`), and
 * declared again here because the client tier may not import `src/pi` and the
 * order is not part of `src/core/view`. That is a real, if small, duplication
 * — so it is one array with a test asserting its contents, rather than an
 * `if/else` chain in two places. If a fourth provenance is ever added, the
 * honest fix is to promote this into `src/core/view` and take it through the
 * door; today it is four literals and a promotion would be ceremony.
 */
export const PROVENANCE_CYCLE: readonly (WireNoteSource | null)[] = [null, "human", "agent", "generated"];

/**
 * The tree as it opens: nothing expanded but the roots, no filter.
 *
 * Roots are expanded eagerly because a tree whose every row is collapsed shows
 * two words (`vault`, `repository`) and reads as an empty column. The TUI's
 * `initialState` does the same thing for the same reason.
 *
 * A fresh `Set` per call, so two callers cannot alias — and, more importantly,
 * so a reducer that mutated one could not corrupt the default for the next
 * mount.
 */
export function initialTreeView(roots: readonly string[] = ["vault", "repository"]): TreeViewState {
  return { expanded: new Set(roots), showInternals: false, provFilter: null, query: "" };
}

// --- reassembling the wire payload -------------------------------------------------

/**
 * The wire payload as the view-models want it.
 *
 * `WireGraphModel` is `Omit<GraphModel, "danglingLinks">` — the payload hoists
 * that map to its own top-level `dangling` rather than shipping it twice
 * (§4.2) — so exactly one field has to be put back before `treeRows` or
 * `detailModel` will accept it. The door (`shared/view.ts`) deliberately does
 * not do this: it is a wire concern, and a door that carried a transformation
 * would be a second implementation rather than a re-export.
 *
 * So it is done here, once, and every caller in the client goes through it.
 */
export function viewModel(payload: GraphPayload): ViewGraphModel {
  return { ...payload.model, danglingLinks: payload.dangling };
}

/**
 * The rows to render, or `[]` before the first graph arrives.
 *
 * `null` is not an error state — it is the half-second between mount and the
 * first `/api/graph` response, and it happens on every single load. Returning
 * an empty array rather than throwing keeps the caller a `map`.
 */
export function rowsFor(payload: GraphPayload | null, state: TreeViewState): TreeRow[] {
  if (payload === null) return [];
  return treeRows(viewModel(payload), state);
}

// --- reducers -----------------------------------------------------------------------

/**
 * Open or close a row.
 *
 * Returns a **new** state with a new `Set`. Mutating the existing one would be
 * cheaper and would not re-render: Preact's `useState` bails out on
 * `Object.is` equality, so an in-place `expanded.add(id)` produces a correct
 * model and a frozen screen. That failure is silent and maddening, which is
 * why every reducer here copies.
 */
export function toggleExpanded(state: TreeViewState, id: string): TreeViewState {
  const expanded = new Set(state.expanded);
  if (!expanded.delete(id)) expanded.add(id);
  return { ...state, expanded };
}

/** Force a row open. Idempotent — the right-arrow key's half of the pair. */
export function expand(state: TreeViewState, id: string): TreeViewState {
  if (state.expanded.has(id)) return state;
  const expanded = new Set(state.expanded);
  expanded.add(id);
  return { ...state, expanded };
}

/** Force a row closed. Idempotent. */
export function collapse(state: TreeViewState, id: string): TreeViewState {
  if (!state.expanded.has(id)) return state;
  const expanded = new Set(state.expanded);
  expanded.delete(id);
  return { ...state, expanded };
}

/**
 * Set the substring filter.
 *
 * No debounce and no minimum length: `treeRows` is a synchronous walk over an
 * in-memory model of a few hundred nodes, so filtering on every keystroke is
 * cheaper than the timer that would avoid it, and a filter that lags behind
 * the text box is the single most irritating thing a filter can do.
 */
export function setQuery(state: TreeViewState, query: string): TreeViewState {
  return state.query === query ? state : { ...state, query };
}

/** Advance the provenance filter one step around {@link PROVENANCE_CYCLE}. */
export function cycleProvenance(state: TreeViewState): TreeViewState {
  const at = PROVENANCE_CYCLE.indexOf(state.provFilter);
  // `indexOf` returns -1 for a value outside the cycle, and `(-1 + 1) % 4` is
  // 0 — which lands on "all". A state that somehow held an unknown filter
  // therefore recovers on the next press instead of sticking.
  const next = PROVENANCE_CYCLE[(at + 1) % PROVENANCE_CYCLE.length] ?? null;
  return { ...state, provFilter: next };
}

/** Show or hide repo plumbing (gitState / external / package / entryPoint). */
export function toggleInternals(state: TreeViewState): TreeViewState {
  return { ...state, showInternals: !state.showInternals };
}

// --- keyboard navigation --------------------------------------------------------------

/** What a key produced: the next state, and the row that should be selected. */
export interface TreeKeyResult {
  readonly state: TreeViewState;
  readonly selectedId: string | null;
  /** `false` when the key meant nothing here and the browser should keep it. */
  readonly handled: boolean;
}

/**
 * The index of `id` among the currently visible rows, or `-1`.
 *
 * Rows are the flattened, filtered, expansion-resolved list — so "the next
 * row" is genuinely the next thing on screen, not the next sibling in the
 * graph. Deriving the cursor from the id rather than storing an index is the
 * same choice the TUI made (`ExplorerState.selectedId` is the source of truth)
 * and for the same reason: an index goes stale the moment a filter changes the
 * row set, and goes stale *plausibly*, pointing at a real but wrong row.
 */
export function indexOfRow(rows: readonly TreeRow[], id: string | null): number {
  if (id === null) return -1;
  return rows.findIndex((row) => row.id === id);
}

/**
 * The id at a row index, or `null` when the index is outside the list.
 *
 * Exported and used by every caller below rather than each writing
 * `rows[i]?.id ?? null` inline, and the reason is coverage rather than
 * brevity. `noUncheckedIndexedAccess` makes an index access `T | undefined`
 * even where the surrounding arithmetic has already clamped it into range, so
 * an inline `?? null` is a branch that *cannot* be taken and therefore cannot
 * be covered — a permanent hole in a gate that is supposed to mean something.
 * Funnelling those accesses through one function turns the same check into a
 * branch that is genuinely reachable, because an out-of-range index is a legal
 * argument here and is tested as one.
 */
export function idAt(rows: readonly TreeRow[], index: number): string | null {
  return rows[index]?.id ?? null;
}

/**
 * Move the cursor `delta` rows, clamped to the ends.
 *
 * Clamped rather than wrapped: wrapping from the last note back to `vault` is
 * disorienting in a tree, where position carries meaning. With nothing
 * selected, a downward move starts at the top and an upward move at the
 * bottom, so the first arrow key after a fresh load always lands somewhere.
 */
export function moveSelection(rows: readonly TreeRow[], id: string | null, delta: number): string | null {
  if (rows.length === 0) return null;
  const at = indexOfRow(rows, id);
  const from = at === -1 ? (delta > 0 ? -1 : rows.length) : at;
  return idAt(rows, Math.min(rows.length - 1, Math.max(0, from + delta)));
}

/**
 * The id of the row that visually contains `id` — the row above it with a
 * smaller depth.
 *
 * Used by the left arrow on an already-collapsed row, which is the one tree
 * gesture users expect and nobody implements. Scanning upwards for the first
 * shallower row is exact for a flattened tree: whatever that row is, it is the
 * parent, because every row between them is a descendant of it.
 *
 * Written as a reversed `slice` rather than a descending index loop for the
 * reason {@link idAt} exists: iterating yields a `TreeRow`, where indexing
 * yields `TreeRow | undefined` and forces an unreachable guard. The copy is of
 * the rows above the cursor, which is bounded by what is on screen.
 */
export function parentOf(rows: readonly TreeRow[], id: string): string | null {
  const at = indexOfRow(rows, id);
  // `at <= 0` covers both "not visible" (-1) and "the first row, which has
  // nothing above it" (0), and in either case there is no parent to find.
  const self = at <= 0 ? undefined : rows[at];
  if (self === undefined) return null;
  for (const row of rows.slice(0, at).reverse()) {
    if (row.depth < self.depth) return row.id;
  }
  return null;
}

/**
 * Vim-ish aliases: `j` is `ArrowDown`, `k` is `ArrowUp` (§11 P4).
 *
 * A *normalizer* rather than two more branches in {@link treeKey}, because
 * the aliasing and the navigation are separate concerns and folding them
 * together would double the arrow tests. Everything below `treeKey`'s first
 * line then works in terms of arrows only.
 *
 * ## Why the aliases are tree-scoped and not global
 *
 * §11 says "vim-ish `j/k` **in the tree**", and the qualifier is load-bearing
 * on both sides. A global `j` would move the tree's cursor while the user is
 * reading the note column — an invisible change to a surface they are not
 * looking at — and it would make `j` untypeable in the graph's depth control.
 * Scoping it here means the tree's own `onKeyDown` applies it, which is only
 * reached when focus is genuinely inside the tree.
 *
 * Case is preserved deliberately: `J` and `K` are Shift-modified keys that
 * vim itself binds to something else, so they are left alone rather than
 * folded onto their lowercase forms.
 */
export const VIM_KEYS: Readonly<Record<string, string>> = { j: "ArrowDown", k: "ArrowUp" };

/** Resolve a vim alias, or return the key unchanged. */
export function normalizeTreeKey(key: string): string {
  return VIM_KEYS[key] ?? key;
}

/**
 * Apply a key to the tree.
 *
 * `ArrowDown`/`ArrowUp` move, `Home`/`End` jump, `ArrowRight` opens (or
 * descends into an already-open row), `ArrowLeft` closes (or climbs to the
 * parent). That last pair is the whole reason this is a function rather than a
 * switch in the component: each arrow has two behaviours depending on the
 * row's state, which is four branches the coverage gate would never see inside
 * a `.tsx`.
 *
 * `handled: false` for everything else, so the caller knows not to
 * `preventDefault` a key it did not consume — swallowing Tab would trap
 * keyboard users in the column, which is the accessibility bug P4 is meant to
 * be fixing rather than introducing.
 *
 * `typing` closes the one path the first version missed: the filter box lives
 * inside the listened element, so typing `j` into a query like "jack" arrived
 * here as an alias and moved the cursor instead of entering the character.
 * The caller passes whether the event's target is a text field (the same
 * `isTextEntry` question the global map asks), and a keystroke that belongs
 * to the input is refused here — the decision in the model, not a DOM check
 * in the `.tsx`.
 */
export function treeKey(
  rows: readonly TreeRow[],
  state: TreeViewState,
  selectedId: string | null,
  rawKey: string,
  typing = false,
): TreeKeyResult {
  const unchanged = { state, selectedId, handled: false } as const;
  if (typing) return unchanged;
  const moved = (id: string | null): TreeKeyResult => ({ state, selectedId: id, handled: true });
  const key = normalizeTreeKey(rawKey);

  if (key === "ArrowDown") return moved(moveSelection(rows, selectedId, 1));
  if (key === "ArrowUp") return moved(moveSelection(rows, selectedId, -1));
  if (key === "Home") return moved(idAt(rows, 0));
  if (key === "End") return moved(idAt(rows, rows.length - 1));

  if (key !== "ArrowRight" && key !== "ArrowLeft") return unchanged;

  const at = indexOfRow(rows, selectedId);
  const row = at === -1 ? undefined : rows[at];
  if (row === undefined || selectedId === null) return unchanged;

  if (key === "ArrowRight") {
    // Closed and has children → open it. Already open → step onto the first
    // child, which is the next row by construction. A leaf does nothing.
    if (!row.hasKids) return unchanged;
    if (!row.expanded) return { state: expand(state, selectedId), selectedId, handled: true };
    return moved(moveSelection(rows, selectedId, 1));
  }

  // ArrowLeft: open → close it; closed (or a leaf) → climb to the parent.
  if (row.hasKids && row.expanded) return { state: collapse(state, selectedId), selectedId, handled: true };
  const parent = parentOf(rows, selectedId);
  return parent === null ? unchanged : moved(parent);
}

// --- presentation ---------------------------------------------------------------------

/**
 * Kind → icon.
 *
 * The descendant of the old `KIND_GLYPHS` text table: the same nine-way
 * distinction (a parallel table to the TUI's `kindStyle`, which the client
 * tier may not import), but drawn from {@link ICONS}' one sprite instead of
 * nine unrelated font fallbacks. The TUI-cross-training argument for reusing
 * the *characters* is gone now that neither surface draws them as text, but
 * the pairings survive: `vault` solid against `gitState` hollow, `note` with
 * its folded corner against `file` without, `external` still pointing out.
 *
 * Colour is *not* duplicated — that stays in the stylesheet, keyed by
 * {@link TreeRowView.kind}.
 */
const KIND_ICONS: Readonly<Record<WireNodeKind, IconName>> = {
  vault: "vault",
  note: "note",
  repository: "repository",
  module: "module",
  package: "package",
  entryPoint: "entryPoint",
  gitState: "gitState",
  external: "external",
  file: "file",
};

/** The icon name for a node kind. */
export function kindIcon(kind: WireNodeKind): IconName {
  return KIND_ICONS[kind];
}

// --- the session fold -----------------------------------------------------------------

/**
 * The synthesized folder session memory lives under.
 *
 * Core's graph builder (`src/core/graph/build.ts`) nests notes whose slug has
 * a directory under a synthesized `vfolder:<dir>` node — kind `module`,
 * because reusing the tree's containment chain needs no client change. That
 * reuse is why there is no `session` node *kind*: a session note is an
 * ordinary `note` that happens to be filed there, and this client recognises
 * it by path, not by kind.
 */
export const SESSION_DIR = "sessions";

/** True when a node id names a note under the {@link SESSION_DIR} fold. */
export function isSessionNote(id: string): boolean {
  return id.startsWith(`note:${SESSION_DIR}/`);
}

/**
 * Whether a row renders a notch quieter.
 *
 * `sessions/<n>.md` notes are machine-written memory that accrues by the
 * dozens with near-duplicate titles, so at any real vault size they are most
 * of the tree's rows — and rows that all look alike at full weight make the
 * six notes a human actually wrote harder to find. So session rows sit in
 * `--weave-dim` until hovered or selected, which is how Obsidian treats its
 * own long tails.
 *
 * The *never* half is the load-bearing part: `selectedId` is the §1.3 bus, so
 * the selection is decided somewhere the tree does not own, and a rule that
 * could dim the selected row would be a rule the graph's click could silently
 * break. The class-coverage gate does not see this — it is asserted here,
 * which is where §10 says it belongs.
 */
export function isMuted(row: TreeRow, selectedId: string | null): boolean {
  return row.id !== selectedId && isSessionNote(row.id);
}

/**
 * Provenance → glyph.
 *
 * `●` human, `◐` agent, `○` generated — the TUI's vocabulary again, and the
 * one place AGENTS.md rule 4 shows up in the browser: agent-written content
 * must never look human-authored, so the marker is a filled/half/hollow shape
 * that survives greyscale, colour-blindness and a screenshot, rather than a
 * colour alone. Structural nodes have no provenance and get nothing.
 */
const PROVENANCE_GLYPHS: Readonly<Record<WireNoteSource, string>> = {
  human: "●",
  agent: "◐",
  generated: "○",
};

/** The provenance marker for a row, or `""` for a structural node. */
export function provenanceGlyph(provenance: WireNoteSource | null): string {
  return provenance === null ? "" : PROVENANCE_GLYPHS[provenance];
}

/** The `title=` on the provenance marker. Spells out what the shape means. */
export function provenanceTitle(provenance: WireNoteSource | null): string {
  return provenance === null ? "" : `${provenance}-authored`;
}

/** The disclosure state of a row: which way the twisty points, or none. */
export type Twisty = "open" | "closed" | "leaf";

// --- ARIA ---------------------------------------------------------------------------

/**
 * The `id` attribute for a tree row.
 *
 * Needed because focus lives on the `<ul role="tree">`, not on the rows — a
 * roving `tabindex` would put every row in the Tab order and make Tab a
 * fourth way to walk the tree. The standard alternative is
 * `aria-activedescendant`, which is an **id reference**, so the rows need ids.
 *
 * Derived from the row id with everything outside `[A-Za-z0-9_-]` replaced,
 * for `rowDomId`'s reason in `search.model.ts`: a graph id is
 * `module:src/web/client`, which is a legal HTML `id` and an illegal CSS
 * selector, and an assistive technology that builds a selector from the
 * reference gets nothing. The replacement is injective enough for this — two
 * ids differing only in punctuation would collide, and the graph builder
 * derives ids from slugs and paths, where `:` is always the kind separator.
 */
export function rowDomId(id: string): string {
  return `weave-row-${id.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

/** `aria-posinset` / `aria-setsize` for one row. */
export interface TreePosition {
  readonly posinset: number;
  readonly setsize: number;
}

/**
 * Position-in-set for every row, from the flattened list.
 *
 * A `role="tree"` whose items are not nested in `role="group"` elements is
 * the *flat* tree pattern, and it is the right one here — the rows come from
 * core's `treeRows` already flattened, and rebuilding a nested `<ul>` in the
 * browser would be a second tree structure to keep in agreement with the
 * TUI's. The pattern's cost is that `aria-level` alone tells a screen reader
 * the depth and nothing about extent: "level 2" with no "3 of 7" leaves a
 * user unable to tell a short list from a long one without walking it, which
 * is precisely the orientation a tree is for.
 *
 * ## Why a stack rather than a contiguous run
 *
 * The obvious implementation — "siblings are consecutive rows at the same
 * depth" — is wrong for exactly the shape a tree always has. Given
 *
 * ```text
 * vault          depth 0
 *   Graph model  depth 1
 *   Viewer       depth 1
 * repository     depth 0
 * ```
 *
 * `vault` and `repository` are siblings, and they are *not* consecutive: two
 * children sit between them. A run-based pass reports both as "1 of 1", which
 * is a confidently wrong announcement rather than a missing one. So the open
 * set at each depth is kept on a stack, and a row at depth *d* closes every
 * set deeper than *d* — the standard flattened-tree walk, and the only one
 * that gets the roots right.
 *
 * One pass over the list, because the per-row version is O(rows²) on a
 * repository with a few thousand files.
 */
export function treePositions(rows: readonly TreeRow[]): TreePosition[] {
  const out: TreePosition[] = rows.map(() => ({ posinset: 1, setsize: 1 }));
  /** Indices of the still-open sibling set at each depth. */
  const open: number[][] = [];

  /**
   * Close every set deeper than `depth` and write its members' positions.
   *
   * `splice` rather than a `pop` loop, and that is a coverage decision as
   * much as a brevity one: `open.pop()` is `number[] | undefined` under
   * `noUncheckedIndexedAccess` even where the loop guard has already proved
   * the array non-empty, so the `?? []` it needs is a branch that *cannot*
   * be taken and therefore cannot be covered — a permanent hole in a gate
   * that is supposed to mean something. `splice` returns an array of arrays
   * with no such element. The same reasoning as {@link idAt}'s.
   */
  const closeBelow = (depth: number): void => {
    for (const set of open.splice(depth + 1)) {
      for (const [index, at] of set.entries()) out[at] = { posinset: index + 1, setsize: set.length };
    }
  };

  for (const [index, row] of rows.entries()) {
    closeBelow(row.depth);
    // A gap in depth cannot happen from `treeRows` (a child is always exactly
    // one deeper than its parent), but a truncated payload could produce one,
    // and a missing slot would silently drop the row from every set. Filling
    // up to the depth and then reading the *last* slot keeps the access
    // total: `at(-1)` on an array just proved non-empty still needs a guard
    // under `noUncheckedIndexedAccess`, so the set is pushed and reused
    // instead of re-indexed.
    let set = open[row.depth];
    if (set === undefined) {
      set = [];
      while (open.length < row.depth) open.push([]);
      open.push(set);
    }
    set.push(index);
  }
  closeBelow(-1);
  return out;
}

/** A `TreeRow`, resolved to the strings and flags a list item renders. */
export interface TreeRowView {
  readonly id: string;
  /** The `id` attribute, for `aria-activedescendant`. */
  readonly domId: string;
  readonly depth: number;
  readonly label: string;
  readonly kind: WireNodeKind;
  /** Which sprite glyph the kind slot draws; the `.tsx` builds the `<svg>`. */
  readonly kindIcon: IconName;
  readonly provenance: WireNoteSource | null;
  readonly provenanceGlyph: string;
  readonly provenanceTitle: string;
  readonly twisty: Twisty;
  readonly hasKids: boolean;
  readonly expanded: boolean;
  readonly selected: boolean;
  /**
   * Render a notch quieter — the session rows of {@link isMuted}.
   *
   * A view-model flag rather than a `.tsx` branch for the same reason every
   * other branch is here, and the stylesheet keys off it with
   * `.weave-row-muted`.
   */
  readonly muted: boolean;
  /** The trailing annotation, already formatted against `now`. */
  readonly meta: string;
  /** ARIA `aria-level`, which is 1-based where `depth` is 0-based. */
  readonly level: number;
  /** ARIA `aria-posinset`: which sibling this is, 1-based. */
  readonly posinset: number;
  /** ARIA `aria-setsize`: how many siblings there are. */
  readonly setsize: number;
}

/**
 * Resolve one row for rendering.
 *
 * `now` is a parameter rather than a `Date.now()` call, per AGENTS.md: a
 * relative timestamp read off the wall clock is untestable, and this is the
 * function that turns `{kind:"relTime", iso}` into `"12m ago"`.
 */
export function rowView(row: TreeRow, selectedId: string | null, now: number, position: TreePosition = { posinset: 1, setsize: 1 }): TreeRowView {
  const twisty: Twisty = !row.hasKids ? "leaf" : row.expanded ? "open" : "closed";
  return {
    id: row.id,
    domId: rowDomId(row.id),
    posinset: position.posinset,
    setsize: position.setsize,
    depth: row.depth,
    label: row.label,
    kind: row.kind,
    kindIcon: kindIcon(row.kind),
    provenance: row.provenance,
    provenanceGlyph: provenanceGlyph(row.provenance),
    provenanceTitle: provenanceTitle(row.provenance),
    twisty,
    hasKids: row.hasKids,
    expanded: row.expanded,
    selected: row.id === selectedId,
    muted: isMuted(row, selectedId),
    meta: formatTreeMeta(row.meta, now),
    level: row.depth + 1,
  };
}

/** Resolve a whole row list, positions included. The component's single `map`. */
export function rowViews(rows: readonly TreeRow[], selectedId: string | null, now: number): TreeRowView[] {
  const positions = treePositions(rows);
  return rows.map((row, index) => rowView(row, selectedId, now, positions[index]));
}

/**
 * `aria-activedescendant` for the tree, or `null`.
 *
 * `null` when the selection is not a *visible* row — the selection is the
 * §1.3 bus and can name a node the tree has filtered away or collapsed under
 * a closed parent. Pointing `aria-activedescendant` at an id that is not in
 * the DOM is worse than omitting it: the attribute is a promise that the
 * element exists, and a screen reader that follows a dangling one announces
 * nothing while the user is certain something is selected.
 */
export function treeActiveDescendant(rows: readonly TreeRow[], selectedId: string | null): string | null {
  return indexOfRow(rows, selectedId) === -1 ? null : rowDomId(selectedId as string);
}

/**
 * The per-row indent, as a custom property.
 *
 * A number, not a pixel width: the stylesheet multiplies it by an indent step
 * it owns, so the tree's density is a CSS decision and this module only says
 * how deep the row is. Applied through Preact's `style` prop, which reaches
 * the DOM via `CSSStyleDeclaration.setProperty` and is therefore **not**
 * governed by `style-src` — the same CSSOM path `cssvars.ts` documents and
 * verified in `preact/src/diff/props.js`. No `'unsafe-inline'` is involved.
 */
export function depthVar(depth: number): Readonly<Record<string, string>> {
  return { "--weave-depth": String(Math.max(0, depth)) };
}

// --- the control strip -------------------------------------------------------------

/** The provenance button's label. `all` is the unfiltered state. */
export function provenanceLabel(provenance: WireNoteSource | null): string {
  return provenance === null ? "all" : provenance;
}

/** The provenance button's tooltip — names what pressing it will do next. */
export function provenanceHint(provenance: WireNoteSource | null): string {
  const at = PROVENANCE_CYCLE.indexOf(provenance);
  const next = PROVENANCE_CYCLE[(at + 1) % PROVENANCE_CYCLE.length] ?? null;
  return `provenance filter: ${provenanceLabel(provenance)} — click for ${provenanceLabel(next)}`;
}

/** The internals toggle's label. */
export function internalsLabel(showInternals: boolean): string {
  return showInternals ? "internals" : "knowledge";
}

/** The internals toggle's tooltip. */
export function internalsHint(showInternals: boolean): string {
  return showInternals
    ? "showing git state, packages, externals and entry points — click to hide"
    : "hiding git state, packages, externals and entry points — click to show";
}

/** Placeholder for the filter box. */
export const FILTER_PLACEHOLDER = "filter…";

/**
 * The tree's accessible name.
 *
 * Names *what is in it* rather than what it is: "Tree" is already the
 * column's heading and the role announces the widget type, so a second
 * "tree" would be read three times. "Vault and repository" is the sentence
 * §1.1 uses for the same thing.
 */
export const TREE_LABEL = "Vault and repository";

/** The filter box's `aria-label`, and the hint naming the key that focuses it. */
export const FILTER_LABEL = "Filter the tree";

/** The filter box's `title`. Teaches `/`, which is the global way in. */
export const FILTER_HINT = "Filter the tree (/)";

// --- the empty states ---------------------------------------------------------------

/**
 * What the column says instead of rows.
 *
 * Four genuinely different situations, and conflating them is how a UI ends up
 * telling a user their vault is empty because they typed a typo into a filter
 * box. `null` means "there are rows — render them".
 *
 * ## Why core's hint is consulted before the row count
 *
 * The obvious order — "no rows? then work out why" — is wrong here, and it is
 * wrong in the case that matters most. A brand-new vault is not a graph with
 * no rows: `treeRows` still emits the `vault` root, so the column renders one
 * word and nothing else, and a user's first ever session says nothing about
 * how to add a note. `treeEmptyHint` is core's answer to exactly that
 * question, and it is deliberately narrow — it returns a string only for a
 * vault with no notes *and* no repository — so consulting it first cannot
 * suppress a tree that has real content.
 *
 * It also outranks the filter message, for the same reason: when the vault is
 * genuinely empty, "nothing matches this filter" is true and useless.
 *
 * Using core's sentence rather than writing one here is §3: the TUI's empty
 * tree and the browser's say the same thing about the same vault, because
 * there is one sentence.
 */
export function treeEmptyMessage(
  payload: GraphPayload | null,
  rows: readonly TreeRow[],
  state: TreeViewState,
): string | null {
  if (payload === null) return "loading…";
  const hint = treeEmptyHint(viewModel(payload));
  if (hint !== null) return hint;
  if (rows.length > 0) return null;
  if (state.query.length > 0 || state.provFilter !== null)
    return "nothing matches this filter — clear it to see the whole vault";
  // No rows, no filter, and core had no opinion — a payload with no roots at
  // all, which the server does not produce but a truncated response could.
  return "nothing to show";
}

/** `34 notes · 127 nodes`-style count line under the tree. Rows, not nodes. */
export function rowCountLabel(rows: readonly TreeRow[]): string {
  return rows.length === 1 ? "1 row" : `${rows.length} rows`;
}
