import type { GraphPayload, NoteSearchHit, WireGraphNode, WireNodeKind } from "../../shared/wire";

export type SearchResultKind = "note" | "node";

export interface SearchResult {
  readonly id: string;
  readonly kind: SearchResultKind;
  readonly label: string;
  readonly detail: string;
  readonly badge: string;
  readonly score: number;
}

export const MAX_RESULTS = 20;
export const MAX_EVIDENCE = 10;
export const DEBOUNCE_MS = 140;

export function labelScore(label: string, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const labelLower = label.toLowerCase();
  const index = labelLower.indexOf(q);
  if (index < 0) return 0;
  if (labelLower === q) return 100;
  if (index === 0) return 70;
  return /[a-z0-9]/.test(labelLower.charAt(index - 1)) ? 30 : 50;
}

export function evidenceScore(score: number): number {
  return Math.min(Math.max(score, 0), MAX_EVIDENCE) * 2;
}

export function noteNodeId(slug: string): string {
  return `note:${slug}`;
}

export function noteScore(hit: NoteSearchHit, query: string): number {
  return labelScore(hit.summary.title, query) + evidenceScore(hit.score);
}

export function nodeScore(node: WireGraphNode, query: string): number {
  return labelScore(node.label, query);
}

export const NODE_DETAIL_KEYS: readonly string[] = ["path", "manifest", "url", "slug"];

export function nodeDetail(node: WireGraphNode): string {
  for (const key of NODE_DETAIL_KEYS) {
    const value = node.detail[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

export function nodeBadge(kind: WireNodeKind): string {
  return kind;
}

export function compareResults(a: SearchResult, b: SearchResult): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.kind !== b.kind) return a.kind === "note" ? -1 : 1;
  return a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
}

export function mergeResults(
  hits: readonly NoteSearchHit[],
  hitQuery: string,
  nodes: readonly WireGraphNode[],
  nodeQuery: string,
): SearchResult[] {
  const byId = new Map<string, SearchResult>();
  for (const hit of hits) {
    const id = noteNodeId(hit.summary.slug);
    byId.set(id, { id, kind: "note", label: hit.summary.title, detail: hit.snippet, badge: "note", score: noteScore(hit, hitQuery) });
  }
  for (const node of nodes) {
    if (byId.has(node.id)) continue;
    const score = nodeScore(node, nodeQuery);
    if (score) byId.set(node.id, { id: node.id, kind: "node", label: node.label, detail: nodeDetail(node), badge: nodeBadge(node.kind), score });
  }
  return [...byId.values()].sort(compareResults).slice(0, MAX_RESULTS);
}

export interface SearchState {
  readonly query: string;
  readonly answered: string;
  readonly hits: readonly NoteSearchHit[];
  readonly cursor: number;
  readonly loading: boolean;
  readonly failed: boolean;
}

export function initialSearchState(): SearchState {
  return { query: "", answered: "", hits: [], cursor: 0, loading: false, failed: false };
}

export function clampCursor(cursor: number, count: number): number {
  return count <= 0 ? 0 : Math.min(Math.max(cursor, 0), count - 1);
}

export function wrapCursor(cursor: number, delta: number, count: number): number {
  return count <= 0 ? 0 : (((cursor + delta) % count) + count) % count;
}

export function resultIdAt(results: readonly SearchResult[], index: number | null): string | null {
  return index === null ? null : (results[index]?.id ?? null);
}

export interface SearchKeyResult {
  readonly cursor: number;
  readonly activate: number | null;
  readonly dismiss: boolean;
  readonly handled: boolean;
}

export function searchKey(cursor: number, key: string, count: number): SearchKeyResult {
  const unchanged = { cursor, activate: null, dismiss: false, handled: false } as const;
  const here = clampCursor(cursor, count);
  if (key === "ArrowDown") return { ...unchanged, cursor: wrapCursor(here, 1, count), handled: true };
  if (key === "ArrowUp") return { ...unchanged, cursor: wrapCursor(here, -1, count), handled: true };
  if (key === "Home") return { ...unchanged, cursor: 0, handled: true };
  if (key === "End") return { ...unchanged, cursor: clampCursor(count - 1, count), handled: true };
  if (key === "Escape") return { ...unchanged, dismiss: true, handled: true };
  if (key !== "Enter" || count === 0) return unchanged;
  return { ...unchanged, cursor: here, activate: here, dismiss: true, handled: true };
}

export const PALETTE_TITLE = "Search the workspace";
export const PALETTE_PLACEHOLDER = "Search notes and repository…";
export const PALETTE_HINT = "↑↓ move · ↵ open · esc close";

export function searchStatus(state: SearchState, count: number): string | null {
  if (!state.query.trim()) return "Type to search notes, modules, files and entry points.";
  if (count > 0) return null;
  if (state.failed) return "search failed — the workspace server may be gone";
  if (state.loading) return "searching…";
  return `no matches for “${state.query.trim()}”`;
}

export function resultCountLabel(count: number): string {
  return count === 1 ? "1 result" : `${count} results`;
}

export interface SearchRowView extends SearchResult {
  readonly active: boolean;
  readonly domId: string;
}

export interface PaletteModel {
  readonly rows: readonly SearchRowView[];
  readonly status: string | null;
  readonly count: number;
  readonly countLabel: string;
  readonly cursor: number;
  readonly activeDomId: string | null;
}

export function rowDomId(index: number): string {
  return `weave-search-row-${index}`;
}

export function paletteModel(state: SearchState, payload: GraphPayload | null): PaletteModel {
  const results = mergeResults(state.hits, state.answered, payload?.model.nodes ?? [], state.query);
  const cursor = clampCursor(state.cursor, results.length);
  const rows = results.map((result, index) => ({ ...result, active: index === cursor, domId: rowDomId(index) }));
  return { rows, status: searchStatus(state, results.length), count: results.length, countLabel: resultCountLabel(results.length), cursor, activeDomId: results.length ? rowDomId(cursor) : null };
}
