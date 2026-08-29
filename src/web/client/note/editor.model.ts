/**
 * The note editor, as a pure state machine (weave-workspace §11 P5.3–P5.4).
 *
 * > `<textarea>` editor with live preview, `⌘S` save, `⌘E` toggle edit/read.
 * > Conflict handling: save carries the mtime it read; a mismatch returns
 * > `409` and the UI offers reload-or-overwrite.
 *
 * Everything that decides is here: dirty tracking, the save lifecycle, the
 * conflict resolution, and the two guards that stand between a user's
 * unsaved paragraph and the ways it can be lost. `Editor.tsx` is a
 * `<textarea>`, a toolbar and three handlers; `editor.ts` owns the fetch. §10
 * forbids a DOM test environment, so a branch that lands in the component is
 * a branch that ships uncovered — and the branches below are precisely the
 * ones where being wrong costs the user their writing.
 *
 * ## Why a reducer and not a handful of `useState` calls
 *
 * Because the interesting properties are *relationships between* the fields,
 * not the fields:
 *
 *  - a save must carry the revision read at load, not one read later;
 *  - a `409` must leave the draft intact **and** offer the server's version;
 *  - a response that arrives after the user has typed again must not silently
 *    replace what they typed;
 *  - navigating away while dirty must be refused *and* remember where the
 *    user was trying to go, so confirming does not make them click twice.
 *
 * Each of those is a statement about two or three fields moving together.
 * Spread across component state they are four invariants nobody can check;
 * as {@link reduceEditor} they are a table of transitions with a test each.
 *
 * ## The three ways an edit can be lost, and what stops each
 *
 * | Loss | Guard |
 * | --- | --- |
 * | Another writer overwrites you | `expectedRevision` on every save → `409` |
 * | You overwrite another writer | the same `409`, offered as a choice not a default |
 * | You navigate away mid-edit | {@link EditorEvent} `navigate` is refused while dirty, parked in {@link EditorState.pending} |
 *
 * The fourth — closing the tab — cannot be solved here, because the browser
 * only offers `beforeunload`. {@link shouldBlockUnload} is the predicate;
 * `editor.ts` attaches the listener.
 *
 * ## An SSE change to the note being edited: keep typing, offer the reload
 *
 * §6 pushes a frame when the vault moves, and `workspace.ts` refetches the
 * open note. If that refetch lands on a note the user is *editing*, there are
 * three possible policies and only one of them is defensible:
 *
 *  1. **Overwrite the draft with the server's version.** Destroys unsaved
 *     work with no prompt, triggered by a background event the user did not
 *     cause. Never.
 *  2. **Block with a modal.** Steals focus mid-sentence, from a notification
 *     rather than an action. Editors that do this are the reason people
 *     disable file watching.
 *  3. **Keep the draft; mark the note as changed on disk; offer a reload.**
 *
 * This module does (3), in {@link applyLoad}: a load carrying a revision
 * different from the one held is recorded in {@link EditorState.external}
 * rather than applied, and the draft is untouched. The user keeps typing and
 * sees a passive marker offering to take the disk version.
 *
 * What makes (3) *safe* rather than merely polite is that it is not the last
 * line of defence. The held revision is now stale by construction, so the
 * next `⌘S` produces a `409` carrying the current note — the same choice,
 * re-offered at the moment the user is actually about to write, and this time
 * authoritative rather than a snapshot that may itself have aged. The passive
 * marker is an early warning; the `409` is the guarantee. Dropping the marker
 * would still be correct and would just make the conflict a surprise;
 * dropping the `409` would not be correct at all, which is why the marker is
 * the part that is allowed to be non-blocking.
 *
 * When the note is **not** dirty, the same load is adopted silently — there
 * is nothing to protect, and showing a "changed on disk" badge over a
 * document the user is only reading would be noise.
 *
 * Compiled by the root `tsconfig.json` when a test imports it: no DOM types,
 * no `node:*`, no `src/core`.
 */

import type { ConflictPayload, NotePayload, SaveNoteRequest } from "../../shared/wire";

// --- state --------------------------------------------------------------------------

/** Read-only rendering, or the `<textarea>`. Toggled by `⌘E`. */
export type EditorMode = "read" | "edit";

/**
 * Where the save lifecycle is.
 *
 * `"saved"` is a transient acknowledgement rather than a resting state — it
 * exists so the toolbar can say "saved" for a moment — and any keystroke
 * returns it to `"idle"`. Without it, a save with no visible outcome is
 * indistinguishable from a save that did not fire, which is exactly the
 * uncertainty that makes people hit `⌘S` four times.
 */
export type SaveStatus = "idle" | "saving" | "saved" | "error";

/**
 * A navigation the editor refused because the draft is dirty.
 *
 * The *destination* is remembered, not merely the fact of the refusal, so
 * confirming the discard completes the move the user asked for. Parking only
 * a boolean would make "discard" mean "stay here with your work gone", which
 * is the worst available outcome.
 *
 * `id` is nullable because clearing the selection (`Esc`, a click on empty
 * graph stage) is a navigation too, and it must be guarded like any other.
 */
export interface PendingNavigation {
  readonly id: string | null;
}

export interface EditorState {
  readonly mode: EditorMode;
  /** The note being edited, or `null` when the column holds nothing. */
  readonly slug: string | null;
  /**
   * The body as last known to be on disk: what was loaded, or what the
   * server echoed back from the last successful save.
   *
   * Dirtiness is `draft !== baseline`, so this is deliberately the
   * **server's** text rather than what was sent to it. Core trims the body
   * and re-attaches the append-only `## Raw` tail, so a save's response can
   * legitimately differ from its request — and baselining against the
   * request would leave the editor permanently dirty by exactly that
   * difference.
   */
  readonly baseline: string;
  /** The `<textarea>`'s content. */
  readonly draft: string;
  /**
   * The revision every save carries. `null` before the first load.
   *
   * Opaque: compare it, never parse it. It is the revision read *with* the
   * body, which is what makes the pair meaningful — a revision fetched
   * separately would describe a state the draft was not typed against.
   */
  readonly revision: string | null;
  readonly status: SaveStatus;
  /** Human-facing, already safe to render. `null` when there is nothing to say. */
  readonly message: string | null;
  /**
   * The draft as it was when the in-flight save was issued, or `null`.
   *
   * The stale-response guard. A save is asynchronous and the user keeps
   * typing through it, so when the response lands this is what decides
   * whether the server's echoed body may be written back into the textarea:
   * it may, if the draft has not moved since; it must not, if it has, or the
   * keystrokes made during the round trip vanish under the reply to a
   * request that predates them.
   */
  readonly saving: string | null;
  /** A `409` awaiting the user's decision. Blocks further saves until resolved. */
  readonly conflict: ConflictPayload | null;
  /**
   * A newer version seen on disk while the draft was dirty (§6).
   *
   * Passive: it does not block typing or saving. See the module header for
   * why an SSE change is an early warning rather than an interruption.
   */
  readonly external: NotePayload | null;
  /** A navigation refused because the draft is dirty. */
  readonly pending: PendingNavigation | null;
}

/** Nothing loaded, nothing typed. */
export function initialEditorState(): EditorState {
  return {
    mode: "read",
    slug: null,
    baseline: "",
    draft: "",
    revision: null,
    status: "idle",
    message: null,
    saving: null,
    conflict: null,
    external: null,
    pending: null,
  };
}

/**
 * Whether the draft differs from what is known to be on disk.
 *
 * Gated on `mode === "edit"` deliberately. In read mode the draft is a stale
 * copy of whatever was last loaded and nobody is typing into it, so treating
 * a difference as unsaved work would block navigation for a user who has not
 * edited anything — the most annoying possible false positive.
 */
export function isDirty(state: EditorState): boolean {
  return state.mode === "edit" && state.draft !== state.baseline;
}

/** Whether a save is worth issuing: dirty, loaded, and not already in flight. */
export function canSave(state: EditorState): boolean {
  return isDirty(state) && state.slug !== null && state.status !== "saving";
}

// --- effects ------------------------------------------------------------------------

/**
 * What a transition asks the outside world to do.
 *
 * Returned as *data* rather than performed, so every branch below is
 * assertable by equality. `editor.ts` is the only thing that turns one of
 * these into a request.
 */
export type EditorEffect =
  | { readonly type: "save"; readonly slug: string; readonly input: SaveNoteRequest }
  /** Complete a navigation the editor was holding — the §1.3 context bus. */
  | { readonly type: "select"; readonly id: string | null }
  /** `POST /api/open` — hand the note to `$EDITOR` (§16). */
  | { readonly type: "open"; readonly slug: string };

/** The result of one transition. */
export interface EditorTransition {
  readonly state: EditorState;
  readonly effect: EditorEffect | null;
}

function still(state: EditorState): EditorTransition {
  return { state, effect: null };
}

// --- events -------------------------------------------------------------------------

export type EditorEvent =
  /** A note arrived from the server — first load, a reselect, or an SSE refetch. */
  | { readonly type: "loaded"; readonly payload: NotePayload }
  /** The selection no longer names a note. */
  | { readonly type: "cleared" }
  /** `⌘E`. */
  | { readonly type: "toggle" }
  /** The `<textarea>` changed. */
  | { readonly type: "draft"; readonly text: string }
  /** `⌘S`, or the toolbar's save. */
  | { readonly type: "save" }
  | { readonly type: "saved"; readonly payload: NotePayload }
  | { readonly type: "failed"; readonly message: string }
  | { readonly type: "conflicted"; readonly conflict: ConflictPayload }
  /** Take the server's version, discarding the draft. */
  | { readonly type: "reload" }
  /** Take the draft, discarding the server's version. */
  | { readonly type: "overwrite" }
  /** Close a conflict prompt or an external-change marker without choosing. */
  | { readonly type: "dismiss" }
  /** The user selected something else. Refused while dirty. */
  | { readonly type: "navigate"; readonly id: string | null }
  /** Confirm the refused navigation, losing the draft. */
  | { readonly type: "discard" }
  /** Cancel the refused navigation and stay. */
  | { readonly type: "stay" }
  /** Open the note in `$EDITOR`. */
  | { readonly type: "open" }
  | { readonly type: "opened"; readonly ok: boolean };

// --- the machine ---------------------------------------------------------------------

/** Copy of the payload's body/revision, with the save lifecycle reset. */
function adopt(state: EditorState, payload: NotePayload, mode: EditorMode): EditorState {
  return {
    ...state,
    mode,
    slug: payload.note.slug,
    baseline: payload.note.body,
    draft: payload.note.body,
    revision: payload.revision,
    status: "idle",
    message: null,
    saving: null,
    conflict: null,
    external: null,
  };
}

/**
 * A note arrived. Three cases, and the middle one is the §6 decision.
 *
 * 1. **A different note.** Nothing to protect — the guard on `navigate` is
 *    what stopped us reaching here with unsaved work — so load it in read
 *    mode, which is the honest default for a document the user has not yet
 *    said they want to change.
 * 2. **The same note, dirty, at a revision we do not hold.** Somebody else
 *    wrote while the user was typing. Keep the draft; record the newer
 *    version. See the module header.
 * 3. **The same note, otherwise.** Adopt it, keeping the current mode: a
 *    refetch triggered by our own save, or by an unrelated frame, must not
 *    eject a reader out of the editor they had open.
 */
function applyLoad(state: EditorState, payload: NotePayload): EditorState {
  if (payload.note.slug !== state.slug) return adopt(state, payload, "read");
  if (isDirty(state) && payload.revision !== state.revision) return { ...state, external: payload };
  return adopt(state, payload, state.mode);
}

/**
 * The whole editor, as one function.
 *
 * Ordered so the guards are visible: `navigate` and `discard` come first
 * because they are the ones that can destroy work, and the save lifecycle
 * follows.
 */
export function reduceEditor(state: EditorState, event: EditorEvent): EditorTransition {
  switch (event.type) {
    case "loaded":
      return still(applyLoad(state, event.payload));

    case "cleared":
      // Reached only through `navigate`, which has already checked
      // dirtiness — so there is nothing here to lose. Resetting rather than
      // blanking selectively, because a half-cleared editor holding a
      // revision for a note that is no longer open is a save waiting to go
      // to the wrong file.
      return still(initialEditorState());

    case "toggle": {
      // With nothing loaded there is nothing to edit, and entering edit mode
      // over an empty column would present a textarea whose save has no
      // slug to go to.
      if (state.slug === null) return still(state);
      if (state.mode === "read") return still({ ...state, mode: "edit", draft: state.baseline, status: "idle", message: null });
      // Leaving edit mode with unsaved changes would discard them silently,
      // which is the same loss `navigate` guards against arriving by a
      // different key. Refuse and say so; `⌘S` or an explicit discard is the
      // way out.
      if (isDirty(state)) return still({ ...state, status: "error", message: UNSAVED_MESSAGE });
      return still({ ...state, mode: "read", status: "idle", message: null });
    }

    case "draft":
      // Any keystroke clears a transient acknowledgement or error: they
      // describe the *previous* draft, and leaving "saved" on screen while
      // the text moves under it is a lie the user will believe.
      return still({ ...state, draft: event.text, status: state.status === "saving" ? "saving" : "idle", message: null });

    case "save": {
      if (!canSave(state) || state.slug === null) return still(state);
      // A save while a conflict is unresolved would be the overwrite the
      // prompt exists to make deliberate. Refuse until the user chooses.
      if (state.conflict !== null) return still(state);
      return {
        state: { ...state, status: "saving", message: null, saving: state.draft },
        effect: { type: "save", slug: state.slug, input: saveInputFor(state) },
      };
    }

    case "saved":
      return still(applySaved(state, event.payload));

    case "failed":
      return still({ ...state, status: "error", message: event.message, saving: null });

    case "conflicted":
      // The draft is untouched — that is the whole contract of a `409`. The
      // conflict sits alongside it until the user picks a side.
      return still({ ...state, status: "error", message: event.conflict.error, saving: null, conflict: event.conflict });

    case "reload":
      return still(applyReload(state));

    case "overwrite":
      return applyOverwrite(state);

    case "dismiss":
      // Clears the *prompts*, never the draft. Dismissing a conflict means
      // "I have read it and I am still thinking", so the next save conflicts
      // again — which is correct, because nothing has been resolved.
      return still({ ...state, conflict: null, external: null, status: "idle", message: null });

    case "navigate":
      return applyNavigate(state, event.id);

    case "discard":
      // The one place a draft is thrown away, and only ever after an
      // explicit confirmation of a navigation the user initiated.
      return state.pending === null
        ? still(state)
        : { state: initialEditorState(), effect: { type: "select", id: state.pending.id } };

    case "stay":
      return still({ ...state, pending: null });

    case "open":
      return state.slug === null ? still(state) : { state, effect: { type: "open", slug: state.slug } };

    case "opened":
      return still({
        ...state,
        status: event.ok ? "idle" : "error",
        message: event.ok ? OPENED_MESSAGE : OPEN_FAILED_MESSAGE,
      });
  }
}

/**
 * The request body for a save.
 *
 * Body only. The editor is a `<textarea>` over the Markdown body (§0 V10) and
 * has no metadata fields, so sending a `meta` it did not collect would be
 * echoing values back at the server for it to rewrite over themselves — and
 * the round trip through JSON is exactly where a tag list picks up a
 * reordering nobody asked for.
 *
 * `expectedRevision` is included whenever one is held, which is always after
 * a load. It is *absent* only in {@link applyOverwrite}, and its absence
 * there is the entire meaning of "overwrite".
 */
function saveInputFor(state: EditorState): SaveNoteRequest {
  return state.revision === null ? { body: state.draft } : { body: state.draft, expectedRevision: state.revision };
}

/**
 * A save succeeded.
 *
 * The echoed body replaces the draft **only if** the draft has not moved
 * since the request went out. Core trims and may re-attach a `## Raw` tail,
 * so the echo is genuinely worth adopting — but adopting it over keystrokes
 * made during the round trip would delete them, and a save is not supposed to
 * be able to delete anything.
 *
 * When the user *has* typed on, the baseline still advances to the echoed
 * body: that is what is on disk now, so the editor correctly reads as dirty
 * by exactly the new keystrokes, and the next save carries the fresh
 * revision rather than conflicting with its own previous write.
 */
function applySaved(state: EditorState, payload: NotePayload): EditorState {
  const raced = state.saving !== null && state.saving !== state.draft;
  return {
    ...state,
    slug: payload.note.slug,
    baseline: payload.note.body,
    draft: raced ? state.draft : payload.note.body,
    revision: payload.revision,
    status: "saved",
    message: SAVED_MESSAGE,
    saving: null,
    conflict: null,
    external: null,
  };
}

/**
 * Take the disk version, discarding the draft.
 *
 * Serves both prompts, because both hold the same thing — a
 * {@link NotePayload} the server already sent us. A `409`'s `collision` arm
 * does not (it names a taken slug, not a note), so it is left alone: there is
 * nothing to reload, and the user's answer is to pick a different name.
 */
function applyReload(state: EditorState): EditorState {
  const payload = state.conflict?.reason === "conflict" ? state.conflict.current : state.external;
  return payload === null || payload === undefined ? state : adopt(state, payload, state.mode);
}

/**
 * Take the draft, discarding the disk version.
 *
 * Implemented by re-issuing the save **without** `expectedRevision`, which is
 * how core spells last-write-wins. The alternative — adopting the conflict's
 * revision and saving against that — would look equivalent and is not: it
 * would succeed only if nothing had moved *again* in the meantime, so a
 * second concurrent writer would turn the user's deliberate "overwrite" into
 * a second surprise conflict. "Overwrite" should mean it.
 */
function applyOverwrite(state: EditorState): EditorTransition {
  if (state.slug === null) return still(state);
  return {
    state: { ...state, status: "saving", message: null, saving: state.draft, conflict: null, external: null },
    effect: { type: "save", slug: state.slug, input: { body: state.draft } },
  };
}

/**
 * The user selected something else.
 *
 * Clean → let it through. Dirty → park the destination and let the component
 * ask. The navigation is *not* performed and *not* forgotten, so confirming
 * costs one click rather than two.
 */
function applyNavigate(state: EditorState, id: string | null): EditorTransition {
  if (!isDirty(state)) return { state, effect: { type: "select", id } };
  return still({ ...state, pending: { id } });
}

// --- the unload guard -----------------------------------------------------------------

/**
 * Whether `beforeunload` should be cancelled.
 *
 * A predicate rather than a listener, because the listener is one line and
 * the *decision* is the part worth testing. Browsers ignore any custom
 * message here and show their own wording, so there is nothing else to
 * return.
 *
 * A pending navigation is deliberately *not* a reason to block: the tab is
 * closing either way, and the parked destination is about to stop existing.
 * Only actual unsaved text counts.
 */
export function shouldBlockUnload(state: EditorState): boolean {
  return isDirty(state);
}

// --- the view model ---------------------------------------------------------------------

/** Copy. Centralised so the toolbar and the tests quote the same strings. */
export const SAVED_MESSAGE = "saved";
export const UNSAVED_MESSAGE = "unsaved changes — save with the button, or discard them";
export const OPENED_MESSAGE = "opened in your editor";
export const OPEN_FAILED_MESSAGE = "could not open the note in an editor";
export const EDIT_LABEL = "Edit";
export const READ_LABEL = "Done";
export const SAVE_LABEL = "Save";
export const SAVING_LABEL = "Saving…";
/**
 * The `Open in $EDITOR` control's name — kept as its accessible label, not as
 * its text.
 *
 * P6.3 demoted this control out of the note bar: as a full-width bordered
 * button sitting between the title and the prose it out-shouted the document
 * it opens. It is now an icon in the head's meta row ({@link OPEN_ICON} in
 * `Note.tsx`'s header), so the label lives on for `aria-label` and the
 * title/tooltip, where the explanation belongs — the icon alone is a glyph,
 * not an invitation.
 */
export const OPEN_LABEL = "Open in $EDITOR";
export const OPEN_HINT = "Hand this note to $EDITOR (or your platform's opener)";
export const DISCARD_LABEL = "Discard changes";
export const KEEP_LABEL = "Keep editing";
export const RELOAD_LABEL = "Reload from disk";
export const OVERWRITE_LABEL = "Overwrite";
export const EXTERNAL_MESSAGE = "this note changed on disk while you were editing";
export const COLLISION_HINT = "pick a different name";

/**
 * The icon the demoted `Open in $EDITOR` control shows, as a string.
 *
 * A single inline SVG is the whole icon system this button needs, and a
 * string constant is what keeps it CSP-legal and testable: it is inserted as
 * *markup* (not as an attribute, which a strict CSP would block), it is
 * `currentColor` so the button's own colour states style it for free, and
 * carrying it here — with `aria-hidden: true` because the accessible name is
 * {@link OPEN_LABEL} — means a test can assert the icon ships with the
 * accessible name and hint rather than hoping the component wires them.
 *
 * Deliberately not the shared icon sprite P6.4 builds for the tree and rail:
 * that is another column's job and another module's vocabulary, and a 15px
 * pencil-plus-page does not want a dependency on it.
 */
export const OPEN_ICON =
  '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
  // The page, open at the corner the pencil is leaving through.
  '<path d="M9 2H3.6A1.6 1.6 0 0 0 2 3.6v8.8A1.6 1.6 0 0 0 3.6 14h8.8A1.6 1.6 0 0 0 14 12.4V9"/>' +
  // The pencil: `edit`'s geometry from the Feather icon, scaled to 16px.
  '<path d="M11.3 2a1.9 1.9 0 1 1 2.7 2.7L5.6 13 2 14l1-3.6 8.3-8.4z"/>' +
  "</svg>";

/** Which prompt, if any, the column must render. */
export type EditorPromptKind = "conflict" | "collision" | "external" | "discard";

/**
 * Every {@link EditorPromptKind}, as a runtime value.
 *
 * `Editor.tsx` emits `weave-note-prompt-${kind}`, so the stylesheet needs one
 * rule per kind and a *type* cannot be walked to check that. A hand-written
 * list in the theme test would pass on the day a fifth kind arrives
 * unstyled — the same reasoning `WIRE_NODE_KINDS` records.
 */
export const EDITOR_PROMPT_KINDS: readonly EditorPromptKind[] = ["conflict", "collision", "external", "discard"];

/**
 * A prompt: a sentence and the choices under it.
 *
 * Modelled as data so "a conflict offers reload *and* overwrite, a collision
 * offers neither" is a table with a test rather than a nest of ternaries in
 * JSX. `actions` are {@link EditorEvent} type names, which is what lets the
 * component dispatch them without knowing what any of them mean.
 */
export interface EditorPrompt {
  readonly kind: EditorPromptKind;
  readonly message: string;
  readonly actions: readonly { readonly label: string; readonly event: EditorEvent }[];
}

/**
 * The prompt to show, or `null`.
 *
 * Ordered by urgency, and only one is ever shown: a `409` is the user's
 * immediate blocker, a refused navigation is a question they just asked, and
 * the external marker is an FYI. Stacking them would produce two dialogs
 * about the same underlying fact — someone else wrote — with different
 * buttons.
 */
export function editorPrompt(state: EditorState): EditorPrompt | null {
  const conflict = state.conflict;
  if (conflict?.reason === "conflict") {
    return {
      kind: "conflict",
      message: conflict.error,
      actions: [
        { label: RELOAD_LABEL, event: { type: "reload" } },
        { label: OVERWRITE_LABEL, event: { type: "overwrite" } },
        { label: KEEP_LABEL, event: { type: "dismiss" } },
      ],
    };
  }
  if (conflict?.reason === "collision") {
    // No reload and no overwrite: there is no competing *version* of this
    // note, only a different note already occupying the name. Offering
    // "overwrite" would be offering to destroy an unrelated file.
    return {
      kind: "collision",
      message: `${conflict.error} (${conflict.slug}) — ${COLLISION_HINT}`,
      actions: [{ label: KEEP_LABEL, event: { type: "dismiss" } }],
    };
  }
  if (state.pending !== null) {
    return {
      kind: "discard",
      message: UNSAVED_MESSAGE,
      actions: [
        { label: KEEP_LABEL, event: { type: "stay" } },
        { label: DISCARD_LABEL, event: { type: "discard" } },
      ],
    };
  }
  if (state.external !== null) {
    return {
      kind: "external",
      message: EXTERNAL_MESSAGE,
      actions: [
        { label: RELOAD_LABEL, event: { type: "reload" } },
        { label: KEEP_LABEL, event: { type: "dismiss" } },
      ],
    };
  }
  return null;
}

/** Everything the note column's toolbar renders. */
export interface EditorToolbar {
  /** `Edit` or `Done` — the `⌘E` button's current meaning. */
  readonly toggleLabel: string;
  /** True while the editor is open, for the button's pressed state. */
  readonly editing: boolean;
  readonly saveLabel: string;
  /** Whether the save control is actionable. */
  readonly canSave: boolean;
  /** `saved`, an error, or `null`. */
  readonly message: string | null;
  /** Tone for the message, so the component picks a class rather than a colour. */
  readonly tone: "none" | "ok" | "warn";
  /** The `•` unsaved marker. */
  readonly dirty: boolean;
}

/** Derive the toolbar. One function, so the component has no conditionals. */
export function editorToolbar(state: EditorState): EditorToolbar {
  const editing = state.mode === "edit";
  return {
    toggleLabel: editing ? READ_LABEL : EDIT_LABEL,
    editing,
    saveLabel: state.status === "saving" ? SAVING_LABEL : SAVE_LABEL,
    canSave: canSave(state) && state.conflict === null,
    message: state.message,
    tone: state.message === null ? "none" : state.status === "error" ? "warn" : "ok",
    dirty: isDirty(state),
  };
}

/**
 * Whether the editor bar should render at all.
 *
 * P6.3 removed the `Open in $EDITOR` button from the bar (it lives in the
 * head's meta row now), which took away the bar's only read-mode inhabitant.
 * A bar that renders in read mode is then an empty ruled strip between the
 * head and the prose — a border describing nothing. So the bar is *earned*:
 * while editing it is always present, otherwise only a message or a prompt
 * (a save's status line, an "opened in your editor" acknowledgement, a
 * conflict) puts something inside it.
 */
export function editorBarVisible(toolbar: EditorToolbar, prompt: EditorPrompt | null): boolean {
  return toolbar.editing || toolbar.message !== null || prompt !== null;
}
