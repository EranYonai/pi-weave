/**
 * The three-column grid, its dividers and the context rail
 * (weave-workspace §1.2).
 *
 * The one interesting line is the `useLayoutEffect`: column widths reach the
 * DOM as **custom properties**, written through `applyVars` →
 * `style.setProperty`. That is the CSSOM path, which `style-src 'nonce-…'`
 * does not govern — see `cssvars.ts` for the verified reasoning — and it
 * leaves the actual `grid-template-columns` rule in the nonce'd stylesheet
 * where it can be read.
 *
 * `useLayoutEffect` rather than `useEffect` so the widths land before paint;
 * with `useEffect` the first frame renders at whatever the CSS fallback says
 * and then jumps.
 *
 * The column/divider pairing is {@link columnSlots}, not an index check here:
 * it is breakpoint-sensitive and therefore worth a test.
 *
 * All three columns are built as of P3, so {@link Column} dispatches on the
 * column id. That ternary chain is the one piece of branching in the file and
 * it is a *routing* decision, not a product one: each arm is a bare element,
 * and everything those components then decide lives in their own `.model.ts`.
 */

import { Fragment } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import { Graph } from "../graph/Graph";
import type { ColorScheme } from "../graph/graph.model";
import type { PositionStorage } from "../graph/positions";
import type { RendererFactory } from "../graph/renderer";
import type { SchemeHost } from "../graph/scheme";
import type { EditorEvent, EditorPrompt, EditorToolbar } from "../note/editor.model";
import { Note } from "../note/Note";
import { Tree } from "../tree/Tree";
import type { GraphPayload, NotePayload } from "../../shared/wire";
import { applyVars } from "./cssvars";
import type { ColumnId, DividerId, ResolvedColumn } from "./layout.model";
import { columnVars } from "./layout.model";
import { ContextRail } from "./ContextRail";
import { Divider } from "./Divider";
import type { ColumnSlot } from "./shell.model";
import { columnSlots, emptyStateFor } from "./shell.model";

export interface ColumnsProps {
  resolved: readonly ResolvedColumn[];
  onDown: (divider: DividerId, clientX: number, pointerId: number) => void;
  onMove: (clientX: number) => void;
  onUp: () => void;
  onKey: (divider: DividerId, key: string) => void;
  /** The §1.3 context bus, as the columns see it. */
  graph: GraphPayload | null;
  note: NotePayload | null;
  selectedId: string | null;
  /**
   * The §1.3 context bus.
   *
   * Takes `string | null` because the graph can *clear* the selection — a
   * click on empty stage — and no other column can. `workspace.ts`'s `select`
   * has always accepted `null`; this prop was merely narrower than the thing
   * behind it. The tree, the note column and the rail pass a `string`, which
   * a handler accepting the wider type takes without a cast.
   */
  onSelect: (id: string | null) => void;
  /** Epoch ms for relative times, read once per render by the shell. */
  now: number;
  /**
   * The graph column's three injected ports (§7.5, §10).
   *
   * Threaded through rather than imported by `Graph.tsx` for the reason
   * `api.dom.ts` exists: `createSigmaRenderer` imports sigma, which is a
   * `ReferenceError` outside a browser, so the module that names it must stay
   * reachable only from a `.tsx` entry point.
   */
  renderer: RendererFactory;
  storage: PositionStorage;
  host: SchemeHost;
  /**
   * The scheme the shell resolved from the user's theme choice
   * (`shell/theme.model.ts`'s `effectiveScheme`), or `null` to let the column
   * read the OS (`graph/scheme.ts`'s `schemeOf`). The stylesheet carries the
   * choice to everything CSS paints; WebGL cannot read custom properties, so
   * the graph needs the decision handed to it as a value.
   */
  scheme: ColorScheme | null;
  /** The boot graph fetch failed — see `state.ts`'s `graphFailed`. */
  bootFailed: boolean;
  /** Slot the graph column fills with its `fit`, for the global `g` key. */
  fit: { current: (() => void) | null };
  /**
   * The note editor's view model (§11 P5).
   *
   * Derived by the shell from the one `EditorHandle`, because the editor's
   * state outlives the note column's mount: below 800 px the column can be
   * unmounted by a resize, and an editor owned by the component would lose
   * an unsaved draft to a window drag.
   */
  toolbar: EditorToolbar | null;
  prompt: EditorPrompt | null;
  draft: string;
  send: (event: EditorEvent) => void;
}

/** One column: a titled region and whichever surface fills it. */
function Column({ id, props }: { id: ColumnId; props: ColumnsProps }) {
  const copy = emptyStateFor(id);
  return (
    <section class={`weave-col weave-col-${id}`} aria-label={copy.title}>
      <h2 class="weave-col-title">{copy.title}</h2>
      {id === "tree" ? <Tree graph={props.graph} selectedId={props.selectedId} onSelect={props.onSelect} now={props.now} /> : null}
      {id === "note" ? (
        <Note
          note={props.note}
          graph={props.graph}
          selectedId={props.selectedId}
          onSelect={props.onSelect}
          now={props.now}
          toolbar={props.toolbar}
          prompt={props.prompt}
          draft={props.draft}
          send={props.send}
        />
      ) : null}
      {id === "graph" ? (
        <Graph
          graph={props.graph}
          selectedId={props.selectedId}
          onSelect={props.onSelect}
          renderer={props.renderer}
          storage={props.storage}
          host={props.host}
          scheme={props.scheme}
          bootFailed={props.bootFailed}
          fit={props.fit}
        />
      ) : null}
      {id === "graph" ? <ContextRail graph={props.graph} selectedId={props.selectedId} onSelect={props.onSelect} /> : null}
    </section>
  );
}

/** A column and, where one follows it, its divider. */
function Slot({ slot, props }: { slot: ColumnSlot; props: ColumnsProps }) {
  const divider = slot.divider;
  return (
    <Fragment>
      <Column id={slot.column.id} props={props} />
      {divider === null ? null : (
        <Divider
          id={divider}
          label={`Resize ${slot.column.id} column`}
          onDown={(x, pointerId) => props.onDown(divider, x, pointerId)}
          onMove={props.onMove}
          onUp={props.onUp}
          onKey={(key) => props.onKey(divider, key)}
        />
      )}
    </Fragment>
  );
}

export function Columns(props: ColumnsProps) {
  const grid = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    applyVars(grid.current, columnVars(props.resolved));
  }, [props.resolved]);

  return (
    <div class="weave-grid" ref={grid} data-columns={props.resolved.length}>
      {columnSlots(props.resolved).map((slot) => (
        <Slot key={slot.column.id} slot={slot} props={props} />
      ))}
    </div>
  );
}
