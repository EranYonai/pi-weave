import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { findGitRoot } from "./git";
import { resolveVaultRoot } from "./paths";
import { buildRepoIndex, summarizeIndex, writeRepoIndex } from "./repoIndex";
import { formatDashboard, getWorkspaceStatus } from "./workspace";
import { DEEP_SCAN_SYSTEM_PROMPT, formatDeepScanResult, runDeepScan, type SummarizeFn } from "./summaries";
import { formatSessionScanResult, renderSessionDigest, runSessionDigestScan, runSessionScan, SESSION_SCAN_SYSTEM_PROMPT, type SessionDigest } from "./sessions";

export interface WorkspaceScanStatus {
  sessionID: string;
  text: string;
  active: boolean;
}

export interface WorkspaceCommand {
  name: string;
  description: string;
  execute(sessionID: string, args: string): Promise<void>;
}

export interface WorkspaceCommandHost {
  getSession(sessionID: string): Promise<{ id: string; cwd: string; model: string | null }>;
  getDigest(sessionID: string, signal: AbortSignal): Promise<{ digest: SessionDigest; hash: string }>;
  sessionSource(sessionID: string): string;
  generate(sessionID: string, prompt: string, signal: AbortSignal, model: string): Promise<string>;
  output(sessionID: string, text: string): Promise<unknown>;
}

interface RunningScan {
  controller: AbortController;
  done: Promise<void>;
}

function summarizer(host: WorkspaceCommandHost, sessionID: string, systemPrompt: string, signal: AbortSignal, model: string): SummarizeFn {
  return async ({ path, content }) => {
    signal.throwIfAborted();
    const text = (await host.generate(sessionID, `${systemPrompt}\n\nFile: ${path}\n\n${content}`, signal, model)).trim();
    signal.throwIfAborted();
    if (!text) throw new Error("model returned an empty summary");
    return text;
  };
}

function historyPath(cwd: string, input: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return resolve(cwd, trimmed);
}

export function createWorkspaceCommands(
  host: WorkspaceCommandHost,
  onStatus: (status: WorkspaceScanStatus) => void = () => {},
  viewer?: { run(cwd: string): Promise<{ session: { server: { entryUrl: string } }; started: boolean }> },
  onViewer?: (event: { sessionID: string; url: string; open: boolean; started: boolean }) => void,
) {
  const running = new Map<string, RunningScan>();
  const commands: WorkspaceCommand[] = [];
  const output = host.output;
  const cwdOf = async (sessionID: string) => (await host.getSession(sessionID)).cwd;

  const start = (sessionID: string, run: (signal: AbortSignal) => Promise<string>): void => {
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

  commands.push({
    name: "weave",
    description: "Show the pi-weave workspace dashboard",
    async execute(sessionID) {
      await output(sessionID, formatDashboard(await getWorkspaceStatus(await cwdOf(sessionID))));
    },
  });

  commands.push({
    name: "weave-scan",
    description: "Refresh the index; use 'deep' or 'sessions [path]' for model-backed scans",
    async execute(sessionID, args) {
      const [mode = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const key = String(sessionID);
      if (running.has(key)) {
        await output(sessionID, "pi-weave: a scan is already running — use /weave-scan-cancel to stop it.");
        return;
      }
      const cwd = await cwdOf(sessionID);
      if (mode.toLowerCase() === "sessions") {
        const session = await host.getSession(sessionID);
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
              summarize: summarizer(host, sessionID, SESSION_SCAN_SYSTEM_PROMPT, signal, session.model!),
              model: session.model!,
              signal,
              onProgress: ({ current, total, path }) => {
                onStatus({ sessionID: key, text: `🕸️ session scan: ${current}/${total} — ${path}`, active: true });
              },
            });
            return signal.aborted
              ? "pi-weave: session scan cancelled."
              : `pi-weave: session scan complete — ${formatSessionScanResult(result)}`;
          }
          const { digest, hash } = await host.getDigest(sessionID, signal);
          const result = await runSessionDigestScan({
            vaultRoot: resolveVaultRoot(),
            digest,
            content: renderSessionDigest(digest),
            source: host.sessionSource(session.id),
            hash,
            summarize: summarizer(host, sessionID, SESSION_SCAN_SYSTEM_PROMPT, signal, session.model!),
            model: session.model!,
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
      onStatus({ sessionID: key, text: "pi-weave: index refreshed", active: false });
      if (mode.toLowerCase() !== "deep") return;

      const session = await host.getSession(sessionID);
      if (!session.model) {
        await output(sessionID, "pi-weave: deep scan needs an active session model — none configured. Light index only.");
        return;
      }
      start(sessionID, async (signal) => {
        onStatus({ sessionID: key, text: "🕸️ deep scan: starting…", active: true });
        const result = await runDeepScan(root, {
          summarize: summarizer(host, sessionID, DEEP_SCAN_SYSTEM_PROMPT, signal, session.model!),
          model: session.model!,
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

  commands.push({
    name: "weave-scan-cancel",
    description: "Cancel the active pi-weave deep or session scan",
    async execute(sessionID) {
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
    commands.push({
      name: "weave-view",
      description: "Open the pi-weave browser workspace; use --no-open to only print the URL",
      async execute(sessionID, input) {
        const args = input.trim();
        if (args && args !== "--no-open") {
          await output(sessionID, "usage: /weave-view [--no-open]");
          return;
        }
        const { session, started } = await viewer.run(await cwdOf(sessionID));
        const url = session.server.entryUrl;
        const open = args !== "--no-open" && onViewer !== undefined;
        onViewer?.({ sessionID: String(sessionID), url, open, started });
        await output(
          sessionID,
          `pi-weave: workspace ${started ? "running" : "already running"} at ${url}${open ? " — opening when the terminal is local." : " — open it in a browser."}`,
        );
      },
    });
  }

  return {
    commands,
    done: (sessionID: string) => running.get(sessionID)?.done,
    async cleanup() {
      for (const scan of running.values()) scan.controller.abort();
      await Promise.all([...running.values()].map((scan) => scan.done));
    },
  };
}
