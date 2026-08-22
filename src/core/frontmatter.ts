import type { NoteMeta, NoteSource } from "./types";
import { NOTE_SOURCES } from "./types";

/**
 * Minimal YAML-front-matter handling for vault notes.
 *
 * Deliberately a *subset*: notes are meant to be human-editable plain text,
 * so we write only `key: value` scalars and `[a, b]` inline arrays, and we
 * parse exactly that. Anything richer belongs in the Markdown body.
 */

export interface ParsedNoteFile {
  meta: NoteMeta;
  body: string;
}

/** Generic, tolerant front-matter parse (any fields) — for non-note OKF files. */
export interface ParsedFrontMatter {
  fields: Map<string, string>;
  body: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

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

/** Serialize note metadata + body to the on-disk Markdown form. */
export function serializeNote(meta: NoteMeta, body: string): string {
  const lines = [
    "---",
    `title: ${quoteField(meta.title)}`,
    `created: ${meta.created}`,
    `updated: ${meta.updated}`,
    `tags: [${meta.tags.map(quoteField).join(", ")}]`,
    `source: ${meta.source}`,
    "---",
    "",
    body.replace(/\s+$/, ""),
    "",
  ];
  return lines.join("\n");
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
  const fields = new Map<string, string>();
  for (const line of match[1].split("\n")) {
    if (line.trim().length === 0) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue; // tolerate blank/junk lines, front matter is best-effort
    fields.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }
  return { fields, body };
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
  return { meta, body: parsed.body };
}
