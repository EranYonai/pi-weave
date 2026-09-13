import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  parseFrontMatter,
  parseNoteFile,
  serializeNote,
} from "./frontmatter";
import { withMutationQueue } from "./mutex";
import { NOTES_DIR, OKF_MANIFEST } from "./paths";
import { slugify, uniqueSlug } from "./slug";
import type {
  Note,
  NoteFrontMatter,
  NoteMeta,
  NoteSearchHit,
  NoteSource,
  NoteSummary,
} from "./types";

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
 * Slugs arrive from tool parameters, so they are untrusted: `../x` and
 * absolute escapes must never read or write outside `<vault>/notes/`
 * (subdirectories *within* it are legitimate for nested notes).
 */
export function resolveNotePath(root: string, slug: string): string | null {
  if (slug.trim().length === 0) return null;
  const notesDir = join(root, NOTES_DIR);
  const candidate = join(notesDir, `${slug}.md`);
  const rel = relative(notesDir, candidate);
  // Slugs may nest, but they may never escape the collection: `..` segments
  // and absolute paths resolve outside notes/ and are rejected here, at the
  // one door every read and write walks through.
  if (rel.startsWith("..") || isAbsolute(rel) || rel.length === 0) return null;
  return candidate;
}

/**
 * Create a note. Returns the written note (with its final, unique slug).
 *
 * Serialized on the notes *directory* rather than on a note path, because
 * what needs protecting is the slug allocation, and the slug is not known
 * until it has been chosen. `uniqueSlug` is a check-then-create: two
 * concurrent `addNote("Decision")` calls could both observe `decision.md`
 * as free and the second would overwrite the first. Holding the directory
 * makes choosing-and-writing a single step.
 */
export async function addNote(root: string, input: AddNoteInput): Promise<Note> {
  await ensureVault(root);
  return withNoteLocks([join(root, NOTES_DIR)], async () => {
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
    // No `frontMatter`: a brand-new note has no prior layout to respect, so
    // the serializer writes its canonical block.
    return writeNote(notePath(root, slug), slug, meta, input.body, undefined);
  });
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
    const { meta, body, frontMatter } = parseNoteFile(text);
    return { slug, ...meta, body, frontMatter };
  } catch {
    return null;
  }
}

/**
 * Write a note file and return the note as it now exists on disk.
 *
 * Every mutation goes through here, for two reasons. It is the one place
 * that threads `frontMatter` into `serializeNote`, so no write path can
 * forget to and quietly resume deleting the user's unknown properties. And
 * it re-parses what was written rather than returning the in-memory `meta`,
 * so the returned note is what a subsequent `getNote` would see — which
 * matters because the serializer legitimately declines some changes (a
 * `tags:` block list is frozen, see `frontmatter.ts`). Reporting the intent
 * instead of the result would make that divergence invisible to the caller.
 */
async function writeNote(
  path: string,
  slug: string,
  meta: NoteMeta,
  body: string,
  frontMatter: NoteFrontMatter | undefined,
): Promise<Note> {
  const text = serializeNote(meta, body, frontMatter);
  // Path-slugs may introduce a new subdirectory; every write path funnels
  // through here, so this is the one mkdir that matters.
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, text, "utf8");
  const parsed = parseNoteFile(text);
  return { slug, ...parsed.meta, body: parsed.body, frontMatter: parsed.frontMatter };
}

/**
 * Namespace prefix for this module's mutation-queue keys.
 *
 * `withMutationQueue` is a **non-reentrant** keyed queue, so a task that
 * takes a key already held by an ancestor on the same call stack waits for
 * itself. That is not hypothetical: `src/pi/tools/noteTool.ts` wraps
 * `addNote`/`appendToNote`/`finalizeNote` in the queue keyed by the bare
 * note path, from the days when locking lived in the adapter. Locking on
 * the bare path in here too would deadlock every one of those tool calls.
 *
 * Prefixing gives core its own key space, so an outer lock held by any
 * adapter is a coarser, harmless layer rather than a hang. The adapter's
 * wrapper is now redundant — locking belongs in core per AGENTS.md rule 3,
 * and it should be removed from the adapter in a change that owns that file
 * — but redundant is a state the system can be in safely, and deadlocked is
 * not.
 */
const LOCK_NS = "vault:note:";

/**
 * Run `task` with exclusive access to every given note path.
 *
 * Paths are locked in a fixed order so callers that need multiple locks cannot
 * deadlock. Every mutation in this module goes through here, keeping appends
 * and finalization serialized with one another.
 */
function withNoteLocks<T>(paths: readonly string[], task: () => Promise<T>): Promise<T> {
  const ordered = [...new Set(paths)].sort();
  return ordered.reduceRight<() => Promise<T>>(
    (inner, path) => () => withMutationQueue(LOCK_NS + path, inner),
    task,
  )();
}

/** Options for {@link appendToNote}. */
export interface AppendToNoteOptions {
  /**
   * Append as **verbatim dictation** into the `## Raw` tail (the skill's raw
   * tail format: separator, heading, never-edit notice, dated fenced block).
   * Creates the tail when the note does not have one yet. Use this for raw
   * user dictation; the default plain append adds structured Markdown to the
   * editorial body above the tail.
   */
  raw?: boolean;
}

/** Append Markdown to an existing note and bump `updated`. */
export async function appendToNote(
  root: string,
  slug: string,
  addition: string,
  now: Date = new Date(),
  options: AppendToNoteOptions = {},
): Promise<Note | null> {
  const path = resolveNotePath(root, slug);
  if (!path) return null;
  return withNoteLocks([path], async () => {
    const note = await getNote(root, slug);
    if (!note) return null;
    const tail = extractRawTail(note.body);
    let body: string;
    if (options.raw) {
      // A raw append always lands at the very end of the body — which is the
      // end of the `## Raw` tail whenever one exists — so "append at end" is
      // the correct placement; the only branch is tail creation.
      const block =
        tail === ""
          ? `${rawTailOpening()}\n\n${formatRawAppend(addition, now)}`
          : formatRawAppend(addition, now);
      body = note.body.replace(/\s+$/, "") + "\n\n" + block + "\n";
    } else if (tail === "") {
      body = note.body.replace(/\s+$/, "") + "\n\n" + addition.trim() + "\n";
    } else {
      // Structured additions belong to the editorial body ABOVE the tail —
      // the raw tail stays the note's bottom, append-only and untouched.
      const idx = note.body.lastIndexOf(tail);
      const head = note.body.slice(0, idx).replace(/\s+$/, "");
      body = (head ? head + "\n\n" : "") + addition.trim() + "\n\n" + tail + "\n";
    }
    return writeNote(path, slug, { ...note, updated: now.toISOString() }, body, note.frontMatter);
  });
}

/**
 * Pick a code fence that cannot be terminated by any backtick run inside
 * `text` (CommonMark: a fence must be at least as long as the longest
 * backtick run it encloses).
 */
function fenceFor(text: string): string {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

/** The canonical opening of a `## Raw` tail: separator, heading, notice. */
function rawTailOpening(): string {
  return `---\n\n${RAW_NOTES_HEADING}\n${RAW_TAIL_NOTICE}`;
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
  const fence = fenceFor(rawText);

  return `<!-- appended ${timestamp} -->\n${fence}\n${rawText.trim()}\n${fence}`;
}

/** The append-only tail where verbatim user scribbles live. */
export const RAW_NOTES_HEADING = "## Raw";

/** The never-edit notice comment at the top of a raw tail (skill format). */
export const RAW_TAIL_NOTICE =
  "<!-- NEVER edit below this line. Verbatim user input preserved here. -->";

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
  return withNoteLocks([path], async () => {
    const note = await getNote(root, slug);
    if (!note) return null;
    const rawTail = extractRawTail(note.body);
    const structured = input.body.trim();
    // A note whose body carries no `## Raw` marker yet is treated as *all*
    // raw: the entire pre-finalize body is preserved verbatim beneath the
    // restructured body as a freshly created tail (docs/notepad.md §4 — the
    // user's words are never silently destroyed by finalization).
    const body =
      structured +
      (rawTail !== ""
        ? `\n\n${rawTail}`
        : note.body.trim() === ""
          ? ""
          : `\n\n${rawTailOpening()}\n\n${fenceFor(note.body)}\n${note.body.trim()}\n${fenceFor(note.body)}`);
    const meta: NoteMeta = { ...note, updated: (input.now ?? new Date()).toISOString() };
    return writeNote(path, slug, meta, body, note.frontMatter);
  });
}

async function listNoteFiles(root: string): Promise<string[]> {
  const dir = join(root, NOTES_DIR);
  const out: string[] = [];
  async function walk(prefix: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(prefix.length > 0 ? join(dir, prefix) : dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await walk(prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push(prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name);
      }
    }
  }
  await walk("");
  return out.sort();
}

export function summarizeNote(note: Note): NoteSummary {
  const { body, frontMatter, ...rest } = note;
  void frontMatter;
  return { ...rest, bodyLength: body.length };
}

/**
 * Newest-updated first. Ties fall back to slug ascending: the input arrives
 * in readdir-sorted (slug) order and `Array.prototype.sort` is stable, so
 * equal timestamps keep that order.
 */
function byUpdatedDesc(a: { updated: string }, b: { updated: string }): number {
  return b.updated.localeCompare(a.updated);
}

export async function listNoteFolders(root: string): Promise<string[]> {
  const dir = join(root, NOTES_DIR);
  const out: string[] = [];
  async function walk(prefix: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(prefix.length > 0 ? join(dir, prefix) : dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        const folder = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
        out.push(folder);
        await walk(folder);
      }
    }
  }
  await walk("");
  return out.sort();
}

/**
 * Everything one pass over the vault can tell you: every readable note with
 * its body, plus how many `.md` files exist.
 *
 * Callers that need both the note list *and* the bodies (the graph builder,
 * search) must use this instead of `listNotes` + `getNote` per slug — that
 * pattern reads and parses every file twice (weave-workspace §4.1).
 */
export interface VaultSnapshot {
  /** Readable, parseable notes, newest-updated first. */
  notes: Note[];
  /**
   * Number of `*.md` files present, *including* ones too malformed to parse.
   * `notes.length` can be smaller; this is the honest on-disk count.
   */
  fileCount: number;
  /** Subdirectories present in <vault>/notes/, including empty ones. */
  folders?: string[];
}

/** Read the whole vault in one pass: one readdir, one read per note. */
export async function readVault(root: string): Promise<VaultSnapshot> {
  const [files, folders] = await Promise.all([listNoteFiles(root), listNoteFolders(root)]);
  const notes: Note[] = [];
  for (const file of files) {
    const note = await getNote(root, file.slice(0, -".md".length));
    if (!note) continue; // unreadable/malformed files are skipped, not fatal
    notes.push(note);
  }
  return {
    notes: notes.sort(byUpdatedDesc),
    fileCount: files.length,
    ...(folders.length > 0 ? { folders } : {}),
  };
}

/** One note's identity and change-detection stamp, without reading its content. */
export interface NoteStat {
  slug: string;
  path: string;
  mtimeMs: number;
  size: number;
}

/**
 * Stat-only pass over the vault: enough to decide *which* notes changed,
 * without reading or parsing any of them. The change-detection primitive
 * behind `src/core/cache/workspace` — a no-change rebuild costs N stats and
 * zero reads.
 *
 * Files that vanish between the readdir and the stat are dropped, so a note
 * deleted mid-pass is simply absent rather than fatal.
 */
export async function statNotes(root: string): Promise<NoteStat[]> {
  const dir = join(root, NOTES_DIR);
  const files = await listNoteFiles(root);
  const stats = await Promise.all(
    files.map(async (file): Promise<NoteStat | null> => {
      const path = join(dir, file);
      try {
        const st = await fs.stat(path);
        return { slug: file.slice(0, -".md".length), path, mtimeMs: st.mtimeMs, size: st.size };
      } catch {
        return null; // raced a delete
      }
    }),
  );
  return stats.filter((s): s is NoteStat => s !== null);
}

/** List all notes with their metadata, newest-updated first. */
export async function listNotes(root: string): Promise<NoteSummary[]> {
  return (await readVault(root)).notes.map(summarizeNote);
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
  // One pass: `listNotes` + a `getNote` per slug would read every file twice.
  for (const note of (await readVault(root)).notes) {
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
    hits.push({ summary: summarizeNote(note), score, snippet: makeSnippet(note.body, q) });
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
