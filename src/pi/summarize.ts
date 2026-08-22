/**
 * pi adapter for deep scans: resolves the session's already-configured model
 * (the codebase-memory-mcp lesson — no extra keys/providers) and drives
 * pi-ai completion through `ctx.modelRegistry`, which owns auth.
 *
 * `createLlmSummarizer` returns null when no model is active (headless
 * runs without a provider, etc.) — callers fall back to light-only.
 * `deps.complete` is the test seam: unit tests inject a fake and never
 * touch a network.
 */

import {
  contentText,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runDeepScan, type DeepScanOptions, type DeepScanResult, type SummarizeFn } from "../core";

export type CompleteFn = (
  model: Model<Api>,
  context: Context,
  options: { maxTokens?: number; signal?: AbortSignal },
) => Promise<AssistantMessage>;

export interface SummarizerDeps {
  complete?: CompleteFn;
}

export interface LlmSummarizer {
  summarize: SummarizeFn;
  /** Provenance label recorded in sidecar front matter (e.g. "ollama/kimi-k3:cloud"). */
  label: string;
}

const SYSTEM_PROMPT = [
  "You write terse, navigation-oriented summaries of source files for a codebase index.",
  "Rules: 1–3 sentences. What the file does, its outward surface (exports/routes/commands),",
  "anything surprising (globals, side effects, generated sections). No preamble, no headings, no code fences.",
].join("\n");

const MAX_OUTPUT_TOKENS = 220;
const REQUEST_TIMEOUT_MS = 30_000;

/** Create the model-backed summarizer, or null when the session has no active model. */
export function createLlmSummarizer(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  deps: SummarizerDeps = {},
): LlmSummarizer | null {
  const model = ctx.model;
  if (!model) return null;
  const complete: CompleteFn =
    deps.complete ?? ((m, c, o) => ctx.modelRegistry.complete(m, c, o));
  const label = `${model.provider}/${model.id}`;
  const summarize: SummarizeFn = async ({ path, content }) => {
    const message = await complete(
      model,
      {
        systemPrompt: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `File: ${path}\n\n\`\`\`\n${content}\n\`\`\``,
            timestamp: Date.now(),
          },
        ],
      },
      { maxTokens: MAX_OUTPUT_TOKENS, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );
    const text = contentText(message.content).trim();
    if (text.length === 0) {
      throw new Error("model returned an empty summary");
    }
    return text;
  };
  return { summarize, label };
}

export type DeepScanOutcome =
  | { kind: "ok"; result: DeepScanResult }
  | { kind: "no-model" }
  | { kind: "not-a-repo" };

type DeepScanTuning = {
  at?: DeepScanOptions["at"];
  maxFiles?: DeepScanOptions["maxFiles"];
  maxFileBytes?: DeepScanOptions["maxFileBytes"];
  concurrency?: DeepScanOptions["concurrency"];
  onProgress?: DeepScanOptions["onProgress"];
  signal?: DeepScanOptions["signal"];
};

/** Run the deep pass against a repo root using the session model. */
export async function deepScanRepository(
  repoRoot: string,
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  deps: SummarizerDeps & DeepScanTuning = {},
): Promise<DeepScanOutcome> {
  const llm = createLlmSummarizer(ctx, deps);
  if (!llm) return { kind: "no-model" };
  // exactOptionalPropertyTypes: only present keys may be spread in.
  const result = await runDeepScan(repoRoot, {
    summarize: llm.summarize,
    model: llm.label,
    ...(deps.at !== undefined ? { at: deps.at } : {}),
    ...(deps.maxFiles !== undefined ? { maxFiles: deps.maxFiles } : {}),
    ...(deps.maxFileBytes !== undefined ? { maxFileBytes: deps.maxFileBytes } : {}),
    ...(deps.concurrency !== undefined ? { concurrency: deps.concurrency } : {}),
    ...(deps.onProgress !== undefined ? { onProgress: deps.onProgress } : {}),
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
  });
  if (result === null) return { kind: "not-a-repo" };
  return { kind: "ok", result };
}

/** One-line human summary of a deep-scan result (for notify output). */
export function formatDeepScanResult(result: DeepScanResult): string {
  const parts = [
    `${result.written} summarized`,
    `${result.skippedFresh} unchanged`,
  ];
  if (result.skippedTooBig > 0) parts.push(`${result.skippedTooBig} skipped (size/type)`);
  if (result.pruned > 0) parts.push(`${result.pruned} pruned`);
  let text = `${parts.join(", ")} — ${result.considered} files considered`;
  if (result.failed.length > 0) {
    const [failed0] = result.failed;
    if (failed0) {
      text += `; ${result.failed.length} failed, first: ${failed0.path}: ${failed0.error}`;
    }
  }
  return text;
}
