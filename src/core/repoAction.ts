import { ensureRepoIndex, summarizeIndex } from "./repoIndex";
import { findGitRoot } from "./git";
import { readSummaries } from "./summaries";

export const WEAVE_REPO_DESCRIPTION =
  "Explore the current git repository through its pi-weave knowledge index (.okf). " +
  "Action: overview (languages, packages, modules, entry points, and how many files have deep-scan summaries). " +
  "The index is derived, rebuilt automatically when the repository changes, and never needs a manual scan.";

export interface RepoActionInput {
  action: "overview";
}

export interface RepoActionResult {
  text: string;
  details: Record<string, unknown>;
}

export async function executeRepoAction(params: RepoActionInput, cwd: string): Promise<RepoActionResult> {
  const root = await findGitRoot(cwd);
  if (!root) {
    return {
      text: "Not inside a git repository — repository knowledge is unavailable here.",
      details: { action: params.action, inRepo: false },
    };
  }

  const ensured = await ensureRepoIndex(root);
  if (!ensured) {
    return {
      text: "The repository has no commits yet, so there is no structure to describe.",
      details: { action: "overview", inRepo: true, indexed: false },
    };
  }
  const summaryCount = (await readSummaries(root)).length;
  const footer = summaryCount > 0
    ? `Summaries: ${summaryCount} file(s) in .okf/repository/summaries/`
    : "Summaries: none yet — /weave-scan writes them with the session model";
  return {
    text: [...summarizeIndex(ensured.index), footer].join("\n"),
    details: { action: "overview", inRepo: true, indexed: true, index: ensured.index, summaryCount },
  };
}
