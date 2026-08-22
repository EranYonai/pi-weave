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
export * from "./workspace";
export * from "./graph/model";
export * from "./graph/wikilinks";
export { buildGraph, dataTimestamp, DEFAULT_MAX_NOTES, type BuildGraphInput } from "./graph/build";
