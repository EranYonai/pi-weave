/**
 * The editor's effects: three requests and an unload listener
 * (weave-workspace §10, §11 P5).
 *
 * `editor.model.ts` decides *whether* to save, *what* to send and *what a
 * response means*; it cannot issue a request or subscribe to `beforeunload`
 * without ceasing to be pure. This is the other half — a controller whose
 * every capability is injected, in the shape `search.ts` established.
 *
 * ## Why `editor.controller.ts` and not `editor.ts`
 *
 * The pairing everywhere else in the client is `x.model.ts` + `x.ts`
 * (`search.model.ts`/`search.ts`, `live.model.ts`/`live.ts`), and that is the
 * name this file wanted. It cannot have it: the component beside it is
 * `Editor.tsx`, and on a case-insensitive filesystem — which is the macOS
 * default — `editor.ts` and `Editor.tsx` are the same path prefix. TypeScript
 * says so directly (`TS1149: File name … differs from already included file
 * name … only in casing`) and the build is a hard error rather than a
 * warning. Renaming the *component* instead would break the `.tsx` = view
 * convention the whole client is read by, so the controller takes the longer
 * name. The capabilities it needs are:
 *
 *  - a **`FetchLike`**, the same port `api.ts` takes, so no DOM is involved;
 *  - a **`select`**, so completing a parked navigation goes through §1.3's
 *    context bus rather than this module knowing what a selection is.
 *
 * The result is that the editor's whole asynchronous behaviour — the save
 * round trip, the `409`, the stale-response guard, the unload block — is
 * covered by ordinary unit tests, and `Editor.tsx` is a `<textarea>` and
 * three handlers.
 *
 * ## Why the controller owns the dispatch loop
 *
 * Every event goes through {@link EditorHandle.send}, which reduces,
 * publishes, and then performs whichever effect the transition asked for.
 * There is no other path that mutates state. That is what makes "a save
 * cannot start while a conflict is unresolved" and "a stale response cannot
 * overwrite the draft" enforceable: the checks live in the reducer, and every
 * response arrives back through here.
 */

import type { FetchLike } from "../api";
import { openNote, saveNote } from "../api";
import type { EditorEffect, EditorEvent, EditorState } from "./editor.model";
import { initialEditorState, reduceEditor, shouldBlockUnload } from "./editor.model";

/**
 * The slice of `beforeunload` this module touches.
 *
 * Structural, and `returnValue` is included because that is the only form
 * every browser still honours: `preventDefault()` alone is the spec's answer
 * and Chrome ignored it for years. Setting both is the portable spelling.
 */
export interface BeforeUnloadEventLike {
  preventDefault(): void;
  returnValue?: unknown;
}

/** The slice of `window` the unload guard subscribes to. */
export interface UnloadHost {
  addEventListener(type: "beforeunload", listener: (event: BeforeUnloadEventLike) => void): void;
  removeEventListener(type: "beforeunload", listener: (event: BeforeUnloadEventLike) => void): void;
}

/** What {@link createEditor} needs. Every capability injected. */
export interface EditorOptions {
  fetch: FetchLike;
  /** The §1.3 context bus. Called to complete a navigation the editor held. */
  select: (id: string | null) => void;
  /** Called after every state change, so the component can re-render. */
  onChange: (state: EditorState) => void;
}

/** A running editor. */
export interface EditorHandle {
  /** Current state. Read at render. */
  state(): EditorState;
  /** Dispatch an event. The only way state moves. */
  send(event: EditorEvent): void;
}

export function createEditor(opts: EditorOptions): EditorHandle {
  let state = initialEditorState();

  const send = (event: EditorEvent): void => {
    const next = reduceEditor(state, event);
    state = next.state;
    opts.onChange(state);
    if (next.effect !== null) perform(next.effect);
  };

  const perform = (effect: EditorEffect): void => {
    if (effect.type === "select") {
      opts.select(effect.id);
      return;
    }
    // Fire and forget: `api.ts` returns failures as values, so there is
    // nothing to reject and nothing to catch. `void` documents the floating
    // promise rather than hiding it — the same shape `workspace.ts` and
    // `search.ts` use.
    if (effect.type === "open") {
      void (async () => {
        const result = await openNote(opts.fetch, effect.slug);
        send({ type: "opened", ok: result.ok && result.data.opened });
      })();
      return;
    }
    void (async () => {
      const result = await saveNote(opts.fetch, effect.slug, effect.input);
      if (result.ok) {
        send({ type: "saved", payload: result.data });
        return;
      }
      // The `409` is not an error in the sense the other five kinds are —
      // it is the server handing back the information the user needs in
      // order to choose. `api.ts` gives it its own arm for exactly this
      // branch.
      send(result.kind === "conflict" ? { type: "conflicted", conflict: result.conflict } : { type: "failed", message: result.message });
    })();
  };

  return { state: () => state, send };
}

/**
 * Block `beforeunload` while the draft is dirty. Returns an unsubscribe.
 *
 * The predicate is a thunk, not a value: a listener registered at mount
 * outlives every render, so a captured state would answer with the editor as
 * it was when the tab opened — which is always clean, making the guard a
 * no-op that looks installed.
 *
 * No custom message: every browser has ignored the string since 2017 and
 * shows its own wording. Returning one would be writing code whose only
 * effect is to suggest, to the next reader, that it does something.
 */
export function watchUnload(host: UnloadHost, dirty: () => boolean): () => void {
  const listener = (event: BeforeUnloadEventLike): void => {
    if (!dirty()) return;
    event.preventDefault();
    // The legacy half. Chrome required a truthy `returnValue` long after the
    // spec settled on `preventDefault`, and setting both is the only
    // spelling that works everywhere.
    event.returnValue = "";
  };
  host.addEventListener("beforeunload", listener);
  return () => host.removeEventListener("beforeunload", listener);
}

/** {@link shouldBlockUnload}, re-exported so the shell imports one module. */
export { shouldBlockUnload };
