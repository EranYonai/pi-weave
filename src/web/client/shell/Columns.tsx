/**
 * The resizable column grid and context rail. The shell supplies resolved
 * widths and only the columns allowed by the current responsive breakpoint.
 */

import { useLayoutEffect, useRef } from "preact/hooks";
import { Graph } from "../graph/Graph";
import type { ColorScheme } from "../graph/graph.model";
import type { PositionStorage } from "../graph/positions";
import type { RendererFactory } from "../graph/renderer";
import type { SchemeHost } from "../graph/scheme";
import { Note } from "../note/Note";
import { Tree } from "../tree/Tree";
import type { GraphPayload, NotePayload } from "../../shared/wire";
import type { ColumnId, DividerId, ResolvedColumn } from "./layout.model";
import { ContextRail } from "./ContextRail";
import { emptyStateFor } from "./shell.model";
import { Divider } from "./Divider";

export interface ColumnsProps {
  resolved: readonly ResolvedColumn[];
  onDown: (divider: DividerId, clientX: number) => void;
  onMove: (clientX: number) => void;
  onUp: () => void;
  onKey: (divider: DividerId, key: string) => void;
  /** The §1.3 context bus, as the columns see it. */
  graph: GraphPayload | null;
  note: NotePayload | null;
  selectedId: string | null;
  recentIds: ReadonlySet<string>;
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
  onRefresh: () => void;
  onOpen: (slug: string) => void;
  /** Save a note's body. Resolves `true` when the write landed. */
  onSave: (slug: string, body: string) => Promise<boolean>;
  /** Slot the note column fills with "is the draft dirty?", for the shell's guards. */
  dirty: { current: (() => boolean) | null };
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
  /** `?sliders=1` — the hidden force tuner (docs/weave-workspace.md §15.7). */
  tuner: boolean;
}

/** One column: a titled region and whichever surface fills it. */
function Column({ id, props }: { id: ColumnId; props: ColumnsProps }) {
  const copy = emptyStateFor(id);
  return (
    <section class={`weave-col weave-col-${id}`} aria-label={copy.title}>
      <h2 class="weave-col-title">{copy.title}</h2>
      {id === "tree" ? <Tree graph={props.graph} selectedId={props.selectedId} recentIds={props.recentIds} onSelect={props.onSelect} onRefresh={props.onRefresh} now={props.now} /> : null}
      {id === "note" ? (
        <Note
          note={props.note}
          graph={props.graph}
          selectedId={props.selectedId}
          onSelect={props.onSelect}
          now={props.now}
          onOpen={props.onOpen}
          onSave={props.onSave}
          dirty={props.dirty}
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
          tuner={props.tuner}
        />
      ) : null}
      {id === "graph" ? <ContextRail graph={props.graph} selectedId={props.selectedId} onSelect={props.onSelect} /> : null}
    </section>
  );
}

export function Columns(props: ColumnsProps) {
  const grid = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const element = grid.current;
    if (element === null) return;
    for (const { id, width } of props.resolved) element.style.setProperty(`--weave-col-${id}`, `${Math.round(width)}px`);
  }, [props.resolved]);
  return <div class="weave-grid" ref={grid} data-columns={props.resolved.length}>
    {props.resolved.map((column, index) => {
      const divider: DividerId | null = index < props.resolved.length - 1 && column.id !== "graph" ? column.id : null;
      return [
        <Column key={`${column.id}-column`} id={column.id} props={props} />,
        divider === null ? null : <Divider key={`${column.id}-divider`} label={`Resize ${column.id} column`}
          onDown={(x) => props.onDown(divider, x)} onMove={props.onMove} onUp={props.onUp}
          onKey={(key) => props.onKey(divider, key)} />,
      ];
    })}
  </div>;
}
