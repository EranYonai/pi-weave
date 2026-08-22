/**
 * Graph model shared between the builder (core) and the viewer (adapter).
 * Pure data — no harness imports (design §21). See docs/weave-view.md §3.
 */

import type { NoteSource, StalenessReport } from "../types";

export type NodeKind =
  | "vault"
  | "note"
  | "repository"
  | "module"
  | "package"
  | "entryPoint"
  | "gitState"
  | "external"
  | "file";

export type EdgeKind = "contains" | "anchored-at" | "links-to" | "mentions";

/** All node kinds — the viewer legend and tests iterate this list. */
export const NODE_KINDS: readonly NodeKind[] = [
  "vault",
  "note",
  "repository",
  "module",
  "package",
  "entryPoint",
  "gitState",
  "external",
  "file",
];

/** All edge kinds — the viewer legend and tests iterate this list. */
export const EDGE_KINDS: readonly EdgeKind[] = ["contains", "anchored-at", "links-to", "mentions"];

/** A single graph node. `id` is stable: derived from slugs/paths only. */
export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  /** Trust provenance for knowledge nodes; null for structural nodes. */
  provenance: NoteSource | null;
  /** Pre-formatted side-panel payload. */
  detail: Record<string, string>;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: EdgeKind;
}

export interface GraphModel {
  /**
   * Data-as-of marker derived from inputs (max note updated / index stamp),
   * so two builds of unchanged inputs produce byte-identical JSON.
   */
  generatedAt: string;
  staleness: StalenessReport | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
}
