/**
 * The SSE hub — the "tell the browser" half of liveness (weave-workspace §6).
 *
 * A hand-rolled `text/event-stream` over `node:http`. No npm package: the
 * server tier's allowlist is empty (§2), and the wire format is four lines of
 * `res.write`.
 *
 * ## Why `EventSource` and not a WebSocket
 *
 * The traffic is one-directional and tiny — `{scope, stamp}`, at human edit
 * rates. `EventSource` reconnects natively, survives a server restart without
 * client code, and rides the `__Host-weave` cookie automatically, which
 * matters because `EventSource` cannot set request headers (§5.1). A
 * WebSocket would need a framing library, a reconnect loop, and its own
 * authentication path to buy nothing.
 *
 * ## Reconnect: refetch-everything, not `Last-Event-ID`
 *
 * §6 offers a choice and this hub takes the simpler branch, deliberately.
 * Frames still carry `id:` (the stamp), because it costs one line and gives
 * the browser a `lastEventId` worth logging — but **the server keeps no
 * replay buffer and ignores `Last-Event-ID` on reconnect**. The client
 * refetches everything when the stream reopens, which is the behaviour §6
 * describes.
 *
 * A replay buffer would be a *second* source of truth about what changed, and
 * a strictly worse one: frames are coalesced hints, not deltas (§6), so
 * replaying the three frames a client missed is no more informative than the
 * client simply noticing it reconnected. What it actually needs after any gap
 * is one `If-None-Match` refetch of `/api/graph` — a 304 when nothing moved,
 * and correct whether it missed one frame or a thousand. Buffering would add
 * per-client retention, an eviction policy and a resume path to arrive at the
 * same fetch.
 *
 * ## Dedupe
 *
 * A client that already holds the current stamp is not sent it again. The
 * watcher's debounce can still emit two frames for one logical edit (a save
 * that lands either side of the 80 ms window), and the stamp is a **content
 * digest** of the graph payload (§5.3, §15.6), so an identical stamp provably
 * means identical content. Dedupe is **per client**, not global: a client that
 * connected after the last broadcast has not seen it.
 *
 * The digest replaced `generatedAt` here for a reason this hub cannot see but
 * depends on: a timestamp max is unchanged by an edit that does not advance
 * it, so dropping such a frame as a duplicate silently withheld a real change
 * from the client. The frames are only as trustworthy as the key they dedupe
 * on.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { CHANGE_EVENT_NAME, type ChangeEvent } from "../shared/wire";

/** §6: a comment frame every 20 s to defeat proxy buffering. */
export const DEFAULT_HEARTBEAT_MS = 20_000;

/**
 * The heartbeat is an SSE comment: a line starting with `:` that carries no
 * event and is discarded by every conforming client. It exists to push bytes
 * through an idle connection so that (a) an intermediary does not buffer or
 * reap the stream, and (b) a socket whose peer vanished without a FIN fails
 * its write and is reaped here.
 */
const HEARTBEAT_FRAME = ":ping\n\n";

/** Recurring-timer injection, so tests never wait 20 s. Mirrors the watcher's. */
export interface IntervalScheduler {
  /** Run `fn` every `ms`; the returned closure cancels it. */
  repeat(fn: () => void, ms: number): () => void;
}

/** `setInterval`, `unref`'d so a live stream cannot outlive the pi session. */
export const realIntervalScheduler: IntervalScheduler = {
  repeat(fn, ms) {
    const handle = setInterval(fn, ms);
    handle.unref?.();
    return () => clearInterval(handle);
  },
};

/**
 * The half of `ServerResponse` this hub uses.
 *
 * Narrower than `ServerResponse` on purpose: it documents the entire contract
 * ("headers, writes, an end, and two lifecycle events") and lets a test pass a
 * recording double without constructing a socket. A real `ServerResponse`
 * satisfies it structurally.
 */
export interface SseSink {
  writeHead(status: number, headers: Record<string, string>): unknown;
  flushHeaders?: () => void;
  write(chunk: string): boolean;
  end(): unknown;
  on(event: "close" | "error", listener: () => void): unknown;
  readonly writableEnded?: boolean;
}

/**
 * The response headers, as a table so the route test can assert them
 * literally.
 *
 * | Header | Why |
 * | --- | --- |
 * | `Content-Type: text/event-stream` | The format. Without it `EventSource` rejects the response outright. |
 * | `Cache-Control: no-cache, no-transform` | `no-transform` additionally forbids a proxy from gzipping, which would introduce its own buffer. |
 * | `Connection: keep-alive` | HTTP/1.1 explicitness; harmless under HTTP/2. |
 * | `X-Accel-Buffering: no` | nginx-specific, and the one that actually matters in practice: without it nginx buffers the stream and every event arrives in a batch when the connection closes. |
 */
export const SSE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

/**
 * Serialize one event.
 *
 * `id:` carries the stamp so the browser exposes `lastEventId` (useful in a
 * log, and the seam if we ever *do* want replay); the server itself keeps no
 * history — see the module header. `retry:` is omitted, leaving the browser's
 * own backoff in charge, which is the behaviour §6 describes.
 */
export function formatFrame(event: ChangeEvent): string {
  return `id: ${event.stamp}\nevent: ${CHANGE_EVENT_NAME}\ndata: ${JSON.stringify(event)}\n\n`;
}

export interface SseHubOptions {
  /**
   * The stamp a newly attached client should be told about, if any.
   *
   * This is what replaces a replay buffer: rather than reconstructing what a
   * reconnecting client missed, hand it the current stamp and let its
   * `If-None-Match` refetch decide whether anything actually moved. Returning
   * `null` (no graph built yet) simply sends nothing.
   */
  currentStamp?: () => string | null;
  heartbeatMs?: number;
  scheduler?: IntervalScheduler;
}

/** One attached browser. */
interface Client {
  sink: SseSink;
  /** Last stamp written to this client; `null` before its first frame. */
  lastStamp: string | null;
  /** Guards against `close` and `error` both firing for the same socket. */
  detached: boolean;
}

/**
 * The hub. Owns every open stream and exactly one heartbeat timer.
 *
 * One timer for all clients rather than one per client: the heartbeat is a
 * liveness probe, not a per-connection schedule, and N timers would be N
 * things to leak. It runs only while at least one client is attached, so an
 * idle server holds no timers at all — which is what lets the process exit
 * cleanly when the pi session ends.
 */
export class SseHub {
  private readonly clients = new Set<Client>();
  private readonly currentStamp: (() => string | null) | undefined;
  private readonly heartbeatMs: number;
  private readonly scheduler: IntervalScheduler;

  private cancelHeartbeat: (() => void) | null = null;
  private closed = false;

  constructor(opts: SseHubOptions = {}) {
    this.currentStamp = opts.currentStamp;
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.scheduler = opts.scheduler ?? realIntervalScheduler;
  }

  /**
   * Adopt a request as an SSE stream.
   *
   * `req` is unused beyond its lifecycle: authentication happened in
   * `security.ts` before the route dispatched here, and `Last-Event-ID` is
   * deliberately ignored (module header). It stays in the signature because
   * that is the shape a route handler has, and because a future replay
   * implementation would need it.
   *
   * After {@link close}, a late request is answered `503` rather than left
   * hanging — a browser retrying into a shutting-down server should learn
   * that immediately.
   */
  attach(req: IncomingMessage, res: SseSink): void {
    if (this.closed) {
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      res.end();
      return;
    }
    res.writeHead(200, { ...SSE_HEADERS });
    // Without this the first frame can sit in Node's header buffer until
    // enough body accumulates, so `EventSource` stays in CONNECTING and the
    // client's status bar lies.
    res.flushHeaders?.();

    const client: Client = { sink: res, lastStamp: null, detached: false };
    this.clients.add(client);

    const detach = (): void => this.detach(client);
    res.on("close", detach);
    res.on("error", detach);
    void req;

    this.startHeartbeat();

    // The reconnect strategy in one line: tell the fresh client where we are
    // and let its conditional refetch work out whether that means anything.
    const stamp = this.currentStamp?.() ?? null;
    if (stamp !== null) this.send(client, { scope: "vault", stamp });
  }

  /** Fan out one event, skipping clients that already hold its stamp. */
  broadcast(event: ChangeEvent): void {
    if (this.closed) return;
    for (const client of [...this.clients]) {
      if (client.lastStamp === event.stamp) continue;
      this.send(client, event);
    }
  }

  /** Attached client count. `server.ts`'s idle shutdown reads this. */
  clientCount(): number {
    return this.clients.size;
  }

  /**
   * End every stream and stop the heartbeat. Idempotent.
   *
   * Ending rather than destroying: the browser sees a clean EOF and applies
   * its normal reconnect backoff, which is right for a restart and harmless
   * for a shutdown (the port is gone and the retry fails fast). A stream left
   * open would keep its socket — and, without the `unref` above, the whole
   * process — alive after the pi session exited.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const client of [...this.clients]) {
      client.detached = true;
      endQuietly(client.sink);
    }
    this.clients.clear();
    this.stopHeartbeat();
  }

  // --- internals --------------------------------------------------------------

  /**
   * Write one frame, recording the stamp so the next broadcast can dedupe.
   *
   * A failed write means the peer is gone in a way `close` has not reported
   * yet, so the client is dropped rather than retried — the alternative is
   * writing into a dead socket every 20 s forever.
   */
  private send(client: Client, event: ChangeEvent): void {
    if (writeQuietly(client.sink, formatFrame(event))) {
      client.lastStamp = event.stamp;
    } else {
      this.detach(client);
    }
  }

  private detach(client: Client): void {
    if (client.detached) return;
    client.detached = true;
    this.clients.delete(client);
    if (this.clients.size === 0) this.stopHeartbeat();
  }

  private startHeartbeat(): void {
    if (this.cancelHeartbeat !== null) return;
    this.cancelHeartbeat = this.scheduler.repeat(() => this.beat(), this.heartbeatMs);
  }

  private stopHeartbeat(): void {
    this.cancelHeartbeat?.();
    this.cancelHeartbeat = null;
  }

  /** One heartbeat round; also the reaper for sockets that died silently. */
  private beat(): void {
    for (const client of [...this.clients]) {
      if (!writeQuietly(client.sink, HEARTBEAT_FRAME)) this.detach(client);
    }
  }
}

/** `write`, reporting failure as `false` instead of throwing. */
function writeQuietly(sink: SseSink, chunk: string): boolean {
  if (sink.writableEnded === true) return false;
  try {
    // `write` returning false is backpressure, not failure — these frames are
    // tens of bytes, so the buffer absorbing them is a success.
    sink.write(chunk);
    return true;
  } catch {
    return false;
  }
}

function endQuietly(sink: SseSink): void {
  try {
    sink.end();
  } catch {
    // The socket died between the liveness check and the write. Shutdown must
    // not fail because a client left first.
  }
}

/**
 * Structural check that a real `ServerResponse` satisfies {@link SseSink}.
 *
 * Purely a compile-time assertion: if `SseSink` ever drifts from the API
 * `node:http` actually offers, `npm run typecheck` fails here rather than at
 * the call site in `server.ts`, which is owned by someone else.
 */
export type SseSinkIsServerResponse = ServerResponse extends SseSink ? true : never;
