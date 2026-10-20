import { promises as fs } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addNote, appendToNote, createFolder, deleteFolder, deleteNote, getNote, moveHtmlArtifact, moveNote, renameFolder, renameNote, upsertNote } from "../../src/core/vault";
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

  it("moves HTML artifacts between vault folders and repoints links to them", async () => {
    const root = await makeTempDir();
    await fs.mkdir(join(root, "notes", "archive"), { recursive: true });
    await fs.writeFile(join(root, "notes", "report.html"), "<title>Report</title>");
    const linker = await addNote(root, { title: "Linker", body: "See [[report.html]]." });

    expect(await moveHtmlArtifact(root, "report.html", "archive")).toEqual({ ok: true, slug: "archive/report.html" });
    expect(await fs.readFile(join(root, "notes", "archive", "report.html"), "utf8")).toBe("<title>Report</title>");
    // The link keeps the words it showed, as a moved note's backlinks do.
    expect((await getNote(root, linker.slug))?.body).toBe("See [[archive/report.html|report.html]].");
    expect(await moveHtmlArtifact(root, "archive/report.html", "archive")).toEqual({ ok: true, slug: "archive/report.html" });
    expect(await moveHtmlArtifact(root, "archive/report.html", null)).toEqual({ ok: true, slug: "report.html" });
    expect((await getNote(root, linker.slug))?.body).toMatch(/^See \[\[report\.html[|\]]/);

    expect(await moveHtmlArtifact(root, "report.html", "missing")).toEqual({ ok: false, reason: "missing" });
    expect(await moveHtmlArtifact(root, "report.html", "../out")).toEqual({ ok: false, reason: "missing" });
    expect(await moveHtmlArtifact(root, "gone.html", null)).toEqual({ ok: false, reason: "missing" });
    expect(await moveHtmlArtifact(root, "../escape.html", null)).toEqual({ ok: false, reason: "invalid" });
    expect(await moveHtmlArtifact(root, "linker", null)).toEqual({ ok: false, reason: "invalid" });
    await fs.writeFile(join(root, "notes", "archive", "report.html"), "occupied");
    expect(await moveHtmlArtifact(root, "report.html", "archive")).toEqual({ ok: false, reason: "collision" });
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

  it("keeps the raw tail even when generated content mentions the heading", async () => {
    // `## Raw` is append-only, verbatim human input. The replacement body here
    // is model output, so a summary that merely *discusses* the raw-tail format
    // must not be mistaken for one and delete the user's words.
    const root = await makeTempDir();
    await upsertNote(root, { slug: "sessions/s", title: "S", body: "first", fields: { session_id: "sid-1" } });
    await appendToNote(root, "sessions/s", "spoken words", new Date(), { raw: true });

    await upsertNote(root, {
      slug: "sessions/s",
      title: "S",
      body: "The session documented the ## Raw tail format.",
      fields: { session_id: "sid-1" },
    });

    const note = await getNote(root, "sessions/s");
    expect(note?.body).toContain("spoken words");
    expect(note?.body).toContain("NEVER edit below this line");
  });

  it("updates a generated note in place when its identity needs quoting", async () => {
    // `quoteField` quotes any value containing `:` — an ISO-timestamp id, say.
    // Comparing a quoted stored value against a raw one never matches, which
    // would fork `-2`, `-3`… on every rescan instead of updating in place.
    const root = await makeTempDir();
    const identity = { field: "session_id", value: "2026-01-01T00:00:00Z" };
    const first = await upsertNote(root, {
      slug: "sessions/s",
      title: "S",
      body: "one",
      fields: { session_id: identity.value },
      identity,
    });
    const second = await upsertNote(root, {
      slug: "sessions/s",
      title: "S",
      body: "two",
      fields: { session_id: identity.value },
      identity,
    });

    expect(second.slug).toBe(first.slug);
    expect(await fs.readdir(join(root, "notes", "sessions"))).toEqual(["s.md"]);
    expect((await getNote(root, "sessions/s"))?.body).toContain("two");
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

  it("creates new folders and rejects invalid paths or collisions", async () => {
    const root = await makeTempDir();
    await addNote(root, { title: "Seed", body: "" });

    expect(await createFolder(root, "New Folder")).toEqual({ ok: true, path: "new-folder" });
    expect(await createFolder(root, "new-folder")).toEqual({ ok: false, reason: "collision" });
    expect(await createFolder(root, "new-folder/sub")).toEqual({ ok: true, path: "new-folder/sub" });
    expect(await createFolder(root, "   ")).toEqual({ ok: false, reason: "invalid" });
    expect(await createFolder(root, "../escape")).toEqual({ ok: false, reason: "invalid" });
  });
});
