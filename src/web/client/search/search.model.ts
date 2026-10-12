import type { GraphPayload, NoteSearchHit, WireGraphNode } from "../../shared/wire";
import { relTime } from "../../shared/view";
import { ICONS } from "../shell/icons.model";
import type { IconDef, IconName } from "../shell/icons.model";

/**
 * The ⌘K palette's decisions: what matched, which group it belongs to, how a
 * scope narrows it, what a row says, and what a key does.
 *
 * `SearchPalette.tsx` renders these and nothing else. Results come from two
 * places: the server's note search (`/api/search`, notes only) and the graph
 * payload the palette already holds, which supplies repository nodes, vault
 * folders and artifacts by label, plus the tag index. Tags are not searchable
 * on the server, so tag hits are derived here from `GraphPayload.tags`, and a
 * query that starts with `#` is a tag query answered from the payload alone.
 */

export type SearchResultKind = "note" | "node" | "tag";

/** The three result groups, in display order. */
export type SearchGroup = "notes" | "code" | "tags";

/** A scope narrows the list to one group, or shows them all. */
export type SearchScope = "all" | SearchGroup;

/** A result's icon: a sprite glyph, or the palette's own tag glyph. */
export type SearchIcon = IconName | "tag";

export interface SearchResult {
  readonly id: string;
  readonly kind: SearchResultKind;
  readonly group: SearchGroup;
  readonly icon: SearchIcon;
  readonly label: string;
  /** Raw text the snippet is cut from: a search snippet, a preview, a path. */
  readonly detail: string;
  /** What the thing is, in words; the right-hand meta for code rows. */
  readonly badge: string;
  readonly score: number;
  /** Vault-relative path for notes and artifacts, `""` otherwise. */
  readonly path: string;
  /** ISO time of the last change, `""` when unknown. */
  readonly updated: string;
}

export const MAX_RESULTS = 20;
export const MAX_EVIDENCE = 10;
export const DEBOUNCE_MS = 140;

export const SEARCH_GROUPS: readonly SearchGroup[] = ["notes", "code", "tags"];
export const SEARCH_SCOPES: readonly SearchScope[] = ["all", ...SEARCH_GROUPS];
export const SCOPE_LABELS: Readonly<Record<SearchScope, string>> = { all: "All", notes: "Notes", code: "Code", tags: "Tags" };

/** Id prefixes of the vault-side nodes the graph builder emits besides notes. */
export const VAULT_ID_PREFIXES: readonly string[] = ["note:", "vfolder:", "artifact:"];

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

/** Prose a node carries, preferred over its locator as snippet text. */
export const NODE_TEXT_KEYS: readonly string[] = ["preview", "summary", "description"];

/** The text a node row's snippet is cut from; empty when it would only repeat the label. */
export function nodeText(node: WireGraphNode): string {
  for (const key of NODE_TEXT_KEYS) {
    const value = node.detail[key];
    if (typeof value === "string" && value) return value;
  }
  const detail = nodeDetail(node);
  return detail === node.label ? "" : detail;
}

const KIND_WORDS: Readonly<Record<string, string>> = {
  entryPoint: "entry point",
  gitState: "git",
  external: "remote",
};

/** A node's kind in words. Vault folders and artifacts are named for what they are, not the kind they reuse. */
export function nodeBadge(node: WireGraphNode): string {
  if (node.id.startsWith("vfolder:")) return "folder";
  if (node.id.startsWith("artifact:")) return "artifact";
  return KIND_WORDS[node.kind] ?? node.kind;
}

/** Notes for everything in the vault, code for everything in the repository. */
export function nodeGroup(node: WireGraphNode): SearchGroup {
  if (node.kind === "vault") return "notes";
  return VAULT_ID_PREFIXES.some((prefix) => node.id.startsWith(prefix)) ? "notes" : "code";
}

function nodePath(node: WireGraphNode): string {
  if (node.id.startsWith("note:")) return node.id.slice("note:".length);
  return node.id.startsWith("artifact:") ? node.id.slice("artifact:".length) : "";
}

export function compareResults(a: SearchResult, b: SearchResult): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.kind !== b.kind) return a.kind === "note" ? -1 : 1;
  return a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
}

// --- tags ------------------------------------------------------------------------

/** The tag a `#` query asks for (possibly `""`), or `null` for an ordinary query. */
export function tagQuery(query: string): string | null {
  const q = query.trim();
  return q.startsWith("#") ? q.slice(1).trim() : null;
}

/** What to ask the server; `""` means do not ask (no query, or a tag query the payload answers). */
export function serverQuery(query: string): string {
  return tagQuery(query) === null ? query.trim() : "";
}

export function noteCountLabel(count: number): string {
  return count === 1 ? "1 note" : `${count} notes`;
}

/**
 * Tag hits from the payload's tag index. A bare `#` lists every tag; any other
 * query ranks by the tag name. Equal scores keep the index's order, which is
 * count descending (§4.3), so popular tags come first.
 */
export function tagResults(tags: Readonly<Record<string, readonly string[]>>, query: string): SearchResult[] {
  const tag = tagQuery(query);
  const out: SearchResult[] = [];
  for (const [name, slugs] of Object.entries(tags)) {
    const score = tag === "" ? 1 : labelScore(name, tag ?? query);
    if (score) out.push({ id: `tag:${name}`, kind: "tag", group: "tags", icon: "tag", label: `#${name}`, detail: noteCountLabel(slugs.length), badge: "tag", score, path: "", updated: "" });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** slug → the best score of any matching tag it carries. */
export function taggedSlugs(tags: Readonly<Record<string, readonly string[]>>, tag: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const [name, slugs] of Object.entries(tags)) {
    const score = labelScore(name, tag);
    if (!score) continue;
    for (const slug of slugs) out.set(slug, Math.max(score, out.get(slug) ?? 0));
  }
  return out;
}

// --- merging -----------------------------------------------------------------------

function noteResult(hit: NoteSearchHit, query: string): SearchResult {
  const { slug, title, updated } = hit.summary;
  return { id: noteNodeId(slug), kind: "note", group: "notes", icon: "note", label: title, detail: hit.snippet, badge: "note", score: noteScore(hit, query), path: slug, updated };
}

function nodeResult(node: WireGraphNode, score: number): SearchResult {
  return {
    id: node.id,
    kind: "node",
    group: nodeGroup(node),
    icon: node.kind,
    label: node.label,
    detail: nodeText(node),
    badge: nodeBadge(node),
    score,
    path: nodePath(node),
    updated: node.detail["updated"] ?? "",
  };
}

/**
 * Every result, grouped (notes, code, tags) and ranked within each group,
 * each group capped at {@link MAX_RESULTS}.
 *
 * A `#` query skips label matching: its notes are the ones carrying a
 * matching tag, and nothing from the repository matches a tag.
 */
export function mergeResults(
  hits: readonly NoteSearchHit[],
  hitQuery: string,
  nodes: readonly WireGraphNode[],
  nodeQuery: string,
  tags: Readonly<Record<string, readonly string[]>> = {},
): SearchResult[] {
  const tag = tagQuery(nodeQuery);
  const tagged = tag ? taggedSlugs(tags, tag) : new Map<string, number>();
  const byId = new Map<string, SearchResult>();
  for (const hit of hits) {
    const result = noteResult(hit, hitQuery);
    byId.set(result.id, result);
  }
  for (const node of nodes) {
    if (byId.has(node.id)) continue;
    const score = tag === null ? nodeScore(node, nodeQuery) : (node.kind === "note" ? tagged.get(nodePath(node)) ?? 0 : 0);
    if (score) byId.set(node.id, nodeResult(node, score));
  }
  const ranked = [...byId.values()].sort(compareResults);
  const inGroup = (group: SearchGroup): SearchResult[] => ranked.filter((result) => result.group === group).slice(0, MAX_RESULTS);
  return [...inGroup("notes"), ...inGroup("code"), ...tagResults(tags, nodeQuery).slice(0, MAX_RESULTS)];
}

// --- snippets ----------------------------------------------------------------------

/**
 * `**TLDR:**` and its spellings, as the notepad skill writes it at the top of
 * a finalized note. It must read as a label, bold or followed by a colon, so
 * prose that merely mentions a TLDR is not mistaken for one.
 */
const TLDR_RE = /(?:\*\*|__)TL;?DR[ \t]*:?[ \t]*(?:\*\*|__)[ \t]*:?|\bTL;?DR[ \t]*:/i;

/**
 * The TLDR in a piece of note text, or `null`.
 *
 * It runs to the first blank line or heading. Server snippets have their
 * whitespace collapsed, so the heading is often the only boundary left; the
 * row ellipsizes whatever follows anyway.
 */
export function tldrOf(text: string): string | null {
  const match = TLDR_RE.exec(text);
  if (match === null) return null;
  const rest = text.slice(match.index + match[0].length);
  const end = rest.search(/\n[ \t]*\n|(?:^|\s)#{1,6}\s/);
  const tldr = (end < 0 ? rest : rest.slice(0, end)).trim();
  return tldr === "" ? null : tldr;
}

const CODE_MARK = "\u0000";

/**
 * Markdown as one line of plain text, for a snippet.
 *
 * Server snippets are cut out of a body and have their whitespace collapsed,
 * so this works on fragments: wikilinks and emphasis may be cut at either end,
 * and line-start syntax (headings, bullets) can sit mid-line. Code spans are
 * set aside first so their contents are never read as emphasis.
 */
export function plainText(markdown: string): string {
  const code: string[] = [];
  return markdown
    .replace(/`{3,}[^\s`]*/g, " ")
    .replace(/`([^`\n]*)`/g, (_match, text: string) => `${CODE_MARK}${code.push(text) - 1}${CODE_MARK}`)
    .replace(/!?\[\[([^\][|]+)(?:\|([^\]]*))?\]\]/g, (_match, target: string, alias: string | undefined) => (alias || target).trim())
    .replace(/^(…?)(?:[^[\]|]*\|)?([^[\]]*)\]\]/, "$1$2")
    .replace(/\[\[([^\]|]*)(?:\|([^\]]*))?$/, (_match, target: string, alias: string | undefined) => alias || target)
    .replace(/\[\[|\]\]/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/(^|\s)#{1,6}(?=\s)/g, "$1")
    .replace(/(^|\n)[ \t]*>[ \t]?/g, "$1")
    .replace(/(^|\s)([-*_])(?:[ \t]?\2){2,}(?=\s|$)/g, "$1")
    .replace(/(^|\s)[-*+][ \t]+\[[ xX]\][ \t]*/g, "$1")
    .replace(/(^|\n)[ \t]*(?:[-*+]|\d+[.)])[ \t]+/g, "$1")
    .replace(/(\s)\*(?=\s)/g, "$1")
    .replace(/(\*\*|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, "$1$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1$2")
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1$2")
    .replace(/\*{2,}|~~/g, "")
    .replace(/\\([\\`*_#[\]|])/g, "$1")
    .replace(new RegExp(`${CODE_MARK}(\\d+)${CODE_MARK}`, "g"), (_match, at: string) => code[Number(at)] as string)
    .replace(/\s+/g, " ")
    .trim();
}

/** The text a snippet shows: the note's TLDR when the text has one, else the text itself. */
export function snippetText(raw: string): string {
  return plainText(tldrOf(raw) ?? raw);
}

/** Shorter query words are too common to be worth marking. */
export const MIN_TERM = 2;

/** What to mark: the whole query, and each of its words. A leading `#` is a tag sigil, not text. */
export function highlightTerms(query: string): string[] {
  const q = query.trim().replace(/^#/, "").trim();
  if (!q) return [];
  return [...new Set([q, ...q.split(/\s+/).filter((word) => word.length >= MIN_TERM)])];
}

export type MatchRange = readonly [start: number, end: number];

/** Case-insensitive matches of the query in `text`, sorted and merged. */
export function matchRanges(text: string, query: string): MatchRange[] {
  const found: Array<[number, number]> = [];
  for (const term of highlightTerms(query)) {
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    for (const match of text.matchAll(re)) found.push([match.index, match.index + match[0].length]);
  }
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const range of found) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push(range);
  }
  return merged;
}

export interface SnippetPart {
  readonly text: string;
  readonly mark: boolean;
}

/** A first match further in than this is brought forward, so the row's ellipsis cannot hide it. */
export const SNIPPET_LEAD = 40;
/** How much text is kept before a match that was brought forward. */
export const SNIPPET_CONTEXT = 16;

/** Split `text` at `ranges` into plain and marked parts. */
export function toParts(text: string, ranges: readonly MatchRange[]): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push({ text: text.slice(at, start), mark: false });
    parts.push({ text: text.slice(start, end), mark: true });
    at = end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), mark: false });
  return parts;
}

/**
 * The snippet a row shows, as parts to mark up.
 *
 * Markdown is reduced to plain text, a TLDR is preferred, and when the first
 * match sits past {@link SNIPPET_LEAD} the text before it is cut back to a
 * word boundary {@link SNIPPET_CONTEXT} characters ahead of it, behind a `…`.
 */
export function snippetParts(raw: string, query: string): SnippetPart[] {
  const text = snippetText(raw);
  const ranges = matchRanges(text, query);
  const first = ranges[0];
  if (first === undefined || first[0] <= SNIPPET_LEAD) return toParts(text, ranges);
  const cut = first[0] - SNIPPET_CONTEXT;
  const space = text.indexOf(" ", cut);
  const from = space >= 0 && space < first[0] ? space + 1 : cut;
  const shift = from - 1;
  return toParts(`…${text.slice(from)}`, ranges.map(([start, end]) => [start - shift, end - shift] as const));
}

// --- row labels ----------------------------------------------------------------------

/** The folder a vault path sits in, `""` at the top level. */
export function folderOf(path: string): string {
  return path.split("/").slice(0, -1).join("/");
}

/** A compact age: `2h`, `3d`, `just now`. */
export function ageLabel(iso: string, now: number): string {
  return relTime(iso, now).replace(/ ago$/, "");
}

/**
 * The muted text at a row's right edge: `folder · age` for notes and
 * artifacts, the kind for anything else. Code would show `line N`, but the
 * graph carries no line numbers, so code rows name their kind instead.
 * Tag rows carry their note count in the snippet and need none.
 */
export function resultMeta(result: SearchResult, now: number): string {
  if (result.kind === "tag") return "";
  if (!result.updated) return result.badge;
  return [folderOf(result.path), ageLabel(result.updated, now)].filter((part) => part !== "").join(" · ");
}

/** The magnifier at the head of the input row. */
export const SEARCH_GLYPH: IconDef = { d: ["M11.25 7a4.25 4.25 0 1 1-8.5 0 4.25 4.25 0 0 1 8.5 0Z", "M10.25 10.25 13.5 13.5"], filled: false };
/** A luggage tag with its eyelet, for tag rows. */
export const TAG_GLYPH: IconDef = { d: ["M2.75 2.75h5l5.5 5.5-5 5-5.5-5.5Z", "M5.5 5.5h.01"], filled: false };

export function iconDef(icon: SearchIcon): IconDef {
  return icon === "tag" ? TAG_GLYPH : ICONS[icon];
}

// --- state and keys ------------------------------------------------------------------

export interface SearchState {
  readonly query: string;
  readonly answered: string;
  readonly hits: readonly NoteSearchHit[];
  readonly cursor: number;
  readonly scope: SearchScope;
  readonly loading: boolean;
  readonly failed: boolean;
}

export function initialSearchState(): SearchState {
  return { query: "", answered: "", hits: [], cursor: 0, scope: "all", loading: false, failed: false };
}

export function clampCursor(cursor: number, count: number): number {
  return count <= 0 ? 0 : Math.min(Math.max(cursor, 0), count - 1);
}

export function wrapCursor(cursor: number, delta: number, count: number): number {
  return count <= 0 ? 0 : (((cursor + delta) % count) + count) % count;
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

export type ScopeCounts = Readonly<Record<SearchScope, number>>;

export function scopeCounts(results: readonly SearchResult[]): ScopeCounts {
  const count = (group: SearchGroup): number => results.filter((result) => result.group === group).length;
  return { all: results.length, notes: count("notes"), code: count("code"), tags: count("tags") };
}

/** All, then every group that has results. */
export function visibleScopes(counts: ScopeCounts): SearchScope[] {
  return SEARCH_SCOPES.filter((scope) => scope === "all" || counts[scope] > 0);
}

/** The chosen scope while it has results; All once it has none. */
export function effectiveScope(scope: SearchScope, counts: ScopeCounts): SearchScope {
  return visibleScopes(counts).includes(scope) ? scope : "all";
}

/** The next visible scope after `scope` (Tab), or before it (Shift+Tab), wrapping. */
export function cycleScope(visible: readonly SearchScope[], scope: SearchScope, backwards: boolean): SearchScope {
  return visible[wrapCursor(Math.max(visible.indexOf(scope), 0), backwards ? -1 : 1, visible.length)] ?? "all";
}

export const PALETTE_TITLE = "Search the workspace";
export const PALETTE_PLACEHOLDER = "Search notes and repository…";
export const PALETTE_HINT = "↑↓ move · ↵ open · ⌘↵ open in new tab · Tab scope";
export const SCOPE_GROUP_LABEL = "Search scope";
export const LIGHT_UP_KEY = "⇧↵";

export function lightUpLabel(count: number): string {
  return `Light up ${count} in the graph`;
}

export function searchStatus(state: SearchState, count: number): string | null {
  if (!state.query.trim()) return "Type to search notes and code. Start with # to find tags.";
  if (count > 0) return null;
  if (state.failed) return "search failed — the workspace server may be gone";
  if (state.loading) return "searching…";
  return `no matches for “${state.query.trim()}”`;
}

// --- the view ------------------------------------------------------------------------

export interface SearchRowView {
  readonly id: string;
  readonly kind: SearchResultKind;
  readonly group: SearchGroup;
  readonly label: string;
  readonly icon: IconDef;
  /** Paths read better in the mono face. */
  readonly mono: boolean;
  readonly parts: readonly SnippetPart[];
  readonly meta: string;
  readonly active: boolean;
  readonly domId: string;
  /** Position in the flat list the arrow keys walk. */
  readonly index: number;
}

export interface SearchGroupView {
  readonly group: SearchGroup;
  /** `Notes · 4`; the sheet sets it in capitals. */
  readonly heading: string;
  readonly domId: string;
  readonly rows: readonly SearchRowView[];
}

export interface ScopeView {
  readonly scope: SearchScope;
  readonly label: string;
  readonly count: number;
  readonly active: boolean;
}

export interface PaletteModel {
  readonly groups: readonly SearchGroupView[];
  /** The visible rows as one list, across groups. */
  readonly rows: readonly SearchRowView[];
  /** Empty while there is no query. */
  readonly scopes: readonly ScopeView[];
  readonly scope: SearchScope;
  readonly status: string | null;
  readonly count: number;
  readonly cursor: number;
  readonly activeDomId: string | null;
  /** The trimmed query. */
  readonly query: string;
  /** Results that are graph nodes, whatever the scope: what lighting up would show. */
  readonly lightUp: number;
}

export function rowDomId(index: number): string {
  return `weave-search-row-${index}`;
}

export function groupDomId(group: SearchGroup): string {
  return `weave-search-group-${group}`;
}

export function rowView(result: SearchResult, index: number, cursor: number, query: string, now: number): SearchRowView {
  return {
    id: result.id,
    kind: result.kind,
    group: result.group,
    label: result.label,
    icon: iconDef(result.icon),
    mono: result.group === "code",
    parts: snippetParts(result.detail, query),
    meta: resultMeta(result, now),
    active: index === cursor,
    domId: rowDomId(index),
    index,
  };
}

export function paletteModel(state: SearchState, payload: GraphPayload | null, now: number): PaletteModel {
  const query = state.query.trim();
  const results = mergeResults(state.hits, state.answered, payload?.model.nodes ?? [], state.query, payload?.tags ?? {});
  const counts = scopeCounts(results);
  const scope = effectiveScope(state.scope, counts);
  const visible = scope === "all" ? results : results.filter((result) => result.group === scope);
  const cursor = clampCursor(state.cursor, visible.length);
  const rows = visible.map((result, index) => rowView(result, index, cursor, state.query, now));
  const groups = SEARCH_GROUPS.flatMap((group) => {
    const inGroup = rows.filter((row) => row.group === group);
    return inGroup.length ? [{ group, heading: `${SCOPE_LABELS[group]} · ${inGroup.length}`, domId: groupDomId(group), rows: inGroup }] : [];
  });
  const scopes = query ? visibleScopes(counts).map((each) => ({ scope: each, label: SCOPE_LABELS[each], count: counts[each], active: each === scope })) : [];
  return {
    groups,
    rows,
    scopes,
    scope,
    status: searchStatus(state, visible.length),
    count: visible.length,
    cursor,
    activeDomId: rows.length ? rowDomId(cursor) : null,
    query,
    lightUp: results.filter((result) => result.kind !== "tag").length,
  };
}

// --- intents -------------------------------------------------------------------------

/** What a key, click or hover asks the palette to do. */
export type PaletteIntent =
  | { readonly type: "none" }
  | { readonly type: "move"; readonly cursor: number }
  | { readonly type: "scope"; readonly scope: SearchScope }
  | { readonly type: "open"; readonly id: string; readonly newTab: boolean }
  | { readonly type: "tag"; readonly query: string }
  | { readonly type: "lightUp"; readonly query: string }
  | { readonly type: "close" };

export const NO_INTENT: PaletteIntent = { type: "none" };

/**
 * Activating a row. A note or node opens; a tag has nothing to open, so it
 * becomes a `#tag` query, which lists the notes carrying it.
 */
export function rowIntent(row: Pick<SearchRowView, "id" | "kind">, newTab: boolean): PaletteIntent {
  return row.kind === "tag" ? { type: "tag", query: `#${row.id.slice("tag:".length)}` } : { type: "open", id: row.id, newTab };
}

/** Lighting up the results, when there is a query and something to light. */
export function lightUpIntent(model: Pick<PaletteModel, "query" | "lightUp">): PaletteIntent {
  return model.query && model.lightUp > 0 ? { type: "lightUp", query: model.query } : NO_INTENT;
}

export interface PaletteKeyInput {
  readonly key: string;
  readonly shift: boolean;
  /** ⌘ or Ctrl. */
  readonly mod: boolean;
  /** The query input has focus. */
  readonly inInput: boolean;
}

/**
 * One key, as an intent.
 *
 * Tab and Shift+Tab cycle the scope while the input has focus and there is
 * more than one scope to cycle; otherwise they are left to the focus trap.
 * Shift+Enter lights the results up in the graph when the shell offers that,
 * and ⌘/Ctrl+Enter opens in a new tab.
 */
export function paletteKey(model: PaletteModel, input: PaletteKeyInput, canLightUp: boolean): PaletteIntent {
  if (input.key === "Tab") {
    if (!input.inInput || input.mod || model.scopes.length < 2) return NO_INTENT;
    return { type: "scope", scope: cycleScope(model.scopes.map((each) => each.scope), model.scope, input.shift) };
  }
  if (input.key === "Enter" && input.shift && canLightUp) return lightUpIntent(model);
  const next = searchKey(model.cursor, input.key, model.count);
  if (!next.handled) return NO_INTENT;
  if (next.activate !== null) return rowIntent(model.rows[next.activate] as SearchRowView, input.mod);
  return next.dismiss ? { type: "close" } : { type: "move", cursor: next.cursor };
}

/** The state after an intent that keeps the palette open. */
export function nextState(state: SearchState, intent: PaletteIntent): SearchState {
  // A hover reports a move on every mouse event; an unchanged cursor keeps the state, so it renders nothing.
  if (intent.type === "move") return intent.cursor === state.cursor ? state : { ...state, cursor: intent.cursor };
  if (intent.type === "scope") return { ...state, scope: intent.scope, cursor: 0 };
  if (intent.type === "tag") return { ...state, query: intent.query, scope: "notes", cursor: 0 };
  return state;
}

/** Whether an intent ends with the palette closed. */
export function closesPalette(intent: PaletteIntent): boolean {
  return intent.type === "open" || intent.type === "lightUp" || intent.type === "close";
}
