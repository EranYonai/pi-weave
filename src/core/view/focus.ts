/**
 * focusModel — the 1-hop neighborhood of a node, grouped (weave-workspace §3).
 *
 * The TUI renders this as the Focus surface; the browser workspace uses
 * `focusNeighborhood` for the graph's neighborhood highlight.
 */

import type { GraphEdge, GraphModel, GraphNode, NodeKind } from "../graph/model";
import type { NoteSource } from "../types";
import { listLabel } from "./tree";
import type { SelectableRow } from "./types";

/** 1-hop neighborhood of `id` (the node itself + direct neighbors). 2-hop excluded. */
export function focusNeighborhood(id: string, edges: readonly GraphEdge[]): Set<string> {
  const out = new Set<string>([id]);
  for (const e of edges) {
    if (e.source === id) out.add(e.target);
    if (e.target === id) out.add(e.source);
  }
  return out;
}

/** Incident-edge degree (both directions, all kinds). */
export function degreeOf(id: string, edges: readonly GraphEdge[]): number {
  let d = 0;
  for (const e of edges) if (e.source === id || e.target === id) d++;
  return d;
}

export interface FocusRow extends SelectableRow {
  label: string;
  kind: NodeKind;
  provenance: NoteSource | null;
}

export interface FocusGroup {
  /** Heading label, e.g. "links to →", "← linked from", "contains", "contained by". */
  heading: string;
  rows: FocusRow[];
}

export interface FocusModel {
  center: FocusRow;
  groups: FocusGroup[];
}

/** The outgoing edge kinds that get their own group, in display order. */
const OUTGOING_KINDS = ["links-to", "contains", "anchored-at"] as const;

const OUTGOING_HEADINGS: Record<(typeof OUTGOING_KINDS)[number], string> = {
  "links-to": "links to →",
  contains: "contains",
  "anchored-at": "anchored at",
};

/** Group the 1-hop neighborhood of `id` (outgoing by kind, then incoming). */
export function focusModel(model: GraphModel, id: string): FocusModel {
  const byId = new Map<string, GraphNode>();
  for (const n of model.nodes) byId.set(n.id, n);

  const centerNode = byId.get(id);
  const center: FocusRow = centerNode
    ? rowFromNode(centerNode)
    : { id, label: id, kind: "note", provenance: null };

  const outByKind = new Map<string, string[]>();
  const incomingContains = new Map<string, string[]>();
  const backlinks = new Map<string, string[]>();
  for (const e of model.edges) {
    if (e.source === id) {
      const list = outByKind.get(e.kind);
      if (list) list.push(e.target);
      else outByKind.set(e.kind, [e.target]);
    } else if (e.target === id) {
      if (e.kind === "links-to") {
        const list = backlinks.get(e.kind);
        if (list) list.push(e.source);
        else backlinks.set(e.kind, [e.source]);
      } else if (e.kind === "contains" || e.kind === "anchored-at") {
        const list = incomingContains.get(e.kind);
        if (list) list.push(e.source);
        else incomingContains.set(e.kind, [e.source]);
      }
    }
  }

  const toRows = (ids: string[]): FocusRow[] =>
    ids
      .map((x) => byId.get(x))
      .filter((n): n is GraphNode => n !== undefined)
      .map(rowFromNode);

  const groups: FocusGroup[] = [];
  for (const kind of OUTGOING_KINDS) {
    const ids = outByKind.get(kind) ?? [];
    if (ids.length === 0) continue;
    groups.push({ heading: OUTGOING_HEADINGS[kind], rows: toRows(ids) });
  }
  const bl = backlinks.get("links-to") ?? [];
  if (bl.length > 0) groups.push({ heading: "← linked from", rows: toRows(bl) });
  const containedBy = incomingContains.get("contains") ?? incomingContains.get("anchored-at") ?? [];
  if (containedBy.length > 0) groups.push({ heading: "contained by", rows: toRows(containedBy) });

  return { center, groups };
}

function rowFromNode(n: GraphNode): FocusRow {
  return { id: n.id, target: n.id, label: listLabel(n), kind: n.kind, provenance: n.provenance };
}
