import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { weaveTools } from "../../core/tools";
import { piParameters } from "./parameters";

const tool = weaveTools.find((definition) => definition.name === "weave_repo")!;

/** `weave_repo` — the repository-exploration tool (design §2/§8). */
export function registerRepoTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: tool.name,
    label: "Weave Repo",
    description: tool.description,
    promptSnippet: "Explore the repository's structure via its .okf knowledge index",
    promptGuidelines: [
      "Use weave_repo action=overview to learn repository structure before broad code exploration instead of scanning files one by one.",
    ],
    parameters: piParameters(tool.input),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await tool.execute(params, ctx.cwd);
      return { content: [{ type: "text", text: result.text }], details: result.details };
    },
  });
}
