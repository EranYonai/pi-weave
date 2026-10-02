import { execFile } from "node:child_process";
import { browserOpenCommand } from "../web/server/controller";
import { WEAVE_RPC } from "./rpc";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

export async function viewerIsLocal(url: string, request: typeof fetch = fetch): Promise<boolean> {
  try {
    const target = new URL(url);
    if (target.protocol !== "http:" || !["127.0.0.1", "::1", "localhost"].includes(target.hostname)) return false;
    const response = await request(target, { redirect: "manual", signal: AbortSignal.timeout(1_000) });
    await response.body?.cancel().catch(() => undefined);
    return response.status === 302 && response.headers.has("set-cookie");
  } catch {
    return false;
  }
}

async function openBrowser(url: string): Promise<boolean> {
  const { command, args } = browserOpenCommand(url);
  return new Promise((resolve) => {
    execFile(command, args, (error) => resolve(error === null));
  });
}

async function viewerNotice(url: string, open: boolean) {
  const opened = open && await viewerIsLocal(url) && await openBrowser(url);
  return {
    message: opened
      ? `Workspace opened at ${url}`
      : `Workspace running at ${url}${open ? " — open this URL from the server host or through a tunnel." : ""}`,
    variant: opened ? "success" as const : "info" as const,
  };
}

const weaveTui = {
  id: "pi-weave.tui",
  async tui(api) {
    api.lifecycle.onDispose(api.event.on("message.part.updated", async ({ properties: { part } }) => {
      if (part.type !== "text" || !part.synthetic) return;
      const result = record(part.metadata?.["pi-weave-result"]);
      if (typeof result.text !== "string") return;
      const route = api.route.current;
      if (route.name === "session" && route.params?.sessionID !== part.sessionID) return;
      const viewer = record(result.viewer);
      if (typeof viewer.url !== "string") return;
      const notice = await viewerNotice(viewer.url, viewer.open === true);
      api.ui.toast({ title: "pi-weave", ...notice });
      if (notice.variant === "success") return;
      api.ui.dialog.replace(() => api.ui.DialogAlert({ title: "pi-weave", message: result.text as string }));
    }));
  },
  async setup(context) {
    const rpc = context.client.rpc(WEAVE_RPC);
    try {
      const initial = await rpc.status({});
      const text = String(record(initial).text ?? "");
      if (text.includes("repo:unindexed")) {
        context.ui.toast.show({ message: "This repository is not indexed yet. Run /weave-scan.", variant: "info" });
      } else if (text.includes(":stale")) {
        context.ui.toast.show({ message: "The pi-weave repository index is stale. Run /weave-scan.", variant: "warning" });
      }
    } catch {
      context.ui.toast.show({ message: "pi-weave unavailable", variant: "warning" });
    }

    let lastProgress = 0;
    const stopStatus = rpc.events.on("status", (event) => {
      const data = record(event.data);
      if (data.active === true && typeof data.text === "string" && Date.now() - lastProgress >= 2_000) {
        lastProgress = Date.now();
        context.ui.toast.show({ message: data.text, variant: "info", duration: 2_000, ...(typeof data.sessionID === "string" ? { sessionID: data.sessionID } : {}) });
      }
      if (data.active === false && typeof data.text === "string" && data.text.includes("complete")) {
        context.ui.toast.show({ message: data.text, variant: "success", ...(typeof data.sessionID === "string" ? { sessionID: data.sessionID } : {}) });
      }
    });
    const stopViewer = rpc.events.on("viewer", async (event) => {
      const data = record(event.data);
      if (typeof data.url !== "string") return;
      context.ui.toast.show({
        title: "pi-weave",
        ...await viewerNotice(data.url, data.open === true),
        ...(typeof data.sessionID === "string" ? { sessionID: data.sessionID } : {}),
      });
    });
    return () => {
      stopViewer();
      stopStatus();
    };
  },
} satisfies import("@opencode/plugin/tui").Plugin.Definition & Pick<import("@opencode-ai/plugin/tui").TuiPluginModule, "tui">;

export default weaveTui;
