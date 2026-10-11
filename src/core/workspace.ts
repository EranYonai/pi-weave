import { findGitRoot } from "./git";
import { readRepoIndex } from "./repoIndex";
import { readSummaries } from "./summaries";
import { basename } from "node:path";
import { resolveVaultRoot } from "./paths";
import { noteCount, vaultExists } from "./vault";
import type { WorkspaceStatus } from "./types";

/**
 * The combined knowledge-workspace view: vault + repository (design §5/§17).
 * This is what session_start, the /weave command, and future adapters read
 * to decide what knowledge is available in the current directory.
 */

export interface WorkspaceOptions {
  /** Override the vault root (defaults to PI_WEAVE_VAULT or ~/.okf). */
  vaultRoot?: string;
}

export async function getWorkspaceStatus(cwd: string, options: WorkspaceOptions = {}): Promise<WorkspaceStatus> {
  const vaultRoot = options.vaultRoot ?? resolveVaultRoot();

  const [exists, count, repoRoot] = await Promise.all([
    vaultExists(vaultRoot),
    noteCount(vaultRoot),
    findGitRoot(cwd),
  ]);

  const status: WorkspaceStatus = {
    cwd,
    vault: { root: vaultRoot, exists, noteCount: count },
    repository: null,
  };

  if (!repoRoot) return status;

  const index = await readRepoIndex(repoRoot);
  status.repository = {
    root: repoRoot,
    name: index?.identity.name ?? basename(repoRoot),
    summaryCount: (await readSummaries(repoRoot)).length,
  };
  return status;
}

/**
 * One-line status string for footers/status bars. It counts notes; the
 * repository appears only once a deep scan has written summaries, because
 * the structure index is plumbing the user never has to think about.
 */
export function formatStatusLine(status: WorkspaceStatus): string {
  const notes = plural(status.vault.noteCount, "note", "notes");
  const summaries = status.repository?.summaryCount ?? 0;
  return summaries > 0 ? `🕸️ ${notes} · ${plural(summaries, "summary", "summaries")}` : `🕸️ ${notes}`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Multi-line dashboard used by the /weave command and notifications. */
export function formatDashboard(status: WorkspaceStatus): string {
  const lines: string[] = [];
  lines.push(`Vault (${status.vault.root}):`);
  lines.push(
    status.vault.exists
      ? `  ${status.vault.noteCount} note(s)`
      : "  not initialized — add a note to create it",
  );
  const repo = status.repository;
  if (!repo) return lines.join("\n");
  lines.push(`Repository (${repo.name} @ ${repo.root}):`);
  lines.push(
    repo.summaryCount > 0
      ? `  summaries: ${repo.summaryCount} file(s) — run /weave-scan to refresh`
      : "  no file summaries yet — run /weave-scan to write them with your session model",
  );
  return lines.join("\n");
}
