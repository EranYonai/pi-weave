/**
 * src/core/view/health.ts — healthModel / countProvenance.
 * Promoted from tests/pi/viewTuiModel.test.ts + viewTuiCoverage.test.ts.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_NOTES } from "../../../src/core/graph/build";
import type { GraphNode } from "../../../src/core/graph/model";
import { countProvenance, healthModel } from "../../../src/core/view";
import { graph, node } from "./fixtures";

describe("healthModel", () => {
  it("surfaces staleness reasons and the provenance split", () => {
    const model = graph(
      [
        node("repository", "repository", "repo", null, { files: "10", languages: "TypeScript (10)", state: "stale" }),
        node("vault", "vault", "Vault", null, { notes: "2" }),
        node("note:a", "note", "A", "human"),
        node("note:b", "note", "B", "agent"),
      ],
      [
        { source: "repository", target: "vault", kind: "contains" },
        { source: "note:a", target: "note:b", kind: "links-to" },
      ],
      { state: "stale", reasons: ["new commits", "index older than HEAD"] },
    );
    const h = healthModel(model);
    const repo = h.sections.find((s) => s.heading === "Repository")!;
    expect(repo.rows.some((r) => r.text.includes("state: stale"))).toBe(true);
    expect(repo.rows.some((r) => r.text.includes("new commits"))).toBe(true);
    const vault = h.sections.find((s) => s.heading === "Vault")!;
    expect(vault.rows.some((r) => r.text.includes("notes: 2"))).toBe(true);
    expect(vault.rows.some((r) => r.text.includes("human 1"))).toBe(true);
    expect(vault.rows.some((r) => r.text.includes("agent 1"))).toBe(true);
  });

  it("lists orphans, dangling links, and top hubs", () => {
    const model = graph(
      [
        node("vault", "vault", "Vault", null, { notes: "3" }),
        node("note:hub", "note", "Hub", "human"),
        node("note:a", "note", "A", "human"),
        node("note:b", "note", "B", "agent", { "dangling links": "2" }),
        node("note:orphan", "note", "Orphan", "human"),
      ],
      [
        { source: "vault", target: "note:hub", kind: "contains" },
        { source: "vault", target: "note:a", kind: "contains" },
        { source: "vault", target: "note:b", kind: "contains" },
        { source: "vault", target: "note:orphan", kind: "contains" },
        { source: "note:hub", target: "note:a", kind: "links-to" },
        { source: "note:hub", target: "note:b", kind: "links-to" },
      ],
    );
    const h = healthModel(model);
    const link = h.sections.find((s) => s.heading === "Link health")!;
    const texts = link.rows.map((r) => r.text);
    expect(texts.some((t) => t.includes("Orphan"))).toBe(true);
    expect(texts.some((t) => t.includes("B (2)"))).toBe(true);
    expect(texts.some((t) => t.includes("Hub (3)"))).toBe(true);
  });

  it("surfaces the truncation warning from vault detail", () => {
    const model = graph(
      [node("vault", "vault", "Vault", null, { notes: String(DEFAULT_MAX_NOTES + 5), warning: "Graph truncated" })],
      [],
    );
    const vault = healthModel(model).sections.find((s) => s.heading === "Vault")!;
    expect(vault.rows.some((r) => r.text.includes("Graph truncated"))).toBe(true);
  });

  it("vault-only graph: no repository section; no orphans/dangling", () => {
    const m = graph([node("vault", "vault", "Vault", null, { notes: "0" })], []);
    const h = healthModel(m);
    expect(h.sections.find((s) => s.heading === "Repository")).toBeUndefined();
    const vault = h.sections.find((s) => s.heading === "Vault")!;
    expect(vault.rows.some((r) => r.text.includes("notes: 0"))).toBe(true);
    const link = h.sections.find((s) => s.heading === "Link health")!;
    expect(link.rows.some((r) => r.text.includes("orphans: none"))).toBe(true);
  });

  it("a graph with neither vault nor repository yields only the link-health section", () => {
    const h = healthModel(graph([node("note:a", "note", "A", "human")], []));
    expect(h.sections.map((s) => s.heading)).toEqual(["Link health"]);
  });

  it("fresh repository with no staleness reasons omits reason rows", () => {
    const m = graph(
      [node("repository", "repository", "repo", null, { files: "1", state: "fresh" })],
      [],
      { state: "fresh", reasons: [] },
    );
    const repo = healthModel(m).sections.find((s) => s.heading === "Repository")!;
    expect(repo.rows.some((r) => r.text.includes("state: fresh"))).toBe(true);
    expect(repo.rows.some((r) => r.text.includes("files: 1"))).toBe(true);
  });

  it("many orphans cap at 10 with an overflow line", () => {
    const nodes: GraphNode[] = [node("vault", "vault", "Vault", null, { notes: "15" })];
    for (let i = 0; i < 15; i++) nodes.push(node(`note:n${i}`, "note", `N${i}`, "human"));
    const edges = nodes.slice(1).map((n) => ({ source: "vault", target: n.id, kind: "contains" as const }));
    const link = healthModel(graph(nodes, edges)).sections.find((s) => s.heading === "Link health")!;
    expect(link.rows.some((r) => r.text.includes("… and 5 more"))).toBe(true);
  });

  it("dangling links cap with an overflow line", () => {
    const nodes: GraphNode[] = [node("vault", "vault", "Vault", null, { notes: "1" })];
    for (let i = 0; i < 12; i++) nodes.push(node(`note:n${i}`, "note", `N${i}`, "human", { "dangling links": "1" }));
    const edges = nodes.slice(1).map((n) => ({ source: "vault", target: n.id, kind: "contains" as const }));
    const link = healthModel(graph(nodes, edges)).sections.find((s) => s.heading === "Link health")!;
    expect(link.rows.some((r) => r.text.includes("… and 2 more"))).toBe(true);
  });

  it("a zero dangling-links count does not produce a dangling row", () => {
    const m = graph(
      [node("vault", "vault", "Vault", null, { notes: "1" }), node("note:a", "note", "A", "human", { "dangling links": "0" })],
      [{ source: "vault", target: "note:a", kind: "contains" }],
    );
    const link = healthModel(m).sections.find((s) => s.heading === "Link health")!;
    expect(link.rows.some((r) => r.text.includes("dangling links ("))).toBe(false);
  });

  it("repository with languages + summarized-files rows", () => {
    const m = graph(
      [
        node("repository", "repository", "repo", null, { files: "5", languages: "TypeScript (5)", state: "fresh" }),
        node("module:src", "module", "src", null, { path: "src", files: "3", "summarized files": "2" }),
      ],
      [{ source: "repository", target: "module:src", kind: "contains" }],
      { state: "fresh", reasons: [] },
    );
    const repo = healthModel(m).sections.find((s) => s.heading === "Repository")!;
    expect(repo.rows.some((r) => r.text.includes("languages: TypeScript"))).toBe(true);
    expect(repo.rows.some((r) => r.text.includes("summarized files: 2"))).toBe(true);
  });

  it("a module whose summarized-files detail is absent contributes zero", () => {
    const m = graph(
      [
        node("repository", "repository", "repo", null, { files: "5" }),
        node("module:a", "module", "a", null, { path: "a" }),
        node("module:b", "module", "b", null, { path: "b", "summarized files": "0" }),
      ],
      [
        { source: "repository", target: "module:a", kind: "contains" },
        { source: "repository", target: "module:b", kind: "contains" },
      ],
    );
    const repo = healthModel(m).sections.find((s) => s.heading === "Repository")!;
    expect(repo.rows.some((r) => r.text.includes("summarized files:"))).toBe(false);
  });

  it("repository with staleness=null omits the staleness rows", () => {
    const m = graph([node("repository", "repository", "repo", null, { files: "1" })], [], null);
    const repo = healthModel(m).sections.find((s) => s.heading === "Repository")!;
    expect(repo.rows.some((r) => r.text.includes("state:"))).toBe(false);
  });

  it("repository with staleness=null and a stale state detail still lists files", () => {
    const m = graph([node("repository", "repository", "repo", null, { files: "2", state: "stale" })], [], null);
    const repo = healthModel(m).sections.find((s) => s.heading === "Repository")!;
    expect(repo.rows.some((r) => r.text.includes("files: 2"))).toBe(true);
  });
});

describe("countProvenance", () => {
  it("tallies the provenance split and structural nodes", () => {
    const c = countProvenance([
      node("a", "note", "A", "human"),
      node("b", "note", "B", "human"),
      node("c", "note", "C", "agent"),
      node("d", "note", "D", "generated"),
      node("e", "module", "E", null),
    ]);
    expect(c).toEqual({ total: 5, human: 2, agent: 1, generated: 1, structural: 1 });
  });
  it("is all zeroes for no nodes", () => {
    expect(countProvenance([])).toEqual({ total: 0, human: 0, agent: 0, generated: 0, structural: 0 });
  });
});
