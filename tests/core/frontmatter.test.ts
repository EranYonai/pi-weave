import { describe, expect, it } from "vitest";
import { parseNoteFile, serializeNote } from "../../src/core/frontmatter";
import type { NoteMeta } from "../../src/core/types";

const baseMeta: NoteMeta = {
  title: "Auth boundary decision",
  created: "2026-08-22T09:00:00.000Z",
  updated: "2026-08-22T09:30:00.000Z",
  tags: ["auth", "security"],
  source: "human",
};

describe("serializeNote", () => {
  it("produces a front matter block followed by the body", () => {
    const text = serializeNote(baseMeta, "Body text here.");
    expect(text).toContain("---\ntitle: Auth boundary decision\ncreated:");
    expect(text).toContain("tags: [auth, security]");
    expect(text).toContain("source: human");
    expect(text.endsWith("Body text here.\n")).toBe(true);
  });

  it("quotes values containing special characters", () => {
    const text = serializeNote({ ...baseMeta, title: "Decisions: [hard] #1" }, "b");
    expect(text).toContain('title: "Decisions: [hard] #1"');
  });

  it("quotes empty titles and trims body trailing whitespace", () => {
    const text = serializeNote({ ...baseMeta, title: "" }, "body\n\n\n");
    expect(text).toContain('title: ""');
    expect(text.endsWith("body\n")).toBe(true);
  });
});

describe("parseNoteFile", () => {
  it("round-trips serialize -> parse", () => {
    const { meta, body } = parseNoteFile(serializeNote(baseMeta, "hello\nworld"));
    expect(meta).toEqual(baseMeta);
    expect(body.trim()).toBe("hello\nworld");
  });

  it("round-trips quoted values", () => {
    const meta: NoteMeta = { ...baseMeta, title: 'He said "hi": now?', tags: ['a"b', "c"] };
    const parsed = parseNoteFile(serializeNote(meta, "x"));
    expect(parsed.meta).toEqual(meta);
  });

  it("throws on missing front matter", () => {
    expect(() => parseNoteFile("# no front matter\nbody")).toThrow(/Missing front matter/);
  });

  it("throws when title is missing", () => {
    expect(() => parseNoteFile("---\ncreated: 2026\n---\nbody")).toThrow(/title/);
  });

  it("tolerates blank and junk lines in front matter", () => {
    const text = "---\n\ntitle: T\nno-colon-here\ncreated: c\nupdated: u\ntags: []\nsource: agent\n---\n\nb";
    const { meta } = parseNoteFile(text);
    expect(meta.title).toBe("T");
    expect(meta.source).toBe("agent");
  });

  it("defaults unknown source values to human", () => {
    const { meta } = parseNoteFile("---\ntitle: T\nsource: robot\n---\nb");
    expect(meta.source).toBe("human");
  });

  it("parses bare-scalar tags as a single tag", () => {
    const { meta } = parseNoteFile("---\ntitle: T\ntags: solo\n---\nb");
    expect(meta.tags).toEqual(["solo"]);
  });

  it("parses empty and missing tags", () => {
    const empty = parseNoteFile("---\ntitle: T\ntags: []\n---\nb");
    expect(empty.meta.tags).toEqual([]);
    const missing = parseNoteFile("---\ntitle: T\n---\nb");
    expect(missing.meta.tags).toEqual([]);
  });

  it("keeps the body verbatim, including --- lines and colons", () => {
    const body = "## heading\n\n---\n\ncode: with: colons";
    const { body: parsed } = parseNoteFile(serializeNote(baseMeta, body));
    expect(parsed.trim()).toBe(body);
  });

  it("handles unquoted values with surrounding whitespace", () => {
    const { meta } = parseNoteFile("---\ntitle:   spaced title  \n---\nb");
    expect(meta.title).toBe("spaced title");
  });
});
