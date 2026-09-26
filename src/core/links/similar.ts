/**
 * Suggest connections between notes that are related but not linked.
 *
 * The companion to `repair.ts`, and deliberately the opposite kind of tool.
 * Repair fixes a link that exists and points wrong: the answer is exact, so
 * repair writes. This finds links that were never written: the answer is a
 * *ranking*, so this only ever reports. A soft signal must not produce a hard
 * `[[link]]` — once written into a body it is indistinguishable from one the
 * user wrote deliberately, and a wrong link is worse than a missing one
 * because a missing link is visible and a wrong one is believed.
 *
 * ## The signal
 *
 * Classic IDF-weighted cosine over every term a note carries — title words,
 * tags, and body words, all in one bag. Terms are weighted by how rare they
 * are *in this vault*:
 *
 *     idf(t) = ln(N / df(t))
 *
 * That one line is why nothing here is domain-specific. A tag on 2400 of
 * 2500 notes scores ~0 and cannot connect anything; a ticket id on 6 notes
 * scores high and connects them strongly. The vault decides what is
 * meaningful by frequency, so there is no list of "important" fields to keep
 * up to date, and a vault of recipes clusters by ingredient exactly as a
 * vault of meeting notes clusters by project. No field names appear in this
 * file for the same reason.
 *
 * ## Why cosine, not Jaccard
 *
 * Weighted Jaccard divides by the union, so it punishes length mismatch: a
 * short journal entry and a long profile about the same subject score low
 * purely for differing in size. Cosine normalises each note by its own
 * magnitude, which is the behaviour wanted when comparing documents of
 * uneven length.
 *
 * Pure: no I/O, no clock.
 */

import { slugify } from "../slug";
import type { Note } from "../types";
import { scanLinks } from "./repair";

/** One suggested connection, with the evidence for it. */
export interface LinkSuggestion {
  /** The two notes, ordered so `a` < `b` — a suggestion has no direction. */
  a: string;
  b: string;
  /** Cosine similarity over IDF-weighted terms, 0..1. */
  score: number;
  /**
   * The terms that earned the score, strongest first.
   *
   * The most important field here. A bare number is unreviewable — "0.16,
   * trust me" — while "they share `acme-1234`, `release-pipeline`" is a claim
   * a human can accept or reject in a second. A suggestion nobody can check
   * is a suggestion nobody should act on.
   */
  shared: string[];
}

/** What {@link suggestLinks} was asked for, and what it found. */
export interface SuggestionReport {
  /** Notes considered (those with at least one distinctive term). */
  considered: number;
  /** Suggestions, strongest first, then by slug for determinism. */
  suggestions: LinkSuggestion[];
}

export interface SuggestOptions {
  /** Only suggest neighbours of this note. Omit for vault-wide pairs. */
  slug?: string;
  /** Maximum suggestions returned. Default 20. */
  limit?: number;
  /**
   * Ignore terms carried by more than this fraction of notes. Default 0.05.
   *
   * Common terms are the vocabulary of a *genre* — every 1:1 note says
   * "sprint", every recipe says "oven" — so they make unrelated notes of the
   * same shape look related. Rare terms are what a note is actually about.
   *
   * Only a ceiling, never a floor: see {@link MIN_TERM_CEILING}.
   */
  maxDocFrequency?: number;
  /** Suggestions below this score are dropped. Default 0.02. */
  minScore?: number;
  /** How many shared terms to cite as evidence. Default 8. */
  evidence?: number;
}

/** Words too structural to carry meaning in any vault, in any domain. */
const TERM_RE = /[\p{L}][\p{L}\p{N}_-]{2,}/gu;

/**
 * Smallest document-frequency ceiling, whatever `maxDocFrequency` computes.
 *
 * A pure percentage collapses on a small vault: at 40 notes, 5% floors to 2,
 * so a term shared by three notes is discarded as "common" and the tool goes
 * silent exactly where a user is most likely to try it. This floor keeps a
 * young vault working while staying far below the point where a term is
 * genuinely genre vocabulary — on any vault large enough for the percentage
 * to exceed it, the percentage wins and this never applies.
 */
export const MIN_TERM_CEILING = 10;

/**
 * Split a note into terms.
 *
 * Title and tags are folded into the same bag as the body rather than being
 * weighted separately: a term's importance is already expressed by its
 * rarity, so boosting "the title" would be a second, redundant opinion about
 * significance — and a wrong one whenever a title is generic ("Notes",
 * "Index") or a body mentions the decisive term once.
 */
function terms(note: Pick<Note, "title" | "tags" | "body">): Set<string> {
  const text = `${note.title} ${note.tags.join(" ")} ${note.body}`;
  const out = new Set<string>();
  for (const match of text.matchAll(TERM_RE)) out.add(match[0].toLowerCase());
  return out;
}

/** The slice of a vault this needs. */
export interface SuggestInput {
  notes: readonly Pick<Note, "slug" | "title" | "tags" | "body">[];
}

/** One deterministic neighbour of a note, with reviewable evidence. */
export interface RelatedNote {
  slug: string;
  score: number;
  reasons: string[];
}

function resolvedLinks(notes: SuggestInput["notes"]): {
  pairs: Set<string>;
  outgoing: Map<string, Set<string>>;
} {
  const pairs = new Set<string>();
  const outgoing = new Map<string, Set<string>>();
  const bySlug = new Set(notes.map((note) => note.slug));
  const byBasename = new Map<string, string[]>();
  const byTitle = new Map<string, string[]>();
  for (const note of notes) {
    const base = note.slug.split("/").pop()!;
    byBasename.set(base, [...(byBasename.get(base) ?? []), note.slug]);
    const title = slugify(note.title);
    if (title.length > 0) byTitle.set(title, [...(byTitle.get(title) ?? []), note.slug]);
  }
  for (const note of notes) {
    for (const link of scanLinks(note.body)) {
      const byBase = byBasename.get(link.target) ?? [];
      const byTtl = byTitle.get(link.target) ?? [];
      const target = bySlug.has(link.target)
        ? link.target
        : byBase.length === 1
          ? byBase[0]!
          : byTtl.length === 1
            ? byTtl[0]!
            : null;
      if (target === null) continue;
      pairs.add(pairKey(note.slug, target));
      const targets = outgoing.get(note.slug);
      if (targets) targets.add(target);
      else outgoing.set(note.slug, new Set([target]));
    }
  }
  return { pairs, outgoing };
}

/**
 * Rank pairs of notes that share distinctive vocabulary but no link.
 *
 * Already-linked pairs are excluded in both directions: the point is to
 * surface connections the vault is *missing*, and re-suggesting a link the
 * user already wrote is noise that buries the real findings.
 */
export function suggestLinks(input: SuggestInput, options: SuggestOptions = {}): SuggestionReport {
  const limit = options.limit ?? 20;
  const maxDf = options.maxDocFrequency ?? 0.05;
  const minScore = options.minScore ?? 0.02;
  const evidenceCount = options.evidence ?? 8;
  const notes = input.notes;
  const n = notes.length;

  const df = new Map<string, number>();
  const bags = new Map<string, Set<string>>();
  for (const note of notes) {
    const bag = terms(note);
    bags.set(note.slug, bag);
    for (const term of bag) df.set(term, (df.get(term) ?? 0) + 1);
  }

  // A term in one note connects nothing; a term in most notes connects
  // everything. Only what lies between can carry a signal.
  const ceiling = Math.max(MIN_TERM_CEILING, Math.floor(n * maxDf));
  const idf = new Map<string, number>();
  for (const [term, count] of df) {
    if (count < 2 || count > ceiling) continue;
    idf.set(term, Math.log(n / count));
  }

  // Unit-normalised vectors, so the dot product below *is* the cosine.
  const vectors = new Map<string, Map<string, number>>();
  for (const note of notes) {
    const vec = new Map<string, number>();
    let norm = 0;
    // Every note got a bag above; the `!` is that loop's invariant.
    for (const term of bags.get(note.slug)!) {
      const weight = idf.get(term);
      if (weight === undefined) continue;
      vec.set(term, weight);
      norm += weight * weight;
    }
    if (norm === 0) continue;
    const len = Math.sqrt(norm);
    for (const [term, weight] of vec) vec.set(term, weight / len);
    vectors.set(note.slug, vec);
  }

  // Existing links, both directions, so a connection the user already made
  // is never offered back to them.
  const { pairs: linked } = resolvedLinks(notes);

  // Candidate generation through an inverted index on distinctive terms
  // only. Comparing every pair is O(n²) and mostly compares notes with
  // nothing in common; postings lists for rare terms are short by
  // definition, so this touches only pairs that can actually score.
  const postings = new Map<string, string[]>();
  for (const [slug, vec] of vectors) {
    for (const term of vec.keys()) postings.set(term, [...(postings.get(term) ?? []), slug]);
  }

  const focus = options.slug;
  if (focus !== undefined && !vectors.has(focus)) {
    return { considered: vectors.size, suggestions: [] };
  }

  const scores = new Map<string, number>();
  const sources = focus !== undefined ? [focus] : [...vectors.keys()];
  // Vault-wide, every pair is reachable from both of its ends, so each
  // contribution would be counted twice and the "cosine" could exceed 1.
  // Accumulating one direction only keeps the score a real cosine; a focused
  // run walks one source, so it never double-counts to begin with.
  const oneWay = focus === undefined;
  for (const slug of sources) {
    const vec = vectors.get(slug)!;
    for (const [term, weight] of vec) {
      // `term` survived the idf filter, so it has a postings list containing
      // at least this note.
      for (const other of postings.get(term)!) {
        if (other === slug || (oneWay && other < slug)) continue;
        const key = pairKey(slug, other);
        if (linked.has(key)) continue;
        // `other` came from this term's postings list, so both lookups are
        // guaranteed present — the `!`s are the index's invariant.
        scores.set(key, (scores.get(key) ?? 0) + weight * vectors.get(other)!.get(term)!);
      }
    }
  }

  const suggestions: LinkSuggestion[] = [];
  for (const [key, score] of scores) {
    if (score < minScore) continue;
    const [a, b] = key.split("\u0000") as [string, string];
    suggestions.push({ a, b, score, shared: sharedTerms(vectors.get(a)!, vectors.get(b)!, evidenceCount) });
  }
  suggestions.sort((x, y) => y.score - x.score || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));

  return { considered: vectors.size, suggestions: suggestions.slice(0, limit) };
}

/**
 * Rank the explicit and lexical neighbours of one note.
 *
 * This is deliberately not semantic search: every result cites a link,
 * backlink, shared tag, or shared term already present in the vault.
 */
export function relatedNotes(input: SuggestInput, slug: string, limit = 20): RelatedNote[] {
  if (limit <= 0) return [];
  const focus = input.notes.find((note) => note.slug === slug);
  if (!focus) return [];

  const related = new Map<string, RelatedNote>();
  const add = (target: string, score: number, reason: string) => {
    if (target === slug) return;
    const existing = related.get(target);
    if (existing) {
      existing.score = Math.max(existing.score, score);
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
    } else {
      related.set(target, { slug: target, score, reasons: [reason] });
    }
  };

  const { outgoing } = resolvedLinks(input.notes);
  for (const target of outgoing.get(slug) ?? []) add(target, 400, `linked from ${slug}`);
  for (const [source, targets] of outgoing) {
    if (targets.has(slug)) add(source, 400, `links to ${slug}`);
  }

  const focusTags = new Map(focus.tags.map((tag) => [tag.toLowerCase(), tag]));
  for (const note of input.notes) {
    const shared = [...new Set(note.tags.map((tag) => tag.toLowerCase()))]
      .filter((tag) => focusTags.has(tag))
      .map((tag) => focusTags.get(tag)!);
    if (shared.length > 0) add(note.slug, 300 + shared.length, `shared tags: ${shared.join(", ")}`);
  }

  for (const suggestion of suggestLinks(input, { slug, limit: Math.max(limit, 20) }).suggestions) {
    const target = suggestion.a === slug ? suggestion.b : suggestion.a;
    add(target, 200 + suggestion.score, `shared terms: ${suggestion.shared.join(", ")}`);
  }

  return [...related.values()]
    .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug))
    .slice(0, limit);
}

/** Order-independent key for an unordered pair. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/** The terms contributing most to a pair's score, strongest first. */
function sharedTerms(a: Map<string, number>, b: Map<string, number>, count: number): string[] {
  const shared: [string, number][] = [];
  for (const [term, weight] of a) {
    const other = b.get(term);
    if (other !== undefined) shared.push([term, weight * other]);
  }
  return shared
    .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
    .slice(0, count)
    .map(([term]) => term);
}

/**
 * Slugify for comparison. Exported so the adapter can echo a target the way
 * the resolver would see it.
 */
export function suggestionTarget(slug: string): string {
  return slug.split("/").map(slugify).join("/");
}
