/**
 * The palette's effects: a timer, a fetch, and nothing else
 * (weave-workspace §10, P4).
 *
 * `search.model.ts` decides *when* to issue a request and *whether* a
 * response may be applied; it cannot arm a timer or call `fetch` without
 * ceasing to be pure. This module is the other half — a controller that owns
 * exactly two capabilities, both injected:
 *
 *  - a **clock** (`now`) and a **scheduler** (`delay`), so the 140 ms debounce
 *    is exercised by a fake in microseconds rather than waited out;
 *  - a **`FetchLike`**, the same port `api.ts` takes, so no DOM is involved.
 *
 * The result is that the palette's entire asynchronous behaviour — debounce,
 * re-arm, stale-response rejection, failure — is covered by ordinary unit
 * tests, and `SearchPalette.tsx` is a `useState`, an effect and three
 * handlers. That is §10's split applied to the one part of the workspace that
 * is genuinely concurrent.
 *
 * ## Why the controller and not the component owns the sequence number
 *
 * A component could hold `seq` in a ref and compare on arrival. It would also
 * be re-created by every hot reload, remounted by every breakpoint change,
 * and untestable. Keeping the counter inside {@link SearchState}, where the
 * reducer can reason about it, means "an older response must not overwrite a
 * newer one" is a property with a test rather than a comment.
 */

import type { FetchLike } from "../api";
import { fetchSearch } from "../api";
import type { SearchEvent, SearchState, SearchTransition } from "./search.model";
import { initialSearchState, reduceSearch } from "./search.model";

/**
 * Arms a one-shot timer and returns nothing.
 *
 * Deliberately *not* returning a cancel handle: the debounce in
 * `reduceSearch` is a re-arming chain precisely so that nothing ever needs
 * cancelling, and a cancel handle here would invite a second, competing
 * mechanism. `(fn, ms) => void setTimeout(fn, ms)` at the call site; a queue
 * a test drains by hand in a test.
 */
export type Scheduler = (run: () => void, ms: number) => void;

/** What {@link createSearch} needs. Every capability injected. */
export interface SearchOptions {
  fetch: FetchLike;
  /** Epoch ms. `Date.now` in the browser. */
  now: () => number;
  delay: Scheduler;
  /** Called after every state change, so the component can re-render. */
  onChange: (state: SearchState) => void;
}

/** A running palette controller. */
export interface SearchHandle {
  /** Current state. Read at render. */
  state(): SearchState;
  /** The text changed. */
  setQuery(query: string): void;
  /** Move the cursor — pointer hover, or a key the model resolved to an index. */
  setCursor(cursor: number): void;
  /** The palette closed: disarm the debounce. */
  dismiss(): void;
}

/**
 * Build the controller.
 *
 * One function, one loop: every event goes through {@link dispatch}, which
 * reduces, publishes, and then performs whichever of the two effects the
 * transition asked for. There is no other path that mutates state, which is
 * what makes "a stale response cannot win" enforceable — the check lives in
 * the reducer and every response arrives through here.
 */
export function createSearch(opts: SearchOptions): SearchHandle {
  let state = initialSearchState();

  const dispatch = (event: SearchEvent): void => {
    const next: SearchTransition = reduceSearch(state, event);
    state = next.state;
    opts.onChange(state);

    if (next.schedule !== null) opts.delay(() => dispatch({ type: "tick", now: opts.now() }), next.schedule);

    const request = next.request;
    if (request === null) return;
    // Fire and forget: `api.ts` returns failures as values, so there is
    // nothing to reject and nothing to catch. `void` documents the floating
    // promise rather than hiding it — the same shape `workspace.ts` uses.
    void (async () => {
      const result = await fetchSearch(opts.fetch, request.query);
      dispatch(
        result.ok
          ? { type: "response", seq: request.seq, query: request.query, hits: result.data.hits }
          : { type: "failed", seq: request.seq },
      );
    })();
  };

  return {
    state: () => state,
    setQuery: (query) => dispatch({ type: "query", query, now: opts.now() }),
    setCursor: (cursor) => dispatch({ type: "cursor", cursor }),
    dismiss: () => dispatch({ type: "dismiss" }),
  };
}
