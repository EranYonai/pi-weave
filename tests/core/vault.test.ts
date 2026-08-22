import { promises as fs } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addNote,
  appendToNote,
  ensureVault,
  formatNote,
  getNote,
  listNotes,
  noteCount,
  searchNotes,
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
