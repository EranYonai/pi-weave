import { execFile } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import weaveTui, { viewerIsLocal } from "../../src/opencode/tui";
import { WorkspaceServerController } from "../../src/web/server/controller";
import { makeTempDir } from "../helpers";

const realFetch = globalThis.fetch;

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_command: string, _args: string[], callback: (error: Error | null) => void) => callback(null)),
}));

describe("OpenCode terminal companion", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 302, headers: { "set-cookie": "session=token" } })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows exact V1 results in a native dialog and opens the viewer from the terminal", async () => {
    let handler: (event: unknown) => Promise<void>;
    const stop = vi.fn();
    const alert = vi.fn();
    const toast = vi.fn();
    const dispose = vi.fn();
    const api = {
      route: { current: { name: "session", params: { sessionID: "s1" } } },
      lifecycle: { onDispose: dispose },
      event: { on: vi.fn((_name, callback) => { handler = callback; return stop; }) },
      ui: { toast, DialogAlert: alert, dialog: { replace: (render: () => void) => render() } },
    };
    await weaveTui.tui(api as never);
    expect(api.event.on).toHaveBeenCalledWith("message.part.updated", expect.any(Function));
    expect(dispose).toHaveBeenCalledWith(stop);
    const send = (part: unknown) => handler({ properties: { part } });
    const part = { type: "text", sessionID: "s1", synthetic: true };
    await send({ type: "tool" });
    await send({ ...part, synthetic: false });
    await send(part);
    const text = "Vault (/private/var/folders/full/path/vault):\n  not initialized";
    const metadata = { "pi-weave-result": { text } };
    await send({ ...part, sessionID: "other", metadata });
    expect(alert).not.toHaveBeenCalled();
    await send({ ...part, metadata });
    expect(alert).toHaveBeenLastCalledWith({ title: "pi-weave", message: text });
    alert.mockClear();
    const url = "http://127.0.0.1:1234/?t=unchanged-token";
    const viewer = (open: boolean) => send({ ...part, metadata: { "pi-weave-result": { text: url, viewer: { url, open } } } });
    vi.mocked(execFile).mockClear();
    await viewer(true);
    expect(execFile).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining([url]), expect.any(Function));
    expect(toast).toHaveBeenLastCalledWith({ title: "pi-weave", message: `Workspace opened at ${url}`, variant: "success" });
    expect(alert).not.toHaveBeenCalled();
    vi.mocked(execFile).mockClear();
    await viewer(false);
    expect(execFile).not.toHaveBeenCalled();
    expect(alert).toHaveBeenLastCalledWith({ title: "pi-weave", message: url });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("remote loopback"); }));
    await viewer(true);
    expect(execFile).not.toHaveBeenCalled();
    expect(toast.mock.lastCall?.[0].message).toContain("through a tunnel");
    expect(alert).toHaveBeenLastCalledWith({ title: "pi-weave", message: url });
  });

  it("opens only a reachable loopback viewer", async () => {
    const reachable = vi.fn(async () => new Response(null, { status: 302, headers: { "set-cookie": "session=token" } }));
    const unreachable = vi.fn(async () => { throw new Error("offline"); });
    expect(await viewerIsLocal("http://127.0.0.1:1234/?t=token", reachable)).toBe(true);
    expect(await viewerIsLocal("http://127.0.0.1:1234/?t=token", unreachable)).toBe(false);
    expect(await viewerIsLocal("https://example.com/?t=token", reachable)).toBe(false);
    expect(await viewerIsLocal("http://127.0.0.1:1234/?t=token", async () => new Response("forbidden", { status: 403 }))).toBe(false);
    expect(reachable).toHaveBeenCalledTimes(1);
    expect(reachable).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ redirect: "manual" }));
  });

  it("recognizes the real viewer token handoff", async () => {
    const vault = await makeTempDir();
    const controller = new WorkspaceServerController({ vaultRoot: () => vault });
    try {
      const { session } = await controller.run(await makeTempDir());
      expect(await viewerIsLocal(session.server.entryUrl, realFetch)).toBe(true);
    } finally {
      await controller.close();
    }
  });

  it("surfaces progress and completion, and opens local viewer events", async () => {
    const handlers = new Map<string, (event: { data: Record<string, unknown> }) => void | Promise<void>>();
    const toasts: { message: string; variant?: string; sessionID?: string }[] = [];
    const rpc = {
      async status() { return { text: "🕸️ vault:0 · repo:unindexed", active: false }; },
      events: {
        on(name: string, handler: (event: { data: Record<string, unknown> }) => void | Promise<void>) {
          handlers.set(name, handler);
          return () => handlers.delete(name);
        },
      },
    };
    const context = {
      client: {
        rpc: () => rpc,
      },
      ui: {
        toast: { show: (toast: { message: string; variant?: string; sessionID?: string }) => toasts.push(toast) },
      },
    };

    const cleanup = await weaveTui.setup(context as never);
    expect(toasts[0]?.message).toContain("not indexed");

    const now = vi.spyOn(Date, "now").mockReturnValue(5_000);
    await handlers.get("status")!({ data: { text: "🕸️ deep scan: 1/3", active: true, sessionID: "s1" } });
    expect(toasts.at(-1)).toMatchObject({ message: "🕸️ deep scan: 1/3", variant: "info", sessionID: "s1" });
    now.mockReturnValue(6_000);
    await handlers.get("status")!({ data: { text: "🕸️ deep scan: 2/3", active: true } });
    expect(toasts.at(-1)?.message).toBe("🕸️ deep scan: 1/3");
    now.mockReturnValue(8_000);
    await handlers.get("status")!({ data: { text: "🕸️ deep scan: 3/3", active: true } });
    expect(toasts.at(-1)?.message).toBe("🕸️ deep scan: 3/3");

    await handlers.get("status")!({ data: { text: "pi-weave: deep scan complete", active: false, sessionID: "s1" } });
    expect(toasts.at(-1)?.variant).toBe("success");

    await handlers.get("viewer")!({
      data: { sessionID: "s1", url: "http://127.0.0.1:1234/", open: true, started: true },
    });
    expect(vi.mocked(execFile)).toHaveBeenCalled();
    expect(toasts.at(-1)?.message).toContain("Workspace opened");
    cleanup?.();
  });

  it("prints the URL instead of opening when the server is remote or --no-open was used", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("remote loopback"); }));
    const handlers = new Map<string, (event: { data: Record<string, unknown> }) => void | Promise<void>>();
    const toasts: { message: string }[] = [];
    const rpc = {
      async status() { return { text: "🕸️ vault:1 · repo:stale", active: false }; },
      events: {
        on(name: string, handler: (event: { data: Record<string, unknown> }) => void | Promise<void>) {
          handlers.set(name, handler);
          return () => {};
        },
      },
    };
    const context = {
      client: {
        rpc: () => rpc,
      },
      ui: {
        toast: { show: (toast: { message: string }) => toasts.push(toast) },
      },
    };
    await weaveTui.setup(context as never);
    expect(toasts[0]?.message).toContain("stale");
    vi.mocked(execFile).mockClear();
    await handlers.get("status")!({ data: null as never });
    await handlers.get("status")!({ data: { text: "🕸️ deep scan: 1/2", active: true } });
    await handlers.get("viewer")!({ data: { open: true } });
    await handlers.get("viewer")!({ data: { url: "http://127.0.0.1:9/", open: true } });
    expect(execFile).not.toHaveBeenCalled();
    expect(toasts.at(-1)?.message).toContain("through a tunnel");
    await handlers.get("viewer")!({ data: { url: "http://127.0.0.1:9/", open: false } });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("degrades cleanly when the server plugin is unavailable", async () => {
    const toasts: { message: string; variant: string }[] = [];
    const context = {
      client: {
        rpc: () => ({
          status: async () => { throw new Error("offline"); },
          events: { on: () => () => {} },
        }),
      },
      ui: { toast: { show: (toast: { message: string; variant: string }) => toasts.push(toast) } },
    };
    await weaveTui.setup(context as never);
    expect(toasts).toContainEqual({ message: "pi-weave unavailable", variant: "warning" });
  });

  it("accepts an initial status without display text", async () => {
    const context = {
      client: {
        rpc: () => ({
          status: async () => ({ active: false }),
          events: { on: () => () => {} },
        }),
      },
      ui: { toast: { show: () => {} } },
    };
    await weaveTui.setup(context as never);
  });
});
