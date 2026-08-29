/**
 * The header bar (weave-workspace §1.2).
 *
 * Title, the `⌘K` search button, the `vault:N · repo:… · N nodes` summary,
 * the refresh button and the connection dot. Every string and every tone
 * comes from `shell.model.ts`.
 *
 * The search control was `disabled` through P1–P3 because search was P4 and
 * an affordance that looks live but is not would be the dishonest option. P4
 * landed, so it is live — and it is a `<button>`, not an `<input>`: the
 * palette owns the only text field in the workspace, and a header box you
 * could type into whose contents were then thrown away when the overlay
 * opened would be a worse lie than the disabled version it replaced.
 */

import { useState } from "preact/hooks";
import { LOGO_MARK_B64, LOGO_MARK_MIME } from "../../shared/logo";
import type { ThemeButtonView } from "./theme.model";
import type { ConnectionView, HeaderSummary } from "./shell.model";
import { REFRESH_ICON_PATHS, SEARCH_PLACEHOLDER, searchHint, summaryParts } from "./shell.model";

export interface HeaderProps {
  summary: HeaderSummary;
  connection: ConnectionView;
  shortcut: string;
  onRefresh: () => void;
  /** Opens the ⌘K palette. The same action the global key performs. */
  onSearch: () => void;
  /** The theme control's face (glyph + hint), from `shell.model.ts`'s friend in `theme.model.ts`. */
  theme: ThemeButtonView;
  /** Advance the theme choice one step in its cycle. The same action the `t` key performs. */
  onTheme: () => void;
}

/**
 * The refresh control, drawn rather than typed.
 *
 * The `⟳` it replaces was a text character, so its weight and shape were
 * whatever the platform's font felt like — the one glyph in the header that
 * the theme did not own. These two strokes (`REFRESH_ICON_PATHS`, in
 * `shell.model.ts`) are stroked in `currentColor`, so hover recolours them
 * like any other text glyph.
 *
 * The spin is one 600 ms turn on click, restarted only by the next click —
 * it says "the request left", which is the truth, and stops rather than
 * pretending to know when the refetch lands (the refetch is fire-and-forget
 * by §7's register, and a spinner that waits for a signal a 304 may never
 * fire would hang forever). Reduced-motion users get the static glyph back,
 * as everywhere else in the sheet.
 */
function RefreshButton({ onRefresh }: { onRefresh: () => void }) {
  const [spinning, setSpinning] = useState(false);
  return (
    <button
      type="button"
      class="weave-refresh"
      onClick={() => {
        onRefresh();
        setSpinning(true);
      }}
      onAnimationEnd={() => setSpinning(false)}
      title="Refetch everything"
      aria-busy={spinning ? "true" : undefined}
    >
      <svg
        class={spinning ? "weave-refresh-glyph weave-refresh-spinning" : "weave-refresh-glyph"}
        viewBox="0 0 24 24"
        width={14}
        height={14}
        fill="none"
        stroke="currentColor"
        stroke-width={2}
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        {REFRESH_ICON_PATHS.map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
    </button>
  );
}

export function Header(props: HeaderProps) {
  return (
    <header class="weave-header">
      <span class="weave-brand">
        <img
          class="weave-brand-mark"
          src={`data:${LOGO_MARK_MIME};base64,${LOGO_MARK_B64}`}
          alt=""
          width={18}
          height={18}
        />
        pi-weave
      </span>
      <button type="button" class="weave-search" title={searchHint(props.shortcut)} onClick={props.onSearch}>
        <span class="weave-search-text">{SEARCH_PLACEHOLDER}</span>
        <kbd>{props.shortcut}</kbd>
      </button>
      <span class="weave-summary">
        {summaryParts(props.summary).map((part) => (
          <span key={part} class="weave-summary-part">
            {part}
          </span>
        ))}
      </span>
      <button
        type="button"
        class="weave-theme"
        onClick={props.onTheme}
        title={props.theme.hint}
        aria-label={props.theme.hint}
      >
        {props.theme.glyph}
      </button>
      <RefreshButton onRefresh={props.onRefresh} />
      <span class={`weave-conn weave-conn-${props.connection.tone}`} title={props.connection.hint}>
        <span class="weave-conn-dot" aria-hidden="true">
          ●
        </span>
        {props.connection.label}
      </span>
    </header>
  );
}
