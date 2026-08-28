/**
 * The graph column (weave-workspace §1.2, §7, P3).
 *
 * Props in, JSX out, and one `ref` handed to a renderer. Every string, every
 * branch and every set comes from `column.model.ts`, `graph.model.ts` or
 * `positions.ts`; what is left here is a `useState`, three effects and four
 * handlers. §10's rule, and the reason the 95 % gate survives a phase whose
 * whole deliverable is a WebGL canvas.
 *
 * The three effects, all one-liners over injected units:
 *
 *  1. **mount** — build a renderer, attach it to the `<div>`, subscribe to
 *     selection. The returned `destroy` is the cleanup, so a hot reload cannot
 *     leak a WebGL context.
 *  2. **graph** — push the drawn model whenever the reduction or the layout
 *     changes. Keyed on `model.key`, which is the *shape* digest, so an SSE
 *     tick that changed a note's body does not re-upload the graph (§7.3:
 *     re-run on drag or expand/collapse, not every frame).
 *  3. **highlight** — push the neighbourhood whenever the selection moves.
 *     This is the §1.3 bus arriving from the tree, a wikilink or the context
 *     rail; the graph does not care which, and that is the whole mechanism
 *     behind "selecting anywhere highlights everywhere".
 *
 * ## The `live` ref
 *
 * The renderer's `onSelect` is registered once at mount and outlives every
 * render, so a handler that closed over `view` and `model` directly would keep
 * answering with the state as it was at mount. The same `live.current` pattern
 * `Shell.tsx` uses for its drag handlers, for the same reason.
 */

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { GraphPayload } from "../../shared/wire";
import type { GraphViewState } from "./column.model";
import {
  DEPTHS,
  FIT_HINT,
  FIT_LABEL,
  LEGEND,
  allExpanded,
  depthHint,
  depthLabel,
  effectiveView,
  expandHint,
  expandLabel,
  graphClick,
  graphColumnModel,
  graphCountLabel,
  parseDepth,
  setDepth,
  toggleExpandAll,
} from "./column.model";
import type { PositionStorage } from "./positions";
import type { GraphRenderer, RendererFactory } from "./renderer";
import { schemeOf } from "./scheme";
import type { SchemeHost } from "./scheme";

export interface GraphProps {
  graph: GraphPayload | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Injected: `createSigmaRenderer` in the browser, a fake in a test. */
  renderer: RendererFactory;
  /** Injected: `localStorage`. See `positions.ts` for why it is a port. */
  storage: PositionStorage;
  /** Injected: `window`. Read once, for `prefers-color-scheme`. */
  host: SchemeHost;
  /**
   * A slot the column writes its `fit` into, so the global `g` key can reach
   * it (§11 P4).
   *
   * A ref rather than lifting the renderer into the shell: the renderer is
   * created, owned and destroyed by the mount effect below, and hoisting it
   * would move a WebGL lifecycle out of the one component that can see the
   * `<div>` it attaches to. A slot the column fills and clears on unmount
   * keeps the ownership where it is and costs one line at each end.
   */
  fit: { current: (() => void) | null };
}

export function Graph(props: GraphProps) {
  const canvas = useRef<HTMLDivElement | null>(null);
  const renderer = useRef<GraphRenderer | null>(null);
  // `null` means "the user has not touched the expansion" — not "nothing is
  // expanded". `effectiveView` resolves the difference; see its doc comment.
  const [state, setState] = useState<GraphViewState | null>(null);

  const scheme = useMemo(() => schemeOf(props.host), [props.host]);
  const view = effectiveView(props.graph, state);
  const model = graphColumnModel(props.graph, props.selectedId, view, props.storage, scheme);
  const everything = allExpanded(view, model.clusters);

  // Read by the mount-time `onSelect`, which outlives this render.
  const live = useRef({ view, model, onSelect: props.onSelect });
  live.current = { view, model, onSelect: props.onSelect };

  useEffect(() => {
    const instance = props.renderer(scheme);
    instance.onSelect((id) => {
      const next = graphClick(live.current.view, live.current.model.clusters, id);
      setState(next.state);
      live.current.onSelect(next.selectedId);
    });
    instance.mount(canvas.current ?? { clientWidth: 0, clientHeight: 0 });
    renderer.current = instance;
    props.fit.current = () => instance.fit();
    return () => {
      instance.destroy();
      renderer.current = null;
      // Cleared, not left dangling: `g` after a breakpoint has unmounted the
      // graph column would otherwise call `fit` on a destroyed WebGL context.
      props.fit.current = null;
    };
  }, [props.renderer, scheme]);

  useEffect(() => {
    renderer.current?.setGraph(model.graph);
  }, [model.key]);

  useEffect(() => {
    renderer.current?.setHighlight(model.highlight);
  }, [model.highlight]);

  return (
    <div class="weave-graph">
      {/* Same shape as `ContextRail`'s: the *decision* is `graphEmptyMessage`,
          and what is left here is whether to render the paragraph it returned. */}
      {model.empty === null ? null : <p class="weave-graph-empty">{model.empty}</p>}
      <div class="weave-graph-canvas" ref={canvas} role="img" aria-label="Knowledge graph" />
      <div class="weave-graph-controls">
        <button type="button" class="weave-chip" title={FIT_HINT} onClick={() => renderer.current?.fit()}>
          {FIT_LABEL}
        </button>
        <button type="button" class="weave-chip" title={expandHint(everything)} onClick={() => setState(toggleExpandAll(view, model.clusters))}>
          {expandLabel(everything)}
        </button>
        <select
          class="weave-chip weave-depth"
          title={depthHint(view.depth)}
          aria-label="Highlight depth"
          value={String(view.depth)}
          onChange={(event) => setState(setDepth(view, parseDepth(event.currentTarget.value, view.depth)))}
        >
          {DEPTHS.map((depth) => (
            <option key={depth} value={String(depth)}>
              {depthLabel(depth)}
            </option>
          ))}
        </select>
        <span class="weave-graph-legend">
          <span class="weave-legend-on">◉ {LEGEND.selected}</span>
          <span class="weave-legend-near">● {LEGEND.neighborhood}</span>
        </span>
      </div>
      <p class="weave-graph-count">{graphCountLabel(model.visible, model.total)}</p>
    </div>
  );
}
