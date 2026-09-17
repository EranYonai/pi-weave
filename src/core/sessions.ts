/**
 * Session scan (docs/session-scan.md): summarize pi session transcripts into
 * the vault — one generated note per session, incrementally maintained by
 * hashing each transcript **while reading it** so unchanged sessions never
 * cost an LLM call on re-scans.
 *
 * Core never talks to an LLM and never imports pi — the `summarize` function
 * is injected (the pi adapter wires the session model; tests inject a fake),
 * and both roots (sessions, vault) are injected too, which keeps this module
 * harness-free and trivially testable with fixture directories.
 */

import { type Dirent } from "node:fs";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { mapWithConcurrency } from "./concurrency";
import {
  parseFrontMatter,
  unquoteField,
  upsertFrontMatterFields,
  type ParsedFrontMatter,
} from "./frontmatter";
import { NOTES_DIR, SESSIONS_DIR } from "./paths";
import { slugify } from "./slug";
import { hashContent, type SummarizeFn } from "./summaries";
import { upsertNote } from "./vault";

/** The pi sessions directory: `~/.pi/agent/sessions/<encoded-cwd>/<ts>_<uuid>.jsonl`. */
export const DEFAULT_SESSIONS_ROOT = join(homedir(), ".pi", "agent", "sessions");
export const SESSIONS_ENV_VAR = "PI_WEAVE_SESSIONS";

/** Resolve the pi sessions root. `env` is injectable for tests. */
export function resolveSessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[SESSIONS_ENV_VAR];
  if (override && override.trim().length > 0) {
    return override;
  }
  return DEFAULT_SESSIONS_ROOT;
}

/* ------------------------------------------------------------------ */
/* Caps                                                                */
/* ------------------------------------------------------------------ */

export const SESSION_SCAN_MAX_SESSIONS = 100;
export const SESSION_SCAN_MAX_FILE_BYTES = 16 * 1024 * 1024;
export const SESSION_SCAN_CONCURRENCY = 2;

const DIGEST_MAX_CHARS = 12_000;
const USER_MSG_MAX_CHARS = 400;
const MAX_USER_MESSAGES = 60;
const COMPACTION_MAX_CHARS = 1200;
const MAX_COMPACTIONS = 3;
const BRANCH_MAX_CHARS = 800;
const MAX_BRANCH_SUMMARIES = 2;
const LAST_ASSISTANT_MAX_CHARS = 800;
const FIRST_MESSAGE_MAX_CHARS = 200;

/* ------------------------------------------------------------------ */
/* Discovery                                                           */
/* ------------------------------------------------------------------ */

/** One discovered transcript: a `.jsonl` file under the sessions root. */
export interface SessionFileInfo {
  /** Absolute path. */
  path: string;
  /** File name (the progress line shows this, not the full path). */
  name: string;
  bytes: number;
  mtimeMs: number;
}

/**
 * All session transcripts under `root`, newest first (mtime desc; ties break
 * by path so ordering is stable across scans). The pi layout is one
 * subdirectory per working directory; non-directories and non-`.jsonl` files
 * are ignored, and entries that vanish mid-listing are dropped quietly.
 */
export async function listSessionFiles(
  root: string,
  opts: { limit?: number } = {},
): Promise<SessionFileInfo[]> {
  let entries: Dirent<string>[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return []; // no sessions dir — nothing to scan
  }
  const out: SessionFileInfo[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dir = join(root, ent.name);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue; // raced a delete
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      let st;
      try {
        st = await fs.stat(path);
      } catch {
        continue; // raced a delete
      }
      if (!st.isFile()) continue;
      out.push({ path, name, bytes: st.size, mtimeMs: st.mtimeMs });
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
  return opts.limit !== undefined ? out.slice(0, opts.limit) : out;
}

/* ------------------------------------------------------------------ */
/* Parsing: the digest                                                 */
/* ------------------------------------------------------------------ */

/** The compact, summarizer-facing picture of one session. */
export interface SessionDigest {
  /** Session uuid from the JSONL header — the stable identity. */
  id: string;
  /** Working directory from the header ("" when absent). */
  cwd: string;
  /** Parent session path for forked/branched sessions. */
  parentSession: string | null;
  /** Header timestamp (ISO). */
  startedAt: string;
  /** Timestamp of the last parsed entry (falls back to startedAt). */
  endedAt: string;
  /** Latest `session_info` display name, when the user set one. */
  name: string | null;
  /** Models used, in first-seen order (`model_change` + assistant messages). */
  models: string[];
  userCount: number;
  assistantCount: number;
  toolResultCount: number;
  /** Assistant errors + tool-result errors. */
  errors: number;
  /** Direct `!!`-style shell executions (role `bashExecution`). */
  bashCount: number;
  /** toolName → call count, from tool-result messages. */
  tools: Record<string, number>;
  firstUserMessage: string | null;
  /** User texts, each clipped, in order. */
  userMessages: string[];
  /** Compaction summaries (newest kept, clipped). */
  compactions: string[];
  /** Branch summaries (newest kept, clipped). */
  branchSummaries: string[];
  /** Last non-empty assistant text, clipped. */
  lastAssistantText: string | null;
}

/** Parse-time clip: truncate long text and mark it. */
function clip(text: string, max: number): string {
  const flat = text.trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Keep at most `cap` items; newest (latest push) wins. */
function pushCapped(arr: string[], item: string, cap: number): void {
  arr.push(item);
  if (arr.length > cap) arr.shift();
}

function pushUnique(arr: string[], value: string): void {
  if (!arr.includes(value)) arr.push(value);
}

/** Extract text from a message `content` (string or content-block array). */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      block !== null &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join(" ");
}

function modelLabel(provider: unknown, model: unknown): string | null {
  if (typeof provider !== "string" || typeof model !== "string") return null;
  if (provider.length === 0 || model.length === 0) return null;
  return `${provider}/${model}`;
}

/**
 * Parse a session JSONL into its digest, or null when the file has no
 * recognizable pi session header (anything else — unknown entry types,
 * malformed lines, missing optional fields — is tolerated and skipped).
 */
export function parseSessionDigest(text: string): SessionDigest | null {
  const digest: SessionDigest = {
    id: "",
    cwd: "",
    parentSession: null,
    startedAt: "",
    endedAt: "",
    name: null,
    models: [],
    userCount: 0,
    assistantCount: 0,
    toolResultCount: 0,
    errors: 0,
    bashCount: 0,
    tools: {},
    firstUserMessage: null,
    userMessages: [],
    compactions: [],
    branchSummaries: [],
    lastAssistantText: null,
  };
  let sawHeader = false;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue; // torn/partial line — skip, never fatal
    }
    if (entry === null || typeof entry !== "object") continue;

    switch (entry.type) {
      case "session": {
        if (sawHeader) break; // first header wins
        const id = typeof entry.id === "string" ? entry.id : "";
        if (id.length === 0) break; // not a pi session header
        sawHeader = true;
        digest.id = id;
        digest.cwd = typeof entry.cwd === "string" ? entry.cwd : "";
        digest.startedAt = typeof entry.timestamp === "string" ? entry.timestamp : "";
        digest.endedAt = digest.startedAt;
        digest.parentSession = typeof entry.parentSession === "string" ? entry.parentSession : null;
        break;
      }
      case "session_info": {
        const name = typeof entry.name === "string" ? entry.name.trim() : "";
        if (name.length > 0) digest.name = name;
        break;
      }
      case "model_change": {
        const label = modelLabel(entry.provider, entry.modelId);
        if (label) pushUnique(digest.models, label);
        break;
      }
      case "compaction": {
        const summary = typeof entry.summary === "string" ? entry.summary : "";
        if (summary.trim().length > 0) {
          pushCapped(digest.compactions, clip(summary, COMPACTION_MAX_CHARS), MAX_COMPACTIONS);
        }
        break;
      }
      case "branch_summary": {
        const summary = typeof entry.summary === "string" ? entry.summary : "";
        if (summary.trim().length > 0) {
          pushCapped(digest.branchSummaries, clip(summary, BRANCH_MAX_CHARS), MAX_BRANCH_SUMMARIES);
        }
        break;
      }
      case "message": {
        const ts = typeof entry.timestamp === "string" ? entry.timestamp : "";
        if (ts.length > 0) digest.endedAt = ts;
        const msg = entry.message;
        if (msg === null || typeof msg !== "object") break;
        const role = (msg as Record<string, unknown>).role;
        switch (role) {
          case "user": {
            digest.userCount += 1;
            const text = extractText((msg as Record<string, unknown>).content).trim();
            if (text.length === 0) break;
            pushCapped(digest.userMessages, clip(text, USER_MSG_MAX_CHARS), MAX_USER_MESSAGES);
            if (digest.firstUserMessage === null) {
              digest.firstUserMessage = clip(text, FIRST_MESSAGE_MAX_CHARS);
            }
            break;
          }
          case "assistant": {
            digest.assistantCount += 1;
            const m = msg as Record<string, unknown>;
            const label = modelLabel(m.provider, m.model);
            if (label) pushUnique(digest.models, label);
            if (m.stopReason === "error") digest.errors += 1;
            const text = extractText(m.content).trim();
            if (text.length > 0) digest.lastAssistantText = clip(text, LAST_ASSISTANT_MAX_CHARS);
            break;
          }
          case "toolResult": {
            digest.toolResultCount += 1;
            const m = msg as Record<string, unknown>;
            if (m.isError === true) digest.errors += 1;
            if (typeof m.toolName === "string" && m.toolName.length > 0) {
              digest.tools[m.toolName] = (digest.tools[m.toolName] ?? 0) + 1;
            }
            break;
          }
          case "bashExecution": {
            digest.bashCount += 1;
            break;
          }
          default:
            break; // custom / extension roles — not memory-worthy
        }
        break;
      }
      default:
        break; // label / custom / thinking_level_change / …
    }
  }

  return sawHeader ? digest : null;
}

/**
 * Peek at just the header line for the session id — the cheap identity
 * lookup used before deciding whether a file needs a full parse.
 */
export interface SessionHeader {
  id: string;
  cwd: string;
  startedAt: string;
}

/**
 * Peek at just the header line for identity, project, and start time — the
 * cheap read used on sessions whose hash already matched (no full parse), and
 * the raw material for the per-project chain.
 */
export function peekSessionHeader(text: string): SessionHeader | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const entry = JSON.parse(trimmed) as Record<string, unknown>;
      if (entry.type !== "session" || typeof entry.id !== "string" || entry.id.length === 0) {
        return null; // first line is not a header — not a session file
      }
      return {
        id: entry.id,
        cwd: typeof entry.cwd === "string" ? entry.cwd : "",
        startedAt: typeof entry.timestamp === "string" ? entry.timestamp : "",
      };
    } catch {
      return null;
    }
  }
  return null;
}

/** True when the session carries anything worth remembering. */
export function sessionHasContent(d: SessionDigest): boolean {
  return (
    d.userCount > 0 || d.bashCount > 0 || d.compactions.length > 0 || d.branchSummaries.length > 0
  );
}

/* ------------------------------------------------------------------ */
/* Rendering: digest, title, tags, note body                           */
/* ------------------------------------------------------------------ */

/** Flatten internal whitespace (user prompts are often multi-line). */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Tool histogram, descending count then name — deterministic output. */
function sortedTools(d: SessionDigest): [string, number][] {
  return Object.entries(d.tools).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * Render the digest as the text handed to the summarizer: a compact
 * transcript, capped so one session always costs one bounded LLM call.
 */
export function renderSessionDigest(d: SessionDigest, opts: { maxChars?: number } = {}): string {
  const lines: string[] = [];
  const span =
    d.startedAt.length === 0
      ? "unknown time"
      : d.endedAt !== d.startedAt && d.endedAt.length > 0
        ? `${d.startedAt} → ${d.endedAt}`
        : d.startedAt;
  lines.push(`Session ${d.id} (${span})`);
  if (d.cwd.length > 0) lines.push(`Project: ${d.cwd}`);
  if (d.name !== null) lines.push(`Name: ${d.name}`);
  if (d.models.length > 0) lines.push(`Models: ${d.models.join(", ")}`);
  const counts = [`${d.userCount} user`, `${d.assistantCount} assistant`, `${d.toolResultCount} tool results`];
  if (d.errors > 0) counts.push(`${d.errors} errors`);
  lines.push(`Messages: ${counts.join(", ")}`);
  const tools = sortedTools(d);
  if (tools.length > 0) {
    lines.push(`Tools: ${tools.map(([name, count]) => `${name} ×${count}`).join(", ")}`);
  }
  if (d.userMessages.length > 0) {
    lines.push("", "## User messages");
    d.userMessages.forEach((m, i) => lines.push(`${i + 1}. ${flatten(m)}`));
  }
  if (d.compactions.length > 0) {
    lines.push("", "## Compaction summaries");
    d.compactions.forEach((c, i) => lines.push(`[${i + 1}] ${c}`));
  }
  if (d.branchSummaries.length > 0) {
    lines.push("", "## Branch summaries");
    d.branchSummaries.forEach((c, i) => lines.push(`[${i + 1}] ${c}`));
  }
  if (d.lastAssistantText !== null) {
    lines.push("", "## Last assistant message", d.lastAssistantText);
  }
  const cap = opts.maxChars ?? DIGEST_MAX_CHARS;
  const text = lines.join("\n");
  return text.length <= cap ? text : `${text.slice(0, cap - 1)}…`;
}

/**
 * The note title: the user's session name, else the first user message, else
 * a fallback from the id — flattened and clipped. Deliberately unprefixed:
 * session notes live in their own `sessions/` vault collection, and the
 * directory is the context a "Pi session:" title prefix used to carry.
 */
export function deriveSessionTitle(d: SessionDigest): string {
  const raw = flatten(d.name ?? d.firstUserMessage ?? "");
  const base = raw.length > 0 ? raw : `session ${d.id.slice(0, 8) || "unknown"}`;
  return base.length > 80 ? `${base.slice(0, 79).trimEnd()}…` : base;
}

/** Tag for every session note — grep- and cluster-friendly. */
export const SESSION_NOTE_TAG = "pi-session";

/** The project tag for a cwd: the directory name, slugified. */
export function projectTagOf(cwd: string): string {
  return cwd.length > 0 ? slugify(basename(cwd)) : "";
}

/** `["pi-session", <project>]` — the project tag is the cwd's directory name. */
export function sessionNoteTags(d: SessionDigest): string[] {
  const tags = [SESSION_NOTE_TAG];
  // Guard before slugify: its empty-input fallback is "note", and a missing
  // cwd must produce NO project tag, not a meaningless one.
  const project = projectTagOf(d.cwd);
  if (project.length > 0) tags.push(project);
  return tags;
}

export interface SessionNoteRecord {
  digest: SessionDigest;
  file: Pick<SessionFileInfo, "path">;
  /** sha1 of the transcript bytes at summarize time. */
  hash: string;
  summary: string;
  /** Summarizer label for provenance (null when unknown). */
  model: string | null;
  /** ISO timestamp of the summarization. */
  at: string;
  /**
   * Slug of the note already representing this session (from the marker
   * index), so a re-summarize lands **in place** — even when the human
   * renamed the note away from its derived slug. Null/absent on creation.
   */
  existingSlug?: string | null;
  /** Neighbour sessions of the same project, as `[[slug]]` links. */
  chain?: SessionChain;
}

/** Chronological neighbours of a session within the same project. */
export interface SessionChain {
  /** Slug of the closest older same-project session note, when known. */
  previous?: string | null;
  /** Slug of the closest newer same-project session note, when known. */
  next?: string | null;
}

/** The front-matter fields owned by session notes. */
export function sessionNoteFields(rec: SessionNoteRecord): Record<string, string> {
  const fields: Record<string, string> = {
    session_id: rec.digest.id,
    session_hash: rec.hash,
    session_cwd: rec.digest.cwd,
    session_file: rec.file.path,
  };
  // Sorting key for the per-project chain; absent on very old notes.
  if (rec.digest.startedAt.length > 0) fields.session_start = rec.digest.startedAt;
  return fields;
}

/** Summary + a `## Details` provenance block. */
export function sessionNoteBody(rec: SessionNoteRecord): string {
  const d = rec.digest;
  const lines = [
    rec.summary,
    "",
    "## Details",
    "",
    `- Session: \`${d.id}\``,
    `- Started: ${d.startedAt.length > 0 ? d.startedAt : "unknown"}${
      d.endedAt.length > 0 && d.endedAt !== d.startedAt ? ` · ended: ${d.endedAt}` : ""
    }`,
    `- Project: \`${d.cwd.length > 0 ? d.cwd : "unknown"}\``,
    `- Messages: ${d.userCount} user · ${d.assistantCount} assistant · ${d.toolResultCount} tool results${
      d.errors > 0 ? ` (${d.errors} errors)` : ""
    }`,
  ];
  const tools = sortedTools(d);
  if (tools.length > 0) {
    lines.push(`- Tools: ${tools.map(([name, count]) => `${name} ×${count}`).join(", ")}`);
  }
  if (d.bashCount > 0) lines.push(`- Shell commands (direct): ${d.bashCount}`);
  if (d.models.length > 0) lines.push(`- Models: ${d.models.join(", ")}`);
  if (rec.chain?.previous) lines.push(`- Previous session: [[${rec.chain.previous}]]`);
  if (rec.chain?.next) lines.push(`- Next session: [[${rec.chain.next}]]`);
  lines.push(`- Transcript: \`${rec.file.path}\``);
  lines.push(`- Summarized: ${rec.at}${rec.model ? ` by ${rec.model}` : ""}`);
  return lines.join("\n");
}

/** Write (create or update in place) the session note for one transcript. */
export async function writeSessionNote(vaultRoot: string, rec: SessionNoteRecord): Promise<string> {
  const note = await upsertNote(vaultRoot, {
    // `sessions/<name>` — an inner folder of the vault graph, so session
    // notes are real notes (search, graph, wikilinks) without mixing the
    // flat listing a human curates. `existingSlug` carries the full slug.
    slug: rec.existingSlug ?? sessionNoteSlug(deriveSessionTitle(rec.digest)),
    title: deriveSessionTitle(rec.digest),
    tags: sessionNoteTags(rec.digest),
    body: sessionNoteBody(rec),
    fields: sessionNoteFields(rec),
    source: "generated",
    // Guard the slug against same-titled but different sessions.
    identity: { field: "session_id", value: rec.digest.id },
    // The record's `at` is the injected scan clock — note timestamps follow
    // it rather than the wall clock (tests inject fixed times).
    now: new Date(rec.at),
  });
  return note.slug;
}

/* ------------------------------------------------------------------ */
/* The note index (incremental-skip lookup)                            */
/* ------------------------------------------------------------------ */

export interface SessionNotePointer {
  slug: string;
  /** `session_hash` recorded when the note was last summarized; null if absent. */
  hash: string | null;
  /** `session_cwd`, when the note carries one — chain grouping. */
  cwd: string | null;
  /** `session_start`, when the note carries one — chain ordering. */
  startedAt: string | null;
}

/**
 * One pass over the `notes/sessions/` collection: `session_id → pointer`,
 * from front matter. Marker-based, so renamed/retitled notes still resolve;
 * the first note claiming an id wins (deterministic by file name order).
 */
export async function readSessionNoteIndex(
  vaultRoot: string,
): Promise<Map<string, SessionNotePointer>> {
  const dir = sessionNotesDir(vaultRoot);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return new Map();
  }
  const map = new Map<string, SessionNotePointer>();
  for (const name of names.sort()) {
    if (!name.endsWith(".md")) continue;
    let text: string;
    try {
      text = await fs.readFile(join(dir, name), "utf8");
    } catch {
      continue;
    }
    const fm = parseFrontMatter(text);
    if (!fm) continue;
    const id = unquoteField(fm.fields.get("session_id") ?? "");
    if (id.length === 0) continue;
    if (map.has(id)) continue;
    const hash = unquoteField(fm.fields.get("session_hash") ?? "");
    map.set(id, {
      // The slug is the note's graph identity: the path relative to notes/.
      slug: `${SESSIONS_DIR}/${name.slice(0, -".md".length)}`,
      hash: hash.length > 0 ? hash : null,
      cwd: nonEmpty(unquoteField(fm.fields.get("session_cwd") ?? "")),
      startedAt: nonEmpty(unquoteField(fm.fields.get("session_start") ?? "")),
    });
  }
  return map;
}

function nonEmpty(value: string): string | null {
  return value.length > 0 ? value : null;
}

/** The `notes/sessions/` directory inside the vault (docs/session-scan.md). */
export function sessionNotesDir(vaultRoot: string): string {
  return join(vaultRoot, NOTES_DIR, SESSIONS_DIR);
}

/** A session note's slug: `sessions/<name>` — nested inside the vault graph. */
export function sessionNoteSlug(titleOrName: string): string {
  return `${SESSIONS_DIR}/${slugify(titleOrName)}`;
}

/* ------------------------------------------------------------------ */
/* Legacy migration: notes/ → sessions/                                */
/* ------------------------------------------------------------------ */

/** The title prefix the first layout carried; migration strips it. */
const LEGACY_TITLE_PREFIX = "Pi session: ";
const LEGACY_SLUG_PREFIX = "pi-session-";

/**
 * Move session notes from the first layout (`notes/*.md`, prefixed titles)
 * into the dedicated `sessions/` collection (docs/session-scan.md §storage).
 *
 * Per legacy note, best-effort, idempotent:
 *  1. strip the `Pi session: ` title prefix (a systematic change, not a
 *     human edit — a human title that merely *begins* with the prefix keeps
 *     its remaining words),
 *  2. backfill `session_start` from the Details block, so per-project chain
 *     ordering works for notes written before the field existed,
 *  3. rename the file, dropping the `pi-session-` slug prefix, and move it
 *     into `sessions/`. A name collision leaves the legacy file untouched —
 *     a later re-summarize settles that session via the marker index.
 *
 * Returns the number of notes moved. Non-session notes are never touched.
 */
/**
 * Rewrite one legacy session note's content for the current layout: strip
 * the `Pi session: ` title prefix (a systematic change, not a human edit —
 * a human title that merely *begins* with the prefix keeps its remaining
 * words), backfill `session_start` from the Details block so per-project
 * chain ordering works for notes written before the field existed, and
 * qualify the body's `[[chain links]]` with their new `sessions/` directory.
 */
function migrateLegacyNoteText(fm: ParsedFrontMatter): string {
  const rawTitle = unquoteField(fm.fields.get("title") ?? "");
  const fields: Record<string, string> = {};
  if (rawTitle.startsWith(LEGACY_TITLE_PREFIX)) {
    fields.title = rawTitle.slice(LEGACY_TITLE_PREFIX.length);
  }
  const started = /^- Started: (\S+)/m.exec(fm.body)?.[1];
  if (started) fields.session_start = started;
  const lines =
    Object.keys(fields).length > 0 ? upsertFrontMatterFields(fm.lines, fields) : fm.lines;
  const body = fm.body.replace(
    /^(- (?:Previous|Next) session: \[\[)([^\]/]+)(\]\])$/gm,
    (_match, head: string, target: string, tail: string) =>
      target.startsWith(SESSIONS_DIR + "/") ? `${head}${target}${tail}` : `${head}${SESSIONS_DIR}/${target}${tail}`,
  );
  return ["---", ...lines, "---", "", body, ""].join("\n");
}

export async function migrateLegacySessionNotes(vaultRoot: string): Promise<number> {
  const targetDir = sessionNotesDir(vaultRoot);
  // Both earlier layouts: the interim vault-level `sessions/` folder, and the
  // original flat `notes/` listing.
  const legacyDirs = [join(vaultRoot, SESSIONS_DIR), join(vaultRoot, NOTES_DIR)];
  let moved = 0;
  for (const legacyDir of legacyDirs) {
    let names: string[];
    try {
      names = await fs.readdir(legacyDir);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (!name.endsWith(".md")) continue;
      let text: string;
      try {
        text = await fs.readFile(join(legacyDir, name), "utf8");
      } catch {
        continue;
      }
      const fm = parseFrontMatter(text);
      if (!fm) continue;
      const id = unquoteField(fm.fields.get("session_id") ?? "");
      if (id.length === 0) continue; // not ours — never touch human notes

      const newText = migrateLegacyNoteText(fm);
      const base = name.slice(0, -".md".length);
      const stripped = base.startsWith(LEGACY_SLUG_PREFIX) ? base.slice(LEGACY_SLUG_PREFIX.length) : base;
      const targetName = `${stripped.length > 0 ? stripped : base}.md`;
      const target = join(targetDir, targetName);
      try {
        if (existsSync(target)) {
          // A file already sits at the target name. When it carries the same
          // session id it is the authoritative, rescanned copy — the legacy
          // one is stale and goes. A different session keeps the legacy file
          // where it is; the marker index and identity guard will separate
          // them on the session's next re-summarize.
          const occupant = parseFrontMatter(await fs.readFile(target, "utf8"));
          const occupantId = occupant ? unquoteField(occupant.fields.get("session_id") ?? "") : "";
          if (occupantId !== id) continue;
        }
        await fs.mkdir(targetDir, { recursive: true });
        await fs.writeFile(target, newText, "utf8");
        await fs.unlink(join(legacyDir, name));
        moved += 1;
      } catch {
        continue; // raced or unwritable — leave the legacy note alone
      }
    }
  }
  // The interim vault-level `sessions/` folder is this migration's own
  // leftover; once emptied, remove the shell too (never `notes/` itself).
  try {
    await fs.rmdir(join(vaultRoot, SESSIONS_DIR));
  } catch {
    // not empty or already gone — either is fine
  }
  return moved;
}

/* ------------------------------------------------------------------ */
/* The scan                                                            */
/* ------------------------------------------------------------------ */

export interface SessionScanOptions {
  sessionsRoot: string;
  vaultRoot: string;
  summarize: SummarizeFn;
  /** Summarizer label recorded for provenance. */
  model?: string;
  maxSessions?: number;
  maxFileBytes?: number;
  concurrency?: number;
  /** Injectable clock (note timestamps). */
  now?: () => Date;
  /** Called before each candidate is processed; `current` is 1-based. */
  onProgress?: (info: { current: number; total: number; path: string }) => void;
  /** When aborted, stop scheduling new work and return partial results. */
  signal?: AbortSignal;
}

export interface SessionScanFailure {
  path: string;
  error: string;
}

export interface SessionScanResult {
  /** Transcript files found under the sessions root. */
  discovered: number;
  /** Candidates after the size filter and the maxSessions cap. */
  considered: number;
  written: number;
  created: number;
  updated: number;
  /** Unchanged since their summary (content hash match) — no LLM call. */
  skippedFresh: number;
  /** Sessions with no user messages, compactions, branches, or shell use. */
  skippedEmpty: number;
  /** Transcripts exceeding the byte cap (filtered before reading). */
  skippedTooBig: number;
  /** Unreadable files and files without a parseable session header. */
  skippedUnreadable: number;
  /** Notes moved from the legacy `notes/` layout into `sessions/`. */
  migrated: number;
  failed: SessionScanFailure[];
}

/**
 * Run the session scan, in three phases (docs/session-scan.md):
 *
 * 1. **Read** every candidate transcript exactly once — hash the bytes while
 *    reading, peek the header line for identity/project/start. Sessions whose
 *    note already carries that hash are skipped here: no parse, no LLM.
 * 2. **Chain** the batch: per project, order the sessions by start time and
 *    give each changed session its `[[previous]]`/`[[next]]` neighbours.
 * 3. **Summarize** the changed, non-empty sessions (the only LLM cost) and
 *    upsert their notes into the `sessions/` vault collection.
 *
 * Failure-tolerant per file; incremental by construction.
 */
export async function runSessionScan(options: SessionScanOptions): Promise<SessionScanResult> {
  const maxSessions = options.maxSessions ?? SESSION_SCAN_MAX_SESSIONS;
  const maxFileBytes = options.maxFileBytes ?? SESSION_SCAN_MAX_FILE_BYTES;
  const concurrency = options.concurrency ?? SESSION_SCAN_CONCURRENCY;
  const now = options.now ?? (() => new Date());
  const onProgress = options.onProgress;
  const aborted = () => options.signal?.aborted === true;

  const result: SessionScanResult = {
    discovered: 0,
    considered: 0,
    written: 0,
    created: 0,
    updated: 0,
    skippedFresh: 0,
    skippedEmpty: 0,
    skippedTooBig: 0,
    skippedUnreadable: 0,
    migrated: 0,
    failed: [],
  };

  // Legacy layout first: session notes move out of `notes/` into the
  // `sessions/` collection the marker index is about to read.
  result.migrated = await migrateLegacySessionNotes(options.vaultRoot);

  const all = await listSessionFiles(options.sessionsRoot);
  result.discovered = all.length;
  const withinSize = all.filter((f) => f.bytes <= maxFileBytes);
  result.skippedTooBig = all.length - withinSize.length;
  const batch = withinSize.slice(0, maxSessions);
  result.considered = batch.length;

  const noteIndex = await readSessionNoteIndex(options.vaultRoot);

  // -- Phase 1: read once, hash while reading, peek the header. -----------
  interface Candidate {
    file: SessionFileInfo;
    hash: string;
    header: SessionHeader;
    /** Existing note pointer when the session was scanned before. */
    pointer: SessionNotePointer | undefined;
    /** Parsed only when the hash changed — fresh sessions are never parsed. */
    digest: SessionDigest | null;
  }
  const candidates: Candidate[] = [];

  for (const file of batch) {
    let buf: Buffer;
    try {
      buf = await fs.readFile(file.path);
    } catch {
      result.skippedUnreadable += 1;
      continue;
    }
    // Hash from the same single read that feeds the parse — the file is
    // never read twice (docs/session-scan.md, "hash while reading").
    const hash = hashContent(buf);
    const header = peekSessionHeader(buf.toString("utf8"));
    if (header === null) {
      result.skippedUnreadable += 1;
      continue;
    }
    const pointer = noteIndex.get(header.id);
    if (pointer && pointer.hash === hash) {
      result.skippedFresh += 1;
      // Kept as a chain participant: it has a note, it has a header.
      candidates.push({ file, hash, header, pointer, digest: null });
      continue;
    }
    const digest = parseSessionDigest(buf.toString("utf8"));
    if (digest === null) {
      result.skippedUnreadable += 1;
      continue;
    }
    if (!sessionHasContent(digest)) {
      result.skippedEmpty += 1;
      continue;
    }
    candidates.push({ file, hash, header, pointer, digest });
  }

  // -- Phase 2: per-project chains over every session with a note. --------
  // A session's slug is known before writing: its existing note's slug (the
  // marker index), or the slug it is about to get (derived from the title).
  const slugOf = (c: Candidate): string =>
    c.pointer?.slug ?? sessionNoteSlug(deriveSessionTitle(c.digest as SessionDigest));
  const startOf = (c: Candidate): string =>
    c.digest?.startedAt || c.header.startedAt || c.pointer?.startedAt || "";
  const projectOf = (c: Candidate): string =>
    projectTagOf(c.header.cwd || c.pointer?.cwd || "");
  const withNotes = candidates
    .filter((c) => c.pointer !== undefined || c.digest !== null)
    .sort((a, b) => (startOf(a) || "~").localeCompare(startOf(b) || "~"));
  const chainOf = (self: Candidate): SessionChain => {
    const project = projectOf(self);
    const pos = withNotes.indexOf(self);
    let previous: string | undefined;
    let next: string | undefined;
    for (let i = pos - 1; i >= 0 && previous === undefined; i--) {
      const c = withNotes[i] as Candidate;
      if (projectOf(c) === project) previous = slugOf(c);
    }
    for (let i = pos + 1; i < withNotes.length && next === undefined; i++) {
      const c = withNotes[i] as Candidate;
      if (projectOf(c) === project) next = slugOf(c);
    }
    return {
      ...(previous !== undefined ? { previous } : {}),
      ...(next !== undefined ? { next } : {}),
    };
  };

  // -- Phase 3: summarize + write the changed sessions. --------------------
  const changed = candidates.filter((c) => c.digest !== null);
  await mapWithConcurrency(changed, concurrency, async (candidate, index) => {
    onProgress?.({ current: index + 1, total: changed.length, path: candidate.file.name });
    const digest = candidate.digest as SessionDigest;
    try {
      const summary = (await options.summarize({ path: candidate.file.path, content: renderSessionDigest(digest) })).trim();
      if (summary.length === 0) throw new Error("model returned an empty summary");
      await writeSessionNote(options.vaultRoot, {
        digest,
        file: { path: candidate.file.path },
        hash: candidate.hash,
        summary,
        model: options.model ?? null,
        at: now().toISOString(),
        existingSlug: candidate.pointer?.slug ?? null,
        chain: chainOf(candidate),
      });
      if (candidate.pointer !== undefined) result.updated += 1;
      else result.created += 1;
      result.written += 1;
    } catch (err) {
      result.failed.push({ path: candidate.file.name, error: err instanceof Error ? err.message : String(err) });
    }
  }, aborted);

  return result;
}