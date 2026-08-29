/**
 * The note column (weave-workspace §1.2, P2.4, P5, P6.3).
 *
 * Props in, JSX out. The markdown pipeline, the sanitiser config, the
 * wikilink resolution and every string are `note.model.ts`; the editor's
 * dirty tracking, save lifecycle and conflict resolution are
 * `editor.model.ts`. This file wires a click handler, sets `innerHTML` with
 * content that has already been through all three of that module's layers,
 * and swaps the rendered body for a `<textarea>` when the editor is open.
 *
 * `dangerouslySetInnerHTML` is used deliberately and exactly twice. The
 * alternative is parsing marked's output into a Preact tree, which means a
 * second HTML parser in the bundle and a second place for a sanitisation
 * mistake to hide. One clearly-marked line whose input is
 * `renderNote(DOMPurify, …)` is easier to audit than a hundred lines that
 * avoid the word "dangerously". The second is the ⌘E control's icon — a
 * constant from `editor.model.ts`, not note content, and small enough that
 * a second site is cheaper than an icon component.
 *
 * The read view is rendered from the **note**, not from the draft: what the
 * `<textarea>` holds is unsaved and un-sanitised, and piping it through
 * `renderNote` on every keystroke would be a live preview paid for with a
 * markdown parse and a DOMPurify pass per character. §11 P5.4 mentions a live
 * preview; the honest version of it is `⌘E`, which is instant and shows the
 * text that actually exists.
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
import { useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { GraphPayload, NotePayload } from "../../shared/wire";
import { Editor, EditorBar } from "./Editor";
import type { EditorEvent, EditorPrompt, EditorToolbar } from "./editor.model";
import { OPEN_HINT, OPEN_ICON, OPEN_LABEL } from "./editor.model";
import {
  CREATED_WORD,
  EDITED_WORD,
  EMPTY_PREVIEW,
  PREVIEW_ID,
  WIKILINK_ATTR,
  noteEmptyMessage,
  noteHeader,
  previewAnchorOf,
  previewCard,
  previewPlacement,
  reducePreview,
  renderNote,
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
  graph: GraphPayload | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Epoch ms for relative times. Injected so the render is deterministic. */
  now: number;
  /** The editor's view model, or `null` when the shell wired no editor. */
  toolbar: EditorToolbar | null;
  prompt: EditorPrompt | null;
  /** The `<textarea>`'s content. Rendered only while `toolbar.editing`. */
  draft: string;
  send: (event: EditorEvent) => void;
}

/**
 * Title, one quiet meta line, tags.
 *
 * The hierarchy is the point: the title is the page's largest voice and the
 * meta line is its footnote — provenance glyph and word, edited, created.
 * `⌘E` sits at the end of that line as an icon, where a control about
 * *workflow* belongs in a column whose job is *reading*; its explanation
 * rides the `title` attribute so the icon never has to explain itself on
 * screen.
 */
function Header({ view, open }: { view: NoteHeaderView; open: (() => void) | null }) {
  return (
    <header class="weave-note-head">
      <h3 class="weave-note-title">{view.title}</h3>
      <p class="weave-note-meta">
        <span class={`weave-prov weave-prov-${view.provenance}`} title={view.provenanceTitle}>
          {view.provenanceGlyph} {view.provenance}
        </span>
        <span class="weave-note-time" title={view.updatedIso}>
          {EDITED_WORD} {view.updated}
        </span>
        <span class="weave-note-time" title={view.createdIso}>
          {CREATED_WORD} {view.created}
        </span>
        {open === null ? null : (
          <button type="button" class="weave-note-open" title={OPEN_HINT} aria-label={OPEN_LABEL} onClick={open}>
            <span class="weave-note-open-mark" aria-hidden="true" dangerouslySetInnerHTML={{ __html: OPEN_ICON }} />
          </button>
        )}
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
  const empty = noteEmptyMessage(props.selectedId, note);

  // Both hook calls sit before the empty-return so the hook order cannot
  // depend on whether a note is loaded. The memoization is cheap insurance:
  // one marked parse + DOMPurify pass + O(nodes) index per *body or vault*
  // instead of per shell render (every editor keystroke and divider pixel
  // re-renders the shell). The instance the render builds —
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
  const card = preview.anchor === null ? null : previewCard(props.graph, preview.anchor);

  // A card whose target note left the screen is a claim about a document that
  // is gone. Navigating (or an SSE swap of the open note, which is what
  // `note.slug` changing underneath the pointer looks like) closes it rather
  // than leaving a preview pointing at prose that is no longer here. This is
  // one effect per *open note*, not per render: it reads the slug, and the
  // slug changes as rarely as navigation happens.
  useLayoutEffect(() => {
    dispatch({ type: "hide" });
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

  if (note === null || index === null) return <p class="weave-note-empty">{empty}</p>;

  // Bound once so TypeScript narrows it for both uses below: `toolbar.editing`
  // is what decides whether the textarea renders, and reading it twice off
  // `props` would need a non-null assertion at the second read.
  const toolbar = props.toolbar;
  const shell = { draft: props.draft, prompt: props.prompt, send: props.send };
  // Keyed on the slug, not the body digest: the article is the scroll
  // container, so an in-place swap would open every note at the previous
  // note's scroll offset. A key change remounts it, and a fresh container
  // starts at the top — no scroll-API effect to untest. The provenance
  // class is the page's spine: the left rule takes the source's colour,
  // which is how the desk says who wrote what a glance away from the text.
  const header = noteHeader(note, props.now);
  return (
    <article key={note.slug} class={`weave-note weave-note-${header.provenance}`}>
      <Header view={header} open={toolbar === null ? null : () => props.send({ type: "open" })} />
      {toolbar === null ? null : <EditorBar toolbar={toolbar} {...shell} />}
      {toolbar !== null && toolbar.editing ? (
        <Editor toolbar={toolbar} {...shell} />
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
            // A wikilink carries no href, so nothing is navigating; this only
            // has to route the click onto the §1.3 context bus. Anywhere else
            // on the page *is* the edit affordance: a click on the prose opens
            // the editor. The two never fight, because the link check reads
            // the exact element the click landed on.
            const target = wikilinkTargetOf(event.target as unknown as Parameters<typeof wikilinkTargetOf>[0]);
            if (target !== null) {
              props.onSelect(target);
              return;
            }
            if (props.toolbar !== null) props.send({ type: "toggle" });
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
            props.onSelect(target);
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