/**
 * L2 — generated-note upsert (vault.ts) and front-matter field upsert
 * (frontmatter.ts): the write path behind `/weave-scan sessions`.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { upsertFrontMatterFields } from "../../src/core/frontmatter";
import { getNote, upsertNote } from "../../src/core/vault";
import { makeTempDir } from "../helpers";

describe("upsertFrontMatterFields", () => {
  it("replaces the first occurrence in place, collapses duplicates, appends missing", () => {
    const out = upsertFrontMatterFields(
      ["title: Keep", "session_hash: old", "custom: keep me", "session_hash: older"],
      { session_hash: "fresh", session_id: "xyz" },
    );
    expect(out).toEqual(["title: Keep", "session_hash: fresh", "custom: keep me", "session_id: xyz"]);
  });

  it("carries unknown and junk lines byte-identically", () => {
    const lines = ["title: T", "", "# a comment", "weird line without colon", "tags: [a, b]"];
    const out = upsertFrontMatterFields(lines, { marker: "v" });
    expect(out).toEqual([...lines, "marker: v"]);
  });

  it("replaces a block-construct line and swallows only its indented children", () => {
    const lines = ["session_hash:", "  - indented", "  - list", "title: After"];
    const out = upsertFrontMatterFields(lines, { session_hash: "h1" });
    expect(out).toEqual(["session_hash: h1", "title: After"]);
  });
});

describe("upsertNote", () => {
  const BASE = {
    slug: "generated-note",
    title: "Generated note",
    body: "v1",
    fields: { session_id: "s1", session_hash: "h1" },
  };

  it("creates a note with managed + extra fields and generated provenance", async () => {
    const root = await makeTempDir();
    try {
      const note = await upsertNote(root, { ...BASE, now: new Date("2026-08-23T09:00:00Z") });
      expect(note.slug).toBe("generated-note");
      expect(note.source).toBe("generated");
      expect(note.created).toBe("2026-08-23T09:00:00.000Z");
      const raw = await fs.readFile(join(root, "notes", "generated-note.md"), "utf8");
      expect(raw).toBe(
        [
          "---",
          "title: Generated note",
          "created: 2026-08-23T09:00:00.000Z",
          "updated: 2026-08-23T09:00:00.000Z",
          "tags: []",
          "source: generated",
          "session_id: s1",
          "session_hash: h1",
          "---",
          "",
          "v1",
          "",
        ].join("\n"),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("drops unsafe/managed field keys on write", async () => {
    const root = await makeTempDir();
    try {
      const note = await upsertNote(root, {
        ...BASE,
        fields: { session_id: "s1", title: "hacked", "bad key!": "v", ok_key: "v" },
      });
      const raw = await fs.readFile(join(root, "notes", "generated-note.md"), "utf8");
      expect(note.title).toBe("Generated note"); // managed keys stay note-engine-owned
      expect(raw).not.toContain("hacked");
      expect(raw).not.toContain("bad key!");
      expect(raw).toContain("ok_key: v");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("without an identity guard, an existing note at the slug is updated (last-write-wins)", async () => {
    const root = await makeTempDir();
    try {
      await fs.mkdir(join(root, "notes"), { recursive: true });
      await fs.writeFile(join(root, "notes", "generated-note.md"), "---\ntitle: Human one\n---\n\nhuman\n", "utf8");
      const note = await upsertNote(root, BASE);
      expect(note.slug).toBe("generated-note");
      expect(note.body).toBe("v1");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("identity guard: skips slugs occupied by a different identity, claims same identity", async () => {
    const root = await makeTempDir();
    try {
      await upsertNote(root, { ...BASE, fields: { session_id: "other-session" } });
      const note = await upsertNote(root, {
        ...BASE,
        identity: { field: "session_id", value: "s1" },
      });
      // "other-session" occupies the base slug; ours lands at -2
      expect(note.slug).toBe("generated-note-2");

      // A re-scan whose marker lookup resolved to the SAME slug updates in place.
      const again = await upsertNote(root, {
        ...BASE,
        slug: "generated-note-2",
        body: "v2",
        identity: { field: "session_id", value: "s1" },
      });
      expect(again.slug).toBe("generated-note-2");
      expect((await getNote(root, "generated-note-2"))!.body).toBe("v2");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("identity guard: never claims a slug occupied by an unmarked (human) note", async () => {
    const root = await makeTempDir();
    try {
      await fs.mkdir(join(root, "notes"), { recursive: true });
      await fs.writeFile(join(root, "notes", "clash.md"), "---\ntitle: Human\n---\n\nmine\n", "utf8");
      const note = await upsertNote(root, {
        ...BASE,
        slug: "clash",
        identity: { field: "session_id", value: "s1" },
      });
      expect(note.slug).toBe("clash-2");
      expect((await getNote(root, "clash"))!.body).toBe("mine");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("updates in place: body and fields refresh, title/created/unknown keys survive, raw tail preserved", async () => {
    const root = await makeTempDir();
    try {
      await upsertNote(root, { ...BASE, now: new Date("2026-08-23T09:00:00Z") });
      // human edits: retitle + unknown key + raw tail + body scribble
      const path = join(root, "notes", "generated-note.md");
      let raw = await fs.readFile(path, "utf8");
      raw = raw.replace("title: Generated note", "title: Renamed by human\nobsidian-thing: yes");
      raw = raw.replace("v1", "human words");
      raw += "\n## Raw\n<!-- NEVER edit below this line. -->\n\n```\nscribble\n```\n";
      await fs.writeFile(path, raw, "utf8");

      const updated = await upsertNote(root, {
        ...BASE,
        body: "v2",
        fields: { session_id: "s1", session_hash: "h2" },
        now: new Date("2026-08-23T11:00:00Z"),
      });
      expect(updated.slug).toBe("generated-note");
      expect(updated.title).toBe("Renamed by human"); // human title kept
      expect(updated.created).toBe("2026-08-23T09:00:00.000Z"); // creation kept
      expect(updated.updated).toBe("2026-08-23T11:00:00.000Z"); // bumped

      const after = await fs.readFile(path, "utf8");
      expect(after).toContain("title: Renamed by human");
      expect(after).toContain("obsidian-thing: yes");
      expect(after).toContain("session_hash: h2"); // upserted in place
      expect(after).toContain("session_id: s1");
      expect(after).toContain("NEVER edit below this line");
      expect(after).toContain("scribble");
      expect(after).toContain("v2"); // body replaced above the tail
      expect(after).not.toContain("human words"); // editorial body replaced
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});