import type { NoteFrontMatter, NoteMeta, NoteSource } from "./types";
import { NOTE_SOURCES } from "./types";

/**
 * Minimal YAML-front-matter handling for vault notes.
 *
 * Deliberately a *subset*: notes are meant to be human-editable plain text,
 * so we write only `key: value` scalars and `[a, b]` inline arrays, and we
 * parse exactly that. Anything richer belongs in the Markdown body.
 *
 * ## Parsing a subset without writing a subset
 *
 * "We parse a subset" used to also mean "we write a subset", and those are
 * not the same promise. `parseNoteFile` read five keys and `serializeNote`
 * wrote five keys, so every write through core silently deleted whatever
 * else the file carried — `aliases`, `cssclass`, `publish`, any property an
 * Obsidian user or another tool had added. Reading a note and appending one
 * line destroyed the rest of its metadata (weave-workspace §11 P5).
 *
 * The fix is *not* a fuller YAML parser. A vault is plain text a human edits,
 * and a parser that understands more is a parser that **rewrites** more —
 * every construct it learns to read is a construct it will re-emit in its own
 * preferred spelling. The fix is to stop conflating "parsed" with
 * "preserved":
 *
 * - The five keys in {@link MANAGED_FRONT_MATTER_KEYS} are **owned**: parsed
 *   into {@link NoteMeta}, and re-rendered from those values on write.
 * - Every other line is **carried**: emitted as the exact bytes it was read
 *   as, in its original position. Unknown keys, blank lines, junk without a
 *   colon, and syntax this subset cannot represent at all — block lists,
 *   folded scalars, nested maps — all survive, because none of them is ever
 *   interpreted.
 *
 * The round-trip property is therefore: **owned fields round-trip by value,
 * every other byte round-trips by byte, and key order is preserved.**
 *
 * ## Two rules that keep writes from inventing content
 *
 * **An owned key is never added to a file that did not have it, unless it
 * carries a value the parser would not have defaulted to.** Real vaults are
 * full of hand-written notes with no `created`/`updated`; `parseNoteFile`
 * defaults those to `""`, and writing `created: ` back would be the engine
 * fabricating metadata during an unrelated edit. Since no mutation path ever
 * *sets* `created`, it stays `""` and stays absent; `updated` is appended
 * only because a caller explicitly asked for a bump, which is a requested
 * change rather than a silent one. See {@link isDefaulted}.
 *
 * **An owned key whose on-disk syntax this subset cannot represent is
 * frozen**: carried verbatim, and not re-rendered or duplicated. Obsidian's
 * property editor writes tags as a YAML block list —
 *
 * ```yaml
 * tags:
 *   - reading
 * ```
 *
 * — which is exactly the shape a line-oriented serializer would destroy, by
 * rewriting the parent as `tags: []` and orphaning the two children under it.
 * So such a construct is left alone entirely and the append pass skips the
 * key, because emitting a second `tags:` further down would leave the user
 * with a duplicated property. The cost is that the engine neither reads nor
 * updates those tags — the same blindness it has today, minus the data loss.
 * It is observable rather than silent: every mutation API returns the note as
 * re-parsed from what was actually written, so a caller that sets tags on
 * such a note gets back a note whose tags did not change.
 */

export interface ParsedNoteFile {
  meta: NoteMeta;
  body: string;
  /** The front-matter block verbatim, for lossless re-serialization. */
  frontMatter: NoteFrontMatter;
}

/** Generic, tolerant front-matter parse (any fields) — for non-note OKF files. */
export interface ParsedFrontMatter {
  fields: Map<string, string>;
  body: string;
  /** The raw block lines in file order, `---` fences excluded. */
  lines: readonly string[];
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

/**
 * The front-matter keys this module owns — parsed into {@link NoteMeta} and
 * re-rendered on write. Everything else is carried verbatim.
 *
 * The array order is also the order in which a missing owned key is appended,
 * so a note that gains `updated` gains it in a predictable place.
 */
export const MANAGED_FRONT_MATTER_KEYS = ["title", "created", "updated", "tags", "source"] as const;

export type ManagedFrontMatterKey = (typeof MANAGED_FRONT_MATTER_KEYS)[number];

const MANAGED: ReadonlySet<string> = new Set<string>(MANAGED_FRONT_MATTER_KEYS);

export function quoteField(value: string): string {
  // Only quote when the value could confuse our subset parser.
  if (/[:#[\]]|^\s|\s$|^$/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

export function unquoteField(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return trimmed;
}

/** One classified line of a front-matter block. */
export interface FrontMatterLine {
  /** The line exactly as it appears in the file. */
  text: string;
  /** The top-level key it declares, or null for blank/junk/continuation lines. */
  key: string | null;
  /**
   * True when the value is a scalar or inline array this subset can both read
   * and write. False for a key introducing a block construct — its value
   * lives in the indented lines below it, which no line-oriented rewrite can
   * safely touch.
   */
  scalar: boolean;
}

/**
 * Classify a front-matter block line by line.
 *
 * The **single** rule for "which line is which key", shared by the parser and
 * the serializer. A second copy of this rule is a second way for a write to
 * disagree with a read about whether a line is owned — and disagreeing in
 * that direction means either dropping a property or duplicating it.
 *
 * Block detection needs one line of lookahead, which is why this classifies
 * the whole block rather than exposing a per-line predicate: `tags:` is a
 * scalar with an empty value on its own, and the head of a list when the next
 * line is indented.
 */
export function scanFrontMatter(lines: readonly string[]): FrontMatterLine[] {
  return lines.map((text, i): FrontMatterLine => {
    const idx = text.indexOf(":");
    // Indented lines belong to whatever is above them: treating one as a
    // top-level key would let the serializer hoist it out of its parent.
    if (idx <= 0 || /^\s/.test(text)) return { text, key: null, scalar: false };
    const key = text.slice(0, idx).trim();
    if (key.length === 0) return { text, key: null, scalar: false };
    const value = text.slice(idx + 1).trim();
    const blockHead = value.length === 0 && /^\s+\S/.test(lines[i + 1] ?? "");
    return { text, key, scalar: !blockHead };
  });
}

function parseTags(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return trimmed.length > 0 ? [unquoteField(trimmed)] : [];
  }
  const inner = trimmed.slice(1, -1).trim();
  if (inner.length === 0) return [];
  return inner
    .split(",")
    .map((t) => unquoteField(t))
    .filter((t) => t.length > 0);
}

function parseSource(value: string): NoteSource {
  const raw = value.trim();
  return (NOTE_SOURCES as readonly string[]).includes(raw)
    ? (raw as NoteSource)
    : "human";
}

/** Render one owned key from its parsed value. */
function renderManaged(key: ManagedFrontMatterKey, meta: NoteMeta): string {
  switch (key) {
    case "title":
      return `title: ${quoteField(meta.title)}`;
    case "created":
      return `created: ${meta.created}`;
    case "updated":
      return `updated: ${meta.updated}`;
    case "tags":
      return `tags: [${meta.tags.map(quoteField).join(", ")}]`;
    default:
      return `source: ${meta.source}`;
  }
}

/**
 * True when omitting `key` would parse back to the same value — the value is
 * indistinguishable from the parser's default for an absent key.
 *
 * Gates **appending** an owned key that the file did not already declare, so
 * an edit to a note's body cannot grow its front matter with fields the user
 * never wrote. A key the file *does* declare is always re-rendered, never
 * dropped: `tags: []` and `source: human` written by hand are the user's
 * lines, and deleting them would be the mirror-image mutation.
 *
 * `title` is never defaulted: it is the one required field, and a note
 * without it is malformed rather than empty.
 */
function isDefaulted(key: ManagedFrontMatterKey, meta: NoteMeta): boolean {
  switch (key) {
    case "title":
      return false;
    case "created":
      return meta.created.length === 0;
    case "updated":
      return meta.updated.length === 0;
    case "tags":
      return meta.tags.length === 0;
    default:
      return meta.source === "human";
  }
}

/**
 * Serialize note metadata + body to the on-disk Markdown form.
 *
 * With `frontMatter` supplied — as `parseNoteFile` returns and every vault
 * write path threads through — the original block is replayed line for line:
 * owned scalar keys are re-rendered in place from `meta`, everything else is
 * emitted as the exact bytes it was read as. Owned keys the original did not
 * declare are appended at the end of the block, and only when they carry a
 * non-default value.
 *
 * Without it, the canonical five-line block is written — the shape `addNote`
 * creates for a brand-new note, where there is no prior layout to respect.
 */
export function serializeNote(meta: NoteMeta, body: string, frontMatter?: NoteFrontMatter): string {
  const block = frontMatter === undefined ? canonicalBlock(meta) : replayBlock(meta, frontMatter);
  return ["---", ...block, "---", "", body.replace(/\s+$/, ""), ""].join("\n");
}

function canonicalBlock(meta: NoteMeta): string[] {
  return MANAGED_FRONT_MATTER_KEYS.map((key) => renderManaged(key, meta));
}

function replayBlock(meta: NoteMeta, frontMatter: NoteFrontMatter): string[] {
  /** Top-level keys the file declares, in any syntax — including frozen ones. */
  const declared = new Set<string>();
  /** Owned keys already re-rendered, so a duplicate key collapses to one line. */
  const rendered = new Set<string>();
  const out: string[] = [];

  for (const line of scanFrontMatter(frontMatter)) {
    if (line.key !== null) declared.add(line.key);
    if (line.key === null || !line.scalar || !MANAGED.has(line.key)) {
      out.push(line.text); // carried verbatim — never interpreted, never reformatted
      continue;
    }
    // A repeated owned key is a typo, and `parseFrontMatter` keeps the last
    // occurrence. Re-rendering the parsed value at the *first* position and
    // dropping the rest preserves that value while collapsing the duplicate.
    if (rendered.has(line.key)) continue;
    rendered.add(line.key);
    out.push(renderManaged(line.key as ManagedFrontMatterKey, meta));
  }

  for (const key of MANAGED_FRONT_MATTER_KEYS) {
    if (declared.has(key) || isDefaulted(key, meta)) continue;
    out.push(renderManaged(key, meta));
  }
  return out;
}

/**
 * Parse any OKF front-matter block generically. Returns null when there is
 * no leading `---` block; field parsing is best-effort (junk lines skipped).
 * The body is stripped of the serializer's blank separator and trailing
 * whitespace so round-trips are stable.
 */
export function parseFrontMatter(text: string): ParsedFrontMatter | null {
  const match = FRONTMATTER_RE.exec(text);
  if (!match || match[1] === undefined) return null;
  const body = text.slice(match[0].length).replace(/^\n/, "").replace(/\s+$/, "");
  const lines = match[1].split("\n");
  const fields = new Map<string, string>();
  for (const line of scanFrontMatter(lines)) {
    // Blank/junk lines and block constructs are skipped: front matter is
    // best-effort, and a value this subset cannot read is one it must not
    // pretend to have read as `""`.
    if (line.key === null || !line.scalar) continue;
    fields.set(line.key, line.text.slice(line.text.indexOf(":") + 1).trim());
  }
  return { fields, body, lines };
}

/**
 * Parse a note file. Throws on missing/invalid front matter so callers can
 * treat the file as malformed rather than guessing.
 */
export function parseNoteFile(text: string): ParsedNoteFile {
  const parsed = parseFrontMatter(text);
  if (!parsed) {
    throw new Error("Missing front matter block (expected leading --- block)");
  }
  const title = parsed.fields.get("title");
  if (!title) {
    throw new Error("Front matter is missing required field: title");
  }
  const meta: NoteMeta = {
    title: unquoteField(title),
    created: parsed.fields.get("created") ?? "",
    updated: parsed.fields.get("updated") ?? "",
    tags: parseTags(parsed.fields.get("tags") ?? "[]"),
    source: parseSource(parsed.fields.get("source") ?? "human"),
  };
  return { meta, body: parsed.body, frontMatter: parsed.lines };
}
