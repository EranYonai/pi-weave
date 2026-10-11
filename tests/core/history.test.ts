import { promises as fs } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  KEYFRAME_EVERY,
  diffBodies,
  historyEnabled,
  historyPath,
  moveHistory,
  readHistory,
  recordRevision,
  removeHistory,
  setHistoryEnabled,
} from "../../src/core/history";
import {
  addNote,
  appendToNote,
  createFolder,
  deleteFolder,
  deleteNote,
  finalizeNote,
  getNote,
  moveNote,
  renameFolder,
  renameNote,
  setNoteBody,
  upsertNote,
} from "../../src/core/vault";
import { executeNoteAction } from "../../src/core/noteAction";
import { makeTempDir } from "../helpers";

const at = (minute: number): Date => new Date(Date.UTC(2026, 9, 11, 9, minute));
const bodies = async (root: string, slug: string): Promise<string[]> => (await readHistory(root, slug)).map((r) => r.body);

describe("note history", () => {
  it("records every write with who made it, raw and readable sections alike", async () => {
    const root = await makeTempDir();
    const note = await addNote(root, { title: "Standup", body: "", source: "human", now: at(0) });
    await appendToNote(root, note.slug, "Maya says Friday", at(1), { raw: true });
    await appendToNote(root, note.slug, "## Decisions\n- ship Friday", at(2));
    await finalizeNote(root, note.slug, { body: "TLDR: ship Friday", now: at(3) });
    await setNoteBody(root, note.slug, "TLDR: ship Monday", at(4));

    const history = await readHistory(root, note.slug);
    expect(history.map((r) => [r.by, r.op])).toEqual([
      ["human", "create"],
      ["agent", "raw"],
      ["agent", "append"],
      ["agent", "finalize"],
      ["human", "edit"],
    ]);
    expect(history[0]!.body).toBe("");
    expect(history[1]!.body).toContain("Maya says Friday");
    expect(history[3]!.body.startsWith("TLDR: ship Friday")).toBe(true);
    expect(history[4]!.body).toBe((await getNote(root, note.slug))!.body);
    expect(history[4]!.body).toContain("Maya says Friday");
    expect(history.map((r) => r.at)).toEqual([0, 1, 2, 3, 4].map((m) => at(m).toISOString()));
  });

  it("stores appends as small deltas, with a full copy every so often", async () => {
    const root = await makeTempDir();
    const note = await addNote(root, { title: "Long", body: "x".repeat(2000), now: at(0) });
    for (let i = 1; i <= KEYFRAME_EVERY + 1; i++) await appendToNote(root, note.slug, `line ${i}`, at(0), { raw: true });
    const lines = (await fs.readFile(historyPath(root, note.slug)!, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(KEYFRAME_EVERY + 2);
    expect(lines[0].full).toHaveLength(2000);
    expect(JSON.stringify(lines[2]).length).toBeLessThan(200);
    expect(typeof lines[KEYFRAME_EVERY].full).toBe("string");
    expect((await bodies(root, note.slug)).at(-1)).toBe((await getNote(root, note.slug))!.body);
  });

  it("notices edits made outside pi-weave, on the next write and on replay", async () => {
    const root = await makeTempDir();
    const note = await addNote(root, { title: "Outside", body: "one", now: at(0) });
    const file = join(root, "notes", `${note.slug}.md`);
    await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace("one", "two"));
    await appendToNote(root, note.slug, "three", at(5));
    expect((await readHistory(root, note.slug)).map((r) => [r.by, r.op, r.body.trim()])).toEqual([
      ["agent", "create", "one"],
      ["outside", "outside", "two"],
      ["agent", "append", "two\n\nthree"],
    ]);

    const current = { body: "four", at: at(9).toISOString() };
    const replayed = await readHistory(root, note.slug, current);
    expect(replayed.at(-1)).toEqual({ at: current.at, by: "outside", op: "outside", body: "four" });
    // Recorded, so asking again does not add it twice.
    expect(await readHistory(root, note.slug, current)).toHaveLength(4);
    expect(await readHistory(root, note.slug, { body: "four", at: at(1).toISOString() })).toHaveLength(4);
  });

  it("starts from a baseline for notes written before history existed", async () => {
    const root = await makeTempDir();
    await setHistoryEnabled(root, false);
    const note = await addNote(root, { title: "Old", body: "before", now: at(0) });
    await setHistoryEnabled(root, true);
    await setNoteBody(root, note.slug, "after", at(3));
    expect((await readHistory(root, note.slug)).map((r) => [r.op, r.body])).toEqual([
      ["baseline", "before"],
      ["edit", "after"],
    ]);
    const fresh = await addNote(root, { title: "Fresh", body: "x", now: at(0) });
    await removeHistory(root, fresh.slug);
    expect((await readHistory(root, fresh.slug, { body: "x", at: at(0).toISOString() })).map((r) => r.op)).toEqual(["baseline"]);
  });

  it("can be turned off and on, keeping other manifest fields", async () => {
    const root = await makeTempDir();
    expect(await historyEnabled(root)).toBe(true);
    await setHistoryEnabled(root, false);
    expect(await historyEnabled(root)).toBe(false);
    const note = await addNote(root, { title: "Quiet", body: "a" });
    await setNoteBody(root, note.slug, "b");
    expect(await readHistory(root, note.slug)).toEqual([]);
    // Shown, but not recorded, while off.
    expect(await readHistory(root, note.slug, { body: "b", at: at(0).toISOString() })).toHaveLength(1);
    expect(await readHistory(root, note.slug)).toEqual([]);
    await setHistoryEnabled(root, true);
    expect(JSON.parse(await fs.readFile(join(root, "okf.json"), "utf8"))).toEqual({ okfVersion: 1, scope: "vault", history: true });
    await fs.writeFile(join(root, "okf.json"), "[]");
    expect(await historyEnabled(root)).toBe(true);
  });

  it("follows renames and moves, and is dropped with the note", async () => {
    const root = await makeTempDir();
    const note = await addNote(root, { title: "Wander", body: "a", now: at(0) });
    await setNoteBody(root, note.slug, "b", at(1));
    expect(await renameNote(root, note.slug, "Roam")).toEqual({ ok: true, slug: "roam" });
    expect(await bodies(root, "roam")).toEqual(["a", "b"]);
    await createFolder(root, "trips");
    expect(await moveNote(root, "roam", "trips")).toEqual({ ok: true, slug: "trips/roam" });
    expect(await bodies(root, "trips/roam")).toEqual(["a", "b"]);
    expect(await renameFolder(root, "trips", "Journeys")).toEqual({ ok: true, path: "journeys" });
    expect(await bodies(root, "journeys/roam")).toEqual(["a", "b"]);
    expect(await deleteFolder(root, "journeys")).toEqual({ ok: true });
    expect(await readHistory(root, "journeys/roam")).toEqual([]);

    const gone = await addNote(root, { title: "Gone", body: "a" });
    expect(await deleteNote(root, gone.slug)).toEqual({ ok: true });
    expect(await readHistory(root, gone.slug)).toEqual([]);
    // Moving a note with no log is a no-op.
    await moveHistory(root, "nothing", "elsewhere");
  });

  it("records link repairs as system changes and generated notes as agent changes", async () => {
    const root = await makeTempDir();
    await addNote(root, { title: "Target", body: "t", now: at(0) });
    const linker = await addNote(root, { title: "Linker", body: "see [[target]]", now: at(0) });
    await renameNote(root, "target", "Target Note");
    expect((await readHistory(root, linker.slug)).map((r) => [r.by, r.op, r.body])).toEqual([
      ["agent", "create", "see [[target]]"],
      ["system", "repair", "see [[target-note|target]]"],
    ]);

    await upsertNote(root, { slug: "gen", title: "Gen", body: "v1", now: at(0) });
    await upsertNote(root, { slug: "gen", title: "Gen", body: "v2", now: at(1) });
    expect((await readHistory(root, "gen")).map((r) => [r.by, r.op, r.body])).toEqual([
      ["agent", "generate", "v1"],
      ["agent", "generate", "v2"],
    ]);
  });

  it("labels notes the agent creates through weave_note as agent edits", async () => {
    const root = await makeTempDir();
    await executeNoteAction({ action: "add", title: "Dictated", text: "my words", source: "human" }, root);
    expect((await readHistory(root, "dictated")).map((r) => r.by)).toEqual(["agent"]);
  });

  it("skips damaged lines up to the next full copy instead of guessing", async () => {
    const root = await makeTempDir();
    const path = historyPath(root, "n")!;
    await fs.mkdir(join(root, "history"), { recursive: true });
    const meta = { at: at(0).toISOString(), by: "human", op: "edit" };
    await fs.writeFile(
      path,
      [
        JSON.stringify({ ...meta, full: "abc" }),
        JSON.stringify({ ...meta, keep: [3, 0], text: "d" }),
        "not json",
        JSON.stringify({ ...meta, keep: [4, 0], text: "e" }),
        JSON.stringify({ ...meta, full: "xyz" }),
        JSON.stringify({ ...meta, by: "nobody", full: "bad author" }),
        JSON.stringify({ ...meta, keep: [1, 0], text: "q" }),
        JSON.stringify({ ...meta, full: "fine" }),
        JSON.stringify({ ...meta, keep: [9, 9], text: "too long" }),
        JSON.stringify({ ...meta, keep: [1, 1], text: "" }),
        JSON.stringify({ ...meta, full: "end" }),
        JSON.stringify({ ...meta, keep: [1], text: "" }),
        JSON.stringify(null),
        "",
      ].join("\n"),
    );
    expect(await bodies(root, "n")).toEqual(["abc", "abcd", "xyz", "fine", "end"]);
  });

  it("never fails the write that caused it", async () => {
    const root = await makeTempDir();
    await fs.writeFile(join(root, "history"), "a file where the directory should be");
    const note = await addNote(root, { title: "Still saved", body: "ok" });
    expect((await getNote(root, note.slug))!.body).toBe("ok");
    expect(await readHistory(root, note.slug, { body: "ok", at: at(0).toISOString() })).toHaveLength(1);
    await recordRevision(root, "../escape", { by: "human", op: "edit", before: null, after: "x", at: at(0) });
    expect(historyPath(root, "../escape")).toBeNull();
    expect(historyPath(root, " ")).toBeNull();
    expect(await readHistory(root, "../escape")).toEqual([]);
  });

  it("diffs bodies by common prefix and suffix", () => {
    expect(diffBodies("hello world", "hello brave world")).toEqual({ keep: [6, 5], text: "brave " });
    expect(diffBodies("aaa", "aa")).toEqual({ keep: [2, 0], text: "" });
    expect(diffBodies("", "new")).toEqual({ keep: [0, 0], text: "new" });
  });
});
