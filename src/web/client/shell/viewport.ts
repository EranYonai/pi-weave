/**
 * Watching the viewport width (weave-workspace §1.2).
 *
 * The width is not a cosmetic detail here: it picks the breakpoint, which
 * decides how many columns render, which decides how many dividers exist. So
 * the subscription is worth a test, and a subscription written inline in a
 * `useEffect` is one no test can reach (§10). Four lines, an injected port,
 * and the shell keeps a one-line effect.
 */

/** The slice of `window` this module reads. `window` satisfies it. */
export interface ViewportHost {
  readonly innerWidth: number;
  addEventListener(type: "resize", listener: () => void): void;
  removeEventListener(type: "resize", listener: () => void): void;
}

/**
 * Call `onChange` with the width whenever the window resizes.
 *
 * Returns an unsubscribe. The listener is *not* invoked eagerly: the shell
 * already seeds its state from `initialWidth` at mount, and firing here would
 * make the first render set state during an effect for no change in value.
 */
export function watchViewport(host: ViewportHost, onChange: (width: number) => void): () => void {
  const listener = (): void => onChange(host.innerWidth);
  host.addEventListener("resize", listener);
  return () => host.removeEventListener("resize", listener);
}
