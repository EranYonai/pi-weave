/**
 * Client entry point (weave-workspace §2, §9).
 *
 * Reads the bootstrap block the HTML shell embedded, then mounts
 * {@link Shell}. Everything else — layout, liveness, fetching — is reached
 * from there.
 *
 * The three DOM reads that cannot be injected any further up (`getElementById`,
 * `innerWidth`, `navigator.platform`) happen here and are passed down as
 * props, so `Shell` and everything below it takes its world as parameters.
 */

import { render } from "preact";
import { BOOTSTRAP_ELEMENT_ID } from "../shared/wire";
import { readBootstrap } from "./bootstrap";
import { Shell } from "./shell/Shell";
import { installTheme } from "./shell/theme";

const host = document.getElementById("app");
if (host !== null) {
  // Before the first render: the sheet carries the grid and the palette, and
  // installing it after would show one unstyled frame. It copies the
  // per-response CSP nonce off the server's own `<style>` — see `theme.ts`.
  installTheme(document);
  const boot = readBootstrap(document.getElementById(BOOTSTRAP_ELEMENT_ID)?.textContent ?? null);
  render(<Shell cwd={boot.cwd} initialWidth={window.innerWidth} platform={navigator.platform} />, host);
}
