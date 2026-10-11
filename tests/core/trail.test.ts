import { afterEach, describe, expect, it } from "vitest";
import { executeNoteAction, trailSteps } from "../../src/core/noteAction";
import { RecallTrail, recallTrail, TRAIL_CAPACITY, TURN_GAP_MS } from "../../src/core/trail";
import { addNote } from "../../src/core/vault";
import { makeTempDir } from "../helpers";

const T0 = new Date("2026-10-11T05:00:00Z");
const at = (ms: number): Date => new Date(T0.getTime() + ms);

describe("RecallTrail", () => {
  it("numbers events and stamps the buffer so a reader can revalidate", () => {
    const trail = new RecallTrail();
    expect(trail.snapshot()).toEqual({ stamp: "0.0", turn: 0, events: [] });
    trail.record({ kind: "read", action: "get", slugs: ["a", "a"], vault: "/v", at: T0 });
    trail.record({ kind: "searched", action: "search", slugs: [], query: "x", vault: "/v", at: at(1) });
    const snapshot = trail.snapshot();
    expect(snapshot.stamp).toBe("1.2");
    expect(snapshot.events).toEqual([
      { seq: 1, turn: 1, at: T0.toISOString(), kind: "read", action: "get", slugs: ["a"], vault: "/v" },
      { seq: 2, turn: 1, at: at(1).toISOString(), kind: "searched", action: "search", slugs: [], query: "x", vault: "/v" },
    ]);
    // The snapshot is a copy: mutating it leaves the buffer alone.
    snapshot.events[0]!.slugs.push("z");
    expect(trail.snapshot().events[0]!.slugs).toEqual(["a"]);
  });

  it("splits turns on a quiet gap until a harness marks turns itself", () => {
    const trail = new RecallTrail(TRAIL_CAPACITY, 1_000);
    trail.record({ kind: "read", action: "get", slugs: ["a"], vault: "/v", at: T0 });
    trail.record({ kind: "read", action: "get", slugs: ["b"], vault: "/v", at: at(500) });
    trail.record({ kind: "read", action: "get", slugs: ["c"], vault: "/v", at: at(5_000) });
    expect(trail.snapshot().events.map((event) => event.turn)).toEqual([1, 1, 2]);

    trail.beginTurn();
    trail.record({ kind: "read", action: "get", slugs: ["d"], vault: "/v", at: at(60_000) });
    // Explicit turns turn the gap rule off: a long pause inside one turn stays one turn.
    trail.record({ kind: "read", action: "get", slugs: ["e"], vault: "/v", at: at(600_000) });
    expect(trail.snapshot().events.map((event) => event.turn)).toEqual([1, 1, 2, 3, 3]);
  });

  it("starts turn one on the first record even when turns are explicit", () => {
    const trail = new RecallTrail();
    trail.beginTurn();
    trail.clear();
    trail.record({ kind: "read", action: "get", slugs: ["a"], vault: "/v", at: T0 });
    expect(trail.snapshot().turn).toBe(1);
    expect(TURN_GAP_MS).toBeGreaterThan(0);
  });

  it("drops the oldest events past its capacity", () => {
    const trail = new RecallTrail(3);
    for (let i = 0; i < 5; i += 1) trail.record({ kind: "read", action: "get", slugs: [`n${i}`], vault: "/v", at: at(i) });
    expect(trail.snapshot().events.map((event) => event.slugs[0])).toEqual(["n2", "n3", "n4"]);
  });

  it("counts distinct notes read or written this turn, not search hits", () => {
    const trail = new RecallTrail();
    trail.beginTurn();
    trail.record({ kind: "read", action: "get", slugs: ["old"], vault: "/v", at: T0 });
    trail.beginTurn();
    expect(trail.usedThisTurn()).toBe(0);
    trail.record({ kind: "searched", action: "search", slugs: ["a", "b", "c"], vault: "/v", at: at(1) });
    trail.record({ kind: "read", action: "search", slugs: ["a"], vault: "/v", at: at(2) });
    trail.record({ kind: "wrote", action: "append", slugs: ["a"], vault: "/v", at: at(3) });
    trail.record({ kind: "wrote", action: "add", slugs: ["a"], vault: "/other", at: at(4) });
    expect(trail.usedThisTurn()).toBe(2);
  });
});

describe("executeNoteAction records the trail", () => {
  afterEach(() => recallTrail.clear());

  it("records reads, search hits and writes against the vault they ran on", async () => {
    const vault = await makeTempDir();
    const trail = new RecallTrail();
    const now = () => T0;
    await addNote(vault, { title: "Auth migration", body: "We decided OIDC.", source: "human" });
    await addNote(vault, { title: "Auth notes", body: "misc", source: "agent" });

    await executeNoteAction({ action: "search", query: "auth" }, vault, now, trail);
    await executeNoteAction({ action: "search", query: "auth migration" }, vault, now, trail);
    await executeNoteAction({ action: "search", query: "nothing-matches-this" }, vault, now, trail);
    await executeNoteAction({ action: "get", slug: "auth-migration" }, vault, now, trail);
    await executeNoteAction({ action: "get", slug: "missing" }, vault, now, trail);
    await executeNoteAction({ action: "append", slug: "auth-migration", text: "SAML too." }, vault, now, trail);
    await executeNoteAction({ action: "finalize", slug: "auth-migration", text: "# Auth\n\nOIDC and SAML." }, vault, now, trail);
    await executeNoteAction({ action: "add", title: "Fresh", text: "new" }, vault, now, trail);
    await executeNoteAction({ action: "list" }, vault, now, trail);
    await executeNoteAction({ action: "links" }, vault, now, trail);

    const steps = trail.snapshot().events.map(({ kind, action, slugs, query, vault: where }) => ({ kind, action, slugs, query, where }));
    expect(steps).toEqual([
      { kind: "searched", action: "search", slugs: expect.arrayContaining(["auth-migration", "auth-notes"]), query: "auth", where: vault },
      { kind: "searched", action: "search", slugs: ["auth-migration"], query: "auth migration", where: vault },
      { kind: "read", action: "search", slugs: ["auth-migration"], query: undefined, where: vault },
      { kind: "searched", action: "search", slugs: [], query: "nothing-matches-this", where: vault },
      { kind: "read", action: "get", slugs: ["auth-migration"], query: undefined, where: vault },
      { kind: "wrote", action: "append", slugs: ["auth-migration"], query: undefined, where: vault },
      { kind: "wrote", action: "finalize", slugs: ["auth-migration"], query: undefined, where: vault },
      { kind: "wrote", action: "add", slugs: ["fresh"], query: undefined, where: vault },
    ]);
  });

  it("writes to the process-wide trail by default and to none when told", async () => {
    const vault = await makeTempDir();
    await addNote(vault, { title: "One", body: "x", source: "human" });
    recallTrail.clear();
    await executeNoteAction({ action: "get", slug: "one" }, vault);
    expect(recallTrail.snapshot().events).toHaveLength(1);
    await executeNoteAction({ action: "get", slug: "one" }, vault, () => T0, null);
    expect(recallTrail.snapshot().events).toHaveLength(1);
  });
});

describe("trailSteps", () => {
  it("records repaired notes as writes and ignores dry runs", () => {
    expect(trailSteps({ action: "links", fix: true }, { text: "", details: { notes: ["a", 3, "b"] } })).toEqual([
      { kind: "wrote", action: "links", slugs: ["a", "b"] },
    ]);
    expect(trailSteps({ action: "links" }, { text: "", details: { notes: [] } })).toEqual([]);
    expect(trailSteps({ action: "links" }, { text: "", details: {} })).toEqual([]);
  });

  it("tolerates results without the expected shape", () => {
    expect(trailSteps({ action: "search", query: "q" }, { text: "", details: { hits: [{ summary: null }, {}] } })).toEqual([
      { kind: "searched", action: "search", slugs: [], query: "q" },
    ]);
    expect(trailSteps({ action: "search", query: "q" }, { text: "", details: {} })).toEqual([
      { kind: "searched", action: "search", slugs: [], query: "q" },
    ]);
    expect(trailSteps({ action: "append", slug: "a" }, { text: "", details: { found: false } })).toEqual([]);
    expect(trailSteps({ action: "suggest" }, { text: "", details: {} })).toEqual([]);
  });
});
