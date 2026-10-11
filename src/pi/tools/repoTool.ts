import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { executeRepoAction, WEAVE_REPO_DESCRIPTION } from "../../core";

/** `weave_repo` — the repository-exploration tool (design §2/§8). */
export function registerRepoTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "weave_repo",
    label: "Weave Repo",
    description: WEAVE_REPO_DESCRIPTION,
    promptSnippet: "Explore the repository's structure via its .okf knowledge index",
    promptGuidelines: [
      "Use weave_repo action=overview to learn repository structure before broad code exploration instead of scanning files one by one.",
    ],
    parameters: Type.Object({
      action: StringEnum(["overview"] as const),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await executeRepoAction(params, ctx.cwd);
      return { content: [{ type: "text", text: result.text }], details: result.details };
    },
  });
}
