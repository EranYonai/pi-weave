import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Canonical locations for pi-weave knowledge (design Appendix A).
 *
 *  - Vault:            ~/.okf/            (human/agent persistent knowledge)
 *  - Repository index: <git root>/.okf/   (derived machine knowledge)
 *
 * The vault location can be overridden with PI_WEAVE_VAULT, primarily for
 * tests and for users who keep their vault somewhere unusual.
 */

export const OKF_DIR = ".okf";
export const OKF_MANIFEST = "okf.json";
export const NOTES_DIR = "notes";
/**
 * Vault collection for generated session memory (docs/session-scan.md).
 * A sibling of `notes/` rather than a subdirectory of it: session notes are
 * machine-derived memory, not hand-curated knowledge, so they stay out of
 * the note graph's flat listing — and out of its slug namespace.
 */
export const SESSIONS_DIR = "sessions";
export const REPOSITORY_DIR = "repository";
export const VAULT_ENV_VAR = "PI_WEAVE_VAULT";

/** Resolve the vault root. `env` is injectable for tests. */
export function resolveVaultRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[VAULT_ENV_VAR];
  if (override && override.trim().length > 0) {
    return override;
  }
  return join(homedir(), OKF_DIR);
}

/** The repository index directory for a given repo root. */
export function repoIndexDir(repoRoot: string): string {
  return join(repoRoot, OKF_DIR);
}

/** Subdirectory of an .okf index holding repository knowledge. */
export function repoKnowledgeDir(repoRoot: string): string {
  return join(repoRoot, OKF_DIR, REPOSITORY_DIR);
}
