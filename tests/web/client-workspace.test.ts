import { describe, expect, it } from "vitest";
import type { FetchLike, HttpResponse } from "../../src/web/client/api";
import { POLL_MS, addedNodeIds, startWorkspace } from "../../src/web/client/workspace";
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

  it("stops polling", async () => {
    let cancelled = false;
    let state = initialWorkspaceState();
    const workspace = startWorkspace({ fetch: fetchWith(GRAPH), state, setState: (next) => { state = next; }, repeat: () => () => { cancelled = true; } });
    workspace.stop();
    expect(cancelled).toBe(true);
  });
});
