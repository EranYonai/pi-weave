/**
 * L2 — deep-scan summarizer adapter: model resolution, prompt shape, and the
 * deep-scan command path. The LLM is stubbed via the `complete` seam or a
 * mock modelRegistry — no network, ever.
 */
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { readSummaryMap } from "../../src/core";
import {
  createLlmSummarizer,
  deepScanRepository,
  formatDeepScanResult,
} from "../../src/pi/summarize";
import { commitAll, createMockCtx, gitInit, makeTempDir, writeFixture } from "../helpers";
import * as fs from "node:fs/promises";

const MODEL = { provider: "testprovider", id: "test-model-1" };

function ctxWithModel(
  cwd: string,
  complete: (model: unknown, context: unknown, options?: unknown) => Promise<unknown>,
) {
  return createMockCtx(cwd, true, { model: MODEL, complete });
}

function asExtensionCtx(ctx: unknown): Pick<ExtensionContext, "model" | "modelRegistry"> {
  return ctx as Pick<ExtensionContext, "model" | "modelRegistry">;
}

describe("createLlmSummarizer", () => {
  it("returns null when the session has no active model", () => {
    const ctx = createMockCtx("/x", true); // no model configured
    expect(createLlmSummarizer(asExtensionCtx(ctx))).toBeNull();
  });

  it("builds a summarizer labeled provider/model that drives complete() with capped output", async () => {
    const seen: { context: unknown; options: unknown }[] = [];
    const ctx = ctxWithModel("/x", async (_model, context, options) => {
      seen.push({ context, options });
      return fauxAssistantMessage("Pure graph builder, no I/O.");
    });
    const llm = createLlmSummarizer(asExtensionCtx(ctx));
    expect(llm).not.toBeNull();
    expect(llm!.label).toBe("testprovider/test-model-1");

    const out = await llm!.summarize({ path: "src/core/graph/build.ts", content: "export function …" });
    expect(out).toBe("Pure graph builder, no I/O.");
    expect(seen).toHaveLength(1);
    const { context, options } = seen[0] as {
      context: { systemPrompt?: string; messages: { role: string; content: string }[] };
      options: { maxTokens?: number; signal?: AbortSignal };
    };
    expect(context.systemPrompt).toContain("1–3 sentences");
    const msg = context.messages[0];
    expect(msg?.role).toBe("user");
    expect(msg?.content).toContain("src/core/graph/build.ts");
    expect(msg?.content).toContain("export function …");
    expect(options.maxTokens).toBeGreaterThan(0);
    expect(options.maxTokens).toBeLessThanOrEqual(400);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects when the model returns only whitespace (no silent empty summaries)", async () => {
    const ctx = ctxWithModel("/x", async () => fauxAssistantMessage("   \n  "));
    const llm = createLlmSummarizer(asExtensionCtx(ctx));
    await expect(llm!.summarize({ path: "a.ts", content: "x" })).rejects.toThrow("empty summary");
  });

  it("honors an injected deps.complete over the registry (unit-test seam)", async () => {
    const ctx = ctxWithModel("/x", async () => { throw new Error("registry should not be used"); });
    const llm = createLlmSummarizer(asExtensionCtx(ctx), {
      complete: async () => fauxAssistantMessage("injected path"),
    });
    expect(await llm!.summarize({ path: "a.ts", content: "x" })).toBe("injected path");
  });
});

describe("deepScanRepository", () => {
  it("returns no-model when the session cannot summarize", async () => {
    const root = await makeTempDir();
    try {
      gitInit(root);
      await writeFixture(root, "a.ts", "export {};\n");
      await commitAll(root);
      expect(await deepScanRepository(root, asExtensionCtx(createMockCtx(root)))).toEqual({ kind: "no-model" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns not-a-repo outside git without calling the model", async () => {
    const dir = await makeTempDir();
    try {
      const ctx = ctxWithModel(dir, async () => { throw new Error("should never be called"); });
      expect(await deepScanRepository(dir, asExtensionCtx(ctx))).toEqual({ kind: "not-a-repo" });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("writes generated-provenance sidecars for source files via the session model", async () => {
    const root = await makeTempDir();
    try {
      gitInit(root);
      await writeFixture(root, "src/one.ts", "export const one = 1;\n");
      await writeFixture(root, "src/two.ts", "export const two = 2;\n");
      await writeFixture(root, "package-lock.json", "{}");
      await commitAll(root);

      const ctx = ctxWithModel(root, async (_m, context) => {
        const msg = (context as { messages: { content: string }[] }).messages[0]!.content;
        const path = /File: (.+)\n/.exec(msg)![1];
        return fauxAssistantMessage(`Summary of ${path}.`);
      });
      const outcome = await deepScanRepository(root, asExtensionCtx(ctx), { at: () => new Date("2026-08-23T12:00:00Z") });
      expect(outcome.kind).toBe("ok");
      if (outcome.kind !== "ok") return;
      expect(outcome.result.written).toBe(2);

      const map = await readSummaryMap(root);
      expect(map.get("src/one.ts")?.summary).toBe("Summary of src/one.ts.");
      expect(map.get("src/one.ts")?.source).toBe("generated");
      expect(map.get("src/one.ts")?.model).toBe("testprovider/test-model-1");
      expect(map.has("package-lock.json")).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("forwards all tuning deps to the deep scan", async () => {
    const root = await makeTempDir();
    try {
      gitInit(root);
      await writeFixture(root, "a.ts", "export {};\n");
      await commitAll(root);
      const ctx = ctxWithModel(root, async () => fauxAssistantMessage("s"));
      const outcome = await deepScanRepository(root, asExtensionCtx(ctx), {
        at: () => new Date("2026-08-23T12:00:00Z"),
        maxFiles: 1,
        maxFileBytes: 100,
        concurrency: 1,
      });
      expect(outcome.kind).toBe("ok");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("forwards onProgress and signal to the deep scan", async () => {
    const root = await makeTempDir();
    try {
      gitInit(root);
      await writeFixture(root, "a.ts", "export {};\n");
      await writeFixture(root, "b.ts", "export {};\n");
      await commitAll(root);
      const ctx = ctxWithModel(root, async () => fauxAssistantMessage("s"));
      const controller = new AbortController();
      const seen: { current: number; total: number; path: string }[] = [];
      const outcome = await deepScanRepository(root, asExtensionCtx(ctx), {
        onProgress: (info) => seen.push(info),
        signal: controller.signal,
      });
      expect(outcome.kind).toBe("ok");
      expect(seen.map((s) => s.path).sort()).toEqual(["a.ts", "b.ts"]);
      expect(seen.every((s) => s.total === 2)).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("formatDeepScanResult", () => {
  it("renders counts, skipping zero buckets", () => {
    expect(formatDeepScanResult({
      considered: 10, written: 4, skippedFresh: 6, skippedTooBig: 0, failed: [], pruned: 0,
    })).toBe("4 summarized, 6 unchanged — 10 files considered");
  });

  it("includes size-skip and prune buckets when nonzero", () => {
    expect(formatDeepScanResult({
      considered: 12, written: 1, skippedFresh: 0, skippedTooBig: 9, failed: [], pruned: 2,
    })).toContain("9 skipped (size/type)");
    expect(formatDeepScanResult({
      considered: 12, written: 1, skippedFresh: 0, skippedTooBig: 9, failed: [], pruned: 2,
    })).toContain("2 pruned");
  });

  it("surfaces the first failure with its path and error", () => {
    const text = formatDeepScanResult({
      considered: 3, written: 2, skippedFresh: 0, skippedTooBig: 0, pruned: 0,
      failed: [{ path: "src/x.ts", error: "timeout" }, { path: "src/y.ts", error: "boom" }],
    });
    expect(text).toContain("2 failed");
    expect(text).toContain("src/x.ts: timeout");
  });
});
