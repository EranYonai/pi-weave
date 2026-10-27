import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The Claude Code plugin, end to end: the real `claude` binary loads the repo
 * as a plugin (`--plugin-dir`) against a throwaway vault, and each step
 * checks what Claude actually did — the commands and skills it registered,
 * the tool calls it made, the notes that landed on disk, and how long a slash
 * command took. Uses the logged-in `claude` and a real model (Haiku), so it
 * needs `claude` on PATH.
 */

const ROOT = resolve(__dirname, "..");
const TOOL = (name: string) => `mcp__plugin_pi-weave_pi-weave__${name}`;
const hasClaude = spawnSync("claude", ["--version"]).status === 0;

interface Event {
  type: string;
  subtype?: string;
  [key: string]: unknown;
}

describe.skipIf(!hasClaude)("claude code plugin", () => {
  let vault: string;
  let home: string;

  beforeAll(() => {
    vault = mkdtempSync(join(tmpdir(), "weave-claude-vault-"));
    home = mkdtempSync(join(tmpdir(), "weave-claude-cwd-"));
  });
  afterAll(() => {
    rmSync(vault, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  function claude(prompt: string, extra: string[] = []) {
    const started = Date.now();
    const run = spawnSync(
      "claude",
      ["-p", prompt, "--plugin-dir", ROOT, "--model", "haiku", "--output-format", "stream-json", "--verbose",
        "--allowedTools", Object.values({ a: TOOL("weave_note"), b: TOOL("weave_repo"), c: TOOL("weave_command") }).join(","),
        ...extra],
      { cwd: home, env: { ...process.env, PI_WEAVE_VAULT: vault }, encoding: "utf8", timeout: 100_000 },
    );
    const events = run.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Event);
    const toolCalls = events.flatMap((e) => (e.type === "assistant"
      ? ((e.message as { content: { type: string; name?: string; input?: unknown }[] }).content)
        .filter((block) => block.type === "tool_use").map((block) => ({ name: block.name ?? "", input: block.input }))
      : []));
    const result = events.find((e) => e.type === "result") as (Event & { result: string; is_error: boolean }) | undefined;
    // A hook that answers a command stops the prompt; its text rides on an informational event.
    const hooked = events.filter((e) => e.type === "system" && e.subtype === "informational").map((e) => String(e.content)).join("\n");
    return { events, toolCalls, hooked, turns: (result as { num_turns?: number } | undefined)?.num_turns ?? -1,
      cost: (result as { total_cost_usd?: number } | undefined)?.total_cost_usd ?? -1, text: `${result?.result ?? ""}${hooked}`, isError: result?.is_error ?? true, ms: Date.now() - started };
  }

  it("registers the commands, skills and MCP tools", () => {
    const { events } = claude("hi");
    const init = events.find((e) => e.type === "system" && e.subtype === "init") as unknown as {
      slash_commands: string[]; skills?: string[]; tools: string[]; mcp_servers: { name: string; status: string }[];
    };
    for (const name of ["weave", "weave-view", "weave-scan", "weave-scan-cancel", "weave-statusline"]) {
      expect(init.slash_commands).toContain(`pi-weave:${name}`);
    }
    expect(init.mcp_servers.find((s) => s.name.includes("pi-weave"))?.status).toBe("connected");
    expect(init.tools).toEqual(expect.arrayContaining([TOOL("weave_note"), TOOL("weave_repo"), TOOL("weave_command")]));
    expect((init.skills ?? []).some((s) => s.includes("pi-weave"))).toBe(true);
  });

  it("/weave-view opens the workspace with no model turn", () => {
    const run = claude("/pi-weave:weave-view --no-open");
    expect(run.hooked).toContain("stopped by hook");
    // The UserPromptSubmit hook answered through the MCP process: no model, no tool call, no cost.
    expect(run.turns).toBe(0);
    expect(run.cost).toBe(0);
    expect(run.toolCalls).toEqual([]);
    expect(/http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+/.exec(run.text)?.[0], run.text).toBeTruthy();
    // What is left is `claude` starting up and connecting its MCP servers.
    expect(run.ms).toBeLessThan(6_000);
  });

  it("saves a note with weave_note and finds it again", () => {
    const add = claude("Save a note titled 'Claude e2e plan' with the text 'ship the plugin on Friday' using weave_note.");
    expect(add.toolCalls.some((c) => c.name === TOOL("weave_note"))).toBe(true);
    const files = readdirSync(vault, { recursive: true }).map(String).filter((f) => f.endsWith(".md"));
    expect(files.some((f) => readFileSync(join(vault, f), "utf8").includes("ship the plugin on Friday"))).toBe(true);

    const search = claude("Search my pi-weave notes for 'plugin on Friday' and quote what you find.");
    expect(search.toolCalls.some((c) => c.name === TOOL("weave_note"))).toBe(true);
    expect(search.text.toLowerCase()).toContain("friday");
  });

  it("/weave and /weave-statusline answer with no model turn too", () => {
    const dash = claude("/pi-weave:weave");
    expect([dash.turns, dash.toolCalls.length]).toEqual([0, 0]);
    expect(dash.text).toMatch(/note/i);
    const line = claude("/pi-weave:weave-statusline");
    expect([line.turns, line.toolCalls.length]).toEqual([0, 0]);
    expect(line.text).toContain("statusLine");
  });

  it("falls back to the model when the hook cannot reach the server", () => {
    // Without a session socket the command still works, as a model turn that calls the tool.
    const run = claude("/pi-weave:weave --no-such-flag-ok", ["--settings", JSON.stringify({ disableAllHooks: true })]);
    expect(run.toolCalls.map((c) => c.name)).toEqual([TOOL("weave_command")]);
  });

  it("the SessionStart hook adds the vault status", () => {
    const { events } = claude("hi");
    const hook = events.find((e) => e.type === "system" && e.subtype === "hook_response");
    expect(JSON.stringify(hook ?? events)).toMatch(/pi-weave: .*notes?/);
  });
});
