/** Hand-built GraphModel fixtures shared by the src/core/view suites. */

import type { GraphModel, GraphNode, NodeKind } from "../../../src/core/graph/model";
import type { NoteSource } from "../../../src/core/types";
import type { TreeState } from "../../../src/core/view";

export function node(
  id: string,
  kind: NodeKind,
  label: string,
  provenance: NoteSource | null,
  detail: Record<string, string> = {},
): GraphNode {
  return { id, kind, label, provenance, detail };
}

export function graph(
  nodes: GraphNode[],
  edges: GraphModel["edges"],
  staleness: GraphModel["staleness"] = null,
): GraphModel {
  return { generatedAt: "2026-06-01T00:00:00.000Z", staleness, nodes, edges, danglingLinks: {} };
}

export const NOW = Date.parse("2026-06-01T00:00:00.000Z");

export function treeState(over: Partial<TreeState> = {}): TreeState {
  return { expanded: new Set(["vault", "repository"]), showInternals: false, provFilter: null, query: "", ...over };
}
