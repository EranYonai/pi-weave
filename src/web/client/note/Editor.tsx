/**
 * The `<textarea>` editor and its toolbar (weave-workspace §0 V10, §11 P5.4).
 *
 * Props in, JSX out. Dirty tracking, the save lifecycle, conflict resolution
 * and every string are `editor.model.ts`; the requests are `editor.ts`. What
 * is left here is three elements and three handlers.
 *
 * A `<textarea>`, not CodeMirror 6, and §0 V10 settles it with a number:
 * CM6 is 118 KB gzip — more than the entire rest of the client — against a
 * 150 KB budget already 62 % spent. The textarea is what proves the *save
 * path* is correct, which is the part P5 is actually gated on. Syntax
 * highlighting can arrive later against a round trip that is already known
 * to be lossless; the reverse order would be building an editor over a bug.
 */

import type { EditorEvent, EditorPrompt, EditorToolbar } from "./editor.model";
import { OPEN_HINT, OPEN_LABEL } from "./editor.model";

export interface EditorProps {
  toolbar: EditorToolbar;
  /** The `<textarea>`'s content — `state.draft`. */
  draft: string;
  /** The one prompt to show, or `null`. Ordered by `editorPrompt`. */
  prompt: EditorPrompt | null;
  /** Dispatch into the controller. The only way anything here changes state. */
  send: (event: EditorEvent) => void;
}

/** The conflict / discard / external-change prompt. */
function Prompt({ prompt, send }: { prompt: EditorPrompt; send: (event: EditorEvent) => void }) {
  return (
    <div class={`weave-note-prompt weave-note-prompt-${prompt.kind}`} role="alert">
      <p class="weave-note-prompt-text">{prompt.message}</p>
      <p class="weave-note-prompt-actions">
        {prompt.actions.map((action) => (
          <button key={action.label} type="button" class="weave-note-action" onClick={() => send(action.event)}>
            {action.label}
          </button>
        ))}
      </p>
    </div>
  );
}

/** The toolbar: edit/done, save, open-in-$EDITOR, and the status word. */
export function EditorBar(props: EditorProps) {
  const { toolbar, send } = props;
  return (
    <div class="weave-note-bar">
      <button
        type="button"
        class="weave-note-toggle"
        aria-pressed={toolbar.editing}
        onClick={() => send({ type: "toggle" })}
      >
        {toolbar.toggleLabel}
      </button>
      {toolbar.editing ? (
        <button type="button" class="weave-note-save" disabled={!toolbar.canSave} onClick={() => send({ type: "save" })}>
          {toolbar.saveLabel}
        </button>
      ) : null}
      <button type="button" class="weave-note-open" title={OPEN_HINT} onClick={() => send({ type: "open" })}>
        {OPEN_LABEL}
      </button>
      {toolbar.dirty ? (
        <span class="weave-note-dirty" title="unsaved changes" aria-hidden="true">
          •
        </span>
      ) : null}
      {toolbar.message === null ? null : <span class={`weave-note-status weave-note-status-${toolbar.tone}`}>{toolbar.message}</span>}
      {props.prompt === null ? null : <Prompt prompt={props.prompt} send={send} />}
    </div>
  );
}

/**
 * The editing surface.
 *
 * `⌘S` is handled here as well as globally, and deliberately: the global
 * `keydown` listener sees every keystroke in the workspace, so claiming a
 * modifier combination there is a workspace-wide claim. Handling it on the
 * textarea too means the save fires from the element that owns the text even
 * if the global map is later narrowed — and `keys.model.ts` returns `null`
 * for anything it does not claim, so the two never fight over one event.
 */
export function Editor(props: EditorProps) {
  return (
    <textarea
      class="weave-note-editor"
      aria-label="Note body"
      spellcheck
      value={props.draft}
      onInput={(event) => props.send({ type: "draft", text: (event.target as HTMLTextAreaElement).value })}
      onKeyDown={(event) => {
        if (event.key.toLowerCase() !== "s" || !(event.metaKey || event.ctrlKey)) return;
        event.preventDefault();
        props.send({ type: "save" });
      }}
    />
  );
}
