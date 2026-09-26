import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { Type } from "typebox";
import {
  addNote,
  appendToNote,
  extractRawTail,
  finalizeNote,
  formatNote,
  formatRawAppend,
  getNote,
  listNotes,
  NOTES_DIR,
  relatedNotes,
  repairVaultLinks,
  resolveNotePath,
  withMutationQueue,
  resolveVaultRoot,
  searchNotes,
  suggestLinks,
  readVault,
  type LinkRepairResult,
  type RelatedNote,
  type SuggestionReport,
} from "../../core";
import type { Note, NoteSearchHit } from "../../core/types";

/** Cap on how many rows of each link-audit category get printed. */
const LINK_REPORT_CAP = 20;

/** Cap on notes printed by `list`; `details.notes` still carries them all. */
const LIST_CAP = 50;

/** Keep search useful without flooding the model on a broad query. */
const SEARCH_REPORT_CAP = 10;
const RELATED_REPORT_CAP = 5;

function capped<T>(items: readonly T[], render: (item: T) => string): string[] {
  const lines = items.slice(0, LINK_REPORT_CAP).map(render);
  if (items.length > LINK_REPORT_CAP) lines.push(`  … and ${items.length - LINK_REPORT_CAP} more`);
  return lines;
}

/**
 * Render suggestions as the text the model reads.
 *
 * Every row carries the shared terms that earned it. A bare score is
 * unreviewable; the evidence is what lets a human accept or reject a
 * suggestion without opening both notes.
 */
function formatSuggestions(report: SuggestionReport, focus: string | undefined): string {
  if (report.suggestions.length === 0) {
    return focus === undefined
      ? `No unlinked notes share enough distinctive vocabulary to suggest a connection (${report.considered} note(s) considered).`
      : `Nothing unlinked looks related to '${focus}' (${report.considered} note(s) considered).`;
  }
  const head = focus === undefined
    ? `${report.suggestions.length} suggested connection(s) across ${report.considered} note(s):`
    : `${report.suggestions.length} note(s) look related to '${focus}':`;
  const rows = report.suggestions.map((s) => {
    const pair = focus === undefined ? `${s.a} ↔ ${s.b}` : s.a === focus ? s.b : s.a;
    return `  ${s.score.toFixed(3)}  ${pair}\n         shared: ${s.shared.join(", ")}`;
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
  return reasons;
}

function formatSearchHits(
  hits: readonly NoteSearchHit[],
  query: string,
  relations: ReadonlyMap<string, RelatedNote>,
): string {
  const shown = hits.slice(0, SEARCH_REPORT_CAP);
  const lines = shown.map((hit) => {
    const tags = hit.summary.tags.length > 0 ? `; tags: ${hit.summary.tags.join(", ")}` : "";
    const relation = relations.get(hit.summary.slug);
    const connected = relation ? `; connected: ${relation.reasons.join("; ")}` : "";
    return `- ${hit.summary.slug}: ${hit.summary.title}\n  matched: ${searchReasons(hit, query).join(", ")}${connected}; source: ${hit.summary.source}; updated: ${hit.summary.updated}${tags}\n  ${hit.snippet}`;
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
  const lines = shown.map(({ relation, note }) => {
    const tags = note.tags.length > 0 ? `; tags: ${note.tags.join(", ")}` : "";
    return `- ${note.slug}: ${note.title}\n  connected: ${relation.reasons.join("; ")}; source: ${note.source}; updated: ${note.updated}${tags}\n  ${preview(note.body)}`;
  });
  return `Connected notes to '${anchor.title}' (not direct query matches):\n${lines.join("\n")}`;
}

/** Render a link audit (and any repair) as the text the model reads. */
function formatLinkReport(result: LinkRepairResult, applied: boolean): string {
  const { audit } = result;
  const stale = audit.total - audit.resolved;
  // Occurrences, not rows. `total`/`resolved` count every `[[…]]` in the
  // vault, while `fixable`/`unresolvable` are grouped (per note+target, per
  // target). Reporting "70 stale" beside "40 unresolvable" with no unit
  // invites the reader to subtract them and find 30 phantom links; saying
  // what each number counts is the whole fix.
  const lines = [
    `${audit.total} wiki-link(s): ${audit.resolved} resolved, ${stale} stale.`,
  ];
  if (applied) {
    lines.push(
      result.applied.length === 0
        ? "Nothing to repair automatically."
        : `Repaired ${result.applied.length} link(s) across ${result.notes.length} note(s):`,
      ...capped(result.applied, (f) => `  ${f.slug}: [[${f.from}]] → [[${f.to}]] (${f.rule})`),
    );
  } else if (audit.fixable.length > 0) {
    lines.push(
      `${audit.fixable.length} auto-fixable (re-run with fix: true):`,
      ...capped(audit.fixable, (f) => `  ${f.slug}: [[${f.from}]] → [[${f.to}]] (${f.rule})`),
    );
  }
  if (audit.ambiguous.length > 0) {
    lines.push(
      `${audit.ambiguous.length} ambiguous link(s) (several candidates — pick one and edit the note):`,
      ...capped(audit.ambiguous, (a) => `  ${a.slug}: [[${a.target}]] → ${a.candidates.join(" | ")}`),
    );
  }
  if (audit.unresolvable.length > 0) {
    lines.push(
      `${audit.unresolvable.length} unresolvable target(s) (no such note — write it or drop the link):`,
      ...capped(audit.unresolvable, (u) => `  [[${u.target}]] ← ${u.notes.join(", ")}`),
    );
  }
  if (audit.fixable.length === 0 && audit.ambiguous.length === 0 && audit.unresolvable.length === 0) {
    lines.push("Every link resolves.");
  }
  return lines.join("\n");
}

/**
 * `weave_note` — the smart-notepad tool (design §1: vault knowledge).
 *
 * The LLM uses this to remember decisions, facts, and preferences as plain
 * Markdown notes that humans can read and edit directly on disk.
 */
export function registerNoteTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "weave_note",
    label: "Weave Note",
    description:
      "Read and write notes in the pi-weave vault — a persistent, human-readable knowledge base " +
      "of Markdown notes. Actions: list (all notes — avoid on large vaults, prefer search), get (one note by slug), add (new note), " +
      "append (extend a note; raw=true appends verbatim dictation into the ## Raw tail), " +
      "finalize (restructure a note above its raw tail), search (ranked slug/title/tags/body matches plus linked, tagged, and lexically related notes; returns the full note when one result or one exact identity resolves), " +
      "links (audit stale [[wiki-links]]; fix=true repairs the unambiguous ones), " +
      "suggest (rank unlinked notes that share distinctive vocabulary; reports only, never writes). " +
      "Use it to remember decisions, facts, and user preferences across sessions.",
    promptSnippet: "Remember and retrieve durable knowledge in the pi-weave vault",
    promptGuidelines: [
      "Use weave_note to store durable knowledge (decisions, preferences, key facts) that should survive the session, marking source as agent-written knowledge.",
      "Use weave_note with action=get when the slug is known; otherwise use one targeted action=search before answering questions about past decisions, people, or projects. A resolved search already contains the full note; do not fetch it again or retry with reformulated queries.",
      "Use weave_note with action=links to find and repair stale [[wiki-links]] deterministically instead of rereading the vault to reconnect notes by hand; add fix=true to apply the unambiguous repairs.",
      "Use weave_note with action=suggest to discover notes that belong together but are not linked (optionally scoped to one slug); it only reports — propose the links to the user rather than writing them.",
    ],
    parameters: Type.Object({
      action: StringEnum(["list", "get", "add", "append", "finalize", "search", "links", "suggest"] as const),
      title: Type.Optional(Type.String({ description: "Note title (add)" })),
      text: Type.Optional(Type.String({ description: "Markdown body (add), addition (append), or restructured body above the raw tail (finalize)" })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Tags (add)" })),
      slug: Type.Optional(Type.String({ description: "Note slug (get, append, finalize)" })),
      raw: Type.Optional(Type.Boolean({ description: "append: add text as verbatim dictation to the ## Raw tail (timestamped fenced block; tail created if missing). Use for dictation/scribbles; omit for structured Markdown additions" })),
      source: Type.Optional(StringEnum(["human", "agent"] as const, { description: "Provenance (add): human for user-scribbled notes, agent for Pi-drafted (default agent)" })),
      query: Type.Optional(Type.String({ description: "Search query (search)" })),
      fix: Type.Optional(Type.Boolean({ description: "links: apply the unambiguous repairs. Omit for a read-only report" })),
      limit: Type.Optional(Type.Number({ description: "suggest: how many suggestions to return (default 20)" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const vault = resolveVaultRoot();

      switch (params.action) {
        case "list": {
          const notes = await listNotes(vault);
          if (notes.length === 0) {
            return {
              content: [{ type: "text", text: `The vault at ${vault} has no notes yet.` }],
              details: { action: "list", notes: [] },
            };
          }
          // Truncated, because the whole list is rarely the answer and on a
          // large vault it is actively harmful: hundreds of lines of slugs
          // crowd out the conversation that prompted the call. Newest first
          // (`listNotes` order), so the cap keeps what is most likely wanted,
          // and the footer names `search` — the action that answers "is there
          // a note about X" without reading the vault aloud.
          const shown = notes.slice(0, LIST_CAP);
          const lines = shown.map(
            (n) => `- ${n.slug}: ${n.title}${n.tags.length > 0 ? ` [${n.tags.join(", ")}]` : ""} (updated ${n.updated}, source: ${n.source})`,
          );
          if (notes.length > shown.length) {
            lines.push(
              `… and ${notes.length - shown.length} more (newest ${shown.length} shown) — use action=search to find a specific note.`,
            );
          }
          return {
            content: [{ type: "text", text: `${notes.length} note(s) in ${vault}:\n${lines.join("\n")}` }],
            details: { action: "list", notes },
          };
        }

        case "get": {
          if (!params.slug) throw new Error("weave_note(get) requires 'slug'");
          const note = await getNote(vault, params.slug);
          if (!note) {
            return { content: [{ type: "text", text: `No note found with slug '${params.slug}'.` }], details: { action: "get", found: false } };
          }
          return { content: [{ type: "text", text: formatNote(note) }], details: { action: "get", found: true, note } };
        }

        case "add": {
          if (!params.title) throw new Error("weave_note(add) requires 'title'");
          if (!params.text) throw new Error("weave_note(add) requires 'text'");
          const title = params.title;
          const text = params.text;
          // Serialized per vault: parallel adds of the same title must not
          // race the unique-slug check and overwrite each other.
          const note = await withMutationQueue(join(vault, NOTES_DIR), () =>
            addNote(vault, {
              title,
              body: text,
              ...(params.tags ? { tags: params.tags } : {}),
              ...(params.source ? { source: params.source } : {}),
            }),
          );
          return {
            content: [{ type: "text", text: `Note created: ${note.slug} (${vault})` }],
            details: { action: "add", note },
          };
        }

        case "append": {
          if (!params.slug) throw new Error("weave_note(append) requires 'slug'");
          if (!params.text) throw new Error("weave_note(append) requires 'text'");
          const slug = params.slug;
          const text = params.text;
          const path = resolveNotePath(vault, slug);
          if (!path) {
            return {
              content: [
                {
                  type: "text",
                  text: `Invalid note slug '${slug}' — notes are flat files inside the vault (no path separators or '..').`,
                },
              ],
              details: { action: "append", found: false },
            };
          }
          // Serialized read-modify-write: parallel weave_note appends (and
          // pi's own file tools) targeting the same note would otherwise
          // lose each other's additions.
          const note = await withMutationQueue(path, () =>
            appendToNote(vault, slug, text, new Date(), params.raw ? { raw: true } : {}),
          );
          if (!note) {
            return { content: [{ type: "text", text: `No note found with slug '${params.slug}'.` }], details: { action: "append", found: false } };
          }
          return {
            content: [{ type: "text", text: params.raw ? `Appended verbatim to the ## Raw tail of ${note.slug} (updated ${note.updated}).` : `Appended to ${note.slug} (updated ${note.updated}).` }],
            details: { action: "append", found: true, note },
          };
        }

        case "finalize": {
          if (!params.slug) throw new Error("weave_note(finalize) requires 'slug'");
          if (!params.text) throw new Error("weave_note(finalize) requires 'text'");
          const slug = params.slug;
          const text = params.text;
          const path = resolveNotePath(vault, slug);
          if (!path) {
            return {
              content: [
                {
                  type: "text",
                  text: `Invalid note slug '${slug}' — notes are flat files inside the vault (no path separators or '..').`,
                },
              ],
              details: { action: "finalize", found: false },
            };
          }
          // Serialized read-modify-write, same as append: finalize replaces the
          // body above the raw tail, so it must not race other writers.
          const note = await withMutationQueue(path, () => finalizeNote(vault, slug, { body: text }));
          if (!note) {
            return { content: [{ type: "text", text: `No note found with slug '${params.slug}'.` }], details: { action: "finalize", found: false } };
          }
          // Be truthful about what was preserved: a note with no `## Raw`
          // marker yet gets its whole pre-finalize body preserved as a new
          // raw tail (never silently dropped).
          const preserved = extractRawTail(note.body) !== "";
          return {
            content: [{ type: "text", text: `Finalized ${note.slug} (updated ${note.updated}). ${preserved ? "Raw tail preserved beneath the structured body." : "Note body was empty — nothing to preserve."}` }],
            details: { action: "finalize", found: true, note },
          };
        }

        case "search": {
          if (!params.query) throw new Error("weave_note(search) requires 'query'");
          const hits = await searchNotes(vault, params.query);
          if (hits.length === 0) {
            return {
              content: [{ type: "text", text: `No notes matched '${params.query}'.` }],
              details: { action: "search", hits: [] },
            };
          }
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
                ? `Other direct matches (${others.length}):\n${formatSearchHits(others, params.query, relatedBySlug)}`
                : "";
              return {
                content: [{
                  type: "text",
                  text: [formatNote(note).trimEnd(), otherMatches, connected].filter(Boolean).join("\n\n") + "\n",
                }],
                details: { action: "search", hits, resolved: note, related },
              };
            }
          }
          return {
            content: [{
              type: "text",
              text: [
                `${hits.length} direct match(es) for '${params.query}', strongest first:\n${formatSearchHits(hits, params.query, relatedBySlug)}`,
                connected,
              ].filter(Boolean).join("\n\n"),
            }],
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
            content: [{ type: "text", text: formatSuggestions(report, params.slug) }],
            details: { action: "suggest", considered: report.considered, suggestions: report.suggestions },
          };
        }

        case "links": {
          const apply = params.fix === true;
          const result = await repairVaultLinks(vault, apply ? { apply: true } : {});
          return {
            content: [{ type: "text", text: formatLinkReport(result, apply) }],
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
    },
  });
}

export { formatRawAppend };
