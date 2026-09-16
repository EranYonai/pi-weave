/**
 * Reading the page's bootstrap block.
 *
 * `page.ts` embeds `{cwd}` as a nonce'd
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
export const EMPTY_BOOTSTRAP: Bootstrap = { cwd: "" };

/**
 * Structural guard for the one value the client reads.
 */
function isBootstrap(value: unknown): value is Bootstrap {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["cwd"] === "string";
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
