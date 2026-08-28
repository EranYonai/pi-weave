/**
 * `mentions` edges — src/core/graph/mentions.ts and its wiring into
 * `buildGraph` (weave-workspace §4.4, §15.5).
 *
 * Two things are under test and they fail differently, so they are separated:
 * the **regex** (what counts as a path in prose — false positives live here)
 * and the **resolution** (which node a path lands on — edge explosion lives
 * here).
 */

import { describe, expect, it } from "vitest";
import { buildGraph, type BuildGraphInput } from "../../src/core/graph/build";
import { buildPathIndex, extractPathMentions, resolveMentions } from "../../src/core/graph/mentions";
import type { Note, NoteSource, RepoIndex, RepoStructure, StalenessReport } from "../../src/core/types";

const T0 = "2026-01-01T00:00:00.000Z";
const FRESH: StalenessReport = { state: "fresh", reasons: [] };

function note(slug: string, body: string, source: NoteSource = "human"): Note {
  return { slug, title: `Title of ${slug}`, created: T0, updated: T0, tags: [], source, body };
}

function structure(overrides: Partial<RepoStructure> = {}): RepoStructure {
  return {
    capturedAt: T0,
    fileCount: 40,
    languages: { TypeScript: 40 },
    packages: [{ manifestPath: "package.json", kind: "npm", name: "demo" }],
    modules: [
      { path: "(root)", fileCount: 2 },
      { path: "src/core", fileCount: 20 },
      { path: "src/web", fileCount: 10 },
      { path: "docs", fileCount: 8 },
    ],
    entryPoints: ["src/index.ts"],
    topLevel: [{ name: "src", fileCount: 30 }],
    okFiles: [".okf/repository/git.json"],
    ...overrides,
  };
}

function makeIndex(structureOverrides: Partial<RepoStructure> = {}): RepoIndex {
  return {
    okfVersion: 1,
    scope: "repository",
    generator: "pi-weave@test",
    source: "generated",
    created: T0,
    updated: T0,
    identity: { name: "demo", root: "/repo/demo", remotes: [], defaultBranch: "main" },
    git: { headSha: "0".repeat(40), branch: "main", changedFiles: [], changedHashes: {}, capturedAt: T0 },
    structure: structure(structureOverrides),
  };
}

function input(notes: Note[], repo: RepoIndex | null = makeIndex()): BuildGraphInput {
  return {
    vault: { root: "/v", exists: true, noteCount: notes.length },
    notes,
    repository: repo === null ? null : { index: repo, staleness: FRESH },
  };
}

function mentionsOf(model: { edges: { source: string; target: string; kind: string }[] }, slug: string): string[] {
  return model.edges.filter((e) => e.kind === "mentions" && e.source === `note:${slug}`).map((e) => e.target);
}

// --- the regex ----------------------------------------------------------------

describe("extractPathMentions", () => {
  it("finds slash-bearing paths and dedupes by first appearance", () => {
    expect(extractPathMentions("see src/core and src/web then src/core again")).toEqual(["src/core", "src/web"]);
  });

  it("requires a slash — bare words are not paths", () => {
    expect(extractPathMentions("the core module handles vault reads")).toEqual([]);
  });

  it("strips trailing sentence punctuation", () => {
    expect(extractPathMentions("it lives in src/core.")).toEqual(["src/core"]);
    expect(extractPathMentions("(src/web), and src/core; done")).toEqual(["src/web", "src/core"]);
  });

  it("strips a trailing slash so a directory reference normalizes", () => {
    expect(extractPathMentions("under src/core/ there is")).toEqual(["src/core"]);
  });

  it("keeps file extensions and dotted directories intact", () => {
    expect(extractPathMentions("src/core/vault.ts and .okf/repository/git.json")).toEqual([
      "src/core/vault.ts",
      ".okf/repository/git.json",
    ]);
  });

  it("does not read a URL path as a repo path", () => {
    // The lookbehind's whole job. Without it every note containing a GitHub
    // link becomes a mention candidate.
    expect(extractPathMentions("https://github.com/acme/demo/src/core")).toEqual([]);
    expect(extractPathMentions("http://example.com/a/b")).toEqual([]);
  });

  it("does not read an email-ish token as a path", () => {
    expect(extractPathMentions("mail user@host.com/inbox please")).toEqual([]);
  });

  it("finds a path inside markdown emphasis and link syntax", () => {
    expect(extractPathMentions("**src/web/server/routes.ts**")).toEqual(["src/web/server/routes.ts"]);
    expect(extractPathMentions("[the file](src/core/vault.ts)")).toEqual(["src/core/vault.ts"]);
  });

  it("drops a markdown heading anchor", () => {
    expect(extractPathMentions("docs/design.md#section")).toEqual(["docs/design.md"]);
  });

  it("is empty for an empty body", () => {
    expect(extractPathMentions("")).toEqual([]);
  });
});

// --- the path index -----------------------------------------------------------

describe("buildPathIndex", () => {
  it("indexes modules, entry points, packages and okf files to their node ids", () => {
    const index = buildPathIndex(structure());
    expect(index.get("src/core")).toBe("module:src/core");
    expect(index.get("src/index.ts")).toBe("entryPoint:src/index.ts");
    expect(index.get("package.json")).toBe("package:package.json");
    expect(index.get(".okf/repository/git.json")).toBe("okf:repository/git.json");
  });

  it("skips the `(root)` pseudo-module", () => {
    expect(buildPathIndex(structure()).has("(root)")).toBe(false);
  });

  it("prefers the module when a path is both a module and an entry point", () => {
    // The tiebreak only has to be stable; pinning it here is what makes it so.
    const index = buildPathIndex(structure({ entryPoints: ["src/core"] }));
    expect(index.get("src/core")).toBe("module:src/core");
  });

  it("tolerates a structure with no okFiles", () => {
    const s = structure();
    delete s.okFiles;
    expect(buildPathIndex(s).size).toBeGreaterThan(0);
  });
});

// --- resolution granularity ---------------------------------------------------

describe("resolveMentions", () => {
  const paths = buildPathIndex(structure());

  it("resolves an exact module path", () => {
    expect(resolveMentions("see src/core", paths)).toEqual(["module:src/core"]);
  });

  it("resolves a file inside a module up to that module", () => {
    // Most repo files are not nodes, so exact-match-only would drop the
    // majority of real mentions.
    expect(resolveMentions("see src/core/graph/build.ts", paths)).toEqual(["module:src/core"]);
  });

  it("collapses two files in the same module into one edge", () => {
    expect(resolveMentions("src/core/vault.ts and src/core/git.ts", paths)).toEqual(["module:src/core"]);
  });

  it("ignores a path that resolves to nothing indexed", () => {
    // The phantom-node guard: an unindexed path must not invent a target.
    expect(resolveMentions("see vendor/thirdparty/lib.ts", paths)).toEqual([]);
  });

  it("does not expand a module mention downward to its files", () => {
    // The edge-explosion guard, stated directly: "see src/core" is one edge.
    expect(resolveMentions("see src/core", paths)).toHaveLength(1);
  });

  it("prefers the longest enclosing module", () => {
    const nested = buildPathIndex(
      structure({
        modules: [
          { path: "src", fileCount: 30 },
          { path: "src/core", fileCount: 20 },
        ],
      }),
    );
    expect(resolveMentions("src/core/graph/build.ts", nested)).toEqual(["module:src/core"]);
  });

  it("does not absorb a mention into a non-module ancestor", () => {
    // `package.json` is a file. "inside package.json" is not a relationship.
    expect(resolveMentions("see package.json/nested", paths)).toEqual([]);
  });

  it("keeps first-appearance order across distinct targets", () => {
    expect(resolveMentions("docs/design.md then src/web/x.ts then src/core", paths)).toEqual([
      "module:docs",
      "module:src/web",
      "module:src/core",
    ]);
  });

  it("is empty against an empty index", () => {
    expect(resolveMentions("src/core", new Map())).toEqual([]);
  });
});

// --- wiring into buildGraph ---------------------------------------------------

describe("buildGraph emits mentions edges (§15.5: no longer declared-but-dead)", () => {
  it("emits note → module for a body naming a repo path", () => {
    const model = buildGraph(input([note("arch", "The engine lives in src/core.")]));
    expect(model.edges).toContainEqual({ source: "note:arch", target: "module:src/core", kind: "mentions" });
  });

  it("emits nothing when there is no repository half", () => {
    const model = buildGraph(input([note("arch", "src/core and src/web")], null));
    expect(model.edges.filter((e) => e.kind === "mentions")).toEqual([]);
  });

  it("never targets a node that does not exist", () => {
    // The invariant that matters most: a mentions edge pointing at a phantom
    // would make the layout render a node the model never declared.
    const model = buildGraph(
      input([note("a", "src/core, vendor/nope.ts, https://github.com/x/y/z, src/index.ts")]),
    );
    const ids = new Set(model.nodes.map((n) => n.id));
    for (const e of model.edges.filter((edge) => edge.kind === "mentions")) {
      expect(ids.has(e.target)).toBe(true);
    }
  });

  it("resolves an entry point exactly rather than to its module", () => {
    const model = buildGraph(input([note("a", "start at src/index.ts")]));
    expect(mentionsOf(model, "a")).toEqual(["entryPoint:src/index.ts"]);
  });

  it("does not explode: a note naming a whole module contributes one edge", () => {
    const model = buildGraph(input([note("a", "see src/core")]));
    expect(mentionsOf(model, "a")).toHaveLength(1);
  });

  it("bounds edges by distinct mentioned paths, not by repo size", () => {
    // 200 files under one module, all named in the body → still one edge,
    // because they all collapse to `module:src/core`.
    const body = Array.from({ length: 200 }, (_, i) => `src/core/f${i}.ts`).join(" ");
    const model = buildGraph(input([note("big", body)]));
    expect(mentionsOf(model, "big")).toEqual(["module:src/core"]);
  });

  it("respects the note cap — an elided note emits no mentions", () => {
    const notes = [note("keep", "src/core"), note("elided", "src/web")];
    const model = buildGraph(input(notes), { maxNotes: 1 });
    expect(mentionsOf(model, "keep")).toEqual(["module:src/core"]);
    expect(mentionsOf(model, "elided")).toEqual([]);
  });

  it("stays byte-deterministic for identical input", () => {
    const notes = [note("a", "src/core and src/web/x.ts"), note("b", "docs/design.md")];
    expect(JSON.stringify(buildGraph(input(notes)))).toBe(JSON.stringify(buildGraph(input(notes))));
  });

  it("a wiki-link and a path mention coexist on the same note", () => {
    const model = buildGraph(input([note("a", "see [[b]] and src/core"), note("b", "x")]));
    expect(model.edges).toContainEqual({ source: "note:a", target: "note:b", kind: "links-to" });
    expect(model.edges).toContainEqual({ source: "note:a", target: "module:src/core", kind: "mentions" });
  });
});

describe("mentions edge count on a repo-like vault", () => {
  it("scales with distinct mentioned modules, not with the cross product", () => {
    // 20 notes each naming three files spread over three modules. The honest
    // upper bound is 20 x 3 = 60; the failure mode being guarded is a note
    // fanning out to every file under a prefix, which would be unbounded.
    const notes = Array.from({ length: 20 }, (_, i) =>
      note(`n${i}`, `touches src/core/a${i}.ts, src/web/b${i}.ts and docs/c${i}.md`),
    );
    const model = buildGraph(input(notes));
    const mentions = model.edges.filter((e) => e.kind === "mentions");
    expect(mentions).toHaveLength(60);
    // Each note contributed exactly the three distinct modules.
    expect(mentionsOf(model, "n0")).toEqual(["module:src/core", "module:src/web", "module:docs"]);
  });
});
