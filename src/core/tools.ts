import { executeNoteAction, WEAVE_NOTE_DESCRIPTION, type NoteActionInput, type NoteActionResult } from "./noteAction";
import { executeRepoAction, WEAVE_REPO_DESCRIPTION, type RepoActionInput } from "./repoAction";

/**
 * The `weave_note` and `weave_repo` tools, defined once for every harness.
 *
 * Plain JSON Schema, because that is the one format Pi, OpenCode and MCP
 * (Claude Code) all accept. Each adapter only maps these definitions onto its
 * own registration call and adds what is genuinely harness-specific, such as
 * Pi's prompt guidelines.
 */

const noteInput = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["list", "get", "add", "append", "finalize", "search", "links", "suggest"] },
    title: { type: "string", description: "Note title (add)" },
    text: { type: "string", description: "Markdown body (add), addition (append), or restructured body above the raw tail (finalize)" },
    tags: { type: "array", items: { type: "string" }, description: "Tags (add)" },
    slug: { type: "string", description: "Note slug (get, append, finalize)" },
    raw: {
      type: "boolean",
      description: "add/append: keep text as verbatim dictation in the ## Raw tail (timestamped fenced block; tail created if missing). Use for the user's own words, including the first words of a dictated note; omit for structured Markdown",
    },
    source: {
      type: "string",
      enum: ["human", "agent"],
      description: "Provenance (add): human for user-scribbled notes, agent for agent-drafted (default agent)",
    },
    query: { type: "string", description: "Search query (search)" },
    fix: { type: "boolean", description: "links: apply the unambiguous repairs. Omit for a read-only report" },
    limit: { type: "number", description: "suggest: how many suggestions to return (default 20)" },
  },
  required: ["action"],
  additionalProperties: false,
} as const;

const repoInput = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["overview"] },
  },
  required: ["action"],
  additionalProperties: false,
} as const;

export const weaveTools = [
  {
    name: "weave_note",
    description: WEAVE_NOTE_DESCRIPTION,
    input: noteInput,
    execute: (input: unknown, _cwd: string, _progress?: (text: string) => Promise<void>): Promise<NoteActionResult> =>
      executeNoteAction(input as NoteActionInput),
  },
  {
    name: "weave_repo",
    description: WEAVE_REPO_DESCRIPTION,
    input: repoInput,
    execute: (input: unknown, cwd: string, _progress?: (text: string) => Promise<void>) => executeRepoAction(input as RepoActionInput, cwd),
  },
];

export type WeaveTool = (typeof weaveTools)[number];
