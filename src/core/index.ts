/**
 * pi-weave core — the portable knowledge engine.
 *
 * NO harness imports allowed in this tree (see docs/design.md §21).
 */
export * from "./types";
export * from "./slug";
export * from "./frontmatter";
export * from "./languages";
export * from "./mutex";
export * from "./paths";
export * from "./git";
export * from "./vault";
export * from "./repoIndex";
export * from "./summaries";
export * from "./sessions";
export * from "./concurrency";
export * from "./workspace";
export * from "./openInEditor";
export * from "./graph/model";
export * from "./graph/wikilinks";
export * from "./view";
export { buildGraph, dataTimestamp, DEFAULT_MAX_NOTES, type BuildGraphInput } from "./graph/build";
export {
  buildCurrentGraph,
  readNoteForView,
  readOkfFileForView,
  readRepositorySide,
  type ViewNote,
} from "./graph/current";
export {
  classifyPath,
  DEFAULT_STALENESS_TTL_MS,
  WorkspaceCache,
  type CacheStats,
  type InvalidationScope,
  type WorkspaceCacheOptions,
  type WorkspaceSnapshot,
} from "./cache/workspace";
