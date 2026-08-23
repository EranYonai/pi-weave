import { describe, expect, it } from "vitest";
import { buildGraph, DEFAULT_MAX_NOTES } from "../../src/core/graph/build";
import type { GraphModel, GraphEdge, GraphNode } from "../../src/core/graph/model";
import type { Note, NoteSource } from "../../src/core/types";
import type { RepoIndex, StalenessReport } from "../../src/core/types";
import { addNote } from "../../src/core/vault";
import {
  treeRows,
  focusModel,
  detailModel,
  healthModel,
  deriveBacklinks,
  focusNeighborhood,
  degreeOf,
  relTime,
  countProvenance,
  sanitizeTerminalText,
  reduce,
  initialState,
  graphRoots,
  mergeAfterRefresh,
  listLabel,
  type TreeState,
  type ExplorerState,
  type ReduceCtx,
} from "../../src/pi/viewer/tui/model";
import { provenanceStyle, kindStyle, PROVENANCE_CYCLE } from "../../src/pi/viewer/tui/theme";
import { commitAll, gitInit, makeTempDir, withVaultEnv, writeFixture } from "../helpers";
import { buildRepoIndex, writeRepoIndex } from "../../src/core/repoIndex";
import { buildCurrentGraph } from "../../src/core";

// ---------------------------------------------------------------------------
// Hand-built graph fixtures (mirror the page tests)
// ---------------------------------------------------------------------------

function node(id: string, kind: GraphNode["kind"], label: string, provenance: NoteSource | null, detail: Record<string, string> = {}): GraphNode {
  return { id, kind, label, provenance, detail };
}

function graph(nodes: GraphNode[], edges: GraphModel["edges"], staleness: StalenessReport | null = null): GraphModel {
  return { generatedAt: "", staleness, nodes, edges };
}

const T0 = "2026-01-01T00:00:00.000Z";
const NOW = Date.parse("2026-06-01T00:00:00.000Z");

function treeState(over: Partial<TreeState> = {}): TreeState {
  return {
    expanded: new Set(["vault", "repository"]),
    showInternals: false,
    provFilter: null,
    query: "",
    now: NOW,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// treeRows — port of the page's listTree, 1:1
// ---------------------------------------------------------------------------

describe("treeRows", () => {
  it("builds an expandable index tree, nesting entry points under modules", () => {
    const model = graph(
      [
        node("repository", "repository", "repo", null),
        node("module:src", "module", "src", null, { path: "src" }),
        node("entryPoint:src/index.ts", "entryPoint", "src/index.ts", null, { path: "src/index.ts" }),
        node("entryPoint:main.ts", "entryPoint", "main.ts", null, { path: "main.ts" }),
        node("vault", "vault", "Vault", null),
        node("note:a", "note", "A", "human"),
      ],
      [
        { source: "repository", target: "module:src", kind: "contains" },
        { source: "repository", target: "entryPoint:src/index.ts", kind: "contains" },
        { source: "repository", target: "entryPoint:main.ts", kind: "contains" },
        { source: "vault", target: "note:a", kind: "contains" },
      ],
    );
    const rows = treeRows(model, treeState({ expanded: new Set(["vault", "repository", "module:src"]), showInternals: true }));
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("module:src");
    expect(ids).toContain("entryPoint:main.ts");
    // src/index.ts nests under module:src (depth 2), not a direct child of repository
    expect(rows.find((r) => r.id === "entryPoint:src/index.ts")?.depth).toBe(2);
    expect(rows.find((r) => r.id === "entryPoint:main.ts")?.depth).toBe(1);
    expect(ids.indexOf("module:src")).toBeLessThan(ids.indexOf("entryPoint:src/index.ts"));
  });

  it("nests the git anchor (anchored-at) under the repository, not as a stray root", () => {
    const model = graph(
      [
        node("repository", "repository", "repo", null),
        node("gitState", "gitState", "main @ abc1234", null),
        node("module:src", "module", "src", null, { path: "src" }),
        node("vault", "vault", "Vault", null),
        node("note:a", "note", "A", "human"),
      ],
      [
        { source: "repository", target: "module:src", kind: "contains" },
        { source: "repository", target: "gitState", kind: "anchored-at" },
        { source: "vault", target: "note:a", kind: "contains" },
      ],
    );
    const rows = treeRows(model, treeState({ expanded: new Set(["vault", "repository"]), showInternals: true }));
    const roots = rows.filter((r) => r.depth === 0).map((r) => r.id).sort();
    expect(roots).toEqual(["repository", "vault"]);
    expect(rows.find((r) => r.id === "gitState")?.depth).toBe(1);
    expect(rows.find((r) => r.id === "repository")?.expanded).toBe(true);
  });

  it("collapses unexpanded branches", () => {
    const model = graph(
      [
        node("repository", "repository", "repo", null),
        node("module:src", "module", "src", null, { path: "src" }),
        node("vault", "vault", "Vault", null),
        node("note:a", "note", "A", "human"),
      ],
      [
        { source: "repository", target: "module:src", kind: "contains" },
        { source: "vault", target: "note:a", kind: "contains" },
      ],
    );
    const rows = treeRows(model, treeState({ expanded: new Set([]), showInternals: true }));
    expect(rows.map((r) => r.id)).toEqual(["repository", "vault"]);
    expect(rows.find((r) => r.id === "repository")?.expanded).toBe(false);
  });

  it("filter prunes to matches + ancestors, auto-expanding ancestors", () => {
    const model = graph(
      [
        node("repository", "repository", "repo", null),
        node("module:src", "module", "src", null, { path: "src" }),
        node("entryPoint:src/index.ts", "entryPoint", "src/index.ts", null, { path: "src/index.ts" }),
        node("entryPoint:main.ts", "entryPoint", "main.ts", null, { path: "main.ts" }),
        node("vault", "vault", "Vault", null),
        node("note:a", "note", "A", "human"),
      ],
      [
        { source: "repository", target: "module:src", kind: "contains" },
        { source: "repository", target: "entryPoint:src/index.ts", kind: "contains" },
        { source: "repository", target: "entryPoint:main.ts", kind: "contains" },
        { source: "vault", target: "note:a", kind: "contains" },
      ],
    );
    // query "src/index" auto-expands repository + module:src
    const rows = treeRows(model, treeState({ expanded: new Set(), showInternals: true, query: "src/index" }));
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("repository");
    expect(ids).toContain("module:src");
    expect(ids).toContain("entryPoint:src/index.ts");
    expect(rows.find((r) => r.id === "repository")?.expanded).toBe(true);
    expect(rows.find((r) => r.id === "module:src")?.expanded).toBe(true);
  });

  it("hides repo plumbing (internals) by default and reveals them with showInternals", () => {
    const model = graph(
      [
        node("repository", "repository", "repo", null),
        node("gitState", "gitState", "main @ ab", null),
        node("external:x", "external", "acme", null),
        node("package:y", "package", "demo", null),
        node("entryPoint:src/index.ts", "entryPoint", "src/index.ts", null, { path: "src/index.ts" }),
        node("module:src", "module", "src", null, { path: "src" }),
        node("vault", "vault", "Vault", null),
        node("note:a", "note", "A", "agent"),
      ],
      [
        { source: "repository", target: "module:src", kind: "contains" },
        { source: "repository", target: "gitState", kind: "anchored-at" },
        { source: "repository", target: "external:x", kind: "contains" },
        { source: "repository", target: "package:y", kind: "contains" },
        { source: "repository", target: "entryPoint:src/index.ts", kind: "contains" },
        { source: "vault", target: "note:a", kind: "contains" },
      ],
    );
    const base = treeState({ expanded: new Set(["vault", "repository", "module:src"]) });
    const hidden = treeRows(model, base).map((r) => r.id);
    expect(hidden).toContain("note:a");
    expect(hidden).toContain("module:src");
    expect(hidden).not.toContain("gitState");
    expect(hidden).not.toContain("external:x");
    expect(hidden).not.toContain("package:y");
    expect(hidden).not.toContain("entryPoint:src/index.ts");

    const shown = treeRows(model, { ...base, showInternals: true }).map((r) => r.id);
    expect(shown).toContain("gitState");
    expect(shown).toContain("external:x");
    expect(shown).toContain("package:y");
    expect(shown).toContain("entryPoint:src/index.ts");
  });

  it("nests .okf file nodes under the .okf module as an expandable subtree", () => {
    const model = graph(
      [
        node("repository", "repository", "repo", null),
        node("module:.okf", "module", ".okf", null, { path: ".okf" }),
        node("module:.okf/repository", "module", "repository", null, { path: ".okf/repository" }),
        node("module:.okf/repository/summaries", "module", "summaries", null, { path: ".okf/repository/summaries" }),
        node("okf:okf.json", "file", "okf.json", null, {}),
        node("okf:repository/git.json", "file", "git.json", null, {}),
        node("okf:repository/summaries/a.md", "file", "a.md", null, {}),
        node("vault", "vault", "Vault", null),
      ],
      [
        { source: "repository", target: "module:.okf", kind: "contains" },
        { source: "module:.okf", target: "module:.okf/repository", kind: "contains" },
        { source: "module:.okf/repository", target: "module:.okf/repository/summaries", kind: "contains" },
        { source: "module:.okf", target: "okf:okf.json", kind: "contains" },
        { source: "module:.okf/repository", target: "okf:repository/git.json", kind: "contains" },
        { source: "module:.okf/repository/summaries", target: "okf:repository/summaries/a.md", kind: "contains" },
      ],
    );
    const rows = treeRows(
      model,
      treeState({
        expanded: new Set(["vault", "repository", "module:.okf", "module:.okf/repository", "module:.okf/repository/summaries"]),
      }),
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("okf:okf.json");
    expect(ids).toContain("okf:repository/git.json");
    expect(ids).toContain("okf:repository/summaries/a.md");
    expect(rows.find((r) => r.id === "module:.okf")?.hasKids).toBe(true);
    expect(rows.find((r) => r.id === "okf:okf.json")?.depth).toBe(2);
    expect(rows.find((r) => r.id === "okf:repository/git.json")?.depth).toBe(3);
    expect(rows.find((r) => r.id === "okf:repository/summaries/a.md")?.depth).toBe(4);
  });

  it("empty vault renders only roots (vault-only graph)", () => {
    const model = graph([node("vault", "vault", "Vault", null)], []);
    const rows = treeRows(model, treeState());
    expect(rows.map((r) => r.id)).toEqual(["vault"]);
  });

  it("provenance filter prunes to matching notes", () => {
    const model = graph(
      [
        node("vault", "vault", "Vault", null),
        node("note:h", "note", "Human note", "human"),
        node("note:a", "note", "Agent note", "agent"),
      ],
      [
        { source: "vault", target: "note:h", kind: "contains" },
        { source: "vault", target: "note:a", kind: "contains" },
      ],
    );
    const rows = treeRows(model, treeState({ provFilter: "agent" }));
    expect(rows.map((r) => r.id)).toContain("note:a");
    expect(rows.map((r) => r.id)).not.toContain("note:h");
  });

  it("carries provenance and meta on rows", () => {
    const model = graph(
      [
        node("vault", "vault", "Vault", null),
        node("note:a", "note", "A", "human", { updated: "2026-05-01T00:00:00.000Z" }),
      ],
      [{ source: "vault", target: "note:a", kind: "contains" }],
    );
    const row = treeRows(model, treeState()).find((r) => r.id === "note:a")!;
    expect(row.provenance).toBe("human");
    expect(row.meta).toBe("1mo ago");
  });
});

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

describe("shared pure helpers", () => {
  it("focusNeighborhood returns the 1-hop neighborhood including the node", () => {
    const edges: GraphEdge[] = [
      { source: "a", target: "b", kind: "links-to" },
      { source: "c", target: "a", kind: "links-to" },
      { source: "b", target: "d", kind: "links-to" },
    ];
    const nb = focusNeighborhood("a", edges);
    expect([...nb].sort()).toEqual(["a", "b", "c"]);
    expect(nb.has("d")).toBe(false);
  });

  it("deriveBacklinks maps each target to its incoming links-to sources", () => {
    const edges: GraphEdge[] = [
      { source: "a", target: "b", kind: "links-to" },
      { source: "c", target: "b", kind: "links-to" },
      { source: "a", target: "c", kind: "contains" },
    ];
    const bl = deriveBacklinks(edges);
    expect(bl.get("b")).toEqual(["a", "c"]);
    expect(bl.has("c")).toBe(false);
  });

  it("degreeOf counts incident edges", () => {
    const edges: GraphEdge[] = [
      { source: "a", target: "b", kind: "contains" },
      { source: "b", target: "c", kind: "links-to" },
    ];
    expect(degreeOf("b", edges)).toBe(2);
    expect(degreeOf("z", edges)).toBe(0);
  });

  it("relTime renders relative human time", () => {
    const now = Date.parse("2026-03-01T12:00:00Z");
    expect(relTime("2026-03-01T11:59:30Z", now)).toBe("just now");
    expect(relTime("2026-03-01T11:30:00Z", now)).toBe("30m ago");
    expect(relTime("2026-03-01T09:00:00Z", now)).toBe("3h ago");
    expect(relTime("2026-02-20T12:00:00Z", now)).toBe("9d ago");
    expect(relTime("2025-12-01T12:00:00Z", now)).toBe("3mo ago");
    expect(relTime("2024-03-01T12:00:00Z", now)).toBe("2y ago");
    expect(relTime("", now)).toBe("");
    expect(relTime("not-a-date", now)).toBe("");
  });

  it("countProvenance tallies provenance split and structural nodes", () => {
    const c = countProvenance([
      node("a", "note", "A", "human"),
      node("b", "note", "B", "human"),
      node("c", "note", "C", "agent"),
      node("d", "note", "D", "generated"),
      node("e", "module", "E", null),
    ]);
    expect(c).toEqual({ total: 5, human: 2, agent: 1, generated: 1, structural: 1 });
  });
});

// ---------------------------------------------------------------------------
// focusModel
// ---------------------------------------------------------------------------

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
    // the links-to group has tokens; backlink group has login + threat
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
});

// ---------------------------------------------------------------------------
// detailModel
// ---------------------------------------------------------------------------

describe("detailModel", () => {
  it("orders meta, derives links and backlinks (contains not a backlink)", () => {
    const model = graph(
      [
        node("vault", "vault", "Vault", null),
        node("note:a", "note", "A", "human", { slug: "a", updated: T0, tags: "x, y" }),
        node("note:b", "note", "B", "agent", { slug: "b" }),
        node("module:src", "module", "src", null, { path: "src", files: "3" }),
      ],
      [
        { source: "vault", target: "note:a", kind: "contains" },
        { source: "vault", target: "note:b", kind: "contains" },
        { source: "note:a", target: "note:b", kind: "links-to" },
        { source: "note:b", target: "note:a", kind: "links-to" },
      ],
    );
    const d = detailModel(model, "note:a")!;
    expect(d.label).toBe("A");
    expect(d.provenance).toBe("human");
    // meta ordered: slug, updated, tags
    const keys = d.meta.map((m) => m.label);
    expect(keys.indexOf("slug")).toBeLessThan(keys.indexOf("updated"));
    expect(keys).toContain("tags");
    // links: outgoing links-to b; contains not counted as a link row
    expect(d.links.map((l) => l.target)).toContain("note:b");
    // backlinks: incoming links-to from b
    expect(d.backlinks.map((l) => l.target)).toEqual(["note:b"]);
  });

  it("returns null for an unknown id", () => {
    const model = graph([node("vault", "vault", "Vault", null)], []);
    expect(detailModel(model, "note:nope")).toBeNull();
  });

  it("entry-point summary surface shows summary meta", () => {
    const model = graph(
      [
        node("repository", "repository", "repo", null),
        node("entryPoint:src/index.ts", "entryPoint", "src/index.ts", null, { path: "src/index.ts", summary: "the entry" }),
      ],
      [{ source: "repository", target: "entryPoint:src/index.ts", kind: "contains" }],
    );
    const d = detailModel(model, "entryPoint:src/index.ts")!;
    expect(d.meta.find((m) => m.label === "summary")?.value).toBe("the entry");
  });
});

// ---------------------------------------------------------------------------
// healthModel
// ---------------------------------------------------------------------------

describe("healthModel", () => {
  it("surfaces staleness reasons and provenance split", () => {
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
    // orphan: note:orphan has no incoming links-to
    expect(texts.some((t) => t.includes("Orphan"))).toBe(true);
    // dangling: note:b has dangling links
    expect(texts.some((t) => t.includes("B (2)"))).toBe(true);
    // hub: note:hub has degree 2
    expect(texts.some((t) => t.includes("Hub (3)"))).toBe(true);
  });

  it("truncation warning surfaced from vault detail", () => {
    const model = graph(
      [node("vault", "vault", "Vault", null, { notes: String(DEFAULT_MAX_NOTES + 5), warning: "Graph truncated" })],
      [],
    );
    const h = healthModel(model);
    const vault = h.sections.find((s) => s.heading === "Vault")!;
    expect(vault.rows.some((r) => r.text.includes("Graph truncated"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sanitizeTerminalText
// ---------------------------------------------------------------------------

describe("sanitizeTerminalText", () => {
  it("strips ANSI/OSC/BEL and C0 controls, keeps newlines and tabs", () => {
    const hostile = "title\x1b[31mred\x1b[0m\x07\x9b\x00\x01\x0bnormal";
    const out = sanitizeTerminalText(hostile);
    expect(out).toBe("title[31mred[0mnormal");
    expect(out).not.toContain("\x1b");
    expect(out).not.toContain("\x9b");
    expect(out).not.toContain("\x07");
    expect(out).not.toContain("\x0b");
    // newlines/tabs preserved
    expect(sanitizeTerminalText("a\nb\tc")).toBe("a\nb\tc");
  });
});

// ---------------------------------------------------------------------------
// reduce — key→state transitions
// ---------------------------------------------------------------------------

function st(over: Partial<ExplorerState> = {}): ExplorerState {
  return {
    surface: "tree",
    searching: false,
    selectedId: "vault",
    focusId: null,
    detailId: null,
    expanded: new Set(["vault"]),
    showInternals: false,
    provFilter: null,
    query: "",
    helpOpen: false,
    refreshing: false,
    version: 0,
    scrollOffset: 0,
    ...over,
  };
}

function ctxRows(ids: string[]): ReduceCtx {
  return { rows: ids.map((id) => ({ id })), window: 24 };
}

describe("reduce", () => {
  it("down moves selection and clamps to last row", () => {
    const rows = ctxRows(["vault", "note:a", "note:b"]);
    let s = reduce(st(), { type: "down" }, rows);
    expect(s.selectedId).toBe("note:a");
    s = reduce(s, { type: "down" }, rows);
    expect(s.selectedId).toBe("note:b");
    s = reduce(s, { type: "down" }, rows);
    expect(s.selectedId).toBe("note:b"); // clamped
  });

  it("up moves selection and clamps to first row", () => {
    const rows = ctxRows(["vault", "note:a", "note:b"]);
    let s = st({ selectedId: "note:b" });
    s = reduce(s, { type: "up" }, rows);
    expect(s.selectedId).toBe("note:a");
    s = reduce(st({ selectedId: "vault" }), { type: "up" }, rows);
    expect(s.selectedId).toBe("vault"); // clamped
  });

  it("home/end jump to first/last; pageUp/pageDown page", () => {
    const rows = ctxRows(["a", "b", "c", "d", "e"]);
    expect(reduce(st({ selectedId: "c" }), { type: "home" }, rows).selectedId).toBe("a");
    expect(reduce(st({ selectedId: "c" }), { type: "end" }, rows).selectedId).toBe("e");
    const s = reduce(st({ selectedId: "a" }), { type: "pageDown" }, { rows: rows.rows, window: 2 });
    expect(s.selectedId).toBe("c"); // a + 2 = index 2
  });

  it("right expands a collapsed node, then moves to first child", () => {
    const rows: ReduceCtx = {
      rows: [
        { id: "vault" },
        { id: "note:a" },
      ],
      window: 24,
    };
    // simulate tree row metadata by giving the selected row hasKids+expanded via state
    // reduce's right-branch reads TreeRow fields off the row; cast for the test
    const treeRows = [
      { id: "vault", depth: 0, hasKids: true, expanded: false, label: "Vault", kind: "vault" as const, provenance: null, meta: "" },
      { id: "note:a", depth: 1, hasKids: false, expanded: false, label: "A", kind: "note" as const, provenance: "human", meta: "" },
    ];
    let s = reduce(st({ selectedId: "vault" }), { type: "right" }, { rows: treeRows, window: 24 });
    expect(s.expanded.has("vault")).toBe(true);
    // right again on an expanded node moves to first child
    s = reduce({ ...s, selectedId: "vault" }, { type: "right" }, { rows: treeRows, window: 24 });
    expect(s.selectedId).toBe("note:a");
  });

  it("left collapses an expanded node, or jumps to parent", () => {
    const treeRows = [
      { id: "vault", depth: 0, hasKids: true, expanded: true, label: "Vault", kind: "vault" as const, provenance: null, meta: "" },
      { id: "note:a", depth: 1, hasKids: false, expanded: false, label: "A", kind: "note" as const, provenance: "human", meta: "" },
    ];
    const s = reduce(st({ selectedId: "note:a", expanded: new Set(["vault"]) }), { type: "left" }, { rows: treeRows, window: 24 });
    expect(s.selectedId).toBe("vault"); // jumped to parent
  });

  it("enter on a tree row opens detail for the selection", () => {
    const s = reduce(st({ selectedId: "note:a" }), { type: "enter" }, ctxRows(["note:a"]));
    expect(s.surface).toBe("detail");
    expect(s.detailId).toBe("note:a");
  });

  it("enter on a detail link jumps to its target", () => {
    const rows: ReduceCtx = { rows: [{ id: "link:note:b", target: "note:b" }], window: 24 };
    const s = reduce(st({ surface: "detail", detailId: "note:a", selectedId: "link:note:b" }), { type: "enter" }, rows);
    expect(s.detailId).toBe("note:b");
    expect(s.selectedId).toBe("note:b");
  });

  it("enter on a focus neighbor re-centers focus", () => {
    const rows: ReduceCtx = { rows: [{ id: "note:b", target: "note:b" }], window: 24 };
    const s = reduce(st({ surface: "focus", focusId: "note:a", selectedId: "note:b" }), { type: "enter" }, rows);
    expect(s.focusId).toBe("note:b");
  });

  it("esc precedence: search > detail > focus > tree-quit", () => {
    // search clears filter
    let s = reduce(st({ searching: true, query: "x" }), { type: "esc" });
    expect(s.searching).toBe(false);
    expect(s.query).toBe("");
    // detail → tree
    s = reduce(st({ surface: "detail", detailId: "x" }), { type: "esc" });
    expect(s.surface).toBe("tree");
    // focus → tree
    s = reduce(st({ surface: "focus", focusId: "x" }), { type: "esc" });
    expect(s.surface).toBe("tree");
    expect(s.focusId).toBeNull();
    // health → tree
    s = reduce(st({ surface: "health" }), { type: "esc" });
    expect(s.surface).toBe("tree");
    // tree → quit signal (component resolves done)
    s = reduce(st({ surface: "tree" }), { type: "esc" });
    expect(s.surface).toBe("tree");
  });

  it("searchChar appends, backspace deletes, commit keeps filter", () => {
    let s = reduce(st({ searching: true }), { type: "searchChar", ch: "a" });
    s = reduce(s, { type: "searchChar", ch: "b" });
    expect(s.query).toBe("ab");
    s = reduce(s, { type: "searchBackspace" });
    expect(s.query).toBe("a");
    s = reduce(s, { type: "searchCommit" });
    expect(s.searching).toBe(false);
    expect(s.query).toBe("a"); // kept
  });

  it("searchChar is capped at MAX_FILTER_LEN", () => {
    let s = st({ searching: true, query: "x".repeat(200) });
    s = reduce(s, { type: "searchChar", ch: "y" });
    expect(s.query.length).toBe(200);
  });

  it("p cycles provenance filter all → human → agent → generated → all", () => {
    let s = reduce(st(), { type: "cycleProvenance" });
    expect(s.provFilter).toBe("human");
    s = reduce(s, { type: "cycleProvenance" });
    expect(s.provFilter).toBe("agent");
    s = reduce(s, { type: "cycleProvenance" });
    expect(s.provFilter).toBe("generated");
    s = reduce(s, { type: "cycleProvenance" });
    expect(s.provFilter).toBeNull();
  });

  it("i toggles internals; f enters focus; g/esc exits focus", () => {
    let s = reduce(st(), { type: "toggleInternals" });
    expect(s.showInternals).toBe(true);
    s = reduce(s, { type: "toggleInternals" });
    expect(s.showInternals).toBe(false);
    s = reduce(st({ selectedId: "note:a" }), { type: "focus" });
    expect(s.surface).toBe("focus");
    expect(s.focusId).toBe("note:a");
    s = reduce(s, { type: "focusExit" });
    expect(s.surface).toBe("tree");
    expect(s.focusId).toBeNull();
  });

  it("1/2 switch surfaces; r refreshes then done clears", () => {
    let s = reduce(st({ surface: "health" }), { type: "surfaceTree" });
    expect(s.surface).toBe("tree");
    s = reduce(st(), { type: "surfaceHealth" });
    expect(s.surface).toBe("health");
    s = reduce(st(), { type: "refresh" });
    expect(s.refreshing).toBe(true);
    s = reduce(s, { type: "refreshDone" });
    expect(s.refreshing).toBe(false);
  });

  it("? toggles help; ignores keys while searching where appropriate", () => {
    let s = reduce(st(), { type: "toggleHelp" });
    expect(s.helpOpen).toBe(true);
    // provenance cycle ignored during search
    s = reduce(st({ searching: true }), { type: "cycleProvenance" });
    expect(s.provFilter).toBeNull();
  });

  it("selection clamp after shrink falls back to first root", () => {
    // simulate refresh dropping the selected id from roots
    const merged = mergeAfterRefresh(st({ selectedId: null }), ["vault", "repository"]);
    expect(merged.selectedId).toBe("vault");
  });

  it("scroll offset keeps the selection within the window", () => {
    const rows = ctxRows(["a", "b", "c", "d", "e"]).rows;
    const s = reduce(st({ selectedId: "a", scrollOffset: 0 }), { type: "down" }, { rows, window: 2 });
    // selection b at index 1, window 2, offset 0 → 0 <= 1 < 2, stays 0
    expect(s.scrollOffset).toBe(0);
    const s2 = reduce(st({ selectedId: "c", scrollOffset: 0 }), { type: "down" }, { rows, window: 2 });
    // selection d at index 3, offset 0 → 3 >= 0+2 → offset = 3-2+1 = 2
    expect(s2.scrollOffset).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// theme maps
// ---------------------------------------------------------------------------

describe("theme maps", () => {
  it("provenanceStyle maps each source to glyph+dim+slot", () => {
    expect(provenanceStyle("human").glyph).toBe("●");
    expect(provenanceStyle("human").dim).toBe(false);
    expect(provenanceStyle("agent").glyph).toBe("◐");
    expect(provenanceStyle("generated").dim).toBe(true);
    expect(provenanceStyle(null).glyph).toBe("");
  });

  it("kindStyle maps each kind to a glyph+slot", () => {
    expect(kindStyle("vault").glyph).toBe("◆");
    expect(kindStyle("repository").glyph).toBe("■");
    expect(kindStyle("gitState").glyph).toBe("⎇");
    expect(kindStyle("file").glyph).toBe("·");
    // notes defer to provenance glyph
    expect(kindStyle("note").glyph).toBe("");
  });

  it("PROVENANCE_CYCLE starts at null (all)", () => {
    expect(PROVENANCE_CYCLE[0]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listLabel
// ---------------------------------------------------------------------------

describe("listLabel", () => {
  it("disambiguates external remotes and packages", () => {
    expect(listLabel(node("external:x", "external", "pi-weave", null, { url: "https://github.com/EranYonai/pi-weave.git" })))
      .toBe("github.com/EranYonai/pi-weave");
    expect(listLabel(node("package:y", "package", "pi-weave", null, { manifest: "package.json" })))
      .toBe("pi-weave (package.json)");
    expect(listLabel(node("module:src", "module", "src/core", null))).toBe("src/core");
    expect(listLabel(node("external:z", "external", "demo", null, { url: "git@github.com:acme/demo.git" })))
      .toBe("github.com:acme/demo");
  });
});

// ---------------------------------------------------------------------------
// End-to-end: buildGraph over a temp vault/repo → treeRows
// ---------------------------------------------------------------------------

describe("integration: buildGraph → treeRows", () => {
  it("pins the integration of builders ⇄ view-model", async () => {
    const vault = await makeTempDir();
    await withVaultEnv(vault, async () => {
      const repo = await makeTempDir();
      gitInit(repo);
      await writeFixture(repo, "src/index.ts", "export const x = 1;\n");
      commitAll(repo, "init");
      const index = await buildRepoIndex(repo);
      expect(index).not.toBeNull();
      await writeRepoIndex(repo, index!);

      await addNote(vault, { title: "Integration Note", body: "[[other]]", source: "human" });
      await addNote(vault, { title: "other", body: "back", source: "agent" });

      const model = await buildCurrentGraph(repo, vault);
      const rows = treeRows(model, treeState({ expanded: new Set(["vault", "repository", "module:src"]), showInternals: true, now: Date.now() }));
      const ids = rows.map((r) => r.id);
      expect(ids).toContain("vault");
      expect(ids).toContain("repository");
      expect(ids.some((id) => id.startsWith("note:"))).toBe(true);
    });
  });
});