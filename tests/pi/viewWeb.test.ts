/**
 * `/weave-view` — the browser workspace, through the adapter
 * (weave-workspace §13, §5.4, §6).
 *
 * Two layers, deliberately:
 *
 *  - **The parser** ({@link parseWeaveViewArgs}) as a table. Eight command
 *    invocations to assert eight string parses would be eight temp
 *    directories and eight HTTP servers for no extra coverage.
 *  - **Everything else through the real command handler** and the mock pi
 *    harness, so what is asserted is what a user typing `/weave-view` gets:
 *    a real server on a real ephemeral port, the exact `exec` call the
 *    platform would make, and a `session_shutdown` that actually releases
 *    the port.
 *
 * ## No fixed ports, and every server is torn down
 *
 * `startWorkspaceServer` binds `listen(0)`; nothing here overrides it. Each
 * built extension registers its `session_shutdown` handler with
 * {@link track}, and `afterEach` fires all of them — a leaked server would
 * hold an SSE heartbeat and hang the run, which is the exact bug this task
 * exists to prevent.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import piWeave, { parseWeaveViewArgs, WEAVE_VIEW_USAGE } from "../../src/pi/index";
import {
  browserOpenCommand,
  createLivenessBridge,
  WebWorkspaceController,
} from "../../src/pi/viewer/web/run";
import { WorkspaceCache } from "../../src/core/cache/workspace";
import { graphStamp } from "../../src/web/server/routes";
import { SseHub } from "../../src/web/server/sse";
import type { ChangeEvent } from "../../src/web/shared/wire";
import { addNote } from "../../src/core/vault";
import { createMockCtx, createMockPi, makeTempDir, withVaultEnv, type MockCtx } from "../helpers";

/** Shutdown hooks for every extension a test built, fired in `afterEach`. */
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  const pending = cleanups.splice(0);
  for (const stop of pending) await stop();
});

function buildExtension() {
  const mock = createMockPi();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  piWeave(mock.api as any);
  return mock;
}

type Ext = ReturnType<typeof buildExtension>;

/** Build an extension whose server is guaranteed to be closed after the test. */
function track(ctx: MockCtx): Ext {
  const mock = buildExtension();
  cleanups.push(async () => {
    await mock.emit("session_shutdown", {}, ctx);
  });
  return mock;
}

async function view(mock: Ext, args: string, ctx: MockCtx): Promise<void> {
  await mock.commands.get("weave-view")!.handler(args, ctx);
}

/** The URL out of the "workspace running at …" notification. */
function urlFrom(ctx: MockCtx): string {
  const hit = ctx.ui.notifications.find((n) => n.message.includes("workspace"));
  const match = /(http:\/\/127\.0\.0\.1:\d+\/\?t=[^\s]+)/.exec(hit?.message ?? "");
  if (match === null) throw new Error(`no URL in notifications: ${JSON.stringify(ctx.ui.notifications)}`);
  return match[1]!;
}

// ---------------------------------------------------------------------------
// Argument parsing (§13)
// ---------------------------------------------------------------------------

describe("parseWeaveViewArgs", () => {
  it.each([
    ["", { surface: "web", open: true }],
    ["   ", { surface: "web", open: true }],
    ["web", { surface: "web", open: true }],
    ["WEB", { surface: "web", open: true }],
    ["tui", { surface: "tui", open: true }],
    ["  TUI  ", { surface: "tui", open: true }],
    ["--no-open", { surface: "web", open: false }],
    ["web --no-open", { surface: "web", open: false }],
    ["--no-open web", { surface: "web", open: false }],
    ["web    --no-open", { surface: "web", open: false }],
  ])("%o parses", (args, expected) => {
    expect(parseWeaveViewArgs(args as string)).toEqual(expected);
  });

  it.each([
    ["nope"],
    ["web tui"],
    ["tui tui"],
    ["tui --no-open"], // the TUI never opens a browser; ignoring the flag would be a lie
    ["--no-open --no-open"],
    ["web --noopen"],
    ["web extra"],
  ])("%o is rejected", (args) => {
    expect(parseWeaveViewArgs(args as string)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The browser opener
// ---------------------------------------------------------------------------

describe("browserOpenCommand", () => {
  it("maps each platform to its opener", () => {
    expect(browserOpenCommand("http://x/", "darwin")).toEqual({ command: "open", args: ["http://x/"] });
    expect(browserOpenCommand("http://x/", "linux")).toEqual({ command: "xdg-open", args: ["http://x/"] });
    expect(browserOpenCommand("http://x/", "win32")).toEqual({
      // The empty string is `start`'s title argument — without it the URL is
      // consumed as the window title and nothing opens.
      command: "cmd",
      args: ["/c", "start", "", "http://x/"],
    });
  });

  it("defaults to the host platform rather than throwing", () => {
    const { command, args } = browserOpenCommand("http://x/");
    expect(typeof command).toBe("string");
    expect(args).toContain("http://x/");
  });

  it("ignores $EDITOR — a URL is not a file", async () => {
    const before = process.env.EDITOR;
    process.env.EDITOR = "vim";
    try {
      expect(browserOpenCommand("http://x/", "darwin").command).toBe("open");
    } finally {
      if (before === undefined) delete process.env.EDITOR;
      else process.env.EDITOR = before;
    }
  });
});

// ---------------------------------------------------------------------------
// The default surface (§13): bare /weave-view is the browser
// ---------------------------------------------------------------------------

describe("/weave-view (bare) — browser workspace by default", () => {
  it("starts the server, opens the browser, and notifies the URL", async () => {
    const vault = await makeTempDir();
    await withVaultEnv(vault, async () => {
      const ctx = createMockCtx(await makeTempDir());
      const mock = track(ctx);

      await view(mock, "", ctx);

      // One browser launch, at the tokenised entry URL.
      expect(mock.api.execCalls).toHaveLength(1);
      const call = mock.api.execCalls[0]!;
      const url = (call.args as string[]).find((a) => a.startsWith("http://")) ?? "";
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=/);
      // Never a fixed port.
      expect(new URL(url).port).not.toBe("");

      expect(ctx.ui.notifications.some((n) => n.message.includes("opened in your browser"))).toBe(true);
      expect(urlFrom(ctx)).toBe(url);

      // No TUI: the browser handled it.
      expect(ctx.ui.customCalls).toHaveLength(0);
    });
  });

  it("serves the real graph over the bound port", async () => {
    const vault = await makeTempDir();
    await withVaultEnv(vault, async () => {
      await addNote(vault, { title: "Alpha", body: "hello", source: "human" });
      const ctx = createMockCtx(await makeTempDir());
      const mock = track(ctx);
      await view(mock, "--no-open", ctx);

      const entry = new URL(urlFrom(ctx));
      const token = entry.searchParams.get("t")!;
      const res = await fetch(`${entry.origin}/api/graph`, { headers: { cookie: `__Host-weave=${token}` } });
      expect(res.status).toBe(200);
      const payload = (await res.json()) as { model: { nodes: { label: string }[] } };
      expect(payload.model.nodes.some((n) => n.label === "Alpha")).toBe(true);
    });
  });

  it("'web' is an alias of the bare form", async () => {
    const vault = await makeTempDir();
    await withVaultEnv(vault, async () => {
      const ctx = createMockCtx(await makeTempDir());
      const mock = track(ctx);
      await view(mock, "web", ctx);
      expect(mock.api.execCalls).toHaveLength(1);
      expect(ctx.ui.customCalls).toHaveLength(0);
    });
  });

  it("appends a `· web:PORT` marker to the status line without losing the indicator", async () => {
    const vault = await makeTempDir();
    await withVaultEnv(vault, async () => {
      const ctx = createMockCtx(await makeTempDir());
      const mock = track(ctx);
      // session_start seeds the base status text the marker is appended to.
      await mock.emit("session_start", {}, ctx);
      expect(ctx.ui.statuses["weave"]).toMatch(/^○ 🧵 vault:/);

      await view(mock, "--no-open", ctx);
      const port = new URL(urlFrom(ctx)).port;
      expect(ctx.ui.statuses["weave"]).toMatch(new RegExp(`^○ 🧵 vault:.* · web:${port}$`));

      // The active indicator still flips, and keeps the marker.
      await mock.emit("agent_start", {}, ctx);
      expect(ctx.ui.statuses["weave"]).toMatch(new RegExp(`^● .* · web:${port}$`));
      await mock.emit("agent_end", {}, ctx);
      expect(ctx.ui.statuses["weave"]).toMatch(new RegExp(`^○ .* · web:${port}$`));
    });
  });

  it("advertises a running server even with no base status text", async () => {
    // The regression this pins: `updateStatus` used to early-return
    // `setStatus("weave", undefined)` whenever `lastStatusText` was empty,
    // *before* it looked up the port. So a workspace started in a session
    // that never emitted `session_start` did not just miss the marker — it
    // cleared the status line while a server was listening on a real port,
    // which is the one thing the marker exists to prevent.
    const vault = await makeTempDir();
    await withVaultEnv(vault, async () => {
      const ctx = createMockCtx(await makeTempDir());
      const mock = track(ctx);
      // Deliberately no `session_start`.
      await view(mock, "--no-open", ctx);

      const port = new URL(urlFrom(ctx)).port;
      // Marker stands alone, with the indicator and no orphaned ` · `.
      expect(ctx.ui.statuses["weave"]).toBe(`○ web:${port}`);

      // And the indicator still flips, exactly as it does with base text.
      await mock.emit("agent_start", {}, ctx);
      expect(ctx.ui.statuses["weave"]).toBe(`● web:${port}`);
      await mock.emit("agent_end", {}, ctx);
      expect(ctx.ui.statuses["weave"]).toBe(`○ web:${port}`);
    });
  });

  it("clears the status line only when there is no text and no server", async () => {
    // The other half of the contract: the fix must not turn "nothing to
    // show" into a permanently-pinned empty indicator.
    const vault = await makeTempDir();
    await withVaultEnv(vault, async () => {
      const ctx = createMockCtx(await makeTempDir());
      const mock = buildExtension();
      await view(mock, "--no-open", ctx);
      expect(ctx.ui.statuses["weave"]).toContain("web:");

      await mock.emit("session_shutdown", {}, ctx);
      // No base text was ever seeded and the server is gone, so the slot is
      // cleared outright rather than left showing a dead port.
      expect(ctx.ui.statuses["weave"]).toBeUndefined();
    });
  });

  it("drops the marker once the workspace is shut down", async () => {
    const vault = await makeTempDir();
    await withVaultEnv(vault, async () => {
      const ctx = createMockCtx(await makeTempDir());
      const mock = buildExtension();
      await mock.emit("session_start", {}, ctx);
      await view(mock, "--no-open", ctx);
      expect(ctx.ui.statuses["weave"]).toContain("· web:");

      await mock.emit("session_shutdown", {}, ctx);
      expect(ctx.ui.statuses["weave"]).not.toContain("· web:");
    });
  });
});

// ---------------------------------------------------------------------------
// --no-open
// ---------------------------------------------------------------------------

describe("/weave-view web --no-open", () => {
  it("starts the server and notifies the URL, launching nothing", async () => {
    const vault = await makeTempDir();
    await withVaultEnv(vault, async () => {
      const ctx = createMockCtx(await makeTempDir());
      const mock = track(ctx);

      await view(mock, "web --no-open", ctx);

      expect(mock.api.execCalls).toEqual([]);
      expect(ctx.ui.customCalls).toHaveLength(0);
      expect(urlFrom(ctx)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=/);
      expect(ctx.ui.notifications.some((n) => n.message.includes("open it in a browser"))).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// The TUI path stays untouched
// ---------------------------------------------------------------------------

describe("/weave-view tui", () => {
  it("opens the explorer and starts no server", async () => {
    const vault = await makeTempDir();
    await withVaultEnv(vault, async () => {
      const ctx = createMockCtx(await makeTempDir());
      const mock = buildExtension();

      const handler = view(mock, "tui", ctx);
      for (let i = 0; i < 100 && ctx.ui.customCalls.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      ctx.ui.resolveCustom(null);
      await handler;

      expect(ctx.ui.customCalls).toHaveLength(1);
      expect(mock.api.execCalls).toEqual([]);
      // No `web:` marker: nothing was started.
      expect(ctx.ui.statuses["weave"]).not.toContain("web:");
      // And shutdown remains a no-op for this path.
      await mock.emit("session_shutdown", {}, ctx);
    });
  });
});

// ---------------------------------------------------------------------------
// Bad arguments
// ---------------------------------------------------------------------------

describe("/weave-view <garbage>", () => {
  it("warns with the usage line and starts nothing", async () => {
    const ctx = createMockCtx(await makeTempDir());
    const mock = buildExtension();
    await view(mock, "nope", ctx);
    expect(ctx.ui.notifications).toEqual([{ message: WEAVE_VIEW_USAGE, level: "warning" }]);
    expect(mock.api.execCalls).toEqual([]);
    expect(ctx.ui.customCalls).toHaveLength(0);
    expect(ctx.ui.statuses["weave"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Singleton (§5.4)
// ---------------------------------------------------------------------------

describe("singleton per session", () => {
  it("a second /weave-view reuses the running server", async () => {
    const vault = await makeTempDir();
    await withVaultEnv(vault, async () => {
      const ctx = createMockCtx(await makeTempDir());
      const mock = track(ctx);

      await view(mock, "", ctx);
      const first = urlFrom(ctx);
      expect(ctx.ui.notifications.some((n) => n.message.includes("workspace running at"))).toBe(true);

      await view(mock, "", ctx);
      // Same port, same token — not a second boot.
      expect(urlFrom(ctx)).toBe(first);
      expect(ctx.ui.notifications.some((n) => n.message.includes("already running at"))).toBe(true);
      // But the browser is re-opened, which is the point of asking twice.
      expect(mock.api.execCalls).toHaveLength(2);
    });
  });

  it("two concurrent invocations still boot exactly one server", async () => {
    const vault = await makeTempDir();
    await withVaultEnv(vault, async () => {
      const ctx = createMockCtx(await makeTempDir());
      const mock = track(ctx);

      await Promise.all([view(mock, "--no-open", ctx), view(mock, "--no-open", ctx)]);

      const urls = ctx.ui.notifications
        .map((n) => /(http:\/\/127\.0\.0\.1:\d+)/.exec(n.message)?.[1])
        .filter((u): u is string => u !== undefined);
      expect(urls).toHaveLength(2);
      expect(new Set(urls).size).toBe(1);
    });
  });

  it("boots a fresh server after an explicit shutdown", async () => {
    const vault = await makeTempDir();
    await withVaultEnv(vault, async () => {
      const ctx = createMockCtx(await makeTempDir());
      const mock = track(ctx);

      await view(mock, "--no-open", ctx);
      const first = new URL(urlFrom(ctx)).port;
      await mock.emit("session_shutdown", {}, ctx);

      ctx.ui.notifications.length = 0;
      await view(mock, "--no-open", ctx);
      const second = new URL(urlFrom(ctx)).port;
      expect(second).not.toBe(first);
      expect(ctx.ui.notifications.some((n) => n.message.includes("workspace running at"))).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Lifecycle (§5.4)
// ---------------------------------------------------------------------------

describe("session_shutdown", () => {
  it("closes the server, the watcher and the SSE hub, releasing the port", async () => {
    const vault = await makeTempDir();
    await withVaultEnv(vault, async () => {
      const ctx = createMockCtx(await makeTempDir());
      const mock = buildExtension();
      await view(mock, "--no-open", ctx);

      const entry = new URL(urlFrom(ctx));
      const token = entry.searchParams.get("t")!;
      const alive = await fetch(`${entry.origin}/api/graph`, { headers: { cookie: `__Host-weave=${token}` } });
      expect(alive.status).toBe(200);
      await alive.json();

      await mock.emit("session_shutdown", {}, ctx);

      // The port is genuinely released: a fetch now fails to connect.
      await expect(
        fetch(`${entry.origin}/api/graph`, { headers: { cookie: `__Host-weave=${token}` } }),
      ).rejects.toThrow();
    });
  });

  it("is idempotent and safe with no workspace ever started", async () => {
    const ctx = createMockCtx(await makeTempDir());
    const mock = buildExtension();
    await mock.emit("session_shutdown", {}, ctx);
    await mock.emit("session_shutdown", {}, ctx);
    expect(mock.api.execCalls).toEqual([]);
  });

  it("closes a workspace whose boot was still in flight", async () => {
    const vault = await makeTempDir();
    await withVaultEnv(vault, async () => {
      const ctx = createMockCtx(await makeTempDir());
      const mock = buildExtension();
      const booting = view(mock, "--no-open", ctx);
      // Shutdown racing a slow boot must still release what the boot produced.
      const stopping = mock.emit("session_shutdown", {}, ctx);
      await Promise.all([booting, stopping]);

      const entry = new URL(urlFrom(ctx));
      await expect(fetch(`${entry.origin}/api/graph`)).rejects.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// Headless / no-UI (Step 4)
// ---------------------------------------------------------------------------

describe("no UI (--mode rpc, headless)", () => {
  it("still starts the server and prints the URL, but launches no browser", async () => {
    const vault = await makeTempDir();
    await withVaultEnv(vault, async () => {
      // hasUI=false: there is no desktop on this side of the connection, so
      // spawning `xdg-open` would either fail or open a window nobody sees.
      // The server is still worth starting — it is reachable over a port
      // forward, which is the whole point.
      const ctx = createMockCtx(await makeTempDir(), false, "rpc");
      const mock = track(ctx);

      await view(mock, "", ctx);

      expect(mock.api.execCalls).toEqual([]);
      expect(ctx.ui.customCalls).toHaveLength(0);
      expect(urlFrom(ctx)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=/);
      // Never the "could not launch" wording: nothing was attempted.
      expect(ctx.ui.notifications.some((n) => n.message.includes("could not launch"))).toBe(false);
    });
  });

  it("does not fall back to the TUI in rpc mode", async () => {
    const vault = await makeTempDir();
    await withVaultEnv(vault, async () => {
      const ctx = createMockCtx(await makeTempDir(), false, "rpc");
      const mock = track(ctx);
      await view(mock, "", ctx);
      // The TUI needs a terminal it does not have; the URL is the answer.
      expect(ctx.ui.customCalls).toHaveLength(0);
      expect(
        ctx.ui.notifications.some((n) => n.message.includes("needs an interactive terminal")),
      ).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Browser-launch failure (§13 fallback)
// ---------------------------------------------------------------------------

describe("browser launch failure", () => {
  /** A controller wired to a temp workspace, with an `exec` the test controls. */
  async function controllerOver(
    exec: (command: string, args: string[]) => Promise<{ code: number; stderr: string }>,
  ): Promise<{ controller: WebWorkspaceController; ctx: MockCtx }> {
    const vaultRoot = await makeTempDir();
    const ctx = createMockCtx(await makeTempDir());
    const controller = new WebWorkspaceController({ exec, vaultRoot: () => vaultRoot });
    cleanups.push(() => controller.close());
    return { controller, ctx };
  }

  it("a non-zero exit leaves the server up and reports the fallback", async () => {
    const { controller, ctx } = await controllerOver(async () => ({ code: 1, stderr: "no display" }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const outcome = await controller.run(ctx as any, { open: true });
    expect(outcome.opened).toBe(false);
    expect(outcome.fallbackToTui).toBe(true);
    expect(outcome.started).toBe(true);
    expect(controller.port()).not.toBeNull();
    expect(ctx.ui.notifications.some((n) => n.message.includes("could not launch a browser"))).toBe(true);
    expect(urlFrom(ctx)).toContain(`:${controller.port()}/`);
  });

  it("a throwing exec (no such binary) is a fallback, not a crash", async () => {
    const { controller, ctx } = await controllerOver(async () => {
      throw new Error("spawn xdg-open ENOENT");
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const outcome = await controller.run(ctx as any, { open: true });
    expect(outcome.opened).toBe(false);
    expect(outcome.fallbackToTui).toBe(true);
    expect(controller.port()).not.toBeNull();
  });

  it("falls back to the TUI through the command when the browser will not open", async () => {
    const vault = await makeTempDir();
    await withVaultEnv(vault, async () => {
      const ctx = createMockCtx(await makeTempDir()); // tui + hasUI
      const mock = track(ctx);
      // Make every exec fail, as a machine with no opener would.
      mock.api.exec = async (command: string, args: string[]) => {
        mock.api.execCalls.push({ name: command, args });
        return { code: 127, stdout: "", stderr: "command not found" };
      };

      const handler = view(mock, "", ctx);
      for (let i = 0; i < 200 && ctx.ui.customCalls.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(ctx.ui.customCalls).toHaveLength(1);
      ctx.ui.resolveCustom(null);
      await handler;

      // The browser was attempted, the server stayed up, and the status line
      // still advertises it after the TUI wrote its own line on close.
      expect(mock.api.execCalls).toHaveLength(1);

      // The port is advertised, and the assertion is on the *port* rather
      // than on the ` · ` separator. This test never emits `session_start`,
      // so there is no base status text for a separator to separate from and
      // the line is `○ web:PORT`, not `○ 🧵 vault:N · web:PORT`. Requiring
      // the separator here was requiring a leading ` · ` against nothing.
      //
      // Strengthened rather than relaxed: it now pins the real port, so a
      // regression that printed a stale or placeholder port fails too — and
      // the previous bug (the status line being cleared outright while a
      // server was listening) is caught by `toBeTruthy` before the match.
      const status = ctx.ui.statuses["weave"];
      expect(status).toBeTruthy();
      expect(status).toMatch(/\bweb:\d+$/);
      expect(status).toContain(`web:${new URL(urlFrom(ctx)).port}`);

      expect(ctx.ui.notifications.some((n) => n.message.includes("could not launch a browser"))).toBe(true);
    });
  });

  it("uses the injected open command", async () => {
    const calls: { command: string; args: string[] }[] = [];
    const vaultRoot = await makeTempDir();
    const ctx = createMockCtx(await makeTempDir());
    const controller = new WebWorkspaceController({
      exec: async (command, args) => {
        calls.push({ command, args });
        return { code: 0, stderr: "" };
      },
      openCommand: (url) => ({ command: "my-browser", args: ["--url", url] }),
      vaultRoot: () => vaultRoot,
    });
    cleanups.push(() => controller.close());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const outcome = await controller.run(ctx as any, { open: true });
    expect(outcome.opened).toBe(true);
    expect(calls).toEqual([{ command: "my-browser", args: ["--url", outcome.session.server.entryUrl] }]);
  });
});

// ---------------------------------------------------------------------------
// Controller internals worth asserting directly
// ---------------------------------------------------------------------------

describe("WebWorkspaceController", () => {
  it("reports no port before boot and after close", async () => {
    const vaultRoot = await makeTempDir();
    const ctx = createMockCtx(await makeTempDir());
    const controller = new WebWorkspaceController({
      exec: async () => ({ code: 0, stderr: "" }),
      vaultRoot: () => vaultRoot,
    });
    cleanups.push(() => controller.close());

    expect(controller.port()).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await controller.run(ctx as any, { open: false });
    expect(controller.port()).toBeGreaterThan(0);
    await controller.close();
    expect(controller.port()).toBeNull();
    await controller.close(); // idempotent
    expect(controller.port()).toBeNull();
  });

  it("clears the slot when the server shuts itself down for idleness (§5.4)", async () => {
    const vaultRoot = await makeTempDir();
    const ctx = createMockCtx(await makeTempDir());
    let stateChanges = 0;
    let fire: (() => void) | null = null;
    const controller = new WebWorkspaceController({
      exec: async () => ({ code: 0, stderr: "" }),
      vaultRoot: () => vaultRoot,
      onStateChange: () => {
        stateChanges += 1;
      },
      // Capture the idle timer instead of waiting 30 minutes for it.
      startServer: async (opts) => {
        const { startWorkspaceServer } = await import("../../src/web/server/server");
        return startWorkspaceServer({
          ...opts,
          setTimer: (fn) => {
            fire = fn;
            return {};
          },
          clearTimer: () => {},
          idleMs: 1,
        });
      },
    });
    cleanups.push(() => controller.close());

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await controller.run(ctx as any, { open: false });
    expect(controller.port()).toBeGreaterThan(0);
    const afterBoot = stateChanges;

    expect(fire).not.toBeNull();
    fire!();
    // The shutdown is async inside the timer; let it settle.
    for (let i = 0; i < 100 && controller.port() !== null; i++) await new Promise((r) => setTimeout(r, 5));

    expect(controller.port()).toBeNull();
    expect(stateChanges).toBeGreaterThan(afterBoot);
  });

  it("honours PI_WEAVE_VAULT when no vaultRoot is injected", async () => {
    const vault = await makeTempDir();
    await withVaultEnv(vault, async () => {
      await addNote(vault, { title: "Env Note", body: "x", source: "human" });
      const ctx = createMockCtx(await makeTempDir());
      const controller = new WebWorkspaceController({ exec: async () => ({ code: 0, stderr: "" }) });
      cleanups.push(() => controller.close());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const outcome = await controller.run(ctx as any, { open: false });
      const model = await outcome.session.cache.graph();
      expect(model.nodes.some((n) => n.label === "Env Note")).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// The liveness bridge (§6)
// ---------------------------------------------------------------------------

describe("createLivenessBridge", () => {
  /** A hub double that records broadcasts instead of writing to sockets. */
  function recordingHub(): { hub: SseHub; sent: ChangeEvent[] } {
    const sent: ChangeEvent[] = [];
    const hub = new SseHub();
    hub.broadcast = (event: ChangeEvent) => {
      sent.push(event);
    };
    return { hub, sent };
  }

  it("invalidates per path and broadcasts one frame per scope", async () => {
    const vaultRoot = await makeTempDir();
    const cwd = await makeTempDir();
    await addNote(vaultRoot, { title: "Live", body: "one", source: "human" });
    const cache = new WorkspaceCache({ cwd, vaultRoot });
    const { hub, sent } = recordingHub();
    const bridge = createLivenessBridge(cache, hub);

    // Nothing broadcast yet, so a fresh client is told nothing.
    expect(bridge.currentStamp()).toBeNull();

    bridge.onPath(join(vaultRoot, "notes", "live.md"));
    bridge.onChange(["vault", "repo"]);
    await bridge.settled();

    expect(sent).toHaveLength(2);
    expect(sent.map((e) => e.scope)).toEqual(["vault", "repo"]);
    expect(new Set(sent.map((e) => e.stamp)).size).toBe(1);
    // And a client attaching now is handed that stamp.
    expect(bridge.currentStamp()).toBe(sent[0]!.stamp);
  });

  it("broadcasts the same content digest the ETag carries (§6, §15.6)", async () => {
    // The half of §15.6 that lived outside the HTTP layer. The client dedupes
    // frames on `stamp` and already holds the stamp of the graph it last
    // fetched, so while this broadcast `generatedAt`, an edit that did not
    // advance the timestamp maximum produced a frame the client discarded
    // *before* it ever issued the conditional GET. One shared key, one
    // meaning.
    const vaultRoot = await makeTempDir();
    const cwd = await makeTempDir();
    await addNote(vaultRoot, { title: "Live", body: "one", tags: ["before"], source: "human" });
    const cache = new WorkspaceCache({ cwd, vaultRoot });
    const { hub, sent } = recordingHub();
    const bridge = createLivenessBridge(cache, hub);

    bridge.onChange(["vault"]);
    await bridge.settled();
    const firstStamp = sent.at(-1)!.stamp;
    // It is the digest the route would serve, not the data-as-of timestamp.
    expect(firstStamp).toBe(graphStamp(await cache.snapshot()));
    expect(firstStamp).not.toBe((await cache.snapshot()).model.generatedAt);

    // A tag edit that leaves `updated` alone — case 2, at the SSE layer.
    const file = join(vaultRoot, "notes", "live.md");
    const original = await readFile(file, "utf8");
    await writeFile(file, original.replace("tags: [before]", "tags: [afterwards]"), "utf8");
    cache.invalidateAll();

    bridge.onChange(["vault"]);
    await bridge.settled();
    const secondStamp = sent.at(-1)!.stamp;

    // The frame carries a *new* stamp, so the client cannot dedupe it away.
    expect(secondStamp).not.toBe(firstStamp);
    expect(secondStamp).toBe(graphStamp(await cache.snapshot()));
  });

  it("swallows a rebuild failure — one missed frame, not an unhandled rejection", async () => {
    const vaultRoot = await makeTempDir();
    const cwd = await makeTempDir();
    const cache = new WorkspaceCache({ cwd, vaultRoot });
    // `snapshot()`, not `graph()`: the bridge needs the notes as well as the
    // model, because the stamp it broadcasts is the digest of the whole
    // payload and `tags` is derived from the notes (§4.3, §15.6).
    cache.snapshot = async () => {
      throw new Error("vault vanished");
    };
    const { hub, sent } = recordingHub();
    const bridge = createLivenessBridge(cache, hub);

    bridge.onChange(["vault"]);
    await bridge.settled();

    expect(sent).toEqual([]);
    expect(bridge.currentStamp()).toBeNull();
  });

  it("serializes overlapping windows so the stamp is the last one built", async () => {
    const vaultRoot = await makeTempDir();
    const cwd = await makeTempDir();
    const cache = new WorkspaceCache({ cwd, vaultRoot });
    const { hub, sent } = recordingHub();
    const bridge = createLivenessBridge(cache, hub);

    bridge.onChange(["vault"]);
    bridge.onChange(["git"]);
    await bridge.settled();

    expect(sent.map((e) => e.scope)).toEqual(["vault", "git"]);
  });
});

// ---------------------------------------------------------------------------
// The watcher is really attached (§6 end-to-end)
// ---------------------------------------------------------------------------

describe("liveness, end to end", () => {
  it("a note written on disk reaches the running server's graph", async () => {
    const vault = await makeTempDir();
    await withVaultEnv(vault, async () => {
      await addNote(vault, { title: "First", body: "a", source: "human" });
      const ctx = createMockCtx(await makeTempDir());
      const mock = track(ctx);
      await view(mock, "--no-open", ctx);

      const entry = new URL(urlFrom(ctx));
      const token = entry.searchParams.get("t")!;
      const headers = { cookie: `__Host-weave=${token}` };

      await addNote(vault, { title: "Second", body: "b", source: "human" });
      // The watcher's 80 ms debounce plus a rebuild; poll rather than sleep.
      let labels: string[] = [];
      for (let i = 0; i < 100; i++) {
        const res = await fetch(`${entry.origin}/api/graph`, { headers });
        const payload = (await res.json()) as { model: { nodes: { label: string }[] } };
        labels = payload.model.nodes.map((n) => n.label);
        if (labels.includes("Second")) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(labels).toContain("Second");
    });
  });

  it("serves .okf content from the repository half", async () => {
    const vault = await makeTempDir();
    await withVaultEnv(vault, async () => {
      const cwd = await makeTempDir();
      await mkdir(join(cwd, ".okf", "repository"), { recursive: true });
      await writeFile(join(cwd, ".okf", "repository", "git.json"), '{"branch":"main"}', "utf8");

      const ctx = createMockCtx(cwd);
      const mock = track(ctx);
      await view(mock, "--no-open", ctx);

      const entry = new URL(urlFrom(ctx));
      const token = entry.searchParams.get("t")!;
      const res = await fetch(`${entry.origin}/api/okf/repository/git.json`, {
        headers: { cookie: `__Host-weave=${token}` },
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { body: string }).body).toContain("main");
    });
  });
});
