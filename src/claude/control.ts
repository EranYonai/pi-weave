import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A per-session control socket, so a hook can run a slash command without a
 * model turn. The MCP process owns the browser workspace, so the hook asks
 * that process to run the command. The protocol is one JSON line each way:
 * `{name, args}` in, `{text}` or `{error}` out.
 */

export type ControlHandler = (name: string, args: string) => Promise<string>;

/** Short on purpose: unix socket paths top out near 104 bytes on macOS. */
export function controlSocketPath(sessionId: string, tmp = tmpdir(), uid = process.getuid?.() ?? 0): string {
  return join(tmp, `pw-${uid}`, `${createHash("sha1").update(sessionId).digest("hex").slice(0, 12)}.sock`);
}

export async function serveControl(path: string, handler: ControlHandler): Promise<{ close(): Promise<void> }> {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  // A socket left by a crashed session; a live one is never at this path.
  rmSync(path, { force: true });
  const server: Server = createServer((socket) => {
    let line = "";
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", async (chunk) => {
      line += chunk;
      if (!line.includes("\n")) return;
      let reply: object;
      try {
        const request = JSON.parse(line) as { name?: unknown; args?: unknown };
        reply = { text: await handler(String(request.name), typeof request.args === "string" ? request.args : "") };
      } catch (error) {
        reply = { error: error instanceof Error ? error.message : String(error) };
      }
      socket.end(`${JSON.stringify(reply)}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return {
    close: () => new Promise((resolve) => {
      server.close(() => {
        rmSync(path, { force: true });
        resolve();
      });
    }),
  };
}

/** The command's output, or null when nothing answers (the model can run it). */
export function callControl(path: string, name: string, args: string, timeoutMs = 15_000): Promise<string | null> {
  return new Promise((resolve) => {
    let data = "";
    const socket = createConnection(path);
    const finish = (value: string | null) => {
      socket.destroy();
      resolve(value);
    };
    let connected = false;
    // Once connected the command is running; falling back to the model would run it twice.
    socket.setTimeout(timeoutMs, () => finish(connected ? "pi-weave: still working; check /weave for progress." : null));
    socket.setEncoding("utf8");
    socket.on("error", () => finish(null));
    socket.on("connect", () => {
      connected = true;
      socket.write(`${JSON.stringify({ name, args })}\n`);
    });
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("end", () => {
      try {
        const reply = JSON.parse(data) as { text?: string; error?: string };
        finish(typeof reply.text === "string" ? reply.text : reply.error ? `pi-weave: ${reply.error}` : null);
      } catch {
        finish(null);
      }
    });
  });
}
