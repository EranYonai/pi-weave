import { describe, expect, it, vi } from "vitest";
import type { FetchLike, HttpResponse } from "../../src/web/client/api";
import { POLL_MS, addedNodeIds, startWorkspace, watchNote } from "../../src/web/client/workspace";
import { initialWorkspaceState } from "../../src/web/client/state";
import type { WorkspaceState } from "../../src/web/client/state";
import type { GraphPayload, NotePayload } from "../../src/web/shared/wire";

const GRAPH: GraphPayload = {
  model: { nodes: [], edges: [], generatedAt: "now" } as unknown as GraphPayload["model"],
  tags: {}, dangling: {}, positions: null, stamp: "a",
};
const NOTE: NotePayload = {
  note: { slug: "alpha", title: "Alpha", body: "body", created: "now", updated: "now", tags: [], source: "human" },
};

function fetchWith(...responses: unknown[]): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  return Object.assign(async (url: string): Promise<HttpResponse> => {
    calls.push(url);
    const body = responses[Math.min(calls.length - 1, responses.length - 1)];
    return { ok: true, status: 200, json: async () => body };
  }, { calls });
}

describe("addedNodeIds", () => {
  it("returns only nodes absent from the previous graph", () => {
    const previous = { ...GRAPH, model: { ...GRAPH.model, nodes: [{ id: "a" }] } } as GraphPayload;
    const next = { ...GRAPH, model: { ...GRAPH.model, nodes: [{ id: "a" }, { id: "b" }] } } as GraphPayload;
    expect(addedNodeIds(previous, next)).toEqual(new Set(["b"]));
    expect(addedNodeIds(null, next)).toEqual(new Set());
  });
});

describe("startWorkspace", () => {
  it("fetches immediately and polls with the current ETag", async () => {
    const fetch = fetchWith(GRAPH, GRAPH);
    let state = initialWorkspaceState();
    let tick: (() => void) | undefined;
    const workspace = startWorkspace({ fetch, state, setState: (next) => { state = next; }, repeat: (fn, ms) => { expect(ms).toBe(POLL_MS); tick = fn; return () => {}; } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.graph).toBe(GRAPH);
    tick?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetch.calls).toEqual(["/api/graph", "/api/graph"]);
    workspace.stop();
  });

  it("does not publish a cached poll", async () => {
    let state = initialWorkspaceState();
    let calls = 0;
    let tick: (() => void) | undefined;
    const fetch: FetchLike = async () => {
      calls += 1;
      return calls === 1
        ? { ok: true, status: 200, json: async () => GRAPH }
        : { ok: false, status: 304, json: async () => { throw new Error("no body"); } };
    };
    let publishes = 0;
    const workspace = startWorkspace({ fetch, state, setState: (next) => { state = next; publishes += 1; }, repeat: (fn) => { tick = fn; return () => {}; } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(publishes).toBe(1);
    tick?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(publishes).toBe(1);
    workspace.stop();
    expect(publishes).toBe(1);
  });

  it("refreshes the selected note alongside the graph", async () => {
    let state: WorkspaceState = { ...initialWorkspaceState(), selectedId: "note:alpha" };
    const fetch = fetchWith(GRAPH, NOTE);
    const workspace = startWorkspace({ fetch, state, setState: (next) => { state = next; }, repeat: () => () => {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.note).toBe(NOTE);
    workspace.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetch.calls).toEqual(["/api/graph", "/api/note/alpha", "/api/graph"]);
    workspace.stop();
  });

  it("retries a failed note fetch when the graph is cached", async () => {
    let state: WorkspaceState = { ...initialWorkspaceState(), selectedId: "note:alpha" };
    let graphCalls = 0;
    let noteCalls = 0;
    let tick: (() => void) | undefined;
    const fetch: FetchLike = async (url) => {
      if (url === "/api/graph") {
        graphCalls += 1;
        return graphCalls === 1
          ? { ok: true, status: 200, json: async () => GRAPH }
          : { ok: false, status: 304, json: async () => { throw new Error("no body"); } };
      }
      noteCalls += 1;
      return noteCalls === 1
        ? { ok: false, status: 500, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => NOTE };
    };
    const workspace = startWorkspace({ fetch, state, setState: (next) => { state = next; }, repeat: (fn) => { tick = fn; return () => {}; } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state).toMatchObject({ note: null, noteFailed: true });
    tick?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state).toMatchObject({ note: NOTE, noteFailed: false });
    expect([graphCalls, noteCalls]).toEqual([2, 2]);
    workspace.stop();
  });

  it("stops polling", async () => {
    let cancelled = false;
    let state = initialWorkspaceState();
    const workspace = startWorkspace({ fetch: fetchWith(GRAPH), state, setState: (next) => { state = next; }, repeat: () => () => { cancelled = true; } });
    workspace.stop();
    expect(cancelled).toBe(true);
  });
});


describe("tab document loading", () => {
  it("retries a failed load independently of cached graph polls", async () => {
    const calls: unknown[] = [];
    let retry!: () => void;
    const cancel = vi.fn();
    const fetch = vi.fn<FetchLike>().mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: "offline" }) }).mockResolvedValue({ ok: true, status: 200, json: async () => NOTE });
    const stop = watchNote(fetch, "one", result => calls.push(result), (fn, ms) => { expect(ms).toBe(POLL_MS); retry = fn; return cancel; });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    retry();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    stop();
    expect(cancel).toHaveBeenCalled();
    expect(calls[1]).toMatchObject({ ok: true, data: NOTE });
    retry();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(2);
  });

  it("cancels the real retry timer after a tab leaves", async () => {
    vi.useFakeTimers();
    try {
      const notify = vi.fn();
      const stop = watchNote(async () => ({ ok: false, status: 503, json: async () => ({}) }), "one", notify);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(POLL_MS);
      expect(notify).toHaveBeenCalledTimes(2);
      stop();
      await vi.advanceTimersByTimeAsync(POLL_MS);
      expect(notify).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it("drops a response completed after a document unmounts", async () => {
    let resolve!: (value: { ok: boolean; status: number; json(): Promise<unknown> }) => void;
    const notify = vi.fn();
    const stop = watchNote(() => new Promise(done => { resolve = done; }), "one", notify);
    stop();
    resolve({ ok: false, status: 503, json: async () => ({ error: "offline" }) });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(notify).not.toHaveBeenCalled();
  });
});
