import { hashContent } from "../core";
import type { SessionDigest } from "../core";
import { createWorkspaceCommands, type WorkspaceScanStatus } from "../core/workspaceCommands";
import type { WorkspaceServerController } from "../web/server/controller";

type Context = import("@opencode/plugin").Plugin.Context;
type SessionID = Parameters<Context["session"]["get"]>[0]["sessionID"];
export type OpenCodeScanStatus = WorkspaceScanStatus;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function timestamp(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : "";
}

function clipped(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Convert OpenCode's public session context to the portable session digest. */
export function openCodeSessionDigest(session: unknown, messages: readonly unknown[]): SessionDigest {
  const info = record(session);
  const time = record(info.time);
  const location = record(info.location);
  const relevant = messages.filter((message) => ["user", "assistant", "compaction", "shell"].includes(String(record(message).type)));
  const digest: SessionDigest = {
    id: String(info.id ?? ""),
    cwd: typeof location.directory === "string" ? location.directory : "",
    parentSession: typeof info.parentID === "string" ? info.parentID : null,
    startedAt: timestamp(time.created),
    endedAt: timestamp(time.updated),
    name: typeof info.title === "string" && info.title.trim() ? info.title.trim() : null,
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
  for (const raw of relevant) {
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

export async function registerOpenCodeCommands(
  context: Context,
  onStatus: (status: OpenCodeScanStatus) => void = () => {},
  viewer?: WorkspaceServerController,
  onViewer: (event: { sessionID: string; url: string; open: boolean; started: boolean }) => void = () => {},
) {
  const shared = createWorkspaceCommands({
    async getSession(id) {
      const session = await context.session.get({ sessionID: id as SessionID });
      return { id: session.id, cwd: session.location.directory, model: session.model ? `${session.model.providerID}/${session.model.id}` : null };
    },
    async getDigest(id, signal) {
      const sessionID = id as SessionID;
      const session = await context.session.get({ sessionID });
      const messages = await context.session.context({ sessionID }, { signal });
      const relevant = messages.filter((message) => ["user", "assistant", "compaction", "shell"].includes(message.type));
      return { digest: openCodeSessionDigest(session, relevant), hash: hashContent(JSON.stringify(relevant)) };
    },
    sessionSource: (id) => `opencode:session:${id}`,
    async generate(id, prompt, signal) {
      return (await context.session.generate({ sessionID: id as SessionID, prompt }, { signal })).text;
    },
    output: (id, text) => context.session.synthetic({ sessionID: id as SessionID, text, description: "pi-weave", resume: false }),
  }, onStatus, viewer, onViewer);
  const registration = await context.command.transform((editor) => {
    for (const command of shared.commands) editor.add({
      name: command.name,
      description: command.description,
      execute: ({ sessionID, prompt }) => command.execute(sessionID, prompt.text),
    });
  });
  return {
    done: shared.done,
    async cleanup() {
      await shared.cleanup();
      await registration.dispose();
    },
  };
}
