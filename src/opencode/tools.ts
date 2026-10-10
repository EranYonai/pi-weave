import { executeNoteAction, executeRepoAction, WEAVE_NOTE_DESCRIPTION, WEAVE_REPO_DESCRIPTION, type NoteActionInput, type RepoActionInput } from "../core";

const noteInput = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["list", "get", "add", "append", "finalize", "search", "links", "suggest"] },
    title: { type: "string", description: "Note title (add)" },
    text: { type: "string", description: "Markdown body (add), addition (append), or restructured body (finalize)" },
    tags: { type: "array", items: { type: "string" }, description: "Tags (add)" },
    slug: { type: "string", description: "Note slug (get, append, finalize)" },
    raw: { type: "boolean", description: "add/append: preserve text verbatim in the ## Raw tail (use for the user's own words)" },
    source: { type: "string", enum: ["human", "agent"], description: "Provenance (add; defaults to agent)" },
    query: { type: "string", description: "Search query (search)" },
    fix: { type: "boolean", description: "links: apply unambiguous repairs" },
    limit: { type: "number", description: "suggest: maximum suggestions (default 20)" },
  },
  required: ["action"],
  additionalProperties: false,
} as const;

const repoInput = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["status", "scan", "overview"] },
  },
  required: ["action"],
  additionalProperties: false,
} as const;

export const weaveTools = [
  {
    name: "weave_note",
    description: WEAVE_NOTE_DESCRIPTION,
    input: noteInput,
    execute: (input: unknown, _cwd: string, _progress?: (text: string) => Promise<void>) => executeNoteAction(input as NoteActionInput),
  },
  {
    name: "weave_repo",
    description: WEAVE_REPO_DESCRIPTION,
    input: repoInput,
    execute: (input: unknown, cwd: string, progress?: (text: string) => Promise<void>) => executeRepoAction(input as RepoActionInput, cwd, progress),
  },
];
