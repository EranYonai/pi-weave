import { promises as fs } from "node:fs";
import { join } from "node:path";
import { parseFrontMatter, unquoteField } from "./frontmatter";
import { NOTES_DIR } from "./paths";
import { addNote, setNoteFields } from "./vault";
import type { Note } from "./types";

/**
 * Meeting transcripts from Weave Capture (`src/capture/`), as vault notes.
 *
 * The capture server runs next to the vault and writes each finished
 * transcript straight into `meetings/` with `status: new`. Every harness reads
 * the same notes: the status line counts the new ones and `/weave-inbox` (or
 * `weave_note` action `inbox`) lists them and marks them read. The notes are
 * ordinary Markdown, so a person can also flip `status` by hand.
 */

/** The vault folder transcripts are written to, and the one the inbox reads. */
export const MEETINGS_FOLDER = "meetings";
export const TRANSCRIPT_KIND = "transcript";

/** One timed line of a transcript. Seconds from the start of the recording. */
export interface TranscriptSegment {
  start: number;
  text: string;
}

export interface TranscriptInput {
  title: string;
  /** When recording started. */
  recorded: Date;
  /** Length of the recording in seconds. */
  duration: number;
  segments: readonly TranscriptSegment[];
  /** The capture server's id for the recording, so a retry never duplicates. */
  capture: string;
}

/** A transcript note as the inbox and the capture app list it. */
export interface TranscriptSummary {
  slug: string;
  title: string;
  recorded: string;
  duration: number;
  status: "new" | "read";
  capture: string;
}

/** `[hh:mm:ss]` for a number of seconds. */
export function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

/** `42m`, `1h 05m`, or `40s` for a recording under a minute. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.round(total / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** The note body: one `[hh:mm:ss] text` line per segment, blank segments dropped. */
export function formatTranscript(segments: readonly TranscriptSegment[]): string {
  const lines = segments
    .map((segment) => ({ start: segment.start, text: segment.text.replace(/\s+/g, " ").trim() }))
    .filter((segment) => segment.text !== "")
    .map((segment) => `[${formatTimestamp(segment.start)}] ${segment.text}`);
  return lines.length > 0 ? lines.join("\n") : "_Nothing was transcribed._";
}

/** Write a transcript as a new note in `meetings/`, marked new. */
export async function saveTranscript(root: string, input: TranscriptInput): Promise<Note> {
  return addNote(root, {
    title: input.title,
    body: formatTranscript(input.segments),
    source: "generated",
    by: "agent",
    folder: MEETINGS_FOLDER,
    now: input.recorded,
    fields: {
      kind: TRANSCRIPT_KIND,
      recorded: input.recorded.toISOString(),
      duration: String(Math.round(input.duration)),
      status: "new",
      capture: input.capture,
    },
  });
}

async function markdownFiles(dir: string, prefix: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map((entry) => {
      if (entry.isDirectory()) return markdownFiles(join(dir, entry.name), `${prefix}${entry.name}/`);
      return Promise.resolve(entry.isFile() && entry.name.endsWith(".md") ? [`${prefix}${entry.name.slice(0, -3)}`] : []);
    }),
  );
  return nested.flat();
}

function field(fields: ReadonlyMap<string, string>, key: string): string {
  return unquoteField(fields.get(key) ?? "");
}

/** Parse a transcript note's text, or null when it is not one. */
export function readTranscript(slug: string, text: string): TranscriptSummary | null {
  const parsed = parseFrontMatter(text);
  if (parsed === null || field(parsed.fields, "kind") !== TRANSCRIPT_KIND) return null;
  const duration = Number(field(parsed.fields, "duration"));
  return {
    slug,
    title: field(parsed.fields, "title") || slug,
    recorded: field(parsed.fields, "recorded") || field(parsed.fields, "created"),
    duration: Number.isFinite(duration) ? duration : 0,
    status: field(parsed.fields, "status") === "new" ? "new" : "read",
    capture: field(parsed.fields, "capture"),
  };
}

/**
 * Every transcript note under `meetings/`, newest first. Only that folder is
 * read, so the status line stays cheap on a large vault.
 */
export async function listTranscripts(root: string): Promise<TranscriptSummary[]> {
  const base = join(root, NOTES_DIR, MEETINGS_FOLDER);
  const slugs = await markdownFiles(base, `${MEETINGS_FOLDER}/`);
  const found = await Promise.all(
    slugs.map(async (slug) => {
      const text = await fs.readFile(join(root, NOTES_DIR, `${slug}.md`), "utf8").catch(() => null);
      return text === null ? null : readTranscript(slug, text);
    }),
  );
  return found
    .filter((item): item is TranscriptSummary => item !== null)
    .sort((a, b) => b.recorded.localeCompare(a.recorded) || a.slug.localeCompare(b.slug));
}

/** How many transcripts are still marked new. */
export async function newTranscriptCount(root: string): Promise<number> {
  return (await listTranscripts(root)).filter((item) => item.status === "new").length;
}

/** Mark a transcript read (or new again). */
export async function setTranscriptStatus(root: string, slug: string, status: "new" | "read"): Promise<boolean> {
  return (await setNoteFields(root, slug, { status })).ok;
}

/**
 * The inbox: list new transcripts and mark them read, so the next call shows
 * only what arrived since. Returns the text a harness shows.
 */
export async function takeInbox(root: string): Promise<{ text: string; transcripts: TranscriptSummary[] }> {
  const fresh = (await listTranscripts(root)).filter((item) => item.status === "new");
  if (fresh.length === 0) {
    return { text: "No new meeting transcripts. Record one with Weave Capture and it lands in meetings/.", transcripts: [] };
  }
  for (const item of fresh) await setTranscriptStatus(root, item.slug, "read");
  const lines = fresh.map((item) => {
    const when = item.recorded ? item.recorded.slice(0, 16).replace("T", " ") : "unknown time";
    return `- ${item.slug}: ${item.title} (${when}, ${formatDuration(item.duration)})`;
  });
  return {
    text: [
      `${fresh.length} new meeting transcript${fresh.length === 1 ? "" : "s"}, now marked read:`,
      ...lines,
      "",
      "Read one with weave_note action get and its slug.",
    ].join("\n"),
    transcripts: fresh.map((item) => ({ ...item, status: "read" })),
  };
}
