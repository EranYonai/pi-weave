import { spawn as nodeSpawn } from "node:child_process";
import { formatDashboard, getWorkspaceStatus } from "../core";
import { weaveTools } from "../core/tools";
import { createWorkspaceCommands } from "../core/workspaceCommands";
import { browserOpenCommand, WorkspaceServerController } from "../web/server/controller";
import { claudeGenerate, type SpawnFn } from "./generate";
import type { McpServerInfo, McpTool } from "./mcp";
import { claudeConfigDir, findTranscript, readClaudeTranscript, transcriptSessionId } from "./sessions";

/**
 * The Claude Code adapter: the shared tools and the shared workspace
 * commands, served as MCP tools from one process per Claude Code session.
 *
 * The browser workspace lives in this same process, so the recall trail and
 * the agent's graph spotlight see every `weave_note` call, exactly as in Pi.
 * Claude Code has no turn event for MCP servers, so turns fall back to the
 * trail's time gap, as in OpenCode.
 */

/** The model scans use unless `PI_WEAVE_CLAUDE_MODEL` names another. */
export const DEFAULT_SCAN_MODEL = "haiku";
const MODEL_PREFIX = "claude-code/";

export const INSTRUCTIONS = [
  "pi-weave is the user's local Markdown memory vault, shared with Pi and OpenCode.",
  "Save the user's notes, decisions and dictation with weave_note, and search it before answering questions about past work.",
  "Leave CLAUDE.md for project instructions; durable knowledge belongs in the vault.",
].join(" ");

export const COMMANDS = ["weave", "weave-view", "weave-scan", "weave-scan-cancel", "weave-statusline"] as const;

export interface ClaudeAdapterOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  home?: string;
  /** Path of the running script, for the status-line snippet. */
  script?: string;
  version?: string;
  spawn?: SpawnFn;
  viewer?: WorkspaceServerController;
}

function statusLineSnippet(script: string): string {
  const command = `node ${JSON.stringify(script)} statusline`;
  return [
    "Add this to ~/.claude/settings.json to show pi-weave in your status line:",
    "",
    JSON.stringify({ statusLine: { type: "command", command } }, null, 2),
  ].join("\n");
}

export function createClaudeAdapter(options: ClaudeAdapterOptions = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const spawn = options.spawn ?? nodeSpawn;
  const viewer = options.viewer ?? new WorkspaceServerController();
  const generate = claudeGenerate({ env, spawn, ...(env.PI_WEAVE_CLAUDE_BIN ? { bin: env.PI_WEAVE_CLAUDE_BIN } : {}) });
  const configDir = claudeConfigDir(env, options.home);
  const transcript = () => findTranscript(cwd, env.CLAUDE_CODE_SESSION_ID, configDir);

  let collecting: string[] | null = null;
  let scan: { text: string; active: boolean } | null = null;
  const shared = createWorkspaceCommands({
    async getSession() {
      const path = await transcript();
      return {
        id: path ? transcriptSessionId(path) : env.CLAUDE_CODE_SESSION_ID ?? "claude-code",
        cwd,
        model: `${MODEL_PREFIX}${env.PI_WEAVE_CLAUDE_MODEL || DEFAULT_SCAN_MODEL}`,
      };
    },
    async getDigest() {
      const path = await transcript();
      if (!path) throw new Error("no Claude Code transcript found for this project");
      return readClaudeTranscript(path);
    },
    sessionSource: (id) => `claude-code:session:${id}`,
    generate: (_id, prompt, signal, model) => generate(prompt, signal, model.slice(MODEL_PREFIX.length)),
    // While a command runs its output is its tool result; a background scan's
    // final word arrives later and is kept by the status below instead.
    async output(_id, text) {
      collecting?.push(text);
    },
  }, (status) => {
    scan = { text: status.text, active: status.active };
  }, viewer, ({ url, open }) => {
    // Over SSH the browser would open on the wrong machine, if at all.
    if (!open || env.SSH_CONNECTION) return;
    const { command, args } = browserOpenCommand(url);
    try {
      spawn(command, args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
    } catch {
      // No opener on this machine; the URL is in the tool result.
    }
  });

  async function runCommand(name: string, args: string): Promise<string> {
    if (name === "weave-statusline") return statusLineSnippet(options.script ?? process.argv[1] ?? "weave.mjs");
    if (name === "weave") {
      const dashboard = formatDashboard(await getWorkspaceStatus(cwd));
      return scan ? `${dashboard}\n\n${scan.active ? "Scan running" : "Last scan"}: ${scan.text}` : dashboard;
    }
    const command = shared.commands.find((candidate) => candidate.name === name);
    if (!command) throw new Error(`Unknown pi-weave command: ${name}`);
    const lines: string[] = [];
    collecting = lines;
    try {
      await command.execute("claude-code", args);
    } finally {
      collecting = null;
    }
    return lines.join("\n") || "pi-weave: scan started in the background. Run /weave to see its progress.";
  }

  const tools: McpTool[] = [
    ...weaveTools.map((tool): McpTool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.input,
      async call(args) {
        return { text: (await tool.execute(args, cwd)).text };
      },
    })),
    {
      name: "weave_command",
      description: "Run a pi-weave slash command (/weave, /weave-view, /weave-scan, /weave-scan-cancel, /weave-statusline) and return its output. Only call this when the user ran one of those commands.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", enum: [...COMMANDS] },
          args: { type: "string", description: "The command's arguments, exactly as the user typed them" },
        },
        required: ["command"],
        additionalProperties: false,
      },
      async call(args) {
        return { text: await runCommand(String(args.command), typeof args.args === "string" ? args.args : "") };
      },
    },
  ];

  const server: McpServerInfo = { name: "pi-weave", version: options.version ?? "0.0.0", instructions: INSTRUCTIONS, tools };
  return {
    server,
    async close() {
      await shared.cleanup();
      await viewer.close();
    },
  };
}
