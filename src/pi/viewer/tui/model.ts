/**
 * PURE view-model for the weave-view TUI (weave-view-tui-design §5, §10.1).
 *
 * Ports the browser page's `listTree` / `focusNeighborhood` / `deriveBacklinks`
 * semantics into TypeScript. Imports ONLY core types — no pi-tui imports —
 * so the bulk of the logic is unit-tested like the page's listTree tests.
 *
 * Every interesting behavior is an exported pure function: `treeRows`,
 * `focusModel`, `detailModel`, `healthModel`, `reduce`, `sanitizeTerminalText`.
 */

import type { GraphEdge, GraphModel, GraphNode, NodeKind } from "../../../core/graph/model";
import type { NoteSource } from "../../../core/types";
import { MAX_FILTER_LEN, PROVENANCE_CYCLE, provenanceStyle, type ProvenanceStyle } from "./theme";

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/** A selectable row in any surface. `target` (when set) is the node id a row
 *  jumps to on `enter` (a link / neighbor). */
export interface SelectableRow {
  id: string;
  /** Node id this row jumps to on enter (links/backlinks/neighbors). */
  target?: string;
}

/** One row in the Explore tree. */
export interface TreeRow extends SelectableRow {
  depth: number;
  hasKids: boolean;
  expanded: boolean;
  label: string;
  kind: NodeKind;
  provenance: NoteSource | null;
  /** Dim meta tail (note: relative updated; module: files=N; …), pre-truncated. */
  meta: string;
}

// ---------------------------------------------------------------------------
// Shared pure helpers (mirror the page's `focusNeighborhood` / `deriveBacklinks`)
// ---------------------------------------------------------------------------

/** 1-hop neighborhood of `id` (the node itself + direct neighbors). 2-hop excluded. */
export function focusNeighborhood(id: string, edges: readonly GraphEdge[]): Set<string> {
  const out = new Set<string>([id]);
  for (const e of edges) {
    if (e.source === id) out.add(e.target);
    if (e.target === id) out.add(e.source);
  }
  return out;
}

/** Map each node id → its incoming `links-to` sources (backlinks). */
export function deriveBacklinks(edges: readonly GraphEdge[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of edges) {
    if (e.kind !== "links-to") continue;
    const list = out.get(e.target);
    if (list) list.push(e.source);
    else out.set(e.target, [e.source]);
  }
  return out;
}

/** Incident-edge degree (both directions, all kinds). */
export function degreeOf(id: string, edges: readonly GraphEdge[]): number {
  let d = 0;
  for (const e of edges) if (e.source === id || e.target === id) d++;
  return d;
}

/** Relative human time, mirroring the page's `relTime`. `now` is epoch ms. */
export function relTime(iso: string | undefined, now: number): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

// ---------------------------------------------------------------------------
// treeRows — the Explore surface (port of the page's listTree, 1:1)
// ---------------------------------------------------------------------------

export interface TreeState {
  /** Expanded node ids (when no filter is active). */
  expanded: ReadonlySet<string>;
  /** Reveal repo plumbing (gitState/external/package/entryPoint). */
  showInternals: boolean;
  /** Provenance filter (null = all). */
  provFilter: NoteSource | null;
  /** Substring filter on node labels (case-insensitive). */
  query: string;
  /** Reference time for relative-time meta (epoch ms). */
  now: number;
}

/** Disambiguate labels that would otherwise read as the same entry twice
 *  (a remote URL whose tail matches the repo name, an npm package named
 *  after the repo). Mirrors the page's `listLabel`. */
export function listLabel(node: GraphNode): string {
  if (node.kind === "external" && node.detail.url) {
    const u = node.detail.url
      .replace(/^[a-z]+:\/\//, "")
      .replace(/^[^@\/]+@/, "")
      .replace(/\.git$/, "")
      .replace(/\/+$/, "");
    if (u) return u;
  }
  if (node.kind === "package" && node.detail.manifest) {
    return `${node.label} (${node.detail.manifest})`;
  }
  return node.label;
}

/** Build the contains/anchored-at nesting + entry-point-to-module map. */
interface TreeIndex {
  byId: Map<string, GraphNode>;
  /** strict contains (used for entry-point → module placement). */
  contains: Map<string, string[]>;
  /** contains + anchored-at (the nesting hierarchy). */
  tree: Map<string, string[]>;
  /** node id → true when it has an incoming contains/anchored-at edge. */
  incoming: Set<string>;
  /** module id → entry-point ids nested under it (by path prefix). */
  moduleEntries: Map<string, string[]>;
  /** roots (nodes with no incoming edge), in node-input order. */
  roots: string[];
}

function indexTree(model: GraphModel): TreeIndex {
  const byId = new Map<string, GraphNode>();
  for (const n of model.nodes) byId.set(n.id, n);

  const contains = new Map<string, string[]>();
  const tree = new Map<string, string[]>();
  const incoming = new Set<string>();
  for (const e of model.edges) {
    if (e.kind === "contains") {
      const list = contains.get(e.source);
      if (list) list.push(e.target);
      else contains.set(e.source, [e.target]);
    }
    if (e.kind === "contains" || e.kind === "anchored-at") {
      const list = tree.get(e.source);
      if (list) list.push(e.target);
      else tree.set(e.source, [e.target]);
      incoming.add(e.target);
    }
  }

  // Entry points nest under the module whose path is the entry's directory prefix.
  const moduleFor = (entryId: string): string | null => {
    const entry = byId.get(entryId);
    if (!entry || entry.kind !== "entryPoint" || !entry.detail.path) return null;
    const p = entry.detail.path;
    let best: string | null = null;
    let bestLen = 0;
    const repoKids = contains.get("repository") ?? [];
    for (const cid of repoKids) {
      const c = byId.get(cid);
      if (c && c.kind === "module" && c.detail.path) {
        const mp = c.detail.path;
        if (p.startsWith(mp + "/") && mp.length > bestLen) {
          best = cid;
          bestLen = mp.length;
        }
      }
    }
    return best;
  };

  const moduleEntries = new Map<string, string[]>();
  for (const n of model.nodes) {
    if (n.kind !== "entryPoint") continue;
    const m = moduleFor(n.id);
    if (m) {
      const list = moduleEntries.get(m);
      if (list) list.push(n.id);
      else moduleEntries.set(m, [n.id]);
    }
  }

  const roots = model.nodes.filter((n) => !incoming.has(n.id)).map((n) => n.id);
  return { byId, contains, tree, incoming, moduleEntries, roots };
}

/** Knowledge-first default: hide repo plumbing unless showInternals. */
function hiddenInternalKind(kind: NodeKind): boolean {
  return kind === "gitState" || kind === "external" || kind === "package" || kind === "entryPoint";
}

function sortKids(ids: string[], byId: Map<string, GraphNode>): string[] {
  return ids
    .slice()
    .sort((a, b) => {
      const la = listLabel(byId.get(a)!);
      const lb = listLabel(byId.get(b)!);
      return la.localeCompare(lb);
    });
}

function metaFor(node: GraphNode, now: number): string {
  switch (node.kind) {
    case "note":
      return node.detail.updated ? relTime(node.detail.updated, now) : "";
    case "module":
      return node.detail.files ? `files=${node.detail.files}` : "";
    case "gitState":
      return node.detail.commit ? node.detail.commit.slice(0, 7) : "";
    case "repository":
      return node.detail.files ? `${node.detail.files} files` : "";
    case "package":
      return node.detail.kind ?? "";
    case "entryPoint":
      return node.detail.summary ? "summary" : "";
    default:
      return "";
  }
}

/**
 * Build the Explore tree rows (port of the page's `listTree`).
 *
 * - Roots: `vault`, `repository` (nodes with no incoming containment edge).
 * - Entry points nest under their prefix module.
 * - Internals hidden by default; `i` toggles.
 * - Filter (query and/or provenance): prune to matches + ancestors, auto-expanding ancestors.
 * - Default expansion (no filter): controlled by `state.expanded`.
 */
export function treeRows(model: GraphModel, state: TreeState): TreeRow[] {
  const idx = indexTree(model);
  const { byId, tree, moduleEntries, roots } = idx;

  const children = (id: string): string[] => {
    const kids = tree.get(id) ?? [];
    // Drop entry points that have a claiming module (they re-nest under it).
    const filtered = kids.filter((kid) => {
      const n = byId.get(kid);
      if (!n || n.kind !== "entryPoint") return true;
      for (const [, entries] of moduleEntries) {
        if (entries.includes(kid)) return false;
      }
      return true;
    });
    let all = filtered.concat(moduleEntries.get(id) ?? []);
    if (!state.showInternals) {
      all = all.filter((k) => {
        const n = byId.get(k);
        return !(n && hiddenInternalKind(n.kind));
      });
    }
    return sortKids(all, byId);
  };

  const filtering = state.provFilter !== null || state.query.length > 0;

  const matches = (node: GraphNode): boolean => {
    if (state.provFilter !== null && node.provenance !== state.provFilter) return false;
    if (state.query.length > 0 && !listLabel(node).toLowerCase().includes(state.query.toLowerCase())) return false;
    return true;
  };

  // Pass 1: mark visible nodes (self-match or a visible descendant).
  const visible = new Set<string>();
  const mark = (id: string): boolean => {
    const node = byId.get(id);
    if (!node) return false;
    let any = false;
    for (const k of children(id)) if (mark(k)) any = true;
    const show = matches(node) || any;
    if (show) visible.add(id);
    return show;
  };
  for (const r of roots) mark(r);

  const rows: TreeRow[] = [];
  const walk = (id: string, depth: number): void => {
    if (!visible.has(id)) return;
    const node = byId.get(id);
    if (!node) return;
    const kids = children(id);
    const visibleKids = kids.filter((k) => visible.has(k));
    const expanded = filtering ? visibleKids.length > 0 : state.expanded.has(id);
    rows.push({
      id,
      depth,
      hasKids: kids.length > 0,
      expanded,
      label: listLabel(node),
      kind: node.kind,
      provenance: node.provenance,
      meta: metaFor(node, state.now),
    });
    if (expanded) for (const k of visibleKids) walk(k, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return rows;
}

/** Empty-state hint rows for the tree surface (design §5.1). */
export function treeEmptyHint(model: GraphModel): string | null {
  const vault = model.nodes.find((n) => n.kind === "vault");
  if (!vault) return null;
  // no notes and no repository
  const hasNotes = model.nodes.some((n) => n.kind === "note");
  const hasRepo = model.nodes.some((n) => n.kind === "repository");
  if (!hasNotes && !hasRepo) return "no notes yet — add one with the weave_note tool";
  return null;
}

// ---------------------------------------------------------------------------
// focusModel — the 1-hop neighborhood (port of focusNeighborhood, grouped)
// ---------------------------------------------------------------------------

export interface FocusRow extends SelectableRow {
  label: string;
  kind: NodeKind;
  provenance: NoteSource | null;
}

export interface FocusGroup {
  /** Heading label, e.g. "links to →", "← linked from", "contains", "contained by". */
  heading: string;
  rows: FocusRow[];
}

export interface FocusModel {
  center: FocusRow;
  groups: FocusGroup[];
}

const OUTGOING_HEADINGS: Record<string, string> = {
  "links-to": "links to →",
  contains: "contains",
  "anchored-at": "anchored at",
};

/** Group the 1-hop neighborhood of `id` (outgoing by kind, then incoming). */
export function focusModel(model: GraphModel, id: string): FocusModel {
  const byId = new Map<string, GraphNode>();
  for (const n of model.nodes) byId.set(n.id, n);

  const centerNode = byId.get(id);
  const center: FocusRow = centerNode
    ? rowFromNode(centerNode)
    : { id, label: id, kind: "note", provenance: null };

  const outByKind = new Map<string, string[]>();
  const incomingContains = new Map<string, string[]>();
  const backlinks = new Map<string, string[]>();
  for (const e of model.edges) {
    if (e.source === id) {
      const list = outByKind.get(e.kind);
      if (list) list.push(e.target);
      else outByKind.set(e.kind, [e.target]);
    } else if (e.target === id) {
      if (e.kind === "links-to") {
        const list = backlinks.get(e.kind);
        if (list) list.push(e.source);
        else backlinks.set(e.kind, [e.source]);
      } else if (e.kind === "contains" || e.kind === "anchored-at") {
        const list = incomingContains.get(e.kind);
        if (list) list.push(e.source);
        else incomingContains.set(e.kind, [e.source]);
      }
    }
  }

  const toRows = (ids: string[]): FocusRow[] =>
    ids
      .map((x) => byId.get(x))
      .filter((n): n is GraphNode => n !== undefined)
      .map(rowFromNode);

  const groups: FocusGroup[] = [];
  for (const kind of ["links-to", "contains", "anchored-at"] as const) {
    const ids = outByKind.get(kind) ?? [];
    if (ids.length === 0) continue;
    groups.push({ heading: OUTGOING_HEADINGS[kind] ?? kind, rows: toRows(ids) });
  }
  const bl = backlinks.get("links-to") ?? [];
  if (bl.length > 0) groups.push({ heading: "← linked from", rows: toRows(bl) });
  const containedBy = incomingContains.get("contains") ?? incomingContains.get("anchored-at") ?? [];
  if (containedBy.length > 0) groups.push({ heading: "contained by", rows: toRows(containedBy) });

  return { center, groups };
}

function rowFromNode(n: GraphNode): FocusRow {
  return { id: n.id, target: n.id, label: listLabel(n), kind: n.kind, provenance: n.provenance };
}

// ---------------------------------------------------------------------------
// detailModel — selected node meta + links + backlinks (body loaded async)
// ---------------------------------------------------------------------------

export interface DetailMetaRow extends SelectableRow {
  label: string;
  value: string;
}

export interface DetailLinkRow extends SelectableRow {
  label: string;
  kind: NodeKind;
  provenance: NoteSource | null;
  /** "link" (outgoing) or "backlink" (incoming). */
  direction: "link" | "backlink";
}

export interface DetailModel {
  id: string;
  label: string;
  kind: NodeKind;
  provenance: NoteSource | null;
  meta: DetailMetaRow[];
  links: DetailLinkRow[];
  backlinks: DetailLinkRow[];
}

/** Ordered meta keys shown in the detail header (design §5.2). */
const META_ORDER = [
  "path",
  "slug",
  "source",
  "updated",
  "created",
  "tags",
  "files",
  "languages",
  "branch",
  "commit",
  "uncommitted changes",
  "captured",
  "manifest",
  "kind",
  "url",
  "summarized files",
  "summarized by",
  "summarized at",
  "summary",
  "dangling links",
  "warning",
  "stale",
  "preview",
  "root",
  "notes",
  "state",
] as const;

export function detailModel(model: GraphModel, id: string): DetailModel | null {
  const byId = new Map<string, GraphNode>();
  for (const n of model.nodes) byId.set(n.id, n);
  const node = byId.get(id);
  if (!node) return null;

  const meta: DetailMetaRow[] = [];
  for (const key of META_ORDER) {
    const v = node.detail[key];
    if (v === undefined || v === "") continue;
    meta.push({ id: `meta:${key}`, label: key, value: v });
  }

  const links: DetailLinkRow[] = [];
  for (const e of model.edges) {
    if (e.source !== id) continue;
    const t = byId.get(e.target);
    if (!t) continue;
    links.push({
      id: `link:${e.kind}:${e.target}`,
      target: e.target,
      label: `${e.kind} → ${listLabel(t)}`,
      kind: t.kind,
      provenance: t.provenance,
      direction: "link",
    });
  }

  const backlinks: DetailLinkRow[] = [];
  for (const e of model.edges) {
    if (e.kind !== "links-to" || e.target !== id) continue;
    const s = byId.get(e.source);
    if (!s) continue;
    backlinks.push({
      id: `backlink:${e.source}`,
      target: e.source,
      label: `← ${listLabel(s)}`,
      kind: s.kind,
      provenance: s.provenance,
      direction: "backlink",
    });
  }

  return {
    id,
    label: listLabel(node),
    kind: node.kind,
    provenance: node.provenance,
    meta,
    links,
    backlinks,
  };
}

// ---------------------------------------------------------------------------
// healthModel — staleness + link health, derived exclusively from GraphModel
// ---------------------------------------------------------------------------

export interface HealthRow extends SelectableRow {
  text: string;
}

export interface HealthSection {
  heading: string;
  rows: HealthRow[];
}

export interface HealthModel {
  sections: HealthSection[];
}

const HEALTH_LIST_CAP = 10;

/** Staleness + link health, derived exclusively from the GraphModel
 *  (design §5.4 — mirrors v2 §7: zero new server/core fields). */
export function healthModel(model: GraphModel): HealthModel {
  const byId = new Map<string, GraphNode>();
  for (const n of model.nodes) byId.set(n.id, n);
  const sections: HealthSection[] = [];

  // Repository section
  const repo = byId.get("repository");
  if (repo) {
    const rows: HealthRow[] = [];
    const staleness = model.staleness;
    if (staleness) {
      rows.push({ id: "health:repo:state", text: `state: ${staleness.state}` });
      for (let i = 0; i < staleness.reasons.length; i++) {
        rows.push({ id: `health:repo:reason:${i}`, text: `  ${staleness.reasons[i]}` });
      }
    }
    if (repo.detail.files) rows.push({ id: "health:repo:files", text: `files: ${repo.detail.files}` });
    if (repo.detail.languages) rows.push({ id: "health:repo:langs", text: `languages: ${repo.detail.languages}` });
    const summarized = model.nodes
      .filter((n) => n.kind === "module" && n.detail["summarized files"])
      .reduce((acc, n) => acc + Number(n.detail["summarized files"] ?? 0), 0);
    if (summarized > 0) {
      rows.push({ id: "health:repo:summarized", text: `summarized files: ${summarized} (run /weave-scan deep)` });
    }
    if (repo.detail.state === "stale") {
      // already covered by staleness reasons; no extra row
    }
    sections.push({ heading: "Repository", rows });
  }

  // Vault section
  const vault = byId.get("vault");
  if (vault) {
    const rows: HealthRow[] = [];
    const noteCount = Number(vault.detail.notes ?? "0");
    rows.push({ id: "health:vault:notes", text: `notes: ${noteCount}` });
    const prov = countProvenance(model.nodes);
    rows.push({
      id: "health:vault:provenance",
      text: `provenance: ● human ${prov.human} · ◐ agent ${prov.agent} · ○ generated ${prov.generated}`,
    });
    if (vault.detail.warning) {
      rows.push({ id: "health:vault:warning", text: vault.detail.warning });
    }
    sections.push({ heading: "Vault", rows });
  }

  // Link health
  const backlinks = deriveBacklinks(model.edges);
  const orphans: GraphNode[] = [];
  const dangling: { node: GraphNode; count: number }[] = [];
  for (const n of model.nodes) {
    if (n.kind !== "note") continue;
    if (!backlinks.has(n.id)) orphans.push(n);
    const dl = n.detail["dangling links"];
    if (dl && Number(dl) > 0) dangling.push({ node: n, count: Number(dl) });
  }
  const degree = new Map<string, number>();
  for (const e of model.edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  const hubs = [...model.nodes]
    .map((n) => ({ n, d: degree.get(n.id) ?? 0 }))
    .filter((x) => x.d > 0)
    .sort((a, b) => b.d - a.d)
    .slice(0, HEALTH_LIST_CAP);

  const linkRows: HealthRow[] = [];
  if (orphans.length > 0) {
    linkRows.push({ id: "health:link:orphans-h", text: `orphans (${orphans.length}):` });
    const shown = orphans.slice(0, HEALTH_LIST_CAP);
    for (let i = 0; i < shown.length; i++) {
      linkRows.push({ id: `health:link:orphan:${shown[i]!.id}`, text: `  ${listLabel(shown[i]!)}`, target: shown[i]!.id });
    }
    if (orphans.length > HEALTH_LIST_CAP) {
      linkRows.push({ id: "health:link:orphan:more", text: `  … and ${orphans.length - HEALTH_LIST_CAP} more` });
    }
  } else {
    linkRows.push({ id: "health:link:orphans-h", text: "orphans: none" });
  }
  if (dangling.length > 0) {
    linkRows.push({ id: "health:link:dangling-h", text: `dangling links (${dangling.length}):` });
    const shown = dangling.slice(0, HEALTH_LIST_CAP);
    for (let i = 0; i < shown.length; i++) {
      linkRows.push({
        id: `health:link:dangling:${shown[i]!.node.id}`,
        text: `  ${listLabel(shown[i]!.node)} (${shown[i]!.count})`,
        target: shown[i]!.node.id,
      });
    }
    if (dangling.length > HEALTH_LIST_CAP) {
      linkRows.push({ id: "health:link:dangling:more", text: `  … and ${dangling.length - HEALTH_LIST_CAP} more` });
    }
  }
  if (hubs.length > 0) {
    linkRows.push({ id: "health:link:hubs-h", text: `top hubs (by degree):` });
    for (let i = 0; i < hubs.length; i++) {
      linkRows.push({
        id: `health:link:hub:${hubs[i]!.n.id}`,
        text: `  ${listLabel(hubs[i]!.n)} (${hubs[i]!.d})`,
        target: hubs[i]!.n.id,
      });
    }
  }
  sections.push({ heading: "Link health", rows: linkRows });

    return { sections };
}

export interface ProvenanceCounts {
  total: number;
  human: number;
  agent: number;
  generated: number;
  structural: number;
}

export function countProvenance(nodes: readonly GraphNode[]): ProvenanceCounts {
  const c: ProvenanceCounts = { total: nodes.length, human: 0, agent: 0, generated: 0, structural: 0 };
  for (const n of nodes) {
    if (n.provenance === "human") c.human++;
    else if (n.provenance === "agent") c.agent++;
    else if (n.provenance === "generated") c.generated++;
    else c.structural++;
  }
  return c;
}

// ---------------------------------------------------------------------------
// sanitizeTerminalText — the TUI's XSS analog (design §9.3)
// ---------------------------------------------------------------------------

/** Strip terminal-escape/control sequences from disk/user content before
 *  styling or handing to Markdown: ESC (0x1b), CSI (0x9b), BEL (0x07), and
 *  other C0 controls except newline (0x0a) and tab (0x09). */
export function sanitizeTerminalText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b/g, "").replace(/\x9b/g, "").replace(/\x07/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

// ---------------------------------------------------------------------------
// ExplorerState + reduce — key→state transitions (design §6, §10.1)
// ---------------------------------------------------------------------------

export type Surface = "tree" | "detail" | "focus" | "health";

export interface ExplorerState {
  surface: Surface;
  /** Inline search sub-mode (only meaningful on the tree surface). */
  searching: boolean;
  /** Selected node id (source of truth; the cursor index is derived). */
  selectedId: string | null;
  /** Node pinned for focus mode. */
  focusId: string | null;
  /** Node open in detail. */
  detailId: string | null;
  /** Tree expansion (when no filter is active). */
  expanded: Set<string>;
  showInternals: boolean;
  provFilter: NoteSource | null;
  query: string;
  helpOpen: boolean;
  refreshing: boolean;
  /** Bumped on every mutation so the render cache can key off it. */
  version: number;
  /** Scroll offset (top visible row index) for the current surface. */
  scrollOffset: number;
}

export function initialState(roots: readonly string[]): ExplorerState {
  const expanded = new Set<string>();
  for (const r of roots) expanded.add(r);
  const selectedId = roots[0] ?? null;
  return {
    surface: "tree",
    searching: false,
    selectedId,
    focusId: null,
    detailId: null,
    expanded,
    showInternals: false,
    provFilter: null,
    query: "",
    helpOpen: false,
    refreshing: false,
    version: 0,
    scrollOffset: 0,
  };
}

/** The roots of a graph (nodes with no incoming contains/anchored-at edge). */
export function graphRoots(model: GraphModel): string[] {
  const incoming = new Set<string>();
  for (const e of model.edges) {
    if (e.kind === "contains" || e.kind === "anchored-at") incoming.add(e.target);
  }
  return model.nodes.filter((n) => !incoming.has(n.id)).map((n) => n.id);
}

export type Action =
  | { type: "up" }
  | { type: "down" }
  | { type: "pageUp" }
  | { type: "pageDown" }
  | { type: "home" }
  | { type: "end" }
  | { type: "left" }
  | { type: "right" }
  | { type: "enter" }
  | { type: "searchStart" }
  | { type: "searchChar"; ch: string }
  | { type: "searchBackspace" }
  | { type: "searchCommit" }
  | { type: "cycleProvenance" }
  | { type: "toggleInternals" }
  | { type: "focus" }
  | { type: "focusExit" }
  | { type: "surfaceTree" }
  | { type: "surfaceHealth" }
  | { type: "refresh" }
  | { type: "refreshDone" }
  | { type: "toggleHelp" }
  | { type: "quit" }
  | { type: "esc" };

/** Context reduce needs for movement: the selectable rows of the current
 *  surface (in display order) and the viewport window size. */
export interface ReduceCtx {
  rows: readonly SelectableRow[];
  window: number;
}

function bump(s: ExplorerState): ExplorerState {
  return { ...s, version: s.version + 1 };
}

function clampIndex(idx: number, len: number): number {
  if (len === 0) return -1;
  if (idx < 0) return 0;
  if (idx >= len) return len - 1;
  return idx;
}

function scrollForSelection(idx: number, window: number, prev: number): number {
  if (window <= 0) return 0;
  if (idx < 0) return 0;
  // keep selection visible: offset <= idx < offset + window
  if (idx < prev) return idx;
  if (idx >= prev + window) return idx - window + 1;
  return prev;
}

function provenanceCycleNext(current: NoteSource | null): NoteSource | null {
  const i = PROVENANCE_CYCLE.indexOf(current);
  const next = PROVENANCE_CYCLE[(i + 1) % PROVENANCE_CYCLE.length];
  return next ?? null;
}

/**
 * Apply an action to the explorer state. Pure: returns a new state.
 *
 * Movement uses `ctx.rows` (the current surface's selectable rows) and
 * `ctx.window` (viewport height) to clamp the cursor and adjust scroll.
 * The component builds `ctx.rows` from the surface's model function.
 */
export function reduce(state: ExplorerState, action: Action, ctx: ReduceCtx = { rows: [], window: 24 }): ExplorerState {
  const rows = ctx.rows;
  const len = rows.length;
  const currentIdx = state.selectedId ? rows.findIndex((r) => r.id === state.selectedId || r.target === state.selectedId) : -1;

  switch (action.type) {
    case "up":
    case "down":
    case "pageUp":
    case "pageDown":
    case "home":
    case "end": {
      if (len === 0) return state;
      let nextIdx: number;
      if (action.type === "up") nextIdx = currentIdx <= 0 ? 0 : currentIdx - 1;
      else if (action.type === "down") nextIdx = currentIdx < 0 ? 0 : Math.min(currentIdx + 1, len - 1);
      else if (action.type === "pageUp") nextIdx = currentIdx < 0 ? 0 : Math.max(0, currentIdx - ctx.window);
      else if (action.type === "pageDown") nextIdx = currentIdx < 0 ? 0 : Math.min(len - 1, currentIdx + ctx.window);
      else if (action.type === "home") nextIdx = 0;
      else nextIdx = len - 1; // end
      nextIdx = clampIndex(nextIdx, len);
      const row = rows[nextIdx];
      if (!row) return state;
      const selectedId = row.target ?? row.id;
      const scrollOffset = scrollForSelection(nextIdx, ctx.window, state.scrollOffset);
      return bump({ ...state, selectedId, scrollOffset });
    }

    case "left":
    case "right": {
      if (state.surface !== "tree") return state;
      if (!state.selectedId) return state;
      // operate on the tree: find the row for selectedId
      const treeRowIdx = rows.findIndex((r) => r.id === state.selectedId);
      const treeRow = treeRowIdx >= 0 ? (rows[treeRowIdx] as TreeRow | undefined) : undefined;
      const isExpanded = state.expanded.has(state.selectedId);
      if (action.type === "right") {
        if (treeRow && treeRow.hasKids && !isExpanded) {
          const expanded = new Set(state.expanded).add(state.selectedId);
          return bump({ ...state, expanded });
        }
        if (treeRow && isExpanded) {
          // move to first child
          const child = rows[treeRowIdx + 1];
          if (child) return bump({ ...state, selectedId: child.id, scrollOffset: scrollForSelection(treeRowIdx + 1, ctx.window, state.scrollOffset) });
        }
        return state;
      }
      // left: collapse, or jump to parent
      if (treeRow && isExpanded) {
        const expanded = new Set(state.expanded);
        expanded.delete(state.selectedId);
        return bump({ ...state, expanded });
      }
      // jump to parent: the nearest preceding row with smaller depth
      for (let i = treeRowIdx - 1; i >= 0; i--) {
        const r = rows[i] as TreeRow | undefined;
        if (r && r.depth < (treeRow?.depth ?? 0)) {
          return bump({ ...state, selectedId: r.id, scrollOffset: scrollForSelection(i, ctx.window, state.scrollOffset) });
        }
      }
      return state;
    }

    case "enter": {
      if (state.searching) {
        // commit search: keep filter, exit search mode
        return bump({ ...state, searching: false, scrollOffset: 0 });
      }
      if (!state.selectedId) return state;
      const row = currentIdx >= 0 ? rows[currentIdx] : undefined;
      if (state.surface === "tree") {
        return bump({ ...state, surface: "detail", detailId: state.selectedId, scrollOffset: 0 });
      }
      if (state.surface === "detail") {
        // jump to the selected link/backlink target
        if (row && row.target) {
          return bump({ ...state, surface: "detail", detailId: row.target, selectedId: row.target, scrollOffset: 0 });
        }
        return state;
      }
      if (state.surface === "focus") {
        // re-center on the selected neighbor
        if (row && row.target) {
          return bump({ ...state, focusId: row.target, selectedId: row.target, scrollOffset: 0 });
        }
        return state;
      }
      if (state.surface === "health") {
        if (row && row.target) {
          return bump({ ...state, surface: "detail", detailId: row.target, selectedId: row.target, scrollOffset: 0 });
        }
        return state;
      }
      return state;
    }

    case "searchStart": {
      if (state.searching) return state;
      if (state.surface === "detail") return state;
      return bump({ ...state, searching: true });
    }

    case "searchChar": {
      if (!state.searching) return state;
      const q = (state.query + action.ch).slice(0, MAX_FILTER_LEN);
      return bump({ ...state, query: q, scrollOffset: 0 });
    }

    case "searchBackspace": {
      if (!state.searching) return state;
      return bump({ ...state, query: state.query.slice(0, -1), scrollOffset: 0 });
    }

    case "searchCommit": {
      if (!state.searching) return state;
      return bump({ ...state, searching: false, scrollOffset: 0 });
    }

    case "esc": {
      // precedence: search > surface-exit > quit
      if (state.searching) {
        return bump({ ...state, searching: false, query: "", scrollOffset: 0 });
      }
      if (state.surface === "detail") {
        return bump({ ...state, surface: "tree", scrollOffset: 0 });
      }
      if (state.surface === "focus") {
        return bump({ ...state, surface: "tree", focusId: null, scrollOffset: 0 });
      }
      if (state.surface === "health") {
        return bump({ ...state, surface: "tree", scrollOffset: 0 });
      }
      // tree → quit (component resolves done(null))
      return bump({ ...state });
    }

    case "quit": {
      return bump({ ...state });
    }

    case "cycleProvenance": {
      if (state.searching) return state;
      return bump({ ...state, provFilter: provenanceCycleNext(state.provFilter), scrollOffset: 0 });
    }

    case "toggleInternals": {
      if (state.searching) return state;
      return bump({ ...state, showInternals: !state.showInternals, scrollOffset: 0 });
    }

    case "focus": {
      if (state.searching) return state;
      if (!state.selectedId) return state;
      return bump({ ...state, surface: "focus", focusId: state.selectedId, scrollOffset: 0 });
    }

    case "focusExit": {
      return bump({ ...state, surface: "tree", focusId: null, scrollOffset: 0 });
    }

    case "surfaceTree": {
      if (state.searching) return state;
      return bump({ ...state, surface: "tree", scrollOffset: 0 });
    }

    case "surfaceHealth": {
      if (state.searching) return state;
      return bump({ ...state, surface: "health", scrollOffset: 0 });
    }

    case "refresh": {
      return bump({ ...state, refreshing: true });
    }

    case "refreshDone": {
      return bump({ ...state, refreshing: false });
    }

    case "toggleHelp": {
      if (state.searching) return state;
      return bump({ ...state, helpOpen: !state.helpOpen });
    }

    default:
      return state;
  }
}

/**
 * Merge explorer state across a refresh (design §6): keep the expanded set,
 * filter, surface, and selected node id. A selected/expanded id that no
 * longer exists drops out; selection falls back to the first root.
 */
export function mergeAfterRefresh(prev: ExplorerState, nextRoots: readonly string[]): ExplorerState {
  let selectedId = prev.selectedId;
  if (selectedId !== null && !nextRoots.includes(selectedId)) {
    // selectedId may be a non-root; the component re-resolves it against the
    // new tree rows. Roots fallback only when it is null.
  }
  if (selectedId === null) selectedId = nextRoots[0] ?? null;
  return {
    ...prev,
    refreshing: false,
    selectedId,
    version: prev.version + 1,
    scrollOffset: 0,
  };
}

// Re-export theme helpers some tests reach for.
export { provenanceStyle, type ProvenanceStyle };