/**
 * pi-weave core — the portable knowledge engine.
 *
 * NO harness imports allowed in this tree (see docs/design.md §21).
 */
export type { WorkspaceStatus } from "./types";
export { NOTES_DIR, SESSIONS_DIR, repoIndexDir, resolveVaultRoot } from "./paths";
export { findGitRoot } from "./git";
export {
  assessStaleness,
  buildRepoIndex,
  readRepoIndex,
  summarizeIndex,
  writeRepoIndex,
} from "./repoIndex";
export { runDeepScan, type DeepScanOptions, type DeepScanResult, type SummarizeFn } from "./summaries";
export {
  DEFAULT_SESSIONS_ROOT,
  SESSIONS_ENV_VAR,
  deriveSessionTitle,
  listSessionFiles,
  migrateLegacySessionNotes,
  parseSessionDigest,
  peekSessionHeader,
  projectTagOf,
  readSessionNoteIndex,
  renderSessionDigest,
  resolveSessionsRoot,
  runSessionScan,
  sessionHasContent,
  sessionNoteBody,
  sessionNoteFields,
  sessionNoteTags,
  writeSessionNote,
  type SessionChain,
  type SessionDigest,
  type SessionScanOptions,
  type SessionScanResult,
} from "./sessions";
export {
  addNote,
  appendToNote,
  createFolder,
  deleteFolder,
  deleteNote,
  extractRawTail,
  finalizeNote,
  formatNote,
  formatRawAppend,
  getHtmlArtifact,
  getNote,
  listNotes,
  moveNote,
  parseHtmlArtifact,
  renameFolder,
  readVault,
  renameNote,
  repairVaultLinks,
  resolveHtmlPath,
  resolveNotePath,
  searchNotes,
  setNoteBody,
  upsertNote,
  type LinkRepairResult,
} from "./vault";
export {
  suggestLinks,
  type LinkSuggestion,
  type SuggestOptions,
  type SuggestionReport,
} from "./links/similar";
export {
  auditLinks,
  rewriteLinks,
  scanLinks,
  type AmbiguousLink,
  type LinkAudit,
  type LinkFix,
  type UnresolvableLink,
} from "./links/repair";
export type { HtmlArtifact } from "./types";
export { withMutationQueue } from "./mutex";
export { formatDashboard, formatStatusLine, getWorkspaceStatus } from "./workspace";
export { WorkspaceCache } from "./cache/workspace";
export {
  buildCurrentGraph,
  readNoteForView,
  readOkfFileForView,
  readRepositorySide,
  type ViewNote,
} from "./graph/current";
