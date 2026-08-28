/**
 * The renderer seam (weave-workspace §7.5).
 *
 * > `src/web/client/graph/renderer.ts` exposes a narrow interface — `mount`,
 * > `setGraph(nodes, edges, positions)`, `setHighlight(Set<id>)`, `onSelect`,
 * > `fit`, `destroy` — with `SigmaRenderer` as the only implementation. If
 * > sigma ever stops being the right answer, one file changes.
 *
 * That is handoff design goal #5 (decouple simulation / rendering /
 * interaction) satisfied *structurally* rather than by discipline. The column
 * above holds a {@link GraphRenderer} and never a `Sigma`; §8 keeps layout
 * correctness independent of the renderer entirely.
 *
 * ## Why `new Sigma(...)` is a parameter
 *
 * §10 forbids a DOM test environment, and sigma needs a canvas and a WebGL
 * context — so the naive shape of this file (interface, then a
 * `createSigmaRenderer` that calls `new Sigma`) is a file that reports **0 %
 * coverage as a whole**, because it cannot even be imported. Verified rather
 * than assumed: `import Sigma from "sigma"` evaluates
 * `WebGL2RenderingContext.BOOL` at module scope while building its default
 * program table, so the import alone is a `ReferenceError` in Node, before a
 * line of ours runs.
 *
 * That is a worse outcome than it looks. This repository's rule (§10, and
 * `docs/testing.md` §L5.2) is that *untestable lines* are kept to a handful,
 * not that untestable *files* are excluded — the one coverage exclusion that
 * exists is a type-only module, and a blanket `src/web/client/**` exclude is
 * explicitly "not acceptable". A whole renderer sitting outside the gate would
 * be exactly the erosion that rule prevents.
 *
 * So the dependency is inverted. {@link SigmaLike} and {@link SigmaFactory}
 * are the two-and-a-half-method port sigma satisfies structurally;
 * {@link sigmaRenderer} is the entire renderer written against the port, and
 * it is covered by ordinary unit tests with a recording fake. The only thing
 * that genuinely cannot be tested is the four-line adapter in
 * `renderer.dom.ts` that says `new Sigma(graph, container, settings)` — the
 * same shape, and the same reasoning, as `api.dom.ts` for `fetch` and
 * `domEventSource` for `EventSource`.
 *
 * §7.5's promise is unaffected. "One file changes" is still true, and it is
 * now true of a file with no branches in it.
 *
 * ## Tier rules (§2)
 *
 * `src/web/client/**`. This file imports no npm package at all, which is what
 * lets the root `tsconfig.json` project (no `DOM` lib) compile the tests that
 * import it.
 */

import type { Point } from "../../shared/layout";
import type { ColorScheme, EdgeDisplayOverride, GraphSettings, NodeDisplayOverride, RenderEdge, RenderGraph, RenderNode } from "./graph.model";
import { edgeReducer, graphSettings, nodeReducer } from "./graph.model";
import type { ProjectedGraph } from "./project";
import { positionsOf, project, syncPositions } from "./project";

// --- the seam -------------------------------------------------------------------

/**
 * The narrow interface §7.5 specifies.
 *
 * `setGraph` takes a {@link RenderGraph} rather than §7.5's literal
 * `(nodes, edges, positions)` triple, and that is the one deviation worth
 * naming. The triple would make every implementation re-derive colours, sizes
 * and labels from raw wire nodes — i.e. it would put the decisions §7.5 wants
 * decoupled *behind* the seam. Passing the already-decided model keeps the
 * argument list to one and the second implementation, if there ever is one,
 * honest.
 */
export interface GraphRenderer {
  /** Attach to a container. Idempotent: mounting twice is a no-op. */
  mount(container: RenderContainer): void;
  /** Replace the drawn graph. Safe before {@link mount}. */
  setGraph(graph: RenderGraph): void;
  /**
   * Move nodes without rebuilding.
   *
   * Separate from {@link setGraph} because a re-run of the simulation over an
   * unchanged node set is the common case (drag, expand, resize) and
   * rebuilding would drop the camera and every WebGL buffer.
   */
  setPositions(positions: ReadonlyMap<string, Point>): void;
  /**
   * Dim everything outside this set (§7.4). `null` clears the highlight.
   *
   * `null` is not the empty set: nothing selected means everything renders
   * normally, an empty neighbourhood means everything dims. See
   * `graph.model.ts`'s `nodeReducer`.
   */
  setHighlight(highlight: ReadonlySet<string> | null): void;
  /** Called with a node id on click, and with `null` on a click off any node. */
  onSelect(handler: (id: string | null) => void): void;
  /** Frame the whole graph. The `[fit]` control. */
  fit(): void;
  /** Current positions, for warm-starting a re-run. */
  positions(): Map<string, Point>;
  /** Called when the user starts dragging a node. */
  onDragStart(handler: (id: string) => void): void;
  /** Called with graph-space coordinates while a node is dragged. */
  onDragMove(handler: (id: string, at: Point) => void): void;
  /** Called when a node drag ends. */
  onDragEnd(handler: (id: string) => void): void;
  /** Tear down. Idempotent, and must leave no listener behind. */
  destroy(): void;
}

/**
 * The container, as far as this seam is concerned.
 *
 * Sigma wants an `HTMLElement`, and this file may not say so — a test
 * importing it drags the module into the **root** `tsconfig.json` project
 * (`exclude` filters the initial glob, not what an included file imports), and
 * that project has no `DOM` lib. The structural stand-in is the same trick
 * `cssvars.ts`, `api.ts` and `live.ts` use; the one cast lives in
 * `renderer.dom.ts`, which is compiled only by `tsconfig.web.json`.
 */
export interface RenderContainer {
  readonly clientWidth: number;
  readonly clientHeight: number;
}

/**
 * A renderer that draws nothing.
 *
 * Not a test double — a production path. The graph column renders before its
 * container exists (the first pass), may never mount at all (the `medium`
 * breakpoint collapses the column), and must keep working when it does not. A
 * null object removes the `renderer === null` check from every call site,
 * which is the check that is always missing from exactly one of them.
 */
export function nullRenderer(): GraphRenderer {
  return {
    mount() {},
    setGraph() {},
    setPositions() {},
    setHighlight() {},
    onSelect() {},
    fit() {},
    onDragStart() {},
    onDragMove() {},
    onDragEnd() {},
    positions() {
      return new Map();
    },
    destroy() {},
  };
}

/**
 * How a {@link GraphRenderer} is obtained.
 *
 * Injected at the column rather than imported by it, so the graph column is
 * driven by a recording fake in a test and by `createSigmaRenderer` in the
 * browser — the same port-shaped injection `api.ts` uses for `fetch`.
 */
export type RendererFactory = (scheme: ColorScheme) => GraphRenderer;

// --- the sigma port -----------------------------------------------------------------

/**
 * The camera, as far as this module uses it.
 *
 * One method. `animatedReset` is what `[fit]` is (§7.4: "Pan / zoom / fit →
 * `camera.animatedReset()`").
 */
export interface CameraLike {
  animatedReset(): Promise<void>;
}

/**
 * The slice of `Sigma` this renderer drives.
 *
 * Structural, so the real class satisfies it without a cast and a fake is an
 * object literal — the same reasoning `EventSourceLike` in `live.ts` records.
 * Six methods, and every one of them is called below, so the port cannot grow
 * a member nothing uses.
 *
 * The reducer signatures are deliberately stated over `RenderNode` /
 * `RenderEdge` rather than sigma's `Partial<NodeDisplayData>`: those are the
 * attributes `project.ts` actually writes, and naming sigma's types here would
 * mean importing sigma.
 */
export interface SigmaLike {
  on(event: "clickNode", handler: (payload: { node: string }) => void): unknown;
  on(event: "clickStage", handler: () => void): unknown;
  on(event: "downNode", handler: (payload: { node: string }) => void): unknown;
  on(event: "moveBody", handler: (payload: { event: { x: number; y: number }; preventSigmaDefault(): void }) => void): unknown;
  on(event: "upNode" | "upStage", handler: () => void): unknown;
  viewportToGraph(position: { x: number; y: number }): Point;
  setSetting(key: "nodeReducer", value: (id: string, data: RenderNode) => NodeDisplayOverride): unknown;
  setSetting(key: "edgeReducer", value: (key: string, data: RenderEdge) => EdgeDisplayOverride): unknown;
  setSetting(key: "enableCameraPanning", value: boolean): unknown;
  setGraph(graph: ProjectedGraph): unknown;
  refresh(): unknown;
  getCamera(): CameraLike;
  kill(): void;
}

/**
 * `new Sigma(graph, container, settings)`, as a port.
 *
 * The one line that cannot be tested, isolated behind a function type so that
 * everything *around* it can be. `renderer.dom.ts` is the four-line adapter
 * that supplies the real constructor.
 */
export type SigmaFactory = (graph: ProjectedGraph, container: RenderContainer, settings: GraphSettings) => SigmaLike;

// --- the implementation --------------------------------------------------------------

/**
 * The renderer §7.5 calls `SigmaRenderer`, over an injected constructor.
 *
 * Holds no decisions. Colours, sizes, labels, z-order, settings and the dim
 * rules are `graph.model.ts`; the graphology instance is `project.ts`; which
 * nodes are highlighted is core's `focusNeighborhood`. What is left is
 * lifecycle: build lazily, delegate, tear down once.
 *
 * The scheme is fixed at construction rather than settable. A
 * `prefers-color-scheme` flip mid-session is rare enough that rebuilding the
 * renderer is the honest response, where a `setScheme` would mean re-deriving
 * every node colour and re-projecting — a second code path for a case nobody
 * hits.
 */
export function sigmaRenderer(create: SigmaFactory, scheme: ColorScheme): GraphRenderer {
  let sigma: SigmaLike | null = null;
  let graph: ProjectedGraph = project({ nodes: [], edges: [] });
  let highlight: ReadonlySet<string> | null = null;
  let select: (id: string | null) => void = () => {};
  let dragStart: (id: string) => void = () => {};
  let dragMove: (id: string, at: Point) => void = () => {};
  let dragEnd: (id: string) => void = () => {};
  let dragging: string | null = null;

  const endDrag = (id: string | null): void => {
    if (dragging === null) return;
    const current = dragging;
    dragging = null;
    // A node drag is a pin, not a pan: sigma's captor would otherwise move the
    // camera on the same gesture that is moving the node, and the node would
    // slide away from the cursor. Re-enable panning only when the drag ends.
    sigma?.setSetting("enableCameraPanning", true);
    if (id === null || id === current) dragEnd(current);
  };

  /**
   * Push the current highlight into sigma's reducers (§7.4).
   *
   * Re-installed on every change rather than reading `highlight` through a
   * closure, because `setSetting` is what tells sigma to schedule a render —
   * mutating a captured variable would change the answer and repaint nothing
   * until the next unrelated frame.
   */
  const applyReducers = (instance: SigmaLike): void => {
    const nodes = nodeReducer(highlight);
    const edges = edgeReducer(highlight);
    instance.setSetting("nodeReducer", (id, data) => ({ ...data, ...nodes(id, data, scheme) }));
    instance.setSetting("edgeReducer", (key, data) => ({ ...data, ...edges(key, data) }));
  };

  return {
    mount(container) {
      if (sigma !== null) return;
      const instance = create(graph, container, graphSettings(scheme));
      // §1.3's context bus: a click writes `selectedId`, and the note column,
      // the tree and the context rail all recompute from it.
      instance.on("clickNode", ({ node }) => select(node));
      instance.on("clickStage", () => select(null));
      instance.on("downNode", ({ node }) => {
        dragging = node;
        // Hold the view still while the node follows the cursor (see endDrag).
        sigma?.setSetting("enableCameraPanning", false);
        dragStart(node);
      });
      instance.on("moveBody", (payload) => {
        if (dragging !== null) {
          // Sigma's captor pans the camera on every mouse move while the
          // button is down; during a node drag that is the pan the gesture
          // must not be. `preventSigmaDefault` is the captor's own gate — it
          // is consulted right after this handler returns — and without it
          // the camera follows the cursor 1:1 while the pin follows it too,
          // so the node appears to slide away under the view.
          payload.preventSigmaDefault();
          dragMove(dragging, instance.viewportToGraph({ x: payload.event.x, y: payload.event.y }));
        }
      });
      instance.on("upNode", () => endDrag(dragging));
      instance.on("upStage", () => endDrag(null));
      applyReducers(instance);
      sigma = instance;
    },

    setGraph(next) {
      graph = project(next);
      sigma?.setGraph(graph);
    },

    setPositions(positions) {
      syncPositions(graph, positions);
      // `refresh` re-reads the node attributes just written; `setGraph` would
      // rebuild every WebGL buffer and reset the camera.
      sigma?.refresh();
    },

    setHighlight(next) {
      highlight = next;
      if (sigma !== null) applyReducers(sigma);
    },

    onSelect(handler) {
      select = handler;
    },

    onDragStart(handler) {
      dragStart = handler;
    },

    onDragMove(handler) {
      dragMove = handler;
    },

    onDragEnd(handler) {
      dragEnd = handler;
    },

    fit() {
      // `animatedReset` settles when the animation ends. Nothing awaits a
      // camera move, and a rejection from a camera killed mid-flight is noise.
      void sigma?.getCamera().animatedReset();
    },

    positions() {
      return positionsOf(graph);
    },
    destroy() {
      sigma?.kill();
      sigma = null;
    },
  };
}
