/**
 * The liveness state machine, as pure data (weave-workspace §6).
 *
 * `src/web/server/sse.ts` pushes `{scope, stamp}` frames at the browser; this
 * module decides two things about them, and nothing else:
 *
 *  1. **What must be refetched** — a {@link RefetchPlan}.
 *  2. **What the status bar should say** — a `ConnectionState`.
 *
 * It is a `.model.ts` for the reason §10 gives: there is no DOM test
 * environment in this repository and we may not add one, so every decision
 * worth getting right lives in a pure function over plain objects and
 * {@link ./live} is left with nothing but socket plumbing. Everything here
 * runs under the root `tsconfig.json`, which has no `DOM` lib — hence no
 * `EventSource`, no `MessageEvent`, and `readyState` arriving as a plain
 * number.
 *
 * ## Frames are hints, not deltas
 *
 * §6 is explicit that macOS `fs.watch` coalesces and can drop events, so a
 * frame means "something in this scope moved, re-read it" and never "here is
 * what changed". That single sentence is why {@link planFor} returns *which
 * endpoints to re-request* rather than a patch, and why there is no code here
 * that tries to apply a frame to a graph in place. A client that treated
 * frames as deltas would diverge silently the first time the OS dropped one,
 * and the divergence would be invisible until someone noticed a stale node an
 * hour later.
 *
 * ## Reconnect refetches everything
 *
 * The server keeps **no replay buffer** and ignores `Last-Event-ID` (see the
 * `sse.ts` header). So a reopened stream carries no information about the gap,
 * and the only correct response to "I was away for an unknown interval" is to
 * re-request everything. That is what {@link reduceLive} produces for a
 * reopen, and it is cheap rather than wasteful: the graph request carries
 * `If-None-Match`, so an unchanged workspace costs one `304` with an empty
 * body. Buffering would add retention, eviction and a resume path to arrive
 * at the same fetch.
 */

import type { ChangeEvent, ChangeScope } from "../shared/wire";
import { isChangeEvent } from "../shared/wire";
import type { ConnectionState } from "./state";

/** The SSE endpoint (§5.3). */
export const EVENTS_PATH = "/events";

// --- `EventSource.readyState`, without the DOM lib ------------------------------

/**
 * The three `readyState` values, restated as local constants.
 *
 * `EventSource.CONNECTING` and friends are DOM globals and this module is
 * compiled by a project with no `DOM` lib, so the numbers are written down
 * here. They are fixed by the HTML specification and cannot drift — unlike,
 * say, an HTTP status, there is no version of the standard in which `CLOSED`
 * stops being `2`.
 */
export const SOCKET_CONNECTING = 0;
export const SOCKET_OPEN = 1;
export const SOCKET_CLOSED = 2;

// --- refetch plans ---------------------------------------------------------------

/**
 * Which endpoints a transition invalidates.
 *
 * Two booleans rather than a set of route names, because at P1 there are
 * exactly two things the shell holds: the graph payload and the selected
 * note's body. This will grow — P2 adds the `.okf` file view and the tag
 * index — and the honest thing is to let it grow then rather than to invent a
 * registry now for endpoints that do not exist.
 */
export interface RefetchPlan {
  /** Re-request `GET /api/graph`, conditionally on the held stamp. */
  readonly graph: boolean;
  /** Re-request `GET /api/note/:slug` for the current selection. */
  readonly note: boolean;
}

/** Nothing to do. Returned for a deduped frame and for an idle transition. */
export const NO_REFETCH: RefetchPlan = { graph: false, note: false };

/** Whether a plan would issue no requests at all. */
export function isNoop(plan: RefetchPlan): boolean {
  return !plan.graph && !plan.note;
}

/**
 * Scope → what it can possibly have invalidated.
 *
 * The table is deliberately thin, and worth stating plainly rather than
 * dressing up: **every** scope invalidates the graph, because the graph
 * carries the vault's notes, the repository index *and* the git-state node
 * plus its staleness report. The one real distinction is the note body — a
 * `repo` or `git` change cannot alter the text of a note on disk, so the note
 * column is left alone, while a `vault` change can and must re-read it.
 *
 * Inventing finer granularity here would be fiction. When P2 gives the client
 * more than two things to hold, this table earns more rows.
 *
 * @param hasSelection whether a note is currently open in the note column;
 *   with nothing selected there is no note to refetch.
 */
export function planFor(scope: ChangeScope, hasSelection: boolean): RefetchPlan {
  return { graph: true, note: scope === "vault" && hasSelection };
}

/**
 * The "I have been away" plan: everything the client holds.
 *
 * Used for a reopened stream and for the header's manual `⟳`. Both mean the
 * same thing — the client cannot reason about what it missed — so they get
 * the same answer rather than two subtly different ones.
 */
export function planForEverything(hasSelection: boolean): RefetchPlan {
  return { graph: true, note: hasSelection };
}

// --- state --------------------------------------------------------------------------

/**
 * Everything the liveness layer remembers.
 *
 * `stamp` is the dedupe key and doubles as the `If-None-Match` value the
 * shell sends. It is kept across a disconnect on purpose: a reconnect
 * refetches everything, but it refetches *conditionally*, so holding the last
 * known stamp turns "refetch everything" into a `304` whenever nothing
 * actually moved while we were away.
 */
export interface LiveState {
  readonly connection: ConnectionState;
  /** Last stamp the client has applied, or `null` before the first graph. */
  readonly stamp: string | null;
  /**
   * Whether the stream has ever been open.
   *
   * The discriminator between "first connect" and "reconnect", which is the
   * only reason this flag exists. The first open needs no forced refetch —
   * the shell fetches the graph on mount — while every later open does.
   */
  readonly opened: boolean;
}

/** Before the socket is created. Matches `state.ts`'s documented defaults. */
export function initialLiveState(): LiveState {
  return { connection: "live", stamp: null, opened: false };
}

/**
 * Record a stamp the client now holds.
 *
 * Called by the shell after any successful graph fetch, including the one on
 * mount. That seeding is what makes the server's hello frame free: `sse.ts`
 * sends the current stamp to every newly attached client, and a client that
 * already fetched that stamp at mount would otherwise treat it as news and
 * fetch a second time.
 *
 * The race is still possible — the hello frame can beat the mount fetch — and
 * it is deliberately not defended against. Losing it costs one conditional
 * GET that answers `304`, and the machinery to prevent that would be worth
 * more than the request it saves.
 */
export function withStamp(state: LiveState, stamp: string): LiveState {
  return state.stamp === stamp ? state : { ...state, stamp };
}

// --- events -------------------------------------------------------------------------

/**
 * What can happen to the stream.
 *
 * `error` carries the socket's `readyState` because that is the *only* way to
 * tell the two failures apart: `EventSource` fires the same `error` event
 * when it is about to retry (`CONNECTING`) and when it has given up
 * (`CLOSED`). Reading the flag is not an optimisation — without it the status
 * bar cannot distinguish "back in a moment" from "this session is over", and
 * would have to pick one and be wrong half the time.
 */
export type LiveEvent =
  | { readonly type: "open" }
  | { readonly type: "error"; readonly readyState: number }
  | { readonly type: "frame"; readonly event: ChangeEvent }
  /** The header's `⟳`. Not a socket event; refetches without touching state. */
  | { readonly type: "refresh" }
  /** The client closed the stream itself — navigation, or `stop()`. */
  | { readonly type: "closed" };

/** The result of one transition: the next state, and what to go and fetch. */
export interface LiveTransition {
  readonly state: LiveState;
  readonly plan: RefetchPlan;
}

/**
 * Map a socket `readyState` at the moment of an error to a status.
 *
 * `CLOSED` is terminal: `EventSource` only reaches it after it has stopped
 * retrying, so `"offline"` is a statement of fact rather than a guess. Any
 * other value means a retry is scheduled, which is `"reconnecting"`. An
 * unrecognised number lands there too — the safe direction, because a status
 * bar that says "reconnecting" while the client is in fact dead is a smaller
 * lie than one that says "offline" while a retry is in flight, and the next
 * `open` or `error` corrects it either way.
 */
export function connectionForError(readyState: number): ConnectionState {
  return readyState === SOCKET_CLOSED ? "offline" : "reconnecting";
}

/**
 * The whole liveness state machine.
 *
 * @param hasSelection whether the note column currently holds a note. Passed
 *   in rather than stored, because it is owned by `selectedId` in
 *   `state.ts` and duplicating it here would create a second copy to keep in
 *   sync — the exact failure §1.3 avoids by having one signal.
 */
export function reduceLive(state: LiveState, event: LiveEvent, hasSelection: boolean): LiveTransition {
  switch (event.type) {
    case "open": {
      // A reopen means an unknown gap: see the module header. The first open
      // is not a gap — nothing preceded it — so it only flips the status.
      const plan = state.opened ? planForEverything(hasSelection) : NO_REFETCH;
      return { state: { ...state, connection: "live", opened: true }, plan };
    }

    case "error":
      return { state: { ...state, connection: connectionForError(event.readyState) }, plan: NO_REFETCH };

    case "frame": {
      // The dedupe that makes the hello frame free, and that absorbs the
      // watcher's debounce emitting two frames for one save. The stamp is a
      // content digest of the graph payload (§5.3), so an identical stamp
      // provably means identical content — which is what entitles this line
      // to skip a refetch. It was `generatedAt` until §15.6, and a timestamp
      // max does *not* carry that guarantee: an edit that did not move the
      // maximum was discarded right here, before the conditional GET that
      // would have caught it ever ran.
      if (event.event.stamp === state.stamp) return { state, plan: NO_REFETCH };
      // The stamp is *not* recorded here. It becomes ours when the refetch it
      // triggers succeeds — recording it now would mean a failed fetch left
      // the client believing it holds data it never received, and the next
      // frame carrying the same stamp would be deduped away.
      return { state: { ...state, connection: "live" }, plan: planFor(event.event.scope, hasSelection) };
    }

    case "refresh":
      return { state, plan: planForEverything(hasSelection) };

    case "closed":
      return { state: { ...state, connection: "offline" }, plan: NO_REFETCH };
  }
}

// --- frame decoding ------------------------------------------------------------------

/**
 * Decode one SSE `data:` line, or `null`.
 *
 * Total by design. This runs inside a socket callback on bytes that survived
 * a server restart, a proxy and whatever else sits on loopback, so a
 * malformed frame must cost a skipped refetch — never an unhandled rejection
 * that kills the listener and silently ends liveness for the session.
 * {@link isChangeEvent} does the structural half; this adds the `JSON.parse`
 * that can throw.
 */
export function parseFrame(data: string): ChangeEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  return isChangeEvent(parsed) ? parsed : null;
}
