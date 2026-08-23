import { describe, expect, it, vi } from "vitest";
import { BodyStore } from "../../src/pi/viewer/tui/bodyStore";
import type { ViewNote } from "../../src/core/graph/current";

function fakeLoaders(over: Partial<BodyStore["loaders"]> = {}) {
  return {
    loadNote: async () => null,
    loadOkf: async () => null,
    ...over,
  };
}

const note = (body: string): ViewNote => ({ slug: "a", title: "A", body, created: "", updated: "", tags: [], source: "human" });

describe("BodyStore", () => {
  it("returns undefined for an unrequested id", () => {
    const s = new BodyStore({ loaders: fakeLoaders() });
    expect(s.get("note:a")).toBeUndefined();
    expect(s.has("note:a")).toBe(false);
    expect(s.isLoading("note:a")).toBe(false);
  });

  it("loads a note body, caches it, and flags loading in between", async () => {
    const loadNote = vi.fn(async (slug: string) => note(`body for ${slug}`));
    const s = new BodyStore({ loaders: fakeLoaders({ loadNote }) });
    expect(s.load("note:a", "note", "a")).toBe(true);
    expect(s.isLoading("note:a")).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(s.isLoading("note:a")).toBe(false);
    expect(s.get("note:a")).toBe("body for a");
    // second load is deduped (cache hit → not started)
    expect(s.load("note:a", "note", "a")).toBe(false);
    expect(loadNote).toHaveBeenCalledTimes(1);
  });

  it("dedups an in-flight load (no double fetch)", async () => {
    const loadNote = vi.fn(async () => note("x"));
    const s = new BodyStore({ loaders: fakeLoaders({ loadNote }) });
    s.load("note:a", "note", "a");
    expect(s.load("note:a", "note", "a")).toBe(false);
    expect(loadNote).toHaveBeenCalledTimes(1);
  });

  it("loads an okf file body via loadOkf", async () => {
    const loadOkf = vi.fn(async (rel: string) => ({ path: rel, body: '{"x":1}' }));
    const s = new BodyStore({ loaders: fakeLoaders({ loadOkf }) });
    s.load("okf:git.json", "file", "git.json");
    await new Promise((r) => setTimeout(r, 0));
    expect(s.get("okf:git.json")).toBe('{"x":1}');
  });

  it("caches null for a file load whose loader returns null", async () => {
    const s = new BodyStore({ loaders: fakeLoaders({ loadOkf: async () => null }) });
    s.load("okf:missing", "file", "missing.json");
    await new Promise((r) => setTimeout(r, 0));
    expect(s.has("okf:missing")).toBe(true);
    expect(s.get("okf:missing")).toBeNull();
  });

  it("returns false (no load) when ref is undefined or id already cached", () => {
    const loadNote = vi.fn(async () => note("x"));
    const s = new BodyStore({ loaders: fakeLoaders({ loadNote }) });
    expect(s.load("note:a", "note", undefined)).toBe(false);
    expect(s.load("note:b", "note", "b")).toBe(true);
    void new Promise((r) => setTimeout(r, 0)).then(() => expect(s.load("note:b", "note", "b")).toBe(false));
  });

  it("caches a null body when the loader returns null", async () => {
    const s = new BodyStore({ loaders: fakeLoaders({ loadNote: async () => null }) });
    s.load("note:a", "note", "a");
    await new Promise((r) => setTimeout(r, 0));
    expect(s.has("note:a")).toBe(true);
    expect(s.get("note:a")).toBeNull();
  });

  it("busts the cache on clear so the next read re-fetches", async () => {
    const loadNote = vi.fn(async () => note("first"));
    const s = new BodyStore({ loaders: fakeLoaders({ loadNote }) });
    s.load("note:a", "note", "a");
    await new Promise((r) => setTimeout(r, 0));
    s.clear();
    expect(s.get("note:a")).toBeUndefined();
    expect(s.load("note:a", "note", "a")).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(loadNote).toHaveBeenCalledTimes(2);
  });

  it("fires onChange once when a load resolves", async () => {
    const onChange = vi.fn();
    const s = new BodyStore({ loaders: fakeLoaders({ loadNote: async () => note("x") }), onChange });
    s.load("note:a", "note", "a");
    expect(onChange).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("handles a rejected loader by caching null", async () => {
    const s = new BodyStore({ loaders: fakeLoaders({ loadNote: async () => { throw new Error("boom"); } }) });
    s.load("note:a", "note", "a");
    await new Promise((r) => setTimeout(r, 0));
    expect(s.get("note:a")).toBeNull();
    expect(s.isLoading("note:a")).toBe(false);
  });
});
