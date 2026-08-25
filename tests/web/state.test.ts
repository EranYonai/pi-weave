/**
 * The context bus (weave-workspace §1.3).
 *
 * `src/web/client/state.ts` is browser-tier, but it is *not* a DOM shell — it
 * is plain signal declarations with no `document` access, so it imports and
 * runs under Node and is covered like any other module. §10 excludes only
 * `**​/*.tsx` view files from coverage; a blanket `src/web/client/**` exclude
 * is explicitly not acceptable, and this suite is why it isn't needed.
 *
 * What is worth asserting at P0 is small but real: the five signals of §1.3
 * exist with the documented initial values, and writing `selectedId` — the one
 * thing every column reacts to — actually propagates. That last point is the
 * whole architecture in one test.
 */

import { computed, effect } from "@preact/signals";
import { afterEach, describe, expect, it } from "vitest";
import { connection, graph, initialTreeState, noteBody, selectedId, treeState } from "../../src/web/client/state";
import type { GraphPayload, ViewNote } from "../../src/web/shared/wire";

/**
 * A minimal but *real* `GraphPayload`.
 *
 * These fixtures used to be structural literals (`{nodes:[{id:"a"}], …}`)
 * matching the local placeholder interfaces `state.ts` declared behind its
 * `TODO(P1)` markers. Those placeholders are gone and the signals now carry
 * the wire contracts, so the fixtures are the wire shapes too — which is the
 * point: an assignment that compiles here is an assignment `api.ts` could
 * actually produce.
 */
const GRAPH: GraphPayload = {
  model: {
    generatedAt: "2026-01-01T00:00:00Z",
    staleness: null,
    nodes: [
      { id: "a", kind: "note", label: "Alpha", provenance: "human", detail: {} },
      { id: "b", kind: "note", label: "Beta", provenance: "agent", detail: {} },
    ],
    edges: [{ source: "a", target: "b", kind: "links-to" }],
  },
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

/** Signals are module-level singletons; leaving one dirty would leak. */
afterEach(() => {
  selectedId.value = null;
  graph.value = null;
  noteBody.value = null;
  treeState.value = initialTreeState();
  connection.value = "live";
});

describe("initial state", () => {
  it("starts with nothing selected and nothing loaded", () => {
    expect(selectedId.value).toBeNull();
    expect(graph.value).toBeNull();
    expect(noteBody.value).toBeNull();
  });

  it("starts with a collapsed tree", () => {
    expect(treeState.value).toEqual({ expanded: [] });
  });

  it("assumes the connection is live until the client learns otherwise", () => {
    expect(connection.value).toBe("live");
  });
});

describe("initialTreeState", () => {
  it("returns a fresh value each call, so callers cannot alias the default", () => {
    const a = initialTreeState();
    const b = initialTreeState();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});

describe("selectedId as the context bus", () => {
  it("notifies dependents when written — the §1.3 mechanism", () => {
    const seen: (string | null)[] = [];
    const stop = effect(() => {
      seen.push(selectedId.value);
    });

    selectedId.value = "note:alpha";
    selectedId.value = "repo:src/core/vault.ts";
    stop();

    // effect() runs once eagerly, then once per write
    expect(seen).toEqual([null, "note:alpha", "repo:src/core/vault.ts"]);
  });

  it("drives derived values, which is how the columns are computed", () => {
    const isNote = computed(() => selectedId.value?.startsWith("note:") ?? false);
    expect(isNote.value).toBe(false);

    selectedId.value = "note:alpha";
    expect(isNote.value).toBe(true);

    selectedId.value = "repo:README.md";
    expect(isNote.value).toBe(false);
  });

  it("stops notifying after the effect is disposed", () => {
    let count = 0;
    const stop = effect(() => {
      void selectedId.value;
      count += 1;
    });
    stop();

    selectedId.value = "note:beta";
    expect(count).toBe(1);
  });
});

describe("the remaining signals hold their payloads", () => {
  it("carries a graph payload", () => {
    graph.value = GRAPH;
    expect(graph.value.model.nodes).toHaveLength(2);
    expect(graph.value.model.edges[0]).toEqual({ source: "a", target: "b", kind: "links-to" });
  });

  it("carries the stamp the SSE consumer dedupes on", () => {
    // The stamp only exists on the real contract — under the old placeholder
    // shape this assertion could not have been written, which is precisely
    // the kind of gap the cleanup closed.
    graph.value = GRAPH;
    expect(graph.value.stamp).toBe(GRAPH.model.generatedAt);
  });

  it("carries a note body and the revision the editor saves against", () => {
    // A `NotePayload`, not a bare `ViewNote`, as of P5: the revision travels
    // *with* the body because a revision fetched separately would describe a
    // state the draft was not typed against.
    noteBody.value = { note: NOTE, revision: "111:22" };
    expect(noteBody.value.note.body).toBe("# Alpha");
    expect(noteBody.value.note.source).toBe("human");
    expect(noteBody.value.revision).toBe("111:22");
  });

  it("carries expanded tree rows", () => {
    treeState.value = { expanded: ["vault", "vault/projects"] };
    expect(treeState.value.expanded).toContain("vault/projects");
  });

  it("moves through the three connection states of §6", () => {
    for (const state of ["live", "reconnecting", "offline"] as const) {
      connection.value = state;
      expect(connection.value).toBe(state);
    }
  });
});
