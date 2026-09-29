import {
  assessStaleness,
  buildRepoIndex,
  readRepoIndex,
  summarizeIndex,
  writeRepoIndex,
} from "./repoIndex";
import { findGitRoot } from "./git";
import { repoIndexDir } from "./paths";

export const WEAVE_REPO_DESCRIPTION =
  "Explore the current git repository through its pi-weave knowledge index (.okf). " +
  "Actions: status (index freshness vs git state), scan (build/refresh the index), " +
  "overview (read the indexed structure: languages, packages, modules, entry points). " +
  "The index is derived and rebuildable; scanning is always safe.";

export interface RepoActionInput {
  action: "status" | "scan" | "overview";
}

export interface RepoActionResult {
  text: string;
  details: Record<string, unknown>;
}

export async function executeRepoAction(
  params: RepoActionInput,
  cwd: string,
  onProgress?: (text: string) => void | Promise<void>,
): Promise<RepoActionResult> {
  const root = await findGitRoot(cwd);
  if (!root) {
    return {
      text: "Not inside a git repository — repository knowledge is unavailable here.",
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
        text: `Repository ${root}\n${lines.join("\n")}`,
        details: { action: "status", inRepo: true, staleness, indexed: index !== null },
      };
    }

    case "scan": {
      await onProgress?.(`Scanning ${root}…`);
      const index = await buildRepoIndex(root);
      if (!index) {
        return {
          text: "Cannot build index: the repository has no commits yet.",
          details: { action: "scan", inRepo: true, scanned: false },
        };
      }
      const dir = await writeRepoIndex(root, index);
      return {
        text: `Knowledge index written to ${dir}\n\n${summarizeIndex(index).join("\n")}`,
        details: { action: "scan", inRepo: true, scanned: true, index },
      };
    }

    case "overview": {
      const index = await readRepoIndex(root);
      if (!index) {
        return {
          text: `No knowledge index at ${repoIndexDir(root)} yet. Use action=scan to build one.`,
          details: { action: "overview", inRepo: true, indexed: false },
        };
      }
      const staleness = await assessStaleness(root);
      const header = staleness.state === "fresh" ? "" : `⚠ index is ${staleness.state} (consider rescanning)\n`;
      return {
        text: header + summarizeIndex(index).join("\n"),
        details: { action: "overview", inRepo: true, indexed: true, staleness, index },
      };
    }
  }
}
