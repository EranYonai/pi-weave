import { promises as fs } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addNote, appendToNote, deleteFolder, deleteNote, getNote, moveNote, renameFolder, renameNote } from "../../src/core/vault";
import { makeTempDir } from "../helpers";

describe("vault mutations", () => {
  it("renames a note and its title without overwriting another note", async () => {
    const root = await makeTempDir();
    const note = await addNote(root, { title: "Old", body: "body", source: "human" });
    await addNote(root, { title: "Taken", body: "other" });

    expect(await renameNote(root, note.slug, "New Name", new Date("2026-01-02"))).toEqual({ ok: true, slug: "new-name" });
    expect(await getNote(root, "old")).toBeNull();
    expect(await getNote(root, "new-name")).toMatchObject({ title: "New Name", body: "body", source: "human" });
    expect(await renameNote(root, "new-name", "New Name")).toEqual({ ok: true, slug: "new-name" });
    expect(await renameNote(root, "new-name", "Taken")).toEqual({ ok: false, reason: "collision" });
    expect(await renameNote(root, "missing", "Name")).toEqual({ ok: false, reason: "missing" });
    expect(await renameNote(root, "../escape", "Name")).toEqual({ ok: false, reason: "invalid" });
    expect(await renameNote(root, "new-name", " ")).toEqual({ ok: false, reason: "invalid" });
  });

  it("moves and deletes notes within the vault", async () => {
    const root = await makeTempDir();
    const note = await addNote(root, { title: "Move Me", body: "body" });
    await fs.mkdir(join(root, "notes", "archive"));

    expect(await moveNote(root, note.slug, "archive")).toEqual({ ok: true, slug: "archive/move-me" });
    expect(await moveNote(root, "archive/move-me", "archive")).toEqual({ ok: true, slug: "archive/move-me" });
    expect(await moveNote(root, "archive/move-me", null)).toEqual({ ok: true, slug: "move-me" });
    expect(await moveNote(root, "move-me", "missing")).toEqual({ ok: false, reason: "missing" });
    expect(await moveNote(root, "missing", null)).toEqual({ ok: false, reason: "missing" });
    expect(await moveNote(root, "../escape", null)).toEqual({ ok: false, reason: "invalid" });
    await addNote(root, { title: "Other", body: "" });
    await fs.writeFile(join(root, "notes", "archive", "other.md"), "occupied");
    expect(await moveNote(root, "other", "archive")).toEqual({ ok: false, reason: "collision" });
    expect(await deleteNote(root, "move-me")).toEqual({ ok: true });
    expect(await deleteNote(root, "move-me")).toEqual({ ok: false, reason: "missing" });
    expect(await deleteNote(root, "../escape")).toEqual({ ok: false, reason: "invalid" });
  });

  it("renames and recursively deletes folders within the vault", async () => {
    const root = await makeTempDir();
    await addNote(root, { title: "Seed", body: "" });
    await fs.mkdir(join(root, "notes", "work", "nested"), { recursive: true });
    await fs.writeFile(join(root, "notes", "work", "nested", "note.md"), "body");

    expect(await renameFolder(root, "work", "Done Work")).toEqual({ ok: true, path: "done-work" });
    expect(await renameFolder(root, "done-work", "Done Work")).toEqual({ ok: true, path: "done-work" });
    await fs.mkdir(join(root, "notes", "taken"));
    expect(await renameFolder(root, "done-work", "taken")).toEqual({ ok: false, reason: "collision" });
    expect(await renameFolder(root, "missing", "new")).toEqual({ ok: false, reason: "missing" });
    expect(await renameFolder(root, "../escape", "new")).toEqual({ ok: false, reason: "invalid" });
    expect(await renameFolder(root, "done-work", " ")).toEqual({ ok: false, reason: "invalid" });
    expect(await deleteFolder(root, "done-work")).toEqual({ ok: true });
    expect(await deleteFolder(root, "done-work")).toEqual({ ok: false, reason: "missing" });
    expect(await deleteFolder(root, "../escape")).toEqual({ ok: false, reason: "invalid" });
  });

  it("serializes folder mutations with descendant note writes", async () => {
    const root = await makeTempDir();
    const note = await addNote(root, { title: "Note", body: "before" });
    await fs.mkdir(join(root, "notes", "work"));
    await moveNote(root, note.slug, "work");

    await Promise.all([
      appendToNote(root, "work/note", "after"),
      renameFolder(root, "work", "done"),
    ]);

    expect(await getNote(root, "work/note")).toBeNull();
    expect((await getNote(root, "done/note"))?.body).toContain("after");

    await Promise.all([
      appendToNote(root, "done/note", "last"),
      deleteFolder(root, "done"),
    ]);
    expect(await getNote(root, "done/note")).toBeNull();
  });
});
