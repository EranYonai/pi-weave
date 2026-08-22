import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { Type } from "typebox";
import {
  addNote,
  appendToNote,
  formatNote,
  getNote,
  listNotes,
  NOTES_DIR,
  resolveNotePath,
  withMutationQueue,
  resolveVaultRoot,
  searchNotes,
} from "../../core";

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
      "of Markdown notes. Actions: list (all notes), get (one note by slug), add (new note), " +
      "append (extend a note), search (title/tags/body). Use it to remember decisions, facts, " +
      "and user preferences across sessions.",
    promptSnippet: "Remember and retrieve durable knowledge in the pi-weave vault",
    promptGuidelines: [
      "Use weave_note to store durable knowledge (decisions, preferences, key facts) that should survive the session, marking source as agent-written knowledge.",
      "Use weave_note with action=search before answering questions about past decisions, people, or projects.",
    ],
    parameters: Type.Object({
      action: StringEnum(["list", "get", "add", "append", "search"] as const),
      title: Type.Optional(Type.String({ description: "Note title (add)" })),
      text: Type.Optional(Type.String({ description: "Markdown body (add) or addition (append)" })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Tags (add)" })),
      slug: Type.Optional(Type.String({ description: "Note slug (get, append)" })),
      query: Type.Optional(Type.String({ description: "Search query (search)" })),
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
          const lines = notes.map(
            (n) => `- ${n.slug}: ${n.title}${n.tags.length > 0 ? ` [${n.tags.join(", ")}]` : ""} (updated ${n.updated}, source: ${n.source})`,
          );
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
              source: "agent",
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
          const note = await withMutationQueue(path, () => appendToNote(vault, slug, text));
          if (!note) {
            return { content: [{ type: "text", text: `No note found with slug '${params.slug}'.` }], details: { action: "append", found: false } };
          }
          return {
            content: [{ type: "text", text: `Appended to ${note.slug} (updated ${note.updated}).` }],
            details: { action: "append", found: true, note },
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
          const lines = hits.map(
            (h) => `- ${h.summary.slug}: ${h.summary.title} (score ${h.score})\n  ${h.snippet}`,
          );
          return {
            content: [{ type: "text", text: `${hits.length} hit(s) for '${params.query}':\n${lines.join("\n")}` }],
            details: { action: "search", hits },
          };
        }
      }
    },
  });
}
