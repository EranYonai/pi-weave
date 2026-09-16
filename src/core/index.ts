/**
 * pi-weave core — the portable knowledge engine.
 *
 * NO harness imports allowed in this tree (see docs/design.md §21).
 */
export type { WorkspaceStatus } from "./types";
export { NOTES_DIR, repoIndexDir, resolveVaultRoot } from "./paths";
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
  addNote,
  appendToNote,
  extractRawTail,
  finalizeNote,
  formatNote,
  formatRawAppend,
  getNote,
  listNotes,
  resolveNotePath,
  searchNotes,
} from "./vault";
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
