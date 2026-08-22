import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  assessStaleness,
  buildRepoIndex,
  findGitRoot,
  readRepoIndex,
  repoIndexDir,
  summarizeIndex,
  writeRepoIndex,
} from "../../core";

/**
 * `weave_repo` — the repository-exploration tool (design §2/§8).
 *
 * Builds and reads the derived .okf index: structure, modules, packages,
 * entry points, plus git-aware staleness.
 */
export function registerRepoTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "weave_repo",
    label: "Weave Repo",
    description:
      "Explore the current git repository through its pi-weave knowledge index (.okf). " +
      "Actions: status (index freshness vs git state), scan (build/refresh the index), " +
      "overview (read the indexed structure: languages, packages, modules, entry points). " +
      "The index is derived and rebuildable; scanning is always safe.",
    promptSnippet: "Explore the repository's structure via its .okf knowledge index",
    promptGuidelines: [
      "Use weave_repo action=overview to learn repository structure before broad code exploration instead of scanning files one by one.",
      "Use weave_repo action=scan when the user asks to explore or index this repository.",
    ],
    parameters: Type.Object({
      action: StringEnum(["status", "scan", "overview"] as const),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const root = await findGitRoot(ctx.cwd);
      if (!root) {
        return {
          content: [{ type: "text", text: "Not inside a git repository — repository knowledge is unavailable here." }],
          details: { action: params.action, inRepo: false },
        };
      }

      switch (params.action) {
        case "status": {
          const staleness = await assessStaleness(root);
          const index = staleness.state !== "missing" ? await readRepoIndex(root) : null;
          const lines = [`Index state: ${staleness.state}`];
          for (const reason of staleness.reasons) lines.push(`- ${reason}`);
          if (index) lines.push(`Indexed at: ${index.updated} by ${index.generator}`);
          return {
            content: [{ type: "text", text: `Repository ${root}\n${lines.join("\n")}` }],
            details: { action: "status", inRepo: true, staleness, indexed: index !== null },
          };
        }

        case "scan": {
          onUpdate?.({ content: [{ type: "text", text: `Scanning ${root}…` }], details: {} });
          const index = await buildRepoIndex(root);
          if (!index) {
            return {
              content: [{ type: "text", text: "Cannot build index: the repository has no commits yet." }],
              details: { action: "scan", inRepo: true, scanned: false },
            };
          }
          const dir = await writeRepoIndex(root, index);
          const summary = summarizeIndex(index).join("\n");
          return {
            content: [{ type: "text", text: `Knowledge index written to ${dir}\n\n${summary}` }],
            details: { action: "scan", inRepo: true, scanned: true, index },
          };
        }

        case "overview": {
          const index = await readRepoIndex(root);
          if (!index) {
            return {
              content: [{ type: "text", text: `No knowledge index at ${repoIndexDir(root)} yet. Use action=scan to build one.` }],
              details: { action: "overview", inRepo: true, indexed: false },
            };
          }
          const staleness = await assessStaleness(root);
          const header = staleness.state === "fresh" ? "" : `⚠ index is ${staleness.state} (consider rescanning)\n`;
          return {
            content: [{ type: "text", text: header + summarizeIndex(index).join("\n") }],
            details: { action: "overview", inRepo: true, indexed: true, staleness, index },
          };
        }
      }
    },
  });
}
