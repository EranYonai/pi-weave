import { promises as fs } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import piWeave from "../../src/pi/index";
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
    expect([...mock.commands.keys()].sort()).toEqual(["weave", "weave-scan"]);
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
      expect(ctx.ui.statuses.weave).toBe("🧵 vault:0");
      expect(ctx.ui.notifications).toEqual([]);
    });
  });

  it("notifies when the repository is not indexed", async () => {
    const mock = buildExtension();
    const repo = await makeRepo();
    await withVaultEnv(await makeTempDir(), async () => {
      const ctx = createMockCtx(repo);
      await mock.emit("session_start", {}, ctx);
      expect(ctx.ui.statuses.weave).toBe("🧵 vault:0 · repo:unindexed");
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

  it("throws on missing required params", async () => {
    const mock = buildExtension();
    const ctx = createMockCtx(await makeTempDir());
    await withVaultEnv(await makeTempDir(), async () => {
      await expect(mock.runTool("weave_note", { action: "add", text: "x" }, ctx)).rejects.toThrow(/title/);
      await expect(mock.runTool("weave_note", { action: "add", title: "t" }, ctx)).rejects.toThrow(/text/);
      await expect(mock.runTool("weave_note", { action: "get" }, ctx)).rejects.toThrow(/slug/);
      await expect(mock.runTool("weave_note", { action: "append", text: "x" }, ctx)).rejects.toThrow(/slug/);
      await expect(mock.runTool("weave_note", { action: "append", slug: "s" }, ctx)).rejects.toThrow(/text/);
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
