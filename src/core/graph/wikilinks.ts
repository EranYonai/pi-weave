/**
 * Obsidian-compatible [[wiki-link]] extraction from note bodies.
 * Pure module — see docs/weave-view.md §3.
 */

import { slugify } from "../slug";

const WIKILINK_RE = /\[\[([^\][|]+)(?:\|[^\]]*)?\]\]/g;

/**
 * Extract wiki-link targets from a note body as slugs. Handles
 * `[[some-note]]` and aliased `[[Some Note|alias]]` (alias ignored for
 * linking). Targets are slugified so `[[Release Plan]]` matches the note
 * `release-plan`. Duplicates are removed, order of first appearance kept.
 */
export function extractWikilinks(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(WIKILINK_RE)) {
    const raw = (match[1] ?? "").trim();
    if (raw.length === 0) continue;
    const slug = slugify(raw);
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}
