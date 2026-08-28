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
        { path: ".okf", fileCount: 1 },
      ],
      entryPoints: ["src/index.ts"],
      topLevel: [{ name: "src", fileCount: 28 }],
      okFiles: [".okf/repository/git.json"],
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

  it("skips whitespace-only targets (empty after trim)", () => {
    expect(extractWikilinks("[[   ]] [[\t]]")).toEqual([]);
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

  // --- §4.2: the *targets*, not just the count -----------------------------
  //
  // The count alone is a display string. A ghost node the user can click to
  // create the missing note needs the name, which the builder used to throw
  // away.

  it("keeps unresolved wiki-link targets on the model, keyed by slug", () => {
    const model = buildGraph(input({
      vault: { root: "/v", exists: true, noteCount: 2 },
      notes: [
        note("one", "human", "links [[two]] plus [[missing]] and [[Also Gone|alias]]"),
        note("two", "agent", "no links here"),
      ],
    }));
    // First-appearance order, slugified the same way `links-to` targets are.
    expect(model.danglingLinks).toEqual({ one: ["missing", "also-gone"] });
    // A note with nothing unresolved is absent, not present-and-empty.
    expect("two" in model.danglingLinks).toBe(false);
  });

  it("counts and names the same set (detail and danglingLinks cannot disagree)", () => {
    const model = buildGraph(input({
      notes: [note("solo", "human", "[[a]] [[b]] [[a]] [[c]]")],
    }));
    const detailCount = model.nodes.find((n) => n.id === "note:solo")?.detail["dangling links"];
    // `[[a]]` twice dedupes in `extractWikilinks`, so three targets, not four.
    expect(model.danglingLinks.solo).toEqual(["a", "b", "c"]);
    expect(detailCount).toBe(String(model.danglingLinks.solo?.length));
  });

  it("is an empty object when nothing dangles, and for an empty vault", () => {
    const linked = buildGraph(input({
      notes: [note("a", "human", "[[b]]"), note("b", "human", "[[a]]")],
    }));
    expect(linked.danglingLinks).toEqual({});
    expect(buildGraph(input()).danglingLinks).toEqual({});
  });

  it("treats links to notes elided by the cap as dangling", () => {
    // The cap is a *view* over the vault, so a link to a real-but-elided note
    // is unresolved from the graph's point of view. Reporting it as dangling
    // is honest about what this graph can show; reporting it as a link would
    // point at a node that is not there.
    const notes: Note[] = [note("keep", "human", "[[elided0]]")];
    for (let i = 0; i < 3; i++) notes.push(note(`elided${i}`, "agent", "x"));
    const model = buildGraph(input({ vault: { root: "/v", exists: true, noteCount: 4 }, notes }), { maxNotes: 1 });
    expect(model.danglingLinks).toEqual({ keep: ["elided0"] });
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
        // Includes a dangling target, so the §4.2 map is part of what the
        // byte-stability claim covers rather than being tested around.
        notes: [note("a", "human", "[[b]] [[ghost]]"), note("b", "human", "[[a]]")],
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

  it("labels a detached HEAD as (detached)", () => {
    const index = makeIndex();
    index.git.branch = "";
    const model = buildGraph(input({ repository: { index, staleness: FRESH } }));
    const gitState = model.nodes.find((n) => n.id === "gitState")!;
    expect(gitState.label).toContain("(detached)");
    expect(gitState.detail.branch).toBe("(detached)");
  });

  it("sorts equal-count languages alphabetically (localeCompare tiebreak)", () => {
    const index = makeIndex();
    index.structure.languages = { Zig: 5, Go: 5 };
    const model = buildGraph(input({ repository: { index, staleness: FRESH } }));
    const repo = model.nodes.find((n) => n.id === "repository")!;
    expect(repo.detail.languages).toBe("Go (5), Zig (5)");
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

describe("buildGraph — .okf subtree", () => {
  it("renders .okf index files as an expandable subtree under the .okf module", () => {
    const index = makeIndex({
      structure: {
        ...makeIndex().structure,
        modules: [{ path: ".okf", fileCount: 3 }],
        okFiles: [
          ".okf/okf.json",
          ".okf/repository/git.json",
          ".okf/repository/structure.json",
          ".okf/repository/summaries/a.md",
        ],
      },
    });
    const model = buildGraph(input({ repository: { index, staleness: FRESH } }));
    const ids = model.nodes.map((n) => n.id);
    // files are file-kind and path-derived
    expect(ids).toContain("okf:okf.json");
    expect(ids).toContain("okf:repository/git.json");
    expect(ids).toContain("okf:repository/summaries/a.md");
    expect(model.nodes.find((n) => n.id === "okf:okf.json")?.kind).toBe("file");
    // folder containers exist (repository, summaries)
    expect(ids).toContain("module:.okf/repository");
    expect(ids).toContain("module:.okf/repository/summaries");
    // contains edges: file under repository folder, summary under summaries folder
    const edgesOf = (s: string) => model.edges.filter((e) => e.source === s && e.kind === "contains").map((e) => e.target).sort();
    expect(edgesOf("module:.okf/repository")).toEqual(["module:.okf/repository/summaries", "okf:repository/git.json", "okf:repository/structure.json"]);
    expect(edgesOf("module:.okf/repository/summaries")).toEqual(["okf:repository/summaries/a.md"]);
    // the .okf root module itself exists
    expect(ids).toContain("module:.okf");
  });

  it("omits the .okf subtree when there are no ok files", () => {
    const structure = { ...makeIndex().structure, modules: [{ path: "src", fileCount: 2 }] };
    delete structure.okFiles;
    const index = makeIndex({ structure });
    const model = buildGraph(input({ repository: { index, staleness: FRESH } }));
    expect(model.nodes.some((n) => n.id.startsWith("okf:"))).toBe(false);
  });

  it("builds the .okf subtree with only summaries and with only repository files", () => {
    // only a summary file -> repository folder exists but has no direct files
    const sumOnly = makeIndex({
      structure: { ...makeIndex().structure, okFiles: [".okf/repository/summaries/a.md"] },
    });
    const a = buildGraph(input({ repository: { index: sumOnly, staleness: FRESH } }));
    expect(a.nodes.some((n) => n.id === "module:.okf/repository")).toBe(true);
    expect(a.nodes.some((n) => n.id === "okf:repository/summaries/a.md")).toBe(true);
    // only a repository file, no summaries -> no summaries folder node
    const repoOnly = makeIndex({
      structure: { ...makeIndex().structure, okFiles: [".okf/repository/git.json"] },
    });
    const b = buildGraph(input({ repository: { index: repoOnly, staleness: FRESH } }));
    expect(b.nodes.some((n) => n.id === "module:.okf/repository/summaries")).toBe(false);
    expect(b.nodes.some((n) => n.id === "okf:repository/git.json")).toBe(true);
    // only a root-level okf file -> no repository/summaries folders at all
    const rootOnly = makeIndex({
      structure: { ...makeIndex().structure, okFiles: [".okf/okf.json"] },
    });
    const c = buildGraph(input({ repository: { index: rootOnly, staleness: FRESH } }));
    expect(c.nodes.some((n) => n.id === "module:.okf/repository")).toBe(false);
    expect(c.nodes.some((n) => n.id === "okf:okf.json")).toBe(true);
  });
});

describe("extractWikilinks — nested targets", () => {
  it("keeps path separators and slugifies each segment", async () => {
    const { extractWikilinks } = await import("../../src/core/graph/wikilinks");
    expect(extractWikilinks("see [[sessions/my-session]] and [[Release Plan|the plan]]")).toEqual([
      "sessions/my-session",
      "release-plan",
    ]);
    // duplicate handling still applies per resolved slug
    expect(extractWikilinks("[[sessions/a]] [[sessions/a|again]] [[sessions/b]]")).toEqual([
      "sessions/a",
      "sessions/b",
    ]);
  });
});

describe("buildGraph — nested vault notes", () => {
  it("groups notes sharing a slug directory under a folder node", async () => {
    const { buildGraph } = await import("../../src/core/graph/build");
    const note = (slug: string, updated: string): import("../../src/core/graph/build").BuildGraphInput["notes"][number] => ({
      slug, title: slug, body: "", created: "", updated, tags: [], source: "generated",
    });
    const model = buildGraph({
      vault: { root: "/v", exists: true, noteCount: 3 },
      notes: [note("sessions/a", "2026-01-01"), note("sessions/b", "2026-01-02"), note("flat", "2026-01-03")],
      repository: null,
    });
    const byId = new Map(model.nodes.map((n) => [n.id, n]));
    const folder = byId.get("vfolder:sessions");
    expect(folder?.kind).toBe("module");
    expect(folder?.label).toBe("sessions");
    expect(folder?.detail.notes).toBe("2");
    // contains edges: vault → folder → both nested notes; flat note direct
    const contains = model.edges.filter((e) => e.kind === "contains");
    expect(contains).toContainEqual({ source: "vault", target: "vfolder:sessions", kind: "contains" });
    expect(contains).toContainEqual({ source: "vfolder:sessions", target: "note:sessions/a", kind: "contains" });
    expect(contains).toContainEqual({ source: "vfolder:sessions", target: "note:sessions/b", kind: "contains" });
    expect(contains).toContainEqual({ source: "vault", target: "note:flat", kind: "contains" });
    // the folder is not a dangling-link target and the tree nests two levels deep
    const treeRowsMod = await import("../../src/core/view/tree");
    const rows = treeRowsMod.treeRows(model, {
      expanded: new Set(["vault", "vfolder:sessions"]),
      query: "",
      provFilter: null,
      showInternals: true,
    });
    const ids = rows.map((r) => r.id);
    const folderIdx = ids.indexOf("vfolder:sessions");
    expect(folderIdx).toBeGreaterThan(ids.indexOf("vault"));
    expect(ids.indexOf("note:sessions/a")).toBeGreaterThan(folderIdx);
  });

  it("supports multi-level nesting with parents before children", async () => {
    const { buildGraph } = await import("../../src/core/graph/build");
    const note = (slug: string): import("../../src/core/graph/build").BuildGraphInput["notes"][number] => ({
      slug, title: slug, body: "", created: "", updated: "2026-01-01", tags: [], source: "generated",
    });
    const model = buildGraph({
      vault: { root: "/v", exists: true, noteCount: 2 },
      notes: [note("a/b/deep"), note("a/shallow")],
      repository: null,
    });
    const ids = model.nodes.map((n) => n.id);
    expect(ids.indexOf("vfolder:a")).toBeLessThan(ids.indexOf("vfolder:a/b"));
    const contains = model.edges.filter((e) => e.kind === "contains");
    expect(contains).toContainEqual({ source: "vault", target: "vfolder:a", kind: "contains" });
    expect(contains).toContainEqual({ source: "vfolder:a", target: "vfolder:a/b", kind: "contains" });
    expect(contains).toContainEqual({ source: "vfolder:a/b", target: "note:a/b/deep", kind: "contains" });
    expect(contains).toContainEqual({ source: "vfolder:a", target: "note:a/shallow", kind: "contains" });
  });
});
