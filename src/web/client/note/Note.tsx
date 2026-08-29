/**
 * The note column (weave-workspace §1.2, P2.4, P5).
 *
 * Props in, JSX out. The markdown pipeline, the sanitiser config, the
 * wikilink resolution and every string are `note.model.ts`; the editor's
 * dirty tracking, save lifecycle and conflict resolution are
 * `editor.model.ts`. This file wires a click handler, sets `innerHTML` with
 * content that has already been through all three of that module's layers,
 * and swaps the rendered body for a `<textarea>` when the editor is open.
 *
 * `dangerouslySetInnerHTML` is used deliberately and exactly once. The
 * alternative is parsing marked's output into a Preact tree, which means a
 * second HTML parser in the bundle and a second place for a sanitisation
 * mistake to hide. One clearly-marked line whose input is
 * `renderNote(DOMPurify, …)` is easier to audit than a hundred lines that
 * avoid the word "dangerously".
 *
 * The read view is rendered from the **note**, not from the draft: what the
 * `<textarea>` holds is unsaved and un-sanitised, and piping it through
 * `renderNote` on every keystroke would be a live preview paid for with a
 * markdown parse and a DOMPurify pass per character. §11 P5.4 mentions a live
 * preview; the honest version of it is `⌘E`, which is instant and shows the
 * text that actually exists.
 */

import DOMPurify from "dompurify";
import { useMemo } from "preact/hooks";
import type { GraphPayload, NotePayload } from "../../shared/wire";
import type { EditorEvent, EditorPrompt, EditorToolbar } from "./editor.model";
import { Editor, EditorBar } from "./Editor";
import type { NoteHeaderView } from "./note.model";
import { noteEmptyMessage, noteHeader, renderNote, tagLabel, wikiIndex, wikilinkTargetOf } from "./note.model";

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

function Header({ view }: { view: NoteHeaderView }) {
  return (
    <header class="weave-note-head">
      <h3 class="weave-note-title">{view.title}</h3>
      <p class="weave-note-meta">
        <span class={`weave-prov weave-prov-${view.provenance}`} title={view.provenanceTitle}>
          {view.provenanceGlyph} {view.provenance}
        </span>
        <span class="weave-note-time" title={view.updatedIso}>
          updated {view.updated}
        </span>
        <span class="weave-note-time" title={view.createdIso}>
          created {view.created}
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

  if (note === null || index === null) return <p class="weave-note-empty">{empty}</p>;

  // Bound once so TypeScript narrows it for both uses below: `toolbar.editing`
  // is what decides whether the textarea renders, and reading it twice off
  // `props` would need a non-null assertion at the second read.
  const toolbar = props.toolbar;
  const shell = { draft: props.draft, prompt: props.prompt, send: props.send };
  return (
    // Keyed on the slug, not the body digest: the article is the scroll
    // container, so an in-place swap would open every note at the previous
    // note's scroll offset. A key change remounts it, and a fresh container
    // starts at the top — no scroll-API effect to untest.
    <article key={note.slug} class="weave-note">
      <Header view={noteHeader(note, props.now)} />
      {toolbar === null ? null : <EditorBar toolbar={toolbar} {...shell} />}
      {toolbar !== null && toolbar.editing ? (
        <Editor toolbar={toolbar} {...shell} />
      ) : (
        <div
          class="weave-note-body"
          // Programmatic focus target for `⌘2`: without a `tabindex`,
          // `focusSelector`'s `.focus()` is a silent no-op. `-1` keeps it out
          // of the Tab order (the workspace moves by `j/k` and `⌘1/2/3`, and
          // Tab must stay the user's).
          tabIndex={-1}
          onClick={(event) => {
            // A wikilink carries no href, so nothing is navigating; this only
            // has to route the click onto the §1.3 context bus.
            const target = wikilinkTargetOf(event.target as unknown as Parameters<typeof wikilinkTargetOf>[0]);
            if (target !== null) props.onSelect(target);
          }}
          onKeyDown={(event) => {
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
    </article>
  );
}
