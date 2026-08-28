/**
 * L2 — session-scan adapter (src/pi/sessionScan.ts) plus the
 * `/weave-scan sessions` command path: session-model wiring (no network),
 * background lifecycle, cancellation, and repo-agnosticity.
 */
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getNote } from "../../src/core";
import piWeave, { sessionScanDone } from "../../src/pi/index";
import {
  createSessionSummarizer,
  formatSessionScanResult,
  scanPiSessions,
} from "../../src/pi/sessionScan";
import {
  createMockCtx,
  createMockPi,
  makeTempDir,
  withSessionsEnv,
  withVaultEnv,
  writeFixture,
} from "../helpers";

const MODEL = { provider: "testprovider", id: "test-model-1" };

function asExtensionCtx(ctx: unknown): Pick<ExtensionContext, "model" | "modelRegistry"> {
  return ctx as Pick<ExtensionContext, "model" | "modelRegistry">;
}

const SESSION_A = [
  JSON.stringify({ type: "session", version: 3, id: "aaaa-bbbb-cccc", timestamp: "2026-08-22T06:33:12.008Z", cwd: "/tmp/proj" }),
  JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-08-22T06:35:00Z", message: { role: "user", content: "build the memory feature" } }),
  "",
].join("\n");

async function putSession(sessions: string, name: string, content: string) {
  await writeFixture(sessions, `--proj--/${name}`, content);
}

function buildExtension() {
  const mock = createMockPi();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  piWeave(mock.api as any);
  return mock;
}

describe("createSessionSummarizer", () => {
  it("returns null when the session has no active model", () => {
    expect(createSessionSummarizer(asExtensionCtx(createMockCtx("/x", true)))).toBeNull();
  });

  it("writes session-memory sentences via the registry with a larger token cap", async () => {
    const seen: { context: unknown; options: unknown }[] = [];
    const ctx = createMockCtx("/x", true, {
      model: MODEL,
      complete: async (_model, context, options) => {
        seen.push({ context, options });
        return fauxAssistantMessage("The user built session memory.");
      },
    });
    const llm = createSessionSummarizer(asExtensionCtx(ctx));
    expect(llm).not.toBeNull();
    expect(llm!.label).toBe("testprovider/test-model-1");

    const out = await llm!.summarize({ path: "/sessions/x.jsonl", content: "Session abc (2026-…)" });
    expect(out).toBe("The user built session memory.");
    const { context, options } = seen[0] as {
      context: { systemPrompt?: string; messages: { content: string }[] };
      options: { maxTokens?: number };
    };
    expect(context.systemPrompt).toContain("memory notes");
    expect(context.systemPrompt).toContain("3–6 sentences");
    // the compaction contract: bottom line, not a vague overview
    expect(context.systemPrompt).toContain("what shipped");
    expect(context.systemPrompt).toContain("what went less well");
    expect(context.messages[0]?.content).toContain("Session abc");
    expect(options.maxTokens).toBe(400);
  });

  it("honors an injected deps.complete over the registry (unit-test seam)", async () => {
    const ctx = createMockCtx("/x", true, {
      model: MODEL,
      complete: async () => {
        throw new Error("registry should not be used");
      },
    });
    const llm = createSessionSummarizer(asExtensionCtx(ctx), { complete: async () => fauxAssistantMessage("seam") });
    expect(await llm!.summarize({ path: "p", content: "c" })).toBe("seam");
  });
});

describe("scanPiSessions", () => {
  it("returns no-model without touching the filesystem", async () => {
    const outcome = await scanPiSessions(asExtensionCtx(createMockCtx("/x", true)));
    expect(outcome).toEqual({ kind: "no-model" });
  });

  it("summarizes sessions into the injected vault, defaulting roots from env", async () => {
    const sessions = await makeTempDir();
    const vault = await makeTempDir();
    try {
      await putSession(sessions, "a.jsonl", SESSION_A);
      await withSessionsEnv(sessions, async () =>
        withVaultEnv(vault, async () => {
          const ctx = createMockCtx("/anywhere", true, {
            model: MODEL,
            complete: async () => fauxAssistantMessage("They built memory."),
          });
          const progress: { current: number; total: number; path: string }[] = [];
          const outcome = await scanPiSessions(asExtensionCtx(ctx), {
            onProgress: (p) => progress.push(p),
          });
          expect(outcome.kind).toBe("ok");
          if (outcome.kind !== "ok") return;
          expect(outcome.result.written).toBe(1);
          expect(progress).toHaveLength(1);
          const note = await getNote(vault, "sessions/build-the-memory-feature");
          expect(note?.body).toContain("They built memory.");
          expect(note?.body).toContain("by testprovider/test-model-1");
        }),
      );
    } finally {
      await fs.rm(sessions, { recursive: true, force: true });
      await fs.rm(vault, { recursive: true, force: true });
    }
  });

  it("forwards every tuning option to the core scan", async () => {
    const sessions = await makeTempDir();
    const vault = await makeTempDir();
    try {
      await putSession(sessions, "a.jsonl", SESSION_A);
      await putSession(sessions, "b.jsonl", SESSION_A.replace("aaaa-bbbb-cccc", "ffff-2222-3333"));
      const ctx = createMockCtx("/x", true, {
        model: MODEL,
        complete: async () => fauxAssistantMessage("s"),
      });
      const progress: { current: number; total: number; path: string }[] = [];
      const outcome = await scanPiSessions(asExtensionCtx(ctx), {
        sessionsRoot: sessions,
        vaultRoot: vault,
        maxSessions: 1,
        maxFileBytes: 1024,
        concurrency: 1,
        now: () => new Date("2026-08-23T12:00:00Z"),
        onProgress: (p) => progress.push(p),
      });
      expect(outcome.kind).toBe("ok");
      if (outcome.kind !== "ok") return;
      expect(outcome.result.considered).toBe(1);
      expect(outcome.result.created).toBe(1);
      const note = await getNote(vault, "sessions/build-the-memory-feature");
      expect(note?.created).toBe("2026-08-23T12:00:00.000Z");
      expect(progress).toHaveLength(1);
    } finally {
      await fs.rm(sessions, { recursive: true, force: true });
      await fs.rm(vault, { recursive: true, force: true });
    }
  });

  it("forwards the abort signal (partial results on cancellation)", async () => {
    const sessions = await makeTempDir();
    const vault = await makeTempDir();
    try {
      await putSession(sessions, "a.jsonl", SESSION_A);
      const controller = new AbortController();
      const ctx = createMockCtx("/x", true, {
        model: MODEL,
        complete: async () => {
          controller.abort();
          return fauxAssistantMessage("s");
        },
      });
      const outcome = await scanPiSessions(asExtensionCtx(ctx), {
        sessionsRoot: sessions,
        vaultRoot: vault,
        signal: controller.signal,
      });
      expect(outcome.kind).toBe("ok");
    } finally {
      await fs.rm(sessions, { recursive: true, force: true });
      await fs.rm(vault, { recursive: true, force: true });
    }
  });
});

describe("formatSessionScanResult", () => {
  it("renders counts and skips zero buckets", () => {
    expect(formatSessionScanResult({
      discovered: 40, considered: 40, written: 3, created: 1, updated: 2,
      skippedFresh: 37, skippedEmpty: 0, skippedTooBig: 0, skippedUnreadable: 0, migrated: 0, failed: [],
    })).toBe("3 summarized (1 new, 2 updated), 37 unchanged — 40 sessions considered");
  });

  it("includes nonzero skip buckets and the first failure", () => {
    const text = formatSessionScanResult({
      discovered: 10, considered: 8, written: 1, created: 1, updated: 0,
      skippedFresh: 4, skippedEmpty: 2, skippedTooBig: 1, skippedUnreadable: 1,
      migrated: 0, failed: [{ path: "x.jsonl", error: "timeout" }],
    });
    expect(text).toContain("2 empty");
    expect(text).toContain("1 skipped (size)");
    expect(text).toContain("1 unreadable");
    expect(text).toContain("1 failed, first: x.jsonl: timeout");
  });
});

describe("/weave-scan sessions command", () => {
  it("runs in the background outside any git repository and writes vault notes", async () => {
    const mock = buildExtension();
    const sessions = await makeTempDir();
    const vault = await makeTempDir();
    const cwd = await makeTempDir(); // deliberately not a git repo
    try {
      await putSession(sessions, "a.jsonl", SESSION_A);
      await withSessionsEnv(sessions, async () =>
        withVaultEnv(vault, async () => {
          const ctx = createMockCtx(cwd, true, {
            model: MODEL,
            complete: async () => fauxAssistantMessage("Remembered."),
          });
          await mock.commands.get("weave-scan")!.handler("sessions", ctx);
          await sessionScanDone();
          expect(ctx.ui.notifications.some((n) => n.message.includes("session scan complete"))).toBe(true);
          expect((await getNote(vault, "sessions/build-the-memory-feature"))!.body).toContain("Remembered.");
          // The settled status line reflects the vault the scan just grew.
          expect(ctx.ui.statuses.weave).toContain("vault:1");
        }),
      );
    } finally {
      await fs.rm(sessions, { recursive: true, force: true });
      await fs.rm(vault, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("warns when no session model is active", async () => {
    const mock = buildExtension();
    const sessions = await makeTempDir();
    const vault = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await withSessionsEnv(sessions, async () =>
        withVaultEnv(vault, async () => {
          const ctx = createMockCtx(cwd, true); // no model
          await mock.commands.get("weave-scan")!.handler("sessions", ctx);
          await sessionScanDone();
          expect(ctx.ui.notifications.some((n) => n.message.includes("needs an active session model"))).toBe(true);
        }),
      );
    } finally {
      await fs.rm(sessions, { recursive: true, force: true });
      await fs.rm(vault, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("refuses to start a second session scan while one is running", async () => {
    const mock = buildExtension();
    const sessions = await makeTempDir();
    const vault = await makeTempDir();
    try {
      await withSessionsEnv(sessions, async () =>
        withVaultEnv(vault, async () => {
          const ctx = createMockCtx(sessions, true, {
            model: MODEL,
            complete: async () => {
              await new Promise((r) => setTimeout(r, 300));
              return fauxAssistantMessage("s");
            },
          });
          await mock.commands.get("weave-scan")!.handler("sessions", ctx);
          await mock.commands.get("weave-scan")!.handler("sessions", ctx);
          expect(ctx.ui.notifications.some((n) => n.message.includes("already running"))).toBe(true);
          await sessionScanDone();
        }),
      );
    } finally {
      await fs.rm(sessions, { recursive: true, force: true });
      await fs.rm(vault, { recursive: true, force: true });
    }
  });

  it("is cancellable via /weave-scan-cancel", async () => {
    const mock = buildExtension();
    const sessions = await makeTempDir();
    const vault = await makeTempDir();
    try {
      await putSession(sessions, "a.jsonl", SESSION_A);
      await withSessionsEnv(sessions, async () =>
        withVaultEnv(vault, async () => {
          const ctx = createMockCtx(sessions, true, {
            model: MODEL,
            complete: async () => {
              await new Promise((r) => setTimeout(r, 50));
              return fauxAssistantMessage("s");
            },
          });
          await mock.commands.get("weave-scan")!.handler("sessions", ctx);
          await mock.commands.get("weave-scan-cancel")!.handler("", ctx);
          await sessionScanDone();
          expect(ctx.ui.notifications.some((n) => n.message.includes("cancellation requested"))).toBe(true);
          expect(ctx.ui.notifications.some((n) => n.message.includes("session scan cancelled"))).toBe(true);
        }),
      );
    } finally {
      await fs.rm(sessions, { recursive: true, force: true });
      await fs.rm(vault, { recursive: true, force: true });
    }
  });

  it("reports when nothing was found", async () => {
    const mock = buildExtension();
    const sessions = await makeTempDir();
    const vault = await makeTempDir();
    try {
      await withSessionsEnv(sessions, async () =>
        withVaultEnv(vault, async () => {
          const ctx = createMockCtx(sessions, true, {
            model: MODEL,
            complete: async () => fauxAssistantMessage("s"),
          });
          await mock.commands.get("weave-scan")!.handler("sessions", ctx);
          await sessionScanDone();
          expect(ctx.ui.notifications.some((n) => n.message.includes("no pi sessions found"))).toBe(true);
        }),
      );
    } finally {
      await fs.rm(sessions, { recursive: true, force: true });
      await fs.rm(vault, { recursive: true, force: true });
    }
  });
});