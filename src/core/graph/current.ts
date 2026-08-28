/**
 * Workspace assembly readers for the viewers (docs/weave-view.md §2,
 * weave-view-tui-design §3.1).
 *
 * These functions are *workspace assembly*, symmetric to `getWorkspaceStatus`
 * (already in core): pure fan-out over `core/vault`, `core/repoIndex`,
 * `core/summaries`, `core/git`, then the pure `buildGraph`. They import only
 * core + node builtins, so a future Claude Code / opencode adapter can
 * assemble the same graph without importing pi's viewer directory.
 */

import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
// Imported from the individual modules rather than the `../index` barrel:
// `src/core/cache/workspace` imports this file, and the barrel re-exports
// that cache, so going through the barrel would close an import cycle.
import { findGitRoot } from "../git";
import { resolveVaultRoot } from "../paths";
import { assessStaleness, readRepoIndex } from "../repoIndex";
import { readSummaryMap } from "../summaries";
import type { Note } from "../types";
import { getNote, readVault, resolveNotePath } from "../vault";
import { buildGraph, DEFAULT_MAX_NOTES, type BuildGraphInput } from "./build";
import type { GraphModel } from "./model";

/** A note read for the viewers (read-only; never cached). Mirrors the vault `Note` shape. */
export interface ViewNote {
  slug: string;
  title: string;
  body: string;
  created: string;
  updated: string;
  tags: string[];
  source: Note["source"];
}

/**
 * Live-read one note for the viewer's side panel / TUI detail (read-only;
 * never caches). Traversal-safe: an unsafe slug returns null without
 * touching disk.
 */
export async function readNoteForView(vaultRoot: string, slug: string): Promise<ViewNote | null> {
  if (resolveNotePath(vaultRoot, slug) === null) return null; // traversal-safe
  const note = await getNote(vaultRoot, slug);
  if (note === null) return null;
  return {
    slug: note.slug,
    title: note.title,
    body: note.body,
    created: note.created,
    updated: note.updated,
    tags: note.tags,
    source: note.source,
  };
}

/**
 * Read one derived index file under <cwd>/.okf for the viewers
 * (traversal-safe). The `rel` path is anchored to <cwd>/.okf, so
 * summary/identity/structure bodies can be shown instead of "(no body)".
 */
export async function readOkfFileForView(cwd: string, rel: string): Promise<{ path: string; body: string } | null> {
  const okfRoot = join(cwd, ".okf");
  const resolved = resolve(okfRoot, rel);
  if (resolved !== okfRoot && !resolved.startsWith(okfRoot + sep)) return null; // traversal-safe
  try {
    const body = await readFile(resolved, "utf8");
    return { path: rel, body };
  } catch {
    return null;
  }
}

/**
 * Assemble the repository half of the graph input for `cwd`, or null when
 * cwd is not inside a git repository with a readable `.okf` index. Shared
 * with `src/core/cache/workspace` so the cached and uncached paths cannot
 * drift in what they read.
 */
export async function readRepositorySide(
  cwd: string,
): Promise<Pick<BuildGraphInput, "repository" | "summaries"> | null> {
  const repoRoot = await findGitRoot(cwd);
  if (repoRoot === null) return null;
  const index = await readRepoIndex(repoRoot);
  if (index === null) return null;
  return {
    repository: { index, staleness: await assessStaleness(repoRoot) },
    summaries: await readSummaryMap(repoRoot), // deep-scan sidecars, read live
  };
}

/**
 * Assemble the fresh graph from disk. Called on every viewer fetch
 * (no caching — docs/weave-view.md §2). Reads the vault (capped at
 * DEFAULT_MAX_NOTES) and, when cwd is an indexed git repository, the repo
 * index + deep-scan summary sidecars. Degrades to a vault-only graph when
 * the repo has no index or the index is corrupt.
 *
 * One read per note: `readVault` returns bodies *and* the file count, so the
 * old `listNotes` → `getNote`-per-slug → `noteCount` sequence (2N reads plus
 * a third readdir) is now N reads and one readdir (weave-workspace §4.1).
 */
export async function buildCurrentGraph(cwd: string, vaultRoot: string = resolveVaultRoot()): Promise<GraphModel> {
  const { notes, fileCount } = await readVault(vaultRoot);

  const input: BuildGraphInput = {
    vault: { root: vaultRoot, exists: true, noteCount: fileCount },
    notes: notes.slice(0, DEFAULT_MAX_NOTES),
    repository: null,
  };

  const repo = await readRepositorySide(cwd);
  if (repo !== null) {
    input.repository = repo.repository;
    if (repo.summaries !== undefined) input.summaries = repo.summaries;
  }
  return buildGraph(input);
}

