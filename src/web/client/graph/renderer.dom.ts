/** Browser-only Sigma adapter; the lifecycle remains testable in renderer.ts. */
import Sigma from "sigma";
import type { ColorScheme } from "./graph.model";
import type { GraphRenderer, RendererFactory, SigmaLike } from "./renderer";
import { sigmaRenderer } from "./renderer";

/** Sigma's own container parameter type, recovered without naming the DOM. */
type SigmaContainer = ConstructorParameters<typeof Sigma>[1];

/** The browser's renderer factory. Passed to the graph column by the shell. */
export const createSigmaRenderer: RendererFactory = (scheme: ColorScheme): GraphRenderer =>
  sigmaRenderer(
    (graph, container, settings) =>
      new Sigma(graph, container as unknown as SigmaContainer, settings) as unknown as SigmaLike,
    scheme,
  );
