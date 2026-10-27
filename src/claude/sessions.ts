import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { hashContent, type SessionDigest } from "../core";
import { digestFromMessages } from "../core/sessionDigest";

/**
 * Claude Code's own transcripts, mapped onto the shared session digest.
 *
 * Claude Code writes one JSONL file per session under
 * `<config dir>/projects/<cwd with every non-alphanumeric as "-">/<session id>.jsonl`,
 * where the config dir is `CLAUDE_CONFIG_DIR` or `~/.claude`.
 * Each assistant content block is its own line; lines of one reply share
 * `message.id`. Tool results come back as user lines holding `tool_result`
 * blocks, and slash commands and `!` shell runs are user lines wrapped in
 * tags. Everything else (attachments, titles, bookkeeping) is skipped.
 */

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return env.CLAUDE_CONFIG_DIR || join(home, ".claude");
}

export function claudeProjectDir(cwd: string, configDir: string = claudeConfigDir()): string {
  return join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

/** The session's transcript, or this project's most recently written one. */
export async function findTranscript(cwd: string, sessionId: string | undefined, configDir: string = claudeConfigDir()): Promise<string | null> {
  const dir = claudeProjectDir(cwd, configDir);
  if (sessionId) {
    const path = join(dir, `${sessionId}.jsonl`);
    if (await stat(path).then((info) => info.isFile(), () => false)) return path;
  }
  const names = await readdir(dir).catch(() => [] as string[]);
  let newest: { path: string; mtime: number } | null = null;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    const info = await stat(path).catch(() => null);
    if (info?.isFile() && (!newest || info.mtimeMs > newest.mtime)) newest = { path, mtime: info.mtimeMs };
  }
  return newest?.path ?? null;
}

export function transcriptSessionId(path: string): string {
  return basename(path, ".jsonl");
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function blocks(content: unknown): Record<string, unknown>[] {
  return Array.isArray(content) ? content.map(record) : [];
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return blocks(content).filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text as string).join("\n");
}

const tag = (text: string, name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim();

/** A user line as the digest should see it: a prompt, a slash command, a shell run, or nothing. */
function userMessage(text: string): Record<string, unknown> | null {
  if (!text.trim()) return null;
  if (text.includes("<bash-input>")) return { type: "shell" };
  const command = tag(text, "command-name");
  if (command) return { type: "user", text: [command, tag(text, "command-args")].filter(Boolean).join(" ") };
  // Command echoes and shell output are the harness talking, not the user.
  if (/^\s*<(local-command-|bash-std|command-message)/.test(text)) return null;
  return { type: "user", text };
}

export interface ClaudeTranscript {
  digest: SessionDigest;
  /** Changes only when the conversation does, so an unchanged session is not re-summarized. */
  hash: string;
}

export function parseClaudeTranscript(text: string, fallbackId = ""): ClaudeTranscript {
  const entries: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(record(JSON.parse(line)));
    } catch {
      // A line cut off mid-write is expected while the session is live.
    }
  }
  const failedTools = new Set<string>();
  for (const entry of entries) {
    for (const block of blocks(record(entry.message).content)) {
      if (block.type === "tool_result" && block.is_error === true && typeof block.tool_use_id === "string") failedTools.add(block.tool_use_id);
    }
  }

  let id = "";
  let cwd = "";
  let startedAt = "";
  let endedAt = "";
  let aiTitle: string | null = null;
  let customTitle: string | null = null;
  const messages: Record<string, unknown>[] = [];
  const replies = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    if (typeof entry.aiTitle === "string" && entry.aiTitle.trim()) aiTitle = entry.aiTitle.trim();
    if (typeof entry.customTitle === "string" && entry.customTitle.trim()) customTitle = entry.customTitle.trim();
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    if (entry.isSidechain === true) continue;
    id ||= typeof entry.sessionId === "string" ? entry.sessionId : "";
    cwd ||= typeof entry.cwd === "string" ? entry.cwd : "";
    if (typeof entry.timestamp === "string") {
      startedAt ||= entry.timestamp;
      endedAt = entry.timestamp;
    }
    const message = record(entry.message);
    if (entry.type === "user") {
      if (entry.isMeta === true) continue;
      const text = textOf(message.content);
      if (entry.isCompactSummary === true) {
        messages.push({ type: "compaction", summary: text });
        continue;
      }
      const mapped = userMessage(text);
      if (mapped) messages.push(mapped);
      continue;
    }
    const key = typeof message.id === "string" ? message.id : `line-${messages.length}`;
    let reply = replies.get(key);
    if (!reply) {
      const model = typeof message.model === "string" && message.model !== "<synthetic>" ? { providerID: "anthropic", id: message.model } : {};
      reply = { type: "assistant", model, error: entry.isApiErrorMessage === true, content: [] };
      replies.set(key, reply);
      messages.push(reply);
    }
    const content = reply.content as Record<string, unknown>[];
    for (const block of blocks(message.content)) {
      if (block.type === "text") content.push({ type: "text", text: block.text });
      if (block.type === "tool_use") {
        content.push({ type: "tool", name: block.name, state: { status: failedTools.has(String(block.id)) ? "error" : "completed" } });
      }
    }
  }
  const digest = digestFromMessages({
    id: id || fallbackId,
    cwd,
    parentSession: null,
    startedAt,
    endedAt: endedAt || startedAt,
    name: customTitle ?? aiTitle,
  }, messages);
  return { digest, hash: hashContent(JSON.stringify(messages)) };
}

export async function readClaudeTranscript(path: string): Promise<ClaudeTranscript> {
  return parseClaudeTranscript(await readFile(path, "utf8"), transcriptSessionId(path));
}
