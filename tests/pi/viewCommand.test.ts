import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import piWeave from "../../src/pi/index";
import { readOkfFileForView } from "../../src/pi/viewer/server";
import type { GraphModel } from "../../src/core/graph/model";
import { createMockCtx, createMockPi, makeTempDir } from "../helpers";

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
    // cleanup: shut down even though nothing started — must not throw
    await mock.emit("session_shutdown", {}, createMockCtx(await makeTempDir()));
  });

  it("starts the server lazily, opens the browser, and reuses the server on repeat", async () => {
    const mock = buildExtension();
    const ctx = createMockCtx(await makeTempDir()); // tui + hasUI
    try {
      await mock.commands.get("weave-view")!.handler("", ctx);
      const url1 = ctx.ui.notifications[0]?.message.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      expect(url1).toBeTruthy();
      expect(mock.api.execCalls).toHaveLength(1);
      expect(mock.api.execCalls[0]?.args).toEqual([url1]);

      // Server actually answers.
      const res = await fetch(`${url1}/graph.json`);
      const graph = (await res.json()) as GraphModel;
      expect(graph.nodes.some((n) => n.id === "vault")).toBe(true);

      // Repeat: same server, reopens the browser (same URL).
      await mock.commands.get("weave-view")!.handler("", ctx);
      const url2 = ctx.ui.notifications[1]?.message.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      expect(url2).toBe(url1);
      expect(mock.api.execCalls).toHaveLength(2);
    } finally {
      await mock.emit("session_shutdown", {}, ctx);
    }
  });

  it("session_shutdown closes the port (connect afterwards is refused)", async () => {
    const mock = buildExtension();
    const ctx = createMockCtx(await makeTempDir());
    await mock.commands.get("weave-view")!.handler("", ctx);
    const url = ctx.ui.notifications[0]?.message.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    expect(url).toBeTruthy();
    await mock.emit("session_shutdown", {}, ctx);
    await expect(fetch(`${url}/`)).rejects.toThrow();

    // After shutdown, a fresh invocation starts a NEW server (possibly a new port).
    await mock.commands.get("weave-view")!.handler("", ctx);
    const url2 = ctx.ui.notifications[1]?.message.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    expect(url2).toBeTruthy();
    const res = await fetch(`${url2}/graph.json`);
    expect(res.status).toBe(200);
    await mock.emit("session_shutdown", {}, ctx);
  });

  it("does not open a browser without UI (print/json modes) but still reports the URL", async () => {
    const mock = buildExtension();
    const ctx = createMockCtx(await makeTempDir(), /* hasUI */ false, "print");
    try {
      await mock.commands.get("weave-view")!.handler("", ctx);
      expect(mock.api.execCalls).toEqual([]);
      expect(ctx.ui.notifications[0]?.message).toContain("http://127.0.0.1:");
    } finally {
      await mock.emit("session_shutdown", {}, ctx);
    }
  });

  it("does not open a browser in rpc mode even with UI present", async () => {
    const mock = buildExtension();
    const ctx = createMockCtx(await makeTempDir(), /* hasUI */ true, "rpc");
    try {
      await mock.commands.get("weave-view")!.handler("", ctx);
      expect(mock.api.execCalls).toEqual([]);
    } finally {
      await mock.emit("session_shutdown", {}, ctx);
    }
  });

  it("respects PI_WEAVE_VIEW_NO_OPEN=1", async () => {
    const before = process.env.PI_WEAVE_VIEW_NO_OPEN;
    process.env.PI_WEAVE_VIEW_NO_OPEN = "1";
    const mock = buildExtension();
    const ctx = createMockCtx(await makeTempDir());
    try {
      await mock.commands.get("weave-view")!.handler("", ctx);
      expect(mock.api.execCalls).toEqual([]);
    } finally {
      if (before === undefined) delete process.env.PI_WEAVE_VIEW_NO_OPEN;
      else process.env.PI_WEAVE_VIEW_NO_OPEN = before;
      await mock.emit("session_shutdown", {}, ctx);
    }
  });

  it("serves a derived .okf file body and rejects traversal/missing paths", async () => {
    const repo = await makeTempDir();
    await mkdir(join(repo, ".okf", "repository", "summaries"), { recursive: true });
    await writeFile(join(repo, ".okf", "repository", "summaries", "a.md"), "# summary\n\nhello", "utf8");
    const mock = buildExtension();
    const ctx = createMockCtx(repo);
    try {
      await mock.commands.get("weave-view")!.handler("", ctx);
      const url = ctx.ui.notifications[0]?.message.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      expect(url).toBeTruthy();

      const ok = await fetch(`${url}/okffile/${encodeURIComponent("repository/summaries/a.md")}`);
      expect(ok.status).toBe(200);
      expect((await ok.json()).body).toContain("hello");

      const missing = await fetch(`${url}/okffile/${encodeURIComponent("nope.md")}`);
      expect(missing.status).toBe(404);

      const traversal = await fetch(`${url}/okffile/${encodeURIComponent("../../package.json")}`);
      expect(traversal.status).toBe(404);
    } finally {
      await mock.emit("session_shutdown", {}, ctx);
    }
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
