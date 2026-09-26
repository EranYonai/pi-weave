import { existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import {
  MANAGED_FRONT_MATTER_KEYS,
  parseFrontMatter,
  parseNoteFile,
  quoteField,
  serializeNote,
  unquoteField,
  upsertFrontMatterFields,
} from "./frontmatter";
import { auditLinks, fenceRanges, rawTailStart, rewriteLinks, RAW_NOTES_HEADING, type LinkAudit, type LinkFix } from "./links/repair";
import { withMutationQueue } from "./mutex";
import { NOTES_DIR, OKF_MANIFEST } from "./paths";
import { slugify, uniqueSlug } from "./slug";
import type {
  Note,
  HtmlArtifact,
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
  return withVaultLock(root, async () => {
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
    if (!meta.updated || !meta.created) {
      const st = await fs.stat(path).catch(() => null);
      if (st) {
        const mtime = st.mtime.toISOString();
        if (!meta.updated) meta.updated = mtime;
        if (!meta.created) meta.created = mtime;
      }
    }
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
 * Run `task` with exclusive mutation access to this vault.
 */
function withVaultLock<T>(root: string, task: () => Promise<T>): Promise<T> {
  // ponytail: one vault-wide lock is enough for a local notepad; use
  // hierarchical locks only if independent-note write throughput matters.
  return withMutationQueue(LOCK_NS + join(root, NOTES_DIR), task);
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
  return withVaultLock(root, async () => {
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

/**
 * The append-only tail where verbatim user scribbles live.
 *
 * Defined in `./links/repair` — the module that must never write past it —
 * and re-exported here, where every caller already looks for it.
 */
export { RAW_NOTES_HEADING };

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
  return withVaultLock(root, async () => {
    const note = await getNote(root, slug);
    if (!note) return null;
    const rawTail = extractRawTail(note.body);
    const structured = input.body.trim();
    // A note whose body carries no `## Raw` marker yet is treated as *all*
    // raw: the entire pre-finalize body is preserved verbatim beneath the
    // restructured body as a freshly created tail so the user's words are
    // never silently destroyed by finalization.
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

export interface UpsertNoteInput {
  slug: string;
  title: string;
  body: string;
  tags?: string[];
  source?: NoteSource;
  fields?: Record<string, string>;
  identity?: { field: string; value: string };
  now?: Date;
}

/** Create or refresh generated knowledge without overwriting a different identity. */
export async function upsertNote(root: string, input: UpsertNoteInput): Promise<Note> {
  await ensureVault(root);
  return withVaultLock(root, async () => {
    const now = (input.now ?? new Date()).toISOString();
    const identity = input.identity;
    let existing = await getNote(root, input.slug);
    if (existing !== null && identity && frontMatterField(existing.frontMatter, identity.field) !== identity.value) {
      existing = null;
    }
    if (existing === null) {
      const slug = uniqueSlug(input.slug, (candidate) => {
        if (!existsSync(notePath(root, candidate))) return false;
        return !identity || fileFrontMatterField(notePath(root, candidate), identity.field) !== identity.value;
      });
      const meta: NoteMeta = {
        title: input.title,
        created: now,
        updated: now,
        tags: input.tags ?? [],
        source: input.source ?? "generated",
      };
      const fields = safeGeneratedFields(input.fields);
      const frontMatter = [
        `title: ${quoteField(meta.title)}`,
        `created: ${meta.created}`,
        `updated: ${meta.updated}`,
        `tags: [${meta.tags.map(quoteField).join(", ")}]`,
        `source: ${meta.source}`,
        ...upsertFrontMatterFields([], fields),
      ];
      return writeNote(notePath(root, slug), slug, meta, input.body, frontMatter);
    }
    const fields = safeGeneratedFields(input.fields);
    const frontMatter = upsertFrontMatterFields(existing.frontMatter ?? [], fields);
    // The existing tail is re-attached whenever there is one. `input.body` is
    // generated content (a model summary), so probing it for a `## Raw` marker
    // would let a summary that merely mentions the heading delete the human's
    // verbatim tail.
    const tail = extractRawTail(existing.body);
    const body = tail === "" ? input.body.trim() : `${input.body.trim()}\n\n${tail}`;
    return writeNote(
      notePath(root, input.slug),
      input.slug,
      { ...existing, updated: now },
      body,
      frontMatter,
    );
  });
}

/**
 * Identity values are compared **unquoted**, matching how the session note
 * index reads them: `quoteField` wraps any value containing `:` (an ISO
 * timestamp used as an id, say), and comparing a quoted value against a raw
 * one never matches — which would fork a new `-2`, `-3`… note on every scan.
 */
function frontMatterField(lines: NoteFrontMatter | undefined, field: string): string | null {
  if (!lines) return null;
  const value = parseFrontMatter(["---", ...lines, "---", ""].join("\n"))?.fields.get(field);
  return value === undefined ? null : unquoteField(value);
}

function fileFrontMatterField(path: string, field: string): string | null {
  try {
    const value = parseFrontMatter(readFileSync(path, "utf8"))?.fields.get(field);
    return value === undefined ? null : unquoteField(value);
  } catch {
    return null;
  }
}

function safeGeneratedFields(fields: Record<string, string> | undefined): Record<string, string> {
  if (!fields) return {};
  const managed = new Set<string>(MANAGED_FRONT_MATTER_KEYS);
  return Object.fromEntries(Object.entries(fields).filter(([key]) => !managed.has(key) && /^[A-Za-z][A-Za-z0-9_-]*$/.test(key)));
}

export type VaultMutationResult =
  | { ok: true; slug?: string; path?: string }
  | { ok: false; reason: "missing" | "collision" | "invalid" };

function resolveFolderPath(root: string, folder: string): string | null {
  const parts = folder.split("/");
  if (parts.length === 0 || parts.some((part) => part === "" || part === "." || part === "..")) return null;
  const notesDir = join(root, NOTES_DIR);
  const candidate = join(notesDir, ...parts);
  const rel = relative(notesDir, candidate);
  return rel.startsWith("..") || isAbsolute(rel) || rel.length === 0 ? null : candidate;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Rewrite every wiki-link in the vault through `resolve`, which maps a stale
 * target to its replacement slug (or null to leave it alone).
 *
 * Two properties matter and are easy to get wrong:
 *
 * - **`updated` is not bumped.** A link repair is bookkeeping, not an edit to
 *   what the note says. Bumping it would reorder the entire vault by recency
 *   on the first repair pass and make "what changed lately" useless.
 * - **Lock-free.** Every caller already holds the vault lock (the queue is
 *   non-reentrant — see {@link LOCK_NS} — so taking it again here would wait
 *   on itself forever).
 *
 * Returns the note slugs that changed and the total number of links rewritten.
 */
async function rewriteVaultLinks(
  root: string,
  resolve: (target: string, noteSlug: string) => string | null,
): Promise<{ notes: string[]; links: number }> {
  const files = (await listNoteFiles(root)).filter(isMarkdown);
  const touched: string[] = [];
  let links = 0;
  for (const file of files) {
    const slug = file.slice(0, -".md".length);
    const path = resolveNotePath(root, slug);
    if (path === null) continue;
    const note = await getNote(root, slug);
    if (note === null) continue;
    const { body, changed } = rewriteLinks(note.body, (target) => resolve(target, slug));
    if (changed === 0) continue;

    // Splice the new body into the ORIGINAL file text rather than going
    // through `writeNote`.
    //
    // `writeNote` reserializes from the parsed note, and serialization is
    // lossy in ways that are harmless for an edit and unacceptable here: it
    // normalizes line endings and trailing whitespace. Those bytes can lie
    // inside the append-only `## Raw` tail, so a *link repair* — which must
    // not touch the tail at all — would rewrite a user's verbatim dictation.
    // `rewriteLinks` already guarantees it only edits offsets above the tail,
    // so replacing exactly that span preserves every other byte in the file.
    let original: string;
    try {
      original = await fs.readFile(path, "utf8");
    } catch {
      continue; // raced a delete
    }
    const at = original.lastIndexOf(note.body);
    if (at === -1) continue; // body not found verbatim; refuse rather than guess
    const next = original.slice(0, at) + body + original.slice(at + note.body.length);
    // Atomic replace where it is safe: rename cannot truncate a note on a
    // crash. A *file* symlink is the exception — renaming over it would
    // silently replace the link with a regular file and orphan the real
    // note — so those are written in place, through the link, as every other
    // vault write already does. (A symlinked *directory* is unaffected:
    // `path` then names a real file inside it.)
    const link = await fs.lstat(path).then((s) => s.isSymbolicLink(), () => false);
    if (link) {
      await fs.writeFile(path, next, "utf8");
    } else {
      const tmp = `${path}.weave-${process.pid}.tmp`;
      await fs.writeFile(tmp, next, "utf8");
      await fs.rename(tmp, path);
    }
    touched.push(slug);
    links += changed;
  }
  return { notes: touched, links };
}

/**
 * Point inbound links at a note's new home after a rename or move.
 *
 * This is the root cause of stale links: before this existed, every rename
 * silently broke every backlink pointing at the old slug, and the only repair
 * was an agent rereading the vault. One helper, called by all three movers.
 */
async function repointBacklinks(root: string, moves: ReadonlyMap<string, string>): Promise<void> {
  if (moves.size === 0) return;
  await rewriteVaultLinks(root, (target) => moves.get(target) ?? null);
}

/** The outcome of a vault-wide link repair. */
export interface LinkRepairResult {
  /** The audit the repair acted on (or would have, for a dry run). */
  audit: LinkAudit;
  /** Fixes actually written. Empty for a dry run. */
  applied: LinkFix[];
  /** Note slugs rewritten. */
  notes: string[];
}

/**
 * Audit the vault's wiki-links and, when `apply` is set, repair every
 * unambiguous one.
 *
 * Idempotent: a second run finds nothing, because the first turned each
 * stale target into a real slug. Ambiguous and unresolvable links are
 * reported and left exactly as they are — this function never guesses and
 * never invents a note.
 */
export async function repairVaultLinks(root: string, options: { apply?: boolean } = {}): Promise<LinkRepairResult> {
  // A dry run needs no lock: it writes nothing, and a report of a vault that
  // changed a millisecond later is no less true than one taken under a lock.
  if (options.apply !== true) {
    return { audit: auditLinks(await readVault(root)), applied: [], notes: [] };
  }
  // Applying does, and the audit has to happen *inside* it. Auditing first
  // and locking second leaves a window in which a concurrent rename or edit
  // invalidates a decision — a target that was unique when audited may be
  // ambiguous by the time it is written — and the stale fix would be applied
  // anyway, then reported as if it had been checked.
  return withVaultLock(root, async () => {
    const audit = auditLinks(await readVault(root));
    if (audit.fixable.length === 0) return { audit, applied: [], notes: [] };
    // Keyed by note, because the audit already decided per-note; the rewrite
    // obeys that decision rather than re-deriving it.
    const byNote = new Map<string, Map<string, string>>();
    for (const fix of audit.fixable) {
      const map = byNote.get(fix.slug) ?? new Map<string, string>();
      map.set(fix.from, fix.to);
      byNote.set(fix.slug, map);
    }
    const { notes } = await rewriteVaultLinks(root, (target, noteSlug) => byNote.get(noteSlug)?.get(target) ?? null);
    return { audit, applied: audit.fixable, notes };
  });
}

/**
 * Keep the on-disk `## Raw` tail whatever the body says — it is append-only.
 * `rawTailStart`, not `extractRawTail`: fence-aware, for untrusted input.
 */
function preserveRawTail(currentBody: string, nextBody: string): string {
  const tail = currentBody.slice(tailBoundary(currentBody)).trimEnd();
  const head = nextBody.slice(0, tailBoundary(nextBody)).trim();
  if (tail === "") return head;
  // An emptied head leaves the tail alone, not a leading blank line.
  return head === "" ? tail : `${head}\n\n${tail}`;
}

/** A `---` rule, alone on the line, with only blank space after it. */
const TAIL_RULE_RE = /(?:^|\n)-{3,}[ \t]*\r?\n\s*$/;

/**
 * Where the tail's text begins — the `---` rule, not the heading
 * `rawTailStart` returns. Splitting at the heading orphans the rule.
 */
function tailBoundary(body: string): number {
  const heading = rawTailStart(body, fenceRanges(body));
  if (heading === body.length) return heading;
  const rule = TAIL_RULE_RE.exec(body.slice(0, heading));
  if (rule === null) return heading;
  // `index` is the newline before the rule when there is one; step over it.
  return rule.index === 0 && !body.startsWith("\n") ? 0 : rule.index + 1;
}

/**
 * Replace a note's Markdown body; unknown front matter rides on
 * `note.frontMatter` and only `updated` moves. Last write wins — no
 * `expectedRevision`; docs/weave-workspace.md §11 P5.3 argues the trade.
 */
export async function setNoteBody(root: string, slug: string, body: string, now = new Date()): Promise<VaultMutationResult> {
  const path = resolveNotePath(root, slug);
  if (path === null) return { ok: false, reason: "invalid" };
  return withVaultLock(root, async () => {
    const note = await getNote(root, slug);
    if (note === null) return { ok: false, reason: "missing" };
    const next = preserveRawTail(note.body, body);
    await writeNote(path, slug, { ...note, updated: now.toISOString() }, next, note.frontMatter);
    return { ok: true, slug };
  });
}

/** Rename a note in place and keep its front-matter title in sync. */
export async function renameNote(root: string, slug: string, name: string, now = new Date()): Promise<VaultMutationResult> {
  const from = resolveNotePath(root, slug);
  const title = name.trim();
  if (from === null || title === "") return { ok: false, reason: "invalid" };
  const parent = slug.split("/").slice(0, -1).join("/");
  const target = [...(parent === "" ? [] : [parent]), slugify(title)].join("/");
  const to = resolveNotePath(root, target);
  if (to === null) return { ok: false, reason: "invalid" };
  return withVaultLock(root, async () => {
    const note = await getNote(root, slug);
    if (note === null) return { ok: false, reason: "missing" };
    if (from !== to && await exists(to)) return { ok: false, reason: "collision" };
    if (from !== to) await fs.rename(from, to);
    await writeNote(to, target, { ...note, title, updated: now.toISOString() }, note.body, note.frontMatter);
    if (from !== to) await repointBacklinks(root, new Map([[slug, target]]));
    return { ok: true, slug: target };
  });
}

/** Move a note to an existing vault folder, or to the vault root with `null`. */
export async function moveNote(root: string, slug: string, folder: string | null): Promise<VaultMutationResult> {
  const from = resolveNotePath(root, slug);
  if (from === null) return { ok: false, reason: "invalid" };
  const targetDir = folder === null ? join(root, NOTES_DIR) : resolveFolderPath(root, folder);
  if (targetDir === null || !(await isDirectory(targetDir))) return { ok: false, reason: "missing" };
  const target = folder === null ? basename(slug) : `${folder}/${basename(slug)}`;
  const to = resolveNotePath(root, target);
  if (to === null) return { ok: false, reason: "invalid" };
  return withVaultLock(root, async () => {
    if (!(await exists(from))) return { ok: false, reason: "missing" };
    if (from === to) return { ok: true, slug };
    if (await exists(to)) return { ok: false, reason: "collision" };
    await fs.rename(from, to);
    await repointBacklinks(root, new Map([[slug, target]]));
    return { ok: true, slug: target };
  });
}

/** Permanently delete one note. */
export async function deleteNote(root: string, slug: string): Promise<VaultMutationResult> {
  const path = resolveNotePath(root, slug);
  if (path === null) return { ok: false, reason: "invalid" };
  return withVaultLock(root, async () => {
    if (!(await exists(path))) return { ok: false, reason: "missing" };
    await fs.unlink(path);
    return { ok: true };
  });
}

/** Rename a vault folder without changing its parent. */
export async function renameFolder(root: string, folder: string, name: string): Promise<VaultMutationResult> {
  const from = resolveFolderPath(root, folder);
  const title = name.trim();
  if (from === null || title === "") return { ok: false, reason: "invalid" };
  const parent = folder.split("/").slice(0, -1).join("/");
  const target = [...(parent === "" ? [] : [parent]), slugify(title)].join("/");
  const to = resolveFolderPath(root, target);
  if (to === null) return { ok: false, reason: "invalid" };
  return withVaultLock(root, async () => {
    if (!(await isDirectory(from))) return { ok: false, reason: "missing" };
    if (from !== to && await exists(to)) return { ok: false, reason: "collision" };
    if (from === to) return { ok: true, path: target };
    // Every note under the folder changes slug, so the whole subtree's
    // backlinks move with it — collected before the rename, while the old
    // paths still exist.
    const moved = (await listNoteFiles(root))
      .filter((f) => isMarkdown(f) && f.startsWith(`${folder}/`))
      .map((f) => f.slice(0, -".md".length));
    await fs.rename(from, to);
    await repointBacklinks(root, new Map(moved.map((s) => [s, `${target}/${s.slice(folder.length + 1)}`])));
    return { ok: true, path: target };
  });
}

/** Permanently delete a vault folder and its contents. */
export async function deleteFolder(root: string, folder: string): Promise<VaultMutationResult> {
  const path = resolveFolderPath(root, folder);
  if (path === null) return { ok: false, reason: "invalid" };
  return withVaultLock(root, async () => {
    if (!(await isDirectory(path))) return { ok: false, reason: "missing" };
    await fs.rm(path, { recursive: true });
    return { ok: true };
  });
}

/** Create a new vault folder. */
export async function createFolder(root: string, folder: string): Promise<VaultMutationResult> {
  const trimmed = folder.trim();
  if (trimmed === "") return { ok: false, reason: "invalid" };
  const rawParts = trimmed.split("/").map((p) => p.trim()).filter((p) => p.length > 0);
  if (rawParts.length === 0 || rawParts.some((p) => p === "." || p === "..")) return { ok: false, reason: "invalid" };
  const parts = rawParts.map(slugify).filter((p) => p.length > 0);
  if (parts.length === 0) return { ok: false, reason: "invalid" };
  const target = parts.join("/");
  const to = resolveFolderPath(root, target);
  if (to === null) return { ok: false, reason: "invalid" };
  return withVaultLock(root, async () => {
    if (await exists(to)) return { ok: false, reason: "collision" };
    await fs.mkdir(to, { recursive: true });
    return { ok: true, path: target };
  });
}

async function listVaultEntries(root: string): Promise<{ files: string[]; folders: string[] }> {
  const dir = join(root, NOTES_DIR);
  const files: string[] = [];
  const folders: string[] = [];
  const seen = new Set<string>();
  async function walk(prefix: string, includeFolders = true): Promise<boolean> {
    const path = prefix.length > 0 ? join(dir, prefix) : dir;
    let realPath: string;
    let entries;
    try {
      realPath = await fs.realpath(path);
      if (seen.has(realPath)) return false;
      seen.add(realPath);
      entries = await fs.readdir(path, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const child = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const stat = await fs.stat(join(dir, child));
          isDirectory = stat.isDirectory();
          isFile = stat.isFile();
        } catch {
          continue;
        }
      }
      if (isDirectory) {
        const visible = includeFolders && !entry.name.startsWith(".");
        if ((await walk(child, visible)) && visible) folders.push(child);
      } else if (isFile && isVaultArtifact(entry.name)) {
        files.push(child);
      }
    }
    return true;
  }
  await walk("");
  return { files: files.sort(), folders: folders.sort() };
}

async function listNoteFiles(root: string): Promise<string[]> {
  return (await listVaultEntries(root)).files;
}

function isMarkdown(path: string): boolean {
  return path.endsWith(".md");
}

function isHtml(path: string): boolean {
  return path.toLowerCase().endsWith(".html") || path.toLowerCase().endsWith(".htm");
}

function isVaultArtifact(path: string): boolean {
  return isMarkdown(path) || isHtml(path);
}

/** Resolve a vault-relative HTML path without allowing traversal. */
export function resolveHtmlPath(root: string, slug: string): string | null {
  if (slug.trim().length === 0 || !isHtml(slug)) return null;
  const notesDir = join(root, NOTES_DIR);
  const candidate = join(notesDir, slug);
  const rel = relative(notesDir, candidate);
  return rel.startsWith("..") || isAbsolute(rel) || rel.length === 0 ? null : candidate;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)));
}

function htmlTagValue(text: string, tag: string): string {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(text);
  return match?.[1] === undefined ? "" : decodeHtml(match[1].replace(/<[^>]+>/g, "").trim());
}

function htmlMeta(text: string, name: string): string {
  for (const match of text.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = match[1] ?? "";
    const get = (key: string): string => {
      const value = new RegExp(`\\b${key}\\s*=\\s*([\\\"'])(.*?)\\1`, "i").exec(attrs);
      return value?.[2] ? decodeHtml(value[2].trim()) : "";
    };
    if (get("name").toLowerCase() === name.toLowerCase()) return get("content");
  }
  return "";
}

/** Parse metadata from an HTML file without attempting to interpret its body. */
export function parseHtmlArtifact(slug: string, text: string, updated = "", size = Buffer.byteLength(text)): HtmlArtifact {
  const comment = /<!--[\s\S]*?---\n([\s\S]*?)\n---[\s\S]*?-->/m.exec(text);
  const fields = comment ? parseFrontMatter(`---\n${comment[1]}\n---\n`)?.fields : undefined;
  const fallback = basename(slug).replace(/\.html?$/i, "").replace(/[-_]+/g, " ");
  return {
    slug,
    title: fields?.get("title") ? unquoteField(fields.get("title")!) : htmlTagValue(text, "title") || fallback,
    description: fields?.get("description")
      ? unquoteField(fields.get("description")!)
      : htmlMeta(text, "description"),
    updated,
    size,
  };
}

/** Read one HTML artifact by its vault-relative path. */
export async function getHtmlArtifact(root: string, slug: string): Promise<HtmlArtifact | null> {
  const path = resolveHtmlPath(root, slug);
  if (!path) return null;
  try {
    const [text, st] = await Promise.all([fs.readFile(path, "utf8"), fs.stat(path)]);
    return parseHtmlArtifact(slug, text, st.mtime.toISOString(), st.size);
  } catch {
    return null;
  }
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
  return (await listVaultEntries(root)).folders;
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
  /** Readable standalone HTML/HTM artifacts. */
  artifacts?: HtmlArtifact[];
  /** Number of HTML/HTM files present, including malformed files. */
  artifactCount?: number;
}

/** Read the whole vault in one pass: one readdir, one read per note. */
export async function readVault(root: string): Promise<VaultSnapshot> {
  const { files, folders } = await listVaultEntries(root);
  const notes: Note[] = [];
  const artifacts: HtmlArtifact[] = [];
  for (const file of files) {
    if (isMarkdown(file)) {
      const note = await getNote(root, file.slice(0, -".md".length));
      if (note) notes.push(note);
    } else if (isHtml(file)) {
      const artifact = await getHtmlArtifact(root, file);
      if (artifact) artifacts.push(artifact);
    }
  }
  const artifactCount = files.filter(isHtml).length;
  return {
    notes: notes.sort(byUpdatedDesc),
    fileCount: files.filter(isMarkdown).length,
    ...(folders.length > 0 ? { folders } : {}),
    ...(artifacts.length > 0 ? { artifacts: artifacts.sort(byUpdatedDesc) } : {}),
    ...(artifactCount > 0 ? { artifactCount } : {}),
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
        return { slug: isMarkdown(file) ? file.slice(0, -".md".length) : file, path, mtimeMs: st.mtimeMs, size: st.size };
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
  return (await listNoteFiles(root)).filter(isMarkdown).length;
}

/**
 * Substring search over slug, title, tags, and body.
 * Score tiers keep identity above repetition: exact slug/title = 100,
 * partial slug/title = 30, tag = 20, body = 1 each (capped at 5).
 * Case-insensitive. Deterministic ordering: score desc, then slug asc.
 */
export async function searchNotes(root: string, query: string): Promise<NoteSearchHit[]> {
  const q = query.toLowerCase().trim();
  if (q.length === 0) return [];

  const hits: NoteSearchHit[] = [];
  // One pass: `listNotes` + a `getNote` per slug would read every file twice.
  for (const note of (await readVault(root)).notes) {
    let score = 0;
    const title = note.title.toLowerCase();
    const slug = note.slug.toLowerCase();
    if (title === q || slug === q) score += 100;
    else if (title.includes(q) || slug.includes(q)) score += 30;
    if (note.tags.some((t) => t.toLowerCase().includes(q))) score += 20;

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
