/**
 * Reading the page's bootstrap block (weave-workspace §5.3).
 *
 * `page.ts` embeds `{cwd, vaultRoot, session}` as a nonce'd
 * `<script type="application/json">` so the first paint knows where it is
 * without a round trip. This decodes it.
 *
 * A `.ts` taking the raw text rather than an element, so the parsing and its
 * failure modes are covered by ordinary tests while `main.tsx` keeps only the
 * `getElementById` that cannot be tested without a DOM.
 *
 * ## Why a missing block is not fatal
 *
 * The bootstrap is a *convenience* — every value in it is cosmetic at P1
 * (`cwd` is a status-bar label) and the API routes work without it. So a
 * block that is absent, empty or malformed yields {@link EMPTY_BOOTSTRAP}
 * rather than throwing. Throwing here would turn a cosmetic problem into a
 * blank page, which is a much worse trade than a status bar reading `—`.
 */

import type { Bootstrap } from "../shared/wire";

/** What the client assumes when the page told it nothing. */
export const EMPTY_BOOTSTRAP: Bootstrap = { cwd: "", vaultRoot: "", session: "" };

/**
 * Structural guard. Every field is a string, and all three are read.
 *
 * `session` is unused at P1 and checked anyway: it is what a later phase uses
 * to tell "I missed frames" from "this is a different server" (see its
 * `wire.ts` comment), and a guard that admits a bootstrap without it would
 * let that distinction fail silently the day it starts mattering.
 */
function isBootstrap(value: unknown): value is Bootstrap {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["cwd"] === "string" &&
    typeof candidate["vaultRoot"] === "string" &&
    typeof candidate["session"] === "string"
  );
}

/**
 * Decode the bootstrap JSON, falling back to {@link EMPTY_BOOTSTRAP}.
 *
 * @param text the block's `textContent`, or `null` when it is absent.
 */
export function readBootstrap(text: string | null): Bootstrap {
  if (text === null || text.trim() === "") return EMPTY_BOOTSTRAP;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return EMPTY_BOOTSTRAP;
  }
  return isBootstrap(parsed) ? parsed : EMPTY_BOOTSTRAP;
}
