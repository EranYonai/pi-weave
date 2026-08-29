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

import { useEffect, useRef, useState, useCallback, useMemo } from "preact/hooks";
import type { GraphPayload } from "../../shared/wire";
import type { GraphViewState } from "./column.model";
import {
  FIT_HINT,
  FIT_LABEL,
  LEGEND,
  allExpanded,
  effectiveView,
  expandHint,
  expandLabel,
  graphClick,
  graphColumnModel,
  graphCountLabel,
  toggleExpandAll,
} from "./column.model";
import type { PositionStorage } from "./positions";
import type { GraphRenderer, RendererFactory } from "./renderer";
import { schemeOf } from "./scheme";
import type { SchemeHost } from "./scheme";
import type { ColorScheme } from "./graph.model";
import { createGraphSimulation } from "./dynamics";
import type { GraphSimulation } from "./dynamics";

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
   * The effective scheme, resolved by the shell from the user's theme choice
   * (`shell/theme.model.ts`), or `null`/omitted to read the OS via
   * {@link schemeOf}. A change remounts the renderer — the one response to a
   * palette change `renderer.ts` calls honest — because a WebGL palette is
   * fixed at construction.
   */
  scheme: ColorScheme | null;
  /**
   * Whether the boot graph fetch failed (`state.ts`'s `graphFailed`). The
   * empty column's sentence switches from "Loading…" to a named recovery:
   * a canvas that never arrives needs a first sentence that says why.
   */
  bootFailed?: boolean;
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
  const dynamics = useRef<GraphSimulation | null>(null);
  const clock = useRef<number | null>(null);
  /**
   * Arm the simulation clock — idempotent.
   *
   * The layout is always live; the clock still sleeps whenever the engine's
   * alpha reaches its floor (a graph that is holding still costs zero frames)
   * and re-arms when a drag pins a node or a re-layout hands over a new
   * engine.
   */
  const armClock = useCallback(() => {
    if (clock.current !== null) return;
    const step = () => {
      clock.current = null;
      const engine = dynamics.current;
      if (engine === null) return;
      engine.tick();
      // Asleep: let the clock die. The next pin re-arms it.
      if (!engine.awake()) return;
      renderer.current?.setPositions(engine.positions());
      clock.current = requestAnimationFrame(step);
    };
    clock.current = requestAnimationFrame(step);
  }, []);
  // `null` means "the user has not touched the expansion" — not "nothing is
  // expanded". `effectiveView` resolves the difference; see its doc comment.
  const [state, setState] = useState<GraphViewState | null>(null);

  // The shell's decision wins; `schemeOf` stays for a host-driven default.
  const scheme = props.scheme ?? schemeOf(props.host);
  const view = effectiveView(props.graph, state);
  // Memoized for two reasons, one cheap and one load-bearing. Cheap: the
  // shell re-renders on every editor keystroke and every divider pixel, and
  // an un-memoized run re-reads `localStorage` and re-parses the position
  // map for a model nothing uses. Load-bearing: the effects below key on
  // `model.highlight`'s *identity* — an un-memoized model hands them a fresh
  // `Set` every render, so typing in the note would repaint the whole WebGL
  // graph. Identity is the whole contract; do not switch the effect to
  // comparing set contents, the memo makes comparison unnecessary.
  const model = useMemo(
    () => graphColumnModel(props.graph, props.selectedId, view, props.storage, scheme, props.bootFailed),
    [props.graph, props.selectedId, view, props.storage, scheme, props.bootFailed],
  );
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
    instance.onDragStart((id) => {
      const at = renderer.current?.positions().get(id);
      if (at) {
        dynamics.current?.pin(id, at);
        // The pin re-heats the engine; if the clock was asleep, wake it.
        armClock();
      }
    });
    instance.onDragMove((id, at) => {
      dynamics.current?.pin(id, at);
    });
    instance.onDragEnd((id) => {
      dynamics.current?.release(id);
    });
    instance.mount(canvas.current ?? { clientWidth: 0, clientHeight: 0 });
    renderer.current = instance;
    // A remount from a scheme flip re-runs *this* effect while the effects
    // below stay keyed on `model.key` / `model.highlight` — which have not
    // changed, because the theme switch did not touch the graph's shape. The
    // fresh canvas would therefore sit empty until the next expand, collapse
    // or selection moved those keys. Push from `live` (current render, not
    // the render this effect was created in), so a remount carries whatever
    // the column is already showing.
    instance.setGraph(live.current.model.graph);
    instance.setHighlight(live.current.model.highlight);
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

  // Live layout, in two effects so pause/resume and re-layout are independent.
  //
  // Effect 1 (keyed on `model.key`) owns the *simulation*: it is created once
  // per graph shape, warm-started from the renderer's current positions so a
  // drag or an expand does not make the graph jump, and disposed when the shape
  // changes. A fresh engine starts at settle alpha — the "alive" answer to an
  // expand — so the clock must arm here if it had gone to sleep.
  useEffect(() => {
    const engine = createGraphSimulation(model.graph, renderer.current?.positions());
    dynamics.current = engine;
    if (engine !== null) armClock();
    return () => {
      dynamics.current = null;
    };
  }, [model.key, armClock]);

  // Effect 2 owns the clock's unmount cleanup: the engine's own lifecycle is
  // effect 1's, and the step self-terminates whenever the engine settles, so
  // the only teardown left here is a frame that could outlive the component.
  useEffect(
    () => () => {
      if (clock.current !== null) {
        cancelAnimationFrame(clock.current);
        clock.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    renderer.current?.setHighlight(model.highlight);
  }, [model.highlight]);

  return (
    <div class="weave-graph">
      {/* Same shape as `ContextRail`'s: the *decision* is `graphEmptyMessage`,
          and what is left here is whether to render the paragraph it returned. */}
      {model.empty === null ? null : <p class="weave-graph-empty">{model.empty}</p>}
      {/* `tabIndex={-1}` is the `⌘3` focus target — see `Note.tsx`'s matching
          comment. The tree's target is the rows `<ul>`, which has its own. */}
      <div class="weave-graph-canvas" ref={canvas} role="img" aria-label="Knowledge graph" tabIndex={-1} />
      <div class="weave-graph-controls">
        <button type="button" class="weave-chip" title={FIT_HINT} onClick={() => renderer.current?.fit()}>
          {FIT_LABEL}
        </button>
        <button type="button" class="weave-chip" title={expandHint(everything)} onClick={() => setState(toggleExpandAll(view, model.clusters))}>
          {expandLabel(everything)}
        </button>
        <span class="weave-graph-legend">
          <span class="weave-legend-on">◉ {LEGEND.selected}</span>
          <span class="weave-legend-near">● {LEGEND.neighborhood}</span>
          <span class="weave-legend-dim">· {LEGEND.dimmed}</span>
        </span>
      </div>
      <p class="weave-graph-count">{graphCountLabel(model.visible, model.total)}</p>
    </div>
  );
}
