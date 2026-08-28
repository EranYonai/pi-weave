/**
 * clusterAggregate — collapse containment subtrees into their parent node
 * (weave-workspace §3, §7.4).
 *
 * A repository graph is mostly containment: a handful of roots, then modules,
 * then hundreds or thousands of files. Drawn flat that is a hairball, and
 * scrolled flat it is a wall. The fix is *graph reduction*, not rendering:
 * given the model and the set of ids the user has expanded, produce a smaller
 * graph where every collapsed subtree is represented by the node that contains
 * it, with the edges that crossed the boundary retargeted onto that node.
 *
 * Because it is reduction, it lives in core and is shared: the sigma graph
 * panel (§7.4) consumes `nodes`/`edges` directly, and the TUI tree can consume
 * the same `clusters` map for its child counts and provenance rollups. One
 * implementation, so the two surfaces cannot disagree about what "collapsed"
 * means.
 *
 * ## Relationship to the retired viewer
 *
 * The retired `page.ts` had a function of the same name. It computed a
 * *visibility mask* — every node stayed in the graph and hidden ones were
 * given `display: none` — and it never rewrote a single edge, so a link from a
 * hidden file to a visible note simply vanished. Two deliberate changes:
 *
 * 1. **Reduction, not masking.** We return the reduced node and edge arrays.
 *    A renderer should never be handed nodes it is expected to hide, and
 *    sigma in particular wants a graph it can consume verbatim (§7.1).
 * 2. **Strict collapse.** The retired `reveal` recursed into *every* child
 *    cluster regardless of the expand set, gating only leaves — so collapsing
 *    `src/core` still drew all of its sub-clusters. That contradicts both the
 *    word "collapse" and {@link treeRows}, which recurses only into expanded
 *    nodes. Here a collapsed cluster hides its entire subtree, so the TUI tree
 *    and the web graph answer "what is visible?" identically.
 *
 * Retained from the original: containment means `contains` **or**
 * `anchored-at`; clusters are real model nodes rather than synthetic ones (so
 * ids stay stable and selection keeps working); and the per-cluster provenance
 * rollup over all descendants.
 *
 * The original's `expandChildren` / `collapseChildren` set builders are *not*
 * ported. They only existed to walk the model a second time, which
 * {@link ClusterInfo.descendants} already did, and each is now one expression
 * on the caller's side:
 *
 * ```ts
 * const under = agg.clusters.get(id)!.descendants.filter((d) => agg.clusters.has(d));
 * const expandAll = new Set([...expanded, id, ...under]);
 * const collapse = new Set([...expanded].filter((e) => e !== id && !under.includes(e)));
 * ```
 */

import type { EdgeKind, GraphEdge, GraphModel, GraphNode } from "../graph/model";
import type { NoteSource } from "../types";
import { graphRoots } from "./tree";

/** The edge kinds that form the nesting hierarchy. Matches `treeRows`. */
const CONTAINMENT: readonly EdgeKind[] = ["contains", "anchored-at"];

function isContainment(kind: EdgeKind): boolean {
  return CONTAINMENT.includes(kind);
}

/** Provenance rollup over a cluster's descendants (the ring / mini-bar source). */
export interface ProvenanceSplit {
  human: number;
  agent: number;
  generated: number;
  /** Descendants with no provenance — modules, files, git state, packages. */
  none: number;
}

/** What is known about one cluster: any node with at least one containment child. */
export interface ClusterInfo {
  /** Direct containment children, de-duplicated, in model edge order. */
  readonly children: readonly string[];
  /** Every transitive containment descendant, de-duplicated, depth-first. */
  readonly descendants: readonly string[];
  /**
   * The hidden descendants this cluster is currently standing in for — the
   * cluster → members direction of the mapping, and what a "12 files" badge
   * counts.
   *
   * Empty unless the cluster is *both* visible and collapsed: an expanded
   * cluster hides nothing, and a cluster that is itself hidden is already
   * represented by an ancestor. So `members` partitions {@link
   * ClusterAggregate.hidden} across the visible clusters, whereas
   * {@link descendants} overlaps freely between a cluster and its ancestors.
   */
  readonly members: readonly string[];
  /** Provenance counts over {@link descendants} (the cluster itself excluded). */
  readonly provenance: ProvenanceSplit;
  /** Whether `expanded` contained this id. */
  readonly expanded: boolean;
}

export interface ClusterAggregate {
  /** The visible nodes, in model order. A subset of `model.nodes`. */
  nodes: GraphNode[];
  /**
   * Edges between visible nodes, in model order. Endpoints inside a collapsed
   * cluster are retargeted onto that cluster; the resulting duplicates and
   * self-loops are dropped.
   */
  edges: GraphEdge[];
  /**
   * Every node with at least one containment child, whether or not it is
   * visible or expanded — a caller implementing "expand all" filters
   * `descendants` through this map.
   */
  clusters: Map<string, ClusterInfo>;
  /** Ids not present in {@link nodes}. */
  hidden: Set<string>;
  /**
   * Hidden id → the visible cluster representing it. The member → cluster
   * direction of the mapping; the inverse of {@link ClusterInfo.members}.
   */
  representative: Map<string, string>;
  /** Containment roots, in model order (always visible). */
  roots: string[];
}

/**
 * Reduce `model` to the subgraph implied by `expanded`.
 *
 * A node is visible when every containment ancestor between it and a root is
 * expanded. Roots are always visible, so an empty `expanded` set yields the
 * roots alone — the maximally collapsed view.
 *
 * Deterministic for a deterministic model: every output is ordered by the
 * model's own node and edge order, and a node reachable through more than one
 * parent is attributed to the first one encountered.
 *
 * Defensive on malformed input, which core cannot rule out for a hand-written
 * or partially-rebuilt `.okf` index: containment cycles terminate, and an edge
 * naming an id that is not in the node set is dropped rather than emitted (a
 * renderer given an edge to a non-existent node throws).
 */
export function clusterAggregate(model: GraphModel, expanded: ReadonlySet<string>): ClusterAggregate {
  const byId = new Map<string, GraphNode>();
  for (const n of model.nodes) byId.set(n.id, n);

  const children = indexChildren(model, byId);
  const roots = graphRoots(model);

  // Visible = reachable from a root without passing through a collapsed node.
  const visible = new Set<string>();
  const reveal = (id: string): void => {
    if (visible.has(id)) return; // also the cycle guard
    visible.add(id);
    if (!expanded.has(id)) return;
    for (const child of children.get(id) ?? []) reveal(child);
  };
  for (const r of roots) reveal(r);

  // Descendants, computed once per cluster and reused for members + provenance.
  const descendantsOf = new Map<string, string[]>();
  for (const id of children.keys()) descendantsOf.set(id, descendants(id, children));

  // Hidden id → nearest visible ancestor. Visible collapsed clusters are the
  // only things that can represent anything; walking them in model order and
  // never overwriting makes multi-parent attribution deterministic.
  const representative = new Map<string, string>();
  for (const n of model.nodes) {
    if (!visible.has(n.id) || expanded.has(n.id)) continue;
    for (const d of descendantsOf.get(n.id) ?? []) {
      if (!visible.has(d) && !representative.has(d)) representative.set(d, n.id);
    }
  }

  // A containment cycle with no root above it is reachable from nowhere, so it
  // is neither visible nor represented. Show it: dropping it silently would
  // lose data the caller has no other way to see.
  for (const n of model.nodes) {
    if (!visible.has(n.id) && !representative.has(n.id)) visible.add(n.id);
  }

  const clusters = new Map<string, ClusterInfo>();
  for (const [id, kids] of children) {
    // Populated from `children.keys()` immediately above, so this is total.
    const desc = descendantsOf.get(id)!;
    clusters.set(id, {
      children: kids,
      descendants: desc,
      members: desc.filter((d) => representative.get(d) === id),
      provenance: splitOf(desc, byId),
      expanded: expanded.has(id),
    });
  }

  const hidden = new Set<string>();
  const nodes: GraphNode[] = [];
  for (const n of model.nodes) {
    if (visible.has(n.id)) nodes.push(n);
    else hidden.add(n.id);
  }

  return { nodes, edges: rewrite(model.edges, visible, representative), clusters, hidden, representative, roots };
}

/** Direct containment children per parent, de-duplicated, in model edge order. */
function indexChildren(model: GraphModel, byId: Map<string, GraphNode>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of model.edges) {
    if (!isContainment(e.kind)) continue;
    // An edge to an id that is not a node cannot be collapsed into anything.
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    const list = out.get(e.source);
    if (list === undefined) out.set(e.source, [e.target]);
    else if (!list.includes(e.target)) list.push(e.target);
  }
  return out;
}

/** Transitive containment descendants of `id`, depth-first, cycle-safe. */
function descendants(id: string, children: Map<string, string[]>): string[] {
  const out: string[] = [];
  const seen = new Set<string>([id]);
  const walk = (at: string): void => {
    for (const child of children.get(at) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      walk(child);
    }
  };
  walk(id);
  return out;
}

function splitOf(ids: readonly string[], byId: Map<string, GraphNode>): ProvenanceSplit {
  const split: ProvenanceSplit = { human: 0, agent: 0, generated: 0, none: 0 };
  for (const id of ids) {
    const provenance: NoteSource | null = byId.get(id)?.provenance ?? null;
    if (provenance === null) split.none++;
    else split[provenance]++;
  }
  return split;
}

/**
 * Retarget each edge onto visible endpoints, then drop the self-loops (both
 * ends fell into the same cluster) and the duplicates (many crossings of the
 * same boundary collapse to one). Kind is preserved and participates in the
 * de-duplication, so a `contains` and a `links-to` between the same pair both
 * survive.
 */
function rewrite(edges: readonly GraphEdge[], visible: ReadonlySet<string>, representative: ReadonlyMap<string, string>): GraphEdge[] {
  const resolve = (id: string): string | undefined => (visible.has(id) ? id : representative.get(id));
  const out: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    const source = resolve(e.source);
    const target = resolve(e.target);
    if (source === undefined || target === undefined) continue;
    if (source === target) continue;
    const key = `${source}\u0000${target}\u0000${e.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ source, target, kind: e.kind });
  }
  return out;
}
