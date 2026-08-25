/**
 * The liveness layer (weave-workspace §6).
 *
 * Two modules under test, and the split between them is the point. Almost
 * everything worth asserting is in `live.model.ts`, which is pure — so the
 * reconnect rule, the dedupe and the three connection states are covered by
 * ordinary function calls with no DOM anywhere. `live.ts` is then thin enough
 * that a nine-line fake `EventSource` reaches every line of it.
 *
 * The rules being pinned, all from §6 and the `sse.ts` header:
 *
 *  - a **reopened** stream refetches everything, because the server keeps no
 *    replay buffer and the client cannot know what it missed;
 *  - the **first** open does not, because the shell already fetched on mount;
 *  - a frame whose stamp the client already holds is dropped;
 *  - a frame's stamp is only recorded once the refetch it caused succeeded;
 *  - `error` distinguishes "retrying" from "given up" by `readyState`.
 */

import { describe, expect, it } from "vitest";
import {
  EVENTS_PATH,
  NO_REFETCH,
  SOCKET_CLOSED,
  SOCKET_CONNECTING,
  SOCKET_OPEN,
  connectionForError,
  initialLiveState,
  isNoop,
  parseFrame,
  planFor,
  planForEverything,
  reduceLive,
  withStamp,
} from "../../src/web/client/live.model";
import type { LiveState, RefetchPlan } from "../../src/web/client/live.model";
import { domEventSource, startLive } from "../../src/web/client/live";
import type { EventSourceLike } from "../../src/web/client/live";
import { connection } from "../../src/web/client/state";
import { CHANGE_EVENT_NAME, CHANGE_SCOPES } from "../../src/web/shared/wire";
import type { ChangeEvent } from "../../src/web/shared/wire";

// --- helpers -------------------------------------------------------------------

function frame(scope: ChangeEvent["scope"], stamp: string): ChangeEvent {
  return { scope, stamp };
}

/** A state that has been open at least once — i.e. a later `open` is a reopen. */
function established(stamp: string | null = "s1"): LiveState {
  return { connection: "live", stamp, opened: true };
}

// --- plans ---------------------------------------------------------------------

describe("refetch plans", () => {
  it("treats every scope as invalidating the graph", () => {
    // Not a simplification to be tidied later: the graph payload carries the
    // vault's notes, the repo index and the git-state node, so all three
    // scopes can move it. See the table's own comment.
    for (const scope of CHANGE_SCOPES) {
      expect(planFor(scope, false).graph).toBe(true);
    }
  });

  it("refetches the note body only for a vault change with a note open", () => {
    expect(planFor("vault", true)).toEqual({ graph: true, note: true });
    expect(planFor("vault", false)).toEqual({ graph: true, note: false });
    // A repo scan or a git checkout cannot rewrite a note's text on disk.
    expect(planFor("repo", true).note).toBe(false);
    expect(planFor("git", true).note).toBe(false);
  });

  it("planForEverything includes the note only when one is open", () => {
    expect(planForEverything(true)).toEqual({ graph: true, note: true });
    expect(planForEverything(false)).toEqual({ graph: true, note: false });
  });

  it("isNoop recognises the empty plan and nothing else", () => {
    expect(isNoop(NO_REFETCH)).toBe(true);
    expect(isNoop({ graph: true, note: false })).toBe(false);
    expect(isNoop({ graph: false, note: true })).toBe(false);
  });
});

// --- connection classification -------------------------------------------------

describe("connectionForError", () => {
  it("is offline only once the socket has actually given up", () => {
    expect(connectionForError(SOCKET_CLOSED)).toBe("offline");
  });

  it("is reconnecting while a retry is still possible", () => {
    expect(connectionForError(SOCKET_CONNECTING)).toBe("reconnecting");
    expect(connectionForError(SOCKET_OPEN)).toBe("reconnecting");
  });

  it("degrades an unknown readyState to reconnecting, not offline", () => {
    // The smaller lie: a retry in flight while we claim to be dead would
    // strand the UI, and the next open/error corrects the optimistic guess.
    expect(connectionForError(99)).toBe("reconnecting");
  });
});

// --- the state machine ----------------------------------------------------------

describe("initialLiveState", () => {
  it("assumes live, holds no stamp, and has never been open", () => {
    expect(initialLiveState()).toEqual({ connection: "live", stamp: null, opened: false });
  });
});

describe("reduceLive — open", () => {
  it("does not refetch on the first open: the shell already fetched on mount", () => {
    const out = reduceLive(initialLiveState(), { type: "open" }, false);
    expect(out.plan).toEqual(NO_REFETCH);
    expect(out.state.opened).toBe(true);
    expect(out.state.connection).toBe("live");
  });

  it("refetches EVERYTHING on a reopen — §6, the server has no replay buffer", () => {
    const out = reduceLive(established(), { type: "open" }, true);
    expect(out.plan).toEqual({ graph: true, note: true });
    expect(out.state.connection).toBe("live");
  });

  it("keeps the held stamp across a reconnect, so the refetch can be a 304", () => {
    const out = reduceLive({ connection: "reconnecting", stamp: "s7", opened: true }, { type: "open" }, false);
    expect(out.state.stamp).toBe("s7");
    expect(out.plan.graph).toBe(true);
  });

  it("clears a reconnecting status", () => {
    const out = reduceLive({ connection: "reconnecting", stamp: null, opened: true }, { type: "open" }, false);
    expect(out.state.connection).toBe("live");
  });
});

describe("reduceLive — error", () => {
  it("goes reconnecting while the browser is retrying, and fetches nothing", () => {
    const out = reduceLive(established(), { type: "error", readyState: SOCKET_CONNECTING }, true);
    expect(out.state.connection).toBe("reconnecting");
    expect(out.plan).toEqual(NO_REFETCH);
  });

  it("goes offline when the socket is closed", () => {
    const out = reduceLive(established(), { type: "error", readyState: SOCKET_CLOSED }, true);
    expect(out.state.connection).toBe("offline");
  });

  it("leaves `opened` set, so the eventual recovery is treated as a reopen", () => {
    const errored = reduceLive(established(), { type: "error", readyState: SOCKET_CONNECTING }, false);
    expect(errored.state.opened).toBe(true);
    const recovered = reduceLive(errored.state, { type: "open" }, false);
    expect(recovered.plan.graph).toBe(true);
  });
});

describe("reduceLive — frame", () => {
  it("refetches on a new stamp", () => {
    const out = reduceLive(established("s1"), { type: "frame", event: frame("vault", "s2") }, true);
    expect(out.plan).toEqual({ graph: true, note: true });
  });

  it("drops a frame carrying the stamp the client already holds", () => {
    // The server sends the current stamp to every newly attached client, and
    // the watcher's debounce can emit two frames for one save. Both are this
    // branch.
    const state = established("s1");
    const out = reduceLive(state, { type: "frame", event: frame("vault", "s1") }, true);
    expect(out.plan).toEqual(NO_REFETCH);
    expect(out.state).toBe(state);
  });

  it("does NOT record the stamp until the refetch it triggered succeeded", () => {
    // Recording on receipt would make a failed fetch permanent: the client
    // would believe it holds data it never got, and dedupe away the next
    // frame that would have corrected it.
    const out = reduceLive(established("s1"), { type: "frame", event: frame("vault", "s2") }, false);
    expect(out.state.stamp).toBe("s1");
  });

  it("proves the socket is alive, so it clears a reconnecting status", () => {
    const out = reduceLive(
      { connection: "reconnecting", stamp: null, opened: true },
      { type: "frame", event: frame("repo", "s3") },
      false,
    );
    expect(out.state.connection).toBe("live");
  });

  it("refetches on the very first frame, when no stamp is held", () => {
    const out = reduceLive(initialLiveState(), { type: "frame", event: frame("git", "s1") }, false);
    expect(out.plan).toEqual({ graph: true, note: false });
  });
});

describe("reduceLive — refresh and closed", () => {
  it("refresh refetches everything without altering the state", () => {
    const state = established("s4");
    const out = reduceLive(state, { type: "refresh" }, true);
    expect(out.plan).toEqual({ graph: true, note: true });
    expect(out.state).toBe(state);
  });

  it("closed is terminal and fetches nothing", () => {
    const out = reduceLive(established(), { type: "closed" }, true);
    expect(out.state.connection).toBe("offline");
    expect(out.plan).toEqual(NO_REFETCH);
  });
});

describe("withStamp", () => {
  it("records a new stamp", () => {
    expect(withStamp(initialLiveState(), "s1").stamp).toBe("s1");
  });

  it("returns the same object for an unchanged stamp, so subscribers stay quiet", () => {
    const state = established("s1");
    expect(withStamp(state, "s1")).toBe(state);
  });

  it("preserves the rest of the state", () => {
    const out = withStamp({ connection: "reconnecting", stamp: "a", opened: true }, "b");
    expect(out).toEqual({ connection: "reconnecting", stamp: "b", opened: true });
  });
});

// --- frame decoding ---------------------------------------------------------------

describe("parseFrame", () => {
  it("decodes a well-formed frame", () => {
    expect(parseFrame('{"scope":"vault","stamp":"s1"}')).toEqual({ scope: "vault", stamp: "s1" });
  });

  it("accepts every declared scope", () => {
    for (const scope of CHANGE_SCOPES) {
      expect(parseFrame(JSON.stringify({ scope, stamp: "s" }))?.scope).toBe(scope);
    }
  });

  it("returns null rather than throwing on junk", () => {
    // A socket callback that throws kills liveness for the whole session.
    for (const bad of ["", "not json", "{", "null", "[]", "3"]) {
      expect(parseFrame(bad)).toBeNull();
    }
  });

  it("rejects JSON that is valid but not ours", () => {
    expect(parseFrame('{"scope":"nope","stamp":"s"}')).toBeNull();
    expect(parseFrame('{"scope":"vault"}')).toBeNull();
    expect(parseFrame('{"stamp":"s"}')).toBeNull();
    expect(parseFrame('{"scope":"vault","stamp":7}')).toBeNull();
  });
});

// --- the socket wiring ---------------------------------------------------------------

/** A recording `EventSource` double. No DOM, no jsdom. */
function fakeSource(): EventSourceLike & {
  emit(data: string): void;
  fire(type: "open" | "error"): void;
  setReadyState(value: number): void;
  readonly closes: number;
} {
  const listeners = new Map<string, Array<(event: { data: string }) => void>>();
  let readyState = SOCKET_CONNECTING;
  let closes = 0;
  return {
    get readyState() {
      return readyState;
    },
    addEventListener(type: string, listener: (event: { data: string }) => void) {
      const existing = listeners.get(type);
      if (existing === undefined) listeners.set(type, [listener]);
      else existing.push(listener);
    },
    close() {
      closes += 1;
      readyState = SOCKET_CLOSED;
    },
    emit(data: string) {
      for (const listener of listeners.get(CHANGE_EVENT_NAME) ?? []) listener({ data });
    },
    fire(type: "open" | "error") {
      for (const listener of listeners.get(type) ?? []) listener({ data: "" });
    },
    setReadyState(value: number) {
      readyState = value;
    },
    get closes() {
      return closes;
    },
  };
}

/** Start a live handle over a fake socket, recording the plans it requests. */
function harness(hasSelection = false) {
  const source = fakeSource();
  const plans: RefetchPlan[] = [];
  const urls: string[] = [];
  const handle = startLive({
    open: (url) => {
      urls.push(url);
      return source;
    },
    refetch: (plan) => plans.push(plan),
    hasSelection: () => hasSelection,
  });
  return { source, plans, urls, handle };
}

describe("startLive", () => {
  it("opens the §5.3 events endpoint by default", () => {
    const { urls } = harness();
    expect(urls).toEqual([EVENTS_PATH]);
  });

  it("honours an injected path", () => {
    const urls: string[] = [];
    startLive({
      open: (url) => {
        urls.push(url);
        return fakeSource();
      },
      refetch: () => {},
      hasSelection: () => false,
      path: "/custom",
    });
    expect(urls).toEqual(["/custom"]);
  });

  it("publishes the connection state to the signal the status bar reads", () => {
    const { source, handle } = harness();
    source.fire("open");
    expect(connection.value).toBe("live");

    source.setReadyState(SOCKET_CONNECTING);
    source.fire("error");
    expect(connection.value).toBe("reconnecting");

    source.setReadyState(SOCKET_CLOSED);
    source.fire("error");
    expect(connection.value).toBe("offline");

    handle.stop();
    connection.value = "live";
  });

  it("refetches on a reopen but not on the first open", () => {
    const { source, plans, handle } = harness();
    source.fire("open");
    expect(plans).toEqual([]);

    source.setReadyState(SOCKET_CONNECTING);
    source.fire("error");
    source.fire("open");
    expect(plans).toEqual([{ graph: true, note: false }]);

    handle.stop();
    connection.value = "live";
  });

  it("routes a decoded frame into a refetch", () => {
    const { source, plans, handle } = harness(true);
    source.emit(JSON.stringify({ scope: "vault", stamp: "s1" }));
    expect(plans).toEqual([{ graph: true, note: true }]);
    handle.stop();
    connection.value = "live";
  });

  it("ignores a malformed frame without disturbing the connection", () => {
    const { source, plans, handle } = harness();
    source.fire("open");
    source.emit("}{ not json");
    expect(plans).toEqual([]);
    expect(connection.value).toBe("live");
    handle.stop();
    connection.value = "live";
  });

  it("dedupes a frame whose stamp `seen` already recorded", () => {
    const { source, plans, handle } = harness();
    handle.seen("s1");
    source.emit(JSON.stringify({ scope: "vault", stamp: "s1" }));
    expect(plans).toEqual([]);

    source.emit(JSON.stringify({ scope: "vault", stamp: "s2" }));
    expect(plans).toHaveLength(1);
    handle.stop();
    connection.value = "live";
  });

  it("refresh() forces a full refetch", () => {
    const { plans, handle } = harness(true);
    handle.refresh();
    expect(plans).toEqual([{ graph: true, note: true }]);
    handle.stop();
    connection.value = "live";
  });

  it("stop() closes the socket, goes offline, and is idempotent", () => {
    const { source, handle } = harness();
    handle.stop();
    handle.stop();
    expect(source.closes).toBe(1);
    expect(connection.value).toBe("offline");
    expect(handle.state().connection).toBe("offline");
    connection.value = "live";
  });

  it("exposes the state it is reducing", () => {
    const { source, handle } = harness();
    expect(handle.state().opened).toBe(false);
    source.fire("open");
    expect(handle.state().opened).toBe(true);
    handle.seen("s9");
    expect(handle.state().stamp).toBe("s9");
    handle.stop();
    connection.value = "live";
  });

  it("reads hasSelection fresh on every event rather than caching it", () => {
    // The selection lives in `selectedId`; a cached copy here would be a
    // second source of truth, which is what §1.3's single signal avoids.
    const source = fakeSource();
    const plans: RefetchPlan[] = [];
    let selected = false;
    const handle = startLive({
      open: () => source,
      refetch: (plan) => plans.push(plan),
      hasSelection: () => selected,
    });

    source.emit(JSON.stringify({ scope: "vault", stamp: "s1" }));
    expect(plans[0]?.note).toBe(false);

    selected = true;
    source.emit(JSON.stringify({ scope: "vault", stamp: "s2" }));
    expect(plans[1]?.note).toBe(true);

    handle.stop();
    connection.value = "live";
  });
});

describe("domEventSource", () => {
  it("constructs the platform EventSource", () => {
    // There is no DOM here, so the assertion is that the factory delegates to
    // the global rather than that a socket opens. Stubbing the global proves
    // the delegation without a browser — the one line in the liveness layer
    // that names a DOM API.
    const globals = globalThis as { EventSource?: unknown };
    const original = globals.EventSource;
    const seen: string[] = [];
    class StubEventSource {
      readyState = SOCKET_CONNECTING;
      constructor(url: string) {
        seen.push(url);
      }
      addEventListener(): void {}
      close(): void {}
    }
    globals.EventSource = StubEventSource;
    try {
      const source = domEventSource("/events");
      expect(seen).toEqual(["/events"]);
      expect(source.readyState).toBe(SOCKET_CONNECTING);
    } finally {
      if (original === undefined) delete globals.EventSource;
      else globals.EventSource = original;
    }
  });
});
