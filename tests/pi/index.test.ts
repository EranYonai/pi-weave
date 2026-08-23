import { promises as fs } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import piWeave, { deepScanDone } from "../../src/pi/index";
import { commitAll, createMockCtx, createMockPi, gitExec, gitInit, makeTempDir, withVaultEnv, writeFixture } from "../helpers";

function buildExtension() {
  const mock = createMockPi();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  piWeave(mock.api as any);
  return mock;
}

async function makeRepo(): Promise<string> {
  const dir = await makeTempDir();
  gitInit(dir);
  await writeFixture(dir, "src/index.ts", "export {};\n");
  commitAll(dir, "initial");
  return dir;
}

describe("extension registration", () => {
  it("registers both tools and both commands", () => {
    const mock = buildExtension();
    expect([...mock.tools.keys()].sort()).toEqual(["weave_note", "weave_repo"]);
    expect([...mock.commands.keys()].sort()).toEqual(["weave", "weave-scan", "weave-scan-cancel", "weave-view"]);
    for (const name of ["weave_note", "weave_repo"]) {
      const tool = mock.tools.get(name)!;
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.promptSnippet).toBeTruthy();
      expect(tool.promptGuidelines?.every((g) => g.includes(name))).toBe(true);
    }
  });
});

describe("session_start", () => {
  it("sets the vault-only status line outside a repo", async () => {
    const mock = buildExtension();
    const cwd = await makeTempDir();
    await withVaultEnv(await makeTempDir(), async () => {
      const ctx = createMockCtx(cwd);
      await mock.emit("session_start", {}, ctx);
      expect(ctx.ui.statuses.weave).toBe("○ 🧵 vault:0");
      expect(ctx.ui.notifications).toEqual([]);
    });
  });

  it("updates status indicator on agent_start and agent_end", async () => {
    const mock = buildExtension();
    const cwd = await makeTempDir();
    await withVaultEnv(await makeTempDir(), async () => {
      const ctx = createMockCtx(cwd);
      await mock.emit("session_start", {}, ctx);
      expect(ctx.ui.statuses.weave).toBe("○ 🧵 vault:0");

      await mock.emit("agent_start", {}, ctx);
      expect(ctx.ui.statuses.weave).toBe("● 🧵 vault:0");

      await mock.emit("agent_end", {}, ctx);
      expect(ctx.ui.statuses.weave).toBe("○ 🧵 vault:0");

      // Uses lastCtx when event ctx is undefined
      await mock.emit("agent_start", {}, undefined as unknown as typeof ctx);
      expect(ctx.ui.statuses.weave).toBe("● 🧵 vault:0");
      await mock.emit("agent_end", {}, undefined as unknown as typeof ctx);
      expect(ctx.ui.statuses.weave).toBe("○ 🧵 vault:0");
    });
  });

  it("handles ctx without theme or when theme property access throws", async () => {
    const mock = buildExtension();
    const cwd = await makeTempDir();
    await withVaultEnv(await makeTempDir(), async () => {
      const ctx = createMockCtx(cwd);
      delete (ctx.ui as { theme?: unknown }).theme;
      await mock.emit("session_start", {}, ctx);
      expect(ctx.ui.statuses.weave).toBe("○ 🧵 vault:0");

      const throwingCtx = createMockCtx(cwd);
      Object.defineProperty(throwingCtx.ui, "theme", {
        get() {
          throw new Error("theme access failed");
        },
      });
      await mock.emit("agent_start", {}, throwingCtx);
      expect(throwingCtx.ui.statuses.weave).toBe("● 🧵 vault:0");

      const noUiCtx = { cwd, hasUI: false, mode: "print", ui: {} } as unknown as typeof ctx;
      await mock.emit("agent_start", {}, noUiCtx);
    });
  });

  it("notifies when the repository is not indexed", async () => {
    const mock = buildExtension();
    const repo = await makeRepo();
    await withVaultEnv(await makeTempDir(), async () => {
      const ctx = createMockCtx(repo);
      await mock.emit("session_start", {}, ctx);
      expect(ctx.ui.statuses.weave).toBe("○ 🧵 vault:0 · repo:unindexed");
      expect(ctx.ui.notifications).toHaveLength(1);
      expect(ctx.ui.notifications[0]?.level).toBe("info");
      expect(ctx.ui.notifications[0]?.message).toContain("no knowledge index");
    });
  });

  it("warns when the index is stale", async () => {
    const mock = buildExtension();
    const repo = await makeRepo();
    const ctx0 = createMockCtx(repo);
    // Index first via the scan command
    await withVaultEnv(await makeTempDir(), async () => {
      await mock.commands.get("weave-scan")!.handler("", ctx0);
      gitExec(repo, ["checkout", "-b", "feature"]);
      const ctx = createMockCtx(repo);
      await mock.emit("session_start", {}, ctx);
      expect(ctx.ui.notifications[0]?.level).toBe("warning");
      expect(ctx.ui.notifications[0]?.message).toContain("stale");
    });
  });

  it("skips notifications without UI (print/json mode)", async () => {
    const mock = buildExtension();
    const repo = await makeRepo();
    await withVaultEnv(await makeTempDir(), async () => {
      const ctx = createMockCtx(repo, /* hasUI */ false);
      await mock.emit("session_start", {}, ctx);
      expect(ctx.ui.statuses.weave).toBeDefined();
      expect(ctx.ui.notifications).toEqual([]);
    });
  });

  it("says nothing when the index is fresh", async () => {
    const mock = buildExtension();
    const repo = await makeRepo();
    await withVaultEnv(await makeTempDir(), async () => {
      const ctx = createMockCtx(repo);
      await mock.commands.get("weave-scan")!.handler("", ctx);
      ctx.ui.notifications.length = 0;
      await mock.emit("session_start", {}, ctx);
      expect(ctx.ui.statuses.weave).toContain(":ok");
      expect(ctx.ui.notifications).toEqual([]);
    });
  });
});

describe("/weave command", () => {
  it("shows the dashboard", async () => {
    const mock = buildExtension();
    const cwd = await makeTempDir();
    await withVaultEnv(await makeTempDir(), async () => {
      const ctx = createMockCtx(cwd);
      await mock.commands.get("weave")!.handler("", ctx);
      expect(ctx.ui.notifications).toHaveLength(1);
      expect(ctx.ui.notifications[0]?.message).toContain("Vault (");
      expect(ctx.ui.notifications[0]?.message).toContain("not inside a git repository");
    });
  });
});

describe("/weave-scan command", () => {
  it("warns outside a repository", async () => {
    const mock = buildExtension();
    const ctx = createMockCtx(await makeTempDir());
    await mock.commands.get("weave-scan")!.handler("", ctx);
    expect(ctx.ui.notifications[0]?.level).toBe("warning");
    expect(ctx.ui.notifications[0]?.message).toContain("not inside a git repository");
  });

  it("warns for a repo without commits", async () => {
    const mock = buildExtension();
    const repo = await makeTempDir();
    gitInit(repo);
    await writeFixture(repo, "a.ts", "x");
    const ctx = createMockCtx(repo);
    await mock.commands.get("weave-scan")!.handler("", ctx);
    expect(ctx.ui.notifications[0]?.message).toContain("no commits");
  });

  it("builds the index, excludes .okf locally, and updates the status line", async () => {
    const mock = buildExtension();
    const repo = await makeRepo();
    await withVaultEnv(await makeTempDir(), async () => {
      const ctx = createMockCtx(repo);
      await mock.commands.get("weave-scan")!.handler("", ctx);
      expect(ctx.ui.notifications[0]?.message).toContain("index refreshed");
      expect(ctx.ui.statuses.weave).toContain(":ok");
      expect(JSON.parse(await fs.readFile(join(repo, ".okf", "okf.json"), "utf8")).scope).toBe("repository");
      expect(await fs.readFile(join(repo, ".git", "info", "exclude"), "utf8")).toContain(".okf/");
    });
  });
});

describe("/weave-scan deep", () => {
  it("warns and stays light-only when no session model is active", async () => {
    const mock = buildExtension();
    const repo = await makeRepo();
    await withVaultEnv(await makeTempDir(), async () => {
      const ctx = createMockCtx(repo); // no model configured
      await mock.commands.get("weave-scan")!.handler("deep", ctx);
      await deepScanDone(repo); // background scan settles
      expect(ctx.ui.notifications.some((n) => n.level === "warning" && n.message.includes("deep scan needs an active session model"))).toBe(true);
      expect(ctx.ui.statuses.weave).toContain(":ok");
      // light index is still written
      expect(JSON.parse(await fs.readFile(join(repo, ".okf", "okf.json"), "utf8")).scope).toBe("repository");
    });
  });

  it("runs a deep scan with the session model and writes summary sidecars", async () => {
    const mock = buildExtension();
    const repo = await makeRepo();
    await withVaultEnv(await makeTempDir(), async () => {
      const ctx = createMockCtx(repo, true, {
        model: { provider: "testprovider", id: "test-model-1" },
        complete: async () => fauxAssistantMessage("Summarizes the entry point."),
      });
      await mock.commands.get("weave-scan")!.handler("deep", ctx);
      await deepScanDone(repo);
      expect(ctx.ui.notifications.some((n) => n.level === "info" && n.message.includes("deep scan complete"))).toBe(true);
      const summariesDir = join(repo, ".okf", "repository", "summaries");
      const files = await fs.readdir(summariesDir);
      expect(files.some((f) => f.endsWith(".summary.md"))).toBe(true);
      expect(ctx.ui.statuses.weave).toContain(":ok");
    });
  });

  it("reports live progress on the status line while scanning", async () => {
    const mock = buildExtension();
    const repo = await makeRepo();
    await writeFixture(repo, "src/extra.ts", "export const extra = 1;\n");
    commitAll(repo, "add extra");
    await withVaultEnv(await makeTempDir(), async () => {
      const ctx = createMockCtx(repo, true, {
        model: { provider: "p", id: "m" },
        // slow the model so the scan is still in flight when we sample the
        // status line (the settled status overwrites progress on completion)
        complete: async () => {
          await new Promise((r) => setTimeout(r, 100));
          return fauxAssistantMessage("s");
        },
      });
      await mock.commands.get("weave-scan")!.handler("deep", ctx);
      // wait for the background scan to emit its first progress line
      for (let i = 0; i < 50 && ctx.ui.statuses.weave === "● 🧵 deep scan: starting…"; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      const progress = ctx.ui.statuses.weave ?? "";
      expect(progress).toMatch(/\d+\/\d+ \(\d+%\)/);
      expect(progress).toContain("src/");
      await deepScanDone(repo);
    });
  });

  it("treats any non-deep arg as light-only (exact-match contract)", async () => {
    const mock = buildExtension();
    const repo = await makeRepo();
    await withVaultEnv(await makeTempDir(), async () => {
      const ctx = createMockCtx(repo, true, {
        model: { provider: "p", id: "m" },
        complete: async () => { throw new Error("should not be called"); },
      });
      await mock.commands.get("weave-scan")!.handler("nonsense", ctx);
      expect(ctx.ui.notifications.some((n) => n.message.includes("deep scan"))).toBe(false);
      expect(ctx.ui.statuses.weave).toContain(":ok");
    });
  });

  it("matches 'DEEP' case-insensitively", async () => {
    const mock = buildExtension();
    const repo = await makeRepo();
    await withVaultEnv(await makeTempDir(), async () => {
      const ctx = createMockCtx(repo, true, {
        model: { provider: "p", id: "m" },
        complete: async () => fauxAssistantMessage("s"),
      });
      await mock.commands.get("weave-scan")!.handler("DEEP", ctx);
      await deepScanDone(repo);
      expect(ctx.ui.notifications.some((n) => n.message.includes("deep scan complete"))).toBe(true);
    });
  });
});

describe("/weave-scan-cancel", () => {
  it("reports when no deep scan is running", async () => {
    const mock = buildExtension();
    const repo = await makeRepo();
    await withVaultEnv(await makeTempDir(), async () => {
      const ctx = createMockCtx(repo);
      await mock.commands.get("weave-scan-cancel")!.handler("", ctx);
      expect(ctx.ui.notifications.some((n) => n.message.includes("no deep scan is currently running"))).toBe(true);
    });
  });

  it("warns when a deep scan is already running for the repository", async () => {
    const mock = buildExtension();
    const repo = await makeRepo();
    await writeFixture(repo, "src/a.ts", "export const a = 1;\n");
    await writeFixture(repo, "src/b.ts", "export const b = 2;\n");
    commitAll(repo, "add files");
    await withVaultEnv(await makeTempDir(), async () => {
      const ctx = createMockCtx(repo, true, {
        model: { provider: "p", id: "m" },
        complete: async () => {
          // Keep the first scan in flight long enough that the second
          // invocation's buildRepoIndex+writeRepoIndex cannot outrun it
          // (a short delay made this test flaky on the 95% CI gate).
          await new Promise((r) => setTimeout(r, 1000));
          return fauxAssistantMessage("s");
        },
      });
      await mock.commands.get("weave-scan")!.handler("deep", ctx);
      // second invocation while the first is still in flight
      await mock.commands.get("weave-scan")!.handler("deep", ctx);
      expect(ctx.ui.notifications.some((n) => n.message.includes("already running"))).toBe(true);
      await deepScanDone(repo);
    });
  });

  it("aborts an in-flight deep scan and reports cancellation", async () => {
    const mock = buildExtension();
    const repo = await makeRepo();
    await writeFixture(repo, "src/a.ts", "export const a = 1;\n");
    await writeFixture(repo, "src/b.ts", "export const b = 2;\n");
    await writeFixture(repo, "src/c.ts", "export const c = 3;\n");
    commitAll(repo, "add files");
    await withVaultEnv(await makeTempDir(), async () => {
      const ctx = createMockCtx(repo, true, {
        model: { provider: "p", id: "m" },
        complete: async () => {
          // Let the scan start, then cancel it from the cancel command.
          await new Promise((r) => setTimeout(r, 5));
          return fauxAssistantMessage("s");
        },
      });
      await mock.commands.get("weave-scan")!.handler("deep", ctx);
      await mock.commands.get("weave-scan-cancel")!.handler("", ctx);
      await deepScanDone(repo);
      expect(ctx.ui.notifications.some((n) => n.message.includes("cancellation requested"))).toBe(true);
      expect(ctx.ui.notifications.some((n) => n.message.includes("deep scan cancelled"))).toBe(true);
    });
  });
});

describe("weave_note tool", () => {
  it("add + get round trip", async () => {
    const mock = buildExtension();
    const cwd = await makeTempDir();
    await withVaultEnv(await makeTempDir(), async () => {
      const ctx = createMockCtx(cwd);
      const added = await mock.runTool("weave_note", {
        action: "add",
        title: "Release plan",
        text: "Ship 0.1 next week.",
        tags: ["release"],
      }, ctx);
      expect(added.content[0]?.text).toContain("release-plan");

      const got = await mock.runTool("weave_note", { action: "get", slug: "release-plan" }, ctx);
      expect(got.content[0]?.text).toContain("# Release plan");
      expect(got.content[0]?.text).toContain("Ship 0.1 next week.");
    });
  });

  it("lists notes and reports an empty vault", async () => {
    const mock = buildExtension();
    const ctx = createMockCtx(await makeTempDir());
    await withVaultEnv(await makeTempDir(), async () => {
      const empty = await mock.runTool("weave_note", { action: "list" }, ctx);
      expect(empty.content[0]?.text).toContain("no notes yet");

      await mock.runTool("weave_note", { action: "add", title: "One", text: "x" }, ctx);
      const list = await mock.runTool("weave_note", { action: "list" }, ctx);
      expect(list.content[0]?.text).toContain("1 note(s)");
      expect(list.content[0]?.text).toContain("one: One");
    });
  });

  it("appends to existing notes and reports unknown slugs", async () => {
    const mock = buildExtension();
    const ctx = createMockCtx(await makeTempDir());
    await withVaultEnv(await makeTempDir(), async () => {
      await mock.runTool("weave_note", { action: "add", title: "Log", text: "first" }, ctx);
      const appended = await mock.runTool("weave_note", { action: "append", slug: "log", text: "second" }, ctx);
      expect(appended.content[0]?.text).toContain("Appended to log");
      const got = await mock.runTool("weave_note", { action: "get", slug: "log" }, ctx);
      expect(got.content[0]?.text).toContain("first");
      expect(got.content[0]?.text).toContain("second");

      const missing = await mock.runTool("weave_note", { action: "append", slug: "ghost", text: "x" }, ctx);
      expect(missing.content[0]?.text).toContain("No note found");
    });
  });

  it("keeps every addition when appends run concurrently", async () => {
    const mock = buildExtension();
    const ctx = createMockCtx(await makeTempDir());
    await withVaultEnv(await makeTempDir(), async () => {
      await mock.runTool("weave_note", { action: "add", title: "Log", text: "start" }, ctx);
      await Promise.all(
        ["alpha", "beta", "gamma"].map((text) =>
          mock.runTool("weave_note", { action: "append", slug: "log", text }, ctx),
        ),
      );
      const got = await mock.runTool("weave_note", { action: "get", slug: "log" }, ctx);
      for (const part of ["start", "alpha", "beta", "gamma"]) {
        expect(got.content[0]?.text).toContain(part);
      }
    });
  });

  it("keeps concurrent adds with the same title (no slug overwrite)", async () => {
    const mock = buildExtension();
    const ctx = createMockCtx(await makeTempDir());
    await withVaultEnv(await makeTempDir(), async () => {
      await Promise.all([
        mock.runTool("weave_note", { action: "add", title: "Dup", text: "one" }, ctx),
        mock.runTool("weave_note", { action: "add", title: "Dup", text: "two" }, ctx),
      ]);
      const list = await mock.runTool("weave_note", { action: "list" }, ctx);
      expect(list.content[0]?.text).toContain("2 note(s)");
      expect(list.content[0]?.text).toContain("dup-2");
    });
  });

  it("rejects slugs that try to escape the vault", async () => {
    const mock = buildExtension();
    const ctx = createMockCtx(await makeTempDir());
    await withVaultEnv(await makeTempDir(), async () => {
      const bad = await mock.runTool("weave_note", { action: "append", slug: "../outside", text: "x" }, ctx);
      expect(bad.content[0]?.text).toContain("Invalid note slug");
      const got = await mock.runTool("weave_note", { action: "get", slug: "../outside" }, ctx);
      expect(got.content[0]?.text).toContain("No note found");
    });
  });

  it("get reports unknown slugs", async () => {
    const mock = buildExtension();
    const ctx = createMockCtx(await makeTempDir());
    await withVaultEnv(await makeTempDir(), async () => {
      const res = await mock.runTool("weave_note", { action: "get", slug: "ghost" }, ctx);
      expect(res.content[0]?.text).toContain("No note found");
    });
  });

  it("searches notes and reports no-match", async () => {
    const mock = buildExtension();
    const ctx = createMockCtx(await makeTempDir());
    await withVaultEnv(await makeTempDir(), async () => {
      await mock.runTool("weave_note", { action: "add", title: "Auth boundary", text: "JWT at gateway.", tags: ["auth"] }, ctx);
      const hits = await mock.runTool("weave_note", { action: "search", query: "auth" }, ctx);
      expect(hits.content[0]?.text).toContain("auth-boundary");
      const none = await mock.runTool("weave_note", { action: "search", query: "zzz" }, ctx);
      expect(none.content[0]?.text).toContain("No notes matched");
    });
  });

  it("finalize restructures the body above the raw tail and preserves it", async () => {
    const mock = buildExtension();
    const ctx = createMockCtx(await makeTempDir());
    await withVaultEnv(await makeTempDir(), async () => {
      await mock.runTool("weave_note", { action: "add", title: "Auth migration", text: "---\n\n## Raw\n<!-- NEVER edit below this line. Verbatim user input preserved here. -->\n\n```\n\"We should move to OIDC.\"\n```", source: "human" }, ctx);
      const res = await mock.runTool("weave_note", { action: "finalize", slug: "auth-migration", text: "**Decision:** move toward OIDC." }, ctx);
      expect(res.content[0]?.text).toContain("Finalized auth-migration");
      expect(res.content[0]?.text).toContain("Raw notes tail preserved");
      const got = await mock.runTool("weave_note", { action: "get", slug: "auth-migration" }, ctx);
      expect(got.content[0]?.text).toContain("**Decision:** move toward OIDC.");
      expect(got.content[0]?.text).toContain("## Raw");
      expect(got.content[0]?.text).toContain("\"We should move to OIDC.\"");
    });
  });

  it("finalize reports unknown and unsafe slugs", async () => {
    const mock = buildExtension();
    const ctx = createMockCtx(await makeTempDir());
    await withVaultEnv(await makeTempDir(), async () => {
      const missing = await mock.runTool("weave_note", { action: "finalize", slug: "ghost", text: "x" }, ctx);
      expect(missing.content[0]?.text).toContain("No note found");
      const bad = await mock.runTool("weave_note", { action: "finalize", slug: "../escape", text: "x" }, ctx);
      expect(bad.content[0]?.text).toContain("Invalid note slug");
    });
  });

  it("add accepts an explicit source for user-scribbled notes", async () => {
    const mock = buildExtension();
    const ctx = createMockCtx(await makeTempDir());
    await withVaultEnv(await makeTempDir(), async () => {
      const res = await mock.runTool("weave_note", { action: "add", title: "Scribble", text: "user's words", source: "human" }, ctx);
      expect(res.details).toMatchObject({ action: "add", note: { source: "human" } });
      const got = await mock.runTool("weave_note", { action: "get", slug: "scribble" }, ctx);
      expect(got.content[0]?.text).toContain("source: human");
    });
  });

  it("throws on missing required params", async () => {
    const mock = buildExtension();
    const ctx = createMockCtx(await makeTempDir());
    await withVaultEnv(await makeTempDir(), async () => {
      await expect(mock.runTool("weave_note", { action: "add", text: "x" }, ctx)).rejects.toThrow(/title/);
      await expect(mock.runTool("weave_note", { action: "add", title: "t" }, ctx)).rejects.toThrow(/text/);
      await expect(mock.runTool("weave_note", { action: "get" }, ctx)).rejects.toThrow(/slug/);
      await expect(mock.runTool("weave_note", { action: "append", text: "x" }, ctx)).rejects.toThrow(/slug/);
      await expect(mock.runTool("weave_note", { action: "append", slug: "s" }, ctx)).rejects.toThrow(/text/);
      await expect(mock.runTool("weave_note", { action: "finalize", text: "x" }, ctx)).rejects.toThrow(/slug/);
      await expect(mock.runTool("weave_note", { action: "finalize", slug: "s" }, ctx)).rejects.toThrow(/text/);
      await expect(mock.runTool("weave_note", { action: "search" }, ctx)).rejects.toThrow(/query/);
    });
  });
});

describe("weave_repo tool", () => {
  it("reports when not inside a repository", async () => {
    const mock = buildExtension();
    const ctx = createMockCtx(await makeTempDir());
    for (const action of ["status", "scan", "overview"] as const) {
      const res = await mock.runTool("weave_repo", { action }, ctx);
      expect(res.content[0]?.text).toContain("Not inside a git repository");
    }
  });

  it("status reports missing index", async () => {
    const mock = buildExtension();
    const repo = await makeRepo();
    const ctx = createMockCtx(repo);
    const res = await mock.runTool("weave_repo", { action: "status" }, ctx);
    expect(res.content[0]?.text).toContain("Index state: missing");
  });

  it("scan builds the index (with progress update), then status is fresh", async () => {
    const mock = buildExtension();
    const repo = await makeRepo();
    const ctx = createMockCtx(repo);
    const updates: string[] = [];
    const res = await mock.runTool("weave_repo", { action: "scan" }, ctx, (u) =>
      updates.push((u as { content: { text: string }[] }).content[0]?.text ?? ""),
    );
    expect(res.content[0]?.text).toContain("Knowledge index written");
    expect(res.content[0]?.text).toContain("Repository:");
    expect(updates[0]).toContain("Scanning");

    const status = await mock.runTool("weave_repo", { action: "status" }, ctx);
    expect(status.content[0]?.text).toContain("Index state: fresh");
    expect(status.content[0]?.text).toContain("Indexed at:");
  });

  it("scan fails gracefully without commits", async () => {
    const mock = buildExtension();
    const repo = await makeTempDir();
    gitInit(repo);
    const ctx = createMockCtx(repo);
    const res = await mock.runTool("weave_repo", { action: "scan" }, ctx);
    expect(res.content[0]?.text).toContain("no commits");
  });

  it("overview asks for a scan when missing, and reports stale indexes", async () => {
    const mock = buildExtension();
    const repo = await makeRepo();
    const ctx = createMockCtx(repo);

    const missing = await mock.runTool("weave_repo", { action: "overview" }, ctx);
    expect(missing.content[0]?.text).toContain("No knowledge index");

    await mock.runTool("weave_repo", { action: "scan" }, ctx);
    const fresh = await mock.runTool("weave_repo", { action: "overview" }, ctx);
    expect(fresh.content[0]?.text).toContain("Repository:");
    expect(fresh.content[0]?.text).not.toContain("⚠");

    await writeFixture(repo, "new-file.ts", "x");
    const stale = await mock.runTool("weave_repo", { action: "overview" }, ctx);
    expect(stale.content[0]?.text).toContain("⚠ index is stale");
  });

  it("status shows staleness reasons", async () => {
    const mock = buildExtension();
    const repo = await makeRepo();
    const ctx = createMockCtx(repo);
    await mock.runTool("weave_repo", { action: "scan" }, ctx);
    await writeFixture(repo, "dirty.ts", "x");
    const res = await mock.runTool("weave_repo", { action: "status" }, ctx);
    expect(res.content[0]?.text).toContain("Index state: stale");
    expect(res.content[0]?.text).toContain("uncommitted");
  });
});

describe("weave_note slug hardening", () => {
  it("append refuses traversal slugs with a friendly message", async () => {
    const mock = buildExtension();
    const ctx = createMockCtx(await makeTempDir());
    await withVaultEnv(await makeTempDir(), async () => {
      const res = await mock.runTool(
        "weave_note",
        { action: "append", slug: "../escape", text: "nope" },
        ctx,
      );
      expect(res.content[0]?.text).toContain("Invalid note slug");
      expect(res.details).toMatchObject({ found: false });
    });
  });
});
