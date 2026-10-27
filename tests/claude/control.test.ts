import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { callControl, controlSocketPath, serveControl } from "../../src/claude/control";
import { main } from "../../src/claude/index";
import { PassThrough } from "node:stream";
import { makeTempDir } from "../helpers";

async function socketIn() {
  const path = controlSocketPath(`s-${Math.random()}`, await makeTempDir());
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

describe("control socket", () => {
  it("keeps the socket path short and stable per session", () => {
    const path = controlSocketPath("3f1e6f1c-8c45-4a37-9a4e-0f1c2b3d4e5f", "/var/folders/ab/cdefghijklmnopqrstuvwxyz0123456789/T");
    expect(path).toBe(controlSocketPath("3f1e6f1c-8c45-4a37-9a4e-0f1c2b3d4e5f", "/var/folders/ab/cdefghijklmnopqrstuvwxyz0123456789/T"));
    expect(path.length).toBeLessThan(100);
    expect(path).not.toBe(controlSocketPath("other", "/var/folders/ab/cdefghijklmnopqrstuvwxyz0123456789/T"));
  });

  it("runs a command through the handler and reports its failures", async () => {
    const path = await socketIn();
    const server = await serveControl(path, async (name, args) => {
      if (name === "boom") throw new Error("nope");
      return `${name}:${args}`;
    });
    expect(await callControl(path, "weave-view", "--no-open")).toBe("weave-view:--no-open");
    expect(await callControl(path, "boom", "")).toBe("pi-weave: nope");
    await server.close();
    expect(await callControl(path, "weave", "")).toBeNull();
  });

  it("replaces a stale socket and answers nothing for garbage", async () => {
    const path = await socketIn();
    const first = await serveControl(path, async () => "one");
    const second = await serveControl(path, async () => "two");
    expect(await callControl(path, "weave", "")).toBe("two");
    await second.close();
    await first.close();
  });

  it("does not fall back to the model once a command is running", async () => {
    const path = await socketIn();
    const hung = createServer((socket) => { socket.resume(); socket.on("error", () => {}); });
    await new Promise<void>((resolve) => hung.listen(path, resolve));
    expect(await callControl(path, "weave-scan", "", 50)).toMatch(/still working/);
    await new Promise((resolve) => hung.close(resolve));
  });

  it("treats a malformed reply as unanswered", async () => {
    const path = await socketIn();
    const bad = createServer((socket) => { socket.resume(); socket.on("error", () => {}); socket.end("not json\n"); });
    await new Promise<void>((resolve) => bad.listen(path, resolve));
    expect(await callControl(path, "weave", "")).toBeNull();
    await new Promise((resolve) => bad.close(resolve));
  });
});

describe("prompt-submit hook", () => {
  async function hook(prompt: string, sessionId = "sess", env: NodeJS.ProcessEnv = {}) {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.on("data", (chunk) => { text += String(chunk); });
    input.end(JSON.stringify({ prompt, session_id: sessionId }));
    await main(["prompt-submit"], { stdin: input, stdout: output, env, cwd: "/", version: "1" });
    return text;
  }

  it("answers /weave commands from the session's server and ignores everything else", async () => {
    const sessionId = `hook-${Math.random()}`;
    const path = controlSocketPath(sessionId);
    const server = await serveControl(path, async (name, args) => `ran ${name} [${args}]`);
    try {
      expect(JSON.parse(await hook("/pi-weave:weave-view --no-open", sessionId))).toEqual({ continue: false, stopReason: "ran weave-view [--no-open]" });
      expect(JSON.parse(await hook("/weave", sessionId))).toEqual({ continue: false, stopReason: "ran weave []" });
      expect(JSON.parse(await hook("/weave-scan sessions", sessionId)).stopReason).toBe("ran weave-scan [sessions]");
      expect(await hook("/weaver", sessionId)).toBe("");
      expect(await hook("tell me about /weave", sessionId)).toBe("");
      expect(await hook("/weave", sessionId, { PI_WEAVE_NESTED: "1" })).toBe("");
      expect(await hook("/weave", "no-such-session")).toBe("");
    } finally {
      await server.close();
    }
  });
});
