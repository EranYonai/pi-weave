import { describe, expect, it } from "vitest";
import { fetchSearch } from "../../src/web/client/api";
import type { FetchLike } from "../../src/web/client/api";
import { ICONS } from "../../src/web/client/shell/icons.model";
import type { GraphPayload, NoteSearchHit, WireGraphNode, WireNodeKind } from "../../src/web/shared/wire";
import {
  DEBOUNCE_MS,
  LIGHT_UP_KEY,
  MAX_EVIDENCE,
  MAX_RESULTS,
  MIN_TERM,
  NODE_DETAIL_KEYS,
  NODE_TEXT_KEYS,
  NO_INTENT,
  PALETTE_HINT,
  PALETTE_PLACEHOLDER,
  PALETTE_TITLE,
  SCOPE_GROUP_LABEL,
  SCOPE_LABELS,
  SEARCH_GLYPH,
  SEARCH_GROUPS,
  SEARCH_SCOPES,
  SNIPPET_CONTEXT,
  SNIPPET_LEAD,
  TAG_GLYPH,
  ageLabel,
  clampCursor,
  closesPalette,
  compareResults,
  cycleScope,
  effectiveScope,
  evidenceScore,
  folderOf,
  groupDomId,
  highlightTerms,
  iconDef,
  initialSearchState,
  labelScore,
  lightUpIntent,
  lightUpLabel,
  matchRanges,
  mergeResults,
  nextState,
  nodeBadge,
  nodeDetail,
  nodeGroup,
  nodeScore,
  nodeText,
  noteCountLabel,
  noteNodeId,
  noteScore,
  paletteKey,
  paletteModel,
  plainText,
  resultMeta,
  rowDomId,
  rowIntent,
  scopeCounts,
  searchKey,
  searchStatus,
  serverQuery,
  snippetParts,
  snippetText,
  tagQuery,
  tagResults,
  taggedSlugs,
  tldrOf,
  toParts,
  visibleScopes,
  wrapCursor,
} from "../../src/web/client/search/search.model";
import type { PaletteKeyInput, PaletteModel, SearchResult, SearchState } from "../../src/web/client/search/search.model";

const NOW = Date.parse("2026-03-04T12:00:00Z");

function node(id: string, kind: WireNodeKind, label: string, detail: Record<string, string> = {}): WireGraphNode {
  return { id, kind, label, provenance: null, detail };
}

function hit(slug: string, title: string, score: number, snippet = "…body…", updated = "2026-03-04T10:00:00Z"): NoteSearchHit {
  return { summary: { slug, title, created: "2026-01-01T00:00:00Z", updated, tags: [], source: "human", bodyLength: 10 }, score, snippet };
}

function payload(nodes: WireGraphNode[], tags: Record<string, string[]> = {}): GraphPayload {
  return { model: { generatedAt: "2026-03-04T09:08:07Z", staleness: null, nodes, edges: [], contentDigest: "" }, tags, dangling: {}, positions: null, stamp: "abc" };
}

function result(overrides: Partial<SearchResult> = {}): SearchResult {
  return { id: "a", kind: "node", group: "code", icon: "module", label: "same", detail: "", badge: "module", score: 10, path: "", updated: "", ...overrides };
}

function keyIn(key: string, extra: Partial<PaletteKeyInput> = {}): PaletteKeyInput {
  return { key, shift: false, mod: false, inInput: true, ...extra };
}

/** A palette over two notes, a module and a tag, all matching "launch". */
function launchModel(state: Partial<SearchState> = {}): PaletteModel {
  const graph = payload(
    [node("module:src/launch", "module", "src/launch", { path: "src/launch" }), node("note:projects/launch-checklist", "note", "Launch checklist")],
    { launch: ["projects/launch-checklist", "launch-post"], other: ["x"] },
  );
  const hits = [hit("projects/launch-checklist", "Launch checklist", 4, "**TLDR:** README demo is done; the launch posts are still open."), hit("launch-post", "Launch post draft", 2)];
  return paletteModel({ ...initialSearchState(), query: "launch", answered: "launch", hits, ...state }, graph, NOW);
}

describe("search ranking", () => {
  it("scores exact, prefix, boundary, interior, misses and empty queries", () => {
    expect(labelScore("layout", "layout")).toBe(100);
    expect(labelScore("layout.model", "layout")).toBe(70);
    expect(labelScore("graph/layout", "layout")).toBe(50);
    expect(labelScore("relayouting", "layout")).toBe(30);
    expect(labelScore("d3-force", "force")).toBe(50);
    expect(labelScore("utf8encode", "encode")).toBe(30);
    expect(labelScore("layout", "sigma")).toBe(0);
    expect(labelScore("layout", "   ")).toBe(0);
    expect(labelScore("Graph", " graph ")).toBe(100);
  });

  it("keeps evidence below a label match and clamps it", () => {
    expect(evidenceScore(MAX_EVIDENCE)).toBeLessThan(labelScore("relayouting", "layout"));
    expect(evidenceScore(-1)).toBe(0);
    expect(evidenceScore(999)).toBe(MAX_EVIDENCE * 2);
    expect(noteScore(hit("a", "Layout", 4), "layout")).toBe(108);
    expect(noteScore(hit("a", "Other", 5), "layout")).toBe(10);
    expect(nodeScore(node("m", "module", "src/layout"), "layout")).toBe(50);
  });

  it("resolves node details, text and badges", () => {
    expect(NODE_DETAIL_KEYS).toEqual(["path", "manifest", "url", "slug"]);
    expect(NODE_TEXT_KEYS).toEqual(["preview", "summary", "description"]);
    expect(nodeDetail(node("m", "module", "m", { path: "src", slug: "ignored" }))).toBe("src");
    expect(nodeDetail(node("e", "external", "gh", { url: "https://x" }))).toBe("https://x");
    expect(nodeDetail(node("n", "note", "n", { slug: "alpha" }))).toBe("alpha");
    expect(nodeDetail(node("v", "vault", "Vault", { notes: "2" }))).toBe("");
    // Prose first, then a locator, and never the label said twice.
    expect(nodeText(node("e", "entryPoint", "src/main.ts", { path: "src/main.ts", summary: "Starts the server." }))).toBe("Starts the server.");
    expect(nodeText(node("n", "note", "Alpha", { slug: "alpha", preview: "Body text" }))).toBe("Body text");
    expect(nodeText(node("m", "module", "src", { path: "src" }))).toBe("");
    expect(nodeText(node("f", "file", "okf.json", { path: ".okf/okf.json" }))).toBe(".okf/okf.json");
    expect(nodeBadge(node("entryPoint:x", "entryPoint", "x"))).toBe("entry point");
    expect(nodeBadge(node("gitState", "gitState", "main"))).toBe("git");
    expect(nodeBadge(node("external:u", "external", "u"))).toBe("remote");
    expect(nodeBadge(node("module:src", "module", "src"))).toBe("module");
    expect(nodeBadge(node("vfolder:projects", "module", "projects"))).toBe("folder");
    expect(nodeBadge(node("artifact:a.html", "file", "A"))).toBe("artifact");
    expect(noteNodeId("alpha")).toBe("note:alpha");
  });

  it("groups the vault under notes and the repository under code", () => {
    expect(nodeGroup(node("note:a", "note", "a"))).toBe("notes");
    expect(nodeGroup(node("vault", "vault", "Vault"))).toBe("notes");
    expect(nodeGroup(node("vfolder:projects", "module", "projects"))).toBe("notes");
    expect(nodeGroup(node("artifact:a.html", "file", "A"))).toBe("notes");
    for (const kind of ["module", "package", "entryPoint", "file", "repository", "gitState", "external"] as const) {
      expect(nodeGroup(node(`${kind}:x`, kind, "x")), kind).toBe("code");
    }
  });

  it("merges, dedupes, orders and caps notes and graph nodes", () => {
    const rows = mergeResults([hit("alpha", "Alpha", 3)], "alpha", [node("module:src/alpha", "module", "src/alpha")], "alpha");
    expect(rows.map((row) => row.kind)).toEqual(["note", "node"]);
    expect(mergeResults([hit("alpha", "Alpha", 3)], "alpha", [node("note:alpha", "note", "Alpha")], "alpha")).toHaveLength(1);
    const a = result();
    expect(compareResults(a, { ...a, id: "b" })).toBeLessThan(0);
    expect(compareResults({ ...a, score: 5 }, a)).toBeGreaterThan(0);
    expect(compareResults({ ...a, kind: "note" }, a)).toBeLessThan(0);
    expect(compareResults(a, { ...a, kind: "note" })).toBeGreaterThan(0);
    const many = Array.from({ length: MAX_RESULTS + 1 }, (_, i) => node(`n${i}`, "module", `thing-${i}`));
    expect(mergeResults([], "thing", many, "thing")).toHaveLength(MAX_RESULTS);
  });

  it("orders groups notes, code, tags whatever the scores, and caps each group on its own", () => {
    const code = Array.from({ length: MAX_RESULTS + 2 }, (_, i) => node(`module:launch-${i}`, "module", `launch-${i}`));
    const notes = [node("note:a", "note", "a launch"), node("vfolder:launch", "module", "launch")];
    const rows = mergeResults([hit("b", "B", 1)], "launch", [...code, ...notes], "launch", { launch: ["b"] });
    expect(rows.map((row) => row.group)).toEqual([
      "notes", "notes", "notes",
      ...Array.from({ length: MAX_RESULTS }, () => "code"),
      "tags",
    ]);
    // The folder outranks the interior label match, and the evidence-only hit comes last.
    expect(rows.slice(0, 3).map((row) => row.id)).toEqual(["vfolder:launch", "note:a", "note:b"]);
  });

  it("carries what a row needs: icon, path, update time and text", () => {
    const [note, folder, artifact] = mergeResults(
      [hit("projects/alpha", "Alpha", 3, "snip", "2026-03-04T10:00:00Z")],
      "alpha",
      [node("artifact:projects/alpha.html", "file", "alpha deck", { path: "projects/alpha.html", updated: "2026-03-01T00:00:00Z", description: "Slides" }), node("vfolder:alpha", "module", "alpha", { path: "alpha", notes: "1" })],
      "alpha",
    );
    expect(note).toMatchObject({ id: "note:projects/alpha", icon: "note", path: "projects/alpha", updated: "2026-03-04T10:00:00Z", detail: "snip", badge: "note" });
    expect(folder).toMatchObject({ icon: "module", group: "notes", badge: "folder", path: "", updated: "" });
    expect(artifact).toMatchObject({ icon: "file", group: "notes", badge: "artifact", path: "projects/alpha.html", detail: "Slides" });
  });
});

describe("tag search", () => {
  const tags = { launch: ["a", "b", "c"], planning: ["a"], relaunch: ["d"] };

  it("tells a tag query from an ordinary one", () => {
    expect(tagQuery("#launch")).toBe("launch");
    expect(tagQuery("  # launch ")).toBe("launch");
    expect(tagQuery("#")).toBe("");
    expect(tagQuery("launch")).toBeNull();
    expect(serverQuery(" launch ")).toBe("launch");
    expect(serverQuery("#launch")).toBe("");
    expect(serverQuery("   ")).toBe("");
  });

  it("finds tags by name, keeping the index's order on ties", () => {
    const rows = tagResults(tags, "launch");
    expect(rows.map((row) => row.label)).toEqual(["#launch", "#relaunch"]);
    expect(rows[0]).toMatchObject({ id: "tag:launch", kind: "tag", group: "tags", icon: "tag", detail: "3 notes", badge: "tag" });
    expect(tagResults(tags, "#plan").map((row) => row.detail)).toEqual(["1 note"]);
    expect(tagResults(tags, "#").map((row) => row.label)).toEqual(["#launch", "#planning", "#relaunch"]);
    expect(tagResults(tags, "")).toEqual([]);
    expect(noteCountLabel(1)).toBe("1 note");
    expect(noteCountLabel(2)).toBe("2 notes");
  });

  it("maps a tag to the notes carrying it, keeping each note's best score", () => {
    const slugs = taggedSlugs(tags, "launch");
    expect(slugs.get("a")).toBe(100);
    expect(slugs.get("d")).toBe(30);
    expect(slugs.has("x")).toBe(false);
    expect(taggedSlugs({ launch: ["a"], "launch-day": ["a"] }, "launch").get("a")).toBe(100);
    expect(taggedSlugs({ "launch-day": ["a"], launch: ["a"] }, "launch").get("a")).toBe(100);
  });

  it("answers a # query with the tag's notes and no code", () => {
    const nodes = [node("note:a", "note", "Alpha"), node("note:z", "note", "Zed"), node("module:launch", "module", "launch")];
    const rows = mergeResults([], "", nodes, "#launch", tags);
    expect(rows.map((row) => row.id)).toEqual(["note:a", "tag:launch", "tag:relaunch"]);
    expect(mergeResults([], "", nodes, "#", tags).map((row) => row.group)).toEqual(["tags", "tags", "tags"]);
  });
});

describe("snippets", () => {
  it("prefers the TLDR, up to a blank line or a heading", () => {
    expect(tldrOf("**TLDR:** Demo done; posts open.\n- [ ] HN post\n\n## Plan\nMore")).toBe("Demo done; posts open.\n- [ ] HN post");
    expect(tldrOf("…**TLDR:** Demo done. ## Plan Phase 1")).toBe("Demo done.");
    expect(tldrOf("TL;DR: short")).toBe("short");
    expect(tldrOf("**TLDR**: bold colon")).toBe("bold colon");
    expect(tldrOf("__TL;DR__ underscored")).toBe("underscored");
    expect(tldrOf("**TLDR: inside bold** then")).toBe("inside bold** then");
    expect(tldrOf("No summary here")).toBeNull();
    // Prose that mentions a TLDR is not one.
    expect(tldrOf("Testers want the *TLDR* before launch")).toBeNull();
    expect(tldrOf("a TLDR before launch")).toBeNull();
    expect(tldrOf("**TLDR:** ## Plan")).toBeNull();
    expect(snippetText("**TLDR:** README demo is done; the **launch** posts are open.\n- [ ] HN post\n\n## Plan")).toBe("README demo is done; the launch posts are open. HN post");
    expect(snippetText("Plain [[launch-checklist|the checklist]] text")).toBe("Plain the checklist text");
  });

  it("turns wikilinks into their display text, whole or cut at either end", () => {
    expect(plainText("See [[launch-checklist]] and [[roadmap|the roadmap]].")).toBe("See launch-checklist and the roadmap.");
    expect(plainText("Embed ![[diagram.png]] here")).toBe("Embed diagram.png here");
    expect(plainText("Empty alias [[target|]] uses target")).toBe("Empty alias target uses target");
    expect(plainText("…ecklist|the checklist]] says go")).toBe("…the checklist says go");
    expect(plainText("…h-checklist]] says go")).toBe("…h-checklist says go");
    expect(plainText("then see [[launch-che…")).toBe("then see launch-che…");
    expect(plainText("then see [[launch|the lau…")).toBe("then see the lau…");
    expect(plainText("odd [[ bracket")).toBe("odd bracket");
  });

  it("strips Markdown syntax, including line syntax left mid-line by a collapsed snippet", () => {
    expect(plainText("# Title\n\nSome **bold**, *em*, _under_, __strong__ and ~~gone~~ text.")).toBe("Title Some bold, em, under, strong and gone text.");
    expect(plainText("intro ## Decisions We ship")).toBe("intro Decisions We ship");
    expect(plainText("#launch and C# stay")).toBe("#launch and C# stay");
    expect(plainText("A [link](http://x.test) and ![alt](pic.png)")).toBe("A link and alt");
    expect(plainText("Run `npm *test*` now")).toBe("Run npm *test* now");
    expect(plainText("```ts const a = 1; ``` after")).toBe("const a = 1; after");
    expect(plainText("> quoted\n> more")).toBe("quoted more");
    expect(plainText("- one\n* two\n+ three\n1. four\n2) five")).toBe("one two three four five");
    expect(plainText("done - [x] shipped - [ ] review")).toBe("done shipped review");
    expect(plainText("above\n\n---\n\nbelow * * * end")).toBe("above below end");
    expect(plainText("a <b>bold</b> <br/> tag, but 1 < 2 > 0")).toBe("a bold tag, but 1 < 2 > 0");
    expect(plainText("snake_case_name and 2*3*4 stay")).toBe("snake_case_name and 2*3*4 stay");
    expect(plainText("cut **bold at the end")).toBe("cut bold at the end");
    expect(plainText("escaped \\* star and \\[x\\]")).toBe("escaped * star and [x]");
    expect(plainText("a list * item")).toBe("a list item");
  });

  it("marks every match of the query and its words, merged", () => {
    expect(highlightTerms("  ")).toEqual([]);
    expect(highlightTerms("#")).toEqual([]);
    expect(highlightTerms("#launch")).toEqual(["launch"]);
    expect(highlightTerms("launch a post")).toEqual(["launch a post", "launch", "post"]);
    expect(MIN_TERM).toBe(2);
    expect(matchRanges("Launch the launch", "launch")).toEqual([[0, 6], [11, 17]]);
    expect(matchRanges("the launch post", "launch post")).toEqual([[4, 15]]);
    expect(matchRanges("post then launch", "launch post")).toEqual([[0, 4], [10, 16]]);
    expect(matchRanges("a.b axb", "a.b")).toEqual([[0, 3]]);
    expect(matchRanges("nothing", "zz")).toEqual([]);
    expect(matchRanges("aaaa", "aa")).toEqual([[0, 4]]);
  });

  it("splits text into plain and marked parts", () => {
    expect(toParts("Launch the launch.", [[0, 6], [11, 17]])).toEqual([
      { text: "Launch", mark: true },
      { text: " the ", mark: false },
      { text: "launch", mark: true },
      { text: ".", mark: false },
    ]);
    expect(toParts("plain", [])).toEqual([{ text: "plain", mark: false }]);
    expect(toParts("", [])).toEqual([]);
  });

  it("brings a far-off match forward so the ellipsis cannot hide it", () => {
    expect(snippetParts("the **launch** post", "launch")).toEqual([
      { text: "the ", mark: false },
      { text: "launch", mark: true },
      { text: " post", mark: false },
    ]);
    const long = `${"word ".repeat(20)}then the launch happens`;
    const parts = snippetParts(long, "launch");
    expect(SNIPPET_LEAD).toBeGreaterThan(SNIPPET_CONTEXT);
    expect(parts[0]?.text.startsWith("…")).toBe(true);
    expect(parts[0]?.text.length).toBeLessThanOrEqual(SNIPPET_CONTEXT + 1);
    expect(parts[1]).toEqual({ text: "launch", mark: true });
    expect(parts.map((part) => part.text).join("")).toBe("…word then the launch happens");
    // One long token before the match: cut mid-token rather than lose it.
    const token = `${"x".repeat(60)}launch`;
    expect(snippetParts(token, "launch")).toEqual([{ text: `…${"x".repeat(SNIPPET_CONTEXT)}`, mark: false }, { text: "launch", mark: true }]);
    expect(snippetParts("", "launch")).toEqual([]);
  });
});

describe("row labels", () => {
  it("names a note's folder and age, a node's kind, and nothing for a tag", () => {
    expect(folderOf("projects/2026/plan")).toBe("projects/2026");
    expect(folderOf("plan")).toBe("");
    expect(ageLabel("2026-03-04T10:00:00Z", NOW)).toBe("2h");
    expect(ageLabel("2026-03-04T11:59:59Z", NOW)).toBe("just now");
    expect(resultMeta(result({ kind: "note", path: "projects/plan", updated: "2026-03-01T12:00:00Z" }), NOW)).toBe("projects · 3d");
    expect(resultMeta(result({ kind: "note", path: "plan", updated: "2026-03-04T11:00:00Z" }), NOW)).toBe("1h");
    expect(resultMeta(result({ kind: "note", path: "projects/plan", updated: "garbage" }), NOW)).toBe("projects");
    expect(resultMeta(result({ badge: "entry point" }), NOW)).toBe("entry point");
    expect(resultMeta(result({ kind: "tag", badge: "tag" }), NOW)).toBe("");
  });

  it("resolves icons from the sprite and the palette's own glyphs", () => {
    expect(iconDef("note")).toBe(ICONS.note);
    expect(iconDef("tag")).toBe(TAG_GLYPH);
    for (const glyph of [SEARCH_GLYPH, TAG_GLYPH]) {
      for (const d of glyph.d) expect(d.toLowerCase()).not.toContain("url(");
    }
  });
});

describe("scopes", () => {
  const counts = { all: 7, notes: 4, code: 0, tags: 3 };

  it("counts results per group and hides empty scopes except All", () => {
    expect(SEARCH_GROUPS).toEqual(["notes", "code", "tags"]);
    expect(SEARCH_SCOPES).toEqual(["all", "notes", "code", "tags"]);
    expect(SCOPE_LABELS).toEqual({ all: "All", notes: "Notes", code: "Code", tags: "Tags" });
    expect(scopeCounts([result({ group: "notes" }), result({ group: "code" }), result({ group: "code" })])).toEqual({ all: 3, notes: 1, code: 2, tags: 0 });
    expect(visibleScopes(counts)).toEqual(["all", "notes", "tags"]);
    expect(visibleScopes({ all: 0, notes: 0, code: 0, tags: 0 })).toEqual(["all"]);
  });

  it("falls back to All while the chosen scope has nothing", () => {
    expect(effectiveScope("notes", counts)).toBe("notes");
    expect(effectiveScope("code", counts)).toBe("all");
  });

  it("cycles forward and back, wrapping", () => {
    const visible = visibleScopes(counts);
    expect(cycleScope(visible, "all", false)).toBe("notes");
    expect(cycleScope(visible, "tags", false)).toBe("all");
    expect(cycleScope(visible, "all", true)).toBe("tags");
    expect(cycleScope(visible, "code", false)).toBe("notes");
    expect(cycleScope([], "all", false)).toBe("all");
  });
});

describe("search state presentation", () => {
  it("passes cancellation through the request port", async () => {
    let signal: { readonly aborted: boolean } | undefined;
    const fetch: FetchLike = (_url, init) => {
      signal = init?.signal;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ query: "a", hits: [] }) });
    };
    const controller = { aborted: false };
    await fetchSearch(fetch, "a", controller);
    expect(signal).toBe(controller);
  });

  it("initializes, clamps and wraps", () => {
    const state = initialSearchState();
    expect(state).toEqual({ query: "", answered: "", hits: [], cursor: 0, scope: "all", loading: false, failed: false });
    expect(clampCursor(9, 3)).toBe(2);
    expect(clampCursor(-1, 3)).toBe(0);
    expect(clampCursor(2, 0)).toBe(0);
    expect(wrapCursor(2, 1, 3)).toBe(0);
    expect(wrapCursor(0, -1, 3)).toBe(2);
    expect(wrapCursor(0, -1, 0)).toBe(0);
  });

  it("handles keyboard navigation and leaves unrelated keys alone", () => {
    expect(searchKey(1, "ArrowDown", 3).cursor).toBe(2);
    expect(searchKey(0, "ArrowUp", 3).cursor).toBe(2);
    expect(searchKey(1, "Home", 3).cursor).toBe(0);
    expect(searchKey(1, "End", 3).cursor).toBe(2);
    expect(searchKey(40, "ArrowDown", 3).cursor).toBe(0);
    expect(searchKey(1, "Enter", 3)).toMatchObject({ cursor: 1, activate: 1, dismiss: true, handled: true });
    expect(searchKey(1, "Enter", 0)).toMatchObject({ activate: null, handled: false });
    expect(searchKey(1, "Escape", 3)).toMatchObject({ activate: null, dismiss: true, handled: true });
    expect(searchKey(1, "Tab", 3).handled).toBe(false);
  });

  it("renders statuses", () => {
    const state = initialSearchState();
    expect(searchStatus(state, 0)).toContain("Type to search");
    expect(searchStatus(state, 0)).toContain("#");
    expect(searchStatus({ ...state, query: "a" }, 3)).toBeNull();
    expect(searchStatus({ ...state, query: "a", loading: true }, 0)).toBe("searching…");
    expect(searchStatus({ ...state, query: "a", failed: true }, 0)).toContain("failed");
    expect(searchStatus({ ...state, query: " zz " }, 0)).toContain("zz");
    expect(PALETTE_TITLE).not.toBe("");
    expect(PALETTE_PLACEHOLDER.toLowerCase()).toContain("notes");
    expect(PALETTE_HINT).toBe("↑↓ move · ↵ open · ⌘↵ open in new tab · Tab scope");
    expect(SCOPE_GROUP_LABEL).not.toBe("");
    expect(LIGHT_UP_KEY).toBe("⇧↵");
    expect(lightUpLabel(7)).toBe("Light up 7 in the graph");
    expect(DEBOUNCE_MS).toBe(140);
  });
});

describe("paletteModel", () => {
  it("groups the visible rows under counted headings and indexes them as one list", () => {
    const model = launchModel();
    expect(model.groups.map((group) => group.heading)).toEqual(["Notes · 2", "Code · 1", "Tags · 1"]);
    expect(model.groups.map((group) => group.domId)).toEqual([groupDomId("notes"), groupDomId("code"), groupDomId("tags")]);
    expect(model.rows.map((row) => row.index)).toEqual([0, 1, 2, 3]);
    expect(model.rows.map((row) => row.domId)).toEqual([0, 1, 2, 3].map(rowDomId));
    expect(model.groups.flatMap((group) => group.rows)).toEqual(model.rows);
    expect(model.count).toBe(4);
    expect(model.query).toBe("launch");
    expect(model.lightUp).toEqual(["note:projects/launch-checklist", "note:launch-post", "module:src/launch"]);
    expect(model.status).toBeNull();
  });

  it("builds each row's icon, face, snippet and meta", () => {
    const [checklist, post, code, tag] = launchModel().rows;
    expect(checklist).toMatchObject({ label: "Launch checklist", icon: ICONS.note, mono: false, meta: "projects · 2h", active: true });
    expect(checklist?.parts).toEqual([
      { text: "README demo is done; the ", mark: false },
      { text: "launch", mark: true },
      { text: " posts are still open.", mark: false },
    ]);
    expect(post?.meta).toBe("2h");
    expect(code).toMatchObject({ label: "src/launch", mono: true, meta: "module", parts: [], group: "code" });
    expect(tag).toMatchObject({ label: "#launch", icon: TAG_GLYPH, meta: "", parts: [{ text: "2 notes", mark: false }] });
  });

  it("lists All and every non-empty scope, with the active one marked", () => {
    expect(launchModel().scopes).toEqual([
      { scope: "all", label: "All", count: 4, active: true },
      { scope: "notes", label: "Notes", count: 2, active: false },
      { scope: "code", label: "Code", count: 1, active: false },
      { scope: "tags", label: "Tags", count: 1, active: false },
    ]);
    expect(launchModel({ query: "", answered: "", hits: [] }).scopes).toEqual([]);
  });

  it("narrows to a scope, and falls back to All when it empties", () => {
    const code = launchModel({ scope: "code" });
    expect(code.scope).toBe("code");
    expect(code.rows.map((row) => row.id)).toEqual(["module:src/launch"]);
    expect(code.rows[0]?.domId).toBe(rowDomId(0));
    expect(code.lightUp).toHaveLength(3);
    // Typed past what the server answered: its hits for "launch" do not light "launch c".
    expect(launchModel({ query: "launch c" }).lightUp).toEqual(["note:projects/launch-checklist"]);
    const gone = paletteModel({ ...initialSearchState(), query: "zz", scope: "code" }, payload([]), NOW);
    expect(gone.scope).toBe("all");
    expect(gone.scopes).toEqual([{ scope: "all", label: "All", count: 0, active: true }]);
  });

  it("clamps the cursor and points the combobox at the active row", () => {
    const model = launchModel({ cursor: 9 });
    expect(model.cursor).toBe(3);
    expect(model.activeDomId).toBe(rowDomId(3));
    expect(model.rows.filter((row) => row.active).map((row) => row.index)).toEqual([3]);
    const empty = paletteModel({ ...initialSearchState(), query: "x" }, null, NOW);
    expect(empty.rows).toEqual([]);
    expect(empty.groups).toEqual([]);
    expect(empty.activeDomId).toBeNull();
  });
});

describe("intents", () => {
  const model = launchModel();

  it("cycles the scope with Tab while the input has focus", () => {
    expect(paletteKey(model, keyIn("Tab"), false)).toEqual({ type: "scope", scope: "notes" });
    expect(paletteKey(model, keyIn("Tab", { shift: true }), false)).toEqual({ type: "scope", scope: "tags" });
    expect(paletteKey(launchModel({ scope: "tags" }), keyIn("Tab"), false)).toEqual({ type: "scope", scope: "all" });
  });

  it("leaves Tab to the focus trap elsewhere, with modifiers, or with nothing to cycle", () => {
    expect(paletteKey(model, keyIn("Tab", { inInput: false }), false)).toBe(NO_INTENT);
    expect(paletteKey(model, keyIn("Tab", { mod: true }), false)).toBe(NO_INTENT);
    expect(paletteKey(launchModel({ query: "", answered: "", hits: [] }), keyIn("Tab"), false)).toBe(NO_INTENT);
  });

  it("moves across groups as one list and closes on Escape", () => {
    expect(paletteKey(model, keyIn("ArrowDown"), false)).toEqual({ type: "move", cursor: 1 });
    expect(paletteKey(launchModel({ cursor: 1 }), keyIn("ArrowDown"), false)).toEqual({ type: "move", cursor: 2 });
    expect(paletteKey(model, keyIn("ArrowUp"), false)).toEqual({ type: "move", cursor: 3 });
    expect(paletteKey(model, keyIn("End"), false)).toEqual({ type: "move", cursor: 3 });
    expect(paletteKey(model, keyIn("Escape"), false)).toEqual({ type: "close" });
    expect(paletteKey(model, keyIn("x"), false)).toBe(NO_INTENT);
  });

  it("opens with Enter, in a new tab with the modifier, and drills into a tag", () => {
    expect(paletteKey(model, keyIn("Enter"), false)).toEqual({ type: "open", id: "note:projects/launch-checklist", newTab: false });
    expect(paletteKey(model, keyIn("Enter", { mod: true }), false)).toEqual({ type: "open", id: "note:projects/launch-checklist", newTab: true });
    expect(paletteKey(launchModel({ cursor: 3 }), keyIn("Enter"), false)).toEqual({ type: "tag", query: "#launch" });
    expect(paletteKey(launchModel({ query: "zz", answered: "", hits: [] }), keyIn("Enter"), false)).toBe(NO_INTENT);
    expect(rowIntent({ id: "module:x", kind: "node" }, true)).toEqual({ type: "open", id: "module:x", newTab: true });
    expect(rowIntent({ id: "tag:a b", kind: "tag" }, false)).toEqual({ type: "tag", query: "#a b" });
  });

  it("lights up with Shift+Enter only when the shell offers it and there is something to light", () => {
    expect(paletteKey(model, keyIn("Enter", { shift: true }), true)).toEqual({ type: "lightUp", query: "launch", ids: model.lightUp });
    expect(paletteKey(model, keyIn("Enter", { shift: true }), false)).toEqual({ type: "open", id: "note:projects/launch-checklist", newTab: false });
    expect(lightUpIntent({ query: "", lightUp: ["note:a"] })).toBe(NO_INTENT);
    expect(lightUpIntent({ query: "launch", lightUp: [] })).toBe(NO_INTENT);
    expect(lightUpIntent({ query: "launch", lightUp: ["note:a"] })).toEqual({ type: "lightUp", query: "launch", ids: ["note:a"] });
  });

  it("updates state for intents that keep the palette open", () => {
    const state = { ...initialSearchState(), query: "launch", cursor: 2, scope: "code" as const };
    expect(nextState(state, { type: "move", cursor: 1 })).toEqual({ ...state, cursor: 1 });
    expect(nextState(state, { type: "move", cursor: 2 })).toBe(state);
    expect(nextState(state, { type: "scope", scope: "tags" })).toEqual({ ...state, scope: "tags", cursor: 0 });
    expect(nextState(state, { type: "tag", query: "#launch" })).toEqual({ ...state, query: "#launch", scope: "notes", cursor: 0 });
    for (const intent of [NO_INTENT, { type: "close" } as const, { type: "open", id: "x", newTab: false } as const]) {
      expect(nextState(state, intent)).toBe(state);
    }
  });

  it("knows which intents close the palette", () => {
    expect(closesPalette({ type: "open", id: "x", newTab: false })).toBe(true);
    expect(closesPalette({ type: "lightUp", query: "x", ids: [] })).toBe(true);
    expect(closesPalette({ type: "close" })).toBe(true);
    expect(closesPalette({ type: "move", cursor: 0 })).toBe(false);
    expect(closesPalette({ type: "scope", scope: "all" })).toBe(false);
    expect(closesPalette({ type: "tag", query: "#x" })).toBe(false);
    expect(closesPalette(NO_INTENT)).toBe(false);
  });
});
