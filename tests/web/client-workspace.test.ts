/**
 * The controller that joins fetching, liveness and the signal bus
 * (weave-workspace §1.3, §6).
 *
 * `workspace.ts` is where the three otherwise-independent client modules meet,
 * so it is where the interesting orderings live: the mount fetch seeds the
 * stamp *before* the socket opens, a reconnect refetches everything, a `304`
 * does not churn subscribers, and a failed refetch leaves the previous data
 * on screen rather than blanking a column.
 *
 * Both dependencies are injected — `fetch` and the socket factory — so all of
 * that is reachable from Node with no DOM, per §10.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { FetchLike, HttpRequest, HttpResponse } from "../../src/web/client/api";
import type { EventSourceLike } from "../../src/web/client/live";
import { SOCKET_CLOSED, SOCKET_CONNECTING } from "../../src/web/client/live.model";
import { connection, graph, noteBody, recentIds, selectedId } from "../../src/web/client/state";
import {
  addedNodeIds,
  noteSlug,
  observeNotes,
  resetWorkspace,
  select,
  startWorkspace,
} from "../../src/web/client/workspace";
import { CHANGE_EVENT_NAME } from "../../src/web/shared/wire";
import type { GraphPayload, NotePayload, ViewNote } from "../../src/web/shared/wire";

afterEach(() => {
  resetWorkspace();
});

// --- fixtures ---------------------------------------------------------------------

function payloadAt(stamp: string): GraphPayload {
  return {
    model: {
      generatedAt: stamp,
      staleness: null,
      nodes: [{ id: "note:alpha", kind: "note", label: "Alpha", provenance: "human", detail: {} }],
      edges: [],
      contentDigest: "",
    },
    tags: {},
    dangling: {},
    positions: null,
    stamp,
  };
}

const NOTE: ViewNote = {
  slug: "alpha",
  title: "Alpha",
  body: "# Alpha",
  created: "2026-01-01T00:00:00Z",
  updated: "2026-01-02T00:00:00Z",
  tags: [],
  source: "human",
};

/** What `GET /api/note/:slug` serves as of P5 (§11 P5.3). */
const PAYLOAD: NotePayload = { note: NOTE, revision: "111:22" };

interface Call {
  readonly url: string;
  readonly init: HttpRequest | undefined;
}

/**
 * A `fetch` that routes by path and records every call.
 *
 * `graphStatus` lets a test force the 304 and failure paths without having to
 * model an ETag cache.
 */
function router(opts: {
  graph?: () => { status: number; body: unknown };
  note?: () => { status: number; body: unknown };
}): FetchLike & { readonly calls: Call[] } {
  const calls: Call[] = [];
  const impl = (url: string, init?: HttpRequest): Promise<HttpResponse> => {
    calls.push({ url, init });
    const handler = url.startsWith("/api/graph") ? opts.graph : opts.note;
    const { status, body } = handler?.() ?? { status: 200, body: {} };
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    });
  };
  return Object.assign(impl, { calls });
}

/** A fake `EventSource`, as in `client-live.test.ts`. */
function fakeSource(): EventSourceLike & {
  emit(data: string): void;
  fire(type: "open" | "error"): void;
  setReadyState(value: number): void;
  readonly closes: number;
} {
  const listeners = new Map<string, Array<(event: { data: string }) => void>>();
  let readyState = SOCKET_CONNECTING;
  let closes = 0;
  return {
    get readyState() {
      return readyState;
    },
    addEventListener(type, listener) {
      const existing = listeners.get(type);
      if (existing === undefined) listeners.set(type, [listener]);
      else existing.push(listener);
    },
    close() {
      closes += 1;
      readyState = SOCKET_CLOSED;
    },
    emit(data) {
      for (const listener of listeners.get(CHANGE_EVENT_NAME) ?? []) listener({ data });
    },
    fire(type) {
      for (const listener of listeners.get(type) ?? []) listener({ data: "" });
    },
    setReadyState(value) {
      readyState = value;
    },
    get closes() {
      return closes;
    },
  };
}

/** Let the controller's fire-and-forget promise chains settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

const graphUrls = (calls: readonly Call[]): Call[] => calls.filter((c) => c.url.startsWith("/api/graph"));
const noteUrls = (calls: readonly Call[]): Call[] => calls.filter((c) => c.url.startsWith("/api/note"));

// --- note ids ------------------------------------------------------------------------

describe("noteSlug", () => {
  it("extracts the slug from a note node id", () => {
    expect(noteSlug("note:alpha")).toBe("alpha");
    expect(noteSlug("note:some/deep-slug")).toBe("some/deep-slug");
  });

  it("is null for anything that is not a note node", () => {
    // Repository, git-state and file nodes have no body to fetch.
    for (const id of [null, "repo:src/core", "gitState", "vault", "", "notes:alpha"]) {
      expect(noteSlug(id)).toBeNull();
    }
  });

  it("rejects an empty slug rather than requesting /api/note/", () => {
    expect(noteSlug("note:")).toBeNull();
  });
});

// --- boot ------------------------------------------------------------------------------

describe("startWorkspace", () => {
  it("fetches the graph on mount and publishes it", async () => {
    const fetch = router({ graph: () => ({ status: 200, body: payloadAt("s1") }) });
    const handle = startWorkspace({ fetch, open: () => fakeSource() });
    await settle();

    expect(graph.value?.stamp).toBe("s1");
    expect(graphUrls(fetch.calls)).toHaveLength(1);
    handle.stop();
  });

  it("sends the mount fetch unconditionally, with no If-None-Match", () => {
    const fetch = router({ graph: () => ({ status: 200, body: payloadAt("s1") }) });
    const handle = startWorkspace({ fetch, open: () => fakeSource() });
    expect(graphUrls(fetch.calls)[0]?.init?.headers).toBeUndefined();
    handle.stop();
  });

  it("seeds the stamp so the server's hello frame is deduped away", async () => {
    // `sse.ts` sends the current stamp to every newly attached client. Without
    // the seed, every single page load would fetch the graph twice.
    const source = fakeSource();
    const fetch = router({ graph: () => ({ status: 200, body: payloadAt("s1") }) });
    const handle = startWorkspace({ fetch, open: () => source });
    await settle();

    source.emit(JSON.stringify({ scope: "vault", stamp: "s1" }));
    await settle();

    expect(graphUrls(fetch.calls)).toHaveLength(1);
    handle.stop();
  });

  it("refetches when a frame carries a stamp it has not seen", async () => {
    const source = fakeSource();
    let stamp = "s1";
    const fetch = router({ graph: () => ({ status: 200, body: payloadAt(stamp) }) });
    const handle = startWorkspace({ fetch, open: () => source });
    await settle();

    stamp = "s2";
    source.emit(JSON.stringify({ scope: "vault", stamp: "s2" }));
    await settle();

    expect(graphUrls(fetch.calls)).toHaveLength(2);
    expect(graph.value?.stamp).toBe("s2");
    handle.stop();
  });

  it("sends If-None-Match on the refetch, so an idle workspace costs a 304", async () => {
    const source = fakeSource();
    const fetch = router({ graph: () => ({ status: 200, body: payloadAt("s1") }) });
    const handle = startWorkspace({ fetch, open: () => source });
    await settle();

    source.emit(JSON.stringify({ scope: "repo", stamp: "s2" }));
    await settle();

    expect(graphUrls(fetch.calls)[1]?.init?.headers).toEqual({ "if-none-match": '"s1"' });
    handle.stop();
  });

  it("refetches EVERYTHING on a reconnect — §6, no replay buffer", async () => {
    const source = fakeSource();
    const fetch = router({
      graph: () => ({ status: 200, body: payloadAt("s1") }),
      note: () => ({ status: 200, body: PAYLOAD }),
    });
    const handle = startWorkspace({ fetch, open: () => source });
    await settle();
    selectedId.value = "note:alpha";

    source.fire("open");
    source.setReadyState(SOCKET_CONNECTING);
    source.fire("error");
    source.fire("open");
    await settle();

    expect(graphUrls(fetch.calls).length).toBeGreaterThan(1);
    expect(noteUrls(fetch.calls)).toHaveLength(1);
    handle.stop();
  });

  it("does not touch the note endpoint for a repo-scope frame", async () => {
    const source = fakeSource();
    const fetch = router({
      graph: () => ({ status: 200, body: payloadAt("s1") }),
      note: () => ({ status: 200, body: PAYLOAD }),
    });
    const handle = startWorkspace({ fetch, open: () => source });
    await settle();
    selectedId.value = "note:alpha";

    source.emit(JSON.stringify({ scope: "repo", stamp: "s9" }));
    await settle();

    expect(noteUrls(fetch.calls)).toEqual([]);
    handle.stop();
  });

  it("refetches the note for a vault frame while a note is open", async () => {
    const source = fakeSource();
    const fetch = router({
      graph: () => ({ status: 200, body: payloadAt("s1") }),
      note: () => ({ status: 200, body: PAYLOAD }),
    });
    const handle = startWorkspace({ fetch, open: () => source });
    await settle();
    selectedId.value = "note:alpha";

    source.emit(JSON.stringify({ scope: "vault", stamp: "s9" }));
    await settle();

    expect(noteUrls(fetch.calls)).toHaveLength(1);
    expect(noteBody.value?.note.slug).toBe("alpha");
    handle.stop();
  });

  it("does not re-assign the graph signal on a 304", async () => {
    // A no-op write still wakes every subscriber; three columns re-rendering
    // whenever the watcher twitches is exactly what the `cached` flag avoids.
    const source = fakeSource();
    let status = 200;
    const fetch = router({ graph: () => ({ status, body: payloadAt("s1") }) });
    const handle = startWorkspace({ fetch, open: () => source });
    await settle();

    const first = graph.value;
    status = 304;
    source.emit(JSON.stringify({ scope: "vault", stamp: "s2" }));
    await settle();

    expect(graph.value).toBe(first);
    handle.stop();
  });

  it("leaves the previous graph on screen when a refetch fails", async () => {
    const source = fakeSource();
    let status = 200;
    const fetch = router({ graph: () => ({ status, body: payloadAt("s1") }) });
    const handle = startWorkspace({ fetch, open: () => source });
    await settle();

    status = 500;
    source.emit(JSON.stringify({ scope: "vault", stamp: "s2" }));
    await settle();

    // Stale beats blank.
    expect(graph.value?.stamp).toBe("s1");
    handle.stop();
  });

  it("does not record a stamp for a failed fetch, so the retry is not deduped", async () => {
    const source = fakeSource();
    let status = 500;
    const fetch = router({ graph: () => ({ status, body: payloadAt("s2") }) });
    const handle = startWorkspace({ fetch, open: () => source });
    await settle();

    status = 200;
    source.emit(JSON.stringify({ scope: "vault", stamp: "s2" }));
    await settle();
    source.emit(JSON.stringify({ scope: "vault", stamp: "s2" }));
    await settle();

    expect(graph.value?.stamp).toBe("s2");
    handle.stop();
  });

  it("survives a graph fetch that rejects outright", async () => {
    const handle = startWorkspace({
      fetch: () => Promise.reject(new Error("connection refused")),
      open: () => fakeSource(),
    });
    await settle();
    expect(graph.value).toBeNull();
    handle.stop();
  });

  it("passes an injected SSE path through to the socket", () => {
    const urls: string[] = [];
    const handle = startWorkspace({
      fetch: router({}),
      open: (url) => {
        urls.push(url);
        return fakeSource();
      },
      path: "/custom-events",
    });
    expect(urls).toEqual(["/custom-events"]);
    handle.stop();
  });

  it("defaults to the §5.3 events path", () => {
    const urls: string[] = [];
    const handle = startWorkspace({
      fetch: router({}),
      open: (url) => {
        urls.push(url);
        return fakeSource();
      },
    });
    expect(urls).toEqual(["/events"]);
    handle.stop();
  });
});

// --- refresh, stop, syncNote ---------------------------------------------------------------

describe("WorkspaceHandle", () => {
  it("refresh() refetches the graph", async () => {
    const fetch = router({ graph: () => ({ status: 200, body: payloadAt("s1") }) });
    const handle = startWorkspace({ fetch, open: () => fakeSource() });
    await settle();

    handle.refresh();
    await settle();

    expect(graphUrls(fetch.calls)).toHaveLength(2);
    handle.stop();
  });

  it("refresh() also refetches the note when one is open", async () => {
    const fetch = router({
      graph: () => ({ status: 200, body: payloadAt("s1") }),
      note: () => ({ status: 200, body: PAYLOAD }),
    });
    const handle = startWorkspace({ fetch, open: () => fakeSource() });
    await settle();
    selectedId.value = "note:alpha";

    handle.refresh();
    await settle();

    expect(noteUrls(fetch.calls)).toHaveLength(1);
    handle.stop();
  });

  it("stop() closes the socket and is idempotent", () => {
    const source = fakeSource();
    const handle = startWorkspace({ fetch: router({}), open: () => source });
    handle.stop();
    handle.stop();
    expect(source.closes).toBe(1);
    expect(connection.value).toBe("offline");
  });

  it("refresh() after stop() is a no-op rather than a crash", async () => {
    const fetch = router({ graph: () => ({ status: 200, body: payloadAt("s1") }) });
    const handle = startWorkspace({ fetch, open: () => fakeSource() });
    await settle();
    handle.stop();
    const before = fetch.calls.length;

    handle.refresh();
    await settle();

    expect(fetch.calls).toHaveLength(before);
  });

  it("syncNote() clears the body when nothing is selected", async () => {
    const fetch = router({ note: () => ({ status: 200, body: PAYLOAD }) });
    const handle = startWorkspace({ fetch, open: () => fakeSource() });
    noteBody.value = PAYLOAD;

    await handle.syncNote();

    expect(noteBody.value).toBeNull();
    expect(noteUrls(fetch.calls)).toEqual([]);
    handle.stop();
  });
});

// --- selection ------------------------------------------------------------------------------

describe("select", () => {
  it("writes the signal synchronously — the §1.3 context bus", async () => {
    const fetch = router({ note: () => ({ status: 200, body: PAYLOAD }) });
    const pending = select(fetch, "note:alpha");
    // The write has already happened; the fetch has not resolved.
    expect(selectedId.value).toBe("note:alpha");
    await pending;
    expect(noteBody.value?.note.slug).toBe("alpha");
  });

  it("percent-encodes the slug in the request", async () => {
    const fetch = router({ note: () => ({ status: 200, body: PAYLOAD }) });
    await select(fetch, "note:a b");
    expect(noteUrls(fetch.calls)[0]?.url).toBe("/api/note/a%20b");
  });

  it("clears the body when the selection is not a note", async () => {
    const fetch = router({ note: () => ({ status: 200, body: PAYLOAD }) });
    await select(fetch, "note:alpha");
    expect(noteBody.value).not.toBeNull();

    await select(fetch, "repo:src/core/vault.ts");

    expect(selectedId.value).toBe("repo:src/core/vault.ts");
    expect(noteBody.value).toBeNull();
  });

  it("clears the body on a null selection", async () => {
    const fetch = router({ note: () => ({ status: 200, body: PAYLOAD }) });
    await select(fetch, "note:alpha");
    await select(fetch, null);
    expect(noteBody.value).toBeNull();
  });

  it("keeps the current body when the note fetch fails", async () => {
    // Blanking a readable column on a transient error throws away content the
    // user was reading, and the note is usually still there.
    const fetch = router({ note: () => ({ status: 200, body: PAYLOAD }) });
    await select(fetch, "note:alpha");

    const failing = router({ note: () => ({ status: 500, body: {} }) });
    await select(failing, "note:beta");

    expect(noteBody.value?.note.slug).toBe("alpha");
  });

  it("ignores a malformed note body", async () => {
    const fetch = router({ note: () => ({ status: 200, body: { note: { slug: 7 }, revision: "r" } }) });
    await select(fetch, "note:alpha");
    expect(noteBody.value).toBeNull();
  });
});

// --- the editor's load hook (§6, P5) -----------------------------------------------------------

describe("observeNotes", () => {
  it("is told about every note that reaches the column", async () => {
    // Three unrelated directions produce a note — the mount fetch, a
    // selection, and an SSE refetch — and the editor's "is this the note I am
    // editing, at a revision I do not hold?" decision has to be made on all
    // three or it is made on none.
    const seen: NotePayload[] = [];
    const stop = observeNotes((p) => void seen.push(p));
    const fetch = router({ note: () => ({ status: 200, body: PAYLOAD }) });

    await select(fetch, "note:alpha");
    expect(seen).toEqual([PAYLOAD]);
    stop();
  });

  it("is not called for a failed or malformed fetch", async () => {
    // The signal is not written either, so telling the editor about a note
    // that never arrived would give it a revision the column does not hold.
    const seen: NotePayload[] = [];
    const stop = observeNotes((p) => void seen.push(p));
    await select(router({ note: () => ({ status: 500, body: {} }) }), "note:alpha");
    await select(router({ note: () => ({ status: 200, body: { note: 7 } }) }), "note:beta");
    expect(seen).toEqual([]);
    stop();
  });

  it("publishes the signal before it calls the hook", async () => {
    // The editor's decision may leave the draft in place *while* the
    // column's read-mode rendering shows the new version, and the two are
    // independent. Calling the hook first would let it see a payload the
    // rest of the workspace does not yet hold.
    let atCall: NotePayload | null = null;
    const stop = observeNotes(() => {
      atCall = noteBody.value;
    });
    await select(router({ note: () => ({ status: 200, body: PAYLOAD }) }), "note:alpha");
    expect(atCall).toEqual(PAYLOAD);
    stop();
  });

  it("unsubscribes, and only its own registration", async () => {
    // Two shells in one test process unmounting out of order must not blank
    // a live hook.
    const first: NotePayload[] = [];
    const second: NotePayload[] = [];
    const stopFirst = observeNotes((p) => void first.push(p));
    const stopSecond = observeNotes((p) => void second.push(p));

    // The second registration won; the first's unsubscribe must be a no-op.
    stopFirst();
    await select(router({ note: () => ({ status: 200, body: PAYLOAD }) }), "note:alpha");
    expect(first).toEqual([]);
    expect(second).toEqual([PAYLOAD]);

    stopSecond();
    await select(router({ note: () => ({ status: 200, body: PAYLOAD }) }), "note:alpha");
    expect(second).toHaveLength(1);
  });

  it("a load with no observer is just a load", async () => {
    const fetch = router({ note: () => ({ status: 200, body: PAYLOAD }) });
    await select(fetch, "note:alpha");
    expect(noteBody.value).toEqual(PAYLOAD);
  });
});

describe("resetWorkspace", () => {
  it("returns every signal to its documented initial value", () => {
    selectedId.value = "note:alpha";
    graph.value = payloadAt("s1");
    noteBody.value = PAYLOAD;
    connection.value = "offline";

    resetWorkspace();

    expect(selectedId.value).toBeNull();
    expect(graph.value).toBeNull();
    expect(noteBody.value).toBeNull();
    expect(connection.value).toBe("live");
    expect(recentIds.value.size).toBe(0);
  });
});

describe("addedNodeIds", () => {
  it("flags nothing on the mount fetch — a first load is not 'new'", () => {
    expect(addedNodeIds(null, payloadAt("s1")).size).toBe(0);
  });

  it("flags ids the previous payload did not have", () => {
    const next = payloadAt("s2");
    next.model.nodes = [
      ...next.model.nodes,
      { id: "file:new.ts", kind: "file", label: "new.ts", provenance: null, detail: {} },
    ];
    const added = addedNodeIds(payloadAt("s1"), next);
    expect(added.has("file:new.ts")).toBe(true);
    expect(added.has("note:alpha")).toBe(false);
  });

  it("flags nothing when the node set is unchanged", () => {
    expect(addedNodeIds(payloadAt("s1"), payloadAt("s1")).size).toBe(0);
  });

  it("flags an id that left and returned", () => {
    const gone = payloadAt("s2");
    gone.model.nodes = [];
    const back = payloadAt("s3");
    expect(addedNodeIds(payloadAt("s1"), gone).has("note:alpha")).toBe(false);
    expect(addedNodeIds(gone, back).has("note:alpha")).toBe(true);
  });
});

describe("recent arrivals (tree flash)", () => {
  it("the mount fetch flags nothing", async () => {
    const fetch = router({ graph: () => ({ status: 200, body: payloadAt("s1") }) });
    const handle = startWorkspace({ fetch, open: () => fakeSource() });
    await settle();
    expect(recentIds.value.size).toBe(0);
    handle.stop();
  });

  it("a frame that adds a node flags exactly the addition, then the timer clears it", async () => {
    let body = payloadAt("s1");
    const fetch = router({
      graph: () => ({ status: 200, body }),
      note: () => ({ status: 404, body: {} }),
    });
    const source = fakeSource();
    const deferred: Array<{ fn: () => void; ms: number; cancel: () => void }> = [];
    const defer = (fn: () => void, ms: number) => {
      const entry = { fn, ms, cancel: () => undefined };
      entry.cancel = () => {
        entry.fn = () => undefined;
      };
      deferred.push(entry);
      return entry.cancel;
    };
    const handle = startWorkspace({ fetch, open: () => source, defer });
    await settle();

    const next = payloadAt("s2");
    next.model.nodes = [
      ...next.model.nodes,
      { id: "file:new.ts", kind: "file", label: "new.ts", provenance: null, detail: {} },
    ];
    body = next;
    source.emit(JSON.stringify({ scope: "vault", stamp: "s2" }));
    await settle();

    expect(recentIds.value.has("file:new.ts")).toBe(true);
    expect(recentIds.value.has("note:alpha")).toBe(false);

    deferred[0].fn();
    expect(recentIds.value.size).toBe(0);
    handle.stop();
  });

  it("stop clears the flag and cancels the pending expiry", async () => {
    let body = payloadAt("s1");
    const fetch = router({ graph: () => ({ status: 200, body }) });
    const source = fakeSource();
    const deferred: Array<{ fn: () => void; ms: number; ran: boolean; cancelRan: boolean }> = [];
    const defer = (fn: () => void, ms: number) => {
      const entry = { fn, ms, ran: false, cancelRan: false };
      deferred.push(entry);
      return () => {
        entry.cancelRan = true;
      };
    };
    const handle = startWorkspace({ fetch, open: () => source, defer });
    await settle();

    body = payloadAt("s2");
    body.model.nodes = [
      ...body.model.nodes,
      { id: "file:new.ts", kind: "file", label: "new.ts", provenance: null, detail: {} },
    ];
    source.emit(JSON.stringify({ scope: "vault", stamp: "s2" }));
    await settle();
    expect(recentIds.value.has("file:new.ts")).toBe(true);

    handle.stop();
    expect(recentIds.value.size).toBe(0);
    expect(deferred[0]?.cancelRan).toBe(true);
  });
});
