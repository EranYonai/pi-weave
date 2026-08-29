/**
 * The context rail: everything related, visible without navigating
 * (weave-workspace §1.1, §1.2, §10, P2.5).
 *
 * §1.1's UX principle is the one that decides arguments here:
 *
 * > **Don't make the user navigate to information. Bring related information
 * > into the current view.**
 *
 * The rail is that principle made concrete. Whatever is selected, the four
 * groups below say what it points at, what points at it, what it is filed
 * under, and what code it talks about — all at a glance, with no click that
 * costs you your place. §1.2 sketches it as `LINKS` / `BACKLINKS`, and §11's
 * P2 line adds mentions and tags now that §4.3 and §4.4 have shipped the data.
 *
 * ## Where each group comes from
 *
 * | Group | Source | Why not something else |
 * | --- | --- | --- |
 * | LINKS | `detailModel().links`, minus mentions | Core's projection, shared with the TUI (§3). |
 * | BACKLINKS | `deriveBacklinks()` over all edges | One pass for the whole graph, not O(nodes × edges) per selection. |
 * | TAGS | `GraphPayload.tags` (§4.3) | The structured index. Never `detail.tags`, which is a display string. |
 * | MENTIONS | `mentions` edges (§4.4) | Both directions: what a note names, and which notes name a file. |
 *
 * `detailModel` is used rather than `focusModel` even though `focusModel`
 * groups the neighbourhood already: its grouping is by *edge kind* with the
 * headings a terminal wants ("links to →", "← linked from"), and the rail
 * needs tags and mentions interleaved on equal footing with those. Reaching
 * through `detailModel` and regrouping keeps core's link/backlink derivation
 * shared while letting the browser decide its own section order.
 *
 * ## Tier rules (§2)
 *
 * `src/web/client/**`. View-models via `../../shared/view`; never `src/core`.
 * No DOM type is named, so the root `tsconfig.json` project compiles the
 * tests.
 */

import type { DetailLinkRow, ViewGraphModel } from "../../shared/view";
import { deriveBacklinks, detailModel, listLabel } from "../../shared/view";
import type { GraphPayload, WireGraphNode, WireNodeKind, WireNoteSource } from "../../shared/wire";
import { isSessionNote, kindIcon, provenanceGlyph, provenanceTitle, viewModel } from "../tree/tree.model";
import type { IconName } from "../shell/icons.model";

// --- rows and groups ---------------------------------------------------------------

/** One clickable entry in the rail. */
export interface ContextRow {
  /** Unique within the rail, for a stable render key. */
  readonly id: string;
  /** The node id to select. Every row is clickable — that is the point. */
  readonly target: string;
  readonly label: string;
  readonly kind: WireNodeKind;
  /** Which sprite glyph the row draws; the `.tsx` builds the `<svg>`. */
  readonly kindIcon: IconName;
  readonly provenance: WireNoteSource | null;
  readonly provenanceGlyph: string;
  readonly provenanceTitle: string;
  /** Highlighted when this row is what is currently selected. */
  readonly selected: boolean;
}

/** One labelled section. */
export interface ContextGroup {
  /** `LINKS`, `BACKLINKS`, `TAGS`, `MENTIONS`. */
  readonly heading: string;
  /** How many rows the section holds — the heading's badge and the collapse default's input. */
  readonly count: number;
  /** Shown when the group is present but empty. Never rendered when hidden. */
  readonly rows: readonly ContextRow[];
}

/** The whole rail for one selection. */
export interface ContextModel {
  /** The selected node's own label, for the rail's subtitle. */
  readonly subject: string | null;
  /** LINKS, BACKLINKS and MENTIONS. Empty groups are omitted, never rendered. */
  readonly groups: readonly ContextGroup[];
  /**
   * TAGS, carried separately because a tag row is not a {@link ContextRow}.
   *
   * A tag has a name, a count and a list of sibling notes; flattening that
   * into the same array as the link rows would mean a union type and a
   * discriminant check inside the component — which is a branch, in a `.tsx`,
   * where §10 says branches cannot be covered. Two fields is the cheaper
   * shape.
   */
  readonly tags: readonly TagGroupRow[];
  /**
   * How many tags TAGS holds — the heading's count.
   *
   * Carried next to `tags` rather than derived in the component for the same
   * reason {@link ContextGroup.count} exists: the number is a *decision* about
   * what the heading says, and an empty rail reports `0` where a group-less
   * `tags.length` would report nothing to talk about.
   */
  readonly tagsCount: number;
  /** Present instead of groups when there is nothing to show. */
  readonly empty: string | null;
}

/** Section headings, in the order §1.2 sketches them. */
export const HEADINGS = { links: "LINKS", backlinks: "BACKLINKS", tags: "TAGS", mentions: "MENTIONS" } as const;

// --- building rows ------------------------------------------------------------------

/**
 * A row from a node. The rail's one place that reads a node's presentation.
 *
 * The icon follows the tree's rule, not the bare kind: a session-memory note
 * appears in LINKS just as often as in the tree, and the rail repeating the
 * tree's icon is how "this is the same thing" is communicated across the two
 * columns.
 */
export function rowFor(id: string, node: WireGraphNode, selectedId: string | null): ContextRow {
  return {
    id,
    target: node.id,
    label: listLabel(node),
    kind: node.kind,
    kindIcon: isSessionNote(node.id) ? "session" : kindIcon(node.kind),
    provenance: node.provenance,
    provenanceGlyph: provenanceGlyph(node.provenance),
    provenanceTitle: provenanceTitle(node.provenance),
    selected: node.id === selectedId,
  };
}

/**
 * A row from one of core's `DetailLinkRow`s.
 *
 * `DetailLinkRow.label` is pre-composed for a terminal — `"links-to → Alpha"`,
 * `"← Alpha"` — and the rail already says which direction a section is in its
 * heading, so repeating it in every row is noise. The node is looked up and
 * relabelled instead, which also recovers the kind glyph and provenance mark
 * that the terminal's single label string had flattened away.
 *
 * Exported so its two `null` paths are directly testable. Both are guards
 * against a shape core does not currently produce — `SelectableRow.target` is
 * optional in general but always set on a `DetailLinkRow`, and core filters
 * unresolvable targets before returning — so reaching them through
 * {@link contextModel} would mean constructing a payload core cannot emit.
 * A guard that cannot be exercised is a guard nobody can check is right.
 */
export function rowFromDetail(row: DetailLinkRow, byId: ReadonlyMap<string, WireGraphNode>, selectedId: string | null): ContextRow | null {
  const target = row.target;
  if (target === undefined) return null;
  const node = byId.get(target);
  // The guard for a truncated payload, where an edge can outlive the node it
  // points at.
  return node === undefined ? null : rowFor(row.id, node, selectedId);
}

/** Index a payload's nodes by id. */
function nodesById(model: ViewGraphModel): Map<string, WireGraphNode> {
  const byId = new Map<string, WireGraphNode>();
  for (const node of model.nodes) byId.set(node.id, node);
  return byId;
}

// --- the four groups ------------------------------------------------------------------

/**
 * Outgoing edges, excluding `mentions` and structural containment.
 *
 * `contains` and `anchored-at` are deliberately dropped: they are the tree's
 * job, the tree is on screen at the same time, and a `repository` node's rail
 * would otherwise be a second copy of the tree with every module in it.
 * `mentions` is dropped here because it gets a section of its own.
 */
const LINK_EDGE_PREFIXES = ["link:links-to:"];

/** True when a `DetailLinkRow`'s id names an edge kind the LINKS group shows. */
function isLinkRow(row: DetailLinkRow): boolean {
  return LINK_EDGE_PREFIXES.some((prefix) => row.id.startsWith(prefix));
}

/** True when a `DetailLinkRow` names a `mentions` edge. */
function isMentionRow(row: DetailLinkRow): boolean {
  return row.id.startsWith("link:mentions:");
}

/**
 * Tag rows for a note.
 *
 * From `GraphPayload.tags` (§4.3) — the structured `tag → slugs` index — and
 * never from `WireGraphNode.detail.tags`, which is a comma-joined display
 * string that §4.2 forbids turning back into structure. The membership test is
 * therefore "does this tag's slug list contain mine", which is exact even for
 * a tag whose name contains a comma.
 *
 * The rows target the tag's *other* notes rather than the tag itself, because
 * there is no tag node in the graph to select. A tag with only this note in it
 * still renders — it says something true about the note — but contributes no
 * navigable siblings, so its count reads `1`.
 */
export interface TagGroupRow {
  readonly tag: string;
  /** Notes carrying this tag, this one included. */
  readonly count: number;
  /** The other notes, clickable. */
  readonly siblings: readonly ContextRow[];
}

/** Tags for a slug, with the notes that share them. */
export function tagsFor(payload: GraphPayload, slug: string, byId: ReadonlyMap<string, WireGraphNode>, selectedId: string | null): TagGroupRow[] {
  const out: TagGroupRow[] = [];
  // Key order is `deriveTagIndex`'s: count descending, then tag ascending
  // (§4.3), and `Object.entries` preserves it. So the popular tags surface
  // first with no sorting here — re-sorting would discard a ranking the server
  // already computed and the ETag already depends on.
  for (const [tag, slugs] of Object.entries(payload.tags)) {
    if (!slugs.includes(slug)) continue;
    const siblings: ContextRow[] = [];
    for (const other of slugs) {
      if (other === slug) continue;
      const node = byId.get(`note:${other}`);
      if (node !== undefined) siblings.push(rowFor(`tag:${tag}:${other}`, node, selectedId));
    }
    out.push({ tag, count: slugs.length, siblings });
  }
  return out;
}

/**
 * Incoming `mentions`: which notes name this file or module (§4.4).
 *
 * The complement of the outgoing half, and the more useful direction of the
 * two — standing on `src/core/vault.ts` and seeing which notes discuss it is
 * the question a repository workspace exists to answer. `deriveBacklinks` is
 * no help here: it filters to `links-to` by design, so mentions need their own
 * pass.
 */
export function incomingMentions(model: ViewGraphModel, id: string, byId: ReadonlyMap<string, WireGraphNode>, selectedId: string | null): ContextRow[] {
  const rows: ContextRow[] = [];
  for (const edge of model.edges) {
    if (edge.kind !== "mentions" || edge.target !== id) continue;
    const node = byId.get(edge.source);
    if (node !== undefined) rows.push(rowFor(`mentioned-by:${edge.source}`, node, selectedId));
  }
  return rows;
}

// --- the model ----------------------------------------------------------------------------

/**
 * The slug inside a `note:<slug>` id, or `null`.
 *
 * Mirrors `workspace.ts`' `noteSlug` and `note.model.ts`' `slugOfNode`. Three
 * copies of a five-line rule is one too many, and the right fix is for the
 * node-id format to live in one module the client tier shares — but that is a
 * refactor across three files that P2 is not the commit for. Exported so the
 * empty-slug case is testable here rather than only through a payload that
 * would need a malformed node in it.
 */
export function slugOf(id: string): string | null {
  if (!id.startsWith("note:")) return null;
  const slug = id.slice("note:".length);
  return slug === "" ? null : slug;
}

/** Copy for the rail's own empty states. */
export const RAIL_EMPTY = {
  loading: "Loading…",
  noSelection: "Select anything to see what it connects to.",
  unknown: "This node is not in the current graph.",
  isolated: "Nothing links to or from this yet.",
} as const;

/** The rail with nothing to show, and a reason. */
function emptyRail(reason: string): ContextModel {
  return { subject: null, groups: [], tags: [], tagsCount: 0, empty: reason };
}

/**
 * Build the rail.
 *
 * Empty groups are **omitted**, not rendered as headings over nothing. The
 * rail sits under the graph column in a fixed-height region (§1.2), so four
 * headings with one row between them wastes the space that the one populated
 * group needed — and a heading with nothing under it reads as a load that
 * failed rather than as an absence.
 *
 * `now` is not a parameter: unlike the tree and the note header, nothing in
 * the rail is time-relative. Rows are labels and glyphs, which is the point —
 * a rail that changed as the clock moved would re-render three columns for no
 * reason.
 */
export function contextModel(payload: GraphPayload | null, selectedId: string | null): ContextModel {
  if (payload === null) return emptyRail(RAIL_EMPTY.loading);
  if (selectedId === null) return emptyRail(RAIL_EMPTY.noSelection);

  const model = viewModel(payload);
  const detail = detailModel(model, selectedId);
  if (detail === null) return emptyRail(RAIL_EMPTY.unknown);

  const byId = nodesById(model);
  const groups: ContextGroup[] = [];
  const push = (heading: string, rows: readonly ContextRow[]): void => {
    if (rows.length > 0) groups.push({ heading, count: rows.length, rows });
  };

  const resolve = (rows: readonly DetailLinkRow[]): ContextRow[] =>
    rows.map((row) => rowFromDetail(row, byId, selectedId)).filter((row): row is ContextRow => row !== null);

  push(HEADINGS.links, resolve(detail.links.filter(isLinkRow)));

  // From the whole-graph pass rather than `detail.backlinks`, which is the
  // same data — but this map is built once and the rail is rebuilt on every
  // selection, so the shared pass is the one that scales.
  const backlinks = deriveBacklinks(model.edges).get(selectedId) ?? [];
  push(
    HEADINGS.backlinks,
    backlinks
      .map((source) => byId.get(source))
      .filter((node): node is WireGraphNode => node !== undefined)
      .map((node) => rowFor(`backlink:${node.id}`, node, selectedId)),
  );

  // Both directions in one section: what this names, and what names it. A
  // note sees the code it discusses; a module sees the notes discussing it,
  // and no node is ever both in practice.
  push(HEADINGS.mentions, [...resolve(detail.links.filter(isMentionRow)), ...incomingMentions(model, selectedId, byId, selectedId)]);

  const slug = slugOf(selectedId);
  const tags = slug === null ? [] : tagsFor(payload, slug, byId, selectedId);

  if (groups.length === 0 && tags.length === 0) {
    return { subject: detail.label, groups: [], tags: [], tagsCount: 0, empty: RAIL_EMPTY.isolated };
  }
  return { subject: detail.label, groups, tags, tagsCount: tags.length, empty: null };
}

// --- counts and collapse (Tier 6, §8 P6.4) ---------------------------------------------

/**
 * A rail section as the component renders it: the heading's count, whether it
 * is open, and the rows to show under it.
 *
 * Collapsed is a rendering state, not a data state, so `rows` is emptied here
 * rather than the component filtering — otherwise the collapsed decision
 * would be an untestable branch in a `.tsx`.
 */
export interface RailSectionView {
  readonly heading: string;
  readonly count: number;
  readonly collapsed: boolean;
  /** The rows, `[]` when collapsed. */
  readonly rows: readonly ContextRow[];
}

/**
 * Which sections the user has explicitly opened or closed.
 *
 * Two sets rather than one because "collapsed" has three origins — the user,
 * the >8 default, and the selection's force-expand — and a single Set cannot
 * say which of them a heading is in. `open` and `closed` are the user's word;
 * the other two are computed by {@link railCollapsed}.
 */
export interface RailToggles {
  /** Sections the user explicitly opened. */
  readonly open: ReadonlySet<string>;
  /** Sections the user explicitly closed. */
  readonly closed: ReadonlySet<string>;
}

/** No user opinion yet — the rail's state on mount. */
export function emptyRailToggles(): RailToggles {
  return { open: new Set(), closed: new Set() };
}

/**
 * A section longer than this opens collapsed.
 *
 * Eight is where a list stops being scannable without scrolling: the rail has
 * a fixed fraction of a fixed column (§1.2), so a MENTIONS section with forty
 * entries would push the sections below it out of the viewport entirely —
 * which is how a rail meant to show *everything at once* ends up showing one
 * group. Under eight the rhythm would cost more than it saved.
 */
export const RAIL_COLLAPSE_THRESHOLD = 8;

/**
 * Whether a section is collapsed.
 *
 * Order of precedence, most specific wins:
 *
 *  1. **The selection is never hidden.** If the selected row lives in this
 *     section, force-expand — `selectedId` is the §1.3 bus and can change a
 *     hundred times a minute while the user is reading something else; a
 *     selection that vanished into a fold would be a bug the user experiences
 *     as "clicking did nothing" and never connects to a toggle 40px away.
 *  2. The user's explicit *close* beats the default but not the selection.
 *  3. The user's explicit *open* beats the default.
 *  4. Otherwise, the {@link RAIL_COLLAPSE_THRESHOLD} default.
 */
export function railCollapsed(toggles: RailToggles, heading: string, count: number, holdsSelection: boolean): boolean {
  if (holdsSelection) return false;
  if (toggles.closed.has(heading)) return true;
  if (toggles.open.has(heading)) return false;
  return count > RAIL_COLLAPSE_THRESHOLD;
}

/** Whether the selection itself is one of this section's rows. */
function holdsSelection(rows: readonly ContextRow[]): boolean {
  return rows.some((row) => row.selected);
}

/**
 * Resolve one section for rendering.
 *
 * The heading identifies the toggle, and headings are a fixed vocabulary
 * ({@link HEADINGS}), so a per-render id is stable across re-renders and
 * remounts — which is what `aria-controls` needs to stay a true promise about
 * the DOM.
 */
export function railSectionView(group: ContextGroup, toggles: RailToggles): RailSectionView {
  const collapsed = railCollapsed(toggles, group.heading, group.count, holdsSelection(group.rows));
  return { heading: group.heading, count: group.count, collapsed, rows: collapsed ? [] : group.rows };
}

/**
 * The TAGS section through the same vocabulary as the link sections.
 *
 * `TAGS` is not a {@link ContextGroup} — its rows are tag groups — but it
 * toggles and counts exactly the same way, so it goes through the same
 * predicate rather than growing a second collapse rule. The count is the
 * number of *tags*, not sibling rows: the heading names the category, and
 * "3 tags" is what a scanner wants before deciding whether to open it.
 */
export function railTagsView(tags: readonly TagGroupRow[], toggles: RailToggles): RailSectionView {
  const collapsed = railCollapsed(toggles, HEADINGS.tags, tags.length, tags.some((tag) => tag.siblings.some((row) => row.selected)));
  return { heading: HEADINGS.tags, count: tags.length, collapsed, rows: [] };
}

/**
 * Move one section to the other state.
 *
 * Both sets are updated per toggle so a heading can never sit in both: the
 * user asking twice (click, selection moves it, click) always lands on a
 * consistent single-word answer.
 */
export function railToggled(toggles: RailToggles, heading: string, collapsed: boolean): RailToggles {
  const open = new Set(toggles.open);
  const closed = new Set(toggles.closed);
  if (collapsed) {
    open.add(heading);
    closed.delete(heading);
  } else {
    closed.add(heading);
    open.delete(heading);
  }
  return { open, closed };
}

/** The `id` of a section's row list, for `aria-controls` to point at. */
export function railPanelId(heading: string): string {
  return `weave-ctx-panel-${heading.toLowerCase()}`;
}
