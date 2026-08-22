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

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

function quote(value: string): string {
  // Only quote when the value could confuse our subset parser.
  if (/[:#[\]]|^\s|\s$|^$/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return trimmed;
}

function parseTags(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return trimmed.length > 0 ? [unquote(trimmed)] : [];
  }
  const inner = trimmed.slice(1, -1).trim();
  if (inner.length === 0) return [];
  return inner
    .split(",")
    .map((t) => unquote(t))
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
    `title: ${quote(meta.title)}`,
    `created: ${meta.created}`,
    `updated: ${meta.updated}`,
    `tags: [${meta.tags.map(quote).join(", ")}]`,
    `source: ${meta.source}`,
    "---",
    "",
    body.replace(/\s+$/, ""),
    "",
  ];
  return lines.join("\n");
}

/**
 * Parse a note file. Throws on missing/invalid front matter so callers can
 * treat the file as malformed rather than guessing.
 */
export function parseNoteFile(text: string): ParsedNoteFile {
  const match = FRONTMATTER_RE.exec(text);
  if (!match || match[1] === undefined) {
    throw new Error("Missing front matter block (expected leading --- block)");
  }
  const raw = match[1];
  // Strip the serializer's blank separator line and any trailing whitespace,
  // so a round-tripped body equals the original input.
  const body = text.slice(match[0].length).replace(/^\n/, "").replace(/\s+$/, "");

  const fields = new Map<string, string>();
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue; // tolerate blank/junk lines, front matter is best-effort
    fields.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }

  const title = fields.get("title");
  if (!title) {
    throw new Error("Front matter is missing required field: title");
  }

  const meta: NoteMeta = {
    title: unquote(title),
    created: fields.get("created") ?? "",
    updated: fields.get("updated") ?? "",
    tags: parseTags(fields.get("tags") ?? "[]"),
    source: parseSource(fields.get("source") ?? "human"),
  };
  return { meta, body };
}
