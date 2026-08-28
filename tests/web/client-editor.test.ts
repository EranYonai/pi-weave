/**
 * The note editor (weave-workspace §11 P5.3–P5.4, §10).
 *
 * Every branch in `editor.model.ts` and `editor.controller.ts`, with no DOM
 * and no jsdom — §10 forbids one, and the split that makes this possible is
 * the whole reason the editor's logic is not in `Editor.tsx`.
 *
 * The suite is organised around the thing the editor exists to guarantee:
 * **a user's unsaved text cannot be destroyed without them saying so.** Each
 * block below is one of the ways it could be, and each is a test that it is
 * not:
 *
 *  - another writer overwriting you → the `409`;
 *  - you overwriting another writer → the same `409`, as a choice;
 *  - navigating away → the parked navigation;
 *  - closing the tab → `shouldBlockUnload`;
 *  - an SSE refetch landing mid-sentence → the external marker;
 *  - a slow save's response landing after you typed again → the stale-response
 *    guard.
 *
 * The last one is the subtle one and it gets the most attention, because it
 * is the failure that would look like a bug in the *user's* typing.
 */

import { describe, expect, it } from "vitest";
import type { FetchLike, HttpRequest, HttpResponse } from "../../src/web/client/api";
import type { BeforeUnloadEventLike, UnloadHost } from "../../src/web/client/note/editor.controller";
import { createEditor, watchUnload } from "../../src/web/client/note/editor.controller";
import type { EditorEvent, EditorState } from "../../src/web/client/note/editor.model";
import {
  DISCARD_LABEL,
  EDITOR_PROMPT_KINDS,
  EDIT_LABEL,
  EXTERNAL_MESSAGE,
  KEEP_LABEL,
  OPEN_FAILED_MESSAGE,
  OPENED_MESSAGE,
  OVERWRITE_LABEL,
  READ_LABEL,
  RELOAD_LABEL,
  SAVED_MESSAGE,
  SAVE_LABEL,
  SAVING_LABEL,
  UNSAVED_MESSAGE,
  canSave,
  editorPrompt,
  editorToolbar,
  initialEditorState,
  isDirty,
  reduceEditor,
  shouldBlockUnload,
} from "../../src/web/client/note/editor.model";
import type { ConflictPayload, NotePayload, ViewNote } from "../../src/web/shared/wire";

// --- fixtures -----------------------------------------------------------------------

const NOTE: ViewNote = {
  slug: "alpha",
  title: "Alpha",
  body: "original body",
  created: "2026-01-01T00:00:00Z",
  updated: "2026-01-02T00:00:00Z",
  tags: [],
  source: "human",
};

function payload(over: Partial<ViewNote> = {}, revision = "r1"): NotePayload {
  return { note: { ...NOTE, ...over }, revision };
}

const LOADED = payload();

/** Apply a sequence of events to a fresh state, returning the last transition. */
function run(...events: readonly EditorEvent[]): EditorState {
  let state = initialEditorState();
  for (const event of events) state = reduceEditor(state, event).state;
  return state;
}

/** A loaded note, open in the editor, with `text` typed into it. */
function typing(text: string): EditorState {
  return run({ type: "loaded", payload: LOADED }, { type: "toggle" }, { type: "draft", text });
}

const CONFLICT: ConflictPayload = {
  error: "the note changed on disk since it was read",
  reason: "conflict",
  current: payload({ body: "their text" }, "r9"),
};

const COLLISION: ConflictPayload = { error: "a note with that slug already exists", reason: "collision", slug: "taken" };

// --- loading ------------------------------------------------------------------------

describe("loading a note", () => {
  it("adopts it in read mode, with the body as both baseline and draft", () => {
    const state = run({ type: "loaded", payload: LOADED });
    expect(state).toMatchObject({
      mode: "read",
      slug: "alpha",
      baseline: "original body",
      draft: "original body",
      revision: "r1",
      status: "idle",
    });
    expect(isDirty(state)).toBe(false);
  });

  it("opens a *different* note in read mode, even from inside the editor", () => {
    // Read is the honest default for a document the user has not said they
    // want to change. Reaching here with unsaved work is impossible — that is
    // what the `navigate` guard is for.
    const state = run(
      { type: "loaded", payload: LOADED },
      { type: "toggle" },
      { type: "loaded", payload: payload({ slug: "beta" }, "r2") },
    );
    expect(state.mode).toBe("read");
    expect(state.slug).toBe("beta");
  });

  it("keeps the editor open when the *same* note is refetched", () => {
    // A refetch triggered by our own save, or by an unrelated SSE frame,
    // must not eject the user out of the editor they had open.
    const state = run({ type: "loaded", payload: LOADED }, { type: "toggle" }, { type: "loaded", payload: payload({}, "r2") });
    expect(state.mode).toBe("edit");
    expect(state.revision).toBe("r2");
  });

  it("clears everything when the selection stops naming a note", () => {
    const state = run({ type: "loaded", payload: LOADED }, { type: "toggle" }, { type: "cleared" });
    expect(state).toEqual(initialEditorState());
  });
});

// --- the SSE-while-editing decision (§6) -----------------------------------------------

describe("a note changes on disk while it is being edited", () => {
  it("keeps the draft and records the newer version rather than applying it", () => {
    // Policy (3) of the three in `editor.model.ts`'s header. Overwriting the
    // draft would destroy unsaved work in response to a background event the
    // user did not cause; a modal would steal focus mid-sentence.
    const state = reduceEditor(typing("my unsaved paragraph"), {
      type: "loaded",
      payload: payload({ body: "their text" }, "r9"),
    }).state;
    expect(state.draft).toBe("my unsaved paragraph");
    expect(state.baseline).toBe("original body");
    // Still saving against the revision we read — which is what makes the
    // next `⌘S` produce the 409 that is the actual guarantee. The passive
    // marker is an early warning; it is deliberately *not* load-bearing.
    expect(state.revision).toBe("r1");
    expect(state.external?.revision).toBe("r9");
  });

  it("adopts the same load silently when the draft is clean", () => {
    // Nothing to protect. A "changed on disk" badge over a document the user
    // is only reading is noise.
    const state = run(
      { type: "loaded", payload: LOADED },
      { type: "toggle" },
      { type: "loaded", payload: payload({ body: "their text" }, "r9") },
    );
    expect(state.draft).toBe("their text");
    expect(state.external).toBeNull();
  });

  it("adopts a load carrying the revision we already hold, even when dirty", () => {
    // Our own save's refetch. The revision matches, so there is no external
    // writer and no reason to mark one.
    const state = reduceEditor(typing("mine"), { type: "loaded", payload: payload({ body: "mine" }, "r1") }).state;
    expect(state.external).toBeNull();
    expect(state.draft).toBe("mine");
  });

  it("offers the newer version through the same reload the 409 uses", () => {
    const marked = reduceEditor(typing("mine"), { type: "loaded", payload: payload({ body: "theirs" }, "r9") }).state;
    const reloaded = reduceEditor(marked, { type: "reload" }).state;
    expect(reloaded.draft).toBe("theirs");
    expect(reloaded.revision).toBe("r9");
    expect(reloaded.external).toBeNull();
    // Still in the editor: taking the disk version is not a reason to close
    // the thing the user was working in.
    expect(reloaded.mode).toBe("edit");
  });

  it("dismissing the marker leaves the draft and the stale revision alone", () => {
    // Which means the next save still conflicts — correct, because nothing
    // has been resolved.
    const marked = reduceEditor(typing("mine"), { type: "loaded", payload: payload({}, "r9") }).state;
    const dismissed = reduceEditor(marked, { type: "dismiss" }).state;
    expect(dismissed.draft).toBe("mine");
    expect(dismissed.revision).toBe("r1");
    expect(dismissed.external).toBeNull();
  });
});

// --- the mode toggle ------------------------------------------------------------------

describe("⌘E", () => {
  it("enters the editor with the draft reset to what is on disk", () => {
    const state = run({ type: "loaded", payload: LOADED }, { type: "toggle" });
    expect(state.mode).toBe("edit");
    expect(state.draft).toBe("original body");
  });

  it("does nothing with no note loaded", () => {
    // A textarea over an empty column would present a save with no slug to
    // go to.
    expect(run({ type: "toggle" })).toEqual(initialEditorState());
  });

  it("leaves the editor when the draft is clean", () => {
    const state = run({ type: "loaded", payload: LOADED }, { type: "toggle" }, { type: "toggle" });
    expect(state.mode).toBe("read");
  });

  it("refuses to leave the editor with unsaved changes, and says why", () => {
    // The same loss `navigate` guards against, arriving by a different key.
    const state = reduceEditor(typing("unsaved"), { type: "toggle" }).state;
    expect(state.mode).toBe("edit");
    expect(state.message).toBe(UNSAVED_MESSAGE);
    expect(state.status).toBe("error");
    expect(state.draft).toBe("unsaved");
  });
});

// --- dirtiness ------------------------------------------------------------------------

describe("dirtiness", () => {
  it("is false in read mode even when the draft differs", () => {
    // In read mode the draft is a stale copy nobody is typing into. Treating
    // a difference as unsaved work would block navigation for a user who has
    // edited nothing — the most annoying possible false positive.
    const state = { ...run({ type: "loaded", payload: LOADED }), draft: "different" };
    expect(isDirty(state)).toBe(false);
  });

  it("is true only when the text actually differs", () => {
    expect(isDirty(typing("changed"))).toBe(true);
    expect(isDirty(typing("original body"))).toBe(false);
  });

  it("gates saving on dirtiness, a slug, and no save already in flight", () => {
    expect(canSave(initialEditorState())).toBe(false);
    expect(canSave(run({ type: "loaded", payload: LOADED }))).toBe(false);
    expect(canSave(typing("changed"))).toBe(true);
    expect(canSave({ ...typing("changed"), status: "saving" })).toBe(false);
    expect(canSave({ ...typing("changed"), slug: null })).toBe(false);
  });

  it("clears a transient acknowledgement on the next keystroke", () => {
    // "saved" describes the *previous* draft; leaving it on screen while the
    // text moves under it is a lie the user will believe.
    const saved = reduceEditor(typing("a"), { type: "saved", payload: payload({ body: "a" }) }).state;
    expect(saved.status).toBe("saved");
    const typed = reduceEditor(saved, { type: "draft", text: "ab" }).state;
    expect(typed.status).toBe("idle");
    expect(typed.message).toBeNull();
  });

  it("keeps `saving` visible while the user types through a round trip", () => {
    const inflight = reduceEditor(typing("a"), { type: "save" }).state;
    expect(reduceEditor(inflight, { type: "draft", text: "ab" }).state.status).toBe("saving");
  });
});

// --- saving -----------------------------------------------------------------------------

describe("⌘S", () => {
  it("emits a save carrying the revision read at load", () => {
    // The entire conflict mechanism in one assertion.
    const transition = reduceEditor(typing("new text"), { type: "save" });
    expect(transition.effect).toEqual({
      type: "save",
      slug: "alpha",
      input: { body: "new text", expectedRevision: "r1" },
    });
    expect(transition.state.status).toBe("saving");
    // The draft as it was when the request went out — the stale-response guard.
    expect(transition.state.saving).toBe("new text");
  });

  it("sends no meta, because the textarea collects none", () => {
    // Echoing metadata back for the server to rewrite over itself is exactly
    // where a tag list picks up a reordering nobody asked for.
    const effect = reduceEditor(typing("x"), { type: "save" }).effect;
    expect(effect?.type === "save" && Object.keys(effect.input).sort()).toEqual(["body", "expectedRevision"]);
  });

  it("omits expectedRevision when none is held", () => {
    const state = { ...typing("x"), revision: null };
    const effect = reduceEditor(state, { type: "save" }).effect;
    expect(effect).toEqual({ type: "save", slug: "alpha", input: { body: "x" } });
  });

  it("does nothing when there is nothing to save", () => {
    for (const state of [initialEditorState(), run({ type: "loaded", payload: LOADED }), typing("original body")]) {
      expect(reduceEditor(state, { type: "save" }).effect).toBeNull();
    }
  });

  it("does nothing while a save is already in flight", () => {
    const inflight = reduceEditor(typing("a"), { type: "save" }).state;
    expect(reduceEditor(inflight, { type: "save" }).effect).toBeNull();
  });

  it("refuses to save while a conflict is unresolved", () => {
    // That save would be the overwrite the prompt exists to make deliberate.
    const conflicted = reduceEditor(reduceEditor(typing("mine"), { type: "save" }).state, {
      type: "conflicted",
      conflict: CONFLICT,
    }).state;
    expect(reduceEditor(conflicted, { type: "save" }).effect).toBeNull();
  });

  it("cannot save with no slug even if every other gate passes", () => {
    expect(reduceEditor({ ...typing("x"), slug: null }, { type: "save" }).effect).toBeNull();
  });

  it("adopts the echoed body on success", () => {
    // Core trims and may re-attach a `## Raw` tail, so the echo is genuinely
    // worth taking — the baseline must be the *server's* text or the editor
    // reads as permanently dirty by exactly that difference.
    const inflight = reduceEditor(typing("new text"), { type: "save" }).state;
    const saved = reduceEditor(inflight, { type: "saved", payload: payload({ body: "new text\n\n## Raw\nscribble" }, "r2") }).state;
    expect(saved.draft).toBe("new text\n\n## Raw\nscribble");
    expect(saved.baseline).toBe("new text\n\n## Raw\nscribble");
    expect(saved.revision).toBe("r2");
    expect(saved.status).toBe("saved");
    expect(saved.message).toBe(SAVED_MESSAGE);
    expect(isDirty(saved)).toBe(false);
  });

  it("does NOT adopt the echo over keystrokes made during the round trip", () => {
    // The stale-response guard, and the one whose failure would look like a
    // bug in the user's own typing: the reply to a request that predates the
    // keystrokes must not delete them.
    const inflight = reduceEditor(typing("first"), { type: "save" }).state;
    const typedOn = reduceEditor(inflight, { type: "draft", text: "first and more" }).state;
    const saved = reduceEditor(typedOn, { type: "saved", payload: payload({ body: "first" }, "r2") }).state;

    expect(saved.draft).toBe("first and more");
    // The baseline still advances: "first" *is* what is on disk now, so the
    // editor correctly reads as dirty by exactly the new keystrokes, and the
    // next save carries `r2` rather than conflicting with its own write.
    expect(saved.baseline).toBe("first");
    expect(saved.revision).toBe("r2");
    expect(isDirty(saved)).toBe(true);
  });

  it("follows a slug change on the response, as a rename produces", () => {
    const inflight = reduceEditor(typing("x"), { type: "save" }).state;
    const saved = reduceEditor(inflight, { type: "saved", payload: payload({ slug: "renamed", body: "x" }, "r2") }).state;
    expect(saved.slug).toBe("renamed");
  });

  it("reports a failure without touching the draft", () => {
    const inflight = reduceEditor(typing("precious"), { type: "save" }).state;
    const failed = reduceEditor(inflight, { type: "failed", message: "server error (500)" }).state;
    expect(failed.draft).toBe("precious");
    expect(failed.status).toBe("error");
    expect(failed.message).toBe("server error (500)");
    expect(failed.saving).toBeNull();
  });
});

// --- conflict resolution -----------------------------------------------------------------

describe("a 409", () => {
  function conflicted(conflict = CONFLICT): EditorState {
    return reduceEditor(reduceEditor(typing("mine"), { type: "save" }).state, { type: "conflicted", conflict }).state;
  }

  it("leaves the draft completely alone — that is the whole contract", () => {
    const state = conflicted();
    expect(state.draft).toBe("mine");
    expect(state.baseline).toBe("original body");
    expect(state.revision).toBe("r1");
    expect(state.conflict).toBe(CONFLICT);
    expect(state.status).toBe("error");
    expect(state.message).toBe(CONFLICT.error);
  });

  it("reload takes the server's version, discarding the draft", () => {
    const state = reduceEditor(conflicted(), { type: "reload" }).state;
    expect(state.draft).toBe("their text");
    expect(state.baseline).toBe("their text");
    expect(state.revision).toBe("r9");
    expect(state.conflict).toBeNull();
    expect(isDirty(state)).toBe(false);
  });

  it("overwrite re-issues the save WITHOUT a revision", () => {
    // The important half. Adopting the conflict's revision instead would look
    // equivalent and is not: it would succeed only if nothing had moved
    // *again*, so a second concurrent writer would turn the user's deliberate
    // overwrite into a second surprise conflict.
    const transition = reduceEditor(conflicted(), { type: "overwrite" });
    expect(transition.effect).toEqual({ type: "save", slug: "alpha", input: { body: "mine" } });
    expect(transition.state.status).toBe("saving");
    expect(transition.state.conflict).toBeNull();
  });

  it("overwrite does nothing with no slug", () => {
    expect(reduceEditor({ ...conflicted(), slug: null }, { type: "overwrite" }).effect).toBeNull();
  });

  it("dismiss clears the prompt but not the draft, so the next save conflicts again", () => {
    const state = reduceEditor(conflicted(), { type: "dismiss" }).state;
    expect(state.conflict).toBeNull();
    expect(state.draft).toBe("mine");
    expect(state.revision).toBe("r1");
    expect(reduceEditor(state, { type: "save" }).effect).toMatchObject({ input: { expectedRevision: "r1" } });
  });

  it("a collision offers no reload, because there is no competing version", () => {
    // Only a different note occupying the name. "Overwrite" would be an
    // offer to destroy an unrelated file.
    const state = conflicted(COLLISION);
    expect(reduceEditor(state, { type: "reload" }).state).toEqual(state);
  });

  it("reload with nothing to reload from is a no-op", () => {
    const state = typing("mine");
    expect(reduceEditor(state, { type: "reload" }).state).toEqual(state);
  });
});

// --- navigating away ----------------------------------------------------------------------

describe("navigating away", () => {
  it("goes straight through when the draft is clean", () => {
    const transition = reduceEditor(run({ type: "loaded", payload: LOADED }), { type: "navigate", id: "note:beta" });
    expect(transition.effect).toEqual({ type: "select", id: "note:beta" });
    expect(transition.state.pending).toBeNull();
  });

  it("goes through from the initial state, so an untouched workspace is not blocked", () => {
    expect(reduceEditor(initialEditorState(), { type: "navigate", id: "note:x" }).effect).toEqual({
      type: "select",
      id: "note:x",
    });
  });

  it("parks the destination when the draft is dirty, and does not perform it", () => {
    const transition = reduceEditor(typing("unsaved"), { type: "navigate", id: "note:beta" });
    expect(transition.effect).toBeNull();
    // The *destination*, not just the fact of the refusal — so confirming
    // costs one click rather than two.
    expect(transition.state.pending).toEqual({ id: "note:beta" });
    expect(transition.state.draft).toBe("unsaved");
  });

  it("guards clearing the selection too, which `Esc` does by accident", () => {
    const transition = reduceEditor(typing("unsaved"), { type: "navigate", id: null });
    expect(transition.effect).toBeNull();
    expect(transition.state.pending).toEqual({ id: null });
  });

  it("discard completes the parked navigation and resets", () => {
    const parked = reduceEditor(typing("unsaved"), { type: "navigate", id: "note:beta" }).state;
    const transition = reduceEditor(parked, { type: "discard" });
    expect(transition.effect).toEqual({ type: "select", id: "note:beta" });
    expect(transition.state).toEqual(initialEditorState());
  });

  it("discard with nothing parked cannot throw work away", () => {
    // The one place a draft is destroyed, so it must be unreachable except
    // through an explicit confirmation of a navigation the user initiated.
    const state = typing("precious");
    const transition = reduceEditor(state, { type: "discard" });
    expect(transition.effect).toBeNull();
    expect(transition.state.draft).toBe("precious");
  });

  it("stay cancels the navigation and keeps the draft", () => {
    const parked = reduceEditor(typing("unsaved"), { type: "navigate", id: "note:beta" }).state;
    const state = reduceEditor(parked, { type: "stay" }).state;
    expect(state.pending).toBeNull();
    expect(state.draft).toBe("unsaved");
    expect(state.mode).toBe("edit");
  });
});

// --- closing the tab ------------------------------------------------------------------------

describe("shouldBlockUnload", () => {
  it("blocks only on actual unsaved text", () => {
    expect(shouldBlockUnload(initialEditorState())).toBe(false);
    expect(shouldBlockUnload(run({ type: "loaded", payload: LOADED }))).toBe(false);
    expect(shouldBlockUnload(typing("changed"))).toBe(true);
  });

  it("does not block on a parked navigation alone", () => {
    // The tab is closing either way and the parked destination is about to
    // stop existing. Only unsaved text counts.
    const parked = reduceEditor({ ...typing("x"), draft: "original body" }, { type: "navigate", id: "note:b" }).state;
    expect(shouldBlockUnload({ ...parked, pending: { id: "note:b" } })).toBe(false);
  });
});

describe("watchUnload", () => {
  /** What one fired `beforeunload` produced. */
  interface Fired {
    readonly prevented: boolean;
    readonly returnValue: unknown;
  }

  function host(): UnloadHost & { fire(): Fired; count(): number } {
    const listeners: Array<(event: BeforeUnloadEventLike) => void> = [];
    return {
      addEventListener: (_type, listener) => void listeners.push(listener),
      removeEventListener: (_type, listener) => {
        const at = listeners.indexOf(listener);
        if (at >= 0) listeners.splice(at, 1);
      },
      fire() {
        let prevented = false;
        const event: BeforeUnloadEventLike = {
          preventDefault: () => {
            prevented = true;
          },
        };
        for (const listener of listeners) listener(event);
        return { prevented, returnValue: event.returnValue };
      },
      count: () => listeners.length,
    };
  }

  it("cancels the unload and sets returnValue while dirty", () => {
    // Both, because Chrome ignored `preventDefault` for years and the spec
    // deprecated `returnValue`. Setting one is the version that silently
    // stops working in half the world's browsers.
    const h = host();
    watchUnload(h, () => true);
    const event = h.fire();
    expect(event.prevented).toBe(true);
    expect(event.returnValue).toBe("");
  });

  it("lets a clean unload through untouched", () => {
    const h = host();
    watchUnload(h, () => false);
    const event = h.fire();
    expect(event.prevented).toBe(false);
    expect(event.returnValue).toBeUndefined();
  });

  it("reads the predicate per event, not once at subscribe", () => {
    // A listener registered at mount outlives every render. A captured value
    // would always be clean, making the guard installed but inert.
    const h = host();
    let dirty = false;
    watchUnload(h, () => dirty);
    expect(h.fire().prevented).toBe(false);
    dirty = true;
    expect(h.fire().prevented).toBe(true);
  });

  it("unsubscribes", () => {
    const h = host();
    const stop = watchUnload(h, () => true);
    expect(h.count()).toBe(1);
    stop();
    expect(h.count()).toBe(0);
  });
});

// --- open in $EDITOR (§16) ----------------------------------------------------------------

describe("open in $EDITOR", () => {
  it("emits the effect for the loaded note", () => {
    const transition = reduceEditor(run({ type: "loaded", payload: LOADED }), { type: "open" });
    expect(transition.effect).toEqual({ type: "open", slug: "alpha" });
  });

  it("does nothing with no note loaded", () => {
    expect(reduceEditor(initialEditorState(), { type: "open" }).effect).toBeNull();
  });

  it("reports both outcomes", () => {
    const loaded = run({ type: "loaded", payload: LOADED });
    expect(reduceEditor(loaded, { type: "opened", ok: true }).state).toMatchObject({
      status: "idle",
      message: OPENED_MESSAGE,
    });
    expect(reduceEditor(loaded, { type: "opened", ok: false }).state).toMatchObject({
      status: "error",
      message: OPEN_FAILED_MESSAGE,
    });
  });
});

// --- the view model ---------------------------------------------------------------------------

describe("editorToolbar", () => {
  it("names the toggle by what it will do, not by where you are", () => {
    expect(editorToolbar(run({ type: "loaded", payload: LOADED })).toggleLabel).toBe(EDIT_LABEL);
    expect(editorToolbar(typing("x")).toggleLabel).toBe(READ_LABEL);
  });

  it("reports the save control's label and whether it is actionable", () => {
    expect(editorToolbar(typing("x"))).toMatchObject({ saveLabel: SAVE_LABEL, canSave: true, dirty: true });
    const inflight = reduceEditor(typing("x"), { type: "save" }).state;
    expect(editorToolbar(inflight)).toMatchObject({ saveLabel: SAVING_LABEL, canSave: false });
  });

  it("disables save while a conflict is unresolved", () => {
    const conflicted = reduceEditor(typing("x"), { type: "conflicted", conflict: CONFLICT }).state;
    expect(editorToolbar(conflicted).canSave).toBe(false);
  });

  it("picks a tone rather than a colour", () => {
    expect(editorToolbar(initialEditorState()).tone).toBe("none");
    const saved = reduceEditor(reduceEditor(typing("x"), { type: "save" }).state, {
      type: "saved",
      payload: payload({ body: "x" }),
    }).state;
    expect(editorToolbar(saved).tone).toBe("ok");
    expect(editorToolbar(reduceEditor(typing("x"), { type: "failed", message: "nope" }).state).tone).toBe("warn");
  });
});

describe("editorPrompt", () => {
  it("shows nothing when there is nothing to decide", () => {
    expect(editorPrompt(initialEditorState())).toBeNull();
    expect(editorPrompt(typing("x"))).toBeNull();
  });

  it("offers reload, overwrite and keep-editing for a conflict", () => {
    const prompt = editorPrompt(reduceEditor(typing("x"), { type: "conflicted", conflict: CONFLICT }).state);
    expect(prompt?.kind).toBe("conflict");
    expect(prompt?.message).toBe(CONFLICT.error);
    expect(prompt?.actions.map((a) => a.label)).toEqual([RELOAD_LABEL, OVERWRITE_LABEL, KEEP_LABEL]);
  });

  it("offers neither reload nor overwrite for a collision", () => {
    const prompt = editorPrompt(reduceEditor(typing("x"), { type: "conflicted", conflict: COLLISION }).state);
    expect(prompt?.kind).toBe("collision");
    expect(prompt?.message).toContain("taken");
    expect(prompt?.actions.map((a) => a.label)).toEqual([KEEP_LABEL]);
  });

  it("offers discard or keep for a parked navigation", () => {
    const parked = reduceEditor(typing("x"), { type: "navigate", id: "note:b" }).state;
    const prompt = editorPrompt(parked);
    expect(prompt?.kind).toBe("discard");
    expect(prompt?.message).toBe(UNSAVED_MESSAGE);
    expect(prompt?.actions.map((a) => a.label)).toEqual([KEEP_LABEL, DISCARD_LABEL]);
  });

  it("offers reload or keep for an external change", () => {
    const marked = reduceEditor(typing("mine"), { type: "loaded", payload: payload({}, "r9") }).state;
    const prompt = editorPrompt(marked);
    expect(prompt?.kind).toBe("external");
    expect(prompt?.message).toBe(EXTERNAL_MESSAGE);
    expect(prompt?.actions.map((a) => a.label)).toEqual([RELOAD_LABEL, KEEP_LABEL]);
  });

  it("shows exactly one prompt, ordered by urgency", () => {
    // Stacking them would produce two dialogs about the same underlying fact
    // — someone else wrote — with different buttons.
    const marked = reduceEditor(typing("mine"), { type: "loaded", payload: payload({}, "r9") }).state;
    const parked = reduceEditor(marked, { type: "navigate", id: "note:b" }).state;
    expect(editorPrompt(parked)?.kind).toBe("discard");
    const conflicted = reduceEditor(parked, { type: "conflicted", conflict: CONFLICT }).state;
    expect(editorPrompt(conflicted)?.kind).toBe("conflict");
  });

  it("every declared kind is producible", () => {
    // `EDITOR_PROMPT_KINDS` drives the stylesheet check, so a kind nobody can
    // reach would be a rule nobody needs — and, worse, a kind that *is*
    // reachable but missing from the list would ship unstyled.
    const marked = reduceEditor(typing("m"), { type: "loaded", payload: payload({}, "r9") }).state;
    const produced = new Set(
      [
        reduceEditor(typing("x"), { type: "conflicted", conflict: CONFLICT }).state,
        reduceEditor(typing("x"), { type: "conflicted", conflict: COLLISION }).state,
        reduceEditor(typing("x"), { type: "navigate", id: "note:b" }).state,
        marked,
      ].map((state) => editorPrompt(state)?.kind),
    );
    expect([...produced].sort()).toEqual([...EDITOR_PROMPT_KINDS].sort());
  });
});

// --- the controller ------------------------------------------------------------------------------

describe("createEditor", () => {
  interface Recorded {
    readonly url: string;
    readonly init: HttpRequest | undefined;
  }

  /** A `fetch` whose responses are queued, so a save can be left in flight. */
  function queued(): FetchLike & { readonly calls: Recorded[]; resolve(response: Partial<HttpResponse>): void } {
    const calls: Recorded[] = [];
    const waiting: Array<(response: HttpResponse) => void> = [];
    const impl = (url: string, init?: HttpRequest): Promise<HttpResponse> => {
      calls.push({ url, init });
      return new Promise<HttpResponse>((resolve) => waiting.push(resolve));
    };
    return Object.assign(impl, {
      calls,
      resolve(response: Partial<HttpResponse>) {
        const next = waiting.shift();
        if (next === undefined) throw new Error("nothing in flight");
        next({ ok: response.ok ?? true, status: response.status ?? 200, json: response.json ?? (() => Promise.resolve({})) });
      },
    });
  }

  function harness() {
    const fetch = queued();
    const selected: Array<string | null> = [];
    const states: EditorState[] = [];
    const editor = createEditor({ fetch, select: (id) => void selected.push(id), onChange: (s) => void states.push(s) });
    return { fetch, selected, states, editor };
  }

  /** Let the controller's fire-and-forget promise chain settle. */
  const settle = (): Promise<void> => new Promise((resolve) => void setTimeout(resolve, 0));

  it("publishes on every transition", async () => {
    const h = harness();
    h.editor.send({ type: "loaded", payload: LOADED });
    h.editor.send({ type: "toggle" });
    expect(h.states).toHaveLength(2);
    expect(h.editor.state().mode).toBe("edit");
    await settle();
  });

  it("POSTs the save and adopts the response", async () => {
    const h = harness();
    h.editor.send({ type: "loaded", payload: LOADED });
    h.editor.send({ type: "toggle" });
    h.editor.send({ type: "draft", text: "new" });
    h.editor.send({ type: "save" });

    expect(h.fetch.calls[0]?.url).toBe("/api/note/alpha");
    expect(JSON.parse(h.fetch.calls[0]?.init?.body ?? "{}")).toEqual({ body: "new", expectedRevision: "r1" });

    h.fetch.resolve({ json: () => Promise.resolve(payload({ body: "new" }, "r2")) });
    await settle();
    expect(h.editor.state()).toMatchObject({ status: "saved", revision: "r2", baseline: "new" });
  });

  it("turns a 409 into a conflict rather than an error", async () => {
    const h = harness();
    h.editor.send({ type: "loaded", payload: LOADED });
    h.editor.send({ type: "toggle" });
    h.editor.send({ type: "draft", text: "mine" });
    h.editor.send({ type: "save" });
    h.fetch.resolve({ ok: false, status: 409, json: () => Promise.resolve(CONFLICT) });
    await settle();

    expect(h.editor.state().conflict).toEqual(CONFLICT);
    expect(h.editor.state().draft).toBe("mine");
  });

  it("turns any other failure into a message", async () => {
    const h = harness();
    h.editor.send({ type: "loaded", payload: LOADED });
    h.editor.send({ type: "toggle" });
    h.editor.send({ type: "draft", text: "mine" });
    h.editor.send({ type: "save" });
    h.fetch.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
    await settle();

    expect(h.editor.state()).toMatchObject({ status: "error", message: "server error (500)", draft: "mine" });
  });

  it("performs a parked navigation through the injected select", async () => {
    const h = harness();
    h.editor.send({ type: "loaded", payload: LOADED });
    h.editor.send({ type: "toggle" });
    h.editor.send({ type: "draft", text: "unsaved" });
    h.editor.send({ type: "navigate", id: "note:beta" });
    expect(h.selected).toEqual([]);
    h.editor.send({ type: "discard" });
    expect(h.selected).toEqual(["note:beta"]);
    await settle();
  });

  it("POSTs /api/open and reports the outcome", async () => {
    const h = harness();
    h.editor.send({ type: "loaded", payload: LOADED });
    h.editor.send({ type: "open" });
    expect(h.fetch.calls[0]?.url).toBe("/api/open");
    expect(JSON.parse(h.fetch.calls[0]?.init?.body ?? "{}")).toEqual({ slug: "alpha" });

    h.fetch.resolve({ json: () => Promise.resolve({ opened: true }) });
    await settle();
    expect(h.editor.state().message).toBe(OPENED_MESSAGE);
  });

  it("reports an open that the server refused", async () => {
    const h = harness();
    h.editor.send({ type: "loaded", payload: LOADED });
    h.editor.send({ type: "open" });
    h.fetch.resolve({ ok: false, status: 404, json: () => Promise.resolve({ opened: false }) });
    await settle();
    expect(h.editor.state().message).toBe(OPEN_FAILED_MESSAGE);
  });

  it("reports an open that succeeded with opened:false", async () => {
    // The 200 case core can produce for a slug it declined to shell out for.
    const h = harness();
    h.editor.send({ type: "loaded", payload: LOADED });
    h.editor.send({ type: "open" });
    h.fetch.resolve({ json: () => Promise.resolve({ opened: false }) });
    await settle();
    expect(h.editor.state().message).toBe(OPEN_FAILED_MESSAGE);
  });

  it("issues no request for a transition with no effect", async () => {
    const h = harness();
    h.editor.send({ type: "save" });
    expect(h.fetch.calls).toEqual([]);
    await settle();
  });
});
