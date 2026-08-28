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
  /**
   * slug → wiki-link targets that resolved to no note in the graph
   * (weave-workspace §4.2).
   *
   * A `[[target]]` that matches nothing is not an error — it is Obsidian's
   * ghost node, the affordance that offers to create the missing note. The
   * builder used to count these and throw the names away, leaving
   * `detail["dangling links"] = "3"` as the only trace; a display string is
   * not something a UI can navigate.
   *
   * Lives here rather than on {@link GraphNode} because `detail` is
   * display-only by contract and must not grow structure (§4.2 is explicit
   * about preferring the model-level map). Notes with nothing unresolved are
   * absent rather than present-and-empty, so the common case costs no bytes.
   *
   * Keyed by **slug**, not by node id: the consumers of this map (the note
   * column, the wire payload's `dangling` field) speak slugs, and `note:` is
   * a graph-internal prefix.
   *
   * Insertion order follows note order and each target list follows
   * first-appearance order in the body, so the JSON stays byte-stable for
   * unchanged inputs.
   */
  danglingLinks: Record<string, string[]>;
  /**
   * Content fingerprint of the note bodies the graph was built from
   * (SHA-256 over `slug\0body-digest` pairs in slug order, truncated to
   * 128 bits of hex).
   *
   * Exists so the wire payload's stamp — the digest the ETag and the SSE
   * dedupe both key on — is sensitive to a **body-only** edit. The payload
   * itself carries only display excerpts of a note (`detail.preview`, the
   * first 240 flattened characters), so an edit below the fold with
   * unchanged front matter used to leave the payload byte-identical: the
   * frame was deduped away and the open note stayed stale until a manual
   * reload. The digest is a function of content only, so it keeps the
   * byte-determinism contract.
   */
  contentDigest: string;
}
