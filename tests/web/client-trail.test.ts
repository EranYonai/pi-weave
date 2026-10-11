import { describe, expect, it } from "vitest";
import type { FetchLike, HttpResponse } from "../../src/web/client/api";
import { fetchTrail, isTrailPayload } from "../../src/web/client/api";
import { GRAPH_PALETTE, HIGHLIGHT_Z_LIFT, TRAIL_STYLE, blendHex, trailOverride } from "../../src/web/client/graph/graph.model";
import type { RenderNode } from "../../src/web/client/graph/graph.model";
import { sigmaRenderer } from "../../src/web/client/graph/renderer";
import type { SigmaLike } from "../../src/web/client/graph/renderer";
import { startTrailPoll } from "../../src/web/client/trail/trail";
import {
  REPLAY_STEP_MS,
  TRAIL_EMPTY_TURN,
  TRAIL_FADE_MS,
  TRAIL_TURNS_SHOWN,
  trailLive,
  trailMarks,
  trailRowClass,
  trailTurns,
  turnHeading,
} from "../../src/web/client/trail/trail.model";
import { POLL_MS } from "../../src/web/client/workspace";
import type { GraphPayload, TrailPayload, WireTrailEvent } from "../../src/web/shared/wire";

const T0 = Date.parse("2026-10-11T05:00:00Z");

function event(seq: number, over: Partial<WireTrailEvent> = {}): WireTrailEvent {
  return { seq, turn: 1, at: new Date(T0 + seq * 1_000).toISOString(), kind: "read", action: "get", slugs: [`n${seq}`], ...over };
}

function trail(...events: WireTrailEvent[]): TrailPayload {
  return { stamp: `s${events.length}`, turn: Math.max(0, ...events.map((e) => e.turn)), events };
}

const GRAPH = {
  model: { nodes: [{ id: "note:auth", label: "Auth migration" }], edges: [] },
  tags: {}, dangling: {}, positions: null, stamp: "g",
} as unknown as GraphPayload;

describe("trailMarks", () => {
  it("glows each touched note and fades it over a minute", () => {
    const payload = trail(event(0, { slugs: ["a"] }));
    expect(trailMarks(payload, T0).get("note:a")).toEqual({ kind: "read", strength: 1 });
    expect(trailMarks(payload, T0 + TRAIL_FADE_MS / 2).get("note:a")?.strength).toBeCloseTo(0.5);
    expect(trailMarks(payload, T0 + TRAIL_FADE_MS).size).toBe(0);
    expect(trailMarks(null, T0).size).toBe(0);
  });

  it("shows the strongest kind at the freshest strength", () => {
    const payload = trail(
      event(0, { kind: "wrote", action: "append", slugs: ["a"] }),
      event(10, { kind: "searched", action: "search", slugs: ["a", "b"] }),
    );
    const marks = trailMarks(payload, T0 + 10_000);
    expect(marks.get("note:a")).toEqual({ kind: "wrote", strength: 1 });
    expect(marks.get("note:b")).toEqual({ kind: "searched", strength: 1 });
    const older = trailMarks(trail(event(10, { slugs: ["a"] }), event(0, { kind: "searched", slugs: ["a"] })), T0 + 10_000);
    expect(older.get("note:a")).toEqual({ kind: "read", strength: 1 });
  });

  it("clamps a slightly-future live event to full strength and skips unparseable times", () => {
    expect(trailMarks(trail(event(5, { slugs: ["a"] })), T0).get("note:a")?.strength).toBe(1);
    expect(trailMarks(trail(event(0, { at: "garbage" })), T0).size).toBe(0);
  });

  it("replays one turn's steps in order from the moment it was clicked", () => {
    const payload = trail(event(0, { turn: 1, slugs: ["old"] }), event(1, { turn: 2, slugs: ["a"] }), event(2, { turn: 2, slugs: ["b"] }));
    const replay = { turn: 2, startedAt: T0 + 3_600_000 };
    const first = trailMarks(payload, replay.startedAt, replay);
    expect([...first.keys()]).toEqual(["note:a"]);
    const both = trailMarks(payload, replay.startedAt + REPLAY_STEP_MS, replay);
    expect([...both.keys()].sort()).toEqual(["note:a", "note:b"]);
  });
});

describe("trailLive", () => {
  it("runs the fade clock only while something glows or has yet to light", () => {
    const payload = trail(event(0));
    expect(trailLive(null, T0)).toBe(false);
    expect(trailLive(payload, T0)).toBe(true);
    expect(trailLive(payload, T0 + TRAIL_FADE_MS)).toBe(false);
    expect(trailLive(payload, T0 + 10 * TRAIL_FADE_MS, { turn: 1, startedAt: T0 + 10 * TRAIL_FADE_MS })).toBe(true);
    expect(trailLive(payload, T0, { turn: 9, startedAt: T0 })).toBe(false);
  });
});

describe("trailTurns", () => {
  it("words each turn's steps newest turn first, with graph labels", () => {
    const payload = trail(
      event(0, { turn: 1, slugs: ["x"] }),
      event(1, { turn: 2, kind: "searched", action: "search", slugs: ["auth", "other"], query: "auth" }),
      event(2, { turn: 2, kind: "read", action: "search", slugs: ["auth"] }),
      event(3, { turn: 2, kind: "wrote", action: "append", slugs: ["auth"] }),
      event(4, { turn: 2, kind: "wrote", action: "finalize", slugs: ["auth"] }),
      event(5, { turn: 2, kind: "wrote", action: "add", slugs: ["fresh"] }),
      event(6, { turn: 2, kind: "wrote", action: "links", slugs: ["a", "b"] }),
      event(7, { turn: 2, kind: "wrote", action: "mystery", slugs: ["m"] }),
      event(8, { turn: 2, kind: "searched", action: "search", slugs: [], query: "none" }),
      event(9, { turn: 2, kind: "searched", action: "search", slugs: ["one"] }),
    );
    const [latest, earlier] = trailTurns(payload, GRAPH);
    expect(latest!.turn).toBe(2);
    expect(latest!.used).toBe(5);
    expect(latest!.time).toMatch(/^\d\d:\d\d$/);
    expect(latest!.steps.map((step) => [step.verb, step.notes.map((note) => note.label), step.detail])).toEqual([
      ['searched "auth"', [], "2 hits"],
      ["read", ["Auth migration"], null],
      ["appended", ["Auth migration"], null],
      ["finalized", ["Auth migration"], null],
      ["created", ["fresh"], null],
      ["fixed links in", ["a", "b"], null],
      ["wrote", ["m"], null],
      ['searched "none"', [], "no hits"],
      ["searched", [], "1 hit"],
    ]);
    expect(latest!.steps[1]!.notes[0]!.id).toBe("note:auth");
    expect(earlier!.turn).toBe(1);
  });

  it("leads with a started turn that has no steps yet, so the last one is not shown as current", () => {
    const payload = { ...trail(event(0, { turn: 1 })), turn: 2 };
    const [current, previous] = trailTurns(payload, null);
    expect(current).toEqual({ turn: 2, time: "", steps: [], used: 0 });
    expect(previous!.turn).toBe(1);
    expect(turnHeading(current!, true)).toBe("This turn");
    expect(TRAIL_EMPTY_TURN).toMatch(/Nothing/);
  });

  it("lists at most a handful of turns and nothing for an empty trail", () => {
    const many = trail(...Array.from({ length: 9 }, (_, i) => event(i, { turn: i + 1 })));
    expect(trailTurns(many, null)).toHaveLength(TRAIL_TURNS_SHOWN);
    expect(trailTurns(trail(), GRAPH)).toEqual([]);
    expect(trailTurns(null, GRAPH)).toEqual([]);
  });

  it("heads the newest turn as This turn and older ones by time", () => {
    const [view] = trailTurns(trail(event(0)), null);
    expect(turnHeading(view!, true)).toBe("This turn");
    expect(turnHeading(view!, false)).toBe(view!.time);
    expect(turnHeading({ ...view!, time: "" }, false)).toBe("Turn 1");
    expect(trailTurns(trail(event(0, { at: "garbage" })), null)[0]!.time).toBe("");
  });
});

describe("trailRowClass", () => {
  it("buckets the glow into three steps per kind", () => {
    expect(trailRowClass(undefined)).toBe("");
    expect(trailRowClass({ kind: "wrote", strength: 0.9 })).toBe(" weave-row-trail weave-row-trail-wrote weave-row-trail-3");
    expect(trailRowClass({ kind: "read", strength: 0.5 })).toBe(" weave-row-trail weave-row-trail-read weave-row-trail-2");
    expect(trailRowClass({ kind: "searched", strength: 0.1 })).toBe(" weave-row-trail weave-row-trail-searched weave-row-trail-1");
  });
});

describe("trailOverride", () => {
  const data = { id: "note:a", x: 0, y: 0, size: 4, label: "A", color: "#888888", kind: "note", provenance: "human", zIndex: 2, type: "circle" } as RenderNode;

  it("blends toward the kind's colour, grows and lifts the node, and keeps its label", () => {
    const wrote = trailOverride({ kind: "wrote", strength: 1 }, data, "dark", "A");
    expect(wrote).toEqual({ color: blendHex("#888888", GRAPH_PALETTE.dark.accent, 1), size: 4 * TRAIL_STYLE.wrote.growth, zIndex: 2 + HIGHLIGHT_Z_LIFT * 3, label: "A" });
    const fading = trailOverride({ kind: "searched", strength: 0.5 }, data, "light", "A");
    expect(fading.color).toBe(blendHex("#888888", GRAPH_PALETTE.light.warning, TRAIL_STYLE.searched.blend * 0.5));
    expect(trailOverride({ kind: "read", strength: 3 }, data, "dark", "A").size).toBe(4 * TRAIL_STYLE.read.growth);
  });

  it("is nothing for no glow or a spent one", () => {
    expect(trailOverride(undefined, data, "dark", "A")).toEqual({});
    expect(trailOverride({ kind: "read", strength: 0 }, data, "dark", "A")).toEqual({});
  });
});

describe("sigmaRenderer.setTrail", () => {
  it("layers the trail over the node reducer and repaints on change", () => {
    let reducer: ((id: string, data: RenderNode) => Record<string, unknown>) | null = null;
    let installs = 0;
    const instance = {
      on: () => instance,
      viewportToGraph: () => ({ x: 0, y: 0 }),
      setSetting: (key: string, value: unknown) => {
        if (key === "nodeReducer") { reducer = value as typeof reducer; installs += 1; }
      },
      setGraph: () => {},
      setCustomBBox: () => {},
      refresh: () => {},
      getCamera: () => ({ animatedReset: async () => {} }),
      kill: () => {},
    } as unknown as SigmaLike;
    const renderer = sigmaRenderer(() => instance, "dark");
    renderer.setTrail(new Map([["note:a", { kind: "wrote", strength: 1 }]]));
    renderer.mount({ clientWidth: 100, clientHeight: 100 });
    const data = { id: "note:a", x: 0, y: 0, size: 4, label: "A", color: "#888888", kind: "note", provenance: "human", zIndex: 2, type: "circle" } as RenderNode;
    expect(reducer!("note:a", data)["size"]).toBe(4 * TRAIL_STYLE.wrote.growth);
    expect(reducer!("note:b", { ...data, id: "note:b" })["size"]).toBe(4);
    // Composes over the selection layer: a receded node glows from its receded state.
    renderer.setHighlight(new Set(["note:b"]), "note:b");
    const receded = reducer!("note:a", data);
    expect(receded["label"]).toBe("A");
    expect(receded["zIndex"]).toBe(0 + HIGHLIGHT_Z_LIFT * 3);
    renderer.setHighlight(null);
    const before = installs;
    renderer.setTrail(new Map());
    expect(installs).toBe(before + 1);
    expect(reducer!("note:a", data)["size"]).toBe(4);
  });
});

describe("isTrailPayload", () => {
  it("accepts the wire shape and rejects anything a link could choke on", () => {
    expect(isTrailPayload(trail(event(0), event(1, { kind: "searched", query: "q", slugs: [] })))).toBe(true);
    expect(isTrailPayload(null)).toBe(false);
    expect(isTrailPayload({ stamp: "s", turn: "1", events: [] })).toBe(false);
    expect(isTrailPayload({ stamp: "s", turn: 1, events: {} })).toBe(false);
    expect(isTrailPayload(trail({ ...event(0), kind: "deleted" as never }))).toBe(false);
    expect(isTrailPayload(trail({ ...event(0), slugs: [1] as never }))).toBe(false);
    expect(isTrailPayload(trail({ ...event(0), query: 7 as never }))).toBe(false);
    expect(isTrailPayload(trail({ ...event(0), seq: "1" as never }))).toBe(false);
  });
});

function respond(status: number, body: unknown): HttpResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("fetchTrail", () => {
  it("revalidates on the held stamp and hands the held payload back on a 304", async () => {
    const held = trail(event(0));
    const seen: Array<Record<string, string> | undefined> = [];
    const fetch: FetchLike = async (_url, init) => { seen.push(init?.headers); return respond(304, null); };
    const result = await fetchTrail(fetch, held);
    expect(result).toEqual({ ok: true, data: held, cached: true });
    expect(seen).toEqual([{ "if-none-match": '"s1"' }]);
    const shape = await fetchTrail(async () => respond(200, { nope: true }));
    expect(shape.ok).toBe(false);
  });
});

describe("startTrailPoll", () => {
  it("reports fresh payloads only, keeps polling past failures, and stops", async () => {
    const first = trail(event(0));
    const replies: HttpResponse[] = [respond(200, first), respond(304, null), respond(500, null), respond(200, trail(event(0), event(1)))];
    const urls: string[] = [];
    const fetch: FetchLike = async (url) => { urls.push(url); return replies.shift() ?? respond(304, null); };
    const seen: TrailPayload[] = [];
    let tick: (() => void) | undefined;
    let cancelled = false;
    const stop = startTrailPoll({ fetch, onTrail: (next) => seen.push(next), repeat: (fn, ms) => { expect(ms).toBe(POLL_MS); tick = fn; return () => { cancelled = true; }; } });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    await settle();
    for (let i = 0; i < 3; i += 1) { tick?.(); await settle(); }
    expect(urls).toEqual(["/api/trail", "/api/trail", "/api/trail", "/api/trail"]);
    expect(seen.map((payload) => payload.events.length)).toEqual([1, 2]);
    stop();
    expect(cancelled).toBe(true);
    tick?.();
    await settle();
    expect(urls).toHaveLength(4);
  });

  it("ignores an overlapping tick and a reply that lands after stop", async () => {
    let release: (() => void) | undefined;
    let calls = 0;
    const fetch: FetchLike = () => { calls += 1; return new Promise((resolve) => { release = () => resolve(respond(200, trail(event(0)))); }); };
    const seen: TrailPayload[] = [];
    let tick: (() => void) | undefined;
    const stop = startTrailPoll({ fetch, onTrail: (next) => seen.push(next), repeat: (fn) => { tick = fn; return () => {}; } });
    tick?.();
    expect(calls).toBe(1);
    stop();
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual([]);
  });

  it("uses a real interval when none is injected", () => {
    const stop = startTrailPoll({ fetch: async () => respond(304, null), onTrail: () => {} });
    stop();
  });
});
