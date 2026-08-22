/**
 * Shared types for pi-weave core.
 *
 * This module — and everything under src/core — must NEVER import from
 * @earendil-works/* or any other harness-specific package. The core is the
 * portable artifact shared by the pi adapter today and the Claude Code /
 * opencode adapters tomorrow (see docs/design.md §21).
 */

/** Where a piece of knowledge came from. Drives trust display (design §13). */
export type NoteSource = "human" | "agent" | "generated";

export const NOTE_SOURCES: readonly NoteSource[] = ["human", "agent", "generated"];

/** Metadata parsed from a vault note's front matter. */
export interface NoteMeta {
  title: string;
  /** ISO-8601 timestamps. */
  created: string;
  updated: string;
  tags: string[];
  source: NoteSource;
}

/** A vault note: metadata plus its Markdown body. */
export interface Note extends NoteMeta {
  /** File-name slug (no extension). Stable identity of the note. */
  slug: string;
  body: string;
}

/** Summary of one note for list/search output. */
export interface NoteSummary extends NoteMeta {
  slug: string;
  /** Size of the Markdown body in characters. */
  bodyLength: number;
}

/** A search hit: the note plus a relevance score and a snippet. */
export interface NoteSearchHit {
  summary: NoteSummary;
  score: number;
  snippet: string;
}

/** Git state snapshot used as the staleness anchor for a repo index. */
export interface GitState {
  headSha: string;
  branch: string;
  /** Tracked-or-untracked files differing from HEAD (porcelain paths). */
  changedFiles: string[];
  /**
   * sha1 of each changed path's worktree content at capture time; null for
   * paths without file content (deletions, untracked directories). Anchors
   * content, not just paths: re-editing an already-dirty file still moves
   * the anchor. Indexes written before this field existed omit it — readers
   * must tolerate its absence.
   */
  changedHashes: Record<string, string | null>;
  capturedAt: string;
}

/** Repository identity (repository/identity.json). */
export interface RepoIdentity {
  name: string;
  root: string;
  remotes: string[];
  defaultBranch: string | null;
}

/** One manifest detected in the repository (package boundary). */
export interface RepoPackage {
  /** Manifest path relative to the repo root, e.g. "packages/core/package.json". */
  manifestPath: string;
  kind: "npm" | "python" | "rust" | "go" | "ruby" | "other";
  /** Package name when it can be read cheaply, else the directory name. */
  name: string;
}

/** A coarse module: a meaningful directory grouping of files. */
export interface RepoModule {
  path: string;
  fileCount: number;
}

/** Structural picture of the repository (repository/structure.json). */
export interface RepoStructure {
  capturedAt: string;
  fileCount: number;
  /** Language name -> file count, e.g. { TypeScript: 12 }. */
  languages: Record<string, number>;
  packages: RepoPackage[];
  modules: RepoModule[];
  /** Likely entry points, repo-relative paths. */
  entryPoints: string[];
  /** Top-level directory listing with direct file counts. */
  topLevel: { name: string; fileCount: number }[];
  /**
   * Files under the derived <repo>/.okf/ index (repo-relative, e.g.
   * "repository/git.json"), captured so the viewer can render `.okf` as an
   * expandable subtree. Absent when there is no `.okf` directory.
   */
  okFiles?: string[];
}

/** The full repository index held under <repo>/.okf/repository/. */
export interface RepoIndex {
  okfVersion: 1;
  scope: "repository";
  generator: string;
  /**
   * Provenance of the whole index (AGENTS.md rule 4). Repository indexes
   * are machine-derived, so this is always "generated" when pi-weave writes
   * them; the reader preserves it so consumers can tell generated knowledge
   * apart from human-authored OKF content.
   */
  source: NoteSource;
  created: string;
  updated: string;
  identity: RepoIdentity;
  git: GitState;
  structure: RepoStructure;
}

export type StalenessState = "missing" | "fresh" | "stale";

export interface StalenessReport {
  state: StalenessState;
  reasons: string[];
}

/** Status of the vault half of the workspace. */
export interface VaultStatus {
  root: string;
  exists: boolean;
  noteCount: number;
}

/** Status of the repository half of the workspace. */
export interface RepoStatus {
  root: string;
  name: string;
  indexed: boolean;
  staleness: StalenessReport;
  /** Deep-scan summaries on disk (docs/scan-modes.md); 0 when none indexed. */
  summaryCount: number;
}

/** Combined knowledge-workspace view for the current directory. */
export interface WorkspaceStatus {
  cwd: string;
  vault: VaultStatus;
  /** null when cwd is not inside a git repository. */
  repository: RepoStatus | null;
}
