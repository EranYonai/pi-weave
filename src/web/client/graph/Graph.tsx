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
  effectiveView,
  graphClick,
  graphColumnModel,
  graphCountLabel,
  graphPicture,
  graphPreview,
  hoverPicture,
} from "./column.model";
import {
  CONNECTED_HEADING,
  LIT_BECAUSE,
  SHEET_CLOSE,
  SHEET_LABEL,
  SHEET_OPEN,
  SHEET_OPEN_SPLIT,
  SPOTLIGHT_CLEAR,
  SPOTLIGHT_CLEAR_HINT,
  SPOTLIGHT_LABEL,
  SPOTLIGHT_LEGEND,
  SPOTLIGHT_PLACEHOLDER,
  connectedMore,
  graphSheet,
  litLabel,
  litOnCanvas,
  spotlightEscapes,
  spotlightOf,
} from "./spotlight.model";
import type { PositionStorage } from "./positions";
import type { GraphRenderer, RendererFactory } from "./renderer";
import type { TrailGlow } from "./graph.model";
import { schemeOf } from "./scheme";
import type { SchemeHost } from "./scheme";
import type { GraphTheme } from "../../shared/themes";
import { setForces, type ForceConstants } from "../../shared/layout";
import { createGraphSimulation } from "./dynamics";
import type { GraphSimulation } from "./dynamics";
import { Icon } from "../tree/Tree";

export interface GraphProps {
  graph: GraphPayload | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  previewId: string | null;
  onOpen: (id: string) => void;
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
  scheme: GraphTheme | null;
  forces: ForceConstants;
  groupColors: boolean;
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
  /** Recall-trail glows by node id (`trail/trail.model.ts`). Omitted means none. */
  trail?: ReadonlyMap<string, TrailGlow>;
  /**
   * The spotlight query (`spotlight.model.ts`), controlled by the shell so
   * other UI — the search palette's "light up in graph" — can set it.
   * Omitted or `""` means no spotlight.
   */
  query?: string;
  /**
   * Node ids the search palette found for `query`, when it lit the graph up.
   * They light alongside the spotlight's own matches; omitted means none.
   */
  found?: readonly string[];
  /**
   * Where the spotlight field writes. **Its presence is what makes this the
   * full graph view**: with it the column shows the floating spotlight field
   * and the side sheet; without it (the context rail's note graph, a narrow
   * column) it keeps the compact preview card it always had.
   */
  onQuery?: (query: string) => void;
  /** The sheet's "Open in split". Omitted hides the button. */
  onOpenSplit?: (id: string) => void;
  /** The shell's clock, for the sheet's "2h ago". Omitted reads the wall clock. */
  now?: number;
}

const NO_GLOWS: ReadonlyMap<string, TrailGlow> = new Map();

export function Graph(props: GraphProps) {
  const canvas = useRef<HTMLDivElement | null>(null);
  const renderer = useRef<GraphRenderer | null>(null);
  const dynamics = useRef<GraphSimulation | null>(null);
  const clock = useRef<number | null>(null);
  // Whether the camera has been fitted to the first settled layout. The
  // mount frames the *starting* positions, which a settling simulation then
  // pushes past the edges — a two-note vault opened with clipped circles.
  const fitted = useRef(false);
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
      if (!engine.awake()) {
        if (!fitted.current) {
          fitted.current = true;
          renderer.current?.fit();
        }
        return;
      }
      renderer.current?.setPositions(engine.positions());
      clock.current = requestAnimationFrame(step);
    };
    clock.current = requestAnimationFrame(step);
  }, []);
  // `null` means "the user has not touched the expansion" — not "nothing is
  // expanded". `effectiveView` resolves the difference; see its doc comment.
  const [state, setState] = useState<GraphViewState | null>(null);
  const forceKey = useMemo(() => { setForces(props.forces); return JSON.stringify(props.forces); }, [props.forces]);
  const groupColors = props.groupColors;

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
    () => graphColumnModel(props.graph, props.selectedId, view, props.storage, scheme, props.bootFailed, groupColors),
    [props.graph, props.selectedId, view, props.storage, scheme, props.bootFailed, forceKey, groupColors],
  );
  // The full graph view has a spotlight and a side sheet; the context rail's
  // note graph keeps the compact card. See `GraphProps.onQuery`.
  const full = props.onQuery !== undefined;
  const query = full ? props.query ?? "" : "";
  const spot = useMemo(() => spotlightOf(props.graph, query, props.found), [props.graph, query, props.found]);
  // Same identity contract as `model` above: the highlight effect keys on the
  // picture's identity, so each step is memoized on exactly what it reads.
  const lit = useMemo(() => litOnCanvas(spot, model.representative), [spot, model.representative]);
  const picture = useMemo(() => graphPicture(model.highlight, props.selectedId, lit), [model.highlight, props.selectedId, lit]);
  const preview = full ? null : graphPreview(props.graph, props.previewId);
  const now = props.now ?? Date.now();
  const sheet = useMemo(() => (full ? graphSheet(props.graph, props.previewId, spot, now) : null), [full, props.graph, props.previewId, spot, now]);
  const field = useRef<HTMLInputElement | null>(null);

  // Read by the mount-time `onSelect`, which outlives this render.
  const trailRef = useRef<ReadonlyMap<string, TrailGlow>>(NO_GLOWS);
  trailRef.current = props.trail ?? NO_GLOWS;
  const live = useRef({ view, model, picture, onSelect: props.onSelect, selectedId: props.selectedId });
  live.current = { view, model, picture, onSelect: props.onSelect, selectedId: props.selectedId };

  useEffect(() => {
    const instance = props.renderer(scheme);
    instance.onSelect((id) => {
      const next = graphClick(live.current.view, live.current.model.clusters, id);
      setState(next.state);
      live.current.onSelect(next.selectedId);
    });
    // Hover drives the *same* reducers a click does (§7.4): the pointer and
    // the selection ask one question, and `hoverHighlight` answers it with the
    // selection's own picture the moment the pointer leaves.
    //
    // Straight to the renderer, deliberately not through `useState`: hover
    // state would enter the `model` memo below and re-derive the layout,
    // the group colours and the whole `RenderGraph` on every pointer move.
    instance.onHover((id) => {
      const { model: current, picture: shown } = live.current;
      // The *drawn* edges, which are exactly the visible ones the column's own
      // highlight was computed over — a neighbour inside a collapsed cluster
      // has already been retargeted onto the cluster standing in for it.
      // Under a spotlight `hoverPicture` hands the spotlight straight back.
      const next = hoverPicture(current.graph.edges, id, shown);
      instance.setHighlight(next.highlight, next.selectedId, next.style);
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
    const shown = live.current.picture;
    instance.setHighlight(shown.highlight, shown.selectedId, shown.style);
    instance.setTrail(trailRef.current);
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
  }, [model.key, forceKey, groupColors]);

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
  }, [model.key, armClock, forceKey]);

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
    renderer.current?.setHighlight(picture.highlight, picture.selectedId, picture.style);
  }, [picture]);

  useEffect(() => {
    renderer.current?.setTrail(trailRef.current);
  }, [props.trail]);

  // `Esc` clears the spotlight before the shell's document listener sees it —
  // or, when `spotlightEscapes` says no, passes through to "clear selection".
  const escape = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || !spotlightEscapes(query, event.target === field.current, sheet !== null)) return;
    event.preventDefault();
    props.onQuery?.("");
  };
  const more = sheet === null ? null : connectedMore(sheet.connected.length, sheet.connectedTotal);

  return (
    <div class="weave-graph" onKeyDown={escape}>
      {/* Same shape as `ContextRail`'s: the *decision* is `graphEmptyMessage`,
          and what is left here is whether to render the paragraph it returned. */}
      {model.empty === null ? null : <p class="weave-graph-empty">{model.empty}</p>}
      {/* `tabIndex={-1}` is the `⌘3` focus target — see `Note.tsx`'s matching
          comment. The tree's target is the rows `<ul>`, which has its own. */}
      <div class="weave-graph-canvas" ref={canvas} role="img" aria-label="Knowledge graph" tabIndex={-1} />
      {!full ? null : (
        <div class={`weave-spotlight${spot === null ? "" : " weave-spotlight-on"}`} role="search">
          <svg class="weave-spotlight-icon" viewBox="0 0 20 20" width={14} height={14} fill="none" stroke="currentColor" stroke-width={1.8} aria-hidden="true">
            <circle cx="8.5" cy="8.5" r="5.5" />
            <path d="m13 13 4 4" />
          </svg>
          <input ref={field} class="weave-spotlight-input" type="search" value={query} placeholder={SPOTLIGHT_PLACEHOLDER}
            aria-label={SPOTLIGHT_LABEL} spellcheck={false} autoComplete="off" onInput={(event) => props.onQuery?.(event.currentTarget.value)} />
          {spot === null ? null : (
            <>
              <span class={`weave-spotlight-count${spot.count === 0 ? " weave-spotlight-none" : ""}`} role="status">{litLabel(spot.count)}</span>
              <button type="button" class="weave-spotlight-clear" title={SPOTLIGHT_CLEAR_HINT} aria-label={SPOTLIGHT_CLEAR_HINT}
                onClick={() => { props.onQuery?.(""); field.current?.focus(); }}>{SPOTLIGHT_CLEAR}</button>
            </>
          )}
        </div>
      )}
      {sheet === null ? null : (
        <aside class="weave-sheet" aria-label={SHEET_LABEL}>
          <button type="button" class="weave-sheet-close" aria-label={SHEET_CLOSE} title={SHEET_CLOSE} onClick={() => props.onSelect(null)}>×</button>
          <p class="weave-sheet-crumb">
            <Icon name={sheet.crumb === "" ? sheet.icon : "module"} class="weave-icon" />
            <span>{sheet.crumb === "" ? sheet.kind : sheet.crumb}</span>
          </p>
          <h2 class="weave-sheet-title">{sheet.title}</h2>
          <p class="weave-sheet-meta">
            {sheet.who === null ? null : <span class={`weave-prov weave-prov-${sheet.who.provenance}`} title={sheet.who.title} aria-hidden="true">{sheet.who.glyph}</span>}
            <span>{sheet.who === null ? sheet.kind : sheet.who.word}</span>
            {sheet.when === "" ? null : <span class="weave-sheet-when">· {sheet.when}</span>}
          </p>
          {sheet.text === null ? null : (
            <div class="weave-sheet-text">
              <span class="weave-sheet-text-head">{sheet.text.heading}</span>
              {sheet.text.parts.map((part) => (part.hit ? <mark class="weave-sheet-mark">{part.text}</mark> : part.text))}
            </div>
          )}
          {sheet.litBecause === null ? null : (
            <p class="weave-sheet-why"><span aria-hidden="true">✳</span>{LIT_BECAUSE} {sheet.litBecause}</p>
          )}
          {sheet.connectedTotal === 0 ? null : (
            <section class="weave-sheet-section" aria-label={CONNECTED_HEADING}>
              <h3 class="weave-sheet-heading">{CONNECTED_HEADING}<span class="weave-sheet-count">{sheet.connectedTotal}</span></h3>
              <ul class="weave-sheet-rows">
                {sheet.connected.map((row) => (
                  <li key={row.id}>
                    <button type="button" class="weave-sheet-row" title={row.label} aria-label={row.ariaLabel} onClick={() => props.onSelect(row.id)}>
                      <span class={`weave-sheet-dot${row.lit ? " weave-sheet-dot-lit" : ""}`} aria-hidden="true" />
                      <span class="weave-sheet-row-label">{row.label}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {more === null ? null : <p class="weave-sheet-more">{more}</p>}
            </section>
          )}
          <div class="weave-sheet-actions">
            <button type="button" class="weave-sheet-open" onClick={() => props.onOpen(sheet.id)}>{SHEET_OPEN}</button>
            {props.onOpenSplit === undefined ? null : (
              <button type="button" class="weave-sheet-split" onClick={() => props.onOpenSplit?.(sheet.id)}>{SHEET_OPEN_SPLIT}</button>
            )}
          </div>
        </aside>
      )}
      {preview === null ? null : (
        <aside class="weave-graph-preview" aria-label="Selected graph node">
          <div class="weave-graph-preview-info">
            <span class="weave-kind" aria-hidden="true"><Icon name={preview.icon} class="weave-icon" /></span>
            <div class="weave-graph-preview-copy">
              <span class="weave-graph-preview-kind">{preview.kind}</span>
              <strong class="weave-graph-preview-title" title={preview.title}>{preview.title}</strong>
            </div>
          </div>
          <button type="button" class="weave-graph-preview-close" aria-label="Clear graph selection" onClick={() => props.onSelect(null)}>×</button>
          <button type="button" class="weave-chip" onClick={() => props.onOpen(preview.id)}>Open in new tab</button>
        </aside>
      )}
      <div class="weave-graph-controls">
        <button type="button" class="weave-chip" title={FIT_HINT} onClick={() => renderer.current?.fit()}>
          {FIT_LABEL}
        </button>
        <span class="weave-graph-legend">
          <span class="weave-legend-on">◉ {LEGEND.selected}</span>
          {spot === null
            ? <span class="weave-legend-near">● {LEGEND.neighborhood}</span>
            : <span class="weave-legend-lit">● {SPOTLIGHT_LEGEND.lit}</span>}
          <span class="weave-legend-dim">· {spot === null ? LEGEND.dimmed : SPOTLIGHT_LEGEND.dimmed}</span>
        </span>
      </div>
      <p class="weave-graph-count">{graphCountLabel(model.visible, model.total)}</p>
    </div>
  );
}
