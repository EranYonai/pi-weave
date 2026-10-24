import { hashContent, type SessionDigest } from "../core";
import { digestFromMessages } from "../core/sessionDigest";
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

/** Convert OpenCode's public session context to the portable session digest. */
export function openCodeSessionDigest(session: unknown, messages: readonly unknown[]): SessionDigest {
  const info = record(session);
  const time = record(info.time);
  const location = record(info.location);
  return digestFromMessages({
    id: String(info.id ?? ""),
    cwd: typeof location.directory === "string" ? location.directory : "",
    parentSession: typeof info.parentID === "string" ? info.parentID : null,
    startedAt: timestamp(time.created),
    endedAt: timestamp(time.updated),
    name: typeof info.title === "string" && info.title.trim() ? info.title.trim() : null,
  }, messages);
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
