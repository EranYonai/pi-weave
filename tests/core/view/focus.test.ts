/**
 * src/core/view/focus.ts — focusModel / focusNeighborhood / degreeOf.
 * Promoted from tests/pi/viewTuiModel.test.ts + viewTuiCoverage.test.ts.
 */

import { describe, expect, it } from "vitest";
import type { GraphEdge } from "../../../src/core/graph/model";
import { degreeOf, focusModel, focusNeighborhood } from "../../../src/core/view";
import { graph, node } from "./fixtures";

describe("focusNeighborhood", () => {
  it("returns the 1-hop neighborhood including the node", () => {
    const edges: GraphEdge[] = [
      { source: "a", target: "b", kind: "links-to" },
      { source: "c", target: "a", kind: "links-to" },
      { source: "b", target: "d", kind: "links-to" },
    ];
    const nb = focusNeighborhood("a", edges);
    expect([...nb].sort()).toEqual(["a", "b", "c"]);
    expect(nb.has("d")).toBe(false);
  });
  it("with no edges the node is its own neighborhood", () => {
    expect(focusNeighborhood("x", []).has("x")).toBe(true);
  });
});

describe("degreeOf", () => {
  it("counts incident edges in both directions", () => {
    const edges: GraphEdge[] = [
      { source: "a", target: "b", kind: "contains" },
      { source: "b", target: "c", kind: "links-to" },
    ];
    expect(degreeOf("b", edges)).toBe(2);
    expect(degreeOf("z", edges)).toBe(0);
  });
  it("is zero on an empty edge list", () => {
    expect(degreeOf("x", [])).toBe(0);
  });
});

describe("focusModel", () => {
  it("groups outgoing and incoming 1-hop neighbors, 2-hop excluded", () => {
    const model = graph(
      [
        node("note:auth", "note", "Auth", "human"),
        node("note:tokens", "note", "Tokens", "agent"),
        node("note:login", "note", "Login", "human"),
        node("note:threat", "note", "Threat", "agent"),
        node("note:far", "note", "Far", "human"),
        node("vault", "vault", "Vault", null),
      ],
      [
        { source: "vault", target: "note:auth", kind: "contains" },
        { source: "vault", target: "note:tokens", kind: "contains" },
        { source: "vault", target: "note:login", kind: "contains" },
        { source: "vault", target: "note:threat", kind: "contains" },
        { source: "vault", target: "note:far", kind: "contains" },
        { source: "note:auth", target: "note:tokens", kind: "links-to" },
        { source: "note:login", target: "note:auth", kind: "links-to" },
        { source: "note:threat", target: "note:auth", kind: "links-to" },
        { source: "note:tokens", target: "note:far", kind: "links-to" }, // 2-hop
      ],
    );
    const f = focusModel(model, "note:auth");
    expect(f.center.id).toBe("note:auth");
    const headings = f.groups.map((g) => g.heading);
    expect(headings).toContain("links to →");
    expect(headings).toContain("← linked from");
    expect(headings).toContain("contained by");
    // far is 2-hop, not present
    const allTargets = f.groups.flatMap((g) => g.rows.map((r) => r.id));
    expect(allTargets).not.toContain("note:far");
    const links = f.groups.find((g) => g.heading === "links to →")!.rows.map((r) => r.id);
    expect(links).toEqual(["note:tokens"]);
    const back = f.groups.find((g) => g.heading === "← linked from")!.rows.map((r) => r.id).sort();
    expect(back).toEqual(["note:login", "note:threat"]);
  });

  it("a node with no edges yields just the center", () => {
    const model = graph([node("note:solo", "note", "Solo", "human")], []);
    const f = focusModel(model, "note:solo");
    expect(f.center.id).toBe("note:solo");
    expect(f.groups).toHaveLength(0);
  });

  it("outgoing contains + anchored-at headings appear", () => {
    const m = graph(
      [
        node("repository", "repository", "repo", null),
        node("module:src", "module", "src", null, { path: "src" }),
        node("gitState", "gitState", "main", null),
      ],
      [
        { source: "repository", target: "module:src", kind: "contains" },
        { source: "repository", target: "gitState", kind: "anchored-at" },
      ],
    );
    const headings = focusModel(m, "repository").groups.map((g) => g.heading);
    expect(headings).toContain("contains");
    expect(headings).toContain("anchored at");
  });

  it("a node only contained (no links) shows contained-by", () => {
    const m = graph(
      [node("vault", "vault", "Vault", null), node("note:a", "note", "A", "human")],
      [{ source: "vault", target: "note:a", kind: "contains" }],
    );
    expect(focusModel(m, "note:a").groups.map((g) => g.heading)).toContain("contained by");
  });

  it("an unknown id still returns a synthetic center", () => {
    const f = focusModel(graph([], []), "note:ghost");
    expect(f.center.id).toBe("note:ghost");
    expect(f.center.kind).toBe("note");
    expect(f.groups).toHaveLength(0);
  });

  it("every edge kind in both directions groups", () => {
    const m = graph(
      [
        node("repository", "repository", "repo", null),
        node("module:src", "module", "src", null, { path: "src" }),
        node("gitState", "gitState", "main", null),
        node("note:a", "note", "A", "human"),
        node("note:b", "note", "B", "human"),
      ],
      [
        { source: "repository", target: "module:src", kind: "contains" },
        { source: "repository", target: "gitState", kind: "anchored-at" },
        { source: "repository", target: "note:a", kind: "links-to" },
        { source: "note:b", target: "repository", kind: "contains" }, // incoming contains
        { source: "note:a", target: "repository", kind: "anchored-at" }, // incoming anchored-at
        { source: "note:a", target: "repository", kind: "links-to" }, // backlink
      ],
    );
    const headings = focusModel(m, "repository").groups.map((g) => g.heading);
    expect(headings).toContain("links to →");
    expect(headings).toContain("contains");
    expect(headings).toContain("anchored at");
    expect(headings).toContain("← linked from");
    expect(headings).toContain("contained by");
  });

  it("multiple same-kind edges accumulate into one group", () => {
    const m = graph(
      [
        node("note:hub", "note", "Hub", "human"),
        node("note:a", "note", "A", "human"),
        node("note:b", "note", "B", "human"),
        node("vault", "vault", "Vault", null),
        node("repository", "repository", "repo", null),
      ],
      [
        { source: "note:hub", target: "note:a", kind: "links-to" },
        { source: "note:hub", target: "note:b", kind: "links-to" },
        { source: "vault", target: "note:hub", kind: "contains" },
        { source: "repository", target: "note:hub", kind: "contains" },
        { source: "repository", target: "note:hub", kind: "anchored-at" },
      ],
    );
    const f = focusModel(m, "note:hub");
    const links = f.groups.find((g) => g.heading === "links to →")!.rows;
    expect(links.map((r) => r.id).sort()).toEqual(["note:a", "note:b"]);
    const contained = f.groups.find((g) => g.heading === "contained by")!.rows.map((r) => r.id).sort();
    expect(contained).toEqual(["repository", "vault"]);
  });

  it("only anchored-at incoming still yields a contained-by group", () => {
    const m = graph(
      [node("repository", "repository", "repo", null), node("gitState", "gitState", "main", null)],
      [{ source: "repository", target: "gitState", kind: "anchored-at" }],
    );
    const f = focusModel(m, "gitState");
    expect(f.groups.find((g) => g.heading === "contained by")!.rows.map((r) => r.id)).toEqual(["repository"]);
  });

  it("mentions edges are grouped under their raw kind (no heading override)", () => {
    const m = graph(
      [node("note:a", "note", "A", "human"), node("note:b", "note", "B", "human")],
      [{ source: "note:a", target: "note:b", kind: "mentions" }],
    );
    // "mentions" is not one of the three grouped outgoing kinds → no group
    expect(focusModel(m, "note:a").groups).toHaveLength(0);
  });

  it("drops neighbors whose node is missing from the graph", () => {
    const m = graph(
      [node("note:a", "note", "A", "human")],
      [{ source: "note:a", target: "note:ghost", kind: "links-to" }],
    );
    expect(focusModel(m, "note:a").groups[0]!.rows).toHaveLength(0);
  });
});
