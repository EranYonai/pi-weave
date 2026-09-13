import { describe, expect, it } from "vitest";
import { fetchSearch } from "../../src/web/client/api";
import type { FetchLike } from "../../src/web/client/api";
import type { GraphPayload, NoteSearchHit, WireGraphNode, WireNodeKind } from "../../src/web/shared/wire";
import {
  DEBOUNCE_MS,
  MAX_EVIDENCE,
  MAX_RESULTS,
  NODE_DETAIL_KEYS,
  PALETTE_HINT,
  PALETTE_PLACEHOLDER,
  PALETTE_TITLE,
  clampCursor,
  compareResults,
  evidenceScore,
  initialSearchState,
  labelScore,
  mergeResults,
  nodeBadge,
  nodeDetail,
  nodeScore,
  noteNodeId,
  noteScore,
  paletteModel,
  resultCountLabel,
  resultIdAt,
  rowDomId,
  searchKey,
  searchStatus,
  wrapCursor,
} from "../../src/web/client/search/search.model";

function node(id: string, kind: WireNodeKind, label: string, detail: Record<string, string> = {}): WireGraphNode {
  return { id, kind, label, provenance: null, detail };
}

function hit(slug: string, title: string, score: number, snippet = "…body…"): NoteSearchHit {
  return { summary: { slug, title, created: "2026-01-01T00:00:00Z", updated: "2026-01-02T00:00:00Z", tags: [], source: "human", bodyLength: 10 }, score, snippet };
}

function payload(nodes: WireGraphNode[]): GraphPayload {
  return { model: { generatedAt: "2026-03-04T09:08:07Z", staleness: null, nodes, edges: [], contentDigest: "" }, tags: {}, dangling: {}, positions: null, stamp: "abc" };
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

  it("resolves node details and badges", () => {
    expect(NODE_DETAIL_KEYS).toEqual(["path", "manifest", "url", "slug"]);
    expect(nodeDetail(node("m", "module", "m", { path: "src", slug: "ignored" }))).toBe("src");
    expect(nodeDetail(node("e", "external", "gh", { url: "https://x" }))).toBe("https://x");
    expect(nodeDetail(node("n", "note", "n", { slug: "alpha" }))).toBe("alpha");
    expect(nodeDetail(node("v", "vault", "Vault", { notes: "2" }))).toBe("");
    expect(nodeBadge("entryPoint")).toBe("entryPoint");
    expect(noteNodeId("alpha")).toBe("note:alpha");
  });

  it("merges, dedupes, orders and caps notes and graph nodes", () => {
    const rows = mergeResults([hit("alpha", "Alpha", 3)], "alpha", [node("module:src/alpha", "module", "src/alpha")], "alpha");
    expect(rows.map((row) => row.kind)).toEqual(["note", "node"]);
    expect(mergeResults([hit("alpha", "Alpha", 3)], "alpha", [node("note:alpha", "note", "Alpha")], "alpha")).toHaveLength(1);
    const a = { id: "a", kind: "node" as const, label: "same", detail: "", badge: "module", score: 10 };
    expect(compareResults(a, { ...a, id: "b" })).toBeLessThan(0);
    expect(compareResults({ ...a, score: 5 }, a)).toBeGreaterThan(0);
    expect(compareResults({ ...a, kind: "note" }, a)).toBeLessThan(0);
    const many = Array.from({ length: MAX_RESULTS + 1 }, (_, i) => node(`n${i}`, "module", `thing-${i}`));
    expect(mergeResults([], "thing", many, "thing")).toHaveLength(MAX_RESULTS);
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

  it("initializes, clamps, wraps and resolves ids", () => {
    const state = initialSearchState();
    expect(state).toEqual({ query: "", answered: "", hits: [], cursor: 0, loading: false, failed: false });
    expect(clampCursor(9, 3)).toBe(2);
    expect(clampCursor(-1, 3)).toBe(0);
    expect(clampCursor(2, 0)).toBe(0);
    expect(wrapCursor(2, 1, 3)).toBe(0);
    expect(wrapCursor(0, -1, 3)).toBe(2);
    expect(wrapCursor(0, -1, 0)).toBe(0);
    const rows = mergeResults([], "", [node("m", "module", "mod")], "mod");
    expect(resultIdAt(rows, 0)).toBe("m");
    expect(resultIdAt(rows, null)).toBeNull();
    expect(resultIdAt(rows, 9)).toBeNull();
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

  it("renders statuses and resolved rows", () => {
    const state = initialSearchState();
    expect(searchStatus(state, 0)).toContain("Type to search");
    expect(searchStatus({ ...state, query: "a" }, 3)).toBeNull();
    expect(searchStatus({ ...state, query: "a", loading: true }, 0)).toBe("searching…");
    expect(searchStatus({ ...state, query: "a", failed: true }, 0)).toContain("failed");
    expect(searchStatus({ ...state, query: " zz " }, 0)).toContain("zz");
    expect(resultCountLabel(1)).toBe("1 result");
    expect(resultCountLabel(0)).toBe("0 results");
    expect(rowDomId(2)).toBe("weave-search-row-2");
    const model = paletteModel({ ...state, query: "layout", cursor: 9 }, payload([node("m", "module", "layout")]));
    expect(model.rows[0]?.active).toBe(true);
    expect(model.activeDomId).toBe(rowDomId(0));
    expect(paletteModel({ ...state, query: "x" }, null).rows).toEqual([]);
    expect(PALETTE_TITLE).not.toBe("");
    expect(PALETTE_PLACEHOLDER.toLowerCase()).toContain("notes");
    expect(PALETTE_HINT).toContain("esc");
    expect(DEBOUNCE_MS).toBe(140);
  });
});
