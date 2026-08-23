import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { parseNoteFile, serializeNote } from "./frontmatter";
import { NOTES_DIR, OKF_MANIFEST } from "./paths";
import { slugify, uniqueSlug } from "./slug";
import type { Note, NoteMeta, NoteSearchHit, NoteSource, NoteSummary } from "./types";

/**
 * The vault: the "smart notepad" half of pi-weave.
 *
 * Plain Markdown files with front matter under <vault>/notes/. Humans can
 * edit them in any editor; agents read/write them through this layer so the
 * format stays consistent (design §1, §13).
 */

export interface AddNoteInput {
  title: string;
  body: string;
  tags?: string[];
  source?: NoteSource;
  /** Injectable clock for tests. */
  now?: Date;
}

interface VaultManifest {
  okfVersion: 1;
  scope: "vault";
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

/** Create the vault layout if needed. Idempotent. */
export async function ensureVault(root: string): Promise<void> {
  await fs.mkdir(join(root, NOTES_DIR), { recursive: true });
  const manifestPath = join(root, OKF_MANIFEST);
  if (!(await exists(manifestPath))) {
    const manifest: VaultManifest = { okfVersion: 1, scope: "vault" };
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  }
}

export async function vaultExists(root: string): Promise<boolean> {
  return exists(join(root, OKF_MANIFEST));
}

function notePath(root: string, slug: string): string {
  return join(root, NOTES_DIR, `${slug}.md`);
}

/**
 * Resolve a note slug to its on-disk path, or null when the slug is unsafe.
 * Slugs arrive from tool parameters, so they are untrusted: `../x`, nested
 * paths, and absolute escapes must never read or write outside the flat
 * <vault>/notes/ directory.
 */
export function resolveNotePath(root: string, slug: string): string | null {
  if (slug.trim().length === 0) return null;
  const notesDir = join(root, NOTES_DIR);
  const candidate = join(notesDir, `${slug}.md`);
  const rel = relative(notesDir, candidate);
  if (rel.startsWith("..") || isAbsolute(rel) || rel.includes(sep)) return null;
  return candidate;
}

/** Create a note. Returns the written note (with its final, unique slug). */
export async function addNote(root: string, input: AddNoteInput): Promise<Note> {
  await ensureVault(root);
  const now = (input.now ?? new Date()).toISOString();
  const base = slugify(input.title);
  const slug = uniqueSlug(base, (candidate) => existsSync(notePath(root, candidate)));

  const meta: NoteMeta = {
    title: input.title,
    created: now,
    updated: now,
    tags: input.tags ?? [],
    source: input.source ?? "agent",
  };
  const text = serializeNote(meta, input.body);
  await fs.writeFile(notePath(root, slug), text, "utf8");
  return { slug, ...meta, body: input.body };
}

/** Read a note by slug. Returns null when missing, malformed, or an unsafe slug. */
export async function getNote(root: string, slug: string): Promise<Note | null> {
  const path = resolveNotePath(root, slug);
  if (!path) return null;
  let text: string;
  try {
    text = await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    const { meta, body } = parseNoteFile(text);
    return { slug, ...meta, body };
  } catch {
    return null;
  }
}

/** Append Markdown to an existing note and bump `updated`. */
export async function appendToNote(
  root: string,
  slug: string,
  addition: string,
  now: Date = new Date(),
): Promise<Note | null> {
  const path = resolveNotePath(root, slug);
  if (!path) return null;
  const note = await getNote(root, slug);
  if (!note) return null;
  const body = note.body.replace(/\s+$/, "") + "\n\n" + addition.trim() + "\n";
  const meta: NoteMeta = { ...note, updated: now.toISOString() };
  await fs.writeFile(path, serializeNote(meta, body), "utf8");
  return { slug, ...meta, body };
}

/** Format a verbatim user scribble as an append-only raw block with a timestamp. */
export function formatRawAppend(rawText: string, date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const min = pad(date.getMinutes());
  const timestamp = `${yyyy}-${mm}-${dd} ${hh}:${min}`;

  return `<!-- appended ${timestamp} -->\n\`\`\`\n${rawText.trim()}\n\`\`\``;
}

/** The append-only tail where verbatim user scribbles live. */
export const RAW_NOTES_HEADING = "## Raw";

/**
 * Extract the raw tail (including separator line, heading, and everything after) verbatim.
 */
export function extractRawTail(body: string): string {
  // Check for '---' preceding ## Raw or ## Raw directly
  const sepIdx = body.indexOf("\n---\n\n## Raw");
  if (sepIdx !== -1) {
    return body.slice(sepIdx + 1).trimEnd();
  }
  if (body.startsWith("---\n\n## Raw") || body.startsWith("---\n## Raw")) {
    return body.trimEnd();
  }
  const sepIdx2 = body.indexOf("\n---\n## Raw");
  if (sepIdx2 !== -1) {
    return body.slice(sepIdx2 + 1).trimEnd();
  }
  const idx = body.indexOf(RAW_NOTES_HEADING);
  if (idx === -1) return "";
  return body.slice(idx).trimEnd();
}

export interface FinalizeNoteInput {
  /**
   * The restructured body ABOVE the raw tail (front-loaded summary, sections,
   * entities, links). The `## Raw` tail is preserved verbatim beneath it.
   */
  body: string;
  /** Injectable clock for tests. */
  now?: Date;
}

/**
 * Finalize a note: replace the body above the `## Raw` tail with a
 * restructured version, preserving the raw tail verbatim (append-only).
 * Returns null when the note is missing or the slug is unsafe.
 */
export async function finalizeNote(
  root: string,
  slug: string,
  input: FinalizeNoteInput,
): Promise<Note | null> {
  const path = resolveNotePath(root, slug);
  if (!path) return null;
  const note = await getNote(root, slug);
  if (!note) return null;
  const rawTail = extractRawTail(note.body);
  const body = input.body.trim() + (rawTail ? `\n\n${rawTail}` : "");
  const meta: NoteMeta = { ...note, updated: (input.now ?? new Date()).toISOString() };
  await fs.writeFile(path, serializeNote(meta, body), "utf8");
  return { slug, ...meta, body };
}

async function listNoteFiles(root: string): Promise<string[]> {
  const dir = join(root, NOTES_DIR);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  return entries.filter((name) => name.endsWith(".md")).sort();
}

/** List all notes with their metadata, newest-updated first. */
export async function listNotes(root: string): Promise<NoteSummary[]> {
  const files = await listNoteFiles(root);
  const summaries: NoteSummary[] = [];
  for (const file of files) {
    const slug = file.slice(0, -".md".length);
    const note = await getNote(root, slug);
    if (!note) continue; // unreadable/malformed files are skipped, not fatal
    const { body, ...summary } = note;
    summaries.push({ ...summary, bodyLength: body.length });
  }
  return summaries.sort((a, b) => b.updated.localeCompare(a.updated));
}

export async function noteCount(root: string): Promise<number> {
  return (await listNoteFiles(root)).length;
}

/**
 * Substring search over title, tags, and body.
 * Score: title match = 3, tag match = 2, body match = 1 each (capped).
 * Case-insensitive. Deterministic ordering: score desc, then slug asc.
 */
export async function searchNotes(root: string, query: string): Promise<NoteSearchHit[]> {
  const q = query.toLowerCase().trim();
  if (q.length === 0) return [];

  const hits: NoteSearchHit[] = [];
  for (const summary of await listNotes(root)) {
    const note = await getNote(root, summary.slug);
    if (!note) continue;

    let score = 0;
    if (note.title.toLowerCase().includes(q)) score += 3;
    if (note.tags.some((t) => t.toLowerCase().includes(q))) score += 2;

    const bodyLower = note.body.toLowerCase();
    let bodyMatches = 0;
    let idx = bodyLower.indexOf(q);
    while (idx >= 0 && bodyMatches < 5) {
      bodyMatches++;
      idx = bodyLower.indexOf(q, idx + q.length);
    }
    score += bodyMatches;

    if (score === 0) continue;
    hits.push({ summary, score, snippet: makeSnippet(note.body, q) });
  }
  return hits.sort((a, b) => b.score - a.score || a.summary.slug.localeCompare(b.summary.slug));
}

function makeSnippet(body: string, q: string, radius = 60): string {
  const idx = body.toLowerCase().indexOf(q);
  if (idx === -1) {
    return body.trim().slice(0, radius * 2);
  }
  const start = Math.max(0, idx - radius);
  const end = Math.min(body.length, idx + q.length + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < body.length ? "…" : "";
  return (prefix + body.slice(start, end) + suffix).replace(/\s+/g, " ").trim();
}

/** Re-export so adapters do not need to know about frontmatter details. */
export { serializeNote, parseNoteFile };

/** Render a note as Markdown text for agent/human consumption. */
export function formatNote(note: Note): string {
  const tags = note.tags.length > 0 ? `, tags: ${note.tags.join(", ")}` : "";
  const header = `# ${note.title}\n(slug: ${note.slug}, updated ${note.updated}${tags}, source: ${note.source})`;
  return `${header}\n\n${note.body.trim()}\n`;
}
