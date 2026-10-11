import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { OKF_MANIFEST } from "./paths";

/**
 * Note history: a copy of every note after every change, so the viewer can
 * replay how a note was written from its first words to now.
 *
 * ## Why a log file and not git
 *
 * The vault is not guaranteed to be a git repository, and when it is, the
 * repository belongs to the user: committing on every append would bury their
 * own history under ours. A plain append-only file per note keeps the
 * project's rule that knowledge lives in readable files, needs no binary, and
 * travels with the vault (the backup ZIP walks the whole vault root).
 *
 * ## Format
 *
 * `<vault>/history/<slug>.jsonl`, one JSON object per revision, oldest first.
 * A revision is either a full copy of the body (`full`) or a delta against
 * the revision before it: keep `keep[0]` characters from the start and
 * `keep[1]` from the end, and put `text` between them. Appends and small
 * edits cost a few bytes. Every {@link KEYFRAME_EVERY}th revision is full, so
 * one damaged line cannot take the rest of the log with it.
 *
 * Bodies only, not front matter: the `updated` stamp changes on every write
 * and would turn every delta into a copy of the whole file.
 *
 * ## Who wrote it
 *
 * Every write path in `vault.ts` says who is writing. An edit made outside
 * pi-weave (an editor, a sync tool) is noticed the next time pi-weave writes
 * or replays the note: the body on disk no longer matches the last revision,
 * so it is recorded as an `outside` revision before anything else.
 *
 * ## Off switch
 *
 * `"history": false` in the vault's `okf.json` stops recording. Existing logs
 * are kept, and nothing is recorded while it is off — including outside edits.
 */

export const HISTORY_DIR = "history";
const LOG_EXT = ".jsonl";
/** A full copy every this many revisions bounds the damage of a bad line. */
export const KEYFRAME_EVERY = 32;

/** Who made a change. `outside` is any editor other than pi-weave. */
export type HistoryAuthor = "human" | "agent" | "outside" | "system";
export const HISTORY_AUTHORS: readonly HistoryAuthor[] = ["human", "agent", "outside", "system"];

/** What kind of change it was. `baseline` is a note as history first found it. */
export type HistoryOp =
  | "create"
  | "edit"
  | "append"
  | "raw"
  | "finalize"
  | "generate"
  | "repair"
  | "outside"
  | "baseline";
export const HISTORY_OPS: readonly HistoryOp[] = [
  "create",
  "edit",
  "append",
  "raw",
  "finalize",
  "generate",
  "repair",
  "outside",
  "baseline",
];

/** One revision of a note, with its body reconstructed. */
export interface NoteRevision {
  /** ISO-8601 time of the change. */
  at: string;
  by: HistoryAuthor;
  op: HistoryOp;
  body: string;
}

/** A line of the log, as stored. */
interface LogEntry {
  at: string;
  by: HistoryAuthor;
  op: HistoryOp;
  full?: string;
  keep?: [number, number];
  text?: string;
}

/** The note body as it stood before a write, and when it got that way. */
export interface PriorBody {
  body: string;
  at: string;
}

export interface RecordInput {
  by: HistoryAuthor;
  op: HistoryOp;
  /** The body before this write; null for a brand-new note. */
  before: PriorBody | null;
  /** The body after this write. */
  after: string;
  at: Date;
}

/** Resolve a note's log path, or null when the slug would escape the log directory. */
export function historyPath(root: string, slug: string): string | null {
  if (slug.trim().length === 0) return null;
  const dir = join(root, HISTORY_DIR);
  const candidate = join(dir, `${slug}${LOG_EXT}`);
  const rel = relative(dir, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return candidate;
}

function folderPath(root: string, folder: string): string | null {
  const parts = folder.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  return join(root, HISTORY_DIR, ...parts);
}

// --- settings ----------------------------------------------------------------

async function readManifest(root: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(join(root, OKF_MANIFEST), "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Whether revisions are being recorded. On unless `okf.json` says `"history": false`. */
export async function historyEnabled(root: string): Promise<boolean> {
  return (await readManifest(root))?.["history"] !== false;
}

/** Turn recording on or off, keeping every other manifest field. */
export async function setHistoryEnabled(root: string, enabled: boolean): Promise<void> {
  const manifest = (await readManifest(root)) ?? { okfVersion: 1, scope: "vault" };
  manifest["history"] = enabled;
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(join(root, OKF_MANIFEST), JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

// --- the log -------------------------------------------------------------------

function isEntry(value: unknown): value is LogEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry["at"] !== "string") return false;
  if (!HISTORY_AUTHORS.includes(entry["by"] as HistoryAuthor)) return false;
  if (!HISTORY_OPS.includes(entry["op"] as HistoryOp)) return false;
  if (typeof entry["full"] === "string") return true;
  const keep = entry["keep"];
  return (
    Array.isArray(keep) &&
    keep.length === 2 &&
    keep.every((n) => Number.isInteger(n) && (n as number) >= 0) &&
    typeof entry["text"] === "string"
  );
}

/**
 * Replay a log into revisions. A line that is not JSON, or a delta that does
 * not fit the body before it, is skipped, and so is every delta after it up
 * to the next full copy: guessing would show the user text nobody wrote.
 *
 * With `lastOnly`, only the newest revision is kept. Recording a write needs
 * nothing else, and keeping every body would cost the sum of all of them.
 */
function replay(text: string, lastOnly = false): NoteRevision[] {
  const revisions: NoteRevision[] = [];
  let body: string | null = null;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      body = null;
      continue;
    }
    if (!isEntry(entry)) {
      body = null;
      continue;
    }
    if (entry.full !== undefined) {
      body = entry.full;
    } else if (body !== null) {
      const [head, tail] = entry.keep as [number, number];
      if (head + tail > body.length) {
        body = null;
        continue;
      }
      body = body.slice(0, head) + (entry.text as string) + body.slice(body.length - tail);
    } else {
      continue;
    }
    if (lastOnly) revisions.length = 0;
    revisions.push({ at: entry.at, by: entry.by, op: entry.op, body });
  }
  return revisions;
}

async function readLog(path: string, lastOnly = false): Promise<{ revisions: NoteRevision[]; lines: number }> {
  let text: string;
  try {
    text = await fs.readFile(path, "utf8");
  } catch {
    return { revisions: [], lines: 0 };
  }
  return { revisions: replay(text, lastOnly), lines: text.split("\n").filter((line) => line.trim() !== "").length };
}

/** The smallest prefix/suffix-preserving edit that turns `from` into `to`. */
export function diffBodies(from: string, to: string): { keep: [number, number]; text: string } {
  const max = Math.min(from.length, to.length);
  let head = 0;
  while (head < max && from.charCodeAt(head) === to.charCodeAt(head)) head++;
  let tail = 0;
  while (tail < max - head && from.charCodeAt(from.length - 1 - tail) === to.charCodeAt(to.length - 1 - tail)) tail++;
  return { keep: [head, tail], text: to.slice(head, to.length - tail) };
}

function entryFor(
  meta: { at: string; by: HistoryAuthor; op: HistoryOp },
  previous: string | null,
  body: string,
  index: number,
): LogEntry {
  if (previous === null || index % KEYFRAME_EVERY === 0) return { ...meta, full: body };
  return { ...meta, ...diffBodies(previous, body) };
}

/** Times never run backwards in a log, even when a clock or mtime does. */
function notBefore(at: string, last: NoteRevision | undefined): string {
  return last !== undefined && at < last.at ? last.at : at;
}

async function appendEntries(
  path: string,
  log: { revisions: NoteRevision[]; lines: number },
  pending: Array<{ at: string; by: HistoryAuthor; op: HistoryOp; body: string }>,
): Promise<void> {
  if (pending.length === 0) return;
  let previous = log.revisions.at(-1)?.body ?? null;
  let index = log.lines;
  const lines: string[] = [];
  for (const { body, ...meta } of pending) {
    lines.push(JSON.stringify(entryFor(meta, previous, body, index)));
    previous = body;
    index++;
  }
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.appendFile(path, lines.join("\n") + "\n", "utf8");
}

/**
 * Record one write. Called by `vault.ts` while it holds the vault lock, after
 * the note file has been written. A failure here never fails the write that
 * caused it: losing a revision is better than losing the user's edit.
 */
export async function recordRevision(root: string, slug: string, input: RecordInput): Promise<void> {
  try {
    const path = historyPath(root, slug);
    if (path === null || !(await historyEnabled(root))) return;
    const log = await readLog(path, true);
    const pending: Array<{ at: string; by: HistoryAuthor; op: HistoryOp; body: string }> = [];
    let last = log.revisions.at(-1);
    if (input.before !== null && last?.body !== input.before.body) {
      const op: HistoryOp = last === undefined ? "baseline" : "outside";
      const outside = { at: notBefore(input.before.at, last), by: "outside" as const, op, body: input.before.body };
      pending.push(outside);
      last = outside;
    }
    if (last?.body !== input.after) {
      pending.push({ at: notBefore(input.at.toISOString(), last), by: input.by, op: input.op, body: input.after });
    }
    await appendEntries(path, log, pending);
  } catch {
    // Deliberately silent; see the doc comment.
  }
}

/**
 * Every revision of a note, oldest first. When `current` is given and differs
 * from the last revision, the difference was made outside pi-weave; it is
 * recorded (if history is on) and returned as the final revision either way,
 * so the slider always ends on what the note says now.
 */
export async function readHistory(root: string, slug: string, current?: PriorBody): Promise<NoteRevision[]> {
  const path = historyPath(root, slug);
  if (path === null) return [];
  const log = await readLog(path);
  const last = log.revisions.at(-1);
  if (current === undefined || last?.body === current.body) return log.revisions;
  const outside: NoteRevision = {
    at: notBefore(current.at, last),
    by: "outside",
    op: last === undefined ? "baseline" : "outside",
    body: current.body,
  };
  if (await historyEnabled(root)) {
    try {
      await appendEntries(path, log, [outside]);
    } catch {
      // Still shown; recording is best effort.
    }
  }
  return [...log.revisions, outside];
}

async function move(from: string | null, to: string | null): Promise<void> {
  if (from === null || to === null || from === to) return;
  try {
    await fs.mkdir(dirname(to), { recursive: true });
    await fs.rename(from, to);
  } catch {
    // No log yet, or nothing to move.
  }
}

/** Carry a note's log to its new slug after a rename or move. */
export async function moveHistory(root: string, from: string, to: string): Promise<void> {
  await move(historyPath(root, from), historyPath(root, to));
}

/** Carry a folder's logs along when the folder is renamed. */
export async function moveHistoryFolder(root: string, from: string, to: string): Promise<void> {
  await move(folderPath(root, from), folderPath(root, to));
}

/** Drop a deleted note's log, so a new note with the same name starts clean. */
export async function removeHistory(root: string, slug: string): Promise<void> {
  const path = historyPath(root, slug);
  if (path !== null) await fs.rm(path, { force: true });
}

/** Drop the logs of every note in a deleted folder. */
export async function removeHistoryFolder(root: string, folder: string): Promise<void> {
  const path = folderPath(root, folder);
  if (path !== null) await fs.rm(path, { recursive: true, force: true });
}
