import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  executeNoteAction,
  executeRepoAction,
  WEAVE_NOTE_DESCRIPTION,
  WEAVE_REPO_DESCRIPTION,
  type NoteActionInput,
  type RepoActionInput,
} from "../core";
import { parseFrontMatter, unquoteField } from "../core/frontmatter";

const noteInput = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["list", "get", "add", "append", "finalize", "search", "links", "suggest"] },
    title: { type: "string", description: "Note title (add)" },
    text: { type: "string", description: "Markdown body (add), addition (append), or restructured body (finalize)" },
    tags: { type: "array", items: { type: "string" }, description: "Tags (add)" },
    slug: { type: "string", description: "Note slug (get, append, finalize)" },
    raw: { type: "boolean", description: "append: preserve text verbatim in the ## Raw tail" },
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

async function packagedSkill(relativePath: string): Promise<import("@opencode/plugin").Skill.Info> {
  const path = fileURLToPath(new URL(`../../skills/${relativePath}/SKILL.md`, import.meta.url));
  const content = await readFile(path, "utf8");
  const parsed = parseFrontMatter(content);
  const name = parsed?.fields.get("name");
  if (!parsed || !name) throw new Error(`Invalid packaged skill: ${relativePath}`);
  return {
    id: name,
    name,
    description: unquoteField(parsed.fields.get("description") ?? ""),
    path,
    content: parsed.body,
  } as import("@opencode/plugin").Skill.Info;
}

const weave = {
  id: "pi-weave",
  async setup(context) {
    context.tool.transform((editor) => {
      editor.add({
        name: "weave_note",
        description: WEAVE_NOTE_DESCRIPTION,
        input: noteInput,
        async execute(input) {
          const result = await executeNoteAction(input as NoteActionInput);
          return { content: result.text, metadata: result.details };
        },
      });
      editor.add({
        name: "weave_repo",
        description: WEAVE_REPO_DESCRIPTION,
        input: repoInput,
        async execute(input, toolContext) {
          const result = await executeRepoAction(
            input as RepoActionInput,
            context.location.directory,
            (status) => toolContext.progress({ status }),
          );
          return { content: result.text, metadata: result.details };
        },
      });
    });

    const skills = await Promise.all([packagedSkill("weave-notepad"), packagedSkill("weave-explore")]);
    context.skill.transform((editor) => {
      for (const skill of skills) editor.add(skill);
    });
  },
} satisfies import("@opencode/plugin").Plugin.Plugin;

export default weave;
