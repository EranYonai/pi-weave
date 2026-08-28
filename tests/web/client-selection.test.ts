/**
 * selection.storage.ts — pure-function tests.
 *
 * The shell's wiring (save on selection change, restore once after the
 * first graph) is a `.tsx` effect and therefore untestable here by
 * convention; what is testable is the contract the effects rely on: saving
 * round-trips, clearing saves an empty marker, a saved id is only offered
 * back while it still names a graph node, and neither direction throws —
 * partitioned-storage contexts make every `Storage` call guilty until
 * proven innocent.
 */

import { describe, expect, it } from "vitest";
import type { GraphPayload } from "../../src/web/shared/wire";
import {
  restoreSelection,
  saveSelection,
  SELECTION_STORAGE_KEY,
  type SelectionStorage,
} from "../../src/web/client/selection.storage";

/** In-memory double that can be told to throw, the way real storage can. */
function fakeStorage(fail = false): SelectionStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => {
      if (fail) throw new Error("SecurityError");
      return data.get(key) ?? null;
    },
    setItem: (key, value) => {
      if (fail) throw new Error("QuotaExceededError");
      data.set(key, value);
    },
  };
}

const NODE_IDS = ["note:alpha", "note:beta", "vault"];

function graph(): GraphPayload {
  return {
    model: {
      generatedAt: "2026-03-04T09:00:00Z",
      staleness: null,
      nodes: NODE_IDS.map((id) => ({ id, kind: "note" as const, label: id, provenance: null, detail: {} })),
      edges: [],
      contentDigest: "",
    },
    tags: {},
    dangling: {},
    positions: null,
    stamp: "abc",
  };
}

describe("saveSelection", () => {
  it("stores the id under the versioned key", () => {
    const storage = fakeStorage();
    expect(saveSelection(storage, "note:alpha")).toBe(true);
    expect(storage.data.get(SELECTION_STORAGE_KEY)).toBe("note:alpha");
  });

  it("stores an empty marker when the selection clears", () => {
    const storage = fakeStorage();
    saveSelection(storage, "note:alpha");
    saveSelection(storage, null);
    expect(storage.data.get(SELECTION_STORAGE_KEY)).toBe("");
  });

  it("reports storage failure instead of throwing", () => {
    expect(saveSelection(fakeStorage(true), "note:alpha")).toBe(false);
  });
});

describe("restoreSelection", () => {
  it("returns the saved id when it still names a node", () => {
    const storage = fakeStorage();
    saveSelection(storage, "note:beta");
    expect(restoreSelection(graph(), storage)).toBe("note:beta");
  });

  it("returns null when nothing was saved", () => {
    expect(restoreSelection(graph(), fakeStorage())).toBeNull();
  });

  it("returns null for the cleared marker", () => {
    const storage = fakeStorage();
    saveSelection(storage, "note:alpha");
    saveSelection(storage, null);
    expect(restoreSelection(graph(), storage)).toBeNull();
  });

  it("does not resurrect an id the graph no longer has", () => {
    const storage = fakeStorage();
    saveSelection(storage, "note:deleted");
    expect(restoreSelection(graph(), storage)).toBeNull();
  });

  it("returns null before the first graph arrives", () => {
    const storage = fakeStorage();
    saveSelection(storage, "note:beta");
    expect(restoreSelection(null, storage)).toBeNull();
  });

  it("absorbs a throwing read", () => {
    const storage = fakeStorage();
    saveSelection(storage, "note:beta");
    expect(restoreSelection(graph(), fakeStorage(true))).toBeNull();
  });
});