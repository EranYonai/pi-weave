import { spawn as nodeSpawn } from "node:child_process";
import { tmpdir } from "node:os";

/**
 * Model calls for the shared scans, through headless Claude Code.
 *
 * Pi and OpenCode hand the scans their own model API. A Claude Code plugin has
 * none, so each summary is one `claude -p` run: no tools, no MCP servers, no
 * saved session, a short system prompt in place of Claude Code's own, and the
 * user's own login and plan. It runs in the temp directory so no project
 * CLAUDE.md or project settings ride along.
 */

/** Set on the child so this plugin's own hooks stay quiet inside it. */
export const NESTED_ENV = "PI_WEAVE_NESTED";

const SYSTEM_PROMPT = "You write concise summaries for a Markdown knowledge vault. Follow the instructions in the message and answer with the summary only.";

export type SpawnFn = typeof nodeSpawn;

export interface ClaudeGenerateOptions {
  bin?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnFn;
}

export function claudeArgs(model: string): string[] {
  return [
    "-p",
    "--model", model,
    "--system-prompt", SYSTEM_PROMPT,
    "--tools", "",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--output-format", "text",
  ];
}

export function claudeGenerate(options: ClaudeGenerateOptions = {}) {
  const env = options.env ?? process.env;
  const bin = options.bin ?? "claude";
  const spawn = options.spawn ?? nodeSpawn;
  return (prompt: string, signal: AbortSignal, model: string): Promise<string> => new Promise((resolve, reject) => {
    const child = spawn(bin, claudeArgs(model), {
      cwd: tmpdir(),
      env: { ...env, [NESTED_ENV]: "1" },
      signal,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => reject(signal.aborted ? signal.reason : new Error(`could not run ${bin}: ${error.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${bin} exited with code ${code}${stderr.trim() ? `: ${stderr.trim().slice(-400)}` : ""}`));
    });
    child.stdin!.on("error", () => {});
    child.stdin!.end(prompt);
  });
}
