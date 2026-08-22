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
import {
  assessStaleness,
  buildGraph,
  DEFAULT_MAX_NOTES,
  findGitRoot,
  getNote,
  listNotes,
  noteCount,
  readRepoIndex,
  readSummaryMap,
  resolveNotePath,
  resolveVaultRoot,
  type BuildGraphInput,
  type GraphModel,
  type Note,
} from "../index";

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
 * Assemble the fresh graph from disk. Called on every viewer fetch
 * (no caching — docs/weave-view.md §2). Reads the vault (capped at
 * DEFAULT_MAX_NOTES) and, when cwd is an indexed git repository, the repo
 * index + deep-scan summary sidecars. Degrades to a vault-only graph when
 * the repo has no index or the index is corrupt.
 */
export async function buildCurrentGraph(cwd: string, vaultRoot: string = resolveVaultRoot()): Promise<GraphModel> {
  const noteSummaries = (await listNotes(vaultRoot)).slice(0, DEFAULT_MAX_NOTES);
  const loaded = await Promise.all(noteSummaries.map((s) => getNote(vaultRoot, s.slug)));
  const notes = loaded.filter((n): n is Note => n !== null);

  const input: BuildGraphInput = {
    vault: { root: vaultRoot, exists: true, noteCount: await noteCount(vaultRoot) },
    notes,
    repository: null,
  };

  const repoRoot = await findGitRoot(cwd);
  if (repoRoot !== null) {
    const index = await readRepoIndex(repoRoot);
    if (index !== null) {
      input.repository = { index, staleness: await assessStaleness(repoRoot) };
      input.summaries = await readSummaryMap(repoRoot); // deep-scan sidecars, read live
    }
  }
  return buildGraph(input);
}

