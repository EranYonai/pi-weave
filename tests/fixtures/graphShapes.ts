/**
 * Graph-shape generators for the layout dynamics gate (weave-workspace §8).
 *
 * Every shape here is a *valid* `GraphModel` — the same type `buildGraph`
 * emits — so the layout engine is exercised through its real contract. The
 * set is chosen adversarially: each shape is one of the ways the retired
 * simulation degenerated.
 *
 * | Generator            | What it proves                                   |
 * | -------------------- | ------------------------------------------------ |
 * | `repoLikeGraph`      | the real case: 5 roots, one with ~60 children     |
 * | `coincidentGraph`    | symmetry breaking from an exactly-shared point    |
 * | `disconnectedGraph`  | components separate, neither escapes to infinity  |
 * | `starGraph`          | hub leaves form a ring, not a line                |
 * | `singleNodeGraph`    | no NaN, no crash                                  |
 * | `emptyGraph`         | no NaN, no crash                                  |
 * | `pathologicalGraph`  | self-edges and edges to missing ids are survivable|
 */

import type { GraphEdge, GraphModel, GraphNode, NodeKind } from "../../src/core/graph/model";
import type { NoteSource } from "../../src/core/types";

/** Fixed stamp: fixtures must never depend on the wall clock. */
const STAMP = "2026-08-24T00:00:00.000Z";

function node(id: string, kind: NodeKind, label = id, provenance: NoteSource | null = null): GraphNode {
  return { id, kind, label, provenance, detail: {} };
}

function edge(source: string, target: string, kind: GraphEdge["kind"] = "contains"): GraphEdge {
  return { source, target, kind };
}

function model(nodes: GraphNode[], edges: GraphEdge[]): GraphModel {
  return { generatedAt: STAMP, staleness: null, nodes, edges, danglingLinks: {}, contentDigest: "" };
}

/** Zero-padded suffix so ids sort the way they were generated. */
function pad(i: number): string {
  return String(i).padStart(3, "0");
}

/**
 * This repository's actual shape (weave-workspace §8): five top-level roots —
 * vault, repository, modules, git-state, external — where `repository` carries
 * a ~60-child containment fan. That hub is the hairball risk and the exact
 * case the graph column must render well.
 *
 * A handful of `links-to` edges cross cluster boundaries, because real vaults
 * link notes to modules; they make cluster separation a genuine test rather
 * than a restatement of the seeding.
 */
export function repoLikeGraph(): GraphModel {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // 1. vault — 14 notes, cross-linked.
  nodes.push(node("vault", "vault", "Vault"));
  const sources: NoteSource[] = ["human", "agent", "generated"];
  for (let i = 0; i < 14; i++) {
    const id = `note:n${pad(i)}`;
    nodes.push(node(id, "note", `Note ${pad(i)}`, sources[i % 3] ?? "human"));
    edges.push(edge("vault", id));
  }
  // A sparse, deterministic wiki-link web inside the vault.
  for (let i = 0; i < 9; i++) {
    edges.push(edge(`note:n${pad(i)}`, `note:n${pad((i * 5 + 3) % 14)}`, "links-to"));
  }

  // 2. repository — the 60-child hub.
  nodes.push(node("repository", "repository", "pi-weave"));
  for (let i = 0; i < 60; i++) {
    const id = `module:src/m${pad(i)}`;
    nodes.push(node(id, "module", `src/m${pad(i)}`));
    edges.push(edge("repository", id));
  }

  // 3. modules — a small second fan with one level of nesting.
  nodes.push(node("modules", "module", "modules"));
  for (let i = 0; i < 8; i++) {
    const id = `file:mod${pad(i)}.ts`;
    nodes.push(node(id, "file", `mod${pad(i)}.ts`));
    edges.push(edge("modules", id));
  }

  // 4. git-state — anchored children.
  nodes.push(node("gitState", "gitState", "main @ 0f1e2d3"));
  for (let i = 0; i < 3; i++) {
    const id = `file:changed${pad(i)}`;
    nodes.push(node(id, "file", `changed${pad(i)}`));
    edges.push(edge("gitState", id, "anchored-at"));
  }

  // 5. external / packages.
  nodes.push(node("external", "external", "remotes"));
  for (let i = 0; i < 4; i++) {
    const id = `package:pkg${pad(i)}/package.json`;
    nodes.push(node(id, "package", `pkg${pad(i)}`));
    edges.push(edge("external", id));
  }

  // Cross-cluster references — notes that point at code.
  edges.push(edge("note:n000", "module:src/m000", "links-to"));
  edges.push(edge("note:n003", "module:src/m031", "links-to"));
  edges.push(edge("note:n007", "file:mod002.ts", "mentions"));

  return model(nodes, edges);
}

/** The five containment roots of {@link repoLikeGraph}, in fixture order. */
export const REPO_LIKE_ROOTS: readonly string[] = ["vault", "repository", "modules", "gitState", "external"];

/**
 * `n` mutually unconnected nodes. Paired with `coincidentPositions` this is
 * the symmetry-breaking probe: every node starts at *exactly* the same point,
 * which is the state in which a `dx / d` repulsion term is identically zero
 * and the retired simulation froze forever.
 */
export function coincidentGraph(n: number): GraphModel {
  const nodes: GraphNode[] = [];
  for (let i = 0; i < n; i++) nodes.push(node(`c${pad(i)}`, "note", `Coincident ${pad(i)}`, "agent"));
  return model(nodes, []);
}

/** Seed every node of `m` at the identical point. */
export function coincidentPositions(m: GraphModel, at: { x: number; y: number }): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  for (const n of m.nodes) out.set(n.id, { x: at.x, y: at.y });
  return out;
}

/** Two containment trees with no edge between them. Must separate, must stay finite. */
export function disconnectedGraph(): GraphModel {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (const [root, kids] of [
    ["alpha", 12],
    ["beta", 9],
  ] as const) {
    nodes.push(node(root, "module", root));
    for (let i = 0; i < kids; i++) {
      const id = `${root}:leaf${pad(i)}`;
      nodes.push(node(id, "file", `${root} leaf ${pad(i)}`));
      edges.push(edge(root, id));
    }
  }
  return model(nodes, edges);
}

/** The two component roots of {@link disconnectedGraph}. */
export const DISCONNECTED_ROOTS: readonly string[] = ["alpha", "beta"];

/**
 * A star of `total` nodes: one hub plus `total - 1` leaves, all `contains`.
 * The pure high-degree-hub case — leaves must ring the hub.
 */
export function starGraph(total: number): GraphModel {
  const nodes: GraphNode[] = [node("hub", "repository", "hub")];
  const edges: GraphEdge[] = [];
  for (let i = 1; i < total; i++) {
    const id = `leaf${pad(i)}`;
    nodes.push(node(id, "file", `leaf ${pad(i)}`));
    edges.push(edge("hub", id));
  }
  return model(nodes, edges);
}

/** One node, no edges. */
export function singleNodeGraph(): GraphModel {
  return model([node("only", "note", "Only", "human")], []);
}

/** No nodes, no edges. */
export function emptyGraph(): GraphModel {
  return model([], []);
}

/**
 * Malformed-but-plausible input: a self-edge, an edge whose source is missing,
 * an edge whose target is missing, and a duplicate edge. `buildGraph` should
 * not emit these, but the layout must not be the thing that throws if it does.
 */
export function pathologicalGraph(): GraphModel {
  const nodes = [node("a", "note", "A", "human"), node("b", "note", "B", "agent"), node("c", "file", "C")];
  const edges: GraphEdge[] = [
    edge("a", "a"),
    edge("a", "b"),
    edge("a", "b"),
    edge("ghost", "b", "links-to"),
    edge("c", "phantom", "links-to"),
  ];
  return model(nodes, edges);
}
