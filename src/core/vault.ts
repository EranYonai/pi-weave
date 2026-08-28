import { existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  MANAGED_FRONT_MATTER_KEYS,
  parseFrontMatter,
  parseNoteFile,
  quoteField,
  serializeNote,
  upsertFrontMatterFields,
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
 * (subdirectories *within* it are legitimate — the sessions collection).
 */
export function resolveNotePath(root: string, slug: string): string | null {
  if (slug.trim().length === 0) return null;
  const notesDir = join(root, NOTES_DIR);
  const candidate = join(notesDir, `${slug}.md`);
  const rel = relative(notesDir, candidate);
  // Slugs may nest (`sessions/foo`) — that is how session memory stays in an
  // inner folder of the vault graph (docs/session-scan.md) — but they may
  // never escape the collection: `..` segments and absolute paths resolve
  // outside notes/ and are rejected here, at the one door every read and
  // write walks through.
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
  // Path-slugs (`sessions/foo`) may introduce a new subdirectory; every
  // write path funnels through here, so this is the one mkdir that matters.
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
 * Paths are locked in a fixed (sorted) order, which is what makes the
 * two-path case — `renameNote`, the only operation touching two files —
 * deadlock-free. Two concurrent renames in opposite directions (`a→b` and
 * `b→a`) would otherwise be able to take one lock each and wait forever;
 * with a total order on acquisition, one of them takes both and the other
 * takes neither.
 *
 * Every mutation in this module goes through here, not just the new ones. A
 * queue that half the writers ignore serializes nothing: an `appendToNote`
 * racing an `updateNote` on the same file is a lost update whether or not
 * the update took a lock.
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

// ---------------------------------------------------------------------------
// Mutation APIs (weave-workspace §11 P5.2, P5.3)
// ---------------------------------------------------------------------------

/**
 * A note plus the stamp that identifies the on-disk state it was read from.
 *
 * The read half of the conflict primitive (§11 P5.3). An editor reads this,
 * holds `revision` for as long as the user is typing, and hands it back on
 * save; a `revision` that no longer matches the file means someone else — a
 * `weave_note` tool call, `$EDITOR`, an Obsidian sync — wrote in between.
 */
export interface RevisionedNote {
  note: Note;
  /**
   * Opaque version stamp. **Compare it, do not interpret it.**
   *
   * It is currently `mtimeMs:size`, and the shape is deliberately not part
   * of the contract: a caller that parses out the mtime is a caller that
   * breaks when this becomes a content hash. Two fields rather than one
   * because mtime alone has a real blind spot — the filesystem timestamp
   * granularity. Two writes inside the same millisecond are indistinguishable
   * by mtime, and "same millisecond" is not exotic when the writer is a
   * program rather than a human; a size change catches the common case of
   * such a pair differing in length.
   *
   * This does not make it a perfect detector. A same-millisecond write that
   * preserves the byte count is invisible, which is the honest limitation of
   * any stat-based scheme, and the reason this is typed as opaque: upgrading
   * it to a digest is then a change here and nowhere else.
   */
  revision: string;
}

function revisionOf(st: { mtimeMs: number; size: number }): string {
  return `${st.mtimeMs}:${st.size}`;
}

/**
 * Read a note together with its {@link RevisionedNote.revision}.
 *
 * Stat-then-read rather than read-then-stat: if a writer lands between the
 * two calls, the revision is of the *older* state than the content, so the
 * save that follows sees a mismatch and is rejected. The opposite order
 * yields a revision newer than the content, which would let a stale body be
 * written back under a revision that looks current — failing safe versus
 * failing silently.
 */
export async function getNoteWithRevision(root: string, slug: string): Promise<RevisionedNote | null> {
  const path = resolveNotePath(root, slug);
  if (!path) return null;
  let revision: string;
  try {
    revision = revisionOf(await fs.stat(path));
  } catch {
    return null;
  }
  const note = await getNote(root, slug);
  return note === null ? null : { note, revision };
}

/**
 * Why a mutation did not happen. The server maps these to status codes —
 * `"missing"` → 404, `"conflict"` → 409, `"collision"` → 409 — but the
 * mapping is the server's business; core reports the *situation* (§11 P5.3).
 */
export type MutationFailure =
  /** No such note, or a slug that failed the traversal guard. */
  | { ok: false; reason: "missing" }
  /** The file moved since `expectedRevision` was read. */
  | { ok: false; reason: "conflict"; current: RevisionedNote }
  /** A rename whose destination slug is already taken. */
  | { ok: false; reason: "collision"; slug: string };

export type MutationResult = { ok: true; note: Note } | MutationFailure;

/** A successful delete, or why it did not happen. */
export type DeleteResult = { ok: true } | { ok: false; reason: "missing" };

export interface UpdateNoteInput {
  /** Replacement Markdown body. Omit to change only metadata. */
  body?: string;
  /**
   * Metadata to merge over the note's current values. `created` is not
   * accepted: it records when the note came into existence, and an edit is
   * not a re-creation.
   */
  meta?: Partial<Pick<NoteMeta, "title" | "tags" | "source">>;
  /**
   * The {@link RevisionedNote.revision} the caller last read. When supplied
   * and no longer current, the write is refused with `reason: "conflict"`
   * and the caller is handed the note as it now is, so a UI can offer
   * reload-or-overwrite without a second round trip. Omit for
   * last-write-wins.
   */
  expectedRevision?: string;
  /** Injectable clock for tests. */
  now?: Date;
}

/**
 * Check `expectedRevision` against the file, inside the caller's lock.
 *
 * Returns the conflict to report, or null to proceed. Being inside the lock
 * is the whole point: a check-then-write with the check outside the mutex is
 * a race with a wider window than no check at all, because it looks like it
 * is doing something.
 */
async function checkRevision(
  root: string,
  slug: string,
  expected: string | undefined,
): Promise<MutationFailure | null> {
  if (expected === undefined) return null;
  const current = await getNoteWithRevision(root, slug);
  if (current === null) return { ok: false, reason: "missing" };
  return current.revision === expected ? null : { ok: false, reason: "conflict", current };
}

/**
 * Update a note's body and/or metadata in place.
 *
 * Preserves unknown front-matter keys (they ride on `note.frontMatter`
 * through `writeNote`) and, when `body` is given, the append-only `## Raw`
 * tail: the replacement body is treated as the *editorial* region above the
 * tail, exactly as `finalizeNote` treats it. A caller replacing the body of
 * a dictated note therefore cannot delete the user's verbatim scribbles by
 * omitting them, which is the one thing `docs/notepad.md` §4 says must never
 * happen. A body that already carries its own `## Raw` tail is written as
 * given, so a round-trip through an editor that shows the whole file is not
 * penalised with a duplicated tail.
 *
 * `updated` is bumped on every successful call, including a metadata-only
 * one — a tag change is a change to the note.
 */
export async function updateNote(
  root: string,
  slug: string,
  input: UpdateNoteInput,
  now: Date = new Date(),
): Promise<MutationResult> {
  const path = resolveNotePath(root, slug);
  if (!path) return { ok: false, reason: "missing" };
  return withNoteLocks([path], async () => {
    const conflict = await checkRevision(root, slug, input.expectedRevision);
    if (conflict) return conflict;
    const note = await getNote(root, slug);
    if (!note) return { ok: false, reason: "missing" };

    const body = input.body === undefined ? note.body : preserveRawTail(note.body, input.body);
    const meta: NoteMeta = {
      ...note,
      ...input.meta,
      updated: (input.now ?? now).toISOString(),
    };
    return { ok: true, note: await writeNote(path, slug, meta, body, note.frontMatter) };
  });
}

/** Re-attach the existing `## Raw` tail unless the replacement already has one. */
function preserveRawTail(currentBody: string, nextBody: string): string {
  const tail = extractRawTail(currentBody);
  if (tail === "" || extractRawTail(nextBody) !== "") return nextBody.trim();
  return nextBody.trim() + `\n\n${tail}`;
}

/**
 * Rename a note: move `oldSlug.md` to `newSlug.md`.
 *
 * `newSlug` is passed through `slugify`, so a caller may hand over either a
 * slug or a human title and get the same filesystem-safe result the rest of
 * the vault uses.
 *
 * ## Inbound `[[wikilinks]]` are deliberately NOT rewritten
 *
 * A rename can break links from other notes, and there are two honest
 * options. Rewriting every referring note is the bigger hammer, and it is
 * the wrong one here:
 *
 * - **It is a multi-file write with no transaction.** Renaming one note
 *   would rewrite N others; a failure partway leaves the vault half-updated,
 *   and there is no rollback. Trading one dangling link for an unknown
 *   number of half-edited files is a bad trade.
 * - **It edits prose to fix an index.** A wikilink lives in body text a
 *   human wrote, sometimes inside a quote, a code fence, or a `## Raw` tail
 *   that `docs/notepad.md` declares append-only and verbatim. A textual
 *   substitution across the vault cannot honour that; a rename would become
 *   the one operation allowed to modify preserved user input.
 * - **The alternative is already visible, not silent.** Dangling targets are
 *   a first-class concept: `buildGraph` collects `danglingLinks`, the wire
 *   payload ships them as `dangling`, and the note column renders an
 *   unresolved wikilink as an unfollowable ghost. A stale link therefore
 *   shows up in the UI as something to fix, which is a better failure than a
 *   silent bulk edit the user cannot review.
 *
 * So: renaming leaves inbound links pointing at the old slug, where they
 * render as dangling. If link-following-a-rename is wanted later, the right
 * shape is an explicit, previewable "update N referring notes?" step — a
 * separate operation the user opts into, not a side effect of this one.
 */
export async function renameNote(
  root: string,
  oldSlug: string,
  newSlug: string,
  now: Date = new Date(),
): Promise<MutationResult> {
  const from = resolveNotePath(root, oldSlug);
  if (!from) return { ok: false, reason: "missing" };
  const target = slugify(newSlug);
  const to = resolveNotePath(root, target);
  // `slugify` cannot emit a traversing slug, but the guard is applied anyway:
  // "this input is already safe" is exactly the assumption that stops being
  // true when someone changes the other function.
  if (!to) return { ok: false, reason: "missing" };
  if (target === oldSlug) {
    const note = await getNote(root, oldSlug);
    return note === null ? { ok: false, reason: "missing" } : { ok: true, note };
  }

  return withNoteLocks([from, to], async () => {
    const note = await getNote(root, oldSlug);
    if (!note) return { ok: false, reason: "missing" };
    // Refuse rather than uniquify: `addNote` may silently pick `decision-2`
    // because nobody named a file there, but a rename onto an existing note
    // is a user mistake, and quietly landing somewhere other than where they
    // asked hides it. `fs.rename` would overwrite the destination outright.
    if (await exists(to)) return { ok: false, reason: "collision", slug: target };

    await fs.rename(from, to);
    // The slug is the note's identity, so a rename is a change to the note.
    const meta: NoteMeta = { ...note, updated: now.toISOString() };
    return { ok: true, note: await writeNote(to, target, meta, note.body, note.frontMatter) };
  });
}

/**
 * Delete a note. **Hard delete** — the file is unlinked.
 *
 * No trash directory, and that is a deliberate omission rather than an
 * oversight. A trash is a real feature: it needs a location that does not
 * pollute `notes/` (everything there is indexed and graphed), a retention
 * policy, a restore path, and an answer for what happens when a deleted slug
 * is later reused. Inventing all of that as a side effect of "P5 needs a
 * delete button" is how a vault grows a second, undocumented store of notes
 * that the index does not know about — and AGENTS.md rule 5 says nothing in
 * `.okf` may be the only copy of anything, which cuts both ways: a
 * half-designed trash becomes exactly such a place.
 *
 * The vault is plain files in a directory most users keep under version
 * control or a synced folder, so the recovery story is the one they already
 * have and understand. If a trash is wanted, it should arrive as its own
 * design decision with those questions answered.
 */
export async function deleteNote(root: string, slug: string): Promise<DeleteResult> {
  const path = resolveNotePath(root, slug);
  if (!path) return { ok: false, reason: "missing" };
  return withNoteLocks([path], async () => {
    try {
      await fs.unlink(path);
      return { ok: true };
    } catch {
      // Already gone, or never existed. Both are "there is no such note",
      // which is the caller's question — not "the unlink syscall failed".
      return { ok: false, reason: "missing" };
    }
  });
}

// ---------------------------------------------------------------------------
// Generated-note upsert (weave-scan sessions; docs/session-scan.md)
// ---------------------------------------------------------------------------

export interface UpsertNoteInput {
  /** Desired slug (already slug-safe); uniquified (`-2`, `-3`…) when creating. */
  slug: string;
  title: string;
  body: string;
  tags?: string[];
  /** Defaults to `"generated"` — the safe direction for AGENTS.md rule 4. */
  source?: NoteSource;
  /**
   * Extra **owned scalar** front-matter fields (e.g. `session_hash`) upserted
   * on every write. Managed keys and syntactically unsafe keys are silently
   * dropped: the note engine owns those, and this function will not fight it.
   */
  fields?: Record<string, string>;
  /**
   * Content identity of the generated note, when the slug alone must not
   * decide ownership: on the create path, a candidate slug already occupied
   * by a note carrying a **different** identity value is skipped (the slug
   * uniquifies to `-2`, `-3`…), while a same-identity occupant is treated as
   * ours. Without this, two generated artifacts that derive the same slug —
   * two sessions that began with the same first message, say — would have
   * the second silently overwrite the first, marker keys and all.
   */
  identity?: { field: string; value: string };
  /** Injectable clock for tests. */
  now?: Date;
}

/**
 * Idempotently create-or-update a note, for generated knowledge that is
 * re-derivable from a source of truth (a session transcript, a scan) and
 * keyed by content the note carries in its front matter.
 *
 * - **Create** (no file at `slug`): canonical managed block plus the extra
 *   fields, body as given, `created` = `updated` = now. The slug is passed
 *   through `uniqueSlug`, so a taken slug shifts to `-2` rather than
 *   overwriting a note the caller could not see.
 * - **Update** (file exists): replace the body and the extra fields, bump
 *   `updated`, and change nothing else — `title`, `created`, `tags`, unknown
 *   front-matter keys, and the append-only `## Raw` tail all survive, per
 *   the vault's round-trip guarantees. Title and tags are deliberately
 *   creation-time values: the human may have retitled or retagged the note,
 *   and a re-scan must not clobber that.
 *
 * Both paths hold the notes-**directory** lock (like `addNote`): the create
 * path runs a check-then-create slug allocation that must be atomic, and the
 * update path's `getNote`-then-write is the same lost-update window.
 */
export async function upsertNote(root: string, input: UpsertNoteInput): Promise<Note> {
  await ensureVault(root);
  return withNoteLocks([join(root, NOTES_DIR)], async () => {
    const now = (input.now ?? new Date()).toISOString();
    const noteAt = (slug: string) => notePath(root, slug);
    const identity = input.identity;
    let existing = await getNote(root, input.slug);
    if (
      existing !== null &&
      identity &&
      fieldFromFrontMatter(existing.frontMatter, identity.field) !== identity.value
    ) {
      // The note at this slug belongs to a different identity (or to no
      // identity at all — a human note): never update it in place. Fall
      // through to the create path, whose guard picks the next free slug.
      existing = null;
    }
    if (existing === null) {
      const slug = uniqueSlug(input.slug, (candidate) => {
        if (!existsSync(noteAt(candidate))) return false; // free
        if (!identity) return true; // slug ownership is the caller's problem
        return occupantIdentity(root, candidate, identity.field) !== identity.value;
      });
      const meta: NoteMeta = {
        title: input.title,
        created: now,
        updated: now,
        tags: input.tags ?? [],
        source: input.source ?? "generated",
      };
      // The managed lines below are re-rendered from `meta` by `serializeNote`
      // (replayBlock substitutes rendered values for managed keys in place);
      // spelling them here just fixes the block's key order.
      const fields = sanitizeUpsertFields(input.fields);
      const frontMatter = [
        `title: ${quoteField(meta.title)}`,
        `created: ${meta.created}`,
        `updated: ${meta.updated}`,
        `tags: [${meta.tags.map(quoteField).join(", ")}]`,
        `source: ${meta.source}`,
        ...upsertFrontMatterFields([], fields),
      ];
      return writeNote(noteAt(slug), slug, meta, input.body, frontMatter);
    }
    const meta: NoteMeta = { ...existing, updated: now };
    const fields = sanitizeUpsertFields(input.fields);
    const frontMatter = upsertFrontMatterFields(existing.frontMatter ?? [], fields);
    const body = preserveRawTail(existing.body, input.body);
    return writeNote(noteAt(input.slug), input.slug, meta, body, frontMatter);
  });
}

/**
 * The identity value carried in a note's own front-matter block, or null when
 * absent — an absent identity never matches, so unmarked notes are never
 * claimed as ours.
 */
function fieldFromFrontMatter(lines: NoteFrontMatter | undefined, field: string): string | null {
  if (!lines) return null;
  const parsed = parseFrontMatter(["---", ...lines, "---", ""].join("\n"));
  if (!parsed) return null;
  return parsed.fields.get(field) ?? null;
}

/**
 * The identity value a note at `slug` carries in its front matter, or null
 * when the file is missing, malformed, or does not declare the field — a
 * null never equals a real identity value, so such a file blocks the slug.
 */
function occupantIdentity(root: string, slug: string, field: string): string | null {
  let text: string;
  try {
    text = readFileSync(notePath(root, slug), "utf8");
  } catch {
    return null;
  }
  const parsed = parseFrontMatter(text);
  if (!parsed) return null;
  return parsed.fields.get(field) ?? null;
}

/**
 * Drop fields this function has no business writing: managed keys (the note
 * engine renders those from `NoteMeta`) and keys that are not plain scalar
 * identifiers (a hostile key could smuggle newlines or `---` into the block).
 * Values are guarded by `quoteField` at render time.
 */
function sanitizeUpsertFields(fields: Record<string, string> | undefined): Record<string, string> {
  if (!fields) return {};
  const managed = new Set<string>(MANAGED_FRONT_MATTER_KEYS);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (managed.has(key)) continue;
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) continue;
    out[key] = value;
  }
  return out;
}

async function listNoteFiles(root: string): Promise<string[]> {
  const dir = join(root, NOTES_DIR);
  const out: string[] = [];
  // Recursive by design: vault notes may nest (`sessions/<name>` — session
  // memory lives in an inner folder of the graph, docs/session-scan.md), and
  // every consumer above this function (list, search, graph, cache) speaks
  // in slugs, so the relative path *is* the slug.
  async function walk(prefix: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(prefix.length > 0 ? join(dir, prefix) : dir, { withFileTypes: true });
    } catch {
      return; // missing vault — nothing to list
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await walk(prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const slug = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
        out.push(slug);
      }
    }
  }
  await walk("");
  return out.sort();
}

/**
 * Derive the list-shaped summary of a note (drops the body, keeps its length).
 *
 * `frontMatter` is dropped along with the body, and explicitly rather than by
 * omission: a spread is exempt from TypeScript's excess-property check, so
 * carrying it would type-check fine and then ship every note's raw metadata
 * block through `listNotes` into the search results and the wire payload —
 * a field no consumer reads, on a shape the contract test pins.
 * Preservation is a property of the *write* path re-reading the file, not of
 * summaries carrying it around.
 */
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
}

/** Read the whole vault in one pass: one readdir, one read per note. */
export async function readVault(root: string): Promise<VaultSnapshot> {
  const files = await listNoteFiles(root);
  const notes: Note[] = [];
  for (const file of files) {
    const note = await getNote(root, file.slice(0, -".md".length));
    if (!note) continue; // unreadable/malformed files are skipped, not fatal
    notes.push(note);
  }
  return { notes: notes.sort(byUpdatedDesc), fileCount: files.length };
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
