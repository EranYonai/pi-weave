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

import { LOGO_MARK_B64, LOGO_MARK_MIME } from "../../shared/logo";
import type { ConnectionView, HeaderSummary } from "./shell.model";
import { SEARCH_PLACEHOLDER, searchHint, summaryParts } from "./shell.model";

export interface HeaderProps {
  summary: HeaderSummary;
  connection: ConnectionView;
  shortcut: string;
  onRefresh: () => void;
  /** Opens the ⌘K palette. The same action the global key performs. */
  onSearch: () => void;
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
      <button type="button" class="weave-refresh" onClick={props.onRefresh} title="Refetch everything">
        ⟳
      </button>
      <span class={`weave-conn weave-conn-${props.connection.tone}`} title={props.connection.hint}>
        <span class="weave-conn-dot" aria-hidden="true">
          ●
        </span>
        {props.connection.label}
      </span>
    </header>
  );
}
