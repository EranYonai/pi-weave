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
 * Clicking the prose swaps it for a `<textarea>`; `draft` is `null` in read
 * mode, so text and mode cannot disagree. No reducer — the 686-line one that
 * stood here resolved conflicts against a revision the server no longer
 * issues. Being component state, the draft is out of the 2 s poll's reach;
 * the shell guards it through the `editor` slot below.
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
 * delegated pattern the click handler established extends to the card for
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
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { GraphPayload, NotePayload } from "../../shared/wire";
import {
  CREATED_WORD,
  artifactKeyOfNode,
  DISCARD_PROMPT,
  DONE_LABEL,
  EDITED_WORD,
  EDITOR_ARIA_LABEL,
  EMPTY_PREVIEW,
  PREVIEW_ID,
  SAVE_LABEL,
  SAVING_LABEL,
  WIKILINK_ATTR,
  draftDirty,
  draftMoved,
  hasTextSelection,
  noteClickAction,
  saveLanded,
  noteEmptyMessage,
  noteHeader,
  previewAnchorOf,
  previewCard,
  previewPlacement,
  reducePreview,
  renderNote,
  selectedArtifactPath,
  tagLabel,
  wikiIndex,
  wikilinkTargetOf,
} from "./note.model";
import type { NoteHeaderView, PreviewElement, PreviewEvent } from "./note.model";

/**
 * The custom properties the preview card is placed with, written by the
 * layout effect through the CSSOM and consumed by `theme.ts`'s
 * `.weave-preview` rule — the same ownership split `cssvars.ts` uses for the
 * column widths.
 */
const PREVIEW_X = "weave-preview-x";
const PREVIEW_Y = "weave-preview-y";

export interface NoteProps {
  note: NotePayload | null;
  loadFailed: boolean;
  graph: GraphPayload | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpen: (slug: string) => void;
  /**
   * Save the note's body. Resolves `true` when the write landed; a `false`
   * has already been reported to the user by the shell, which owns the one
   * error-reporting gesture the client has.
   */
  onSave: (slug: string, body: string) => Promise<boolean>;
  /**
   * The shell's handle on the open editor — the `fit` pattern again. Guards
   * both *ask* (navigate, unload) and *close* (a tree rename of this note).
   * Functions, not values, or a mount-time guard answers "clean" forever.
   */
  editor: { current: { dirty(): boolean; discard(): void } | null };
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
  onDone,
  onSave,
}: {
  view: NoteHeaderView;
  open: () => void;
  editing: boolean;
  saving: boolean;
  onDone: () => void;
  onSave: () => void;
}) {
  return (
    <header class="weave-note-head">
      <h3 class="weave-note-title">{view.title}</h3>
      <p class="weave-note-meta">
        {/* Nothing in read mode: the prose is the way in. The way out needs a
            control, because "click the text" cannot also mean "stop". */}
        {editing ? (
          <>
            <button type="button" class="weave-note-save" disabled={saving} onClick={onSave}>
              {saving ? SAVING_LABEL : SAVE_LABEL}
            </button>
            <button type="button" class="weave-note-edit" onClick={onDone}>{DONE_LABEL}</button>
          </>
        ) : null}
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
  const note = props.note?.note ?? null;
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
    () => (note === null || index === null ? "" : renderNote(DOMPurify, note.body, index)),
    [note, index],
  );

  // The hover card. The reducer lives in `note.model.ts`; this is its
  // dispatch. Held per column deliberately — a preview is a gesture about the
  // note on screen, and a card that survives the note it pointed at is a
  // stale claim.
  const [preview, sendPreview] = useState(EMPTY_PREVIEW);
  const dispatch = (event: PreviewEvent): void => void sendPreview((state) => reducePreview(state, event));
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dirty = note !== null && draft !== null && draftDirty(draft, note.body);
  // Bumped on open and close, so a late reply knows it is late (`saveLanded`).
  const session = useRef(0);
  // The draft *now*: `save` outlives the render that captured its own copy.
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // During render, not in an effect: an effect runs after paint, leaving a
  // window where the slot is still clean and a click slips the guard.
  props.editor.current = { dirty: () => dirty, discard: () => close() };
  useEffect(() => () => {
    props.editor.current = null;
  }, [props.editor]);

  const close = (): void => {
    session.current += 1;
    setDraft(null);
    setSaving(false);
  };

  const open = (body: string): void => {
    session.current += 1;
    setDraft(body);
  };

  const save = async (): Promise<void> => {
    if (note === null || draft === null || saving) return;
    const issued = session.current;
    // The textarea stays enabled through the request, so the draft can move
    // underneath it; the reply is only ever about these bytes.
    const sent = draft;
    setSaving(true);
    const ok = await props.onSave(note.slug, sent);
    // A reply for an editor that is gone must not close the one now open.
    if (!saveLanded(issued, session.current)) return;
    // Stay open on failure, and on success the user typed through: both hold
    // text the server does not have, and closing would discard it.
    if (!ok || draftMoved(sent, draftRef.current)) setSaving(false);
    else close();
  };

  const toggleEdit = (): void => {
    if (note === null) return;
    if (draft === null) open(note.body);
    else if (!dirty || window.confirm(DISCARD_PROMPT)) close();
  };
  const card = preview.anchor === null ? null : previewCard(props.graph, preview.anchor);

  // A card whose target note left the screen is a claim about a document that
  // is gone. Navigating (or an SSE swap of the open note, which is what
  // `note.slug` changing underneath the pointer looks like) closes it rather
  // than leaving a preview pointing at prose that is no longer here. This is
  // one effect per *open note*, not per render: it reads the slug, and the
  // slug changes as rarely as navigation happens.
  useLayoutEffect(() => {
    dispatch({ type: "hide" });
    // A different note is a different document: an open editor holding the
    // previous one's text would save it over this one. The shell's guard is
    // what asks before a dirty draft gets here.
    close();
  }, [note === null ? null : note.slug]);

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
        if (slug !== null && link.getAttribute(WIKILINK_ATTR) === slug) link.setAttribute("aria-describedby", PREVIEW_ID);
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
  }, [preview, card]);

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
        <iframe
          key={artifactKey}
          class="weave-artifact-frame"
          title={title}
          sandbox="allow-scripts"
          src={`/api/artifact/${encodeURIComponent(artifactPath)}`}
        />
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
        saving={saving}
        onDone={toggleEdit}
        onSave={() => void save()}
      />
      {draft !== null ? (
        <textarea
          class="weave-note-editor"
          aria-label={EDITOR_ARIA_LABEL}
          spellcheck
          value={draft}
          onInput={(event) => setDraft((event.target as HTMLTextAreaElement).value)}
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
            // Three gestures, one element; `noteClickAction` owns the order.
            const selection =
              typeof window !== "undefined" && typeof window.getSelection === "function"
                ? window.getSelection()
                : null;
            const target = wikilinkTargetOf(event.target as unknown as Parameters<typeof wikilinkTargetOf>[0]);
            const action = noteClickAction(hasTextSelection(selection), target);
            // A wikilink carries no href, so route it onto the context bus.
            if (action === "navigate" && target !== null) props.onSelect(target);
            else if (action === "edit") open(note.body);
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
            event.preventDefault();
            // The keyboard's half of the click: without it, editing would be
            // mouse-only now that the Edit button is gone.
            if (target !== null) props.onSelect(target);
            else open(note.body);
          }}
          // Sanitised by `renderNote`'s three layers — see note.model.ts.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
      {card === null ? null : (
        <div
          ref={cardRef}
          id={PREVIEW_ID}
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
