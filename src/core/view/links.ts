/**
 * Link and tag derivations over vault/graph data (weave-workspace §3, §4.3).
 */

import type { GraphEdge } from "../graph/model";
import type { NoteMeta } from "../types";

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

/**
 * One tag and every note carrying it (weave-workspace §4.3).
 *
 * `slugs` rather than node ids: `note:` is a graph-internal prefix, and every
 * consumer of this index — the note column's tag chips, `GraphPayload.tags` —
 * addresses notes by slug.
 */
export interface TagIndex {
  tag: string;
  slugs: string[];
}

/**
 * The minimum a note has to expose to be tag-indexed: its identity and its
 * tags.
 *
 * Declared structurally instead of taking `NoteSummary` outright so the
 * function accepts a `Note` (which has a `body` and no `bodyLength`) just as
 * happily as a `NoteSummary`. §4.3 specifies `NoteSummary[]`; this is that
 * signature widened to its actual requirement rather than narrowed past it,
 * and `NoteSummary` still satisfies it exactly.
 */
export type TaggedNote = Pick<NoteMeta, "tags"> & { slug: string };

/**
 * Invert `note → tags` into `tag → notes` (weave-workspace §4.3).
 *
 * ## Why this takes notes and not a `GraphModel`
 *
 * The obvious alternative is deriving from the graph, since every other
 * function in this directory does. It is the wrong source here, and the
 * reason is worth stating because "derive everything from the graph" is
 * otherwise a good rule.
 *
 * `buildGraph` flattens tags into `detail.tags`, a comma-joined **display**
 * string (`build.ts`: `note.tags.join(", ")`). Recovering an array from it
 * means splitting on `", "` — which is re-parsing a display string into
 * structure, precisely what §4.2/§4.3 forbid `detail` from being used for,
 * and it is lossy besides: a tag containing a comma round-trips wrong, and
 * the tag is simply absent when a note has none. The alternative is to make
 * `GraphNode` carry a real `tags: string[]` alongside the display string,
 * which puts the same fact on the node twice and grows the wire model for
 * every note whether or not anything reads it.
 *
 * Notes are the upstream source of truth. Both callers already hold them —
 * `buildCurrentGraph` and `WorkspaceCache` each read the vault before they
 * build a graph — so deriving here costs no extra I/O and keeps one
 * representation of a tag: the array on the note. The graph's display string
 * stays a projection of that, never an input to it.
 *
 * ## Ordering
 *
 * Count descending, then tag ascending, per §4.3 — the popular tags surface
 * first and ties are alphabetical rather than insertion-ordered. Each `slugs`
 * list is sorted ascending too, so the whole structure is a pure function of
 * the tag/slug *set*: two vaults with the same tags in a different note order
 * produce byte-identical JSON, which is what lets this ride the ETag.
 *
 * The tiebreak is **codepoint** order, not `localeCompare`, which is the one
 * place this file departs from the habit elsewhere in core. `localeCompare`
 * reads the host's default locale and the runtime's ICU build — a Node
 * compiled with small-icu can order `"Arch"` against `"arch"` differently
 * from one with full-icu. Everywhere else that is a cosmetic difference in a
 * list a human is about to read; here the output is hashed into a cache key
 * (§5.3), so an ordering that varies by machine is a correctness bug rather
 * than a preference. Codepoint order is total, locale-free and matches the
 * bare `.sort()` used for `slugs` just below.
 *
 * Duplicate tags within one note collapse (front matter is hand-editable and
 * `tags: [a, a]` is a typo, not two memberships).
 */
export function deriveTagIndex(notes: readonly TaggedNote[]): TagIndex[] {
  const bySlug = new Map<string, Set<string>>();
  for (const note of notes) {
    for (const tag of note.tags) {
      const slugs = bySlug.get(tag);
      if (slugs) slugs.add(note.slug);
      else bySlug.set(tag, new Set([note.slug]));
    }
  }
  return [...bySlug]
    .map(([tag, slugs]): TagIndex => ({ tag, slugs: [...slugs].sort() }))
    // Tags come from a Map's keys, so no two are equal and the comparator
    // never needs to return 0 for the tiebreak — `< ? -1 : 1` is total here.
    .sort((a, b) => b.slugs.length - a.slugs.length || (a.tag < b.tag ? -1 : 1));
}
