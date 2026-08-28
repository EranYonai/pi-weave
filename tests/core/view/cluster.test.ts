/**
 * src/core/view/cluster.ts — clusterAggregate.
 *
 * The reduction the sigma panel (§7.4) and the TUI tree both stand on, so the
 * cases that matter are the ones where the two surfaces could disagree:
 * what "collapsed" hides, where a boundary-crossing edge lands, and whether
 * expanding is exactly the inverse of collapsing.
 */

import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphModel } from "../../../src/core/graph/model";
import { clusterAggregate } from "../../../src/core/view";
import { graph, node } from "./fixtures";

/** Sorted visible ids — order is asserted separately, once. */
function ids(model: ReturnType<typeof clusterAggregate>): string[] {
  return model.nodes.map((n) => n.id).sort();
}

/** `source>target:kind` strings, sorted, for compact edge assertions. */
function wires(agg: ReturnType<typeof clusterAggregate>): string[] {
  return agg.edges.map((e) => `${e.source}>${e.target}:${e.kind}`).sort();
}

function contains(source: string, target: string): GraphEdge {
  return { source, target, kind: "contains" };
}

function links(source: string, target: string): GraphEdge {
  return { source, target, kind: "links-to" };
}

/**
 * repo ─contains─▶ core ─contains─▶ model.ts
 *   │                  └─contains─▶ tree.ts
 *   └────contains─▶ pi   ─contains─▶ index.ts
 * vault ─contains─▶ note-a ─links-to─▶ (varies per test)
 */
function repoish(edges: GraphEdge[] = []): GraphModel {
  return graph(
    [
      node("repo", "repository", "pi-weave", null),
      node("core", "module", "src/core", null),
      node("pi", "module", "src/pi", null),
      node("model.ts", "file", "model.ts", null),
      node("tree.ts", "file", "tree.ts", null),
      node("index.ts", "file", "index.ts", null),
      node("vault", "vault", "vault", null),
      node("note-a", "note", "Graph model", "human"),
    ],
    [
      contains("repo", "core"),
      contains("repo", "pi"),
      contains("core", "model.ts"),
      contains("core", "tree.ts"),
      contains("pi", "index.ts"),
      contains("vault", "note-a"),
      ...edges,
    ],
  );
}

describe("clusterAggregate visibility", () => {
  it("shows only the roots when nothing is expanded", () => {
    const agg = clusterAggregate(repoish(), new Set());
    expect(ids(agg)).toEqual(["repo", "vault"]);
    expect(agg.roots).toEqual(["repo", "vault"]);
    expect([...agg.hidden].sort()).toEqual(["core", "index.ts", "model.ts", "note-a", "pi", "tree.ts"]);
  });

  it("reveals a cluster's children when it is expanded", () => {
    const agg = clusterAggregate(repoish(), new Set(["repo"]));
    expect(ids(agg)).toEqual(["core", "pi", "repo", "vault"]);
  });

  it("keeps a collapsed cluster's whole subtree hidden, not just its leaves", () => {
    // The retired implementation revealed nested clusters regardless of the
    // expand set; `core` and `pi` would have shown here. That is the one
    // deliberate behavioural change in the port.
    const agg = clusterAggregate(repoish(), new Set(["core"]));
    expect(ids(agg)).toEqual(["repo", "vault"]);
  });

  it("requires every ancestor on the path to be expanded", () => {
    const agg = clusterAggregate(repoish(), new Set(["repo", "core"]));
    expect(ids(agg)).toEqual(["core", "model.ts", "pi", "repo", "tree.ts", "vault"]);
    // `pi` is expanded-in-name-only: its parent is expanded, it is not.
    expect(agg.hidden.has("index.ts")).toBe(true);
  });

  it("emits nodes in model order, not expansion order", () => {
    const agg = clusterAggregate(repoish(), new Set(["vault", "repo"]));
    expect(agg.nodes.map((n) => n.id)).toEqual(["repo", "core", "pi", "vault", "note-a"]);
  });

  it("treats anchored-at as containment", () => {
    const model = graph(
      [node("repo", "repository", "repo", null), node("git", "gitState", "HEAD", null)],
      [{ source: "repo", target: "git", kind: "anchored-at" }],
    );
    expect(ids(clusterAggregate(model, new Set()))).toEqual(["repo"]);
    expect(ids(clusterAggregate(model, new Set(["repo"])))).toEqual(["git", "repo"]);
  });

  it("ignores non-containment edges when deciding nesting", () => {
    // note-a links to note-b; that must not make note-b a child of note-a.
    const model = graph(
      [node("note-a", "note", "A", "human"), node("note-b", "note", "B", "human")],
      [links("note-a", "note-b")],
    );
    const agg = clusterAggregate(model, new Set());
    expect(ids(agg)).toEqual(["note-a", "note-b"]);
    expect(agg.clusters.size).toBe(0);
  });
});

describe("clusterAggregate collapse/expand round-trip", () => {
  it("expanding then collapsing returns the original reduction", () => {
    const model = repoish();
    const collapsed = clusterAggregate(model, new Set());
    const expanded = clusterAggregate(model, new Set(["repo", "core", "pi", "vault"]));
    const recollapsed = clusterAggregate(model, new Set());

    expect(ids(expanded)).toHaveLength(model.nodes.length);
    expect(ids(recollapsed)).toEqual(ids(collapsed));
    expect(wires(recollapsed)).toEqual(wires(collapsed));
    expect([...recollapsed.representative]).toEqual([...collapsed.representative]);
  });

  it("fully expanded is the identity on nodes and edges", () => {
    const model = repoish([links("note-a", "model.ts")]);
    const all = new Set(["repo", "core", "pi", "vault"]);
    const agg = clusterAggregate(model, all);
    expect(agg.nodes).toEqual(model.nodes);
    expect(agg.edges).toEqual(model.edges);
    expect(agg.hidden.size).toBe(0);
    expect(agg.representative.size).toBe(0);
  });

  it("expanding one level at a time is monotone", () => {
    const model = repoish();
    const steps = [new Set<string>(), new Set(["repo"]), new Set(["repo", "core"]), new Set(["repo", "core", "pi"])];
    let previous = 0;
    for (const expanded of steps) {
      const count = clusterAggregate(model, expanded).nodes.length;
      expect(count).toBeGreaterThan(previous);
      previous = count;
    }
  });
});

describe("clusterAggregate edge rewriting", () => {
  it("retargets an edge into a collapsed cluster onto the cluster", () => {
    const agg = clusterAggregate(repoish([links("note-a", "model.ts")]), new Set(["vault", "repo"]));
    // note-a is visible, model.ts is inside collapsed `core`.
    expect(wires(agg)).toContain("note-a>core:links-to");
    expect(wires(agg)).not.toContain("note-a>model.ts:links-to");
  });

  it("dedupes several edges that cross the same boundary", () => {
    const model = repoish([links("note-a", "model.ts"), links("note-a", "tree.ts")]);
    const agg = clusterAggregate(model, new Set(["vault", "repo"]));
    expect(wires(agg).filter((w) => w === "note-a>core:links-to")).toHaveLength(1);
  });

  it("keeps distinct kinds between the same rewritten pair", () => {
    const model = repoish([links("note-a", "model.ts"), { source: "note-a", target: "tree.ts", kind: "mentions" }]);
    const agg = clusterAggregate(model, new Set(["vault", "repo"]));
    expect(wires(agg)).toContain("note-a>core:links-to");
    expect(wires(agg)).toContain("note-a>core:mentions");
  });

  it("drops an edge whose ends collapse into the same cluster", () => {
    const model = repoish([links("model.ts", "tree.ts")]);
    const agg = clusterAggregate(model, new Set(["repo"]));
    expect(wires(agg)).not.toContain("core>core:links-to");
    expect(agg.edges.every((e) => e.source !== e.target)).toBe(true);
  });

  it("rewrites both endpoints at once", () => {
    const model = repoish([links("model.ts", "index.ts")]);
    const agg = clusterAggregate(model, new Set(["repo"]));
    expect(wires(agg)).toContain("core>pi:links-to");
  });

  it("emits edges in model order", () => {
    const model = repoish([links("note-a", "model.ts")]);
    const agg = clusterAggregate(model, new Set(["repo", "vault"]));
    expect(agg.edges.map((e) => `${e.source}>${e.target}`)).toEqual([
      "repo>core",
      "repo>pi",
      "vault>note-a",
      "note-a>core",
    ]);
  });

  it("drops edges naming ids that are not in the node set", () => {
    // A partially-rebuilt .okf index can produce these; a renderer handed an
    // edge to a non-existent node throws.
    const model = graph([node("a", "note", "A", "human")], [links("a", "ghost"), links("ghost", "a")]);
    const agg = clusterAggregate(model, new Set());
    expect(agg.edges).toEqual([]);
  });

  it("ignores a containment edge to a missing node when indexing children", () => {
    const model = graph([node("repo", "repository", "repo", null)], [contains("repo", "ghost")]);
    const agg = clusterAggregate(model, new Set());
    expect(agg.clusters.size).toBe(0);
    expect(ids(agg)).toEqual(["repo"]);
  });
});

describe("clusterAggregate nesting and mapping", () => {
  it("maps a cluster to its members and each member back to its cluster", () => {
    const agg = clusterAggregate(repoish(), new Set(["repo"]));
    const core = agg.clusters.get("core");
    expect(core?.members).toEqual(["model.ts", "tree.ts"]);
    expect(agg.representative.get("model.ts")).toBe("core");
    expect(agg.representative.get("tree.ts")).toBe("core");
    expect(agg.representative.get("index.ts")).toBe("pi");
  });

  it("attributes a nested member to the nearest visible collapsed ancestor", () => {
    // Nothing expanded: `repo` stands in for core, pi and every file.
    const agg = clusterAggregate(repoish(), new Set());
    expect(agg.representative.get("model.ts")).toBe("repo");
    expect(agg.clusters.get("repo")?.members).toEqual(["core", "model.ts", "tree.ts", "pi", "index.ts"]);
    // `core` is itself hidden, so it stands in for nothing.
    expect(agg.clusters.get("core")?.members).toEqual([]);
  });

  it("partitions the hidden set across the visible clusters", () => {
    // The property `members` is documented to hold: every hidden node is
    // claimed by exactly one visible cluster, so a badge count can never
    // double-count or lose a node.
    for (const expanded of [new Set<string>(), new Set(["repo"]), new Set(["repo", "core"])]) {
      const agg = clusterAggregate(repoish(), expanded);
      const claimed = [...agg.clusters.values()].flatMap((c) => c.members);
      expect(claimed.sort()).toEqual([...agg.hidden].sort());
      expect(new Set(claimed).size).toBe(claimed.length);
    }
  });

  it("reports children and descendants for every cluster, expanded or not", () => {
    const agg = clusterAggregate(repoish(), new Set(["repo", "core", "pi", "vault"]));
    expect([...agg.clusters.keys()].sort()).toEqual(["core", "pi", "repo", "vault"]);
    expect(agg.clusters.get("repo")?.children).toEqual(["core", "pi"]);
    expect(agg.clusters.get("repo")?.descendants).toEqual(["core", "model.ts", "tree.ts", "pi", "index.ts"]);
    expect(agg.clusters.get("repo")?.expanded).toBe(true);
    // Expanded clusters stand in for nothing.
    expect(agg.clusters.get("repo")?.members).toEqual([]);
  });

  it("de-duplicates a child named by two containment edges", () => {
    const model = graph(
      [node("repo", "repository", "repo", null), node("a", "file", "a", null)],
      [contains("repo", "a"), contains("repo", "a"), { source: "repo", target: "a", kind: "anchored-at" }],
    );
    expect(clusterAggregate(model, new Set(["repo"])).clusters.get("repo")?.children).toEqual(["a"]);
  });

  it("attributes a multi-parent child to the first parent in model order", () => {
    const model = graph(
      [
        node("root", "repository", "root", null),
        node("p1", "module", "p1", null),
        node("p2", "module", "p2", null),
        node("shared", "file", "shared", null),
      ],
      [contains("root", "p1"), contains("root", "p2"), contains("p1", "shared"), contains("p2", "shared")],
    );
    const agg = clusterAggregate(model, new Set(["root"]));
    expect(agg.representative.get("shared")).toBe("p1");
    expect(agg.clusters.get("p1")?.members).toEqual(["shared"]);
    expect(agg.clusters.get("p2")?.members).toEqual([]);
    // Both still report it as a descendant — the hierarchy is a DAG.
    expect(agg.clusters.get("p2")?.descendants).toEqual(["shared"]);
  });

  it("rolls provenance up over all descendants, counting structural nodes as none", () => {
    const model = graph(
      [
        node("vault", "vault", "vault", null),
        node("folder", "module", "folder", null),
        node("h", "note", "H", "human"),
        node("a", "note", "A", "agent"),
        node("g", "note", "G", "generated"),
      ],
      [contains("vault", "folder"), contains("folder", "h"), contains("folder", "a"), contains("folder", "g")],
    );
    const agg = clusterAggregate(model, new Set());
    expect(agg.clusters.get("vault")?.provenance).toEqual({ human: 1, agent: 1, generated: 1, none: 1 });
    expect(agg.clusters.get("folder")?.provenance).toEqual({ human: 1, agent: 1, generated: 1, none: 0 });
  });
});

describe("clusterAggregate degenerate shapes", () => {
  it("handles an empty graph", () => {
    const agg = clusterAggregate(graph([], []), new Set());
    expect(agg.nodes).toEqual([]);
    expect(agg.edges).toEqual([]);
    expect(agg.roots).toEqual([]);
    expect(agg.clusters.size).toBe(0);
    expect(agg.hidden.size).toBe(0);
    expect(agg.representative.size).toBe(0);
  });

  it("handles a lone node, which is its own root", () => {
    const model = graph([node("solo", "note", "Solo", "human")], []);
    const agg = clusterAggregate(model, new Set());
    expect(agg.roots).toEqual(["solo"]);
    expect(ids(agg)).toEqual(["solo"]);
    expect(agg.clusters.size).toBe(0);
    // Expanding a childless root is a no-op, not a crash.
    expect(clusterAggregate(model, new Set(["solo"])).nodes).toEqual(model.nodes);
  });

  it("collapses the whole graph into one root cluster", () => {
    const agg = clusterAggregate(repoish(), new Set());
    const under = agg.clusters.get("repo");
    expect(under?.members).toHaveLength(5);
    // Two roots, so `repo` swallows everything except the vault subtree.
    expect(agg.nodes).toHaveLength(2);
    expect(wires(agg)).toEqual([]);
  });

  it("keeps a single all-swallowing root visible", () => {
    const model = graph(
      [node("root", "repository", "root", null), node("a", "file", "a", null), node("b", "file", "b", null)],
      [contains("root", "a"), contains("a", "b")],
    );
    const agg = clusterAggregate(model, new Set());
    expect(ids(agg)).toEqual(["root"]);
    expect(agg.clusters.get("root")?.members).toEqual(["a", "b"]);
  });

  it("expands a cluster whose only child is a leaf", () => {
    const model = graph(
      [node("root", "repository", "root", null), node("leaf", "file", "leaf", null)],
      [contains("root", "leaf")],
    );
    expect(ids(clusterAggregate(model, new Set(["root"])))).toEqual(["leaf", "root"]);
  });

  it("ignores expanding an id that is not a cluster", () => {
    const agg = clusterAggregate(repoish(), new Set(["note-a", "model.ts", "nonexistent"]));
    expect(ids(agg)).toEqual(["repo", "vault"]);
  });

  it("surfaces a containment cycle that no root reaches", () => {
    // graphRoots finds no root inside the cycle, so it is reachable from
    // nowhere. Showing it beats dropping data the caller cannot otherwise see.
    const model = graph(
      [node("root", "repository", "root", null), node("x", "file", "x", null), node("y", "file", "y", null)],
      [contains("x", "y"), contains("y", "x")],
    );
    const agg = clusterAggregate(model, new Set());
    expect(ids(agg)).toEqual(["root", "x", "y"]);
    expect(wires(agg)).toEqual(["x>y:contains", "y>x:contains"]);
  });

  it("terminates on a cycle hanging off a root and does not recount it", () => {
    const model = graph(
      [
        node("root", "repository", "root", null),
        node("x", "module", "x", null),
        node("y", "module", "y", null),
      ],
      [contains("root", "x"), contains("x", "y"), contains("y", "x")],
    );
    const agg = clusterAggregate(model, new Set(["root", "x", "y"]));
    expect(ids(agg)).toEqual(["root", "x", "y"]);
    expect(agg.clusters.get("root")?.descendants).toEqual(["x", "y"]);
    expect(agg.clusters.get("x")?.descendants).toEqual(["y"]);
    expect(agg.clusters.get("y")?.descendants).toEqual(["x"]);
  });
});
