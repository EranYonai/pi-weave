import { join } from "node:path";
import {
  addNote,
  appendToNote,
  extractRawTail,
  finalizeNote,
  formatNote,
  getNote,
  listNotes,
  readVault,
  repairVaultLinks,
  resolveNotePath,
  searchNotes,
  type LinkRepairResult,
} from "./vault";
import { relatedNotes, suggestLinks, type RelatedNote, type SuggestionReport } from "./links/similar";
import { NOTES_DIR, resolveVaultRoot } from "./paths";
import { withMutationQueue } from "./mutex";
import type { Note, NoteSearchHit } from "./types";

export const WEAVE_NOTE_DESCRIPTION =
  "Read and write notes in the pi-weave vault — a persistent, human-readable knowledge base " +
  "of Markdown notes. Actions: list (all notes — avoid on large vaults, prefer search), get (one note by slug), add (new note), " +
  "append (extend a note; raw=true appends verbatim dictation into the ## Raw tail; add with raw=true starts the note there), " +
  "finalize (restructure a note above its raw tail), search (ranked slug/title/tags/body matches plus linked, tagged, and lexically related notes; returns the full note when one result or one exact identity resolves), " +
  "links (audit stale [[wiki-links]]; fix=true repairs the unambiguous ones), " +
  "suggest (rank unlinked notes that share distinctive vocabulary; reports only, never writes). " +
  "Use it to remember decisions, facts, and user preferences across sessions.";

export interface NoteActionInput {
  action: "list" | "get" | "add" | "append" | "finalize" | "search" | "links" | "suggest";
  title?: string;
  text?: string;
  tags?: string[];
  slug?: string;
  raw?: boolean;
  source?: "human" | "agent";
  query?: string;
  fix?: boolean;
  limit?: number;
}

export interface NoteActionResult {
  text: string;
  details: Record<string, unknown>;
}

const LINK_REPORT_CAP = 20;
const LIST_CAP = 50;
const SEARCH_REPORT_CAP = 10;
const RELATED_REPORT_CAP = 5;
const COMPLETE_BODY_CAP = 2_000;
const COMPLETE_BODY_RESULTS = 3;

function capped<T>(items: readonly T[], render: (item: T) => string): string[] {
  const lines = items.slice(0, LINK_REPORT_CAP).map(render);
  if (items.length > LINK_REPORT_CAP) lines.push(`  … and ${items.length - LINK_REPORT_CAP} more`);
  return lines;
}

function formatSuggestions(report: SuggestionReport, focus: string | undefined): string {
  if (report.suggestions.length === 0) {
    return focus === undefined
      ? `No unlinked notes share enough distinctive vocabulary to suggest a connection (${report.considered} note(s) considered).`
      : `Nothing unlinked looks related to '${focus}' (${report.considered} note(s) considered).`;
  }
  const head = focus === undefined
    ? `${report.suggestions.length} suggested connection(s) across ${report.considered} note(s):`
    : `${report.suggestions.length} note(s) look related to '${focus}':`;
  const rows = report.suggestions.map((suggestion) => {
    const pair = focus === undefined
      ? `${suggestion.a} ↔ ${suggestion.b}`
      : suggestion.a === focus ? suggestion.b : suggestion.a;
    return `  ${suggestion.score.toFixed(3)}  ${pair}\n         shared: ${suggestion.shared.join(", ")}`;
  });
  return [
    head,
    ...rows,
    "",
    "These are suggestions, not links — nothing was written. Add a [[wikilink]] to any pair worth keeping.",
  ].join("\n");
}

function searchReasons(hit: NoteSearchHit, query: string): string[] {
  const q = query.trim().toLowerCase();
  const title = hit.summary.title.toLowerCase();
  const slug = hit.summary.slug.toLowerCase();
  const reasons: string[] = [];
  if (title === q) reasons.push("exact title");
  else if (slug === q) reasons.push("exact slug");
  else if (title.includes(q)) reasons.push("title");
  else if (slug.includes(q)) reasons.push("slug");
  const tags = hit.summary.tags.filter((tag) => tag.toLowerCase().includes(q));
  if (tags.length > 0) reasons.push(`tags: ${tags.join(", ")}`);
  if (hit.snippet.toLowerCase().includes(q)) reasons.push("body");
  if (reasons.length === 0) {
    const haystack = `${title} ${slug} ${hit.summary.tags.join(" ").toLowerCase()} ${hit.snippet.toLowerCase()}`;
    const terms = [...new Set(q.match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])].filter((term) => haystack.includes(term));
    if (terms.length > 0) reasons.push(`query terms: ${terms.join(", ")}`);
  }
  return reasons;
}

function searchContent(note: Note | undefined, snippet: string, complete: boolean): string {
  const body = note?.body.trim() ?? "";
  if (complete && body.length <= COMPLETE_BODY_CAP) return `[complete body]\n  ${body}`;
  return `[excerpt${body.length > COMPLETE_BODY_CAP ? "; use get for the full note" : ""}]\n  ${snippet}`;
}

function formatSearchHits(
  hits: readonly NoteSearchHit[],
  query: string,
  relations: ReadonlyMap<string, RelatedNote>,
  notes: ReadonlyMap<string, Note>,
): string {
  const shown = hits.slice(0, SEARCH_REPORT_CAP);
  const lines = shown.map((hit, index) => {
    const tags = hit.summary.tags.length > 0 ? `; tags: ${hit.summary.tags.join(", ")}` : "";
    const relation = relations.get(hit.summary.slug);
    const connected = relation ? `; connected: ${relation.reasons.join("; ")}` : "";
    const content = searchContent(notes.get(hit.summary.slug), hit.snippet, index < COMPLETE_BODY_RESULTS);
    return `- ${hit.summary.slug}: ${hit.summary.title}\n  matched: ${searchReasons(hit, query).join(", ")}${connected}; source: ${hit.summary.source}; updated: ${hit.summary.updated}${tags}\n  ${content}`;
  });
  if (hits.length > shown.length) lines.push(`… and ${hits.length - shown.length} more direct match(es).`);
  return lines.join("\n");
}

function preview(body: string): string {
  const flat = body.trim().replace(/\s+/g, " ");
  return flat.length > 180 ? `${flat.slice(0, 180)}…` : flat;
}

function formatRelatedNotes(
  relations: readonly RelatedNote[],
  notes: ReadonlyMap<string, Note>,
  direct: ReadonlySet<string>,
  anchor: Note,
): string {
  const shown = relations
    .filter((relation) => !direct.has(relation.slug))
    .flatMap((relation) => {
      const note = notes.get(relation.slug);
      return note ? [{ relation, note }] : [];
    })
    .slice(0, RELATED_REPORT_CAP);
  if (shown.length === 0) return "";
  const lines = shown.map(({ relation, note }, index) => {
    const tags = note.tags.length > 0 ? `; tags: ${note.tags.join(", ")}` : "";
    const content = searchContent(note, preview(note.body), index < COMPLETE_BODY_RESULTS);
    return `- ${note.slug}: ${note.title}\n  connected: ${relation.reasons.join("; ")}; source: ${note.source}; updated: ${note.updated}${tags}\n  ${content}`;
  });
  return `Connected notes to '${anchor.title}' (discovery context only — not direct query matches or evidence about the query):\n${lines.join("\n")}`;
}

function formatLinkReport(result: LinkRepairResult, applied: boolean): string {
  const { audit } = result;
  const lines = [`${audit.total} wiki-link(s): ${audit.resolved} resolved, ${audit.total - audit.resolved} stale.`];
  if (applied) {
    lines.push(
      result.applied.length === 0
        ? "Nothing to repair automatically."
        : `Repaired ${result.applied.length} link(s) across ${result.notes.length} note(s):`,
      ...capped(result.applied, (fix) => `  ${fix.slug}: [[${fix.from}]] → [[${fix.to}]] (${fix.rule})`),
    );
  } else if (audit.fixable.length > 0) {
    lines.push(
      `${audit.fixable.length} auto-fixable (re-run with fix: true):`,
      ...capped(audit.fixable, (fix) => `  ${fix.slug}: [[${fix.from}]] → [[${fix.to}]] (${fix.rule})`),
    );
  }
  if (audit.ambiguous.length > 0) {
    lines.push(
      `${audit.ambiguous.length} ambiguous link(s) (several candidates — pick one and edit the note):`,
      ...capped(audit.ambiguous, (link) => `  ${link.slug}: [[${link.target}]] → ${link.candidates.join(" | ")}`),
    );
  }
  if (audit.unresolvable.length > 0) {
    lines.push(
      `${audit.unresolvable.length} unresolvable target(s) (no such note — write it or drop the link):`,
      ...capped(audit.unresolvable, (link) => `  [[${link.target}]] ← ${link.notes.join(", ")}`),
    );
  }
  if (audit.fixable.length === 0 && audit.ambiguous.length === 0 && audit.unresolvable.length === 0) {
    lines.push("Every link resolves.");
  }
  return lines.join("\n");
}

export async function executeNoteAction(
  params: NoteActionInput,
  vault = resolveVaultRoot(),
  now: () => Date = () => new Date(),
): Promise<NoteActionResult> {
  switch (params.action) {
    case "list": {
      const notes = await listNotes(vault);
      if (notes.length === 0) return { text: `The vault at ${vault} has no notes yet.`, details: { action: "list", notes: [] } };
      const shown = notes.slice(0, LIST_CAP);
      const lines = shown.map(
        (note) => `- ${note.slug}: ${note.title}${note.tags.length > 0 ? ` [${note.tags.join(", ")}]` : ""} (updated ${note.updated}, source: ${note.source})`,
      );
      if (notes.length > shown.length) {
        lines.push(`… and ${notes.length - shown.length} more (newest ${shown.length} shown) — use action=search to find a specific note.`);
      }
      return { text: `${notes.length} note(s) in ${vault}:\n${lines.join("\n")}`, details: { action: "list", notes } };
    }

    case "get": {
      if (!params.slug) throw new Error("weave_note(get) requires 'slug'");
      const note = await getNote(vault, params.slug);
      return note
        ? { text: formatNote(note), details: { action: "get", found: true, note } }
        : { text: `No note found with slug '${params.slug}'.`, details: { action: "get", found: false } };
    }

    case "add": {
      if (!params.title) throw new Error("weave_note(add) requires 'title'");
      if (!params.text) throw new Error("weave_note(add) requires 'text'");
      const note = await withMutationQueue(join(vault, NOTES_DIR), () =>
        addNote(vault, {
          title: params.title!,
          body: params.text!,
          ...(params.tags ? { tags: params.tags } : {}),
          ...(params.source ? { source: params.source } : {}),
          ...(params.raw ? { raw: true, now: now() } : {}),
        }),
      );
      return {
        text: params.raw
          ? `Note created: ${note.slug} (${vault}), text preserved verbatim in its ## Raw tail.`
          : `Note created: ${note.slug} (${vault})`,
        details: { action: "add", note },
      };
    }

    case "append": {
      if (!params.slug) throw new Error("weave_note(append) requires 'slug'");
      if (!params.text) throw new Error("weave_note(append) requires 'text'");
      const path = resolveNotePath(vault, params.slug);
      if (!path) {
        return {
          text: `Invalid note slug '${params.slug}' — notes are flat files inside the vault (no path separators or '..').`,
          details: { action: "append", found: false },
        };
      }
      const note = await withMutationQueue(path, () =>
        appendToNote(vault, params.slug!, params.text!, now(), params.raw ? { raw: true } : {}),
      );
      if (!note) return { text: `No note found with slug '${params.slug}'.`, details: { action: "append", found: false } };
      return {
        text: params.raw
          ? `Appended verbatim to the ## Raw tail of ${note.slug} (updated ${note.updated}).`
          : `Appended to ${note.slug} (updated ${note.updated}).`,
        details: { action: "append", found: true, note },
      };
    }

    case "finalize": {
      if (!params.slug) throw new Error("weave_note(finalize) requires 'slug'");
      if (!params.text) throw new Error("weave_note(finalize) requires 'text'");
      const path = resolveNotePath(vault, params.slug);
      if (!path) {
        return {
          text: `Invalid note slug '${params.slug}' — notes are flat files inside the vault (no path separators or '..').`,
          details: { action: "finalize", found: false },
        };
      }
      const note = await withMutationQueue(path, () => finalizeNote(vault, params.slug!, { body: params.text! }));
      if (!note) return { text: `No note found with slug '${params.slug}'.`, details: { action: "finalize", found: false } };
      const preserved = extractRawTail(note.body) !== "";
      return {
        text: `Finalized ${note.slug} (updated ${note.updated}). ${preserved ? "Raw tail preserved beneath the structured body." : "Note body was empty — nothing to preserve."}`,
        details: { action: "finalize", found: true, note },
      };
    }

    case "search": {
      if (!params.query) throw new Error("weave_note(search) requires 'query'");
      const hits = await searchNotes(vault, params.query);
      if (hits.length === 0) return { text: `No notes matched '${params.query}'.`, details: { action: "search", hits: [] } };
      const { notes } = await readVault(vault);
      const bySlug = new Map(notes.map((note) => [note.slug, note]));
      const direct = new Set(hits.map((hit) => hit.summary.slug));
      const anchor = bySlug.get(hits[0]!.summary.slug);
      const related = anchor ? relatedNotes({ notes }, anchor.slug) : [];
      const relatedBySlug = new Map(related.map((relation) => [relation.slug, relation]));
      const connected = anchor ? formatRelatedNotes(related, bySlug, direct, anchor) : "";
      const query = params.query.trim().toLowerCase();
      const exact = hits.filter((hit) =>
        hit.summary.title.trim().toLowerCase() === query || hit.summary.slug.toLowerCase() === query
      );
      const resolved = hits.length === 1 ? hits[0] : exact.length === 1 ? exact[0] : undefined;
      if (resolved) {
        const note = bySlug.get(resolved.summary.slug);
        if (note) {
          const others = hits.filter((hit) => hit.summary.slug !== note.slug);
          const otherMatches = others.length > 0
            ? `Other direct matches (${others.length}):\n${formatSearchHits(others, params.query, relatedBySlug, bySlug)}`
            : "";
          return {
            text: [formatNote(note).trimEnd(), otherMatches, connected].filter(Boolean).join("\n\n") + "\n",
            details: { action: "search", hits, resolved: note, related },
          };
        }
      }
      return {
        text: [
          `${hits.length} direct match(es) for '${params.query}', strongest first:\n${formatSearchHits(hits, params.query, relatedBySlug, bySlug)}`,
          connected,
        ].filter(Boolean).join("\n\n"),
        details: { action: "search", hits, related },
      };
    }

    case "suggest": {
      const { notes } = await readVault(vault);
      const report = suggestLinks(
        { notes },
        {
          ...(params.slug ? { slug: params.slug } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        },
      );
      return {
        text: formatSuggestions(report, params.slug),
        details: { action: "suggest", considered: report.considered, suggestions: report.suggestions },
      };
    }

    case "links": {
      const apply = params.fix === true;
      const result = await repairVaultLinks(vault, apply ? { apply: true } : {});
      return {
        text: formatLinkReport(result, apply),
        details: {
          action: "links",
          fixed: apply,
          total: result.audit.total,
          resolved: result.audit.resolved,
          fixable: result.audit.fixable,
          ambiguous: result.audit.ambiguous,
          unresolvable: result.audit.unresolvable,
          applied: result.applied,
          notes: result.notes,
        },
      };
    }
  }
}
