import { readFileSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { formatStatusLine, getWorkspaceStatus } from "../core";
import { NESTED_ENV } from "./generate";
import { serveMcp } from "./mcp";
import { createClaudeAdapter } from "./server";

/**
 * Entry point of the Claude Code plugin, bundled to `claude/dist/weave.mjs`.
 *
 *   weave.mjs mcp            the MCP server (plugin.json → mcpServers)
 *   weave.mjs session-start  SessionStart hook: the status line, as context
 *   weave.mjs statusline     opt-in status-line command
 *
 * Hooks and the status line pass a JSON object on stdin; only its working
 * directory is used.
 */

export interface MainIo {
  stdin: Readable;
  stdout: Writable;
  env: NodeJS.ProcessEnv;
  cwd: string;
  version: string;
}

async function readJson(stdin: Readable): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of stdin) text += String(chunk);
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function cwdFrom(input: Record<string, unknown>, fallback: string): string {
  const workspace = input.workspace as Record<string, unknown> | undefined;
  if (typeof workspace?.current_dir === "string") return workspace.current_dir;
  return typeof input.cwd === "string" ? input.cwd : fallback;
}

export async function main(argv: readonly string[], io: MainIo): Promise<number> {
  const [mode = "mcp"] = argv;
  if (mode === "mcp") {
    const adapter = createClaudeAdapter({ env: io.env, cwd: io.env.CLAUDE_PROJECT_DIR ?? io.cwd, version: io.version });
    await serveMcp(adapter.server, io.stdin, io.stdout);
    await adapter.close();
    return 0;
  }
  if (mode === "session-start" || mode === "statusline") {
    const input = await readJson(io.stdin);
    // Scans run headless Claude Code; its sessions need no pi-weave context.
    if (mode === "session-start" && io.env[NESTED_ENV]) return 0;
    const line = formatStatusLine(await getWorkspaceStatus(cwdFrom(input, io.cwd)));
    io.stdout.write(mode === "session-start" ? `pi-weave: ${line}\n` : `${line}\n`);
    return 0;
  }
  io.stdout.write("usage: weave.mjs [mcp | session-start | statusline]\n");
  return 2;
}

export function packageVersion(): string {
  try {
    return (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}
