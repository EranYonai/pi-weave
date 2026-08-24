import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import piWeave from "../../src/pi/index";
import { readOkfFileForView } from "../../src/core";
import { createMockCtx, createMockPi, makeTempDir, withVaultEnv } from "../helpers";

function buildExtension() {
  const mock = createMockPi();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  piWeave(mock.api as any);
  return mock;
}

describe("/weave-view command", () => {
  it("is registered alongside the other commands, with session_shutdown wired", async () => {
    const mock = buildExtension();
    expect(mock.commands.has("weave-view")).toBe(true);
    // cleanup: shut down — the TUI holds no session resources, so this is a no-op
    // and must not throw.
    await mock.emit("session_shutdown", {}, createMockCtx(await makeTempDir()));
  });

  it("readOkfFileForView: reads a file, and rejects traversal or missing paths", async () => {
    const repo = await makeTempDir();
    await mkdir(join(repo, ".okf", "repository"), { recursive: true });
    await writeFile(join(repo, ".okf", "repository", "git.json"), "{\"branch\":\"main\"}", "utf8");
    await writeFile(join(repo, "secret.txt"), "top secret", "utf8");

    const good = await readOkfFileForView(repo, "repository/git.json");
    expect(good?.body).toContain("main");

    const missing = await readOkfFileForView(repo, "repository/absent.json");
    expect(missing).toBeNull();

    const traversal = await readOkfFileForView(repo, "../../secret.txt");
    expect(traversal).toBeNull();
  });
});

describe("/weave-view tui", () => {
  it("parses 'tui' and invokes ctx.ui.custom once; done(null) completes the handler", async () => {
    const vault = await makeTempDir();
    await withVaultEnv(vault, async () => {
      const mock = buildExtension();
      const ctx = createMockCtx(await makeTempDir()); // tui + hasUI
      const handlerPromise = mock.commands.get("weave-view")!.handler("tui", ctx);
      // let the handler reach ctx.ui.custom (await buildCurrentGraph over disk, then custom)
      for (let i = 0; i < 50 && ctx.ui.customCalls.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
      expect(ctx.ui.customCalls).toHaveLength(1);
      // simulate the user pressing q -> done(null) resolves the handler
      ctx.ui.resolveCustom(null);
      await handlerPromise;
      // status line refreshed after close
      expect(ctx.ui.statuses["weave"]).toBeTruthy();
      // no browser/server started
      expect(mock.api.execCalls).toEqual([]);
    });
  });

  it("warns and does nothing without UI (hasUI=false)", async () => {
    const mock = buildExtension();
    const ctx = createMockCtx(await makeTempDir(), false, "tui");
    await mock.commands.get("weave-view")!.handler("tui", ctx);
    expect(ctx.ui.customCalls).toHaveLength(0);
    expect(ctx.ui.notifications.some((n) => n.message.includes("interactive terminal"))).toBe(true);
  });

  it("warns in rpc mode even with UI present", async () => {
    const mock = buildExtension();
    const ctx = createMockCtx(await makeTempDir(), true, "rpc");
    await mock.commands.get("weave-view")!.handler("tui", ctx);
    expect(ctx.ui.customCalls).toHaveLength(0);
    expect(ctx.ui.notifications.some((n) => n.message.includes("interactive terminal"))).toBe(true);
  });

  it("unknown arg → usage warning, nothing else", async () => {
    const mock = buildExtension();
    const ctx = createMockCtx(await makeTempDir());
    await mock.commands.get("weave-view")!.handler("nope", ctx);
    expect(ctx.ui.customCalls).toHaveLength(0);
    expect(mock.api.execCalls).toEqual([]);
    expect(ctx.ui.notifications.some((n) => n.message === "usage: /weave-view [tui]")).toBe(true);
  });

  it("/weave-view (no arg) runs the TUI just like 'tui' (browser viewer retired)", async () => {
    const vault = await makeTempDir();
    await withVaultEnv(vault, async () => {
      const mock = buildExtension();
      const ctx = createMockCtx(await makeTempDir()); // tui + hasUI
      const handlerPromise = mock.commands.get("weave-view")!.handler("", ctx);
      for (let i = 0; i < 50 && ctx.ui.customCalls.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
      expect(ctx.ui.customCalls).toHaveLength(1);
      ctx.ui.resolveCustom(null);
      await handlerPromise;
      // no HTTP server, no browser exec
      expect(mock.api.execCalls).toEqual([]);
    });
  });

  it("session_shutdown is a no-op — the TUI holds no session resources", async () => {
    const mock = buildExtension();
    const ctx = createMockCtx(await makeTempDir()); // tui + hasUI
    const handlerPromise = mock.commands.get("weave-view")!.handler("tui", ctx);
    for (let i = 0; i < 50 && ctx.ui.customCalls.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    ctx.ui.resolveCustom(null);
    await handlerPromise;
    await mock.emit("session_shutdown", {}, ctx);
    expect(mock.api.execCalls).toEqual([]);
  });
});