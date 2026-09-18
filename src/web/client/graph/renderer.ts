import type { Point } from "../../shared/layout";
import type { ColorScheme, EdgeDisplayOverride, GraphSettings, NodeDisplayOverride, RenderEdge, RenderGraph, RenderNode, ViewBox } from "./graph.model";
import { edgeReducer, frameBox, graphSettings, nodeReducer } from "./graph.model";
import type { ProjectedGraph } from "./project";
import { positionsOf, project, syncPositions } from "./project";

/**
 * The container, as far as this seam is concerned.
 *
 * Sigma wants an `HTMLElement`, and this file may not say so — a test
 * importing it drags the module into the **root** `tsconfig.json` project
 * (`exclude` filters the initial glob, not what an included file imports), and
 * that project has no `DOM` lib. The structural stand-in keeps this module DOM-free; the one cast lives in
 * `renderer.dom.ts`, which is compiled only by `tsconfig.web.json`.
 */
export interface RenderContainer {
  readonly clientWidth: number;
  readonly clientHeight: number;
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
 * The slice of `Sigma` this renderer drives.
 *
 * Structural, so the real class satisfies it without a cast and a fake is an
 * object literal — the same reasoning the injected renderer port records.
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
  setSetting(key: "edgeReducer", value: (key: string, data: RenderEdge, scheme: ColorScheme) => EdgeDisplayOverride): unknown;
  setSetting(key: "enableCameraPanning", value: boolean): unknown;
  setGraph(graph: ProjectedGraph): unknown;
  /**
   * Freeze the graph→viewport normalization onto a fixed box.
   *
   * Sigma's own `autoRescale` would recompute that mapping from the moving
   * extent on every repaint — which a drag does every frame — so crossing the
   * view's edge rescaled the whole graph under the cursor. `graph.model.ts`'s
   * {@link frameBox} records the why in full.
   */
  setCustomBBox(box: ViewBox | null): unknown;
  refresh(): unknown;
  getCamera(): { animatedReset(): Promise<void> };
  kill(): void;
}

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
export function sigmaRenderer(
  create: (graph: ProjectedGraph, container: RenderContainer, settings: GraphSettings) => SigmaLike,
  scheme: ColorScheme,
) {
  let sigma: SigmaLike | null = null;
  let graph: ProjectedGraph = project({ nodes: [], edges: [] });
  let highlight: ReadonlySet<string> | null = null;
  /** The selection inside that neighbourhood — see `nodeReducer`. */
  let selected: string | null = null;
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

  /** The box to freeze the view on, from the graph's *current* positions. */
  const boxOf = (): ViewBox | null => frameBox([...positionsOf(graph).values()]);

  /**
   * Push the current highlight into sigma's reducers (§7.4).
   *
   * Re-installed on every change rather than reading `highlight` through a
   * closure, because `setSetting` is what tells sigma to schedule a render —
   * mutating a captured variable would change the answer and repaint nothing
   * until the next unrelated frame.
   */
  const applyReducers = (instance: SigmaLike): void => {
    const nodes = nodeReducer(highlight, selected);
    const edges = edgeReducer(highlight, selected);
    instance.setSetting("nodeReducer", (id, data) => ({ ...data, ...nodes(id, data, scheme) }));
    instance.setSetting("edgeReducer", (key, data) => ({ ...data, ...edges(key, data, scheme) }));
  };

  return {
    mount(container: RenderContainer) {
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
      // Freeze the view box for whatever graph arrived before mount, so the
      // first frame is already framed and stable — see `SigmaLike.setCustomBBox`.
      instance.setCustomBBox(boxOf());
      sigma = instance;
    },

    setGraph(next: RenderGraph) {
      graph = project(next);
      sigma?.setGraph(graph);
      // Re-frame on a shape change: new nodes legitimately change the extent,
      // and the box is what keeps the *drag* frames from also changing it.
      // Deliberately not touched by `setPositions` — a settling simulation
      // must not move the view under the user.
      sigma?.setCustomBBox(boxOf());
    },

    setPositions(positions: ReadonlyMap<string, Point>) {
      syncPositions(graph, positions);
      // `refresh` re-reads the node attributes just written; `setGraph` would
      // rebuild every WebGL buffer and reset the camera.
      sigma?.refresh();
    },

    setHighlight(next: ReadonlySet<string> | null, selectedId: string | null = null) {
      highlight = next;
      selected = selectedId;
      if (sigma !== null) applyReducers(sigma);
    },

    onSelect(handler: (id: string | null) => void) {
      select = handler;
    },

    onDragStart(handler: (id: string) => void) {
      dragStart = handler;
    },

    onDragMove(handler: (id: string, at: Point) => void) {
      dragMove = handler;
    },

    onDragEnd(handler: (id: string) => void) {
      dragEnd = handler;
    },

    fit() {
      // Re-frame onto the **current** positions — a graph the user has pulled
      // apart wants its dragged nodes inside the view — then reset the camera
      // onto that box. `animatedReset` settles when the animation ends. Nothing
      // awaits a camera move, and a rejection from a camera killed mid-flight
      // is noise.
      sigma?.setCustomBBox(boxOf());
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

export type GraphRenderer = ReturnType<typeof sigmaRenderer>;
