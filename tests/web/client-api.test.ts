/**
 * The client's HTTP layer (weave-workspace §5.3).
 *
 * `fetch` is injected, so every case the network can produce is reachable
 * from Node with no DOM and no jsdom: 200, the 304 revalidation path, the
 * 403 the four security layers produce, 404, a body that is not JSON, a body
 * that is JSON but not ours, and `fetch` rejecting outright. §10 puts
 * "client logic" in `.model.ts`/`.ts` files precisely so this is testable
 * without a browser.
 *
 * The 304 case gets the most attention because it is the one with a
 * *contract* rather than just a status: the server ETags `/api/graph` on a
 * stamp derived from input timestamps, so a 304 means "your copy is still
 * correct" and the wrapper must hand that copy back rather than a null the
 * caller might render.
 */

import { describe, expect, it } from "vitest";
import {
  classifyStatus,
  deleteNote,
  fetchGraph,
  fetchNote,
  fetchOkfFile,
  fetchSearch,
  isConflictPayload,
  isGraphPayload,
  isNotePayload,
  isOkfFile,
  isOpenResult,
  isSearchPayload,
  isViewNote,
  messageForStatus,
  openNote,
  renameNote,
  saveNote,
} from "../../src/web/client/api";
import type { FetchLike, HttpRequest, HttpResponse } from "../../src/web/client/api";
import type { ConflictPayload, GraphPayload, NotePayload, ViewNote } from "../../src/web/shared/wire";

// --- fakes ---------------------------------------------------------------------

interface Call {
  readonly url: string;
  readonly init: HttpRequest | undefined;
}

/** A `fetch` that answers with one canned response and records its calls. */
function fakeFetch(response: Partial<HttpResponse>): FetchLike & { readonly calls: Call[] } {
  const calls: Call[] = [];
  const impl = (url: string, init?: HttpRequest): Promise<HttpResponse> => {
    calls.push({ url, init });
    return Promise.resolve({
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: response.json ?? (() => Promise.resolve({})),
    });
  };
  return Object.assign(impl, { calls });
}

/** A `fetch` that answers 200 with `body`. */
function respondsWith(body: unknown): FetchLike & { readonly calls: Call[] } {
  return fakeFetch({ ok: true, status: 200, json: () => Promise.resolve(body) });
}

/** A `fetch` that fails with a status. */
function respondsStatus(status: number): FetchLike {
  return fakeFetch({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve({ error: "no" }) });
}

/** A `fetch` that rejects, as it does when the server is gone. */
function rejects(message = "Failed to fetch"): FetchLike {
  return () => Promise.reject(new Error(message));
}

const GRAPH: GraphPayload = {
  model: { nodes: [], edges: [], generatedAt: "2026-01-01T00:00:00Z" } as unknown as GraphPayload["model"],
  tags: {},
  dangling: {},
  positions: null,
  stamp: "2026-01-01T00:00:00Z",
};

const NOTE: ViewNote = {
  slug: "alpha",
  title: "Alpha",
  body: "# Alpha",
  created: "2026-01-01T00:00:00Z",
  updated: "2026-01-02T00:00:00Z",
  tags: ["architecture"],
  source: "human",
};

/** What `GET /api/note/:slug` serves as of P5: the note plus its revision. */
const PAYLOAD: NotePayload = { note: NOTE, revision: "111:22" };

// --- status classification ----------------------------------------------------

describe("classifyStatus", () => {
  it.each([
    [403, "auth"],
    [404, "missing"],
    [500, "server"],
    [503, "server"],
    [400, "server"],
  ])("maps %i to %s", (status, kind) => {
    expect(classifyStatus(status)).toBe(kind);
  });
});

describe("messageForStatus", () => {
  it("says the session has ended for a 403 — reconnecting will not help", () => {
    expect(messageForStatus(403)).toContain("session has ended");
  });

  it("is terse for a 404", () => {
    expect(messageForStatus(404)).toBe("not found");
  });

  it("carries the status for anything else", () => {
    expect(messageForStatus(500)).toContain("500");
  });

  it("never echoes a response body", () => {
    // The 403 body is deliberately uninformative (see `sendForbidden`), and
    // this layer must not undo that by rendering server text.
    for (const status of [403, 404, 500]) expect(messageForStatus(status)).not.toContain("forbidden");
  });
});

// --- guards ---------------------------------------------------------------------

describe("isGraphPayload", () => {
  it("accepts a well-formed payload", () => {
    expect(isGraphPayload(GRAPH)).toBe(true);
  });

  it.each([
    ["null", null],
    ["a string", "graph"],
    ["an array", []],
    ["a missing stamp", { model: { nodes: [], edges: [] }, tags: {}, dangling: {} }],
    ["a non-string stamp", { model: { nodes: [], edges: [] }, tags: {}, dangling: {}, stamp: 1 }],
    ["a missing model", { tags: {}, dangling: {}, stamp: "s" }],
    ["a non-object model", { model: "x", tags: {}, dangling: {}, stamp: "s" }],
    ["non-array nodes", { model: { nodes: {}, edges: [] }, tags: {}, dangling: {}, stamp: "s" }],
    ["non-array edges", { model: { nodes: [], edges: 3 }, tags: {}, dangling: {}, stamp: "s" }],
    ["a non-object tags index", { model: { nodes: [], edges: [] }, tags: [], dangling: {}, stamp: "s" }],
    ["a missing dangling index", { model: { nodes: [], edges: [] }, tags: {}, stamp: "s" }],
  ])("rejects %s", (_label, value) => {
    expect(isGraphPayload(value)).toBe(false);
  });

  it("does not walk individual nodes — a bad node degrades one row, not the app", () => {
    const loose = { ...GRAPH, model: { nodes: [{ nonsense: true }], edges: [] } };
    expect(isGraphPayload(loose)).toBe(true);
  });
});

describe("isViewNote", () => {
  it("accepts a well-formed note", () => {
    expect(isViewNote(NOTE)).toBe(true);
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a missing slug", { ...NOTE, slug: undefined }],
    ["a non-string title", { ...NOTE, title: 7 }],
    ["a missing body", { ...NOTE, body: undefined }],
    ["a non-string created", { ...NOTE, created: null }],
    ["a non-string updated", { ...NOTE, updated: {} }],
    ["a non-string source", { ...NOTE, source: 1 }],
    ["non-array tags", { ...NOTE, tags: "architecture" }],
    ["tags containing a non-string", { ...NOTE, tags: ["a", 2] }],
  ])("rejects %s", (_label, value) => {
    expect(isViewNote(value)).toBe(false);
  });
});

describe("isOkfFile / isSearchPayload / isOpenResult", () => {
  it("accepts well-formed payloads", () => {
    expect(isOkfFile({ path: "index/notes.md", body: "x" })).toBe(true);
    expect(isSearchPayload({ query: "a", hits: [] })).toBe(true);
    expect(isOpenResult({ opened: true })).toBe(true);
  });

  it.each([
    ["okf without a body", isOkfFile, { path: "a" }],
    ["okf with a numeric path", isOkfFile, { path: 1, body: "x" }],
    ["okf null", isOkfFile, null],
    ["search without hits", isSearchPayload, { query: "a" }],
    ["search with object hits", isSearchPayload, { query: "a", hits: {} }],
    ["search with a numeric query", isSearchPayload, { query: 1, hits: [] }],
    ["open with a string flag", isOpenResult, { opened: "yes" }],
    ["open empty", isOpenResult, {}],
  ])("rejects %s", (_label, guard, value) => {
    expect((guard as (v: unknown) => boolean)(value)).toBe(false);
  });
});

// --- fetchGraph -------------------------------------------------------------------

describe("fetchGraph", () => {
  it("returns the payload on 200", async () => {
    const result = await fetchGraph(respondsWith(GRAPH));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.stamp).toBe(GRAPH.stamp);
      expect(result.cached).toBe(false);
    }
  });

  it("sends no If-None-Match on the first load", async () => {
    const impl = respondsWith(GRAPH);
    await fetchGraph(impl, null);
    expect(impl.calls[0]?.init?.headers).toBeUndefined();
  });

  it("sends the held stamp as a quoted If-None-Match", async () => {
    const impl = respondsWith(GRAPH);
    await fetchGraph(impl, GRAPH);
    expect(impl.calls[0]?.init?.headers?.["if-none-match"]).toBe(`"${GRAPH.stamp}"`);
  });

  it("returns the caller's own payload on 304, flagged as cached", async () => {
    // The contract that stops a revalidation from blanking the graph column.
    const impl = fakeFetch({ ok: false, status: 304, json: () => Promise.reject(new Error("no body")) });
    const result = await fetchGraph(impl, GRAPH);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBe(GRAPH);
      expect(result.cached).toBe(true);
    }
  });

  it("never reads the body of a 304 — there isn't one", async () => {
    let read = false;
    const impl: FetchLike = () =>
      Promise.resolve({
        ok: false,
        status: 304,
        json: () => {
          read = true;
          return Promise.resolve({});
        },
      });
    await fetchGraph(impl, GRAPH);
    expect(read).toBe(false);
  });

  it("treats a 304 with nothing held as malformed, not as a cache hit", async () => {
    // We cannot have sent a conditional request, so the server answering one
    // is a bug — better loud than a null typed as a payload.
    const result = await fetchGraph(fakeFetch({ ok: false, status: 304 }), null);
    expect(result).toMatchObject({ ok: false, kind: "malformed", status: 304 });
  });

  it("reports a 403 as an auth failure", async () => {
    const result = await fetchGraph(respondsStatus(403));
    expect(result).toMatchObject({ ok: false, kind: "auth", status: 403 });
  });

  it("reports a 500 as a server failure", async () => {
    expect(await fetchGraph(respondsStatus(500))).toMatchObject({ ok: false, kind: "server", status: 500 });
  });

  it("reports a rejected fetch as a network failure with status 0", async () => {
    const result = await fetchGraph(rejects("connection refused"));
    expect(result).toMatchObject({ ok: false, kind: "network", status: 0 });
    if (!result.ok) expect(result.message).toContain("connection refused");
  });

  it("survives a rejection that is not an Error", async () => {
    const result = await fetchGraph(() => Promise.reject("just a string"));
    expect(result).toMatchObject({ ok: false, kind: "network" });
  });

  it("reports an unparseable body as malformed", async () => {
    const impl = fakeFetch({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError("Unexpected token <")) });
    expect(await fetchGraph(impl)).toMatchObject({ ok: false, kind: "malformed", status: 200 });
  });

  it("reports a well-formed JSON body of the wrong shape as malformed", async () => {
    // The realistic version: a proxy or a stale server answering something
    // that parses but is not ours.
    expect(await fetchGraph(respondsWith({ hello: "world" }))).toMatchObject({ ok: false, kind: "malformed" });
  });
});

// --- fetchNote ---------------------------------------------------------------------

describe("fetchNote", () => {
  it("returns the note and its revision on 200", async () => {
    const result = await fetchNote(respondsWith(PAYLOAD), "alpha");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.note.title).toBe("Alpha");
      expect(result.data.revision).toBe("111:22");
    }
  });

  it("requests the encoded slug", async () => {
    const impl = respondsWith(PAYLOAD);
    await fetchNote(impl, "notes/with space");
    expect(impl.calls[0]?.url).toBe("/api/note/notes%2Fwith%20space");
  });

  it("encodes a traversal attempt rather than checking it here", async () => {
    // Deliberate: `resolveNotePath` on the server is the single guard. A
    // second implementation here is how the two drift apart.
    const impl = respondsWith(PAYLOAD);
    await fetchNote(impl, "../../etc/passwd");
    expect(impl.calls[0]?.url).toBe("/api/note/..%2F..%2Fetc%2Fpasswd");
  });

  it("reports a deleted note as missing, which is normal during a live edit", async () => {
    expect(await fetchNote(respondsStatus(404), "gone")).toMatchObject({ ok: false, kind: "missing", status: 404 });
  });

  it("reports a 403 as auth", async () => {
    expect(await fetchNote(respondsStatus(403), "alpha")).toMatchObject({ ok: false, kind: "auth" });
  });

  it("reports a network rejection", async () => {
    expect(await fetchNote(rejects(), "alpha")).toMatchObject({ ok: false, kind: "network", status: 0 });
  });

  it("reports a note missing its tags as malformed", async () => {
    const bad = { note: { ...NOTE, tags: null }, revision: "1:1" };
    expect(await fetchNote(respondsWith(bad), "alpha")).toMatchObject({ ok: false, kind: "malformed" });
  });

  it("reports a bare ViewNote — the pre-P5 shape — as malformed", async () => {
    // The route used to serve this. A stale server build answering an old
    // shape must be a visible failure, not an editor that saves with
    // `revision: undefined` and silently becomes last-write-wins.
    expect(await fetchNote(respondsWith(NOTE), "alpha")).toMatchObject({ ok: false, kind: "malformed" });
  });

  it("reports a payload with no revision as malformed", async () => {
    expect(await fetchNote(respondsWith({ note: NOTE }), "alpha")).toMatchObject({ ok: false, kind: "malformed" });
  });

  it("reports an unparseable body as malformed", async () => {
    const impl = fakeFetch({ ok: true, status: 200, json: () => Promise.reject(new Error("boom")) });
    expect(await fetchNote(impl, "alpha")).toMatchObject({ ok: false, kind: "malformed" });
  });

  it("survives a non-Error rejection", async () => {
    expect(await fetchNote(() => Promise.reject(42), "alpha")).toMatchObject({ ok: false, kind: "network" });
  });
});

// --- fetchOkfFile ------------------------------------------------------------------

describe("fetchOkfFile", () => {
  it("returns the file on 200", async () => {
    const result = await fetchOkfFile(respondsWith({ path: "index/notes.md", body: "# x" }), "index/notes.md");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.body).toBe("# x");
  });

  it("preserves path separators while encoding each segment", async () => {
    // `encodeURIComponent` on the whole string would turn the separators into
    // %2F and guarantee a 404.
    const impl = respondsWith({ path: "a/b c.md", body: "" });
    await fetchOkfFile(impl, "a/b c.md");
    expect(impl.calls[0]?.url).toBe("/api/okf/a/b%20c.md");
  });

  it("reports a missing file", async () => {
    expect(await fetchOkfFile(respondsStatus(404), "nope.md")).toMatchObject({ ok: false, kind: "missing" });
  });

  it("reports a malformed payload", async () => {
    expect(await fetchOkfFile(respondsWith({ path: "a" }), "a")).toMatchObject({ ok: false, kind: "malformed" });
  });
});

// --- fetchSearch -------------------------------------------------------------------

describe("fetchSearch", () => {
  it("returns hits on 200", async () => {
    const result = await fetchSearch(respondsWith({ query: "graph", hits: [] }), "graph");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.query).toBe("graph");
  });

  it("encodes the query string", async () => {
    const impl = respondsWith({ query: "a&b", hits: [] });
    await fetchSearch(impl, "a&b c");
    expect(impl.calls[0]?.url).toBe("/api/search?q=a%26b%20c");
  });

  it("sends an empty query rather than skipping the request", async () => {
    // The search box sends one on every keystroke, including the clearing
    // one, and the server answers `[]` — so there is no special case here.
    const impl = respondsWith({ query: "", hits: [] });
    await fetchSearch(impl, "");
    expect(impl.calls[0]?.url).toBe("/api/search?q=");
  });

  it("reports a malformed payload", async () => {
    expect(await fetchSearch(respondsWith({ query: "a" }), "a")).toMatchObject({ ok: false, kind: "malformed" });
  });

  it("reports a network failure", async () => {
    expect(await fetchSearch(rejects(), "a")).toMatchObject({ ok: false, kind: "network" });
  });
});

// --- openNote ----------------------------------------------------------------------

describe("openNote", () => {
  it("POSTs a JSON body with the slug", async () => {
    const impl = respondsWith({ opened: true });
    await openNote(impl, "alpha");
    const call = impl.calls[0];
    expect(call?.url).toBe("/api/open");
    expect(call?.init?.method).toBe("POST");
    expect(call?.init?.headers?.["content-type"]).toBe("application/json");
    expect(JSON.parse(call?.init?.body ?? "{}")).toEqual({ slug: "alpha" });
  });

  it("returns opened:true on success", async () => {
    const result = await openNote(respondsWith({ opened: true }), "alpha");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.opened).toBe(true);
  });

  it("surfaces the 404 as missing rather than as a success carrying false", async () => {
    // The server answers 404 with {opened:false}; collapsing that into a
    // successful `false` would hide the failure from a network panel.
    expect(await openNote(respondsStatus(404), "gone")).toMatchObject({ ok: false, kind: "missing", status: 404 });
  });

  it("does not escape the slug into the URL — it travels in the body", async () => {
    const impl = respondsWith({ opened: true });
    await openNote(impl, "../../etc/passwd");
    expect(impl.calls[0]?.url).toBe("/api/open");
  });

  it("reports a malformed response", async () => {
    expect(await openNote(respondsWith({}), "alpha")).toMatchObject({ ok: false, kind: "malformed" });
  });

  it("reports a network failure", async () => {
    expect(await openNote(rejects(), "alpha")).toMatchObject({ ok: false, kind: "network" });
  });
});

// --- writes (P5) ---------------------------------------------------------------------

const CONFLICT: ConflictPayload = {
  error: "the note changed on disk since it was read",
  reason: "conflict",
  current: { note: { ...NOTE, body: "someone else's text" }, revision: "999:44" },
};

const COLLISION: ConflictPayload = { error: "a note with that slug already exists", reason: "collision", slug: "taken" };

/** A `fetch` that answers 409 with `body`. */
function conflicts(body: unknown): FetchLike & { readonly calls: Call[] } {
  return fakeFetch({ ok: false, status: 409, json: () => Promise.resolve(body) });
}

describe("isNotePayload", () => {
  it("accepts the shape the route serves", () => {
    expect(isNotePayload(PAYLOAD)).toBe(true);
  });

  it("rejects anything missing either half", () => {
    const bad = [null, 42, [], {}, NOTE, { note: NOTE }, { revision: "r" }, { note: {}, revision: "r" }, { note: NOTE, revision: 1 }];
    for (const value of bad) {
      expect(isNotePayload(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe("isConflictPayload", () => {
  it("accepts both arms", () => {
    expect(isConflictPayload(CONFLICT)).toBe(true);
    expect(isConflictPayload(COLLISION)).toBe(true);
  });

  it("rejects a conflict whose nested note is unusable", () => {
    // Checked to the depth the prompt *renders*: the reload button writes
    // `current.note` into the column and overwrite sends `current.revision`.
    // A payload missing either would produce a dialog with two buttons, at
    // least one of which silently does nothing.
    for (const value of [
      { ...CONFLICT, current: undefined },
      { ...CONFLICT, current: { note: NOTE } },
      { ...CONFLICT, current: { note: {}, revision: "r" } },
      { ...COLLISION, slug: 7 },
      { error: "x", reason: "other" },
      { reason: "collision", slug: "s" },
      null,
      [],
      "409",
    ]) {
      expect(isConflictPayload(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe("saveNote", () => {
  it("POSTs the request verbatim to the note's URL", async () => {
    const impl = respondsWith(PAYLOAD);
    await saveNote(impl, "alpha", { body: "new text", expectedRevision: "111:22" });
    const call = impl.calls[0];
    expect(call?.url).toBe("/api/note/alpha");
    expect(call?.init?.method).toBe("POST");
    expect(call?.init?.headers?.["content-type"]).toBe("application/json");
    expect(JSON.parse(call?.init?.body ?? "{}")).toEqual({ body: "new text", expectedRevision: "111:22" });
  });

  it("sends no expectedRevision when the caller omits one — that is how overwrite is spelled", async () => {
    const impl = respondsWith(PAYLOAD);
    await saveNote(impl, "alpha", { body: "mine" });
    expect(JSON.parse(impl.calls[0]?.init?.body ?? "{}")).toEqual({ body: "mine" });
  });

  it("encodes the slug", async () => {
    const impl = respondsWith(PAYLOAD);
    await saveNote(impl, "a b/c", { body: "x" });
    expect(impl.calls[0]?.url).toBe("/api/note/a%20b%2Fc");
  });

  it("returns the fresh payload on 200", async () => {
    const result = await saveNote(respondsWith(PAYLOAD), "alpha", { body: "x" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.revision).toBe("111:22");
  });

  it("decodes a 409 into its own arm, carrying the current note", async () => {
    // The whole reason writes do not go through the generic `request`: the
    // 409 *body* is the point, and flattening it to a message would leave
    // the editor unable to offer reload-or-overwrite.
    const result = await saveNote(conflicts(CONFLICT), "alpha", { body: "x", expectedRevision: "old" });
    expect(result.ok).toBe(false);
    if (result.ok || result.kind !== "conflict") throw new Error("expected a conflict");
    expect(result.status).toBe(409);
    expect(result.message).toBe(CONFLICT.error);
    if (result.conflict.reason !== "conflict") throw new Error("expected the conflict arm");
    expect(result.conflict.current.note.body).toBe("someone else's text");
    expect(result.conflict.current.revision).toBe("999:44");
  });

  it("treats a 409 with an undecodable body as malformed, not as a prompt", async () => {
    // Presenting reload-or-overwrite built from a payload we could not read
    // would offer two buttons, at least one of which does nothing.
    expect(await saveNote(conflicts({ nonsense: true }), "alpha", { body: "x" })).toMatchObject({
      ok: false,
      kind: "malformed",
      status: 409,
    });
  });

  it("treats a 409 with an unparseable body as malformed", async () => {
    const impl = fakeFetch({ ok: false, status: 409, json: () => Promise.reject(new Error("boom")) });
    expect(await saveNote(impl, "alpha", { body: "x" })).toMatchObject({ ok: false, kind: "malformed", status: 409 });
  });

  it("maps the other statuses exactly as reads do", async () => {
    expect(await saveNote(respondsStatus(404), "gone", { body: "x" })).toMatchObject({ ok: false, kind: "missing" });
    expect(await saveNote(respondsStatus(403), "alpha", { body: "x" })).toMatchObject({ ok: false, kind: "auth" });
    expect(await saveNote(respondsStatus(500), "alpha", { body: "x" })).toMatchObject({ ok: false, kind: "server" });
    expect(await saveNote(rejects(), "alpha", { body: "x" })).toMatchObject({ ok: false, kind: "network", status: 0 });
    expect(await saveNote(() => Promise.reject(42), "alpha", { body: "x" })).toMatchObject({ ok: false, kind: "network" });
  });

  it("reports a 200 that is not a NotePayload as malformed", async () => {
    expect(await saveNote(respondsWith(NOTE), "alpha", { body: "x" })).toMatchObject({ ok: false, kind: "malformed" });
  });

  it("reports a 200 with an unparseable body as malformed", async () => {
    const impl = fakeFetch({ ok: true, status: 200, json: () => Promise.reject(new Error("boom")) });
    expect(await saveNote(impl, "alpha", { body: "x" })).toMatchObject({ ok: false, kind: "malformed" });
  });
});

describe("renameNote", () => {
  it("POSTs the target to the rename sub-resource", async () => {
    const impl = respondsWith(PAYLOAD);
    await renameNote(impl, "alpha", "Alpha Renamed");
    expect(impl.calls[0]?.url).toBe("/api/note/alpha/rename");
    expect(JSON.parse(impl.calls[0]?.init?.body ?? "{}")).toEqual({ slug: "Alpha Renamed" });
  });

  it("surfaces a collision as a conflict carrying the taken slug", async () => {
    const result = await renameNote(conflicts(COLLISION), "alpha", "taken");
    if (result.ok || result.kind !== "conflict") throw new Error("expected a conflict");
    expect(result.conflict).toEqual(COLLISION);
  });

  it("reports a missing source note", async () => {
    expect(await renameNote(respondsStatus(404), "gone", "x")).toMatchObject({ ok: false, kind: "missing" });
  });
});

describe("deleteNote", () => {
  it("sends DELETE with no body", async () => {
    const impl = respondsWith({ deleted: true });
    await deleteNote(impl, "alpha");
    expect(impl.calls[0]?.url).toBe("/api/note/alpha");
    expect(impl.calls[0]?.init?.method).toBe("DELETE");
    expect(impl.calls[0]?.init?.body).toBeUndefined();
  });

  it("returns the acknowledgement on 200", async () => {
    const result = await deleteNote(respondsWith({ deleted: true }), "alpha");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.deleted).toBe(true);
  });

  it("reports a missing note", async () => {
    expect(await deleteNote(respondsStatus(404), "gone")).toMatchObject({ ok: false, kind: "missing" });
  });

  it("rejects an acknowledgement that does not say `deleted: true`", async () => {
    for (const body of [{}, { deleted: false }, { deleted: "yes" }]) {
      expect(await deleteNote(respondsWith(body), "alpha"), JSON.stringify(body)).toMatchObject({ ok: false, kind: "malformed" });
    }
  });
});
