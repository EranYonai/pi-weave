import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpawnFn } from "../../src/claude/generate";
import { claudeProjectDir } from "../../src/claude/sessions";
import { createClaudeAdapter, DEFAULT_SCAN_MODEL, INSTRUCTIONS } from "../../src/claude/server";
import { WorkspaceServerController } from "../../src/web/server/controller";
import { commitAll, gitInit, makeTempDir, withVaultEnv, writeFixture } from "../helpers";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** A fake `claude` that answers every prompt with one summary line. */
async function fakeClaude(): Promise<string> {
  const path = join(await makeTempDir(), "claude");
  await writeFile(path, "#!/bin/sh\ncat > /dev/null\necho \"A generated summary using $3.\"\n");
  await chmod(path, 0o755);
  return path;
}

async function setup(env: NodeJS.ProcessEnv = {}, opener: (command: string) => void = () => {}) {
  const cwd = await makeTempDir();
  const vault = await makeTempDir();
  const home = await makeTempDir();
  gitInit(cwd);
  await writeFixture(cwd, "retry.ts", "export const attempts = 6;\n");
  commitAll(cwd);
  const bin = await fakeClaude();
  const opened: string[][] = [];
  const spawn = ((command: string, args: string[], options: object) => {
    if (command === bin) return nodeSpawn(command, args, options);
    opener(command);
    opened.push([command, ...args]);
    const child = new EventEmitter() as EventEmitter & { unref(): void };
    child.unref = () => {};
    return child;
  }) as unknown as SpawnFn;
  const viewer = new WorkspaceServerController({ vaultRoot: () => vault });
  const adapter = createClaudeAdapter({ env: { PI_WEAVE_CLAUDE_BIN: bin, ...env }, cwd, home, script: "/plugin/weave.mjs", version: "9.9.9", spawn, viewer });
  closers.push(() => adapter.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = adapter.server.tools.find((candidate) => candidate.name === name)!;
    return (await tool.call(args)).text;
  };
  const command = (name: string, args?: string) => call("weave_command", args === undefined ? { command: name } : { command: name, args });
  return { adapter, cwd, vault, home, opened, call, command };
}

describe("Claude Code adapter", () => {
  it("serves the shared tools plus the command tool", async () => {
    const { adapter, vault, call } = await setup();
    expect(adapter.server).toMatchObject({ name: "pi-weave", version: "9.9.9", instructions: INSTRUCTIONS });
    expect(adapter.server.tools.map((tool) => tool.name)).toEqual(["weave_note", "weave_repo", "weave_command"]);
    await withVaultEnv(vault, async () => {
      expect(await call("weave_note", { action: "add", title: "Retries", text: "Six attempts." })).toContain("retries");
      expect(await call("weave_repo", { action: "overview" })).toContain("Repository:");
    });
  });

  it("shows the dashboard and the status-line setting", async () => {
    const { vault, command } = await setup();
    await withVaultEnv(vault, async () => {
      expect(await command("weave")).toContain(`Vault (${vault})`);
    });
    const snippet = await command("weave-statusline");
    expect(snippet).toContain('"command": "node \\"/plugin/weave.mjs\\" statusline"');
    await expect(command("weave-nope")).rejects.toThrow("Unknown pi-weave command: weave-nope");
  });

  it("opens the workspace in a browser only when asked and local", async () => {
    const { opened, command } = await setup();
    expect(await command("weave-view", "--no-open")).toMatch(/workspace running at http:\/\/127\.0\.0\.1:\d+\//);
    expect(opened).toEqual([]);
    expect(await command("weave-view")).toContain("already running");
    expect(opened).toHaveLength(1);
    expect(opened[0]![1]).toMatch(/^http:\/\/127\.0\.0\.1/);

    const remote = await setup({ SSH_CONNECTION: "1 2 3 4" });
    await remote.command("weave-view");
    expect(remote.opened).toEqual([]);

    const broken = await setup({}, () => { throw new Error("no opener"); });
    expect(await broken.command("weave-view")).toContain("workspace running");
  });

  it("runs the deep scan in the background with headless Claude Code", async () => {
    const { cwd, vault, command } = await setup({ PI_WEAVE_CLAUDE_MODEL: "sonnet" });
    await withVaultEnv(vault, async () => {
      expect(await command("weave-scan", "bogus")).toBe("usage: /weave-scan [sessions [path]]");
      expect(await command("weave-scan")).toContain("started in the background");
      await vi.waitFor(async () => expect(await command("weave")).toContain("Last scan: pi-weave: deep scan complete"), { timeout: 10_000 });
    });
    const dir = join(cwd, ".okf", "repository", "summaries");
    const summary = await readFile(join(dir, (await readdir(dir))[0]!), "utf8");
    expect(summary).toContain("model: claude-code/sonnet");
    expect(summary).toContain("A generated summary using sonnet.");
  });

  it("reports a running scan, and cancels it", async () => {
    const { vault, command } = await setup();
    await withVaultEnv(vault, async () => {
      expect(await command("weave-scan-cancel")).toBe("pi-weave: no scan is currently running.");
      await command("weave-scan");
      expect(await command("weave")).toContain("Scan running:");
      expect(await command("weave-scan-cancel")).toBe("pi-weave: scan cancellation requested.");
      await vi.waitFor(async () => expect(await command("weave")).toMatch(/Last scan: pi-weave: (deep )?scan cancelled/), { timeout: 10_000 });
    });
  });

  it("summarizes this project's Claude Code session into the vault", async () => {
    const { cwd, vault, home, command } = await setup();
    await mkdir(claudeProjectDir(cwd, home), { recursive: true });
    await writeFile(join(claudeProjectDir(cwd, home), "abc.jsonl"), [
      JSON.stringify({ type: "user", sessionId: "abc", cwd, timestamp: "2026-10-24T10:00:00Z", message: { content: "Cap webhook retries at six" } }),
      JSON.stringify({ type: "assistant", sessionId: "abc", timestamp: "2026-10-24T10:01:00Z", message: { id: "m", model: "claude-opus-5-5", content: [{ type: "text", text: "Done." }] } }),
    ].join("\n"));
    await withVaultEnv(vault, async () => {
      await command("weave-scan", "sessions");
      await vi.waitFor(async () => expect(await command("weave")).toContain("session scan complete — 1 summarized"), { timeout: 10_000 });
    });
    const [note] = await readdir(join(vault, "notes", "sessions"));
    const text = await readFile(join(vault, "notes", "sessions", note!), "utf8");
    expect(text).toContain('session_file: "claude-code:session:abc"');
    expect(text).toContain(`by claude-code/${DEFAULT_SCAN_MODEL}`);
  });

  it("says so when the project has no Claude Code transcript", async () => {
    for (const env of [{}, { CLAUDE_CODE_SESSION_ID: "gone" }]) {
      const { vault, command } = await setup(env);
      await withVaultEnv(vault, async () => {
        await command("weave-scan", "sessions");
        await vi.waitFor(async () => expect(await command("weave")).toContain("no Claude Code transcript found for this project"), { timeout: 10_000 });
      });
    }
  });

  it("defaults to Claude Code's project directory and real process", async () => {
    const adapter = createClaudeAdapter({ env: { CLAUDE_PROJECT_DIR: "/nowhere" } });
    closers.push(() => adapter.close());
    expect(adapter.server.version).toBe("0.0.0");
    const tool = adapter.server.tools.find((candidate) => candidate.name === "weave_command")!;
    expect((await tool.call({ command: "weave-statusline", args: 3 })).text).toContain("statusline");
    const fallback = createClaudeAdapter();
    closers.push(() => fallback.close());
    expect(fallback.server.tools).toHaveLength(3);
  });
});
