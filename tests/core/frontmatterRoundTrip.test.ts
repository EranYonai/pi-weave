/**
 * The front-matter round-trip property (weave-workspace §11 P5.1, §16).
 *
 * ## What is being defended
 *
 * A vault note is a file a human also edits, in an editor pi-weave did not
 * write. Real notes therefore carry front-matter keys the engine has never
 * heard of — Obsidian's `aliases`, `cssclass`, `publish`, a `date` some
 * template inserted. `parseNoteFile` reads five keys and, before this suite
 * existed, `serializeNote` wrote five keys, so **every** write through core
 * deleted the rest. Appending one line to a note destroyed its metadata.
 *
 * §11 P5 gates the browser editor on fixing that, and §16 says "do not start
 * at the textarea" — because an editor over a lossy round-trip is a data-loss
 * bug on a keyboard shortcut. This file is the gate.
 *
 * ## Why a property test and not more examples
 *
 * The failure mode is *unknown* keys, and an example test can only enumerate
 * keys someone thought of. The property is stated over generated inputs so
 * the assertion is about the shape of the transformation rather than about a
 * list of field names:
 *
 * 1. **Idempotence** — `parse(serialize(parse(x))) ≡ parse(x)`. One write
 *    cycle is a fixed point, so no amount of reading and rewriting a note
 *    drifts its metadata.
 * 2. **Byte-identity of what we do not own** — every line that is not one of
 *    the five managed keys comes back as the exact bytes it went in as.
 * 3. **Order preservation** — the sequence of keys in the block is unchanged.
 *
 * The generator is a small deterministic LCG rather than a fuzzing library:
 * no new dependency (AGENTS.md), and a seeded failure is reproducible by
 * rerunning the suite rather than by copying a counterexample out of a log.
 */

import { describe, expect, it } from "vitest";
import {
  MANAGED_FRONT_MATTER_KEYS,
  parseNoteFile,
  scanFrontMatter,
  serializeNote,
} from "../../src/core/frontmatter";

// --- a deterministic generator ------------------------------------------------

/** Numerical Recipes LCG: reproducible, dependency-free, good enough to shuffle. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function pick<T>(next: () => number, xs: readonly T[]): T {
  return xs[Math.floor(next() * xs.length)]!;
}

/**
 * Front-matter lines a real vault produces, deliberately including the ones
 * this subset cannot represent.
 *
 * The interesting entries are the last few. A block list, a nested map and a
 * folded scalar are all *unparseable* here — and a value the writer cannot
 * re-render is precisely the value a naive serializer mangles instead of
 * dropping cleanly, which is the more damaging half of the bug.
 */
const UNKNOWN_LINES: readonly string[] = [
  "aliases: [Auth Boundary, ADR-7]",
  "cssclass: wide-table",
  "publish: true",
  "date: 2026-03-04",
  "weight: 12",
  "author: Eran Yonai",
  "obsidianUIMode: preview",
  "banner: attachments/hero.png",
  'description: "A quoted: value, with punctuation"',
  "empty:",
  "", // a blank line inside the block
  "# a YAML comment the parser has no concept of",
  "not a key at all",
  "  indented: continuation",
  "aliases:\n  - Auth Boundary\n  - ADR-7", // block list
  "meta:\n  owner: platform\n  tier: 1", // nested map
  "summary: >\n  folded scalar text\n  continued here", // folded scalar
];

const MANAGED_LINES: readonly string[] = [
  "title: Auth boundary decision",
  'title: "Decisions: [hard] #1"',
  "created: 2026-08-22T09:00:00.000Z",
  "updated: 2026-08-22T09:30:00.000Z",
  "tags: [auth, security]",
  "tags: []",
  "source: human",
  "source: agent",
  "source: generated",
];

const BODIES: readonly string[] = [
  "Plain body.",
  "# Heading\n\nSome text with a [[wikilink]].",
  "Body with a --- separator line\n\nand: a colon",
  "## Raw\n```\nverbatim\n```",
  "",
];

/**
 * Build a random but always-valid note file: a title plus assorted lines.
 *
 * "Valid" excludes a **repeated key**, and deliberately so — YAML forbids
 * duplicate keys in a mapping, so a block with two `title:` lines has no
 * single correct interpretation and cannot be round-tripped by value and by
 * bytes at the same time (collapsing to the winning value changes the line
 * list; keeping both lines leaves a stale one that contradicts the parse).
 * pi-weave collapses, that choice is asserted by name in
 * "collapses a duplicated managed key onto its first position", and stating
 * the property over inputs where the question does not arise keeps it a
 * statement about preservation rather than about conflict resolution.
 */
function generateNote(next: () => number): string {
  const lines: string[] = [];
  const used = new Set<string>(["title"]); // reserved for the injected line
  const count = 1 + Math.floor(next() * 7);
  for (let i = 0; i < count; i++) {
    const line = next() < 0.55 ? pick(next, UNKNOWN_LINES) : pick(next, MANAGED_LINES);
    const key = scanFrontMatter(line.split("\n"))[0]?.key;
    if (key !== null && key !== undefined) {
      if (used.has(key)) continue;
      used.add(key);
    }
    lines.push(line);
  }
  // Exactly one title, at a random position, so `parseNoteFile` never throws
  // and the managed keys are not always in canonical order.
  lines.splice(Math.floor(next() * (lines.length + 1)), 0, "title: Generated note");
  return `---\n${lines.join("\n")}\n---\n\n${pick(next, BODIES)}\n`;
}

// --- the properties -----------------------------------------------------------

const MANAGED = new Set<string>(MANAGED_FRONT_MATTER_KEYS);

/** Re-serialize a parsed note exactly as every vault write path does. */
function rewrite(text: string): string {
  const { meta, body, frontMatter } = parseNoteFile(text);
  return serializeNote(meta, body, frontMatter);
}

/** The lines of a block that this module does not own, with their positions. */
function carriedLines(text: string): string[] {
  const { frontMatter } = parseNoteFile(text);
  return scanFrontMatter(frontMatter)
    .filter((l) => l.key === null || !l.scalar || !MANAGED.has(l.key))
    .map((l) => l.text);
}

/** Every top-level key the block declares, in file order. */
function keyOrder(text: string): string[] {
  const { frontMatter } = parseNoteFile(text);
  const out: string[] = [];
  for (const line of scanFrontMatter(frontMatter)) {
    if (line.key !== null && !out.includes(line.key)) out.push(line.key);
  }
  return out;
}

const CASES = 400;

describe("front-matter round-trip (property)", () => {
  it("parse(serialize(parse(x))) ≡ parse(x) — one write cycle is a fixed point", () => {
    const next = rng(20260826);
    for (let i = 0; i < CASES; i++) {
      const original = generateNote(next);
      const once = rewrite(original);
      // The parse of the rewrite equals the parse of the original…
      expect(parseNoteFile(once), `case ${i}:\n${original}`).toEqual(parseNoteFile(original));
      // …and rewriting again changes nothing at the byte level, which is the
      // stronger statement: no note can drift by being opened repeatedly.
      expect(rewrite(once), `case ${i}:\n${original}`).toBe(once);
    }
  });

  it("unknown fields survive byte-identically", () => {
    const next = rng(777);
    for (let i = 0; i < CASES; i++) {
      const original = generateNote(next);
      expect(carriedLines(rewrite(original)), `case ${i}:\n${original}`).toEqual(carriedLines(original));
    }
  });

  it("key order is preserved", () => {
    const next = rng(31337);
    for (let i = 0; i < CASES; i++) {
      const original = generateNote(next);
      expect(keyOrder(rewrite(original)), `case ${i}:\n${original}`).toEqual(keyOrder(original));
    }
  });

  it("the body survives the cycle unchanged", () => {
    const next = rng(4242);
    for (let i = 0; i < CASES; i++) {
      const original = generateNote(next);
      expect(parseNoteFile(rewrite(original)).body).toBe(parseNoteFile(original).body);
    }
  });
});

// --- the named cases the property is a generalisation of ----------------------
//
// The property above would catch each of these, but only as "case 231 failed"
// with a generated blob attached. These name the behaviours so a regression
// says *what* broke.

describe("front-matter preservation (named cases)", () => {
  const withExtras = [
    "---",
    "title: Auth boundary decision",
    "aliases: [Auth Boundary, ADR-7]",
    "created: 2026-08-22T09:00:00.000Z",
    "cssclass: wide-table",
    "updated: 2026-08-22T09:30:00.000Z",
    "tags: [auth, security]",
    "publish: true",
    "source: human",
    "---",
    "",
    "Body.",
    "",
  ].join("\n");

  it("keeps unknown keys interleaved between managed ones, in place", () => {
    expect(rewrite(withExtras)).toBe(withExtras);
  });

  it("re-renders managed keys from the parsed values, leaving neighbours alone", () => {
    const { meta, body, frontMatter } = parseNoteFile(withExtras);
    const out = serializeNote({ ...meta, updated: "2026-09-01T00:00:00.000Z" }, body, frontMatter);
    expect(out).toContain("updated: 2026-09-01T00:00:00.000Z");
    expect(out).not.toContain("2026-08-22T09:30:00.000Z");
    expect(out).toContain("aliases: [Auth Boundary, ADR-7]");
    expect(out).toContain("cssclass: wide-table");
    expect(out).toContain("publish: true");
    // Position, not just presence: `aliases` still sits between title and created.
    expect(out.indexOf("aliases:")).toBeGreaterThan(out.indexOf("title:"));
    expect(out.indexOf("aliases:")).toBeLessThan(out.indexOf("created:"));
  });

  it("preserves unrepresentable syntax verbatim rather than reformatting it", () => {
    // The Obsidian property editor writes tags as a block list. A
    // line-oriented rewrite that "understood" it would emit `tags: []` and
    // orphan the two children — worse than dropping them, because the file
    // stops parsing as the user intended while still looking plausible.
    const text = [
      "---",
      "title: Reading list",
      "tags:",
      "  - reading",
      "  - queue",
      "meta:",
      "  owner: platform",
      "summary: >",
      "  folded text",
      "  continued",
      "---",
      "",
      "Body.",
      "",
    ].join("\n");
    expect(rewrite(text)).toBe(text);
  });

  it("does not read a block-list value as a scalar", () => {
    const { meta } = parseNoteFile("---\ntitle: T\ntags:\n  - reading\n---\n\nb\n");
    // The engine cannot represent it, so it reports no tags rather than
    // inventing `[""]` from the empty text after the colon.
    expect(meta.tags).toEqual([]);
  });

  it("never adds a second copy of a key it declined to rewrite", () => {
    const out = rewrite("---\ntitle: T\ntags:\n  - reading\n---\n\nb\n");
    expect(out.match(/^tags:/gm)).toHaveLength(1);
  });

  it("keeps blank lines, comments and junk inside the block", () => {
    const text = [
      "---",
      "title: T",
      "",
      "# a comment",
      "no-colon-here",
      "source: agent",
      "---",
      "",
      "b",
      "",
    ].join("\n");
    expect(rewrite(text)).toBe(text);
  });

  it("collapses a duplicated managed key onto its first position", () => {
    // `parseFrontMatter` keeps the last occurrence, so the surviving line
    // must carry the last value — at the first position, so surrounding
    // unknown keys do not shift.
    const out = rewrite("---\ntitle: First\nx: keep\ntitle: Second\n---\n\nb\n");
    expect(out.match(/^title:/gm)).toHaveLength(1);
    expect(out).toContain("title: Second");
    expect(out.indexOf("title:")).toBeLessThan(out.indexOf("x: keep"));
  });
});

describe("notes lacking created/updated are not given them", () => {
  // Hand-written notes in a real vault frequently have neither. Defaulting
  // them to "" on read is fine; writing "created: " back is the engine
  // fabricating metadata during an edit the user asked for something else.
  const bare = "---\ntitle: Hand written\n---\n\nJust a body.\n";

  it("round-trips a title-only note byte-identically", () => {
    expect(rewrite(bare)).toBe(bare);
  });

  it("omits every managed key whose value is indistinguishable from absent", () => {
    const out = rewrite(bare);
    expect(out).not.toContain("created:");
    expect(out).not.toContain("updated:");
    expect(out).not.toContain("tags:");
    expect(out).not.toContain("source:");
  });

  it("appends a managed key only when it carries a real value", () => {
    const { meta, body, frontMatter } = parseNoteFile(bare);
    const out = serializeNote({ ...meta, updated: "2026-09-01T00:00:00.000Z" }, body, frontMatter);
    expect(out).toContain("updated: 2026-09-01T00:00:00.000Z");
    expect(out).not.toContain("created:"); // still absent — nothing set it
    expect(parseNoteFile(out).meta.created).toBe("");
  });

  it("keeps a key the user did write, even at its default value", () => {
    // The mirror-image mutation: `tags: []` and `source: human` on disk are
    // the user's lines. "Omit when defaulted" gates *appending*, not deleting.
    const text = "---\ntitle: T\ntags: []\nsource: human\n---\n\nb\n";
    expect(rewrite(text)).toBe(text);
  });

  it("adds title to a block that has none, so the result stays parseable", () => {
    // `parseNoteFile` refuses a titleless block, but `serializeNote` is
    // public and a caller can hand it one (an OKF file, a hand-built block).
    // Title is the one managed key that is appended unconditionally: emitting
    // the note without it would produce a file nothing can read back.
    const out = serializeNote(
      { title: "Recovered", created: "", updated: "", tags: [], source: "human" },
      "b",
      ["weight: 3"],
    );
    expect(out).toBe("---\nweight: 3\ntitle: Recovered\n---\n\nb\n");
    expect(parseNoteFile(out).meta.title).toBe("Recovered");
  });

  it("always writes title, even empty — it is required, not defaultable", () => {
    // Every other managed key may be omitted when it carries no information.
    // `title` may not: it is the one field `parseNoteFile` requires, so an
    // omitted empty title would turn a readable note into a malformed file.
    // Quoting is what keeps it readable — a bare `title:` would be missing.
    const text = "---\ntitle: T\nweight: 3\n---\n\nb\n";
    const { meta, body, frontMatter } = parseNoteFile(text);
    const out = serializeNote({ ...meta, title: "" }, body, frontMatter);
    expect(out).toContain('title: ""');
    expect(out).toContain("weight: 3");
    expect(parseNoteFile(out).meta.title).toBe("");
  });
});

describe("serializeNote without a front-matter block", () => {
  it("writes the canonical five-field block for a brand-new note", () => {
    const out = serializeNote(
      {
        title: "New",
        created: "2026-08-22T09:00:00.000Z",
        updated: "2026-08-22T09:00:00.000Z",
        tags: ["a"],
        source: "agent",
      },
      "body",
    );
    expect(out).toBe(
      [
        "---",
        "title: New",
        "created: 2026-08-22T09:00:00.000Z",
        "updated: 2026-08-22T09:00:00.000Z",
        "tags: [a]",
        "source: agent",
        "---",
        "",
        "body",
        "",
      ].join("\n"),
    );
  });
});
