import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildRepoIndex,
  DEEP_SCAN_SYSTEM_PROMPT,
  findGitRoot,
  formatDashboard,
  formatDeepScanResult,
  formatSessionScanResult,
  getWorkspaceStatus,
  hashContent,
  renderSessionDigest,
  resolveVaultRoot,
  runDeepScan,
  runSessionDigestScan,
  runSessionScan,
  SESSION_SCAN_SYSTEM_PROMPT,
  summarizeIndex,
  writeRepoIndex,
  type SessionDigest,
  type SummarizeFn,
} from "../core";
import type { WorkspaceServerController } from "../web/server/controller";

type Context = import("@opencode/plugin").Plugin.Context;
type SessionID = Parameters<Context["session"]["get"]>[0]["sessionID"];

export interface OpenCodeScanStatus {
  sessionID: string;
  text: string;
  active: boolean;
}

interface RunningScan {
  controller: AbortController;
  done: Promise<void>;
}

export interface OpenCodeCommands {
  cleanup(): Promise<void>;
  done(sessionID: string): Promise<void> | undefined;
}

function historyPath(cwd: string, input: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return resolve(cwd, trimmed);
}

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

function sessionModelLabel(session: unknown): string | null {
  const model = record(record(session).model);
  return typeof model.providerID === "string" && typeof model.id === "string"
    ? `${model.providerID}/${model.id}`
    : null;
}

function summarizer(
  context: Context,
  sessionID: SessionID,
  systemPrompt: string,
  signal: AbortSignal,
): SummarizeFn {
  return async ({ path, content }) => {
    const result = await context.session.generate({
      sessionID,
      prompt: `${systemPrompt}\n\nFile: ${path}\n\n${content}`,
    }, { signal });
    const text = result.text.trim();
    if (!text) throw new Error("model returned an empty summary");
    return text;
  };
}

export async function registerOpenCodeCommands(
  context: Context,
  onStatus: (status: OpenCodeScanStatus) => void = () => {},
  viewer?: WorkspaceServerController,
  onViewer: (event: { sessionID: string; url: string; open: boolean; started: boolean }) => void = () => {},
): Promise<OpenCodeCommands> {
  const running = new Map<string, RunningScan>();
  const registrations: Awaited<ReturnType<Context["command"]["transform"]>>[] = [];
  const output = (sessionID: SessionID, text: string) =>
    context.session.synthetic({ sessionID, text, description: "pi-weave", resume: false });
  const cwdOf = async (sessionID: SessionID) => (await context.session.get({ sessionID })).location.directory;

  const start = (sessionID: SessionID, run: (signal: AbortSignal) => Promise<string>): void => {
    const key = String(sessionID);
    const controller = new AbortController();
    const done = (async () => {
      try {
        const text = await run(controller.signal);
        await output(sessionID, text);
        onStatus({ sessionID: key, text, active: false });
      } catch (error) {
        const text = controller.signal.aborted
          ? "pi-weave: scan cancelled."
          : `pi-weave: scan failed — ${error instanceof Error ? error.message : String(error)}`;
        await output(sessionID, text).catch(() => {});
        onStatus({ sessionID: key, text, active: false });
      } finally {
        running.delete(key);
      }
    })();
    running.set(key, { controller, done });
  };

  registrations.push(await context.command.transform((editor) => {
    editor.add({
      name: "weave",
      description: "Show the pi-weave workspace dashboard",
      async execute({ sessionID }) {
        await output(sessionID, formatDashboard(await getWorkspaceStatus(await cwdOf(sessionID))));
      },
    });

    editor.add({
      name: "weave-scan",
      description: "Refresh the index; use 'deep' or 'sessions [path]' for model-backed scans",
      async execute({ sessionID, prompt }) {
        const [mode = "", ...rest] = prompt.text.trim().split(/\s+/).filter(Boolean);
        const key = String(sessionID);
        if (running.has(key)) {
          await output(sessionID, "pi-weave: a scan is already running — use /weave-scan-cancel to stop it.");
          return;
        }
        const cwd = await cwdOf(sessionID);
        if (mode.toLowerCase() === "sessions") {
          const session = await context.session.get({ sessionID });
          if (!session.model) {
            await output(sessionID, "pi-weave: session scan needs an active session model — none configured.");
            return;
          }
          start(sessionID, async (signal) => {
            const status = "🕸️ session scan: starting…";
            onStatus({ sessionID: key, text: status, active: true });
            if (rest.length > 0) {
              const result = await runSessionScan({
                sessionsRoot: historyPath(cwd, rest.join(" ")),
                vaultRoot: resolveVaultRoot(),
                summarize: summarizer(context, sessionID, SESSION_SCAN_SYSTEM_PROMPT, signal),
                ...(sessionModelLabel(session) ? { model: sessionModelLabel(session)! } : {}),
                signal,
                onProgress: ({ current, total, path }) => {
                  onStatus({ sessionID: key, text: `🕸️ session scan: ${current}/${total} — ${path}`, active: true });
                },
              });
              return signal.aborted
                ? "pi-weave: session scan cancelled."
                : `pi-weave: session scan complete — ${formatSessionScanResult(result)}`;
            }
            const messages = await context.session.context({ sessionID }, { signal });
            const digest = openCodeSessionDigest(session, messages);
            const relevant = messages.filter((message) => ["user", "assistant", "compaction", "shell"].includes(message.type));
            const result = await runSessionDigestScan({
              vaultRoot: resolveVaultRoot(),
              digest,
              content: renderSessionDigest(digest),
              source: `opencode:session:${session.id}`,
              hash: hashContent(JSON.stringify(relevant)),
              summarize: summarizer(context, sessionID, SESSION_SCAN_SYSTEM_PROMPT, signal),
              ...(sessionModelLabel(session) ? { model: sessionModelLabel(session)! } : {}),
            });
            return signal.aborted
              ? "pi-weave: session scan cancelled."
              : `pi-weave: session scan complete — ${formatSessionScanResult(result)}`;
          });
          return;
        }

        const root = await findGitRoot(cwd);
        if (!root) {
          await output(sessionID, "pi-weave: not inside a git repository.");
          return;
        }
        const index = await buildRepoIndex(root);
        if (!index) {
          await output(sessionID, "pi-weave: cannot index — the repository has no commits yet.");
          return;
        }
        await writeRepoIndex(root, index);
        await output(sessionID, `pi-weave: index refreshed\n${summarizeIndex(index).join("\n")}`);
        if (mode.toLowerCase() !== "deep") return;

        const session = await context.session.get({ sessionID });
        if (!session.model) {
          await output(sessionID, "pi-weave: deep scan needs an active session model — none configured. Light index only.");
          return;
        }
        start(sessionID, async (signal) => {
          onStatus({ sessionID: key, text: "🕸️ deep scan: starting…", active: true });
          const result = await runDeepScan(root, {
            summarize: summarizer(context, sessionID, DEEP_SCAN_SYSTEM_PROMPT, signal),
            ...(sessionModelLabel(session) ? { model: sessionModelLabel(session)! } : {}),
            signal,
            onProgress: ({ current, total, path }) => {
              const pct = total > 0 ? Math.round((current / total) * 100) : 100;
              onStatus({ sessionID: key, text: `🕸️ deep scan: ${current}/${total} (${pct}%) — ${path}`, active: true });
            },
          });
          if (signal.aborted) return "pi-weave: deep scan cancelled.";
          return result
            ? `pi-weave: deep scan complete — ${formatDeepScanResult(result)}`
            : "pi-weave: deep scan stopped — repository unavailable.";
        });
      },
    });

    editor.add({
      name: "weave-scan-cancel",
      description: "Cancel the active pi-weave deep or session scan",
      async execute({ sessionID }) {
        const scan = running.get(String(sessionID));
        if (!scan) {
          await output(sessionID, "pi-weave: no scan is currently running.");
          return;
        }
        scan.controller.abort();
        await output(sessionID, "pi-weave: scan cancellation requested.");
      },
    });

    if (viewer) {
      editor.add({
        name: "weave-view",
        description: "Open the pi-weave browser workspace; use --no-open to only print the URL",
        async execute({ sessionID, prompt }) {
          const args = prompt.text.trim();
          if (args && args !== "--no-open") {
            await output(sessionID, "usage: /weave-view [--no-open]");
            return;
          }
          const { session, started } = await viewer.run(await cwdOf(sessionID));
          const url = session.server.entryUrl;
          const open = args !== "--no-open";
          onViewer({ sessionID: String(sessionID), url, open, started });
          await output(
            sessionID,
            `pi-weave: workspace ${started ? "running" : "already running"} at ${url}${open ? " — opening when the terminal is local." : " — open it in a browser."}`,
          );
        },
      });
    }
  }));

  return {
    done: (sessionID) => running.get(sessionID)?.done,
    async cleanup() {
      for (const scan of running.values()) scan.controller.abort();
      await Promise.all([...running.values()].map((scan) => scan.done));
      await Promise.all(registrations.map((registration) => registration.dispose()));
    },
  };
}
