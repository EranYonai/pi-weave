import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { browserOpenCommand } from "../web/server/controller";
import { WEAVE_RPC } from "./rpc";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

export async function serverIsLocal(info: { paths: { tmp: string } }): Promise<boolean> {
  try {
    await access(info.paths.tmp);
    return true;
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

const weaveTui = {
  id: "pi-weave.tui",
  async setup(context) {
    const rpc = context.client.rpc(WEAVE_RPC);
    const [status, setStatus] = context.storage.memory("pi-weave.status", {
      initial: { text: "🕸️ loading…", active: false },
    });
    const update = (value: unknown) => {
      const next = record(value);
      setStatus((draft) => {
        if (typeof next.text === "string") draft.text = next.text;
        if (typeof next.active === "boolean") draft.active = next.active;
      });
    };

    try {
      const initial = await rpc.status({});
      update(initial);
      const text = String(record(initial).text ?? "");
      if (text.includes("repo:unindexed")) {
        context.ui.toast.show({ message: "This repository is not indexed yet. Run /weave-scan.", variant: "info" });
      } else if (text.includes(":stale")) {
        context.ui.toast.show({ message: "The pi-weave repository index is stale. Run /weave-scan.", variant: "warning" });
      }
    } catch {
      setStatus((draft) => { draft.text = "🕸️ unavailable"; });
    }

    const stopStatus = rpc.events.on("status", (event) => {
      update(event.data);
      const data = record(event.data);
      if (data.active === false && typeof data.text === "string" && data.text.includes("complete")) {
        context.ui.toast.show({ message: data.text, variant: "success", ...(typeof data.sessionID === "string" ? { sessionID: data.sessionID } : {}) });
      }
    });
    const stopViewer = rpc.events.on("viewer", async (event) => {
      const data = record(event.data);
      if (typeof data.url !== "string") return;
      let opened = false;
      if (data.open === true) {
        const info = await context.client.server.info();
        if (await serverIsLocal(info)) opened = await openBrowser(data.url);
      }
      context.ui.toast.show({
        title: "pi-weave",
        message: opened
          ? `Workspace opened at ${data.url}`
          : `Workspace running at ${data.url}${data.open === true ? " — open this URL from the server host or through a tunnel." : ""}`,
        variant: opened ? "success" : "info",
        ...(typeof data.sessionID === "string" ? { sessionID: data.sessionID } : {}),
      });
    });
    const stopHome = context.ui.slot({ append: "home.footer.status", render: () => status.text });
    const stopPrompt = context.ui.slot({ append: "prompt.footer.status", render: () => status.text });

    return () => {
      stopPrompt();
      stopHome();
      stopViewer();
      stopStatus();
    };
  },
} satisfies import("@opencode/plugin/tui").Plugin.Definition;

export default weaveTui;
