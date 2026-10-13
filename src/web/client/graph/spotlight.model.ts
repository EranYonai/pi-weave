/**
 * The graph spotlight: light up the nodes a query names (UI refresh, G1).
 *
 * Type a word into the field floating over the graph and the nodes it names
 * stay at full strength, grow and carry their labels while everything else
 * drops back to faint dots; the lines *between* lit nodes light up too. A side
 * sheet explains the node you are looking at, including why it lit.
 *
 * Everything the feature decides lives here, for §10's reason: the column
 * component is a canvas plus a few overlays, and a branch inside a `.tsx` is a
 * branch no test can reach. What this module answers:
 *
 * - {@link spotlightOf} — which nodes a query lights, and why each one did.
 * - {@link litOnCanvas} — the same set in terms of what is *drawn*, so a lit
 *   note inside a collapsed folder lights the folder standing in for it.
 * - {@link graphSheet} — the side sheet's content for the previewed node.
 * - {@link spotlightEscapes} — whether `Esc` clears the query or falls through
 *   to the shell's existing "clear selection".
 *
 * The rendering itself is not here: the lit set is handed to the renderer's
 * ordinary `setHighlight` with the `spotlight` style (`graph.model.ts`), the
 * same path and the same fade a selection's neighbourhood takes.
 *
 * ## Tier rules (§2)
 *
 * `src/web/client/**`: wire types from `../../shared/wire`, core view-models
 * only through `../../shared/view`. No DOM type is named, so the root
 * `tsconfig.json` compiles the tests.
 */

import { relTime } from "../../shared/view";
import type { GraphPayload, WireGraphEdge, WireGraphNode, WireNoteSource } from "../../shared/wire";
import { excerptOf, stripMarkdown } from "../note/note.model";
import type { IconName } from "../shell/icons.model";
import { provenanceGlyph, provenanceTitle } from "../tree/tree.model";
import { graphPreview } from "./column.model";

// --- copy ------------------------------------------------------------------------------

/** The field's placeholder: what the spotlight can find, in the order people look. */
export const SPOTLIGHT_PLACEHOLDER = "Light up notes, tags or code";

/** The field's accessible name. */
export const SPOTLIGHT_LABEL = "Light up in graph";

/** The clear control's label and hint — it is also what `Esc` does. */
export const SPOTLIGHT_CLEAR = "Esc";
export const SPOTLIGHT_CLEAR_HINT = "Clear the spotlight (Esc)";

/** The legend while a spotlight is up, replacing the neighbourhood's. */
export const SPOTLIGHT_LEGEND = { lit: "lit", dimmed: "not lit" } as const;

/**
 * Why a node lit when only the search palette found it: its words are in the
 * note's text, which the graph payload does not carry.
 */
export const SEARCH_REASON = "search match";

/** The count chip: `5 lit`, or a plain sentence when nothing matched. */
export function litLabel(count: number): string {
  return count === 0 ? "no matches" : `${count} lit`;
}

// --- the query -----------------------------------------------------------------------------

/** One word of a query. */
export interface SpotlightTerm {
  /** Lower-cased, never empty. */
  readonly text: string;
  /** Written as `#word`: matches tags and nothing else. */
  readonly tagOnly: boolean;
}

/**
 * Split a query into terms.
 *
 * Words, not a phrase: `launch draft` lights "Launch post draft", which a
 * substring match on the whole query would miss. A leading `#` makes a term
 * tag-only, the way tags are written everywhere else in the workspace; a bare
 * `#` names nothing and is dropped.
 */
export function spotlightTerms(query: string): SpotlightTerm[] {
  const terms: SpotlightTerm[] = [];
  for (const word of query.toLowerCase().split(/\s+/)) {
    const tagOnly = word.startsWith("#");
    const text = tagOnly ? word.replace(/^#+/, "") : word;
    if (text !== "") terms.push({ text, tagOnly });
  }
  return terms;
}

// --- matching -------------------------------------------------------------------------------

/** A node's matching path: the slug or repo path its id is derived from. */
export function nodePath(node: WireGraphNode): string {
  const fromDetail = node.detail.path ?? node.detail.slug;
  if (typeof fromDetail === "string" && fromDetail !== "") return fromDetail;
  const colon = node.id.indexOf(":");
  return colon === -1 ? "" : node.id.slice(colon + 1);
}

/** Note node id → its tags, from the payload's structured tag index (never `detail.tags`). */
export function tagsByNode(payload: GraphPayload): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [tag, slugs] of Object.entries(payload.tags)) {
    for (const slug of slugs) {
      const id = `note:${slug}`;
      const list = out.get(id);
      if (list === undefined) out.set(id, [tag]);
      else if (!list.includes(tag)) list.push(tag);
    }
  }
  return out;
}

/** The reasons one node matched, or `null` when some term found nothing. */
export function matchReasons(node: WireGraphNode, tags: readonly string[], terms: readonly SpotlightTerm[]): string[] | null {
  const title = node.label.toLowerCase();
  const path = nodePath(node).toLowerCase();
  let byTitle = false;
  let byPath = false;
  const byTag: string[] = [];
  for (const term of terms) {
    const inTitle = !term.tagOnly && title.includes(term.text);
    const tagHits = tags.filter((tag) => tag.toLowerCase().includes(term.text));
    // The path is the weakest reason — a note's slug usually spells its own
    // title — so it is only *named* when nothing better explains the term.
    const inPath = !term.tagOnly && !inTitle && tagHits.length === 0 && path.includes(term.text);
    if (!inTitle && tagHits.length === 0 && !inPath) return null;
    byTitle ||= inTitle;
    byPath ||= inPath;
    for (const tag of tagHits) if (!byTag.includes(tag)) byTag.push(tag);
  }
  // Stable reading order — title, then tags in the index's order, then path —
  // whatever order the words were typed in.
  const ordered = tags.filter((tag) => byTag.includes(tag));
  return [...(byTitle ? ["title"] : []), ...ordered.map((tag) => `tag #${tag}`), ...(byPath ? ["path"] : [])];
}

/** What a query lit. `null` from {@link spotlightOf} means "no spotlight at all". */
export interface Spotlight {
  readonly terms: readonly SpotlightTerm[];
  /** Lit node ids, from the full payload — collapsed nodes included. */
  readonly lit: ReadonlySet<string>;
  /** Lit node id → why it lit: `title`, `tag #x`, `path`, `search match`. */
  readonly reasons: ReadonlyMap<string, readonly string[]>;
  /** How many nodes lit. The chip's number. */
  readonly count: number;
}

/**
 * Light up the nodes a query names.
 *
 * Case-insensitive, word by word: a node lights when **every** term is found
 * in its title, one of its tags or its path. Matching runs over the whole
 * payload rather than the drawn graph, so the count is the same whatever is
 * expanded — {@link litOnCanvas} maps the answer onto the canvas.
 *
 * `found` is what the search palette listed for this same query, when the
 * spotlight came from its "Light up in graph". Search reads note text the
 * payload does not have, so a note it found by a word in its body lights too
 * ({@link SEARCH_REASON}), and the graph never says "no matches" for results
 * the palette just showed. Ids not in the payload are skipped.
 *
 * `null` for an empty (or whitespace, or bare `#`) query: no spotlight, which
 * the column renders as the ordinary graph. A query that matches nothing is
 * *not* `null` — it is an empty set, and the canvas dims entirely, which is
 * the honest picture of "nothing here is called that".
 */
export function spotlightOf(payload: GraphPayload | null, query: string, found: readonly string[] = []): Spotlight | null {
  const terms = spotlightTerms(query);
  if (terms.length === 0) return null;
  const lit = new Set<string>();
  const reasons = new Map<string, readonly string[]>();
  if (payload !== null) {
    const tags = tagsByNode(payload);
    for (const node of payload.model.nodes) {
      if (lit.has(node.id)) continue;
      const why = matchReasons(node, tags.get(node.id) ?? [], terms);
      if (why === null) continue;
      lit.add(node.id);
      reasons.set(node.id, why);
    }
    const searched = new Set(found);
    for (const node of payload.model.nodes) {
      if (lit.has(node.id) || !searched.has(node.id)) continue;
      lit.add(node.id);
      reasons.set(node.id, [SEARCH_REASON]);
    }
  }
  return { terms, lit, reasons, count: lit.size };
}

/**
 * The lit set in terms of what is drawn.
 *
 * A lit node hidden inside a collapsed cluster is not on the canvas, so the
 * cluster representing it lights instead — the same retargeting the
 * neighbourhood highlight relies on (`clusterAggregate`'s `representative`).
 * `null` in, `null` out.
 */
export function litOnCanvas(spot: Spotlight | null, representative: ReadonlyMap<string, string>): Set<string> | null {
  if (spot === null) return null;
  const out = new Set<string>();
  for (const id of spot.lit) out.add(representative.get(id) ?? id);
  return out;
}

/** `title, tag #launch` — the sheet's "Lit because" line — or `null` for an unlit node. */
export function litBecause(spot: Spotlight | null, id: string): string | null {
  const why = spot?.reasons.get(id);
  return why === undefined || why.length === 0 ? null : why.join(", ");
}

/**
 * Whether `Esc` clears the query.
 *
 * Inside the field, a query is what `Esc` clears — the habit of every search
 * box. Elsewhere in the graph it clears the query only when no sheet is open:
 * an open sheet is the nearer thing, and closing it is the shell's existing
 * `Esc` (clear the selection). With no query there is nothing to clear here,
 * so `Esc` keeps exactly the behaviour it had before the spotlight existed.
 */
export function spotlightEscapes(query: string, inField: boolean, sheetOpen: boolean): boolean {
  return query !== "" && (inField || !sheetOpen);
}

// --- marking the words ------------------------------------------------------------------------

/** A run of text, marked when it is one of the query's words. */
export interface MarkedPart {
  readonly text: string;
  readonly hit: boolean;
}

/**
 * Split `text` into runs, marking every occurrence of a term.
 *
 * Case-insensitive, left to right, earliest match first and the longest term
 * at a tie, never overlapping — so `launch` inside "Launches" marks `Launch`
 * and leaves `es` plain. Tag-only terms mark too: the sheet's text is where
 * the reader looks for the word they typed, whatever field it matched.
 */
export function markParts(text: string, terms: readonly SpotlightTerm[]): MarkedPart[] {
  const words = [...new Set(terms.map((term) => term.text))].sort((a, b) => b.length - a.length);
  const lower = text.toLowerCase();
  const parts: MarkedPart[] = [];
  let at = 0;
  let plain = "";
  while (at < text.length) {
    const word = words.find((candidate) => lower.startsWith(candidate, at));
    if (word === undefined) {
      plain += text[at];
      at += 1;
      continue;
    }
    if (plain !== "") parts.push({ text: plain, hit: false });
    plain = "";
    parts.push({ text: text.slice(at, at + word.length), hit: true });
    at += word.length;
  }
  if (plain !== "") parts.push({ text: plain, hit: false });
  return parts;
}

// --- the side sheet --------------------------------------------------------------------------------

/** The sheet's text block's heading. */
export type SheetTextKind = "TLDR" | "Summary" | "Preview";

/** The sheet's text block: a note's TLDR, a summary, or the note's opening words. */
export interface SheetText {
  readonly heading: SheetTextKind;
  readonly parts: readonly MarkedPart[];
}

/** One row of the sheet's Connected list. */
export interface SheetRow {
  readonly id: string;
  readonly label: string;
  readonly lit: boolean;
  /** The row's accessible name: the dot says "lit" to the eye, this says it aloud. */
  readonly ariaLabel: string;
}

/** Who wrote a note, as the sheet says it. */
export interface SheetWho {
  readonly provenance: WireNoteSource;
  readonly glyph: string;
  readonly word: string;
  readonly title: string;
}

/** Everything the side sheet renders for one node. */
export interface GraphSheet {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly icon: IconName;
  /** Where it lives: `projects`, `projects / 2026`, `Vault`. Empty for a root. */
  readonly crumb: string;
  readonly who: SheetWho | null;
  /** `2h ago`, or `""` when the node carries no time. */
  readonly when: string;
  readonly text: SheetText | null;
  /** The "Lit because" line, or `null` when the node did not light. */
  readonly litBecause: string | null;
  readonly connected: readonly SheetRow[];
  /** All connections, of which {@link connected} shows the first few. */
  readonly connectedTotal: number;
}

/** How many connections the sheet lists before it stops. */
export const CONNECTED_LIMIT = 6;

/** The sheet's section heading and its overflow line. */
export const CONNECTED_HEADING = "Connected";
export function connectedMore(shown: number, total: number): string | null {
  return total > shown ? `+${total - shown} more` : null;
}

/** The sheet's labels. */
export const SHEET_LABEL = "Graph node details";
export const SHEET_CLOSE = "Close details";
export const SHEET_OPEN = "Open";
export const SHEET_OPEN_SPLIT = "Open in split";
export const LIT_BECAUSE = "Lit because:";

/** Provenance → the word the sheet's meta line uses. The replay's vocabulary. */
const WHO_WORDS: Readonly<Record<WireNoteSource, string>> = {
  human: "You",
  agent: "Agent",
  generated: "Generated",
};

/** The edge kinds that are hierarchy rather than content. */
const STRUCTURAL = new Set<WireGraphEdge["kind"]>(["contains", "anchored-at"]);

/** The containment parent of every node, first edge wins (as `clusterAggregate` attributes). */
function parentsOf(edges: readonly WireGraphEdge[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const edge of edges) {
    if (STRUCTURAL.has(edge.kind) && !out.has(edge.target) && edge.source !== edge.target) out.set(edge.target, edge.source);
  }
  return out;
}

/** The deepest crumb segments shown before an ellipsis takes over. */
export const CRUMB_DEPTH = 3;

/**
 * Where a node lives, as a breadcrumb of its containment ancestors.
 *
 * The root itself is left off when there is anything below it — "projects"
 * says where a note is, "Vault / projects" says it twice — and kept when it is
 * the only ancestor, because a root note's crumb is the root. Deep chains keep
 * their last {@link CRUMB_DEPTH} folders behind an ellipsis. Cycle-safe.
 */
export function crumbOf(payload: GraphPayload, id: string): string {
  const parents = parentsOf(payload.model.edges);
  const labels = new Map(payload.model.nodes.map((node) => [node.id, node.label] as const));
  const chain: string[] = [];
  const seen = new Set<string>([id]);
  let at = parents.get(id);
  while (at !== undefined && !seen.has(at)) {
    seen.add(at);
    chain.unshift(labels.get(at) ?? at);
    at = parents.get(at);
  }
  const below = chain.length > 1 ? chain.slice(1) : chain;
  const shown = below.length > CRUMB_DEPTH ? ["…", ...below.slice(-CRUMB_DEPTH)] : below;
  return shown.join(" / ");
}

/**
 * The TLDR a finalized note opens with, from its preview.
 *
 * The notepad skill writes `**TLDR:**` directly under the title (skills/
 * weave-notepad). The preview is the body's first characters with whitespace
 * flattened, so the block ends at the next heading or the next bold label;
 * checkbox and bullet markers that lost their line starts are turned back
 * into readable separators. `null` when the note has no TLDR.
 */
export function tldrOf(preview: string): string | null {
  const found = /\*\*TL;?DR:?\*\*:?|(?:^|\s)TL;?DR:/i.exec(preview);
  if (found === null) return null;
  let rest = preview.slice(found.index + found[0].length);
  const stop = rest.search(/(?:^|\s)#{1,6}\s|\*\*[^*]+:\*\*/);
  if (stop >= 0) rest = rest.slice(0, stop);
  const text = stripMarkdown(
    rest
      .replace(/(?:^|\s)[-*+]\s+\[[xX]\]\s*/g, " ☑ ")
      .replace(/(?:^|\s)[-*+]\s+\[ \]\s*/g, " ☐ ")
      .replace(/(?:^|\s)[-*+]\s+/g, " · "),
  )
    .replace(/\s+/g, " ")
    .replace(/^\s*·\s*/, "")
    .trim();
  return text === "" ? null : text;
}

/** How long the sheet's text block may run. */
export const SHEET_TEXT_LIMIT = 200;

/** The sheet's text block for a node, or `null` when the payload has none. */
export function sheetText(node: WireGraphNode, terms: readonly SpotlightTerm[]): SheetText | null {
  const preview = node.detail.preview ?? "";
  const tldr = tldrOf(preview);
  if (tldr !== null) return { heading: "TLDR", parts: markParts(excerptOf(tldr, SHEET_TEXT_LIMIT), terms) };
  const summary = node.detail.summary ?? node.detail.description ?? "";
  if (summary.trim() !== "") return { heading: "Summary", parts: markParts(excerptOf(summary, SHEET_TEXT_LIMIT), terms) };
  const opening = excerptOf(preview, SHEET_TEXT_LIMIT);
  return opening === "" ? null : { heading: "Preview", parts: markParts(opening, terms) };
}

/**
 * The node's connections, as the sheet lists them.
 *
 * Content edges first — links and mentions, in either direction — because
 * "connected" means what the node is *about*, not which folder it sits in.
 * A node with no content edges (a folder, a module) lists its children
 * instead. Lit connections come first, then alphabetical.
 */
export function connectionsOf(payload: GraphPayload, id: string, spot: Spotlight | null): SheetRow[] {
  const byId = new Map(payload.model.nodes.map((node) => [node.id, node] as const));
  const collect = (keep: (edge: WireGraphEdge) => string | null): string[] => {
    const out: string[] = [];
    for (const edge of payload.model.edges) {
      const other = keep(edge);
      if (other !== null && other !== id && byId.has(other) && !out.includes(other)) out.push(other);
    }
    return out;
  };
  const content = collect((edge) => (STRUCTURAL.has(edge.kind) ? null : edge.source === id ? edge.target : edge.target === id ? edge.source : null));
  const ids = content.length > 0 ? content : collect((edge) => (STRUCTURAL.has(edge.kind) && edge.source === id ? edge.target : null));
  const rows = ids.map((other) => {
    const node = byId.get(other) as WireGraphNode;
    const lit = spot?.lit.has(other) ?? false;
    return { id: other, label: node.label, lit, ariaLabel: lit ? `${node.label} (lit)` : node.label };
  });
  return rows.sort((a, b) => Number(b.lit) - Number(a.lit) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

/**
 * The side sheet for the previewed node, or `null` when there is none.
 *
 * Built from the graph payload alone — no extra request: the node's label,
 * kind and `detail` (provenance, `updated`, the preview the TLDR is read
 * from, a deep-scan summary), its containment parents for the crumb and its
 * edges for the Connected list. `now` is injected, per AGENTS.md.
 */
export function graphSheet(payload: GraphPayload | null, id: string | null, spot: Spotlight | null, now: number): GraphSheet | null {
  const preview = graphPreview(payload, id);
  if (preview === null || payload === null) return null;
  const node = payload.model.nodes.find((candidate) => candidate.id === preview.id) as WireGraphNode;
  const connected = connectionsOf(payload, preview.id, spot);
  return {
    id: preview.id,
    title: preview.title,
    kind: preview.kind,
    icon: preview.icon,
    crumb: crumbOf(payload, preview.id),
    who: node.provenance === null
      ? null
      : { provenance: node.provenance, glyph: provenanceGlyph(node.provenance), word: WHO_WORDS[node.provenance], title: provenanceTitle(node.provenance) },
    when: relTime(node.detail.updated, now),
    text: sheetText(node, spot?.terms ?? []),
    litBecause: litBecause(spot, preview.id),
    connected: connected.slice(0, CONNECTED_LIMIT),
    connectedTotal: connected.length,
  };
}
