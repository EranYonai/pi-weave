/**
 * The ⌘K palette (weave-workspace §1.2, P4).
 *
 * Props in, JSX out. Ranking, merging, debouncing, stale-response rejection,
 * cursor movement and every string are `search.model.ts` and `search.ts`; the
 * focus trap is `focus.model.ts` behind `useFocusTrap`. What is left is a
 * `useState`, one memo and three handlers. §10's rule.
 */

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { GraphPayload } from "../../shared/wire";
import { useFocusTrap } from "../shell/FocusTrap";
import type { SearchRowView } from "./search.model";
import { PALETTE_HINT, PALETTE_PLACEHOLDER, PALETTE_TITLE, initialSearchState, paletteModel, resultIdAt, searchKey } from "./search.model";
import type { SearchOptions } from "./search";
import { createSearch } from "./search";

export interface SearchPaletteProps {
  graph: GraphPayload | null;
  /** The §1.3 context bus. */
  onSelect: (id: string) => void;
  onClose: () => void;
  /** The controller's ports (§10). Supplied by the shell. */
  ports: Omit<SearchOptions, "onChange">;
}

function Row({ row, onPick, onHover }: { row: SearchRowView; onPick: () => void; onHover: () => void }) {
  return (
    <li
      id={row.domId}
      role="option"
      aria-selected={row.active}
      class={`weave-hit weave-hit-${row.kind}${row.active ? " weave-hit-on" : ""}`}
      onMouseMove={onHover}
      onClick={onPick}
    >
      <span class="weave-hit-badge">{row.badge}</span>
      <span class="weave-hit-label">{row.label}</span>
      <span class="weave-hit-detail">{row.detail}</span>
    </li>
  );
}

export function SearchPalette(props: SearchPaletteProps) {
  const [state, setState] = useState(initialSearchState);
  const search = useMemo(() => createSearch({ ...props.ports, onChange: setState }), []);
  const trap = useFocusTrap();
  const input = useRef<HTMLInputElement | null>(null);
  // Focus the input, not the container the trap starts on: the palette's
  // whole surface is its query, and opening it to a container that only
  // swallows (and does not forward) keystrokes makes the user click before
  // they can type. Runs after the trap's own effect — hooks run in order,
  // and the trap is created first — so this is the final word. The input
  // carries the dialog's `aria-label`, so the announcement the
  // container-focus exists for still happens.
  useEffect(() => void input.current?.focus(), []);
  const model = paletteModel(state, props.graph);

  const pick = (index: number | null): void => {
    const id = resultIdAt(model.rows, index);
    if (id !== null) props.onSelect(id);
    search.dismiss();
    props.onClose();
  };

  return (
    <div class="weave-scrim" onClick={() => pick(null)}>
      <div
        class="weave-palette"
        role="dialog"
        aria-modal="true"
        aria-label={PALETTE_TITLE}
        tabIndex={-1}
        ref={trap.ref as { current: HTMLDivElement | null }}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (trap.onKeyDown(event as unknown as KeyboardEvent)) return;
          const next = searchKey(state, event.key, model.count);
          if (!next.handled) return;
          event.preventDefault();
          search.setCursor(next.state.cursor);
          if (next.dismiss) pick(next.activate);
        }}
      >
        <input
          type="search"
          class="weave-palette-input"
          ref={input}
          value={state.query}
          placeholder={PALETTE_PLACEHOLDER}
          aria-label={PALETTE_TITLE}
          aria-controls="weave-search-results"
          aria-activedescendant={model.activeDomId ?? undefined}
          onInput={(event) => search.setQuery(event.currentTarget.value)}
        />
        {model.status === null ? (
          <ul id="weave-search-results" class="weave-hits" role="listbox" aria-label={PALETTE_TITLE}>
            {model.rows.map((row, index) => (
              <Row key={row.id} row={row} onPick={() => pick(index)} onHover={() => search.setCursor(index)} />
            ))}
          </ul>
        ) : (
          <p class="weave-palette-status" role="status">
            {model.status}
          </p>
        )}
        <p class="weave-palette-foot">
          <span>{model.countLabel}</span>
          <span class="weave-palette-hint">{PALETTE_HINT}</span>
        </p>
      </div>
    </div>
  );
}
