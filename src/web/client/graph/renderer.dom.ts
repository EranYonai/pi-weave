/**
 * The real `new Sigma(...)`, adapted to the renderer's injected port
 * (weave-workspace §7.5, §10).
 *
 * `renderer.ts` deliberately does not import sigma: it is a `.ts` compiled by
 * the **root** `tsconfig.json` whenever a test imports it, and `import Sigma
 * from "sigma"` is a `ReferenceError` there — sigma evaluates
 * `WebGL2RenderingContext.BOOL` at module scope while building its default
 * program table, so the import alone dies outside a browser.
 *
 * Something still has to call the real thing. That is this file, and it is
 * separate so the untestable surface is *one constructor call* rather than the
 * whole renderer: `sigmaRenderer` holds the lifecycle, the reducers and the
 * delegation, and is unit-tested against `SigmaLike` with a recording fake.
 * Identical shape and identical reasoning to `api.dom.ts` for `fetch` and
 * `domEventSource` in `live.ts` for `EventSource`.
 *
 * This module is only reachable from a `.tsx` entry point, so it is compiled
 * exclusively by `tsconfig.web.json` (which has `DOM`) and never pulled into
 * the root project. That is what lets it name sigma at all.
 *
 * ## This is §7.5's swap point
 *
 * If sigma stops being the right answer — §0.2's "revisit only if we
 * measurably exceed sigma's comfort zone (tens of thousands of nodes)" —
 * this file and the {@link SigmaLike} port in `renderer.ts` are what change.
 * Nothing above the seam mentions sigma at all.
 */

import Sigma from "sigma";
import type { ColorScheme } from "./graph.model";
import type { GraphRenderer, RendererFactory, SigmaFactory, SigmaLike } from "./renderer";
import { sigmaRenderer } from "./renderer";

/** Sigma's own container parameter type, recovered without naming the DOM. */
type SigmaContainer = ConstructorParameters<typeof Sigma>[1];

/**
 * `new Sigma(graph, container, settings)`, as a {@link SigmaFactory}.
 *
 * The real `Sigma` satisfies `SigmaLike` structurally — `on`, `setSetting`,
 * `setGraph`, `refresh`, `getCamera` and `kill` are all present with
 * compatible shapes — so the only work here is the container cast, which is
 * checked against sigma's own declared parameter type rather than against an
 * `HTMLElement` asserted from memory.
 */
const createSigma: SigmaFactory = (graph, container, settings) =>
  new Sigma(graph, container as unknown as SigmaContainer, settings) as unknown as SigmaLike;

/** The browser's renderer factory. Passed to the graph column by the shell. */
export const createSigmaRenderer: RendererFactory = (scheme: ColorScheme): GraphRenderer =>
  sigmaRenderer(createSigma, scheme);
