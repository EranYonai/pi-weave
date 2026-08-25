/**
 * detailModel — a selected node's meta + links + backlinks (weave-workspace §3).
 *
 * The note body is *not* part of this model: it is loaded async by whichever
 * renderer needs it (`readNoteForView` / `readOkfFileForView`).
 */

import type { GraphModel, GraphNode, NodeKind } from "../graph/model";
import type { NoteSource } from "../types";
import { listLabel } from "./tree";
import type { SelectableRow } from "./types";

export interface DetailMetaRow extends SelectableRow {
  label: string;
  value: string;
}

export interface DetailLinkRow extends SelectableRow {
  label: string;
  kind: NodeKind;
  provenance: NoteSource | null;
  /** "link" (outgoing) or "backlink" (incoming). */
  direction: "link" | "backlink";
}

export interface DetailModel {
  id: string;
  label: string;
  kind: NodeKind;
  provenance: NoteSource | null;
  meta: DetailMetaRow[];
  links: DetailLinkRow[];
  backlinks: DetailLinkRow[];
}

/** Ordered meta keys shown in the detail header (weave-view-tui-design §5.2). */
const META_ORDER = [
  "path",
  "slug",
  "source",
  "updated",
  "created",
  "tags",
  "files",
  "languages",
  "branch",
  "commit",
  "uncommitted changes",
  "captured",
  "manifest",
  "kind",
  "url",
  "summarized files",
  "summarized by",
  "summarized at",
  "summary",
  "dangling links",
  "warning",
  "stale",
  "preview",
  "root",
  "notes",
  "state",
] as const;

export function detailModel(model: GraphModel, id: string): DetailModel | null {
  const byId = new Map<string, GraphNode>();
  for (const n of model.nodes) byId.set(n.id, n);
  const node = byId.get(id);
  if (!node) return null;

  const meta: DetailMetaRow[] = [];
  for (const key of META_ORDER) {
    const v = node.detail[key];
    if (v === undefined || v === "") continue;
    meta.push({ id: `meta:${key}`, label: key, value: v });
  }

  const links: DetailLinkRow[] = [];
  for (const e of model.edges) {
    if (e.source !== id) continue;
    const t = byId.get(e.target);
    if (!t) continue;
    links.push({
      id: `link:${e.kind}:${e.target}`,
      target: e.target,
      label: `${e.kind} → ${listLabel(t)}`,
      kind: t.kind,
      provenance: t.provenance,
      direction: "link",
    });
  }

  const backlinks: DetailLinkRow[] = [];
  for (const e of model.edges) {
    if (e.kind !== "links-to" || e.target !== id) continue;
    const s = byId.get(e.source);
    if (!s) continue;
    backlinks.push({
      id: `backlink:${e.source}`,
      target: e.source,
      label: `← ${listLabel(s)}`,
      kind: s.kind,
      provenance: s.provenance,
      direction: "backlink",
    });
  }

  return {
    id,
    label: listLabel(node),
    kind: node.kind,
    provenance: node.provenance,
    meta,
    links,
    backlinks,
  };
}
