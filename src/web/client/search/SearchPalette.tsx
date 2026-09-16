import { useEffect, useRef, useState } from "preact/hooks";
import type { GraphPayload } from "../../shared/wire";
import { useFocusTrap } from "../shell/FocusTrap";
import { fetchSearch } from "../api";
import type { FetchLike } from "../api";
import type { SearchRowView } from "./search.model";
import { DEBOUNCE_MS, PALETTE_HINT, PALETTE_PLACEHOLDER, PALETTE_TITLE, initialSearchState, paletteModel, resultIdAt, searchKey } from "./search.model";
import type { SearchState } from "./search.model";

export interface SearchPaletteProps {
  graph: GraphPayload | null;
  onSelect: (id: string) => void;
  onClose: () => void;
  ports: { fetch: FetchLike };
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
  const [state, setState] = useState<SearchState>(initialSearchState);
  const requestId = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const trap = useFocusTrap();
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => void input.current?.focus(), []);

  useEffect(() => {
    const query = state.query.trim();
    let active = true;
    if (!query) {
      abort.current?.abort();
      setState((current) => ({ ...current, hits: [], answered: "", loading: false, failed: false }));
      return () => { active = false; };
    }

    const timer = window.setTimeout(async () => {
      const id = ++requestId.current;
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setState((current) => ({ ...current, loading: true, failed: false }));
      const result = await fetchSearch(props.ports.fetch, query, controller.signal);
      if (!active || controller.signal.aborted || id !== requestId.current) return;
      setState((current) => result.ok
        ? { ...current, hits: result.data.hits, answered: query, loading: false, failed: false, cursor: 0 }
        : { ...current, loading: false, failed: true });
    }, DEBOUNCE_MS);

    return () => {
      active = false;
      window.clearTimeout(timer);
      abort.current?.abort();
    };
  }, [state.query, props.ports.fetch]);

  const model = paletteModel(state, props.graph);
  const pick = (index: number | null): void => {
    const id = resultIdAt(model.rows, index);
    if (id !== null) props.onSelect(id);
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
          const next = searchKey(state.cursor, event.key, model.count);
          if (!next.handled) return;
          event.preventDefault();
          setState((current) => ({ ...current, cursor: next.cursor }));
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
          onInput={(event) => setState((current) => ({ ...current, query: event.currentTarget.value, cursor: 0 }))}
        />
        {model.status === null ? (
          <ul id="weave-search-results" class="weave-hits" role="listbox" aria-label={PALETTE_TITLE}>
            {model.rows.map((row, index) => <Row key={row.id} row={row} onPick={() => pick(index)} onHover={() => setState((current) => ({ ...current, cursor: index }))} />)}
          </ul>
        ) : (
          <p class="weave-palette-status" role="status">{model.status}</p>
        )}
        <p class="weave-palette-foot">
          <span>{model.countLabel}</span>
          <span class="weave-palette-hint">{PALETTE_HINT}</span>
        </p>
      </div>
    </div>
  );
}
