/**
 * src/core/view/tree.ts — treeRows / listLabel / graphRoots / treeEmptyHint.
 *
 * Promoted from tests/pi/viewTuiModel.test.ts + viewTuiCoverage.test.ts when
 * the view-models moved to the portable tier (weave-workspace §3).
 */

import { describe, expect, it } from "vitest";
import { buildCurrentGraph } from "../../../src/core";
import { buildRepoIndex, writeRepoIndex } from "../../../src/core/repoIndex";
import { addNote } from "../../../src/core/vault";
import { graphRoots, listLabel, treeEmptyHint, treeRows } from "../../../src/core/view";
import { commitAll, gitInit, makeTempDir, withVaultEnv, writeFixture } from "../../helpers";
import { graph, node, treeState } from "./fixtures";

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

  it("carries provenance and structured meta on rows", () => {
    const model = graph(
      [
        node("vault", "vault", "Vault", null),
        node("note:a", "note", "A", "human", { updated: "2026-05-01T00:00:00.000Z" }),
      ],
      [{ source: "vault", target: "note:a", kind: "contains" }],
    );
    const row = treeRows(model, treeState()).find((r) => r.id === "note:a")!;
    expect(row.provenance).toBe("human");
    expect(row.meta).toEqual({ kind: "relTime", iso: "2026-05-01T00:00:00.000Z" });
  });
});

// ---------------------------------------------------------------------------
// treeRows meta — the structured TreeMeta produced per node kind
// ---------------------------------------------------------------------------

describe("treeRows meta", () => {
  it("module files → an attribute count; repository files → a prose count", () => {
    const m = graph(
      [
        node("repository", "repository", "repo", null, { files: "5" }),
        node("module:src", "module", "src", null, { path: "src", files: "8" }),
      ],
      [{ source: "repository", target: "module:src", kind: "contains" }],
    );
    const rows = treeRows(m, treeState({ showInternals: true }));
    expect(rows.find((r) => r.id === "module:src")?.meta).toEqual({ kind: "count", n: 8, unit: "files", phrasing: "attribute" });
    expect(rows.find((r) => r.id === "repository")?.meta).toEqual({ kind: "count", n: 5, unit: "files", phrasing: "prose" });
  });

  it("a non-numeric files detail degrades to verbatim text in both phrasings", () => {
    const m = graph(
      [
        node("repository", "repository", "repo", null, { files: "lots" }),
        node("module:src", "module", "src", null, { path: "src", files: "many" }),
      ],
      [{ source: "repository", target: "module:src", kind: "contains" }],
    );
    const rows = treeRows(m, treeState({ showInternals: true }));
    expect(rows.find((r) => r.id === "module:src")?.meta).toEqual({ kind: "text", text: "files=many" });
    expect(rows.find((r) => r.id === "repository")?.meta).toEqual({ kind: "text", text: "lots files" });
  });

  it("gitState → the full sha; package → its kind; entryPoint with a summary → a marker", () => {
    const m = graph(
      [
        node("repository", "repository", "repo", null),
        node("gitState", "gitState", "main @ ab", null, { commit: "abcdef1234567890" }),
        node("package:p", "package", "p", null, { kind: "npm" }),
        node("entryPoint:x", "entryPoint", "x", null, { summary: "s" }),
      ],
      [
        { source: "repository", target: "gitState", kind: "anchored-at" },
        { source: "repository", target: "package:p", kind: "contains" },
        { source: "repository", target: "entryPoint:x", kind: "contains" },
      ],
    );
    const rows = treeRows(m, treeState({ showInternals: true }));
    expect(rows.find((r) => r.id === "gitState")?.meta).toEqual({ kind: "commit", sha: "abcdef1234567890" });
    expect(rows.find((r) => r.id === "package:p")?.meta).toEqual({ kind: "text", text: "npm" });
    expect(rows.find((r) => r.id === "entryPoint:x")?.meta).toEqual({ kind: "text", text: "summary" });
  });

  it("nodes without the relevant detail, and kinds with no meta, carry null", () => {
    const m = graph(
      [
        node("repository", "repository", "repo", null, {}),
        node("module:src", "module", "src", null, {}),
        node("gitState", "gitState", "main", null, {}),
        node("package:p", "package", "p", null, {}),
        node("entryPoint:x", "entryPoint", "x", null, {}),
        node("note:a", "note", "A", "human", {}),
        node("vault", "vault", "Vault", null, {}),
      ],
      [
        { source: "repository", target: "module:src", kind: "contains" },
        { source: "repository", target: "gitState", kind: "anchored-at" },
        { source: "repository", target: "package:p", kind: "contains" },
        { source: "repository", target: "entryPoint:x", kind: "contains" },
        { source: "vault", target: "note:a", kind: "contains" },
      ],
    );
    const rows = treeRows(m, treeState({ showInternals: true }));
    for (const r of rows) expect(r.meta).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// treeRows edge states
// ---------------------------------------------------------------------------

describe("treeRows edge states", () => {
  it("empty graph yields no rows", () => {
    expect(treeRows(graph([], []), treeState())).toEqual([]);
  });
  it("query that matches nothing prunes everything", () => {
    const m = graph(
      [node("vault", "vault", "Vault", null), node("note:a", "note", "A", "human")],
      [{ source: "vault", target: "note:a", kind: "contains" }],
    );
    const rows = treeRows(m, treeState({ query: "zzz" }));
    expect(rows.map((r) => r.id)).not.toContain("note:a");
  });
  it("combined query + provenance filter requires both to match", () => {
    const m = graph(
      [node("vault", "vault", "Vault", null), node("note:alpha", "note", "Alpha", "human"), node("note:beta", "note", "Beta", "agent")],
      [
        { source: "vault", target: "note:alpha", kind: "contains" },
        { source: "vault", target: "note:beta", kind: "contains" },
      ],
    );
    const rows = treeRows(m, treeState({ query: "alph", provFilter: "agent" }));
    // Alpha matches query "alph" but not prov(agent); Beta matches prov but not query → neither shows
    expect(rows.map((r) => r.id)).not.toContain("note:alpha");
    expect(rows.map((r) => r.id)).not.toContain("note:beta");
  });
  it("an edge pointing to a non-existent child is skipped (no crash)", () => {
    const m = graph(
      [node("vault", "vault", "Vault", null), node("note:a", "note", "A", "human")],
      [
        { source: "vault", target: "note:a", kind: "contains" },
        { source: "vault", target: "note:ghost", kind: "contains" }, // ghost not a node
      ],
    );
    const rows = treeRows(m, treeState());
    expect(rows.map((r) => r.id)).toContain("note:a");
  });
  it("orphan entryPoint (no repository contains) hits the empty repoKids fallback", () => {
    const m = graph([node("entryPoint:src/index.ts", "entryPoint", "src/index.ts", null, { path: "src/index.ts" })], []);
    const rows = treeRows(m, treeState({ showInternals: true }));
    expect(rows.map((r) => r.id)).toEqual(["entryPoint:src/index.ts"]);
  });
  it("two entry points under the same module both nest (the accumulate arm)", () => {
    const m = graph(
      [
        node("repository", "repository", "repo", null),
        node("module:src", "module", "src", null, { path: "src" }),
        node("entryPoint:src/a.ts", "entryPoint", "src/a.ts", null, { path: "src/a.ts" }),
        node("entryPoint:src/b.ts", "entryPoint", "src/b.ts", null, { path: "src/b.ts" }),
      ],
      [
        { source: "repository", target: "module:src", kind: "contains" },
        { source: "repository", target: "entryPoint:src/a.ts", kind: "contains" },
        { source: "repository", target: "entryPoint:src/b.ts", kind: "contains" },
      ],
    );
    const rows = treeRows(m, treeState({ expanded: new Set(["repository", "module:src"]), showInternals: true }));
    expect(rows.find((r) => r.id === "entryPoint:src/a.ts")?.depth).toBe(2);
    expect(rows.find((r) => r.id === "entryPoint:src/b.ts")?.depth).toBe(2);
  });
  it("entryPoint without a path detail is not nested under a module", () => {
    const m = graph(
      [node("repository", "repository", "repo", null), node("entryPoint:main", "entryPoint", "main", null, {})],
      [{ source: "repository", target: "entryPoint:main", kind: "contains" }],
    );
    const rows = treeRows(m, treeState({ showInternals: true }));
    expect(rows.map((r) => r.id)).toContain("entryPoint:main");
  });
});

// ---------------------------------------------------------------------------
// treeEmptyHint
// ---------------------------------------------------------------------------

describe("treeEmptyHint", () => {
  it("vault-only with no notes/repo: hint", () => {
    expect(treeEmptyHint(graph([node("vault", "vault", "Vault", null)], []))).toBe("no notes yet — add one with the weave_note tool");
  });
  it("has notes: no hint", () => {
    const m = graph(
      [node("vault", "vault", "Vault", null), node("note:a", "note", "A", "human")],
      [{ source: "vault", target: "note:a", kind: "contains" }],
    );
    expect(treeEmptyHint(m)).toBeNull();
  });
  it("no vault node at all: no hint", () => {
    expect(treeEmptyHint(graph([node("repository", "repository", "repo", null)], []))).toBeNull();
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
  it("external with an empty url falls back to the label", () => {
    expect(listLabel(node("external:x", "external", "fallback", null, { url: "" }))).toBe("fallback");
  });
  it("package without a manifest keeps the label", () => {
    expect(listLabel(node("package:y", "package", "demo", null))).toBe("demo");
  });
  it("a url that strips to nothing falls back to the label", () => {
    expect(listLabel(node("external:x", "external", "bare", null, { url: "https://" }))).toBe("bare");
  });
});

// ---------------------------------------------------------------------------
// graphRoots
// ---------------------------------------------------------------------------

describe("graphRoots", () => {
  it("finds nodes with no incoming contains/anchored-at", () => {
    const m = graph(
      [node("vault", "vault", "Vault", null), node("note:a", "note", "A", "human")],
      [{ source: "vault", target: "note:a", kind: "links-to" }], // links-to does not make a child
    );
    expect(graphRoots(m).sort()).toEqual(["note:a", "vault"]);
  });
  it("an empty graph has no roots", () => {
    expect(graphRoots(graph([], []))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: buildGraph over a temp vault/repo → treeRows
// ---------------------------------------------------------------------------

describe("integration: buildCurrentGraph → treeRows", () => {
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
      const rows = treeRows(model, treeState({ expanded: new Set(["vault", "repository", "module:src"]), showInternals: true }));
      const ids = rows.map((r) => r.id);
      expect(ids).toContain("vault");
      expect(ids).toContain("repository");
      expect(ids.some((id) => id.startsWith("note:"))).toBe(true);
    });
  });
});
