import { describe, expect, it } from "vitest";
import { buildGraph, dataTimestamp, DEFAULT_MAX_NOTES, type BuildGraphInput } from "../../src/core/graph/build";
import { extractWikilinks } from "../../src/core/graph/wikilinks";
import type { Note, NoteSource, RepoIndex, StalenessReport } from "../../src/core/types";
import type { SummaryRecord } from "../../src/core/summaries";
import { NODE_KINDS } from "../../src/core/graph/model";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-02-01T00:00:00.000Z";
const T2 = "2026-03-01T00:00:00.000Z";

function note(slug: string, source: NoteSource, body: string, updated = T0, tags: string[] = []): Note {
  return { slug, title: `Title of ${slug}`, created: T0, updated, tags, source, body };
}

function makeIndex(overrides: Partial<RepoIndex> = {}): RepoIndex {
  return {
    okfVersion: 1,
    scope: "repository",
    generator: "pi-weave@test",
    source: "generated",
    created: T1,
    updated: T2,
    identity: {
      name: "demo",
      root: "/repo/demo",
      remotes: ["origin https://github.com/acme/demo.git"],
      defaultBranch: "main",
    },
    git: {
      headSha: "0123456789abcdef0123456789abcdef01234567",
      branch: "main",
      changedFiles: [],
      changedHashes: {},
      capturedAt: T2,
    },
    structure: {
      capturedAt: T2,
      fileCount: 42,
      languages: { TypeScript: 30, Markdown: 12 },
      packages: [{ manifestPath: "package.json", kind: "npm", name: "demo" }],
      modules: [
        { path: "(root)", fileCount: 2 },
        { path: "src", fileCount: 28 },
      ],
      entryPoints: ["src/index.ts"],
      topLevel: [{ name: "src", fileCount: 28 }],
    },
    ...overrides,
  };
}

const FRESH: StalenessReport = { state: "fresh", reasons: [] };

function input(overrides: Partial<BuildGraphInput> = {}): BuildGraphInput {
  return {
    vault: { root: "/vault", exists: true, noteCount: 0 },
    notes: [],
    repository: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// extractWikilinks
// ---------------------------------------------------------------------------

describe("extractWikilinks", () => {
  it("extracts plain and aliased links, slugifying display targets", () => {
    expect(extractWikilinks("See [[release-plan]] and [[Release Plan|the plan]].")).toEqual(["release-plan"]);
  });
  it("deduplicates preserving first-appearance order", () => {
    expect(extractWikilinks("[[b]] [[a]] [[b]]")).toEqual(["b", "a"]);
  });
  it("ignores empties, non-link brackets, and unclosed links", () => {
    expect(extractWikilinks("[[]] [x] [[  ]] [[unclosed")).toEqual([]);
  });
  it("handles no links at all", () => {
    expect(extractWikilinks("plain markdown [text](url)")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildGraph — shape
// ---------------------------------------------------------------------------

describe("buildGraph", () => {
  it("produces the two roots with a git anchor and remote node", () => {
    const model = buildGraph(input({
      repository: { index: makeIndex(), staleness: FRESH },
    }));
    const byId = new Map(model.nodes.map((n) => [n.id, n]));
    expect(byId.has("vault")).toBe(true);
    expect(byId.has("repository")).toBe(true);
    expect(byId.get("gitState")?.label).toBe("main @ 0123456");
    const ext = model.nodes.find((n) => n.kind === "external");
    expect(ext?.label).toBe("origin");
    expect(ext?.detail.url).toBe("https://github.com/acme/demo.git");
    expect(ext?.id).toBe("external:https://github.com/acme/demo.git");
    expect(byId.get("package:package.json")?.label).toBe("demo");
    expect(byId.get("module:src")?.detail.files).toBe("28");
    expect(byId.get("module:(root)")?.label).toBe("./ (root files)");
    expect(byId.get("entryPoint:src/index.ts")?.kind).toBe("entryPoint");
    // structural nodes carry no provenance
    expect(byId.get("repository")?.provenance).toBeNull();
    expect(byId.get("vault")?.provenance).toBeNull();

    const kinds = new Set(model.edges.map((e) => e.kind));
    expect(kinds).toEqual(new Set(["contains", "anchored-at"]));
  });

  it("maps note provenance from NoteMeta.source and exposes side-panel detail", () => {
    const model = buildGraph(input({
      vault: { root: "/vault", exists: true, noteCount: 3 },
      notes: [note("a", "human", "alpha body", T0, ["x"]), note("b", "agent", "beta body"), note("c", "generated", "gamma")],
    }));
    const byId = new Map(model.nodes.map((n) => [n.id, n]));
    expect(byId.get("note:a")?.provenance).toBe("human");
    expect(byId.get("note:b")?.provenance).toBe("agent");
    expect(byId.get("note:c")?.provenance).toBe("generated");
    expect(byId.get("note:a")?.detail.tags).toBe("x");
    expect(byId.get("note:a")?.detail.preview).toBe("alpha body");
    expect(byId.get("note:b")?.detail.tags).toBeUndefined();
    const contains = model.edges.filter((e) => e.kind === "contains");
    expect(contains).toHaveLength(3);
    expect(contains.every((e) => e.source === "vault")).toBe(true);
  });

  it("creates links-to edges from wiki-links, counting dangling ones", () => {
    const model = buildGraph(input({
      vault: { root: "/v", exists: true, noteCount: 2 },
      notes: [
        note("one", "human", "links [[two]] and [[Two|again]] plus [[missing]]"),
        note("two", "agent", "backlink [[one]]"),
      ],
    }));
    const links = model.edges.filter((e) => e.kind === "links-to");
    expect(links).toContainEqual({ source: "note:one", target: "note:two", kind: "links-to" });
    expect(links).toContainEqual({ source: "note:two", target: "note:one", kind: "links-to" });
    expect(links).toHaveLength(2); // [[Two|again]] dedupes, [[missing]] drops
    const one = model.nodes.find((n) => n.id === "note:one");
    expect(one?.detail["dangling links"]).toBe("1");
  });

  it("works for an empty vault without a repository", () => {
    const model = buildGraph(input());
    expect(model.nodes).toHaveLength(1);
    expect(model.nodes[0]?.id).toBe("vault");
    expect(model.edges).toEqual([]);
    expect(model.staleness).toBeNull();
    expect(model.generatedAt).toBe("");
  });

  it("passes the staleness report through and surfaces the first reason on the repo node", () => {
    const stale: StalenessReport = { state: "stale", reasons: ["HEAD moved", "dirty tree"] };
    const model = buildGraph(input({ repository: { index: makeIndex(), staleness: stale } }));
    expect(model.staleness).toEqual(stale);
    expect(model.nodes.find((n) => n.id === "repository")?.detail.stale).toBe("HEAD moved");
  });

  it("is byte-identical for identical inputs (polling contract)", () => {
    const build = () =>
      JSON.stringify(buildGraph(input({
        notes: [note("a", "human", "[[b]]"), note("b", "human", "[[a]]")],
        repository: { index: makeIndex(), staleness: FRESH },
      })));
    expect(build()).toBe(build());
  });

  it("caps notes at maxNotes with a vault warning and drops links to elided notes", () => {
    const notes: Note[] = [note("keep", "human", "[[elided]]")];
    for (let i = 0; i < 5; i++) notes.push(note(`elided${i}`, "agent", "x"));
    const model = buildGraph(input({ vault: { root: "/v", exists: true, noteCount: 6 }, notes }), { maxNotes: 1 });
    expect(model.nodes.filter((n) => n.kind === "note")).toHaveLength(1);
    expect(model.nodes.find((n) => n.id === "vault")?.detail.warning).toContain("1");
    expect(model.edges.filter((e) => e.kind === "links-to")).toEqual([]);
  });

  it("has a sane default cap constant", () => {
    expect(DEFAULT_MAX_NOTES).toBe(500);
  });

  it("derives generatedAt from the newest input timestamp, repo included", () => {
    const withRepo = buildGraph(input({
      notes: [note("a", "human", "x", T0)],
      repository: { index: makeIndex(), staleness: FRESH }, // index.updated = T2 (newest)
    }));
    expect(withRepo.generatedAt).toBe(T2);
    const notesOnly = buildGraph(input({ notes: [note("a", "human", "x", T0)] }));
    expect(notesOnly.generatedAt).toBe(T0);
  });

  it("parses bare URLs (what core remotes() emits) into derived labels", () => {
    const index = makeIndex();
    index.identity.remotes = ["git@github.com:acme/demo.git", "https://example.com/org/mono.git/"];
    const model = buildGraph(input({ repository: { index, staleness: FRESH } }));
    const exts = model.nodes.filter((n) => n.kind === "external");
    expect(exts.map((n) => n.label)).toEqual(["demo", "mono"]);
    // ids stay unique even when two URLs would collide on label
    const index2 = makeIndex();
    index2.identity.remotes = ["git@github.com:a/demo.git", "https://github.com/b/demo.git"];
    const model2 = buildGraph(input({ repository: { index: index2, staleness: FRESH } }));
    const ids = model2.nodes.filter((n) => n.kind === "external").map((n) => n.id);
    expect(ids).toEqual(["external:git@github.com:a/demo.git", "external:https://github.com/b/demo.git"]);
  });
});

describe("dataTimestamp", () => {
  it("uses the newest note/index timestamp", () => {
    expect(dataTimestamp(input({ notes: [note("a", "human", "x", T1)] }))).toBe(T1);
  });
});

describe("buildGraph — edge branches", () => {
  it("renders every declared node kind given a full fixture", () => {
    const model = buildGraph(input({
      notes: [note("n", "human", "x")],
      repository: { index: makeIndex(), staleness: FRESH },
    }));
    const kinds = new Set(model.nodes.map((n) => n.kind));
    expect(new Set(NODE_KINDS)).toEqual(kinds);
  });

  it("truncates long note bodies in the preview with an ellipsis", () => {
    const body = "word ".repeat(100);
    const model = buildGraph(input({ notes: [note("long", "human", body)] }));
    const p = model.nodes.find((n) => n.id === "note:long")?.detail.preview ?? "";
    expect(p.endsWith("…")).toBe(true);
    expect(p.length).toBeLessThanOrEqual(241);
  });

  it("keeps a repository with no languages terse, and tolerates stale-without-reasons", () => {
    const index = makeIndex();
    index.structure.languages = {};
    const model = buildGraph(input({
      repository: { index, staleness: { state: "stale", reasons: [] } },
    }));
    const repo = model.nodes.find((n) => n.id === "repository")!;
    expect(repo.detail.languages).toBeUndefined();
    expect(repo.detail.stale).toBeUndefined();
    expect(model.staleness?.state).toBe("stale");
  });

  it("falls back to bare-URL parsing when the first token looks like a URL or user@host", () => {
    const index = makeIndex();
    index.identity.remotes = ["https://ex.com/a b", "user@host: org/repo.git"];
    const model = buildGraph(input({ repository: { index, staleness: FRESH } }));
    const labels = model.nodes.filter((n) => n.kind === "external").map((n) => n.label);
    expect(labels).toEqual(["a b", "repo"]);
  });
});

describe("wikilinks — degenerate targets", () => {
  it("punctuation-only targets fall back to the generic 'note' slug", () => {
    expect(extractWikilinks("[[!!!]] [[ok]]")).toEqual(["note", "ok"]);
  });
});

// ---------------------------------------------------------------------------
// buildGraph — deep-scan summaries
// ---------------------------------------------------------------------------

function summaryRec(over: Partial<SummaryRecord> = {}): SummaryRecord {
  return {
    target: "src/a.ts",
    contentHash: "abc",
    summary: "Does a thing.",
    model: "test/model",
    at: T2,
    source: "generated",
    ...over,
  };
}

describe("buildGraph — summaries", () => {
  it("counts summarized files inside a module and omits the key when none", () => {
    const summaries = new Map<string, SummaryRecord>([
      ["src/a.ts", summaryRec({ target: "src/a.ts" })],
      ["src/b.ts", summaryRec({ target: "src/b.ts" })],
    ]);
    const model = buildGraph(input({ repository: { index: makeIndex(), staleness: FRESH }, summaries }));
    const src = model.nodes.find((n) => n.id === "module:src");
    expect(src?.detail["summarized files"]).toBe("2");
    // a module with no summaries keeps only path/files
    const root = model.nodes.find((n) => n.id === "module:(root)");
    expect(root?.detail["summarized files"]).toBeUndefined();
  });

  it("derives generatedAt from the newest summary timestamp", () => {
    const newer = "2026-04-01T00:00:00.000Z"; // newer than index.updated (T2)
    const model = buildGraph(input({
      repository: { index: makeIndex(), staleness: FRESH },
      summaries: new Map([["src/a.ts", summaryRec({ at: newer })]]),
    }));
    expect(model.generatedAt).toBe(newer);
  });

  it("attaches summary detail to entry points, with and without a model label", () => {
    const withModel = buildGraph(input({
      repository: { index: makeIndex(), staleness: FRESH },
      summaries: new Map([["src/index.ts", summaryRec({ target: "src/index.ts", model: "ollama/kimi" })]]),
    }));
    const ep = withModel.nodes.find((n) => n.id === "entryPoint:src/index.ts");
    expect(ep?.detail.summary).toBe("Does a thing.");
    expect(ep?.detail["summarized by"]).toBe("ollama/kimi");

    const noModel = buildGraph(input({
      repository: { index: makeIndex(), staleness: FRESH },
      summaries: new Map([["src/index.ts", summaryRec({ target: "src/index.ts", model: null })]]),
    }));
    const ep2 = noModel.nodes.find((n) => n.id === "entryPoint:src/index.ts");
    expect(ep2?.detail.summary).toBe("Does a thing.");
    expect(ep2?.detail["summarized by"]).toBeUndefined();
  });
});
