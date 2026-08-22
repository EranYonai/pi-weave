/**
 * Deep-scan summaries (docs/scan-modes.md): LLM-written, one sidecar
 * Markdown file per summarized source file, stored under
 * `<repo>/.okf/repository/summaries/`. Incremental via content hash.
 *
 * Core never talks to an LLM — `runDeepScan` takes an injected
 * `summarize(path, content)` function. The pi adapter wires the session
 * model (pi-ai completeSimple); tests inject a fake.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { parseFrontMatter, quoteField, unquoteField } from "./frontmatter";
import { listFiles } from "./git";
import { repoKnowledgeDir } from "./paths";
import type { NoteSource } from "./types";

export const SUMMARIES_DIR = "summaries";
export const SUMMARY_SUFFIX = ".summary.md";

export const DEEP_SCAN_MAX_FILES = 300;
export const DEEP_SCAN_MAX_FILE_BYTES = 32_768;
export const DEEP_SCAN_CONCURRENCY = 4;

/** A parsed summary sidecar. */
export interface SummaryRecord {
  /** Repo-relative source path this summary describes. */
  target: string;
  /** sha1 of the file content at summarize time. */
  contentHash: string;
  summary: string;
  model: string | null;
  at: string;
  source: NoteSource;
}

/** One call to the (injected) language model. */
export type SummarizeFn = (file: { path: string; content: string }) => Promise<string>;

export interface DeepScanOptions {
  summarize: SummarizeFn;
  at?: () => Date;
  maxFiles?: number;
  maxFileBytes?: number;
  concurrency?: number;
  /** Model label recorded in sidecar front matter (provenance detail). */
  model?: string;
  /**
   * Called before each candidate file is processed. `current` is 1-based
   * (the file about to be handled), `total` is the candidate count — the
   * adapter renders this as a live progress line.
   */
  onProgress?: (info: { current: number; total: number; path: string }) => void;
  /** When aborted, stop scheduling new work and return partial results. */
  signal?: AbortSignal;
}

export interface DeepScanFailure {
  path: string;
  error: string;
}

export interface DeepScanResult {
  /** Candidate source files considered (after skip-lists and caps). */
  considered: number;
  written: number;
  /** Unchanged since their summary (content hash match) — no LLM call. */
  skippedFresh: number;
  /** Candidates skipped because they exceed the byte cap. */
  skippedTooBig: number;
  failed: DeepScanFailure[];
  /** Sidecars removed because their target is no longer tracked. */
  pruned: number;
}

/** Deterministic sidecar file name for a repo-relative target path. */
export function summaryFileName(target: string): string {
  return target.split("/").join("--") + SUMMARY_SUFFIX;
}

function summariesDir(repoRoot: string): string {
  return join(repoKnowledgeDir(repoRoot), SUMMARIES_DIR);
}

/** Absolute sidecar path for a target (name is derived, never user input). */
export function summaryPath(repoRoot: string, target: string): string {
  return join(summariesDir(repoRoot), summaryFileName(target));
}

/**
 * Serialize a summary sidecar: OKF-front-matter + summary body, provenance
 * always "generated" (AGENTS.md rule 4).
 */
export function serializeSummary(rec: SummaryRecord): string {
  const lines = [
    "---",
    `target: ${quoteField(rec.target)}`,
    `source: ${rec.source}`,
    `content_hash: ${quoteField(rec.contentHash)}`,
    `at: ${quoteField(rec.at)}`,
  ];
  if (rec.model !== null) lines.push(`model: ${quoteField(rec.model)}`);
  lines.push("---", "", rec.summary.replace(/\s+$/, ""), "");
  return lines.join("\n");
}

export function parseSummaryFile(text: string): SummaryRecord | null {
  const parsed = parseFrontMatter(text);
  if (!parsed) return null;
  const target = unquoteField(parsed.fields.get("target") ?? "");
  const contentHash = unquoteField(parsed.fields.get("content_hash") ?? "");
  const at = unquoteField(parsed.fields.get("at") ?? "");
  if (target.length === 0 || contentHash.length === 0 || at.length === 0) return null;
  const rawSource = parsed.fields.get("source") ?? "";
  return {
    target,
    contentHash,
    summary: parsed.body,
    model: parsed.fields.has("model") ? unquoteField(parsed.fields.get("model") ?? "") : null,
    at,
    source: rawSource === "human" || rawSource === "agent" || rawSource === "generated"
      ? rawSource
      : "generated",
  };
}

/** All summaries currently on disk. Corrupt sidecars are skipped. */
export async function readSummaries(repoRoot: string): Promise<SummaryRecord[]> {
  let names: string[];
  try {
    names = await fs.readdir(summariesDir(repoRoot));
  } catch {
    return [];
  }
  const out: SummaryRecord[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(SUMMARY_SUFFIX)) continue;
    try {
      const rec = parseSummaryFile(await fs.readFile(join(summariesDir(repoRoot), name), "utf8"));
      if (rec) out.push(rec);
    } catch {
      // unreadable sidecar — skip
    }
  }
  return out;
}

/** Summaries keyed by target path — the shape buildGraph/dash want. */
export async function readSummaryMap(repoRoot: string): Promise<Map<string, SummaryRecord>> {
  const map = new Map<string, SummaryRecord>();
  for (const rec of await readSummaries(repoRoot)) map.set(rec.target, rec);
  return map;
}

/* ------------------------------------------------------------------ */
/* Deep scan                                                           */
/* ------------------------------------------------------------------ */

/** Files that never deserve a summary (lockfiles, minified, snapshots, media). */
const SKIP_NAME = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|cargo\.lock|go\.sum|gemfile\.lock|poetry\.lock|bun\.lockb?)$/i;
const SKIP_EXT = /\.(min\.(js|css)|map|snap|png|jpe?g|gif|webp|avif|ico|bmp|svg|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|wasm|sqlite3?|db|bin|exe|dll|so|dylib|a|o|class|pyc|mp[34]|mov|webm|wav|flac|ogg)$/i;

/** Cheap binary sniff: NUL byte in the first 8 KiB means binary. */
function looksBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, 8192);
  for (let i = 0; i < limit; i++) if (buf[i] === 0) return true;
  return false;
}

/** Never summarize our own derived artifacts (`.okf/` sidecars etc.). */
const SKIP_OKF = /(^|\/)\.okf(\/|$)/;

export function isSummarizablePath(path: string): boolean {
  return !SKIP_OKF.test(path) && !SKIP_NAME.test(path) && !SKIP_EXT.test(path);
}

export function hashContent(content: string | Buffer): string {
  return createHash("sha1").update(content).digest("hex");
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  shouldStop?: () => boolean,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      if (shouldStop?.()) return;
      const i = next++;
      results[i] = await fn(items[i] as T, i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return results;
}

/**
 * Run the deep scan: summarize tracked source files into summary sidecars.
 * Incremental (content-hash skip) and failure-tolerant per file.
 */
export async function runDeepScan(repoRoot: string, options: DeepScanOptions): Promise<DeepScanResult | null> {
  const maxFiles = options.maxFiles ?? DEEP_SCAN_MAX_FILES;
  const maxFileBytes = options.maxFileBytes ?? DEEP_SCAN_MAX_FILE_BYTES;
  const concurrency = options.concurrency ?? DEEP_SCAN_CONCURRENCY;
  const now = options.at ?? (() => new Date());
  const signal = options.signal;
  const onProgress = options.onProgress;
  const aborted = () => signal?.aborted === true;

  const listed = await listFiles(repoRoot);
  if (listed === null) return null; // not a git repository

  const candidates = listed.filter(isSummarizablePath).slice(0, maxFiles);
  const existing = await readSummaryMap(repoRoot);
  const existingByHash = new Map<string, SummaryRecord>(
    [...existing.values()].map((r) => [r.target, r]),
  );

  const result: DeepScanResult = {
    considered: candidates.length,
    written: 0,
    skippedFresh: 0,
    skippedTooBig: 0,
    failed: [],
    pruned: 0,
  };

  await mapWithConcurrency(candidates, concurrency, async (path, index) => {
    onProgress?.({ current: index + 1, total: candidates.length, path });
    let buf: Buffer;
    try {
      buf = await fs.readFile(join(repoRoot, path));
    } catch {
      result.failed.push({ path, error: "unreadable" });
      return;
    }
    if (buf.length > maxFileBytes || (buf.length > 0 && looksBinary(buf))) {
      result.skippedTooBig += 1;
      return;
    }
    const hash = hashContent(buf);
    if (existingByHash.get(path)?.contentHash === hash) {
      result.skippedFresh += 1;
      return;
    }
    try {
      const summary = (await options.summarize({ path, content: buf.toString("utf8") })).trim();
      await writeSummary(repoRoot, {
        target: path,
        contentHash: hash,
        summary,
        model: options.model ?? null,
        at: now().toISOString(),
        source: "generated",
      });
      result.written += 1;
    } catch (err) {
      result.failed.push({ path, error: err instanceof Error ? err.message : String(err) });
    }
  }, aborted);

  // Prune sidecars whose target left the tracked set.
  const targets = new Set(listed);
  result.pruned = await pruneSummaries(repoRoot, (rec) => targets.has(rec.target));
  return result;
}

/** Write one summary sidecar (mkdir -p; rename for crash safety). */
export async function writeSummary(repoRoot: string, rec: SummaryRecord): Promise<string> {
  const dir = summariesDir(repoRoot);
  await fs.mkdir(dir, { recursive: true });
  const file = summaryPath(repoRoot, rec.target);
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, serializeSummary(rec), "utf8");
  await fs.rename(tmp, file);
  return file;
}

/** Delete sidecars whose record fails `keep`. Returns number removed. */
export async function pruneSummaries(
  repoRoot: string,
  keep: (rec: SummaryRecord) => boolean,
): Promise<number> {
  const dir = summariesDir(repoRoot);
  let removed = 0;
  for (const rec of await readSummaries(repoRoot)) {
    if (keep(rec)) continue;
    try {
      await fs.unlink(join(dir, summaryFileName(rec.target)));
      removed += 1;
    } catch {
      // already gone
    }
  }
  return removed;
}
