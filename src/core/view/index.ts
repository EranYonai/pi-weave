/**
 * src/core/view — portable, renderer-agnostic view-models (weave-workspace §3).
 *
 * One implementation of the tree, detail, focus, and health projections, shared
 * by the pi TUI and the browser workspace so they can never drift. Pure
 * functions over `GraphModel`; no harness, no DOM, no terminal concepts.
 */
export * from "./types";
export * from "./time";
export * from "./tree";
export * from "./detail";
export * from "./focus";
export * from "./links";
export * from "./health";
export * from "./cluster";
