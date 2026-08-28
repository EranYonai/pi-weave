/**
 * The ⌘K palette (weave-workspace §1.1, §1.3, §10, P4).
 *
 * Three things are asserted here, and the middle one is the reason this file
 * is long.
 *
 * **Ranking and merging** — the palette spans both faces of the product, so
 * a note hit and a graph node have to be comparable, deduped and totally
 * ordered. The invariant worth stating: no amount of body evidence can lift a
 * weak label match above a strong one, because the score tiers are further
 * apart than the evidence band.
 *
 * **Asynchrony** — the debounce, the re-arm chain, and the stale-response
 * guard. These are the bugs that do not reproduce: two requests in flight,
 * the older one lands second, and the user watches results for a query they
 * finished typing 300 ms ago. `reduceSearch` is a pure function over an
 * injected clock and `createSearch` takes a scheduler, so the whole thing is
 * driven here in microseconds with no timers and no DOM (§10).
 *
 * **The keyboard lifecycle** — P4's exit criterion is "drivable without a
 * mouse", and for the palette that means open → type → move → Enter →
 * selected, with every step reachable from a key.
 */

import { describe, expect, it } from "vitest";
import type { FetchLike, HttpResponse } from "../../src/web/client/api";
import { createSearch } from "../../src/web/client/search/search";
import type { SearchState } from "../../src/web/client/search/search.model";
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
  isFresh,
  labelScore,
  mergeResults,
  nodeBadge,
  nodeDetail,
  nodeScore,
  noteNodeId,
  noteScore,
  paletteModel,
  reduceSearch,
  resultCountLabel,
  resultIdAt,
  rowDomId,
  searchKey,
  searchStatus,
  wrapCursor,
} from "../../src/web/client/search/search.model";
import type { GraphPayload, NoteSearchHit, WireGraphNode, WireNodeKind } from "../../src/web/shared/wire";

// --- fixtures ---------------------------------------------------------------------

function node(id: string, kind: WireNodeKind, label: string, detail: Record<string, string> = {}): WireGraphNode {
  return { id, kind, label, provenance: null, detail };
}

function hit(slug: string, title: string, score: number, snippet = "…body…"): NoteSearchHit {
  return {
    summary: { slug, title, created: "2026-01-01T00:00:00Z", updated: "2026-01-02T00:00:00Z", tags: [], source: "human", bodyLength: 10 },
    score,
    snippet,
  };
}

function payload(nodes: WireGraphNode[]): GraphPayload {
  return {
    model: { generatedAt: "2026-03-04T09:08:07Z", staleness: null, nodes, edges: [] },
    tags: {},
    dangling: {},
    // Still `null` on the wire (§5.3, §7.3) — the client lays out itself.
    positions: null,
    stamp: "abc",
  };
}

// --- ranking ----------------------------------------------------------------------

describe("labelScore", () => {
  it("ranks exact over prefix over boundary over interior", () => {
    expect(labelScore("layout", "layout")).toBe(100);
    expect(labelScore("layout.model", "layout")).toBe(70);
    expect(labelScore("graph/layout", "layout")).toBe(50);
    expect(labelScore("relayouting", "layout")).toBe(30);
  });

  it("is case-insensitive and ignores surrounding whitespace in the query", () => {
    // The query comes from a text input; a trailing space is a typo, not a
    // filter that should suddenly match nothing.
    expect(labelScore("Graph Architecture", "  graph  ")).toBe(70);
    expect(labelScore("graph", "GRAPH")).toBe(100);
  });

  it("is zero for a miss and for an empty query", () => {
    expect(labelScore("layout", "sigma")).toBe(0);
    expect(labelScore("layout", "")).toBe(0);
    expect(labelScore("layout", "   ")).toBe(0);
  });

  it("treats a digit as part of a word, so `d3-force` prefix-matches `force`", () => {
    // `-` is a separator, so this is a boundary match, not an interior one.
    expect(labelScore("d3-force", "force")).toBe(50);
    // …whereas a digit immediately before is inside a word.
    expect(labelScore("utf8encode", "encode")).toBe(30);
  });
});

describe("evidenceScore", () => {
  it("occupies a band strictly below the weakest label tier", () => {
    // The load-bearing invariant: a note that merely mentions the query in
    // its body must never outrank the module actually named after it.
    expect(evidenceScore(MAX_EVIDENCE)).toBeLessThan(labelScore("relayouting", "layout"));
  });

  it("clamps a score outside searchNotes' documented range", () => {
    expect(evidenceScore(-5)).toBe(0);
    expect(evidenceScore(999)).toBe(MAX_EVIDENCE * 2);
  });
});

describe("noteScore and nodeScore", () => {
  it("adds body evidence to a note's title match", () => {
    expect(noteScore(hit("a", "Layout", 4), "layout")).toBe(100 + 8);
  });

  it("surfaces a note whose title says nothing, on evidence alone", () => {
    expect(noteScore(hit("a", "Unrelated", 5), "layout")).toBe(10);
  });

  it("ranks a graph node on its label alone — a node has no body", () => {
    expect(nodeScore(node("module:src/layout", "module", "src/layout"), "layout")).toBe(50);
  });
});

describe("nodeDetail", () => {
  it("prefers the first present key in declared order", () => {
    expect(NODE_DETAIL_KEYS[0]).toBe("path");
    expect(nodeDetail(node("m", "module", "m", { path: "src/web", slug: "ignored" }))).toBe("src/web");
    expect(nodeDetail(node("e", "external", "gh", { url: "https://x" }))).toBe("https://x");
    expect(nodeDetail(node("n", "note", "n", { slug: "alpha" }))).toBe("alpha");
  });

  it("is empty for a node carrying none of them, rather than inventing one", () => {
    // A `vault` or `gitState` row is honestly one line.
    expect(nodeDetail(node("vault", "vault", "Vault", { notes: "34" }))).toBe("");
    expect(nodeDetail(node("vault", "vault", "Vault", { path: "" }))).toBe("");
  });

  it("names the kind verbatim as the badge", () => {
    expect(nodeBadge("entryPoint")).toBe("entryPoint");
  });
});

describe("noteNodeId", () => {
  it("matches the id shape the graph builder emits", () => {
    // The same prefix `workspace.ts`'s `noteSlug` strips. If these disagree,
    // selecting a search hit fetches nothing.
    expect(noteNodeId("alpha")).toBe("note:alpha");
  });
});

// --- merging ------------------------------------------------------------------------

describe("mergeResults", () => {
  it("labels the two sources distinctly", () => {
    const rows = mergeResults([hit("alpha", "Alpha", 3)], "alpha", [node("module:src/alpha", "module", "src/alpha")], "alpha");
    expect(rows.map((r) => r.kind)).toEqual(["note", "node"]);
    expect(rows.map((r) => r.badge)).toEqual(["note", "module"]);
  });

  it("keeps the note and drops the graph node when both name one thing", () => {
    // Every note is also a graph node, so a title match matches twice. The
    // hit is strictly richer — it has a snippet and body evidence.
    const rows = mergeResults([hit("alpha", "Alpha", 3)], "alpha", [node("note:alpha", "note", "Alpha")], "alpha");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("note");
    expect(rows[0]?.detail).toBe("…body…");
  });

  it("drops graph nodes that do not match at all", () => {
    const nodes = [node("module:src/layout", "module", "src/layout"), node("module:src/sigma", "module", "src/sigma")];
    expect(mergeResults([], "", nodes, "layout").map((r) => r.id)).toEqual(["module:src/layout"]);
  });

  it("ranks a module named for the query above a note that merely mentions it", () => {
    const rows = mergeResults([hit("misc", "Miscellany", MAX_EVIDENCE)], "layout", [node("module:layout", "module", "layout")], "layout");
    expect(rows.map((r) => r.id)).toEqual(["module:layout", "note:misc"]);
  });

  it("scores the two sources against different queries", () => {
    // The whole reason the palette feels instant: graph labels rank against
    // what is typed *now*, note hits against the query their request carried.
    // Mid-flight, the modules are already right and the notes are one beat
    // behind — which is better than showing nothing for 140 ms.
    const rows = mergeResults([hit("old", "Old", 3)], "lay", [node("module:layout", "module", "layout")], "layout");
    expect(rows[0]?.id).toBe("module:layout");
    expect(rows[0]?.score).toBe(100);
  });

  it("orders notes ahead of nodes on an exact score tie", () => {
    const rows = mergeResults([hit("layout", "layout", 0)], "layout", [node("module:layout", "module", "layout")], "layout");
    expect(rows.map((r) => r.kind)).toEqual(["note", "node"]);
  });

  it("is totally ordered, so equal scores never reshuffle between renders", () => {
    const nodes = [node("module:b", "module", "same"), node("module:a", "module", "same")];
    expect(mergeResults([], "", nodes, "same").map((r) => r.id)).toEqual(["module:a", "module:b"]);
  });

  it("caps the list, keeping the strongest rather than the first found", () => {
    const nodes = Array.from({ length: MAX_RESULTS + 5 }, (_, i) => node(`module:m${i}`, "module", `x-thing-${i}`));
    // One exact match, added last, must survive the cap.
    nodes.push(node("module:exact", "module", "x"));
    const rows = mergeResults([], "", nodes, "x");
    expect(rows).toHaveLength(MAX_RESULTS);
    expect(rows[0]?.id).toBe("module:exact");
  });

  it("is empty for an empty query — every score is zero", () => {
    expect(mergeResults([], "", [node("m", "module", "anything")], "")).toEqual([]);
  });
});

describe("compareResults", () => {
  it("falls through score, kind, label, then id", () => {
    const base = { detail: "", badge: "module", score: 10 } as const;
    const a = { ...base, id: "a", kind: "node" as const, label: "same" };
    const b = { ...base, id: "b", kind: "node" as const, label: "same" };
    expect(compareResults(a, b)).toBeLessThan(0);
    expect(compareResults({ ...a, score: 5 }, b)).toBeGreaterThan(0);
    expect(compareResults({ ...a, kind: "note" }, b)).toBeLessThan(0);
    expect(compareResults(b, { ...a, kind: "note" })).toBeGreaterThan(0);
  });
});

// --- the debounce and the stale-response guard ------------------------------------------

describe("reduceSearch — typing", () => {
  it("arms one timer for a burst and issues after the last keystroke", () => {
    // The re-arm chain, stepped by hand. A keystroke at t=0 arms t=140; one
    // at t=100 arms nothing; the t=140 tick sees 40 ms elapsed and re-arms
    // for the remaining 100.
    let s = initialSearchState();
    let t = reduceSearch(s, { type: "query", query: "l", now: 0 });
    expect(t.schedule).toBe(DEBOUNCE_MS);
    s = t.state;

    t = reduceSearch(s, { type: "query", query: "la", now: 100 });
    expect(t.schedule).toBeNull();
    expect(t.request).toBeNull();
    s = t.state;

    t = reduceSearch(s, { type: "tick", now: 140 });
    expect(t.request).toBeNull();
    expect(t.schedule).toBe(100);
    s = t.state;

    t = reduceSearch(s, { type: "tick", now: 240 });
    expect(t.request).toEqual({ seq: 1, query: "la" });
    expect(t.state.loading).toBe(true);
  });

  it("clears immediately for an empty query rather than spending a round trip", () => {
    const primed = { ...initialSearchState(), hits: [hit("a", "A", 1)], answered: "a", issued: "a", pending: true };
    const t = reduceSearch(primed, { type: "query", query: "  ", now: 5 });
    expect(t.request).toBeNull();
    expect(t.schedule).toBeNull();
    expect(t.state.hits).toEqual([]);
    expect(t.state.answered).toBe("");
    // …and it disarms, so the armed tick lands on a no-op.
    expect(t.state.pending).toBe(false);
  });

  it("sends the cursor home on every edit", () => {
    // The row under the cursor was chosen from a different result list.
    const s = { ...initialSearchState(), cursor: 4 };
    expect(reduceSearch(s, { type: "query", query: "x", now: 0 }).state.cursor).toBe(0);
  });

  it("trims the query it issues", () => {
    let s = reduceSearch(initialSearchState(), { type: "query", query: "  lay  ", now: 0 }).state;
    const t = reduceSearch(s, { type: "tick", now: DEBOUNCE_MS });
    expect(t.request?.query).toBe("lay");
    s = t.state;
    expect(s.issued).toBe("lay");
  });

  it("ignores a tick with no timer armed", () => {
    const t = reduceSearch(initialSearchState(), { type: "tick", now: 9999 });
    expect(t.request).toBeNull();
    expect(t.schedule).toBeNull();
  });

  it("does not re-issue the query already in flight", () => {
    // A stray tick — the palette closed and reopened, say — must not cost a
    // duplicate request.
    const s = { ...initialSearchState(), query: "lay", issued: "lay", pending: true, typedAt: 0 };
    const t = reduceSearch(s, { type: "tick", now: 500 });
    expect(t.request).toBeNull();
    expect(t.state.pending).toBe(false);
  });

  it("does not issue for a box emptied before the timer fired", () => {
    const s = { ...initialSearchState(), query: "   ", pending: true, typedAt: 0 };
    const t = reduceSearch(s, { type: "tick", now: 500 });
    expect(t.request).toBeNull();
    expect(t.state.pending).toBe(false);
  });

  it("disarms on dismiss, so a timer in flight lands on nothing", () => {
    const s = { ...initialSearchState(), pending: true };
    const after = reduceSearch(s, { type: "dismiss" }).state;
    expect(after.pending).toBe(false);
    expect(reduceSearch(after, { type: "tick", now: 9999 }).request).toBeNull();
  });

  it("moves the cursor on a pointer hover without touching anything else", () => {
    const t = reduceSearch(initialSearchState(), { type: "cursor", cursor: 3 });
    expect(t.state.cursor).toBe(3);
    expect(t.request).toBeNull();
  });
});

describe("reduceSearch — responses", () => {
  /** Two requests in flight: seq 1 and seq 2, neither answered. */
  function twoInFlight(): SearchState {
    return { ...initialSearchState(), query: "layout", seq: 2, applied: 0, loading: true };
  }

  it("applies a fresh response", () => {
    const t = reduceSearch(twoInFlight(), { type: "response", seq: 2, query: "layout", hits: [hit("a", "A", 3)] });
    expect(t.state.hits).toHaveLength(1);
    expect(t.state.answered).toBe("layout");
    expect(t.state.loading).toBe(false);
    expect(t.state.applied).toBe(2);
  });

  it("rejects an older response that lands after a newer one — the stale guard", () => {
    // The bug this exists for: request 1 is slow, request 2 is fast, and
    // without `applied` the slow answer to a query the user typed past
    // overwrites the right one.
    const after2 = reduceSearch(twoInFlight(), { type: "response", seq: 2, query: "layout", hits: [hit("new", "New", 3)] }).state;
    const after1 = reduceSearch(after2, { type: "response", seq: 1, query: "lay", hits: [hit("old", "Old", 3)] }).state;
    expect(after1).toBe(after2);
    expect(after1.hits[0]?.summary.slug).toBe("new");
  });

  it("rejects a duplicate delivery of the response already applied", () => {
    const once = reduceSearch(twoInFlight(), { type: "response", seq: 2, query: "layout", hits: [] }).state;
    expect(reduceSearch(once, { type: "response", seq: 2, query: "layout", hits: [hit("x", "X", 1)] }).state).toBe(once);
    expect(isFresh(once, 2)).toBe(false);
    expect(isFresh(once, 3)).toBe(true);
  });

  it("stays loading when an older response arrives while a newer one is out", () => {
    const t = reduceSearch(twoInFlight(), { type: "response", seq: 1, query: "lay", hits: [] });
    expect(t.state.loading).toBe(true);
    expect(t.state.applied).toBe(1);
  });

  it("keeps the previous hits on failure, beside a notice", () => {
    // Stale results plus "search failed" beat a blank palette.
    const held = { ...twoInFlight(), hits: [hit("a", "A", 3)] };
    const t = reduceSearch(held, { type: "failed", seq: 2 });
    expect(t.state.hits).toHaveLength(1);
    expect(t.state.failed).toBe(true);
    expect(t.state.loading).toBe(false);
  });

  it("rejects a stale failure too", () => {
    const after2 = reduceSearch(twoInFlight(), { type: "response", seq: 2, query: "layout", hits: [] }).state;
    expect(reduceSearch(after2, { type: "failed", seq: 1 }).state).toBe(after2);
    expect(after2.failed).toBe(false);
  });

  it("clears a previous failure once a response succeeds", () => {
    const failed = reduceSearch(twoInFlight(), { type: "failed", seq: 1 }).state;
    const ok = reduceSearch(failed, { type: "response", seq: 2, query: "layout", hits: [] }).state;
    expect(ok.failed).toBe(false);
  });
});

// --- the controller -------------------------------------------------------------------

describe("createSearch", () => {
  /** A scheduler whose timers a test fires by hand. Returns the queue. */
  function scheduler(): { queue: Array<{ run: () => void; ms: number }>; delay: (run: () => void, ms: number) => void } {
    const queue: Array<{ run: () => void; ms: number }> = [];
    return { queue, delay: (run, ms) => void queue.push({ run, ms }) };
  }

  /**
   * Drain the microtask queue.
   *
   * A response travels through four awaits before it reaches the reducer —
   * `fetchImpl`, `response.json()`, `request`'s own return, and the
   * controller's `await fetchSearch` — so a fixed pair of `await
   * Promise.resolve()` calls is a test that passes for the wrong reason today
   * and fails the day `api.ts` grows a fifth. Ten is comfortably more than
   * the chain and costs nothing.
   */
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  function responder(hits: NoteSearchHit[], status = 200): { fetch: FetchLike; urls: string[]; settle: () => void } {
    const urls: string[] = [];
    const gates: Array<() => void> = [];
    const fetch: FetchLike = (url) => {
      urls.push(url);
      return new Promise<HttpResponse>((resolve) => {
        gates.push(() =>
          resolve({ ok: status < 300, status, json: () => Promise.resolve({ query: "", hits }) }),
        );
      });
    };
    return { fetch, urls, settle: () => gates.splice(0).forEach((g) => g()) };
  }

  it("issues one request for a burst of keystrokes", async () => {
    const clock = { t: 0 };
    const sched = scheduler();
    const http = responder([hit("a", "Alpha", 3)]);
    const seen: SearchState[] = [];
    const search = createSearch({ fetch: http.fetch, now: () => clock.t, delay: sched.delay, onChange: (s) => void seen.push(s) });

    search.setQuery("l");
    clock.t = 60;
    search.setQuery("la");
    clock.t = 120;
    search.setQuery("lay");
    expect(sched.queue).toHaveLength(1);

    // The armed tick fires 140 ms after the *first* keystroke, finds only
    // 20 ms since the last, and re-arms.
    clock.t = 140;
    sched.queue.shift()?.run();
    expect(http.urls).toEqual([]);
    expect(sched.queue).toHaveLength(1);

    clock.t = 260;
    sched.queue.shift()?.run();
    expect(http.urls).toEqual(["/api/search?q=lay"]);

    http.settle();
    await flush();
    expect(search.state().hits).toHaveLength(1);
    expect(search.state().answered).toBe("lay");
    expect(seen.at(-1)).toBe(search.state());
  });

  it("percent-encodes the query, so a `&` is not a second parameter", async () => {
    const clock = { t: 0 };
    const sched = scheduler();
    const http = responder([]);
    const search = createSearch({ fetch: http.fetch, now: () => clock.t, delay: sched.delay, onChange: () => {} });
    search.setQuery("a&b=c");
    clock.t = DEBOUNCE_MS;
    sched.queue.shift()?.run();
    expect(http.urls).toEqual(["/api/search?q=a%26b%3Dc"]);
    http.settle();
    await flush();
  });

  it("records a failure without clearing what is on screen", async () => {
    const clock = { t: 0 };
    const sched = scheduler();
    const http = responder([], 503);
    const search = createSearch({ fetch: http.fetch, now: () => clock.t, delay: sched.delay, onChange: () => {} });
    search.setQuery("lay");
    clock.t = DEBOUNCE_MS;
    sched.queue.shift()?.run();
    http.settle();
    await flush();
    expect(search.state().failed).toBe(true);
    expect(search.state().loading).toBe(false);
  });

  it("lets a slow first response lose to a fast second one", async () => {
    // The end-to-end form of the stale guard, through the real controller.
    const clock = { t: 0 };
    const sched = scheduler();
    const gates: Array<(hits: NoteSearchHit[]) => void> = [];
    const fetch: FetchLike = () =>
      new Promise<HttpResponse>((resolve) => {
        gates.push((hits) => resolve({ ok: true, status: 200, json: () => Promise.resolve({ query: "", hits }) }));
      });
    const search = createSearch({ fetch, now: () => clock.t, delay: sched.delay, onChange: () => {} });

    search.setQuery("lay");
    clock.t = DEBOUNCE_MS;
    sched.queue.shift()?.run();

    clock.t = 200;
    search.setQuery("layout");
    clock.t = 200 + DEBOUNCE_MS;
    sched.queue.shift()?.run();
    expect(gates).toHaveLength(2);

    // Resolve the *second* first, then the first.
    gates[1]?.([hit("new", "New", 3)]);
    await flush();
    gates[0]?.([hit("old", "Old", 3)]);
    await flush();

    expect(search.state().hits.map((h) => h.summary.slug)).toEqual(["new"]);
  });

  it("dismiss disarms, so a fired timer issues nothing", () => {
    const clock = { t: 0 };
    const sched = scheduler();
    const http = responder([]);
    const search = createSearch({ fetch: http.fetch, now: () => clock.t, delay: sched.delay, onChange: () => {} });
    search.setQuery("lay");
    search.dismiss();
    clock.t = DEBOUNCE_MS;
    sched.queue.shift()?.run();
    expect(http.urls).toEqual([]);
  });

  it("moves the cursor", () => {
    const sched = scheduler();
    const http = responder([]);
    const search = createSearch({ fetch: http.fetch, now: () => 0, delay: sched.delay, onChange: () => {} });
    search.setCursor(2);
    expect(search.state().cursor).toBe(2);
  });
});

// --- the keyboard lifecycle -------------------------------------------------------------

describe("clampCursor and wrapCursor", () => {
  it("clamps into range and collapses an empty list to zero", () => {
    expect(clampCursor(9, 3)).toBe(2);
    expect(clampCursor(-4, 3)).toBe(0);
    expect(clampCursor(2, 0)).toBe(0);
  });

  it("wraps at both ends — a ranked list is not spatial, unlike the tree", () => {
    expect(wrapCursor(2, 1, 3)).toBe(0);
    expect(wrapCursor(0, -1, 3)).toBe(2);
    expect(wrapCursor(0, -1, 0)).toBe(0);
  });
});

describe("searchKey", () => {
  const state = { ...initialSearchState(), cursor: 1 };

  it("moves, wraps, and jumps to the ends", () => {
    expect(searchKey(state, "ArrowDown", 3).state.cursor).toBe(2);
    expect(searchKey(state, "ArrowUp", 3).state.cursor).toBe(0);
    expect(searchKey({ ...state, cursor: 2 }, "ArrowDown", 3).state.cursor).toBe(0);
    expect(searchKey(state, "Home", 3).state.cursor).toBe(0);
    expect(searchKey(state, "End", 3).state.cursor).toBe(2);
  });

  it("re-clamps a cursor left over from a longer list before moving", () => {
    // The list is rebuilt from a query and a payload that both change under
    // the cursor, so an index that was valid when set may not be now.
    expect(searchKey({ ...state, cursor: 40 }, "ArrowDown", 3).state.cursor).toBe(0);
  });

  it("activates the row under the cursor and dismisses", () => {
    const result = searchKey(state, "Enter", 3);
    expect(result).toMatchObject({ activate: 1, dismiss: true, handled: true });
  });

  it("does not swallow Enter when there is nothing to open", () => {
    expect(searchKey(state, "Enter", 0)).toMatchObject({ activate: null, handled: false });
  });

  it("dismisses on Escape without activating", () => {
    expect(searchKey(state, "Escape", 3)).toMatchObject({ activate: null, dismiss: true, handled: true });
  });

  it("returns handled:false for everything else — the treeKey contract", () => {
    // The palette contains a text input. Swallowing an unclaimed key would
    // break typing, Tab, ⌘R and text selection in one go.
    for (const key of ["Tab", "a", " ", "ArrowLeft", "PageDown", "F5"]) {
      expect(searchKey(state, key, 3).handled, key).toBe(false);
    }
  });
});

describe("resultIdAt", () => {
  it("is null for no index and for an out-of-range one", () => {
    const rows = mergeResults([], "", [node("module:a", "module", "a")], "a");
    expect(resultIdAt(rows, null)).toBeNull();
    expect(resultIdAt(rows, 9)).toBeNull();
    expect(resultIdAt(rows, 0)).toBe("module:a");
  });
});

// --- the resolved palette ----------------------------------------------------------------

describe("paletteModel", () => {
  const nodes = [node("module:layout", "module", "layout"), node("module:src/layout", "module", "src/layout")];

  it("marks exactly one row active and points aria-activedescendant at it", () => {
    const state = { ...initialSearchState(), query: "layout", cursor: 1 };
    const model = paletteModel(state, payload(nodes));
    expect(model.rows.filter((r) => r.active)).toHaveLength(1);
    expect(model.activeDomId).toBe(rowDomId(1));
    expect(model.rows[1]?.domId).toBe(model.activeDomId);
  });

  it("clamps a cursor past the end of a shrunken list", () => {
    const model = paletteModel({ ...initialSearchState(), query: "layout", cursor: 12 }, payload(nodes));
    expect(model.cursor).toBe(1);
    expect(model.activeDomId).toBe(rowDomId(1));
  });

  it("has no active descendant when there is nothing to point at", () => {
    const model = paletteModel({ ...initialSearchState(), query: "zzz" }, payload(nodes));
    expect(model.activeDomId).toBeNull();
    expect(model.count).toBe(0);
  });

  it("works before the first graph arrives", () => {
    // The half-second between mount and `/api/graph`, which happens on every
    // single load.
    expect(paletteModel({ ...initialSearchState(), query: "x" }, null).rows).toEqual([]);
  });

  it("gives every row a selector-safe dom id, unlike the graph ids themselves", () => {
    // `module:src/web/client` is a legal HTML id and an illegal CSS selector.
    const model = paletteModel({ ...initialSearchState(), query: "layout" }, payload(nodes));
    for (const row of model.rows) expect(row.domId).toMatch(/^[a-z0-9-]+$/);
  });
});

describe("searchStatus", () => {
  const base = initialSearchState();

  it("invites a query when the box is empty", () => {
    expect(searchStatus(base, 0)).toContain("Type to search");
    expect(searchStatus({ ...base, query: "   " }, 0)).toContain("Type to search");
  });

  it("is null when there are rows to render", () => {
    expect(searchStatus({ ...base, query: "a" }, 3)).toBeNull();
  });

  it("distinguishes searching, empty and failed", () => {
    // Conflating these is how a search box tells a user their vault is empty
    // because the server restarted.
    expect(searchStatus({ ...base, query: "a", pending: true }, 0)).toBe("searching…");
    expect(searchStatus({ ...base, query: "a", loading: true }, 0)).toBe("searching…");
    expect(searchStatus({ ...base, query: "a", failed: true }, 0)).toContain("failed");
    expect(searchStatus({ ...base, query: " zz " }, 0)).toContain("zz");
  });

  it("prefers the failure notice over the searching one", () => {
    // A retry in flight after a failure still owes the user the failure.
    expect(searchStatus({ ...base, query: "a", failed: true, loading: true }, 0)).toContain("failed");
  });
});

describe("palette copy", () => {
  it("pluralises the count", () => {
    expect(resultCountLabel(1)).toBe("1 result");
    expect(resultCountLabel(0)).toBe("0 results");
    expect(resultCountLabel(8)).toBe("8 results");
  });

  it("teaches the keys it responds to", () => {
    for (const key of ["↑↓", "↵", "esc"]) expect(PALETTE_HINT).toContain(key);
  });

  it("names both halves of the workspace in the placeholder", () => {
    // §1.1: the vault and the repository are lenses onto one knowledge base,
    // and the palette is the one surface that spans both at once.
    expect(PALETTE_PLACEHOLDER.toLowerCase()).toContain("notes");
    expect(PALETTE_PLACEHOLDER.toLowerCase()).toContain("repository");
    expect(PALETTE_TITLE).not.toBe("");
  });
});
