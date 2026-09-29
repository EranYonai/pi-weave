import { execFile } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import weaveTui, { serverIsLocal } from "../../src/opencode/tui";
import { makeTempDir } from "../helpers";

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_command: string, _args: string[], callback: (error: Error | null) => void) => callback(null)),
}));

describe("OpenCode terminal companion", () => {
  it("detects whether the server filesystem is local", async () => {
    expect(await serverIsLocal({ paths: { tmp: await makeTempDir() } })).toBe(true);
    expect(await serverIsLocal({ paths: { tmp: "/definitely/not/a/local/opencode/server" } })).toBe(false);
  });

  it("renders status, surfaces completion, and opens local viewer events", async () => {
    const tmp = await makeTempDir();
    const handlers = new Map<string, (event: { data: Record<string, unknown> }) => void | Promise<void>>();
    const toasts: { message: string; variant?: string }[] = [];
    const slots: { render(): unknown }[] = [];
    const state = { text: "", active: false };
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
        server: { info: async () => ({ paths: { tmp } }) },
      },
      storage: {
        memory: () => [state, (mutate: (draft: typeof state) => void) => mutate(state)],
      },
      ui: {
        toast: { show: (toast: { message: string; variant?: string }) => toasts.push(toast) },
        slot(claim: { render(): unknown }) {
          slots.push(claim);
          return () => {};
        },
      },
    };

    const cleanup = await weaveTui.setup(context as never);
    expect(slots).toHaveLength(2);
    expect(slots[0]!.render()).toBe("🕸️ vault:0 · repo:unindexed");
    expect(toasts[0]?.message).toContain("not indexed");

    await handlers.get("status")!({ data: { text: "pi-weave: deep scan complete", active: false, sessionID: "s1" } });
    expect(slots[1]!.render()).toContain("scan complete");
    expect(toasts.at(-1)?.variant).toBe("success");

    await handlers.get("viewer")!({
      data: { sessionID: "s1", url: "http://127.0.0.1:1234/", open: true, started: true },
    });
    expect(vi.mocked(execFile)).toHaveBeenCalled();
    expect(toasts.at(-1)?.message).toContain("Workspace opened");
    cleanup?.();
  });

  it("prints the URL instead of opening when the server is remote or --no-open was used", async () => {
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
        server: { info: async () => ({ paths: { tmp: "/not/local" } }) },
      },
      storage: { memory: () => [{ text: "", active: false }, () => {}] },
      ui: {
        toast: { show: (toast: { message: string }) => toasts.push(toast) },
        slot: () => () => {},
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
    const state = { text: "", active: false };
    const context = {
      client: {
        rpc: () => ({
          status: async () => { throw new Error("offline"); },
          events: { on: () => () => {} },
        }),
      },
      storage: { memory: () => [state, (mutate: (draft: typeof state) => void) => mutate(state)] },
      ui: { toast: { show: () => {} }, slot: () => () => {} },
    };
    await weaveTui.setup(context as never);
    expect(state.text).toBe("🕸️ unavailable");
  });

  it("accepts an initial status without display text", async () => {
    const context = {
      client: {
        rpc: () => ({
          status: async () => ({ active: false }),
          events: { on: () => () => {} },
        }),
      },
      storage: { memory: () => [{ text: "loading", active: false }, () => {}] },
      ui: { toast: { show: () => {} }, slot: () => () => {} },
    };
    await weaveTui.setup(context as never);
  });
});
