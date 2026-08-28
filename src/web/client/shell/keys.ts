/**
 * The global key subscription (weave-workspace §11 P4, §10).
 *
 * `keys.model.ts` decides what a keystroke means; this attaches one listener
 * and performs the answer. Four lines of it are the listener and the rest is
 * dispatch, which is deliberate — the same split `viewport.ts` uses, and for
 * the same reason: a subscription written inline in a `useEffect` is one no
 * test can reach.
 *
 * ## One listener, on the document, at the bubble phase
 *
 * Not capture. The bubble phase runs *after* the element under focus has had
 * the event, so the tree's own `onKeyDown` claims `ArrowDown` before this
 * ever sees it and the palette claims `Enter` before this does. That ordering
 * is what lets both handlers stay simple: neither needs to know the other
 * exists, because the local one goes first and the global one is the
 * fallback. Capture would invert it and every column-level key would need an
 * exception here.
 *
 * `preventDefault` is called **only** for a keystroke that produced an
 * action. Everything else — Tab, ⌘R, ⌘L, typing — passes through untouched,
 * which is `treeKey`'s `handled: false` contract at the document level.
 */

import type { KeyContext, KeyboardEventLike, ShellAction } from "./keys.model";
import { describeKey, shellKey } from "./keys.model";

/** The slice of `document` this module subscribes to. */
export interface KeyHost {
  addEventListener(type: "keydown", listener: (event: KeyboardEventLike) => void): void;
  removeEventListener(type: "keydown", listener: (event: KeyboardEventLike) => void): void;
}

/** What {@link watchKeys} needs. */
export interface KeyOptions {
  /** Read fresh per keystroke — the overlay and the selection both move. */
  context: () => KeyContext;
  run: (action: ShellAction) => void;
}

/**
 * Listen for global shortcuts. Returns an unsubscribe.
 *
 * The context is a **thunk**, not a value. A listener registered at mount
 * outlives every render, so a captured `{overlay, hasSelection}` would answer
 * with the state as it was at mount — the palette would never see itself as
 * open, and `⌘K` would stack overlays. The same `live.current` reasoning
 * `Shell.tsx` and `Graph.tsx` apply to their long-lived handlers.
 */
export function watchKeys(host: KeyHost, opts: KeyOptions): () => void {
  const listener = (event: KeyboardEventLike): void => {
    const action = shellKey(describeKey(event), opts.context());
    if (action === null) return;
    event.preventDefault();
    opts.run(action);
  };
  host.addEventListener("keydown", listener);
  return () => host.removeEventListener("keydown", listener);
}
