import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { GitState } from "./types";

/**
 * Minimal git layer for repository knowledge.
 *
 * Every function degrades to `null`/empty instead of throwing: callers are
 * usually answering "is there repo knowledge here?" and must survive
 * detached worktrees, missing git binaries, and non-repo directories.
 */

export interface GitExecOptions {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

async function git(args: string[], cwd: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) resolve(null);
      else resolve(stdout);
    });
  });
}

/** Absolute path of the enclosing git worktree root, or null. */
export async function findGitRoot(cwd: string, options: GitExecOptions = {}): Promise<string | null> {
  const out = await git(["rev-parse", "--show-toplevel"], cwd, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const root = out?.trim();
  if (!root || root.length === 0) return null;
  // Normalize symlinks (macOS /var -> /private/var) so callers always get a
  // canonical, comparable path.
  try {
    return await fs.realpath(root);
  } catch {
    return root;
  }
}

/** Current HEAD sha, or null (unborn branch, not a repo, ...). */
export async function headSha(cwd: string, options: GitExecOptions = {}): Promise<string | null> {
  const out = await git(["rev-parse", "HEAD"], cwd, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const sha = out?.trim();
  return sha && sha.length > 0 ? sha : null;
}

/** Current branch name; null when detached or not a repo. */
export async function currentBranch(cwd: string, options: GitExecOptions = {}): Promise<string | null> {
  const out = await git(["symbolic-ref", "--short", "HEAD"], cwd, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const branch = out?.trim();
  return branch && branch.length > 0 ? branch : null;
}

/** Paths changed in the worktree relative to HEAD (porcelain v1). */
export async function changedFiles(cwd: string, options: GitExecOptions = {}): Promise<string[]> {
  const out = await git(["status", "--porcelain"], cwd, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (out === null) return [];
  return out
    .split("\n")
    .map((line) => line.slice(3).trim()) // drop the 2 status columns + space
    .map((path) => {
      // Renames appear as "old -> new"; the new path is what matters.
      const arrow = path.indexOf(" -> ");
      return arrow >= 0 ? path.slice(arrow + 4) : path;
    })
    .filter((path) => path.length > 0)
    .sort();
}

/** Files git knows about: tracked plus untracked-but-not-ignored. */
export async function listFiles(cwd: string, options: GitExecOptions = {}): Promise<string[] | null> {
  const out = await git(
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    cwd,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  if (out === null) return null;
  return out
    .split("\n")
    .filter((f) => f.length > 0)
    .sort();
}

/** Configured remotes, deduplicated URLs. */
export async function remotes(cwd: string, options: GitExecOptions = {}): Promise<string[]> {
  const out = await git(["remote", "-v"], cwd, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (out === null) return [];
  const urls = new Set<string>();
  for (const line of out.split("\n")) {
    const parts = line.split(/\s+/);
    const url = parts[1];
    if (url) urls.add(url);
  }
  return [...urls].sort();
}

/** Remote default branch (origin/HEAD), null when unknown. */
export async function defaultBranch(cwd: string, options: GitExecOptions = {}): Promise<string | null> {
  const out = await git(
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    cwd,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const ref = out?.trim();
  if (!ref) return null;
  const prefix = "origin/";
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
}

/**
 * Add `.okf/` to the repo's local exclude file (.git/info/exclude) so the
 * derived index stays a local cache by default (design §15, Model A) without
 * touching tracked files. Idempotent; no-op when the git dir is missing.
 */
export async function excludeOkfLocally(repoRoot: string): Promise<void> {
  const infoDir = join(repoRoot, ".git", "info");
  const excludePath = join(infoDir, "exclude");
  let current = "";
  try {
    current = await fs.readFile(excludePath, "utf8");
  } catch {
    // no exclude file yet — we will create it
  }
  const already = current
    .split("\n")
    .map((line) => line.trim())
    .some((line) => line === ".okf/" || line === ".okf");
  if (already) return;
  await fs.mkdir(infoDir, { recursive: true });
  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  await fs.writeFile(excludePath, `${current}${prefix}.okf/\n`, "utf8");
}

/** Snapshot the current git state. Returns null when HEAD does not exist. */
export async function snapshotGitState(cwd: string, options: GitExecOptions = {}): Promise<GitState | null> {
  const sha = await headSha(cwd, options);
  if (!sha) return null;
  return {
    headSha: sha,
    branch: (await currentBranch(cwd, options)) ?? "(detached)",
    changedFiles: await changedFiles(cwd, options),
    capturedAt: new Date().toISOString(),
  };
}
