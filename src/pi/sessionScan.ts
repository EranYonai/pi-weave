/**
 * pi adapter for the session scan: summarize agent
 * session transcripts into the vault as incremental memory notes.
 *
 * Model wiring is shared with the deep scan (`createModelSummarizer` — the
 * session's already-configured model, auth via `modelRegistry`); only the
 * prompt differs, because a session transcript wants different sentences
 * than a source file. `deps.complete` is the test seam — no network in unit
 * tests.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  resolveSessionsRoot,
  resolveVaultRoot,
  runSessionScan,
  SESSION_SCAN_SYSTEM_PROMPT,
  formatSessionScanResult,
  type SessionScanOptions,
  type SessionScanResult,
  type SummarizeFn,
} from "../core";
import { createModelSummarizer, type SummarizerDeps } from "./summarize";

const SESSION_MAX_OUTPUT_TOKENS = 3_000;

/** Session summarizer over the session model, or null when none is active. */
export function createSessionSummarizer(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  deps: SummarizerDeps = {},
): { summarize: SummarizeFn; label: string } | null {
  return createModelSummarizer(ctx, SESSION_SCAN_SYSTEM_PROMPT, SESSION_MAX_OUTPUT_TOKENS, deps);
}

export type SessionScanOutcome =
  | { kind: "ok"; result: SessionScanResult }
  | { kind: "no-model" };

export interface SessionScanAdapterOptions {
  complete?: SummarizerDeps["complete"];
  maxSessions?: SessionScanOptions["maxSessions"];
  maxFileBytes?: SessionScanOptions["maxFileBytes"];
  concurrency?: SessionScanOptions["concurrency"];
  sessionsRoot?: SessionScanOptions["sessionsRoot"];
  vaultRoot?: SessionScanOptions["vaultRoot"];
  now?: SessionScanOptions["now"];
  onProgress?: SessionScanOptions["onProgress"];
  signal?: SessionScanOptions["signal"];
}

/**
 * Scan pi sessions into the vault using the session model. Roots default to
 * the real locations (PI_WEAVE_SESSIONS / PI_WEAVE_VAULT overrides apply);
 * tests inject both.
 */
export async function scanPiSessions(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  deps: SessionScanAdapterOptions = {},
): Promise<SessionScanOutcome> {
  const llm = createSessionSummarizer(
    ctx,
    deps.complete !== undefined ? { complete: deps.complete } : {},
  );
  if (!llm) return { kind: "no-model" };
  // exactOptionalPropertyTypes: only present keys may be spread in.
  const result = await runSessionScan({
    sessionsRoot: deps.sessionsRoot ?? resolveSessionsRoot(),
    vaultRoot: deps.vaultRoot ?? resolveVaultRoot(),
    summarize: llm.summarize,
    model: llm.label,
    ...(deps.maxSessions !== undefined ? { maxSessions: deps.maxSessions } : {}),
    ...(deps.maxFileBytes !== undefined ? { maxFileBytes: deps.maxFileBytes } : {}),
    ...(deps.concurrency !== undefined ? { concurrency: deps.concurrency } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.onProgress !== undefined ? { onProgress: deps.onProgress } : {}),
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
  });
  return { kind: "ok", result };
}

export { formatSessionScanResult };
