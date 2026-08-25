/**
 * src/web/server/sse.ts — the broadcast half of liveness (weave-workspace §6).
 *
 * Tested over a **real** `node:http` server on `listen(0)`, connected with
 * real `fetch`, with frames parsed off the response body stream. The hub's
 * whole job is to produce bytes a browser's `EventSource` will accept, and a
 * mock sink cannot tell us whether it does. The one thing that stays injected
 * is the heartbeat interval — waiting 20 s for a `:ping` would be absurd, and
 * the scheduler seam exists precisely so we do not have to.
 *
 * Every server and hub is registered for teardown in `afterEach`: a stream
 * left open holds a socket, and a socket held open hangs the vitest run.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_HEARTBEAT_MS,
  SSE_HEADERS,
  SseHub,
  formatFrame,
  realIntervalScheduler,
  type SseSink,
} from "../../src/web/server/sse";
import { CHANGE_EVENT_NAME, isChangeEvent, type ChangeEvent } from "../../src/web/shared/wire";

// --- harness ------------------------------------------------------------------

/** An {@link IntervalScheduler} the test fires by hand. */
function fakeScheduler() {
  let seq = 0;
  const repeats = new Map<number, () => void>();
  let lastMs = -1;
  return {
    scheduler: {
      repeat(fn: () => void, ms: number): () => void {
        const id = seq++;
        lastMs = ms;
        repeats.set(id, fn);
        return () => void repeats.delete(id);
      },
    },
    /** Fire every live interval once. */
    tick(): void {
      for (const fn of [...repeats.values()]) fn();
    },
    live: (): number => repeats.size,
    ms: (): number => lastMs,
  };
}

const servers: Server[] = [];
const hubs: SseHub[] = [];
const abortControllers: AbortController[] = [];

afterEach(async () => {
  // Order matters: end the streams first so the sockets are releasable, then
  // abort any client still reading, then close the listeners. Closing a
  // server with a live SSE stream attached would otherwise never resolve.
  while (hubs.length > 0) hubs.pop()?.close();
  while (abortControllers.length > 0) abortControllers.pop()?.abort();
  while (servers.length > 0) {
    const server = servers.pop()!;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/**
 * Boot a minimal server whose only route is the SSE stream, on an ephemeral
 * port. Never a fixed port — a fixed port makes the suite unrunnable twice at
 * once and collides with whatever else the machine is doing.
 */
async function boot(hub: SseHub): Promise<string> {
  hubs.push(hub);
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/events") hub.attach(req, res);
    else {
      res.writeHead(404);
      res.end();
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** One parsed SSE frame. `comment` is a heartbeat (`:ping`). */
interface Frame {
  id?: string;
  event?: string;
  data?: string;
  comment?: string;
}

/**
 * A live connection to the stream, with frames parsed off the body as they
 * arrive.
 *
 * Chunk boundaries are not frame boundaries: a slow socket can split a frame
 * mid-line and TCP can coalesce two frames into one read. So the reader keeps
 * a buffer and splits on the blank line that SSE actually delimits with,
 * rather than assuming one chunk is one event.
 */
async function connect(base: string): Promise<{
  frames: Frame[];
  status: number;
  headers: Headers;
  /** Wait until at least `n` frames have been parsed, or time out. */
  waitFor(n: number): Promise<void>;
  /** Wait for the body stream to end (the server called `end()`). */
  ended(): Promise<void>;
  close(): void;
}> {
  const controller = new AbortController();
  abortControllers.push(controller);
  const response = await fetch(`${base}/events`, { signal: controller.signal });
  const frames: Frame[] = [];
  let done = false;

  const pump = (async () => {
    const reader = response.body?.getReader();
    if (reader === undefined) return;
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let split = buffer.indexOf("\n\n");
        while (split >= 0) {
          frames.push(parseFrame(buffer.slice(0, split)));
          buffer = buffer.slice(split + 2);
          split = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // An aborted read is how a test disconnects; it is not a failure.
    } finally {
      done = true;
    }
  })();

  return {
    frames,
    status: response.status,
    headers: response.headers,
    async waitFor(n: number): Promise<void> {
      for (let i = 0; i < 200 && frames.length < n; i += 1) {
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    async ended(): Promise<void> {
      for (let i = 0; i < 200 && !done; i += 1) await new Promise((r) => setTimeout(r, 5));
      await pump;
    },
    close(): void {
      controller.abort();
    },
  };
}

function parseFrame(block: string): Frame {
  const frame: Frame = {};
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) frame.comment = line.slice(1);
    else if (line.startsWith("id: ")) frame.id = line.slice(4);
    else if (line.startsWith("event: ")) frame.event = line.slice(7);
    else if (line.startsWith("data: ")) frame.data = line.slice(6);
  }
  return frame;
}

/** Wait until the hub observes `n` clients — `attach` completes server-side. */
async function waitForClients(hub: SseHub, n: number): Promise<void> {
  for (let i = 0; i < 200 && hub.clientCount() !== n; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

const EVENT = (scope: ChangeEvent["scope"], stamp: string): ChangeEvent => ({ scope, stamp });

// --- frame format ----------------------------------------------------------------

describe("formatFrame", () => {
  it("emits id, event and data, terminated by a blank line", () => {
    expect(formatFrame(EVENT("vault", "2026-01-01T00:00:00.000Z"))).toBe(
      'id: 2026-01-01T00:00:00.000Z\n' +
        `event: ${CHANGE_EVENT_NAME}\n` +
        'data: {"scope":"vault","stamp":"2026-01-01T00:00:00.000Z"}\n\n',
    );
  });

  it("produces data the shared guard accepts — the client's actual parse path", () => {
    for (const scope of ["vault", "repo", "git"] as const) {
      const frame = parseFrame(formatFrame(EVENT(scope, "s1")).trimEnd());
      expect(isChangeEvent(JSON.parse(frame.data!))).toBe(true);
    }
  });

  it("carries the stamp as the SSE id", () => {
    // The client gets it as `lastEventId`. The server keeps no replay buffer
    // (see the module header) — this is for observability, not resume.
    expect(formatFrame(EVENT("git", "abc")).startsWith("id: abc\n")).toBe(true);
  });
});

// --- headers ----------------------------------------------------------------------

describe("SseHub — headers (§6)", () => {
  it("responds 200 with the event-stream headers", async () => {
    const base = await boot(new SseHub({ scheduler: fakeScheduler().scheduler }));
    const client = await connect(base);
    expect(client.status).toBe(200);
    expect(client.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(client.headers.get("cache-control")).toBe("no-cache, no-transform");
    // Without this nginx buffers the whole stream and every event arrives at
    // once when the connection finally closes.
    expect(client.headers.get("x-accel-buffering")).toBe("no");
    client.close();
  });

  it("declares the header table it documents", () => {
    expect(SSE_HEADERS["Content-Type"]).toBe("text/event-stream; charset=utf-8");
    expect(SSE_HEADERS["Connection"]).toBe("keep-alive");
  });

  it("calls flushHeaders so the client leaves CONNECTING immediately", () => {
    let flushed = false;
    const sink = recordingSink({ onFlush: () => void (flushed = true) });
    const hub = new SseHub({ scheduler: fakeScheduler().scheduler });
    hubs.push(hub);
    hub.attach(fakeRequest(), sink.sink);
    expect(flushed).toBe(true);
  });

  it("tolerates a sink with no flushHeaders", () => {
    const sink = recordingSink({ omitFlush: true });
    const hub = new SseHub({ scheduler: fakeScheduler().scheduler });
    hubs.push(hub);
    expect(() => hub.attach(fakeRequest(), sink.sink)).not.toThrow();
    expect(hub.clientCount()).toBe(1);
  });
});

// --- broadcast and dedupe -----------------------------------------------------------

describe("SseHub — broadcast", () => {
  it("delivers a broadcast frame to a connected client", async () => {
    const hub = new SseHub({ scheduler: fakeScheduler().scheduler });
    const base = await boot(hub);
    const client = await connect(base);
    await waitForClients(hub, 1);

    hub.broadcast(EVENT("vault", "s1"));
    await client.waitFor(1);
    expect(client.frames[0]).toEqual({
      id: "s1",
      event: CHANGE_EVENT_NAME,
      data: '{"scope":"vault","stamp":"s1"}',
    });
    client.close();
  });

  it("fans out to every client", async () => {
    const hub = new SseHub({ scheduler: fakeScheduler().scheduler });
    const base = await boot(hub);
    const a = await connect(base);
    const b = await connect(base);
    await waitForClients(hub, 2);

    hub.broadcast(EVENT("repo", "s1"));
    await a.waitFor(1);
    await b.waitFor(1);
    expect(a.frames[0]?.id).toBe("s1");
    expect(b.frames[0]?.id).toBe("s1");
    a.close();
    b.close();
  });

  it("dedupes by stamp: an identical stamp is not re-sent", async () => {
    const hub = new SseHub({ scheduler: fakeScheduler().scheduler });
    const base = await boot(hub);
    const client = await connect(base);
    await waitForClients(hub, 1);

    // The watcher's debounce can emit two frames for one logical edit, and
    // `generatedAt` is derived from input timestamps — so an equal stamp
    // provably means equal content.
    hub.broadcast(EVENT("vault", "s1"));
    hub.broadcast(EVENT("vault", "s1"));
    hub.broadcast(EVENT("repo", "s1"));
    await client.waitFor(1);
    hub.broadcast(EVENT("vault", "s2"));
    await client.waitFor(2);

    expect(client.frames.map((f) => f.id)).toEqual(["s1", "s2"]);
    client.close();
  });

  it("dedupes per client, not globally", async () => {
    const hub = new SseHub({ scheduler: fakeScheduler().scheduler });
    const base = await boot(hub);
    const first = await connect(base);
    await waitForClients(hub, 1);
    hub.broadcast(EVENT("vault", "s1"));
    await first.waitFor(1);

    // A client that connected *after* the broadcast has not seen it, so a
    // global "last stamp" would starve it.
    const second = await connect(base);
    await waitForClients(hub, 2);
    hub.broadcast(EVENT("vault", "s1"));
    await second.waitFor(1);

    expect(first.frames.map((f) => f.id)).toEqual(["s1"]);
    expect(second.frames.map((f) => f.id)).toEqual(["s1"]);
    first.close();
    second.close();
  });

  it("sends the current stamp on attach — the reconnect strategy", async () => {
    // Instead of replaying missed frames, a fresh connection is told where
    // the server is and refetches conditionally. See the module header.
    const hub = new SseHub({ currentStamp: () => "current", scheduler: fakeScheduler().scheduler });
    const base = await boot(hub);
    const client = await connect(base);
    await client.waitFor(1);
    expect(client.frames[0]?.id).toBe("current");

    // And having just been told, it is not told again.
    hub.broadcast(EVENT("vault", "current"));
    hub.broadcast(EVENT("vault", "next"));
    await client.waitFor(2);
    expect(client.frames.map((f) => f.id)).toEqual(["current", "next"]);
    client.close();
  });

  it("sends nothing on attach when no graph has been built yet", async () => {
    const hub = new SseHub({ currentStamp: () => null, scheduler: fakeScheduler().scheduler });
    const base = await boot(hub);
    const client = await connect(base);
    await waitForClients(hub, 1);
    hub.broadcast(EVENT("vault", "s1"));
    await client.waitFor(1);
    expect(client.frames.map((f) => f.id)).toEqual(["s1"]);
    client.close();
  });

  it("ignores Last-Event-ID — the documented no-replay choice", async () => {
    const hub = new SseHub({ currentStamp: () => "current", scheduler: fakeScheduler().scheduler });
    const base = await boot(hub);
    const controller = new AbortController();
    abortControllers.push(controller);
    const response = await fetch(`${base}/events`, {
      headers: { "Last-Event-ID": "s-ancient" },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    // No history is replayed; the client is simply told the current stamp and
    // refetches with `If-None-Match`.
    await waitForClients(hub, 1);
    controller.abort();
  });
});

// --- heartbeat ---------------------------------------------------------------------

describe("SseHub — heartbeat (§6)", () => {
  it("emits a comment frame on each interval", async () => {
    const clock = fakeScheduler();
    const hub = new SseHub({ scheduler: clock.scheduler });
    const base = await boot(hub);
    const client = await connect(base);
    await waitForClients(hub, 1);

    clock.tick();
    await client.waitFor(1);
    // A comment carries no event, so a conforming client discards it — its
    // whole purpose is to push bytes through an idle connection.
    expect(client.frames[0]).toEqual({ comment: "ping" });
    expect(client.frames[0]?.event).toBeUndefined();
    client.close();
  });

  it("defaults to the §6 20 s interval", () => {
    const clock = fakeScheduler();
    const hub = new SseHub({ scheduler: clock.scheduler });
    hubs.push(hub);
    hub.attach(fakeRequest(), recordingSink().sink);
    expect(clock.ms()).toBe(DEFAULT_HEARTBEAT_MS);
    expect(clock.ms()).toBe(20_000);
  });

  it("runs no timer until a client attaches, and stops when the last leaves", () => {
    const clock = fakeScheduler();
    const hub = new SseHub({ scheduler: clock.scheduler });
    hubs.push(hub);
    // An idle server holding a live timer is what keeps a process alive after
    // the pi session exits.
    expect(clock.live()).toBe(0);

    const a = recordingSink();
    const b = recordingSink();
    hub.attach(fakeRequest(), a.sink);
    hub.attach(fakeRequest(), b.sink);
    expect(clock.live()).toBe(1); // one timer for all clients, not one each

    a.fire("close");
    expect(clock.live()).toBe(1);
    b.fire("close");
    expect(clock.live()).toBe(0);
  });

  it("reaps a client whose socket died without a close event", () => {
    const clock = fakeScheduler();
    const hub = new SseHub({ scheduler: clock.scheduler });
    hubs.push(hub);
    const dead = recordingSink({ throwOnWrite: true });
    hub.attach(fakeRequest(), dead.sink);
    expect(hub.clientCount()).toBe(1);

    // The heartbeat is also the reaper: a peer that vanished without a FIN is
    // only detectable by writing to it.
    clock.tick();
    expect(hub.clientCount()).toBe(0);
    expect(clock.live()).toBe(0);
  });
});

// --- client accounting ----------------------------------------------------------------

describe("SseHub — clientCount (§5.4 idle shutdown depends on it)", () => {
  it("tracks connects and disconnects over the network", async () => {
    const hub = new SseHub({ scheduler: fakeScheduler().scheduler });
    const base = await boot(hub);
    expect(hub.clientCount()).toBe(0);

    const a = await connect(base);
    await waitForClients(hub, 1);
    const b = await connect(base);
    await waitForClients(hub, 2);
    expect(hub.clientCount()).toBe(2);

    a.close();
    await waitForClients(hub, 1);
    expect(hub.clientCount()).toBe(1);

    b.close();
    await waitForClients(hub, 0);
    expect(hub.clientCount()).toBe(0);
  });

  it("counts a client once even when close and error both fire", () => {
    const hub = new SseHub({ scheduler: fakeScheduler().scheduler });
    hubs.push(hub);
    const sink = recordingSink();
    hub.attach(fakeRequest(), sink.sink);
    expect(hub.clientCount()).toBe(1);
    // Node emits both for an aborted request; double-decrementing would drive
    // the count negative and disable the idle shutdown.
    sink.fire("close");
    sink.fire("error");
    expect(hub.clientCount()).toBe(0);
  });

  it("drops a client whose write fails during a broadcast", () => {
    const hub = new SseHub({ scheduler: fakeScheduler().scheduler });
    hubs.push(hub);
    const dead = recordingSink({ throwOnWrite: true });
    const alive = recordingSink();
    hub.attach(fakeRequest(), dead.sink);
    hub.attach(fakeRequest(), alive.sink);

    hub.broadcast(EVENT("vault", "s1"));
    expect(hub.clientCount()).toBe(1);
    // One dead peer must not cost the live one its frame.
    expect(alive.writes.join("")).toContain("id: s1");
  });

  it("does not write to a response that has already ended", () => {
    const hub = new SseHub({ scheduler: fakeScheduler().scheduler });
    hubs.push(hub);
    const sink = recordingSink();
    hub.attach(fakeRequest(), sink.sink);
    // The socket finished without Node having emitted `close` yet — writing
    // into it would throw ERR_STREAM_WRITE_AFTER_END inside a broadcast loop.
    sink.markEnded();

    const before = sink.writes.length;
    hub.broadcast(EVENT("vault", "s1"));
    expect(sink.writes.length).toBe(before);
    expect(hub.clientCount()).toBe(0);
  });
});

// --- shutdown ---------------------------------------------------------------------------

describe("SseHub — close() (§5.4)", () => {
  it("ends every stream, so no socket outlives the session", async () => {
    const hub = new SseHub({ scheduler: fakeScheduler().scheduler });
    const base = await boot(hub);
    const a = await connect(base);
    const b = await connect(base);
    await waitForClients(hub, 2);

    hub.close();
    // The client's body stream must actually terminate — a hung stream is
    // exactly what keeps the process alive after the pi session exits.
    await a.ended();
    await b.ended();
    expect(hub.clientCount()).toBe(0);
  });

  it("stops the heartbeat and goes silent", () => {
    const clock = fakeScheduler();
    const hub = new SseHub({ scheduler: clock.scheduler });
    const sink = recordingSink();
    hub.attach(fakeRequest(), sink.sink);
    hub.close();
    expect(clock.live()).toBe(0);

    const after = sink.writes.length;
    clock.tick();
    hub.broadcast(EVENT("vault", "s1"));
    expect(sink.writes.length).toBe(after);
  });

  it("is idempotent and survives a sink that throws on end", () => {
    const hub = new SseHub({ scheduler: fakeScheduler().scheduler });
    const sink = recordingSink({ throwOnEnd: true });
    hub.attach(fakeRequest(), sink.sink);
    expect(() => hub.close()).not.toThrow();
    expect(() => hub.close()).not.toThrow();
    expect(sink.ends).toBe(1);
  });

  it("answers a late connection 503 instead of hanging it", async () => {
    const hub = new SseHub({ scheduler: fakeScheduler().scheduler });
    const base = await boot(hub);
    hub.close();
    const response = await fetch(`${base}/events`);
    // A browser retrying into a shutting-down server should learn that at
    // once, rather than holding a connection that will never produce a byte.
    expect(response.status).toBe(503);
    await response.text();
    expect(hub.clientCount()).toBe(0);
  });
});

// --- the real timer ------------------------------------------------------------------------

describe("realIntervalScheduler", () => {
  it("backs the hub when no scheduler is injected", async () => {
    // `server.ts` constructs the hub with no options, so this fallback is
    // production wiring rather than a dead default. A 1 ms heartbeat keeps it
    // fast; the point is that a real timer is installed and `close()` clears
    // it — a surviving interval is what keeps the process alive at shutdown.
    const hub = new SseHub({ heartbeatMs: 1 });
    const base = await boot(hub);
    const client = await connect(base);
    await client.waitFor(2);
    expect(client.frames.every((f) => f.comment === "ping")).toBe(true);

    hub.close();
    await client.ended();
    const settled = client.frames.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(client.frames.length).toBe(settled);
  });

  it("repeats until cancelled", async () => {
    let beats = 0;
    const cancel = realIntervalScheduler.repeat(() => void (beats += 1), 1);
    await new Promise((r) => setTimeout(r, 20));
    cancel();
    expect(beats).toBeGreaterThan(0);
    const settled = beats;
    await new Promise((r) => setTimeout(r, 15));
    expect(beats).toBe(settled);
  });
});

// --- sink double ------------------------------------------------------------------------------

interface RecordingSinkOptions {
  throwOnWrite?: boolean;
  throwOnEnd?: boolean;
  omitFlush?: boolean;
  onFlush?: () => void;
}

/**
 * An {@link SseSink} double, for the paths a real socket cannot be made to
 * take on demand: a write that throws, an `end` that throws, a response
 * already ended, a sink without `flushHeaders`. Everything reachable over a
 * real connection is tested over one.
 */
function recordingSink(opts: RecordingSinkOptions = {}) {
  const writes: string[] = [];
  const listeners = new Map<string, Array<() => void>>();
  let ends = 0;
  let ended = false;
  let forceEnded = false;

  const sink: SseSink = {
    writeHead: () => undefined,
    write(chunk: string): boolean {
      if (opts.throwOnWrite === true) throw new Error("EPIPE");
      writes.push(chunk);
      return true;
    },
    end(): undefined {
      ends += 1;
      ended = true;
      if (opts.throwOnEnd === true) throw new Error("ERR_STREAM_ALREADY_FINISHED");
      return undefined;
    },
    on(event: "close" | "error", listener: () => void): undefined {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return undefined;
    },
    get writableEnded(): boolean {
      return ended || forceEnded;
    },
  };
  if (opts.omitFlush !== true) sink.flushHeaders = (): void => opts.onFlush?.();

  return {
    sink,
    writes,
    /** Simulate a socket that ended between `attach` and the next write. */
    markEnded(): void {
      forceEnded = true;
    },
    get ends(): number {
      return ends;
    },
    fire(event: "close" | "error"): void {
      for (const listener of listeners.get(event) ?? []) listener();
    },
  };
}

/** The slice of `IncomingMessage` `attach` touches: nothing. */
function fakeRequest(): IncomingMessage {
  return {} as IncomingMessage;
}
