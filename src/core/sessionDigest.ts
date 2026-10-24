import type { SessionDigest } from "./sessions";

/**
 * One harness-neutral way to build a {@link SessionDigest}.
 *
 * Pi sessions are parsed from their own JSONL by `parseSessionDigest`. Every
 * other harness (OpenCode's session API, Claude Code's transcripts) maps its
 * records onto the small message shape below and lets this function do the
 * counting, clipping and capping, so the digests stay identical in form.
 *
 * Messages are `unknown` on purpose: records come from outside the process,
 * and anything malformed is skipped rather than trusted.
 *
 * - `{ type: "user", text }`
 * - `{ type: "shell" }` — a direct shell execution by the user
 * - `{ type: "compaction", summary }`
 * - `{ type: "assistant", model: { providerID, id }, finish?, error?, content: [{ type: "text", text } | { type: "tool", name, state: { status } }] }`
 */
export interface DigestSessionInfo {
  id: string;
  cwd: string;
  parentSession: string | null;
  startedAt: string;
  endedAt: string;
  name: string | null;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function clipped(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function digestFromMessages(info: DigestSessionInfo, messages: readonly unknown[]): SessionDigest {
  const digest: SessionDigest = {
    ...info,
    models: [],
    userCount: 0,
    assistantCount: 0,
    toolResultCount: 0,
    errors: 0,
    bashCount: 0,
    tools: {},
    firstUserMessage: null,
    userMessages: [],
    compactions: [],
    branchSummaries: [],
    lastAssistantText: null,
  };
  for (const raw of messages) {
    const message = record(raw);
    if (message.type === "user") {
      digest.userCount += 1;
      const text = clipped(message.text, 400);
      if (text) {
        digest.userMessages.push(text);
        if (digest.userMessages.length > 60) digest.userMessages.shift();
        digest.firstUserMessage ??= clipped(text, 120);
      }
      continue;
    }
    if (message.type === "shell") {
      digest.bashCount += 1;
      continue;
    }
    if (message.type === "compaction") {
      const summary = clipped(message.summary, 1_200);
      if (summary) {
        digest.compactions.push(summary);
        if (digest.compactions.length > 3) digest.compactions.shift();
      }
      continue;
    }
    if (message.type !== "assistant") continue;
    digest.assistantCount += 1;
    const model = record(message.model);
    if (typeof model.providerID === "string" && typeof model.id === "string") {
      const label = `${model.providerID}/${model.id}`;
      if (!digest.models.includes(label)) digest.models.push(label);
    }
    if (message.finish === "error" || message.error) digest.errors += 1;
    const content = Array.isArray(message.content) ? message.content : [];
    const text = content
      .filter((part) => record(part).type === "text")
      .map((part) => record(part).text)
      .filter((part): part is string => typeof part === "string")
      .join("\n");
    if (text.trim()) digest.lastAssistantText = clipped(text, 1_200);
    for (const part of content) {
      const tool = record(part);
      if (tool.type !== "tool") continue;
      digest.toolResultCount += 1;
      const name = typeof tool.name === "string" ? tool.name : "unknown";
      digest.tools[name] = (digest.tools[name] ?? 0) + 1;
      if (record(tool.state).status === "error") digest.errors += 1;
    }
  }
  return digest;
}
