/**
 * treeRows — the portable Explore/tree view-model (weave-workspace §3).
 *
 * Ported 1:1 from the retired browser page's `listTree`. Pure: it takes a
 * `GraphModel` plus a `TreeState` and returns rows. No renderer concepts —
 * no widths, no truncation, no escape codes. Both the TUI and the browser
 * workspace build their tree column from this.
 */

import type { GraphModel, GraphNode, NodeKind } from "../graph/model";
import type { NoteSource } from "../types";
import type { SelectableRow, TreeMeta } from "./types";

/** One row in the Explore tree. */
export interface TreeRow extends SelectableRow {
  depth: number;
  hasKids: boolean;
  expanded: boolean;
  label: string;
  kind: NodeKind;
  provenance: NoteSource | null;
  /** Structured trailing annotation; renderers format it (see formatTreeMeta). */
  meta: TreeMeta;
}

export interface TreeState {
  /** Expanded node ids (when no filter is active). */
  expanded: ReadonlySet<string>;
  /** Reveal repo plumbing (gitState/external/package/entryPoint). */
  showInternals: boolean;
  /** Provenance filter (null = all). */
  provFilter: NoteSource | null;
  /** Substring filter on node labels (case-insensitive). */
  query: string;
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
  // The caller only invokes this for entryPoint nodes, so the path guard suffices.
  const moduleFor = (entry: GraphNode): string | null => {
    if (!entry.detail.path) return null;
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
    const m = moduleFor(n);
    if (m) {
      const list = moduleEntries.get(m);
      if (list) list.push(n.id);
      else moduleEntries.set(m, [n.id]);
    }
  }

  const roots = model.nodes.filter((n) => !incoming.has(n.id)).map((n) => n.id);
  return { byId, contains, tree, incoming, moduleEntries, roots };
}

/** The roots of a graph (nodes with no incoming contains/anchored-at edge). */
export function graphRoots(model: GraphModel): string[] {
  const incoming = new Set<string>();
  for (const e of model.edges) {
    if (e.kind === "contains" || e.kind === "anchored-at") incoming.add(e.target);
  }
  return model.nodes.filter((n) => !incoming.has(n.id)).map((n) => n.id);
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

/** A `count` meta when the detail value is numeric, else a verbatim `text`
 *  meta — so a hand-built or corrupt graph still displays what it holds. */
function countMeta(raw: string, unit: string, phrasing: "attribute" | "prose"): TreeMeta {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return { kind: "text", text: phrasing === "attribute" ? `${unit}=${raw}` : `${raw} ${unit}` };
  }
  return { kind: "count", n, unit, phrasing };
}

function metaFor(node: GraphNode): TreeMeta {
  switch (node.kind) {
    case "note":
      return node.detail.updated ? { kind: "relTime", iso: node.detail.updated } : null;
    case "module":
      return node.detail.files ? countMeta(node.detail.files, "files", "attribute") : null;
    case "gitState":
      return node.detail.commit ? { kind: "commit", sha: node.detail.commit } : null;
    case "repository":
      return node.detail.files ? countMeta(node.detail.files, "files", "prose") : null;
    case "package":
      return node.detail.kind ? { kind: "text", text: node.detail.kind } : null;
    case "entryPoint":
      return node.detail.summary ? { kind: "text", text: "summary" } : null;
    default:
      return null;
  }
}

/**
 * Build the Explore tree rows (port of the page's `listTree`).
 *
 * - Roots: `vault`, `repository` (nodes with no incoming containment edge).
 * - Entry points nest under their prefix module.
 * - Internals hidden by default; the caller toggles `showInternals`.
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
    // Skip kids absent from the node set (corrupt/hand-built graphs): the page
    // never produces these, but a defensive filter keeps the tree robust.
    all = all.filter((k) => byId.has(k));
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
    const node = byId.get(id)!;
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
    const node = byId.get(id)!;
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
      meta: metaFor(node),
    });
    if (expanded) for (const k of visibleKids) walk(k, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return rows;
}

/** Empty-state hint for the tree surface (weave-view-tui-design §5.1). */
export function treeEmptyHint(model: GraphModel): string | null {
  const vault = model.nodes.find((n) => n.kind === "vault");
  if (!vault) return null;
  // no notes and no repository
  const hasNotes = model.nodes.some((n) => n.kind === "note");
  const hasRepo = model.nodes.some((n) => n.kind === "repository");
  if (!hasNotes && !hasRepo) return "no notes yet — add one with the weave_note tool";
  return null;
}
