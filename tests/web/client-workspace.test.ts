import { afterEach, describe, expect, it } from "vitest";
import type { FetchLike, HttpResponse } from "../../src/web/client/api";
import { POLL_MS, addedNodeIds, resetWorkspace, startWorkspace } from "../../src/web/client/workspace";
import { graph, noteBody, selectedId } from "../../src/web/client/state";
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

afterEach(() => resetWorkspace());

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
    let tick: (() => void) | undefined;
    const workspace = startWorkspace({ fetch, repeat: (fn, ms) => { expect(ms).toBe(POLL_MS); tick = fn; return () => {}; } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(graph.value).toBe(GRAPH);
    tick?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetch.calls).toEqual(["/api/graph", "/api/graph"]);
    workspace.stop();
  });

  it("refreshes the selected note alongside the graph", async () => {
    selectedId.value = "note:alpha";
    const fetch = fetchWith(GRAPH, NOTE);
    const workspace = startWorkspace({ fetch, repeat: () => () => {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(noteBody.value).toBe(NOTE);
    workspace.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetch.calls).toEqual(["/api/graph", "/api/note/alpha", "/api/graph"]);
    workspace.stop();
  });

  it("stops polling", async () => {
    let cancelled = false;
    const workspace = startWorkspace({ fetch: fetchWith(GRAPH), repeat: () => () => { cancelled = true; } });
    workspace.stop();
    expect(cancelled).toBe(true);
  });
});
