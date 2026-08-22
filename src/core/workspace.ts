import { findGitRoot } from "./git";
import { assessStaleness, readRepoIndex } from "./repoIndex";
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
  const staleness = await assessStaleness(repoRoot);
  status.repository = {
    root: repoRoot,
    name: index?.identity.name ?? basename(repoRoot),
    indexed: index !== null,
    staleness,
  };
  return status;
}

/** One-line status string for footers/status bars. */
export function formatStatusLine(status: WorkspaceStatus): string {
  const vault = `vault:${status.vault.noteCount}`;
  if (!status.repository) return `🧵 ${vault}`;
  if (!status.repository.indexed) return `🧵 ${vault} · repo:unindexed`;
  const mark = status.repository.staleness.state === "fresh" ? "ok" : status.repository.staleness.state;
  return `🧵 ${vault} · ${status.repository.name}:${mark}`;
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
  if (!status.repository) {
    lines.push("Repository: none (not inside a git repository)");
    return lines.join("\n");
  }
  const repo = status.repository;
  lines.push(`Repository (${repo.name} @ ${repo.root}):`);
  if (!repo.indexed) {
    lines.push("  not indexed — run a repository scan or ask pi to explore");
    return lines.join("\n");
  }
  lines.push(`  index: ${repo.staleness.state}`);
  for (const reason of repo.staleness.reasons) {
    lines.push(`    - ${reason}`);
  }
  return lines.join("\n");
}
