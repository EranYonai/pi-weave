import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { main, packageVersion } from "../../src/claude/index";
import { makeTempDir, withVaultEnv } from "../helpers";

async function run(argv: string[], stdin: string, env: NodeJS.ProcessEnv = {}, cwd = "/") {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => { text += String(chunk); });
  input.end(stdin);
  const code = await main(argv, { stdin: input, stdout: output, env, cwd, version: "1.0.0" });
  return { code, text };
}

describe("Claude Code plugin entry", () => {
  it("serves MCP by default", async () => {
    const { code, text } = await run([], `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    expect(code).toBe(0);
    expect(JSON.parse(text)).toMatchObject({ result: { serverInfo: { name: "pi-weave", version: "1.0.0" } } });
    expect((await run(["mcp"], "", { CLAUDE_PROJECT_DIR: "/" })).code).toBe(0);
  });

  it("prints the status line for the SessionStart hook and the status line", async () => {
    const vault = await makeTempDir();
    const cwd = await makeTempDir();
    await withVaultEnv(vault, async () => {
      expect(await run(["session-start"], JSON.stringify({ cwd, session_id: "s" }))).toEqual({ code: 0, text: "pi-weave: 🕸️ 0 notes\n" });
      expect(await run(["statusline"], JSON.stringify({ workspace: { current_dir: cwd } }))).toEqual({ code: 0, text: "🕸️ 0 notes\n" });
      expect((await run(["statusline"], "not json", {}, cwd)).text).toBe("🕸️ 0 notes\n");
      expect((await run(["statusline"], "null", {}, cwd)).text).toBe("🕸️ 0 notes\n");
    });
  });

  it("stays quiet inside its own headless scans, and rejects unknown modes", async () => {
    expect(await run(["session-start"], "{}", { PI_WEAVE_NESTED: "1" })).toEqual({ code: 0, text: "" });
    expect(await run(["nope"], "")).toEqual({ code: 2, text: "usage: weave.mjs [mcp | session-start | statusline]\n" });
  });

  it("reads its version from package.json", () => {
    expect(packageVersion()).toBe(JSON.parse(readFileSync("package.json", "utf8")).version);
  });

  it("ships a committed bundle that runs", async () => {
    const vault = await makeTempDir();
    const out = execFileSync(process.execPath, ["claude/dist/weave.mjs", "session-start"], {
      input: JSON.stringify({ cwd: await makeTempDir() }),
      env: { ...process.env, PI_WEAVE_VAULT: vault, PI_WEAVE_NESTED: "" },
    }).toString();
    expect(out).toBe("pi-weave: 🕸️ 0 notes\n");
    const mcp = execFileSync(process.execPath, ["claude/dist/weave.mjs", "mcp"], {
      input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`,
      env: { ...process.env, PI_WEAVE_VAULT: vault },
    }).toString();
    expect(JSON.parse(mcp).result.tools.map((tool: { name: string }) => tool.name)).toEqual(["weave_note", "weave_repo", "weave_command"]);
  });
});
