/**
 * Deterministic stale-link detection and repair for the vault.
 *
 * A wiki-link goes stale for two reasons: the note it pointed at was renamed
 * or moved (and nothing rewrote the inbound links), or it was written by hand
 * as a bare title — `[[John Doe]]` — while the note lives at `1-1s/john-doe`.
 * Graph building already notices both (`GraphModel.danglingLinks`) but only
 * ever reports a count. This module resolves and repairs them.
 *
 * ## Why no fuzzy matching
 *
 * The resolver is a ladder of three rules, each of which must produce
 * **exactly one** candidate to fire:
 *
 *   1. exact slug        — the target already names a note; nothing to do
 *   2. unique basename   — `john-doe` → `1-1s/john-doe`
 *   3. unique slug-title — front-matter `title` slugified
 *
 * Two candidates is *ambiguous* and is reported, never guessed. Zero is
 * *unresolvable* and is reported so a human can write the note or drop the
 * link. There is no edit distance, no scoring, no embedding: a repair pass
 * that is only probably right is worse than no repair pass, because it
 * silently rewrites knowledge. The degenerate case here is always "ask the
 * human", never "wrong link".
 *
 * Pure: no I/O lives here. The disk-touching repair entry points are in
 * `../vault` (`repairVaultLinks`, and the backlink rewrite that rename/move
 * perform), which already owns the vault lock and the write path. The
 * dependency runs one way — vault imports repair, never the reverse — so
 * there is no import cycle to reason about at 3am.
 */

import { slugify } from "../slug";
import type { HtmlArtifact, Note } from "../types";

/**
 * The append-only tail heading.
 *
 * Defined here rather than in `vault.ts` (which re-exports it, so its public
 * API is unchanged) because repair is the module that must *not* cross it,
 * and vault imports repair. One definition, no cycle.
 */
export const RAW_NOTES_HEADING = "## Raw";

/** One `[[wiki-link]]` found in a body, with enough context to rewrite it. */
export interface LinkOccurrence {
  /** Index of the opening `[[` in the body. */
  start: number;
  /** Index just past the closing `]]`. */
  end: number;
  /** The link target as written, before normalisation. */
  rawTarget: string;
  /** The target normalised to a slug, the way the graph builder sees it. */
  target: string;
  /** The pipe alias, when the link has one. */
  alias: string | undefined;
}

/**
 * Normalise a link target to a slug.
 *
 * Deliberately identical to `extractWikilinks` (`../graph/wikilinks.ts`):
 * if repair normalised differently from graph building, the audit would
 * report links the graph considers fine, or miss ones it flags. HTML
 * artifacts keep their extension — it is part of their identity.
 */
export function normalizeTarget(raw: string): string {
  const trimmed = raw.trim();
  return /\.html?$/i.test(trimmed)
    ? trimmed.replace(/\\/g, "/").replace(/^\.\//, "")
    : trimmed
        .split("/")
        .map((part) => slugify(part))
        .join("/");
}

const WIKILINK_RE = /\[\[([^\][|]+)(?:\|([^\]]*))?\]\]/g;
const FENCE_RE = /^[ \t]*(?:`{3,}|~{3,}).*$/gm;

/**
 * The byte offset where the `## Raw` tail begins, or the body length when
 * there is none.
 *
 * The tail is append-only and verbatim — "NEVER edit below this line" is
 * written into every note that has one. A link inside a user's dictation is
 * *their* text, quoted; repairing it would edit words the vault promises not
 * to touch. Rare (1 occurrence in a 1241-link vault) and absolutely off
 * limits.
 */
function rawTailStart(body: string): number {
  const idx = body.indexOf(`\n${RAW_NOTES_HEADING}`);
  if (idx !== -1) return idx;
  return body.startsWith(RAW_NOTES_HEADING) ? 0 : body.length;
}

/** Half-open `[start, end)` ranges covering fenced code blocks. */
function fenceRanges(body: string): [number, number][] {
  const ranges: [number, number][] = [];
  let open: number | null = null;
  for (const match of body.matchAll(FENCE_RE)) {
    if (open === null) open = match.index;
    else {
      ranges.push([open, match.index + match[0].length]);
      open = null;
    }
  }
  // An unterminated fence runs to the end of the body, the way a renderer
  // treats it.
  if (open !== null) ranges.push([open, body.length]);
  return ranges;
}

/**
 * Every repairable `[[wiki-link]]` in a body, in order.
 *
 * Skips the `## Raw` tail and fenced code blocks. `extractWikilinks` does
 * neither, on purpose: it feeds the graph, where over-reporting a link is
 * harmless. Here the output drives a rewrite, so a `[[…]]` inside a code
 * sample is a string literal and must stay one.
 */
export function scanLinks(body: string): LinkOccurrence[] {
  const limit = rawTailStart(body);
  const fences = fenceRanges(body);
  const out: LinkOccurrence[] = [];
  for (const match of body.matchAll(WIKILINK_RE)) {
    const start = match.index;
    if (start >= limit) break;
    if (fences.some(([a, b]) => start >= a && start < b)) continue;
    // Group 1 is mandatory in WIKILINK_RE, and `split` always yields at
    // least one segment: both `!`s below are the regex's guarantee, not
    // optimism.
    const rawTarget = match[1]!;
    if (rawTarget.trim().length === 0) continue;
    out.push({
      start,
      end: start + match[0].length,
      rawTarget: rawTarget.trim(),
      target: normalizeTarget(rawTarget),
      alias: match[2],
    });
  }
  return out;
}

/**
 * Rewrite link targets in a body. `resolve` returns the new slug for a
 * target, or null to leave the link alone.
 *
 * The alias is preserved — `[[John Doe]]` becomes `[[1-1s/john-doe|John Doe]]`
 * and `[[John Doe|JD]]` becomes `[[1-1s/john-doe|JD]]` — so the rendered
 * prose is byte-identical before and after a repair. A human rereading the
 * note sees no diff; only the graph changes.
 */
export function rewriteLinks(body: string, resolve: (target: string) => string | null): { body: string; changed: number } {
  const occurrences = scanLinks(body);
  let out = "";
  let cursor = 0;
  let changed = 0;
  for (const occ of occurrences) {
    const to = resolve(occ.target);
    if (to === null || to === occ.target) continue;
    const alias = occ.alias ?? occ.rawTarget;
    out += body.slice(cursor, occ.start) + `[[${to}|${alias}]]`;
    cursor = occ.end;
    changed++;
  }
  return { body: out + body.slice(cursor), changed };
}

/** One link that resolves to exactly one note and can be rewritten. */
export interface LinkFix {
  /** The note containing the stale link. */
  slug: string;
  /** The stale target, normalised. */
  from: string;
  /** The note it unambiguously means. */
  to: string;
  /** Which ladder rung resolved it. */
  rule: "basename" | "title";
  /** Occurrences of this target in this note. */
  count: number;
}

/** A stale link with more than one candidate: reported, never repaired. */
export interface AmbiguousLink {
  slug: string;
  target: string;
  candidates: string[];
}

/** A stale link with no candidate at all, and who points at it. */
export interface UnresolvableLink {
  target: string;
  /** Note slugs referencing it, sorted. */
  notes: string[];
}

/** The result of one audit pass over a vault. */
export interface LinkAudit {
  /** Every link occurrence considered (raw tail and code fences excluded). */
  total: number;
  /** Occurrences already pointing at a real note or artifact. */
  resolved: number;
  /** Unambiguously repairable, sorted by note then target. */
  fixable: LinkFix[];
  /** Multiple candidates — a human has to choose. */
  ambiguous: AmbiguousLink[];
  /** No candidate: the note was never written. */
  unresolvable: UnresolvableLink[];
}

/** The slice of a vault snapshot the audit needs. */
export interface LinkAuditInput {
  notes: readonly Pick<Note, "slug" | "title" | "body">[];
  artifacts?: readonly Pick<HtmlArtifact, "slug">[];
}

function indexBy<T>(items: readonly T[], key: (item: T) => string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list) list.push((item as { slug: string }).slug);
    else out.set(k, [(item as { slug: string }).slug]);
  }
  return out;
}

/**
 * Audit every wiki-link in a vault. Pure: no I/O, no clock, no randomness —
 * the same vault always produces the same audit, which is what makes the
 * repair reviewable.
 */
export function auditLinks(input: LinkAuditInput): LinkAudit {
  const notes = input.notes;
  const slugs = new Set(notes.map((n) => n.slug));
  const artifactSlugs = new Set((input.artifacts ?? []).map((a) => a.slug));
  const byBasename = indexBy(notes, (n) => n.slug.split("/").pop()!);
  const byTitle = indexBy(notes, (n) => slugify(n.title));

  let total = 0;
  let resolved = 0;
  // Keyed `slug\u0000target` so repeated occurrences of the same stale link
  // in one note collapse into a single fix carrying a count.
  const fixes = new Map<string, LinkFix>();
  const ambiguous: AmbiguousLink[] = [];
  const unresolvable = new Map<string, Set<string>>();

  for (const note of notes) {
    const seenAmbiguous = new Set<string>();
    for (const occ of scanLinks(note.body)) {
      total++;
      if (slugs.has(occ.target) || artifactSlugs.has(occ.target)) {
        resolved++;
        continue;
      }
      const basename = occ.target.split("/").pop()!;
      const byBase = byBasename.get(basename) ?? [];
      const byTtl = byTitle.get(basename) ?? [];
      const rule: LinkFix["rule"] | null = byBase.length === 1 ? "basename" : byTtl.length === 1 ? "title" : null;
      const to = rule === "basename" ? byBase[0] : rule === "title" ? byTtl[0] : undefined;
      if (rule !== null && to !== undefined) {
        const key = `${note.slug}\u0000${occ.target}`;
        const existing = fixes.get(key);
        if (existing) existing.count++;
        else fixes.set(key, { slug: note.slug, from: occ.target, to, rule, count: 1 });
        continue;
      }
      const candidates = [...new Set([...byBase, ...byTtl])].sort();
      if (candidates.length > 1) {
        if (!seenAmbiguous.has(occ.target)) {
          seenAmbiguous.add(occ.target);
          ambiguous.push({ slug: note.slug, target: occ.target, candidates });
        }
        continue;
      }
      const refs = unresolvable.get(occ.target);
      if (refs) refs.add(note.slug);
      else unresolvable.set(occ.target, new Set([note.slug]));
    }
  }

  return {
    total,
    resolved,
    fixable: [...fixes.values()].sort((a, b) => a.slug.localeCompare(b.slug) || a.from.localeCompare(b.from)),
    ambiguous: ambiguous.sort((a, b) => a.slug.localeCompare(b.slug) || a.target.localeCompare(b.target)),
    unresolvable: [...unresolvable.entries()]
      .map(([target, notes]) => ({ target, notes: [...notes].sort() }))
      .sort((a, b) => a.target.localeCompare(b.target)),
  };
}
