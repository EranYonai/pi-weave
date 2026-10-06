/**
 * The note column — reading, and editing (weave-workspace §1.2, P2.4, P5, P6.3).
 *
 * Props in, JSX out. The markdown pipeline, sanitiser config, wikilink
 * resolution and every string are in `note.model.ts`. This file wires the
 * rendered body, selection-safe wikilink navigation, the Open in `$EDITOR`
 * action, and the body editor.
 *
 * ## The editor
 *
 * The explicit Edit control swaps the body for a `<textarea>`; `draft` is
 * `null` in read mode, so text and mode cannot disagree. No reducer — the 686-line one that
 * stood here resolved conflicts against a revision the server no longer
 * issues. Drafts are keyed by note identity in the shared in-memory store, out of the
 * 2 s poll's reach; the shell guards removal of their final visible tab.
 *
 * `dangerouslySetInnerHTML` is used deliberately for sanitized note HTML. The
 * alternative is parsing marked's output into a Preact tree, which means a
 * second HTML parser in the bundle and a second place for a sanitisation
 * mistake to hide. One clearly-marked line whose input is
 * `renderNote(DOMPurify, …)` is easier to audit than a second HTML parser.
 *
 * ## Wikilink preview (P6.3)
 *
 * Hovering or focusing a wikilink opens a small card for its target. The
 * body's delegated handlers extend to the card for
 * free — `mouseover`, `focusin` and `keydown` are read through the same
 * ancestor walk (`previewAnchorOf`), the state machine is `reducePreview`,
 * and this file's only contribution is forwarding the pointer's viewport
 * coordinates. The card is `pointer-events: none`, which is why it can never
 * fight the click: hovering "through" it is not possible, so the reader's
 * next gesture always reaches the link underneath.
 *
 * Positioning is a `useLayoutEffect`, not an inline style: the CSP allows no
 * `style="…"` attribute, and the card's text (so its height) is not known
 * until it is mounted. The effect measures it, asks `previewPlacement` for
 * its spot, and writes the result as custom properties through the same
 * CSSOM path `cssvars.ts` uses.
 */

import DOMPurify from "dompurify";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { GraphPayload, NotePayload } from "../../shared/wire";
import {
  CREATED_WORD,
  artifactKeyOfNode,
  DISCARD_PROMPT,
  DONE_LABEL,
  EDIT_LABEL,
  EDITED_WORD,
  EDITOR_ARIA_LABEL,
  EMPTY_PREVIEW,
  SAVE_LABEL,
  SAVING_LABEL,
  TASK_CHECKBOX_ATTR,
  WIKILINK_ATTR,
  hasTextSelection,
  noteEmptyMessage,
  noteHeader,
  previewAnchorOf,
  previewCard,
  previewPlacement,
  reducePreview,
  renderNote,
  selectedArtifactPath,
  tagLabel,
  taskCheckboxIndexOf,
  taskCheckboxLabel,
  toggleTaskCheckbox,
  wikiIndex,
  wikilinkTargetOf,
} from "./note.model";
import type { NoteHeaderView, PreviewElement, PreviewEvent } from "./note.model";
import { createDraftStore } from "./drafts";
import type { DraftStore } from "./drafts";
import { ScenePreview } from "./ScenePreview";

/**
 * The custom properties the preview card is placed with, written by the
 * layout effect through the CSSOM and consumed by `theme.ts`'s
 * `.weave-preview` rule — the same ownership split `cssvars.ts` uses for the
 * column widths.
 */
const PREVIEW_X = "weave-preview-x";
const PREVIEW_Y = "weave-preview-y";

export interface NoteProps {
  spellcheck?: boolean;
  defaultEdit?: boolean;
  note: NotePayload | null;
  loadFailed: boolean;
  graph: GraphPayload | null;
  selectedId: string | null;
  vaultRoot?: string;
  onSelect: (id: string, newTab?: boolean) => void;
  onOpen: (slug: string) => void;
  /**
   * Save the note's body. Resolves `true` when the write landed; a `false`
   * has already been reported to the user by the shell, which owns the one
   * error-reporting gesture the client has.
   */
  onSave: (slug: string, body: string) => Promise<boolean>;
  /** Shared across Note instances so duplicate tabs edit one in-memory body. */
  drafts?: DraftStore;
  /** Stable per view; distinct when the same note is mounted more than once. */
  idPrefix?: string;
  /** Monotonic identity of the document load that produced `note`. */
  loadVersion: number;
  /** Epoch ms for relative times. Injected so the render is deterministic. */
  now: number;
}

/**
 * Title, one quiet meta line, tags.
 *
 * The hierarchy is the point: the title is the page's largest voice and the
 * meta line is its footnote — provenance glyph and word, edited, created.
 * The Open in `$EDITOR` action sits at the end of that line as an icon, where
 * a workflow control belongs in a column whose job is reading.
 */
function Header({
  view,
  open,
  editing,
  saving,
  taskSaving,
  onToggle,
  onSave,
}: {
  view: NoteHeaderView;
  open: () => void;
  editing: boolean;
  saving: boolean;
  taskSaving: boolean;
  onToggle: () => void;
  onSave: () => void;
}) {
  return (
    <header class="weave-note-head">
      <h3 class="weave-note-title">{view.title}</h3>
      <p class="weave-note-meta">
        {editing ? (
          <>
            <button type="button" class="weave-note-save" disabled={saving || taskSaving} onClick={onSave}>
              {saving ? SAVING_LABEL : SAVE_LABEL}
            </button>
            <button type="button" class="weave-note-edit" disabled={taskSaving} onClick={onToggle}>{DONE_LABEL}</button>
          </>
        ) : <button type="button" class="weave-note-edit" disabled={taskSaving} onClick={onToggle}>{EDIT_LABEL}</button>}
        <button type="button" class="weave-note-open" title="Open in $EDITOR" aria-label="Open in $EDITOR" onClick={open}>
          <span class="weave-note-open-mark" aria-hidden="true">↗</span>
        </button>
        <span class={`weave-prov weave-prov-${view.provenance}`} title={view.provenanceTitle}>
          {view.provenanceGlyph} {view.provenance}
        </span>
        <span class="weave-note-time" title={view.updatedIso}>
          {EDITED_WORD} {view.updated}
        </span>
        <span class="weave-note-time" title={view.createdIso}>
          {CREATED_WORD} {view.created}
        </span>
      </p>
      <p class="weave-note-tags">
        {view.tags.map((tag) => (
          <span key={tag} class="weave-tag">
            {tagLabel(tag)}
          </span>
        ))}
      </p>
    </header>
  );
}

export function Note(props: NoteProps) {
  const localDrafts = useRef(createDraftStore());
  const drafts = props.drafts ?? localDrafts.current;
  const generatedId = useId();
  const previewId = `${props.idPrefix ?? generatedId}-weave-preview`;
  const [storeVersion, setDraftVersion] = useState(0);
  useEffect(() => drafts.subscribe(() => setDraftVersion((version) => version + 1)), [drafts]);
  const note = props.note?.note ?? null;
  const body = note === null ? "" : drafts.getTaskBody(note.slug, note.body);
  const artifactPath = selectedArtifactPath(props.graph, props.selectedId);
  const empty = noteEmptyMessage(props.selectedId, note, props.loadFailed);

  // Both hook calls sit before the empty-return so the hook order cannot
  // depend on whether a note is loaded. The memoization is cheap insurance:
  // one marked parse + DOMPurify pass + O(nodes) index per body or vault
  // instead of per shell render. The instance the render builds —
  // `markdownRenderer(index)` inside `renderNote` — stays per-call by design;
  // only the *result* is memoized.
  const index = useMemo(() => (note === null ? null : wikiIndex(props.graph, note.slug)), [note, props.graph]);
  const html = useMemo(
    () => (note === null || index === null ? "" : renderNote(DOMPurify, body, index)),
    [note, body, index],
  );

  // The hover card. The reducer lives in `note.model.ts`; this is its
  // dispatch. Held per column deliberately — a preview is a gesture about the
  // note on screen, and a card that survives the note it pointed at is a
  // stale claim.
  const [preview, sendPreview] = useState(EMPTY_PREVIEW);
  const dispatch = (event: PreviewEvent): void => void sendPreview((state) => reducePreview(state, event));
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const draft = note === null ? null : drafts.get(note.slug);
  const taskSaving = note !== null && drafts.isTaskSaving(note.slug);
  const save = async (): Promise<void> => {
    if (note !== null && !drafts.isTaskSaving(note.slug)) await drafts.save(note.slug, props.onSave);
  };

  const saveTask = async (checkbox: HTMLInputElement, taskIndex: number): Promise<void> => {
    const restore = (): void => {
      checkbox.checked = !checkbox.checked;
      checkbox.setAttribute("aria-label", taskCheckboxLabel(checkbox.checked));
    };
    if (note === null || drafts.isTaskSaving(note.slug)) {
      restore();
      return;
    }
    const nextBody = toggleTaskCheckbox(drafts.getTaskBody(note.slug, note.body), taskIndex);
    if (nextBody === null) {
      restore();
      return;
    }

    const inputs = [...(bodyRef.current?.querySelectorAll<HTMLInputElement>(`input[${TASK_CHECKBOX_ATTR}]`) ?? [])];
    checkbox.setAttribute("aria-label", taskCheckboxLabel(checkbox.checked));
    for (const input of inputs) input.disabled = true;
    try {
      if (!await drafts.saveTask(note.slug, nextBody, props.onSave)) restore();
    } catch (error) {
      restore();
      throw error;
    } finally {
      for (const input of inputs) input.disabled = drafts.isTaskSaving(note.slug);
    }
  };

  const defaultOpened = useRef<string | null>(null);
  useEffect(() => {
    if (note !== null && defaultOpened.current !== note.slug) {
      defaultOpened.current = note.slug;
      if (props.defaultEdit && drafts.get(note.slug) === null) drafts.open(note.slug, body);
    }
  }, [note?.slug, props.defaultEdit]);

  const toggleEdit = (): void => {
    if (note === null || drafts.isTaskSaving(note.slug)) return;
    if (drafts.get(note.slug) === null) drafts.open(note.slug, body);
    else if (!drafts.isDirty(note.slug) || window.confirm(DISCARD_PROMPT)) drafts.discard(note.slug);
  };
  const card = preview.anchor === null ? null : previewCard(props.graph, preview.anchor);

  useLayoutEffect(() => {
    if (note !== null) drafts.taskBody(note.slug, note.body, props.loadVersion);
  }, [drafts, note === null ? null : note.slug, note?.body, props.loadVersion]);

  // A card whose target note left the screen is a claim about a document that
  // is gone. Navigating (or an SSE swap of the open note, which is what
  // `note.slug` changing underneath the pointer looks like) closes it rather
  // than leaving a preview pointing at prose that is no longer here. This is
  // one effect per *open note*, not per render: it reads the slug, and the
  // slug changes as rarely as navigation happens.
  useLayoutEffect(() => {
    dispatch({ type: "hide" });
    // Drafts belong to note identity and survive this Note instance changing
    // documents or unmounting.
  }, [note === null ? null : note.slug]);

  useLayoutEffect(() => {
    if (note === null) return;
    const saving = drafts.isTaskSaving(note.slug);
    for (const input of bodyRef.current?.querySelectorAll<HTMLInputElement>(`input[${TASK_CHECKBOX_ATTR}]`) ?? []) {
      input.disabled = saving;
    }
  }, [note === null ? null : note.slug, storeVersion, html]);

  // Wired after the card mounts, because both jobs depend on the live DOM:
  // the card's size (the placement decision needs measured dimensions, which
  // no render can know), and `aria-describedby`, which the link has to carry
  // for the card to be *announced* rather than merely seen. The rendered HTML
  // is a string, so the attribute is written back onto the one open link per
  // preview — imperative, and deliberately so: the alternative is re-rendering
  // the whole body through marked on every pointer move.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (body !== null) {
      const slug = preview.anchor?.slug ?? null;
      for (const link of body.querySelectorAll(`a[${WIKILINK_ATTR}]`)) {
        if (slug !== null && link.getAttribute(WIKILINK_ATTR) === slug) link.setAttribute("aria-describedby", previewId);
        else link.removeAttribute("aria-describedby");
      }
    }
    const element = cardRef.current;
    if (element === null || card === null) return;
    // Measured, not guessed: the geometry the placement decision needs is the
    // card's own box as it now is, and by the time this effect runs it *is*.
    const spot = previewPlacement(
      preview.pointerX,
      preview.pointerY,
      element.offsetWidth,
      element.offsetHeight,
      window.innerWidth,
      window.innerHeight,
    );
    // CSSOM, not an attribute: `style="…"` is what the CSP forbids, and
    // `setProperty` is the path it has no hook on.
    element.style.setProperty(`--${PREVIEW_X}`, `${spot.x}px`);
    element.style.setProperty(`--${PREVIEW_Y}`, `${spot.y}px`);
  }, [preview, card, previewId]);

  if (artifactPath !== null) {
    const artifact = props.graph?.model.nodes.find((node) => node.id === props.selectedId);
    const title = artifact?.label ?? artifactPath;
    const artifactKey = artifact === undefined ? artifactPath : artifactKeyOfNode(artifact) ?? artifactPath;
    return (
      <article key={artifactKey} class="weave-note weave-note-artifact">
        <header class="weave-note-head">
          <h3 class="weave-note-title">{title}</h3>
          <p class="weave-note-meta"><span class="weave-note-time">{artifactPath}</span></p>
        </header>
        {/\.excalidraw$/i.test(artifactPath) ? (
          <>
          <ScenePreview key={artifactKey} path={artifactPath} version={artifactKey} title={title} />
          <div class="weave-scene-handoff">
            <a class="weave-scene-download" href={`/api/scene/${encodeURIComponent(artifactPath)}`} download>Download editable source</a>
            <p>Open the downloaded file in <a href="https://excalidraw.com/" target="_blank" rel="noreferrer noopener">Excalidraw</a>. Save your edited file back to <code>{props.vaultRoot ? `${props.vaultRoot.replace(/[\\/]$/, "")}/` : ""}notes/{artifactPath}</code>, then refresh Weave.</p>
            <p>For offline editing, use your local or self-hosted Excalidraw editor.</p>
          </div>
          </>
        ) : <iframe
          key={artifactKey}
          class="weave-artifact-frame"
          title={title}
          sandbox="allow-scripts"
          src={`/api/artifact/${encodeURIComponent(artifactPath)}`}
        />}
      </article>
    );
  }

  if (note === null || index === null) return <p class="weave-note-empty">{empty}</p>;

  // Keyed on the slug, not the body digest: the article is the scroll
  // container, so an in-place swap would open every note at the previous
  // note's scroll offset. A key change remounts it, and a fresh container
  // starts at the top — no scroll-API effect to untest. The provenance
  // class is the page's spine: the left rule takes the source's colour,
  // which is how the desk says who wrote what a glance away from the text.
  const header = noteHeader(note, props.now);
  return (
    <article key={note.slug} class={`weave-note weave-note-${header.provenance}`}>
      <Header
        view={header}
        open={() => props.onOpen(note.slug)}
        editing={draft !== null}
        saving={draft?.saving ?? false}
        taskSaving={taskSaving}
        onToggle={toggleEdit}
        onSave={() => void save()}
      />
      {draft !== null ? (
        <textarea
          class="weave-note-editor"
          aria-label={EDITOR_ARIA_LABEL}
          spellcheck={props.spellcheck ?? true}
          value={draft.body}
          onInput={(event) => drafts.edit(note.slug, (event.target as HTMLTextAreaElement).value)}
          onKeyDown={(event) => {
            // Bound here, not in `keys.model.ts`: a global binding is a
            // workspace-wide claim, and Escape must not reach the shell.
            if (event.key === "Escape") {
              event.stopPropagation();
              toggleEdit();
              return;
            }
            if (event.key.toLowerCase() !== "s" || !(event.metaKey || event.ctrlKey)) return;
            event.preventDefault();
            void save();
          }}
        />
      ) : (
      <div
          ref={bodyRef}
          class="weave-note-body"
          // Programmatic focus target for `⌘2`: without a `tabindex`,
          // `focusSelector`'s `.focus()` is a silent no-op. `-1` keeps it out
          // of the Tab order (the workspace moves by `j/k` and `⌘1/2/3`, and
          // Tab must stay the user's).
          tabIndex={-1}
          // One delegated hover/focus pair, exactly as the click is delegated:
          // the body is re-rendered wholesale whenever the note changes, and
          // per-link listeners on `dangerouslySetInnerHTML` output would have
          // to be re-attached by hand. `mouseover` on plain prose yields a
          // null anchor, and the reducer answers that with "already closed",
          // so the stream across ordinary text costs nothing.
          onMouseOver={(event) => {
            const anchor = previewAnchorOf(event.target as unknown as PreviewElement);
            if (anchor !== null) dispatch({ type: "show", anchor, x: event.clientX, y: event.clientY });
            else dispatch({ type: "hide" });
          }}
          onMouseLeave={() => dispatch({ type: "hide" })}
          onFocus={(event) => {
            // Focus has no pointer coordinate, so the card anchors to the
            // link's own box instead — its leading bottom corner, where a
            // pointer would have been.
            const anchor = previewAnchorOf(event.target as unknown as PreviewElement);
            if (anchor === null) return;
            const box = (event.target as unknown as { getBoundingClientRect?(): { left: number; bottom: number } }).getBoundingClientRect?.();
            dispatch({ type: "show", anchor, x: box?.left ?? 0, y: box?.bottom ?? 0 });
          }}
          onBlur={() => dispatch({ type: "hide" })}
          onClick={(event) => {
            const checkbox = event.target as HTMLInputElement;
            const taskIndex = taskCheckboxIndexOf(checkbox);
            if (taskIndex !== null) {
              void saveTask(checkbox, taskIndex);
              return;
            }
            const selection =
              typeof window !== "undefined" && typeof window.getSelection === "function"
                ? window.getSelection()
                : null;
            if (hasTextSelection(selection)) return;
            const target = wikilinkTargetOf(event.target as unknown as Parameters<typeof wikilinkTargetOf>[0]);
            // A wikilink carries no href, so route it onto the context bus.
            if (target !== null) props.onSelect(target, event.metaKey || event.ctrlKey || event.shiftKey);
          }}
          onKeyDown={(event) => {
            // Escape is first so the card closes on the gesture a keyboard
            // user has for closing things, and the event is stopped short of
            // the global keymap: with focus on a wikilink, Escape means
            // "close this card". Letting it through would clear the whole
            // selection from a tooltip.
            if (event.key === "Escape" && preview.anchor !== null) {
              event.stopPropagation();
              dispatch({ type: "dismiss" });
              return;
            }
            if (event.key !== "Enter" && event.key !== " ") return;
            const target = wikilinkTargetOf(event.target as unknown as Parameters<typeof wikilinkTargetOf>[0]);
            if (target === null) return;
            event.preventDefault();
            props.onSelect(target, event.metaKey || event.ctrlKey || event.shiftKey);
          }}
          // Sanitised by `renderNote`'s three layers — see note.model.ts.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
      {card === null ? null : (
        <div
          ref={cardRef}
          id={previewId}
          role="tooltip"
          class={`weave-preview${card.ghost ? " weave-preview-ghost" : ""}`}
        >
          <span class="weave-preview-kind">{card.kind}</span>
          <span class="weave-preview-title">{card.title}</span>
          {card.text === "" ? null : <p class="weave-preview-text">{card.text}</p>}
        </div>
      )}
    </article>
  );
}
