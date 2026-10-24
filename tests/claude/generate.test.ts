import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeArgs, claudeGenerate, NESTED_ENV } from "../../src/claude/generate";
import { makeTempDir } from "../helpers";

async function script(body: string): Promise<string> {
  const path = join(await makeTempDir(), "claude");
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

describe("claudeGenerate", () => {
  it("runs headless Claude Code with no tools, no MCP and no saved session", () => {
    const args = claudeArgs("haiku");
    expect(args.slice(0, 3)).toEqual(["-p", "--model", "haiku"]);
    expect(args).toEqual(expect.arrayContaining(["--strict-mcp-config", "--no-session-persistence"]));
    expect(args[args.indexOf("--tools") + 1]).toBe("");
  });

  it("sends the prompt on stdin and returns stdout, marking the child as nested", async () => {
    const bin = await script(`printf '%s|' "$${NESTED_ENV}" "$3" "$PWD"; cat`);
    const text = await claudeGenerate({ bin, env: { PATH: process.env.PATH } })("summarize this", new AbortController().signal, "sonnet");
    const [nested, model, cwd, prompt] = text.split("|");
    expect(nested).toBe("1");
    expect(model).toBe("sonnet");
    expect(cwd).not.toBe(process.cwd());
    expect(prompt).toBe("summarize this");
  });

  it("reports a failed run with the tail of its stderr", async () => {
    const generate = claudeGenerate({ bin: await script("echo 'not logged in' >&2; exit 3") });
    await expect(generate("x", new AbortController().signal, "haiku")).rejects.toThrow(/exited with code 3: not logged in/);
    const quiet = claudeGenerate({ bin: await script("exit 1") });
    await expect(quiet("x", new AbortController().signal, "haiku")).rejects.toThrow(/exited with code 1$/);
  });

  it("reports a missing binary and honours cancellation", async () => {
    const missing = join(await makeTempDir(), "no-such-claude");
    await expect(claudeGenerate({ bin: missing })("x", new AbortController().signal, "haiku")).rejects.toThrow(/could not run/);
    const controller = new AbortController();
    const running = claudeGenerate({ bin: await script("sleep 5") })("x", controller.signal, "haiku");
    controller.abort(new Error("stop"));
    await expect(running).rejects.toThrow("stop");
  });
});
