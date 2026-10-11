import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  executeNoteAction,
  formatRawAppend,
  WEAVE_NOTE_DESCRIPTION,
} from "../../core";

/** `weave_note` — the smart-notepad tool (design §1: vault knowledge). */
export function registerNoteTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "weave_note",
    label: "Weave Note",
    description: WEAVE_NOTE_DESCRIPTION,
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
      raw: Type.Optional(Type.Boolean({ description: "add/append: keep text as verbatim dictation in the ## Raw tail (timestamped fenced block; tail created if missing). Use for the user's own words, including the first words of a dictated note; omit for structured Markdown" })),
      source: Type.Optional(StringEnum(["human", "agent"] as const, { description: "Provenance (add): human for user-scribbled notes, agent for Pi-drafted (default agent)" })),
      query: Type.Optional(Type.String({ description: "Search query (search)" })),
      fix: Type.Optional(Type.Boolean({ description: "links: apply the unambiguous repairs. Omit for a read-only report" })),
      limit: Type.Optional(Type.Number({ description: "suggest: how many suggestions to return (default 20)" })),
    }),
    async execute(_toolCallId, params) {
      const result = await executeNoteAction(params);
      return { content: [{ type: "text", text: result.text }], details: result.details };
    },
  });
}

export { formatRawAppend };
