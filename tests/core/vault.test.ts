import { promises as fs } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addNote,
  appendToNote,
  ensureVault,
  extractRawTail,
  finalizeNote,
  formatNote,
  formatRawAppend,
  getNote,
  getHtmlArtifact,
  listNotes,
  noteCount,
  parseHtmlArtifact,
  RAW_NOTES_HEADING,
  RAW_TAIL_NOTICE,
  readVault,
  resolveNotePath,
  searchNotes,
  setNoteBody,
  statNotes,
  summarizeNote,
  vaultExists,
} from "../../src/core/vault";
import { makeTempDir } from "../helpers";

let vault: string;
beforeEach(async () => {
  vault = await makeTempDir();
});

describe("ensureVault / vaultExists", () => {
  it("creates the vault layout, idempotently", async () => {
    expect(await vaultExists(vault)).toBe(false);
    await ensureVault(vault);
    expect(await vaultExists(vault)).toBe(true);
    const manifest = JSON.parse(await fs.readFile(join(vault, "okf.json"), "utf8"));
    expect(manifest).toEqual({ okfVersion: 1, scope: "vault" });

    // second run leaves existing manifest alone
    await fs.writeFile(join(vault, "okf.json"), '{"okfVersion":1,"scope":"vault","custom":true}');
    await ensureVault(vault);
    expect(JSON.parse(await fs.readFile(join(vault, "okf.json"), "utf8")).custom).toBe(true);
  });
});

describe("addNote / getNote", () => {
  it("writes a Markdown note with front matter", async () => {
    const note = await addNote(vault, {
      title: "Team conventions",
      body: "We use feature branches.",
      tags: ["team"],
      source: "agent",
      now: new Date("2026-08-22T10:00:00Z"),
    });
    expect(note.slug).toBe("team-conventions");
    expect(note.source).toBe("agent");
    const onDisk = await fs.readFile(join(vault, "notes", "team-conventions.md"), "utf8");
    expect(onDisk).toContain("title: Team conventions");
    expect(onDisk).toContain("We use feature branches.");

    const back = await getNote(vault, "team-conventions");
    expect(back?.title).toBe("Team conventions");
    expect(back?.tags).toEqual(["team"]);
    expect(back?.created).toBe("2026-08-22T10:00:00.000Z");
  });

  it("defaults tags and source", async () => {
    const note = await addNote(vault, { title: "Plain", body: "b" });
    expect(note.tags).toEqual([]);
    expect(note.source).toBe("agent");
  });

  it("falls back to file mtime when created/updated are missing from frontmatter", async () => {
    await ensureVault(vault);
    const rawNote = "---\ntitle: Hand Crafted\n---\nbody text\n";
    await fs.writeFile(join(vault, "notes", "hand-crafted.md"), rawNote);
    const note = await getNote(vault, "hand-crafted");
    expect(note).not.toBeNull();
    expect(note?.updated).not.toBe("");
    expect(note?.created).not.toBe("");
    expect(new Date(note!.updated).getTime()).toBeGreaterThan(0);
  });

  it("uniquifies colliding slugs", async () => {
    const first = await addNote(vault, { title: "Decision", body: "one" });
    const second = await addNote(vault, { title: "Decision", body: "two" });
    const third = await addNote(vault, { title: "Decision", body: "three" });
    expect([first.slug, second.slug, third.slug]).toEqual(["decision", "decision-2", "decision-3"]);
  });

  it("getNote returns null for unknown slugs", async () => {
    expect(await getNote(vault, "nope")).toBeNull();
  });
});

describe("appendToNote", () => {
  it("appends Markdown and bumps updated", async () => {
    const note = await addNote(vault, {
      title: "Ideas",
      body: "First idea.",
      now: new Date("2026-08-22T10:00:00Z"),
    });
    const updated = await appendToNote(vault, note.slug, "Second idea.", new Date("2026-08-23T10:00:00Z"));
    expect(updated?.updated).toBe("2026-08-23T10:00:00.000Z");
    expect(updated?.created).toBe(note.created);
    expect(updated?.body).toContain("First idea.");
    expect(updated?.body).toContain("Second idea.");
    expect(updated?.body.indexOf("First idea.")).toBeLessThan(updated!.body.indexOf("Second idea."));
  });

  it("returns null for unknown slugs", async () => {
    expect(await appendToNote(vault, "ghost", "text")).toBeNull();
  });

  it("raw: true creates a ## Raw tail with a dated fenced block", async () => {
    const note = await addNote(vault, { title: "Dictation", body: "compiled so far" });
    const updated = await appendToNote(
      vault,
      note.slug,
      '"we should do X"',
      new Date(2026, 7, 23, 8, 45, 0),
      { raw: true },
    );
    expect(updated?.body).toContain("compiled so far");
    expect(updated?.body).toContain("---\n\n## Raw\n" + RAW_TAIL_NOTICE);
    expect(updated?.body).toContain("<!-- appended 2026-08-23 08:45 -->\n```\n\"we should do X\"\n```");
    // dictation lands below the compiled body, inside a findable tail
    expect(extractRawTail(updated!.body)).not.toBe("");
    expect(updated!.body.indexOf("compiled so far")).toBeLessThan(updated!.body.indexOf(RAW_NOTES_HEADING));
  });

  it("raw: true appends inside an existing tail and keeps the body above untouched", async () => {
    const note = await addNote(vault, { title: "Dictation", body: "compiled" });
    await appendToNote(vault, note.slug, "one", new Date(2026, 7, 23, 8, 45, 0), { raw: true });
    const second = await appendToNote(vault, note.slug, "two", new Date(2026, 7, 23, 9, 0, 0), { raw: true });
    expect(second?.body).toContain("```\none\n```");
    expect(second?.body).toContain("```\ntwo\n```");
    // still exactly one tail opening, still starting at the compiled body
    expect(second!.body.split(RAW_NOTES_HEADING).length - 1).toBe(1);
    expect(second!.body.startsWith("compiled\n\n---\n\n## Raw")).toBe(true);
    // first block stays above the second (append-only order)
    expect(second!.body.indexOf("```")).toBeLessThan(second!.body.indexOf("<!-- appended 2026-08-23 09:00 -->"));
  });

  it("plain appends stay above an existing raw tail", async () => {
    const note = await addNote(vault, { title: "Dictation", body: "compiled" });
    await appendToNote(vault, note.slug, "verbatim words", new Date(2026, 7, 23, 8, 45, 0), { raw: true });
    const updated = await appendToNote(vault, note.slug, "## New section\n\nEditorial text.", new Date(2026, 7, 23, 9, 0, 0));
    const body = updated!.body;
    expect(body).toContain("Editorial text.");
    // editorial addition sits between the compiled body and the raw tail
    expect(body.indexOf("Editorial text.")).toBeGreaterThan(body.indexOf("compiled"));
    expect(body.indexOf("Editorial text.")).toBeLessThan(body.indexOf(RAW_NOTES_HEADING));
    // the tail survived verbatim at the bottom
    expect(extractRawTail(body)).toContain("verbatim words");
  });

  it("plain appends stay above a tail that fills the whole body", async () => {
    const rawOnly = "---\n\n## Raw\n" + RAW_TAIL_NOTICE + "\n\n```\nverbatim\n```";
    const note = await addNote(vault, { title: "Raw only", body: rawOnly });
    const updated = await appendToNote(vault, note.slug, "structured bit");
    expect(updated?.body.startsWith("structured bit\n\n---\n\n## Raw")).toBe(true);
    expect(extractRawTail(updated!.body)).toBe(rawOnly);
  });
});

describe("formatRawAppend", () => {
  it("formats verbatim text with timestamp and backticks", () => {
    const fixed = new Date(2026, 7, 23, 8, 45, 0); // August 23 2026, 08:45
    const result = formatRawAppend("User input line", fixed);
    expect(result).toBe("<!-- appended 2026-08-23 08:45 -->\n```\nUser input line\n```");
  });

  it("defaults to current date when omitted", () => {
    const result = formatRawAppend("test");
    expect(result).toMatch(/^<!-- appended \d{4}-\d{2}-\d{2} \d{2}:\d{2} -->\n```\ntest\n```$/);
  });

  it("uses a longer fence when the verbatim text contains backticks", () => {
    const fixed = new Date(2026, 7, 23, 8, 45, 0);
    const tripled = formatRawAppend("said ```code``` out loud", fixed);
    expect(tripled).toContain("\n````\nsaid ```code``` out loud\n````");
    const quadrupled = formatRawAppend("has ```` inside", fixed);
    expect(quadrupled).toContain("\n`````\nhas ```` inside\n`````");
  });
});

describe("extractRawTail", () => {
  it("returns the raw tail verbatim when preceded by separator and heading", () => {
    const body = "# Summary\n\nWe decided X.\n\n---\n\n## Raw\n<!-- NEVER edit below this line. Verbatim user input preserved here. -->\n\n```\n\"We should do X.\"\n```";
    expect(extractRawTail(body)).toBe("---\n\n## Raw\n<!-- NEVER edit below this line. Verbatim user input preserved here. -->\n\n```\n\"We should do X.\"\n```");
  });

  it("returns the raw tail when body starts directly with separator or heading", () => {
    const body1 = "---\n\n## Raw\n```\nraw\n```";
    expect(extractRawTail(body1)).toBe("---\n\n## Raw\n```\nraw\n```");

    const body2 = "---\n## Raw\n```\nraw\n```";
    expect(extractRawTail(body2)).toBe("---\n## Raw\n```\nraw\n```");

    const body3 = "text\n---\n## Raw\n```\nraw\n```";
    expect(extractRawTail(body3)).toBe("---\n## Raw\n```\nraw\n```");

    const body4 = "## Raw\n```\nraw\n```";
    expect(extractRawTail(body4)).toBe("## Raw\n```\nraw\n```");
  });

  it("exports RAW_NOTES_HEADING as ## Raw", () => {
    expect(RAW_NOTES_HEADING).toBe("## Raw");
  });

  it("returns '' when there is no raw tail", () => {
    expect(extractRawTail("just a body")).toBe("");
  });
});

describe("finalizeNote", () => {
  it("restructures the body above the raw tail and preserves it verbatim", async () => {
    const rawSection = "---\n\n## Raw\n<!-- NEVER edit below this line. Verbatim user input preserved here. -->\n\n```\n\"We should move to OIDC next quarter.\"\n```";
    const note = await addNote(vault, {
      title: "Auth migration",
      body: `# Draft\n\n${rawSection}\n`,
      source: "human",
      now: new Date("2026-08-22T10:00:00Z"),
    });
    const finalized = await finalizeNote(vault, note.slug, {
      body: "# Auth migration\n\n**Decision:** move toward OIDC.\n\n## Questions\n- Token migration strategy",
      now: new Date("2026-08-23T10:00:00Z"),
    });
    expect(finalized?.updated).toBe("2026-08-23T10:00:00.000Z");
    expect(finalized?.created).toBe(note.created);
    expect(finalized?.body).toContain("**Decision:** move toward OIDC.");
    expect(finalized?.body).toContain("## Raw");
    expect(finalized?.body).toContain("<!-- NEVER edit below this line. Verbatim user input preserved here. -->");
    expect(finalized?.body).toContain("\"We should move to OIDC next quarter.\"");
    // the raw tail sits at the end, after the restructured body
    expect(finalized!.body.indexOf("**Decision:**")).toBeLessThan(finalized!.body.indexOf("## Raw"));
  });

  it("finalizing a note with no raw tail preserves the whole body as a new raw tail", async () => {
    const note = await addNote(vault, { title: "Plain", body: "old dictated body" });
    const finalized = await finalizeNote(vault, note.slug, { body: "new body" });
    expect(finalized?.body).toContain("new body");
    expect(finalized?.body).toContain("## Raw");
    expect(finalized?.body).toContain(RAW_TAIL_NOTICE);
    // nothing is lost: the pre-finalize body survives verbatim below
    expect(finalized?.body).toContain("old dictated body");
    expect(finalized!.body.indexOf("new body")).toBeLessThan(finalized!.body.indexOf("## Raw"));
    // the new tail is a real tail: a second finalize keeps it untouched
    const again = await finalizeNote(vault, note.slug, { body: "newer body" });
    expect(again?.body).toContain("newer body");
    expect(extractRawTail(again!.body)).toBe(extractRawTail(finalized!.body));
  });

  it("finalizing an empty-body note creates no tail", async () => {
    const note = await addNote(vault, { title: "Empty", body: "" });
    const finalized = await finalizeNote(vault, note.slug, { body: "structured" });
    expect(finalized?.body).toBe("structured");
    expect(finalized?.body).not.toContain("## Raw");
  });

  it("returns null for unknown or unsafe slugs", async () => {
    expect(await finalizeNote(vault, "ghost", { body: "x" })).toBeNull();
    expect(await finalizeNote(vault, "../escape", { body: "x" })).toBeNull();
  });
});

/**
 * The browser editor's write path. The claim is not "the body changed" but
 * that **nothing else** did — the Obsidian case is the real test, since every
 * line of it is one the engine's front-matter subset cannot represent.
 */
describe("setNoteBody", () => {
  it("replaces the body and moves only `updated`", async () => {
    const note = await addNote(vault, {
      title: "Auth decision",
      body: "first draft",
      tags: ["auth", "adr"],
      source: "human",
      now: new Date("2026-08-20T10:00:00Z"),
    });
    const result = await setNoteBody(vault, note.slug, "second draft", new Date("2026-08-21T10:00:00Z"));
    expect(result).toEqual({ ok: true, slug: note.slug });

    const saved = await getNote(vault, note.slug);
    expect(saved?.body).toBe("second draft");
    expect(saved?.updated).toBe("2026-08-21T10:00:00.000Z");
    // Everything an edit is not entitled to touch.
    expect(saved?.created).toBe(note.created);
    expect(saved?.title).toBe("Auth decision");
    expect(saved?.tags).toEqual(["auth", "adr"]);
    expect(saved?.source).toBe("human");
  });

  it("leaves an Obsidian-shaped front-matter block byte-identical except `updated`", async () => {
    // Written by hand rather than through addNote: the point is a block this
    // engine cannot author, arriving from Obsidian and leaving unharmed.
    const frontMatter = [
      "---",
      "title: Imported",
      "created: 2026-08-20T10:00:00.000Z",
      "updated: 2026-08-20T10:00:00.000Z",
      "aliases: [\"a: b\", 'c, d']",
      "cssclass: wide",
      "# a comment belonging to no key",
      "",
      "tags:",
      "  - auth",
      "  - adr",
      "nested:",
      "  child: value",
      "source: human",
      "---",
    ].join("\n");
    await fs.mkdir(join(vault, "notes"), { recursive: true });
    await fs.writeFile(join(vault, "notes", "imported.md"), `${frontMatter}\n\noriginal body\n`, "utf8");

    const result = await setNoteBody(vault, "imported", "edited body", new Date("2026-08-21T10:00:00Z"));
    expect(result).toEqual({ ok: true, slug: "imported" });

    const text = await fs.readFile(join(vault, "notes", "imported.md"), "utf8");
    // An array equality, not a bag of `toContain`s: a silently reordered block
    // would pass those and is still a diff the user did not make.
    expect(text.split("\n---\n")[0]?.split("\n")).toEqual(
      frontMatter.replace("updated: 2026-08-20T10:00:00.000Z", "updated: 2026-08-21T10:00:00.000Z").split("\n").slice(0, -1),
    );
    expect(text).toContain("edited body");
    expect(text).not.toContain("original body");
  });

  it("re-attaches a `## Raw` tail the editor dropped, and never doubles one it kept", async () => {
    const note = await addNote(vault, { title: "Dictated", body: "summary", source: "human" });
    await appendToNote(vault, note.slug, "spoken words", new Date("2026-08-20T10:00:00Z"), { raw: true });
    const withTail = await getNote(vault, note.slug);
    const tail = extractRawTail(withTail!.body);
    expect(tail).not.toBe("");

    // Dropped: the tail comes back, because it is append-only.
    await setNoteBody(vault, note.slug, "rewritten summary");
    const dropped = await getNote(vault, note.slug);
    expect(dropped?.body).toContain("rewritten summary");
    expect(extractRawTail(dropped!.body)).toBe(tail);

    // Kept: an editor showing the whole file round-trips without a duplicate.
    await setNoteBody(vault, note.slug, dropped!.body);
    const kept = await getNote(vault, note.slug);
    expect(kept?.body.match(/## Raw/g)?.length).toBe(1);
    expect(kept?.body).toContain("spoken words");
  });

  /**
   * The append-only promise, against an editor that can type anything: not
   * "a dropped tail comes back" but "the bytes below the line are the ones
   * the user dictated". Each case claims a tail it does not have.
   */
  describe("the `## Raw` tail is verbatim, not merely present", () => {
    async function dictated(slug: string, words: string): Promise<string> {
      const note = await addNote(vault, { title: slug, body: "summary", source: "human" });
      await appendToNote(vault, note.slug, words, new Date("2026-08-20T10:00:00Z"), { raw: true });
      return note.slug;
    }

    it("refuses edits to the words inside the tail", async () => {
      const slug = await dictated("Quoted", "what the user actually said");
      const body = (await getNote(vault, slug))!.body;
      // The case a "re-attach only when the new body has no tail" rule misses:
      // the tail it sees is the edited one, so it restores nothing.
      await setNoteBody(vault, slug, body.replace("what the user actually said", "A FABRICATED QUOTE"));
      const after = (await getNote(vault, slug))!.body;
      expect(after).toContain("what the user actually said");
      expect(after).not.toContain("A FABRICATED QUOTE");
    });

    it("does not mistake `## Rawhide` for a tail and drop the real one", async () => {
      const slug = await dictated("Heading", "precious words");
      await setNoteBody(vault, slug, "new body\n\n## Rawhide\n\nabout the film");
      const after = (await getNote(vault, slug))!.body;
      expect(after).toContain("precious words");
      expect(after).toContain("## Rawhide");
    });

    it("does not mistake a fenced `## Raw` example for a tail", async () => {
      const slug = await dictated("Fenced", "real dictation");
      // A note documenting the convention: the sample is not the tail.
      await setNoteBody(vault, slug, "how tails look:\n\n```md\n## Raw\nexample\n```");
      const after = (await getNote(vault, slug))!.body;
      expect(after).toContain("real dictation");
      expect(after).toContain("```md");
    });

    it("keeps a tail alone when the editorial body is emptied", async () => {
      const slug = await dictated("Emptied", "still here");
      await setNoteBody(vault, slug, "");
      const after = (await getNote(vault, slug))!.body;
      expect(after).toContain("still here");
      expect(after.startsWith("---")).toBe(true); // no leading blank line
    });

    it("leaves a note that never had a tail alone", async () => {
      const note = await addNote(vault, { title: "Plain", body: "just prose", source: "human" });
      await setNoteBody(vault, note.slug, "replaced entirely");
      expect((await getNote(vault, note.slug))!.body).toBe("replaced entirely");
    });
  });

  it("refuses an unknown slug and never writes outside the notes directory", async () => {
    expect(await setNoteBody(vault, "ghost", "x")).toEqual({ ok: false, reason: "missing" });
    expect(await setNoteBody(vault, "", "x")).toEqual({ ok: false, reason: "invalid" });

    const target = join(vault, "target.md");
    const original = "---\ntitle: Target\nsource: human\n---\n\noriginal body\n";
    await fs.writeFile(target, original, "utf8");
    expect(await setNoteBody(vault, "../target", "injected")).toEqual({ ok: false, reason: "invalid" });
    expect(await fs.readFile(target, "utf8")).toBe(original);
  });
});

describe("listNotes / noteCount", () => {
  it("lists summaries newest-updated first, without bodies", async () => {
    await addNote(vault, { title: "Old", body: "old body", now: new Date("2026-08-20T10:00:00Z") });
    await ensureVault(vault);
    await addNote(vault, { title: "New", body: "new body", now: new Date("2026-08-21T10:00:00Z") });
    const notes = await listNotes(vault);
    expect(notes.map((n) => n.slug)).toEqual(["new", "old"]);
    expect(notes[0]?.bodyLength).toBe(8);
    expect(await noteCount(vault)).toBe(2);
  });

  it("skips malformed note files instead of failing", async () => {
    await addNote(vault, { title: "Good", body: "x" });
    await fs.writeFile(join(vault, "notes", "broken.md"), "no front matter here", "utf8");
    const notes = await listNotes(vault);
    expect(notes.map((n) => n.slug)).toEqual(["good"]);
    // noteCount counts files on disk, listNotes counts parseable notes
    expect(await noteCount(vault)).toBe(2);
  });

  it("returns an empty list for a missing notes dir", async () => {
    expect(await listNotes(join(vault, "nowhere"))).toEqual([]);
  });
});

// One pass over the vault — the primitive that removed the double read
// from buildCurrentGraph (weave-workspace §4.1).
describe("readVault", () => {
  it("returns bodies and the on-disk file count in one pass", async () => {
    await addNote(vault, { title: "Old", body: "old body", now: new Date("2026-08-20T10:00:00Z") });
    await addNote(vault, { title: "New", body: "new body", now: new Date("2026-08-21T10:00:00Z") });

    const snapshot = await readVault(vault);
    expect(snapshot.notes.map((n) => n.slug)).toEqual(["new", "old"]);
    expect(snapshot.notes[0]?.body).toBe("new body");
    expect(snapshot.fileCount).toBe(2);
  });

  it("counts malformed files but omits them from notes", async () => {
    await addNote(vault, { title: "Good", body: "x" });
    await fs.writeFile(join(vault, "notes", "broken.md"), "no front matter here", "utf8");

    const snapshot = await readVault(vault);
    expect(snapshot.notes.map((n) => n.slug)).toEqual(["good"]);
    expect(snapshot.fileCount).toBe(2);
  });

  it("is empty for a missing notes dir", async () => {
    expect(await readVault(join(vault, "nowhere"))).toEqual({ notes: [], fileCount: 0 });
  });

  it("breaks ties on equal timestamps by slug ascending", async () => {
    const at = new Date("2026-08-20T10:00:00Z");
    for (const title of ["Zulu", "Alpha", "Mike"]) {
      await addNote(vault, { title, body: "same instant", now: at });
    }
    expect((await readVault(vault)).notes.map((n) => n.slug)).toEqual(["alpha", "mike", "zulu"]);
  });

  it("agrees with listNotes, which is now derived from it", async () => {
    await addNote(vault, { title: "One", body: "aaa" });
    await addNote(vault, { title: "Two", body: "bbbb" });
    const snapshot = await readVault(vault);
    expect(await listNotes(vault)).toEqual(snapshot.notes.map(summarizeNote));
  });

  it("discovers HTML artifacts and extracts title and description metadata", async () => {
    await ensureVault(vault);
    await fs.mkdir(join(vault, "notes", "reports"), { recursive: true });
    await fs.writeFile(
      join(vault, "notes", "reports", "sprint.html"),
      '<html><head><title>Sprint report</title><meta name="description" content="A summary"></head></html>',
      "utf8",
    );
    const snapshot = await readVault(vault);
    expect(snapshot.fileCount).toBe(0);
    expect(snapshot.artifactCount).toBe(1);
    expect(snapshot.artifacts).toEqual([
      expect.objectContaining({ slug: "reports/sprint.html", title: "Sprint report", description: "A summary" }),
    ]);
    expect(await getHtmlArtifact(vault, "reports/sprint.html")).not.toBeNull();
  });

  it("discovers symlinked notes and folders without following cycles", async () => {
    const linkedVault = await makeTempDir();
    await addNote(linkedVault, { title: "Folder note", body: "inside linked folder" });
    await addNote(linkedVault, { title: "Linked file", body: "linked individually" });
    await ensureVault(vault);
    await fs.symlink(join(linkedVault, "notes"), join(vault, "notes", "linked"));
    await fs.symlink(
      join(linkedVault, "notes", "linked-file.md"),
      join(vault, "notes", "linked-file.md"),
    );
    await fs.symlink(".", join(linkedVault, "notes", "loop"));

    const snapshot = await readVault(vault);
    expect(snapshot.notes.map((note) => note.slug).sort()).toEqual([
      "linked-file",
      "linked/folder-note",
      "linked/linked-file",
    ]);
    expect(snapshot.fileCount).toBe(3);
    expect(snapshot.folders).toEqual(["linked"]);
  });

  it("lets a YAML-in-comment block override HTML metadata", () => {
    const artifact = parseHtmlArtifact(
      "report.htm",
      '<!--\n---\ntitle: Hand-authored\ndescription: Details here\n---\n--><title>Ignored</title>',
    );
    expect(artifact.title).toBe("Hand-authored");
    expect(artifact.description).toBe("Details here");
  });
});

describe("summarizeNote", () => {
  it("drops the body and records its length", async () => {
    const note = await addNote(vault, { title: "Sized", body: "12345", tags: ["t"] });
    const summary = summarizeNote(note);
    expect(summary).toEqual({
      slug: note.slug,
      title: "Sized",
      created: note.created,
      updated: note.updated,
      tags: ["t"],
      source: note.source,
      bodyLength: 5,
    });
    expect("body" in summary).toBe(false);
  });
});

// The stat-only pass behind the WorkspaceCache: change detection with no reads.
describe("statNotes", () => {
  it("returns slug, path, mtime and size per note without parsing", async () => {
    await addNote(vault, { title: "Alpha", body: "a" });
    await addNote(vault, { title: "Beta", body: "b" });

    const stats = await statNotes(vault);
    expect(stats.map((s) => s.slug)).toEqual(["alpha", "beta"]);
    expect(stats[0]?.path).toBe(join(vault, "notes", "alpha.md"));
    expect(stats[0]?.size).toBeGreaterThan(0);
    expect(stats[0]?.mtimeMs).toBeGreaterThan(0);
  });

  it("includes malformed files — it never parses, so it cannot reject them", async () => {
    await addNote(vault, { title: "Good", body: "x" });
    await fs.writeFile(join(vault, "notes", "broken.md"), "no front matter", "utf8");
    expect((await statNotes(vault)).map((s) => s.slug)).toEqual(["broken", "good"]);
  });

  it("is empty for a missing notes dir", async () => {
    expect(await statNotes(join(vault, "nowhere"))).toEqual([]);
  });

  it("reports a larger size after a note grows", async () => {
    await addNote(vault, { title: "Alpha", body: "small" });
    const before = (await statNotes(vault))[0]!;
    await appendToNote(vault, "alpha", "a much longer addition to the body");
    const after = (await statNotes(vault))[0]!;
    expect(after.size).toBeGreaterThan(before.size);
  });

  it("drops entries that vanish between the readdir and the stat", async () => {
    await addNote(vault, { title: "Ghost", body: "x" });
    const realStat = fs.stat;
    // Simulate the delete-mid-pass race the filter exists for.
    (fs as unknown as { stat: unknown }).stat = async (path: string) => {
      if (String(path).endsWith("ghost.md")) throw new Error("ENOENT");
      return (realStat as (p: string) => unknown)(path);
    };
    try {
      expect(await statNotes(vault)).toEqual([]);
    } finally {
      (fs as unknown as { stat: unknown }).stat = realStat;
    }
  });
});

describe("slug safety (untrusted tool input)", () => {
  it("resolves safe slugs (including nested) and rejects traversal/empty ones", () => {
    expect(resolveNotePath(vault, "plain-slug_2")).toBe(join(vault, "notes", "plain-slug_2.md"));
    // Nested slugs are legitimate, but they stay inside notes/.
    expect(resolveNotePath(vault, "sessions/my-session")).toBe(
      join(vault, "notes", "sessions", "my-session.md"),
    );
    expect(resolveNotePath(vault, "../escape")).toBeNull();
    expect(resolveNotePath(vault, "../../deep/escape")).toBeNull();
    expect(resolveNotePath(vault, "sessions/../../escape")).toBeNull();
    expect(resolveNotePath(vault, "..")).toBeNull();
    expect(resolveNotePath(vault, "")).toBeNull();
    expect(resolveNotePath(vault, "   ")).toBeNull();
  });

  it("getNote never reads files outside the notes directory", async () => {
    // A well-formed, note-shaped file living OUTSIDE notes/:
    await fs.writeFile(
      join(vault, "secret.md"),
      "---\ntitle: Secret\nsource: human\n---\n\nnot for the vault\n",
      "utf8",
    );
    expect(await getNote(vault, "../secret")).toBeNull();
  });

  it("appendToNote never writes files outside the notes directory", async () => {
    const target = join(vault, "target.md");
    const original = "---\ntitle: Target\nsource: human\n---\n\noriginal body\n";
    await fs.writeFile(target, original, "utf8");
    expect(await appendToNote(vault, "../target", "injected")).toBeNull();
    expect(await fs.readFile(target, "utf8")).toBe(original);
  });
});

describe("searchNotes", () => {
  beforeEach(async () => {
    await addNote(vault, {
      title: "Auth decision",
      body: "JWT chosen for stateless auth. Auth boundary at the gateway.",
      tags: ["auth"],
      now: new Date("2026-08-20T10:00:00Z"),
    });
    await addNote(vault, {
      title: "Vacation plans",
      body: "Lisbon in autumn.",
      tags: ["personal"],
      now: new Date("2026-08-21T10:00:00Z"),
    });
  });

  it("returns [] for empty queries", async () => {
    expect(await searchNotes(vault, "   ")).toEqual([]);
  });

  it("ranks title matches above body-only matches", async () => {
    const hits = await searchNotes(vault, "auth");
    expect(hits.length).toBe(1);
    expect(hits[0]?.summary.slug).toBe("auth-decision");
    expect(hits[0]?.score).toBeGreaterThan(3); // title + tag + body matches
    expect(hits[0]?.snippet).toContain("JWT");
  });

  it("keeps an exact identity ahead of repeated body mentions", async () => {
    await addNote(vault, { title: "Boats", body: "The primary note." });
    await addNote(vault, { title: "Journal", body: "boats boats boats boats boats" });
    const hits = await searchNotes(vault, "boats");
    expect(hits.map((hit) => hit.summary.slug)).toEqual(["boats", "journal"]);
  });

  it("finds matches by tag", async () => {
    const hits = await searchNotes(vault, "personal");
    expect(hits.map((h) => h.summary.slug)).toEqual(["vacation-plans"]);
  });

  it("finds body matches and builds a windowed snippet", async () => {
    const long = "lorem ipsum dolor sit amet ".repeat(20);
    await addNote(vault, { title: "Longy", body: `${long} needle ${long}` });
    const hits = await searchNotes(vault, "needle");
    expect(hits.length).toBe(1);
    expect(hits[0]?.snippet.startsWith("…")).toBe(true);
    expect(hits[0]?.snippet.endsWith("…")).toBe(true);
    expect(hits[0]?.snippet).toContain("needle");
  });

  it("sorts ties deterministically by slug", async () => {
    await addNote(vault, { title: "b note", body: "same keyword" });
    await addNote(vault, { title: "a note", body: "same keyword" });
    const hits = await searchNotes(vault, "same");
    expect(hits.map((h) => h.summary.slug)).toEqual(["a-note", "b-note"]);
  });

  it("falls back to body prefix snippet when the body has no match (title hit)", async () => {
    const hits = await searchNotes(vault, "vacation");
    expect(hits[0]?.snippet).toBe("Lisbon in autumn.");
  });

  it("returns [] when nothing matches", async () => {
    expect(await searchNotes(vault, "zzz-no-match")).toEqual([]);
  });
});

describe("formatNote", () => {
  it("renders title, metadata, and body", async () => {
    const note = await addNote(vault, { title: "T", body: "body text", tags: ["x"] });
    const text = formatNote(note);
    expect(text).toContain("# T");
    expect(text).toContain("slug: t");
    expect(text).toContain("tags: x");
    expect(text).toContain("source: agent");
    expect(text).toContain("body text");
  });

  it("omits the tags segment for untagged notes", async () => {
    const note = await addNote(vault, { title: "Bare", body: "x" });
    expect(formatNote(note)).not.toContain("tags:");
  });
});
