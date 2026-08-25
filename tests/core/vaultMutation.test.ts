/**
 * The note mutation APIs: `updateNote`, `renameNote`, `deleteNote`, and the
 * conflict-detection primitive behind them (weave-workspace §11 P5.2, P5.3).
 *
 * Three things are being pinned here, in rough order of how expensive they
 * are to get wrong:
 *
 * 1. **Unknown front matter survives a real write**, not just a direct
 *    `serialize(parse(x))`. `tests/core/frontmatterRoundTrip.test.ts` proves
 *    the pure functions compose losslessly; that proof is worth nothing if a
 *    vault write path forgets to thread `frontMatter` through. These tests go
 *    through the filesystem for that reason.
 * 2. **Concurrent mutations serialize.** The APIs run under
 *    `withMutationQueue`, so interleaved read-modify-write cycles must not
 *    lose an update.
 * 3. **Conflicts are detected**, so a browser save can be turned into a 409
 *    instead of silently clobbering whatever `$EDITOR` wrote a second ago.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addNote,
  appendToNote,
  deleteNote,
  finalizeNote,
  getNote,
  getNoteWithRevision,
  renameNote,
  updateNote,
} from "../../src/core/vault";
import { makeTempDir } from "../helpers";

let vault: string;
beforeEach(async () => {
  vault = await makeTempDir();
});

/** Write a note file by hand, so the front matter is exactly these bytes. */
async function writeRaw(slug: string, text: string): Promise<void> {
  await fs.mkdir(join(vault, "notes"), { recursive: true });
  await fs.writeFile(join(vault, "notes", `${slug}.md`), text, "utf8");
}

function read(slug: string): Promise<string> {
  return fs.readFile(join(vault, "notes", `${slug}.md`), "utf8");
}

const T1 = new Date("2026-09-01T10:00:00Z");

// ---------------------------------------------------------------------------

describe("unknown front matter survives every write path", () => {
  // The bug §11 P5 gates editing on: these keys used to be deleted by any
  // write. Asserted per *path* rather than once, because each path builds its
  // own `meta` and each is an independent chance to drop the block.
  const withExtras = [
    "---",
    "title: Auth boundary",
    "aliases: [ADR-7, Auth]",
    "created: 2026-08-22T09:00:00.000Z",
    "cssclass: wide-table",
    "updated: 2026-08-22T09:30:00.000Z",
    "publish: true",
    "tags: [auth]",
    "source: human",
    "---",
    "",
    "The decision.",
    "",
  ].join("\n");

  beforeEach(async () => {
    await addNote(vault, { title: "seed", body: "x" }); // ensures the vault layout
    await writeRaw("auth-boundary", withExtras);
  });

  function expectExtrasIntact(text: string): void {
    expect(text).toContain("aliases: [ADR-7, Auth]");
    expect(text).toContain("cssclass: wide-table");
    expect(text).toContain("publish: true");
  }

  it("appendToNote keeps them", async () => {
    await appendToNote(vault, "auth-boundary", "More.", T1);
    const text = await read("auth-boundary");
    expectExtrasIntact(text);
    expect(text).toContain("updated: 2026-09-01T10:00:00.000Z");
    expect(text).toContain("More.");
  });

  it("finalizeNote keeps them", async () => {
    await finalizeNote(vault, "auth-boundary", { body: "# Restructured", now: T1 });
    expectExtrasIntact(await read("auth-boundary"));
  });

  it("updateNote keeps them, for a body change and a metadata change alike", async () => {
    await updateNote(vault, "auth-boundary", { body: "New body." }, T1);
    expectExtrasIntact(await read("auth-boundary"));
    await updateNote(vault, "auth-boundary", { meta: { tags: ["auth", "adr"] } }, T1);
    const text = await read("auth-boundary");
    expectExtrasIntact(text);
    expect(text).toContain("tags: [auth, adr]");
  });

  it("renameNote keeps them, at the new path", async () => {
    const result = await renameNote(vault, "auth-boundary", "Auth Boundary v2", T1);
    expect(result.ok).toBe(true);
    expectExtrasIntact(await read("auth-boundary-v2"));
  });

  it("keeps their position relative to the managed keys", async () => {
    // Preservation that reorders is still a diff the user did not ask for.
    await updateNote(vault, "auth-boundary", { body: "New body." }, T1);
    const text = await read("auth-boundary");
    expect(text.indexOf("aliases:")).toBeLessThan(text.indexOf("created:"));
    expect(text.indexOf("cssclass:")).toBeLessThan(text.indexOf("updated:"));
    expect(text.indexOf("publish:")).toBeLessThan(text.indexOf("tags:"));
  });

  it("does not add created/updated to a note that never had them", async () => {
    await writeRaw("bare", "---\ntitle: Bare\nweight: 3\n---\n\nBody.\n");
    // A metadata-only update does bump `updated` — the caller asked for a
    // change — but `created` stays absent, because nothing sets it.
    await updateNote(vault, "bare", { meta: { tags: ["t"] } }, T1);
    const text = await read("bare");
    expect(text).not.toContain("created:");
    expect(text).toContain("weight: 3");
    expect((await getNote(vault, "bare"))?.created).toBe("");
  });
});

// ---------------------------------------------------------------------------

describe("updateNote", () => {
  beforeEach(async () => {
    await addNote(vault, {
      title: "Ideas",
      body: "Original body.",
      tags: ["a"],
      source: "human",
      now: new Date("2026-08-01T00:00:00Z"),
    });
  });

  it("replaces the body and bumps updated, leaving created alone", async () => {
    const result = await updateNote(vault, "ideas", { body: "Replaced." }, T1);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.note.body).toBe("Replaced.");
    expect(result.note.updated).toBe("2026-09-01T10:00:00.000Z");
    expect(result.note.created).toBe("2026-08-01T00:00:00.000Z");
  });

  it("merges metadata without touching the body", async () => {
    const result = await updateNote(vault, "ideas", { meta: { title: "Better ideas", tags: ["b"] } }, T1);
    expect(result.ok).toBe(true);
    const note = await getNote(vault, "ideas");
    expect(note?.title).toBe("Better ideas");
    expect(note?.tags).toEqual(["b"]);
    expect(note?.source).toBe("human"); // untouched keys keep their value
    expect(note?.body).toBe("Original body.");
  });

  it("bumps updated even for a metadata-only change", async () => {
    const result = await updateNote(vault, "ideas", { meta: { tags: ["c"] } }, T1);
    expect(result.ok && result.note.updated).toBe("2026-09-01T10:00:00.000Z");
  });

  it("prefers an explicit `now` in the input over the argument", async () => {
    const result = await updateNote(vault, "ideas", { body: "x", now: new Date("2027-01-01T00:00:00Z") }, T1);
    expect(result.ok && result.note.updated).toBe("2027-01-01T00:00:00.000Z");
  });

  it("preserves the append-only ## Raw tail when the body is replaced", async () => {
    // docs/notepad.md §4: the raw tail is verbatim user input and must not be
    // deletable by a caller that simply did not include it.
    const tail = "---\n\n## Raw\n```\n\"the user's own words\"\n```";
    await addNote(vault, { title: "Dictated", body: `# Draft\n\n${tail}` });
    const result = await updateNote(vault, "dictated", { body: "# Compiled summary" }, T1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.note.body).toContain("# Compiled summary");
    expect(result.note.body).toContain("\"the user's own words\"");
    expect(result.note.body.indexOf("# Compiled")).toBeLessThan(result.note.body.indexOf("## Raw"));
  });

  it("does not duplicate the tail when the new body already contains one", async () => {
    // The browser editor shows the whole file, so a save round-trips the tail
    // back in. Re-appending it would grow the note on every save.
    const tail = "---\n\n## Raw\n```\nverbatim\n```";
    await addNote(vault, { title: "Dictated", body: `# Draft\n\n${tail}` });
    const result = await updateNote(vault, "dictated", { body: `# Edited\n\n${tail}` }, T1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.note.body.match(/## Raw/g)).toHaveLength(1);
  });

  it("reports missing for an unknown slug", async () => {
    expect(await updateNote(vault, "ghost", { body: "x" })).toEqual({ ok: false, reason: "missing" });
  });

  it("reports missing rather than writing outside the notes directory", async () => {
    const outside = join(vault, "target.md");
    const original = "---\ntitle: Target\n---\n\noriginal\n";
    await fs.writeFile(outside, original, "utf8");
    expect(await updateNote(vault, "../target", { body: "injected" })).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(await fs.readFile(outside, "utf8")).toBe(original);
  });

  it("reports missing when the file is unparseable", async () => {
    await writeRaw("broken", "no front matter at all");
    expect(await updateNote(vault, "broken", { body: "x" })).toEqual({ ok: false, reason: "missing" });
  });
});

// ---------------------------------------------------------------------------

describe("renameNote", () => {
  beforeEach(async () => {
    await addNote(vault, { title: "Old name", body: "Body.", now: new Date("2026-08-01T00:00:00Z") });
  });

  it("moves the file and returns the note under its new slug", async () => {
    const result = await renameNote(vault, "old-name", "new-name", T1);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.note.slug).toBe("new-name");
    expect(result.note.body).toBe("Body.");
    expect(result.note.updated).toBe("2026-09-01T10:00:00.000Z");
    expect(await getNote(vault, "old-name")).toBeNull();
    expect((await getNote(vault, "new-name"))?.body).toBe("Body.");
  });

  it("slugifies the target, so a human title is accepted", async () => {
    const result = await renameNote(vault, "old-name", "A Much Better Name!", T1);
    expect(result.ok && result.note.slug).toBe("a-much-better-name");
  });

  it("refuses a collision instead of overwriting or uniquifying", async () => {
    await addNote(vault, { title: "Taken", body: "do not clobber" });
    expect(await renameNote(vault, "old-name", "taken", T1)).toEqual({
      ok: false,
      reason: "collision",
      slug: "taken",
    });
    // Both files still there, both intact.
    expect((await getNote(vault, "taken"))?.body).toBe("do not clobber");
    expect((await getNote(vault, "old-name"))?.body).toBe("Body.");
  });

  it("is a no-op when the target slug equals the current one", async () => {
    const result = await renameNote(vault, "old-name", "Old name", T1);
    expect(result).toMatchObject({ ok: true });
    // Not a self-collision, and `updated` is untouched: nothing changed.
    expect(result.ok && result.note.updated).toBe("2026-08-01T00:00:00.000Z");
  });

  it("reports missing for an unknown source note", async () => {
    expect(await renameNote(vault, "ghost", "whatever")).toEqual({ ok: false, reason: "missing" });
  });

  it("reports missing for a same-slug rename of a note that does not exist", async () => {
    expect(await renameNote(vault, "ghost", "ghost")).toEqual({ ok: false, reason: "missing" });
  });

  it("refuses to read or move a note outside the notes directory", async () => {
    const outside = join(vault, "secret.md");
    await fs.writeFile(outside, "---\ntitle: Secret\n---\n\nsecret\n", "utf8");
    expect(await renameNote(vault, "../secret", "stolen")).toEqual({ ok: false, reason: "missing" });
    expect(await getNote(vault, "stolen")).toBeNull();
    await expect(fs.readFile(outside, "utf8")).resolves.toContain("secret");
  });

  it("leaves inbound wikilinks pointing at the old slug (dangling, by design)", async () => {
    // The documented decision: a rename does not rewrite other notes' prose.
    // Dangling targets are already surfaced by the graph and rendered as
    // ghosts, so the breakage is visible rather than silently repaired with
    // an untransactional multi-file edit. This test exists so that choice
    // cannot be reversed by accident.
    await addNote(vault, { title: "Referrer", body: "See [[old-name]] for context." });
    await renameNote(vault, "old-name", "new-name", T1);
    const referrer = await getNote(vault, "referrer");
    expect(referrer?.body).toContain("[[old-name]]");
    expect(referrer?.body).not.toContain("[[new-name]]");
  });

  it("preserves the raw tail and body bytes across the move", async () => {
    const tail = "---\n\n## Raw\n```\nverbatim\n```";
    await addNote(vault, { title: "Dictated", body: `# Draft\n\n${tail}` });
    const result = await renameNote(vault, "dictated", "dictation", T1);
    expect(result.ok && result.note.body).toContain("verbatim");
  });
});

// ---------------------------------------------------------------------------

describe("deleteNote", () => {
  it("hard-deletes the file", async () => {
    await addNote(vault, { title: "Doomed", body: "x" });
    expect(await deleteNote(vault, "doomed")).toEqual({ ok: true });
    expect(await getNote(vault, "doomed")).toBeNull();
    await expect(fs.access(join(vault, "notes", "doomed.md"))).rejects.toThrow();
  });

  it("leaves no trash copy behind — the delete is not a move", async () => {
    // Pins the documented semantics: there is no trash concept in the vault,
    // and adding one is a design decision, not an implementation detail.
    await addNote(vault, { title: "Doomed", body: "x" });
    await deleteNote(vault, "doomed");
    expect(await fs.readdir(join(vault, "notes"))).toEqual([]);
  });

  it("reports missing for a note that is not there", async () => {
    await addNote(vault, { title: "Other", body: "x" });
    expect(await deleteNote(vault, "ghost")).toEqual({ ok: false, reason: "missing" });
  });

  it("reports missing rather than deleting outside the notes directory", async () => {
    const outside = join(vault, "secret.md");
    await fs.writeFile(outside, "important", "utf8");
    expect(await deleteNote(vault, "../secret")).toEqual({ ok: false, reason: "missing" });
    await expect(fs.readFile(outside, "utf8")).resolves.toBe("important");
  });

  it("deletes a note it cannot parse", async () => {
    // Unlink does not care about front matter, and a corrupt file is exactly
    // the one a user most wants to be able to remove.
    await addNote(vault, { title: "Seed", body: "x" });
    await writeRaw("broken", "not a note");
    expect(await deleteNote(vault, "broken")).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------

describe("conflict detection (§11 P5.3)", () => {
  beforeEach(async () => {
    await addNote(vault, { title: "Shared", body: "v1", now: new Date("2026-08-01T00:00:00Z") });
  });

  it("getNoteWithRevision returns the note and an opaque stamp", async () => {
    const read = await getNoteWithRevision(vault, "shared");
    expect(read?.note.body).toBe("v1");
    expect(typeof read?.revision).toBe("string");
    expect(read?.revision.length).toBeGreaterThan(0);
  });

  it("returns null for unknown and unsafe slugs", async () => {
    expect(await getNoteWithRevision(vault, "ghost")).toBeNull();
    expect(await getNoteWithRevision(vault, "../escape")).toBeNull();
  });

  it("returns null for a file it cannot parse", async () => {
    await writeRaw("broken", "not a note");
    expect(await getNoteWithRevision(vault, "broken")).toBeNull();
  });

  it("a write with the current revision succeeds", async () => {
    const read = await getNoteWithRevision(vault, "shared");
    const result = await updateNote(vault, "shared", { body: "v2", expectedRevision: read!.revision }, T1);
    expect(result).toMatchObject({ ok: true });
    expect((await getNote(vault, "shared"))?.body).toBe("v2");
  });

  it("a write with a stale revision is refused and reports the current state", async () => {
    const stale = (await getNoteWithRevision(vault, "shared"))!;
    // Somebody else writes — $EDITOR, another tool, a sync client.
    await updateNote(vault, "shared", { body: "written by someone else" }, T1);

    const result = await updateNote(vault, "shared", { body: "v2", expectedRevision: stale.revision }, T1);
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "conflict") throw new Error("expected a conflict");
    // The current note rides along, so a UI can offer reload-or-overwrite
    // without a second round trip. That is what makes this mappable to a 409
    // with a useful body.
    expect(result.current.note.body).toBe("written by someone else");
    expect(result.current.revision).not.toBe(stale.revision);
    // …and the stale content did not land.
    expect((await getNote(vault, "shared"))?.body).toBe("written by someone else");
  });

  it("the revision handed back by a conflict is the one that then succeeds", async () => {
    const stale = (await getNoteWithRevision(vault, "shared"))!;
    await updateNote(vault, "shared", { body: "theirs" }, T1);
    const conflict = await updateNote(vault, "shared", { body: "mine", expectedRevision: stale.revision }, T1);
    if (conflict.ok || conflict.reason !== "conflict") throw new Error("expected a conflict");

    // The reload-then-retry loop a client actually performs.
    const retry = await updateNote(
      vault,
      "shared",
      { body: "merged", expectedRevision: conflict.current.revision },
      T1,
    );
    expect(retry).toMatchObject({ ok: true });
    expect((await getNote(vault, "shared"))?.body).toBe("merged");
  });

  it("omitting the revision is last-write-wins", async () => {
    await updateNote(vault, "shared", { body: "theirs" }, T1);
    const result = await updateNote(vault, "shared", { body: "mine" }, T1);
    expect(result).toMatchObject({ ok: true });
    expect((await getNote(vault, "shared"))?.body).toBe("mine");
  });

  it("a revision for a note that has since been deleted reports missing, not conflict", async () => {
    const read = await getNoteWithRevision(vault, "shared");
    await deleteNote(vault, "shared");
    expect(await updateNote(vault, "shared", { body: "v2", expectedRevision: read!.revision })).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("distinguishes a same-length rewrite", async () => {
    // The stamp includes size *and* mtime; a same-length edit must still be
    // caught, which is the case a size-only stamp would miss.
    const stale = (await getNoteWithRevision(vault, "shared"))!;
    await updateNote(vault, "shared", { body: "v9" }, new Date("2026-09-02T10:00:00Z"));
    const result = await updateNote(vault, "shared", { body: "v3", expectedRevision: stale.revision }, T1);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("concurrent mutations serialize", () => {
  it("does not lose an append when many run at once", async () => {
    // Each append is a read-modify-write. Unqueued, the last writer wins and
    // most of these vanish; queued, all twenty land.
    await addNote(vault, { title: "Log", body: "start" });
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => appendToNote(vault, "log", `line-${i}`, T1)),
    );
    const note = await getNote(vault, "log");
    for (let i = 0; i < 20; i++) expect(note?.body).toContain(`line-${i}`);
  });

  it("does not lose an update when appends and updates interleave", async () => {
    await addNote(vault, { title: "Mixed", body: "start" });
    await Promise.all([
      appendToNote(vault, "mixed", "appended-a", T1),
      updateNote(vault, "mixed", { meta: { tags: ["tagged"] } }, T1),
      appendToNote(vault, "mixed", "appended-b", T1),
    ]);
    const note = await getNote(vault, "mixed");
    expect(note?.body).toContain("appended-a");
    expect(note?.body).toContain("appended-b");
    expect(note?.tags).toEqual(["tagged"]);
  });

  it("gives every concurrent addNote of the same title a distinct slug", async () => {
    // `uniqueSlug` is a check-then-create; without the directory lock two
    // callers can both see `decision.md` as free and one overwrites the other.
    const notes = await Promise.all(
      Array.from({ length: 8 }, () => addNote(vault, { title: "Decision", body: "b" })),
    );
    expect(new Set(notes.map((n) => n.slug)).size).toBe(8);
    expect((await fs.readdir(join(vault, "notes"))).length).toBe(8);
  });

  it("two renames onto the same free slug: exactly one wins", async () => {
    await addNote(vault, { title: "A", body: "a-body" });
    await addNote(vault, { title: "B", body: "b-body" });
    const results = await Promise.all([
      renameNote(vault, "a", "merged", T1),
      renameNote(vault, "b", "merged", T1),
    ]);
    // Serialization is what makes this deterministic in *shape*: the loser
    // sees the file the winner just created. Unqueued, both would pass the
    // existence check and one note would be silently overwritten.
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = results.find((r) => !r.ok)!;
    expect(loser.ok === false && loser.reason).toBe("collision");
    // The loser's note is still on disk under its original name.
    const survivors = await fs.readdir(join(vault, "notes"));
    expect(survivors).toHaveLength(2);
    expect(survivors).toContain("merged.md");
  });

  it("crossing renames deadlock-free: a→b and b→a both terminate", async () => {
    // Each call locks two paths, in opposite logical directions. Acquiring
    // them in a fixed sorted order is what stops the pair taking one lock
    // each and waiting forever — so the assertion that matters most here is
    // simply that this `await` returns.
    await addNote(vault, { title: "A", body: "a-body" });
    await addNote(vault, { title: "B", body: "b-body" });
    const results = await Promise.all([
      renameNote(vault, "a", "b", T1),
      renameNote(vault, "b", "a", T1),
    ]);
    // Both correctly collide: an atomic swap is not something either call
    // can perform, and neither may clobber the other's file to fake one.
    expect(results.every((r) => !r.ok && r.reason === "collision")).toBe(true);
    expect((await getNote(vault, "a"))?.body).toBe("a-body");
    expect((await getNote(vault, "b"))?.body).toBe("b-body");
  });

  it("a delete racing an update leaves no half-written file", async () => {
    await addNote(vault, { title: "Racy", body: "x" });
    const [update, del] = await Promise.all([
      updateNote(vault, "racy", { body: "updated" }, T1),
      deleteNote(vault, "racy"),
    ]);
    // Order is whichever the queue picked, but the outcomes must agree: if
    // the delete ran last the note is gone, otherwise the update failed.
    if (del.ok && update.ok) {
      expect(await getNote(vault, "racy")).toBeNull();
    } else {
      expect(update.ok).toBe(false);
    }
  });
});
