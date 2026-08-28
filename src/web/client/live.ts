/**
 * The SSE socket, wired to {@link ./live.model} (weave-workspace §6).
 *
 * Everything that decides anything lives in `live.model.ts`. This file owns
 * exactly one thing the model cannot: a real `EventSource`, its three
 * listeners, and the fact that it must be closed. Keeping that separation
 * sharp is what lets the whole liveness layer be unit-tested with no DOM —
 * §10's constraint, and the reason `.model.ts` files exist at all.
 *
 * ## The socket is injected
 *
 * {@link startLive} takes a factory rather than calling `new EventSource`.
 * The DOM one is the default at the call site in the shell, and a test passes
 * a fake with the same four members. This is the same port-shaped injection
 * `api.ts` uses for `fetch` and for the same reason: without it, the only way
 * to reach the reconnect path would be a browser.
 *
 * ## Why the connection state is written here and not in the model
 *
 * The model is pure and returns a next state; something has to publish it to
 * the `connection` signal that the status bar reads. That publication is this
 * file's other job, and it is one line — which is the correct amount of logic
 * for a file with no test harness behind it.
 */

import type { ChangeScope } from "../shared/wire";
import { CHANGE_EVENT_NAME } from "../shared/wire";
import type { LiveEvent, LiveState, RefetchPlan } from "./live.model";
import { EVENTS_PATH, initialLiveState, isNoop, parseFrame, reduceLive, withStamp } from "./live.model";
import { connection } from "./state";

/**
 * The slice of `EventSource` this module uses.
 *
 * Structural, so the platform's satisfies it without a cast and a fake is an
 * object literal. Two details are load-bearing:
 *
 * **`addEventListener` for all three events, not `onopen`/`onerror`.** The
 * handler properties are the more obvious spelling and they do not typecheck:
 * a property of function type is checked *contravariantly* under
 * `strictFunctionTypes`, so a port declaring `onopen: ((e: unknown) => void)`
 * rejects the platform's `(ev: Event) => any` — `unknown` is not assignable
 * to `Event`. Method declarations are compared bivariantly, so the single
 * `addEventListener` form accepts the real `EventSource` without a cast and
 * without this module ever naming a DOM type.
 *
 * **`{data: string}` rather than `MessageEvent`.** This file is compiled by
 * `tsconfig.web.json` for the bundle *and* pulled into the root project when
 * a test imports it, and the root project has no `DOM` lib. The narrow shape
 * is the only one both projects can resolve. `open` and `error` carry no
 * payload this module reads, so they receive it and ignore it.
 */
export interface EventSourceLike {
  /** `0` connecting, `1` open, `2` closed. See `live.model.ts`'s constants. */
  readonly readyState: number;
  addEventListener(type: string, listener: (event: { data: string }) => void): void;
  close(): void;
}

/** Creates a stream for a URL. The DOM's `EventSource` constructor fits. */
export type EventSourceFactory = (url: string) => EventSourceLike;

/** What {@link startLive} needs from its host. */
export interface LiveOptions {
  /** Injected socket constructor. */
  open: EventSourceFactory;
  /**
   * Run a refetch plan. Async and awaited nowhere — a fetch that outlives the
   * socket is the caller's problem to make idempotent, and the shell's is.
   */
  refetch: (plan: RefetchPlan) => void;
  /** Whether a note is open, read fresh per event. See `reduceLive`. */
  hasSelection: () => boolean;
  /** The stream URL. Defaults to {@link EVENTS_PATH}. */
  path?: string;
}

/** A running stream. */
export interface LiveHandle {
  /** Close the socket and mark the connection offline. Idempotent. */
  stop(): void;
  /** Force a full refetch — the header's `⟳`. */
  refresh(): void;
  /** Record a stamp the client now holds, so the next frame can dedupe it. */
  seen(stamp: string): void;
  /** Current state. For tests and the status bar's tooltip. */
  state(): LiveState;
}

/**
 * Attach to the event stream.
 *
 * Note what this does *not* do: reconnect. `EventSource` reconnects natively
 * with its own backoff, which is most of why §6 chose it over a WebSocket, so
 * a retry loop here would be a second one racing the browser's.
 */
export function startLive(opts: LiveOptions): LiveHandle {
  let state = initialLiveState();
  let stopped = false;

  const source = opts.open(opts.path ?? EVENTS_PATH);

  /** The single path from a socket event to a state change and a refetch. */
  const dispatch = (event: LiveEvent): void => {
    const next = reduceLive(state, event, opts.hasSelection());
    state = next.state;
    connection.value = state.connection;
    if (!isNoop(next.plan)) opts.refetch(next.plan);
  };

  source.addEventListener("open", () => dispatch({ type: "open" }));
  source.addEventListener("error", () => dispatch({ type: "error", readyState: source.readyState }));
  source.addEventListener(CHANGE_EVENT_NAME, (event) => {
    const frame = parseFrame(event.data);
    // A frame we cannot read is dropped rather than escalated: the next one
    // carries the same "something moved" meaning, and the heartbeat proves
    // the socket is still alive meanwhile.
    if (frame !== null) dispatch({ type: "frame", event: frame });
  });

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      source.close();
      dispatch({ type: "closed" });
    },
    refresh() {
      dispatch({ type: "refresh" });
    },
    seen(stamp: string) {
      state = withStamp(state, stamp);
    },
    state() {
      return state;
    },
  };
}

/**
 * `new EventSource(url)`, as an {@link EventSourceFactory}.
 *
 * The one place in the liveness layer that names a DOM global, isolated here
 * so that everything else in it compiles and runs under Node.
 */
export function domEventSource(url: string): EventSourceLike {
  return new EventSource(url);
}

/** Re-exported so the shell imports its liveness vocabulary from one module. */
export type { ChangeScope, LiveState, RefetchPlan };
