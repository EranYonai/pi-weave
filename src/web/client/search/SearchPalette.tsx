import { useEffect, useRef, useState } from "preact/hooks";
import type { GraphPayload } from "../../shared/wire";
import { useFocusTrap } from "../shell/FocusTrap";
import { ICON_BOX, ICON_STROKE } from "../shell/icons.model";
import type { IconDef } from "../shell/icons.model";
import { fetchSearch } from "../api";
import type { FetchLike } from "../api";
import type { PaletteIntent, SearchRowView, SearchState } from "./search.model";
import {
  DEBOUNCE_MS,
  LIGHT_UP_KEY,
  PALETTE_HINT,
  PALETTE_PLACEHOLDER,
  PALETTE_TITLE,
  SCOPE_GROUP_LABEL,
  SEARCH_GLYPH,
  closesPalette,
  initialSearchState,
  lightUpIntent,
  lightUpLabel,
  nextState,
  paletteKey,
  paletteModel,
  rowIntent,
  serverQuery,
} from "./search.model";

export interface SearchPaletteProps {
  graph: GraphPayload | null;
  onSelect: (id: string, newTab?: boolean) => void;
  onClose: () => void;
  /** Light the query's matches up in the graph. The footer offers it only when this is given. */
  onLightUp?: (query: string) => void;
  ports: { fetch: FetchLike };
}

function Glyph({ def, class: className }: { def: IconDef; class: string }) {
  return (
    <svg
      class={className}
      width={ICON_BOX}
      height={ICON_BOX}
      viewBox={`0 0 ${ICON_BOX} ${ICON_BOX}`}
      fill={def.filled ? "currentColor" : "none"}
      stroke={def.filled ? undefined : "currentColor"}
      stroke-width={def.filled ? undefined : def.width ?? ICON_STROKE}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {def.d.map((d) => <path d={d} />)}
    </svg>
  );
}

function Row({ row, onPick, onHover }: { row: SearchRowView; onPick: (newTab: boolean) => void; onHover: () => void }) {
  return (
    <li
      id={row.domId}
      role="option"
      aria-selected={row.active}
      class={`weave-hit weave-hit-${row.group}${row.active ? " weave-hit-on" : ""}`}
      onMouseMove={onHover}
      onClick={(event) => onPick(event.metaKey || event.ctrlKey)}
    >
      <Glyph def={row.icon} class="weave-icon weave-hit-icon" />
      <span class={row.mono ? "weave-hit-label weave-hit-mono" : "weave-hit-label"}>{row.label}</span>
      <span class="weave-hit-detail">{row.parts.map((part) => part.mark ? <mark class="weave-hit-mark">{part.text}</mark> : part.text)}</span>
      {row.meta ? <span class="weave-hit-meta">{row.meta}</span> : null}
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
    const query = serverQuery(state.query);
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

  const model = paletteModel(state, props.graph, Date.now());
  const run = (intent: PaletteIntent): void => {
    if (intent.type === "open") props.onSelect(intent.id, intent.newTab);
    if (intent.type === "lightUp") props.onLightUp?.(intent.query);
    if (closesPalette(intent)) props.onClose();
    else setState((current) => nextState(current, intent));
    if (intent.type === "scope" || intent.type === "tag") input.current?.focus();
  };

  return (
    <div class="weave-scrim" onClick={() => run({ type: "close" })}>
      <div
        class="weave-palette"
        role="dialog"
        aria-modal="true"
        aria-label={PALETTE_TITLE}
        tabIndex={-1}
        ref={trap.ref as { current: HTMLDivElement | null }}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          const intent = paletteKey(model, { key: event.key, shift: event.shiftKey, mod: event.metaKey || event.ctrlKey, inInput: event.target === input.current }, props.onLightUp !== undefined);
          if (intent.type === "none") {
            trap.onKeyDown(event as unknown as KeyboardEvent);
            return;
          }
          event.preventDefault();
          run(intent);
        }}
      >
        <div class="weave-palette-bar">
          <Glyph def={SEARCH_GLYPH} class="weave-icon weave-palette-glyph" />
          <input
            type="search"
            class="weave-palette-input"
            ref={input}
            value={state.query}
            placeholder={PALETTE_PLACEHOLDER}
            role="combobox"
            aria-label={PALETTE_TITLE}
            aria-expanded={model.count > 0}
            aria-autocomplete="list"
            aria-controls="weave-search-results"
            aria-activedescendant={model.activeDomId ?? undefined}
            onInput={(event) => setState((current) => ({ ...current, query: event.currentTarget.value, cursor: 0 }))}
          />
          <kbd class="weave-palette-kbd" aria-hidden="true">Esc</kbd>
        </div>
        {model.scopes.length ? (
          <div class="weave-palette-scopes" role="group" aria-label={SCOPE_GROUP_LABEL}>
            {model.scopes.map((scope) => (
              <button key={scope.scope} type="button" class="weave-palette-scope" aria-pressed={scope.active} onClick={() => run({ type: "scope", scope: scope.scope })}>
                {scope.label} <span class="weave-palette-scope-count">{scope.count}</span>
              </button>
            ))}
          </div>
        ) : null}
        {model.status === null ? (
          <ul id="weave-search-results" class="weave-hits" role="listbox" aria-label={PALETTE_TITLE}>
            {model.groups.map((group) => (
              <li key={group.group} role="presentation" class="weave-hit-section">
                <div id={group.domId} role="presentation" class="weave-hit-group">{group.heading}</div>
                <ul role="group" aria-labelledby={group.domId} class="weave-hit-rows">
                  {group.rows.map((row) => <Row key={row.id} row={row} onPick={(newTab) => run(rowIntent(row, newTab))} onHover={() => run({ type: "move", cursor: row.index })} />)}
                </ul>
              </li>
            ))}
          </ul>
        ) : (
          <p class="weave-palette-status" role="status">{model.status}</p>
        )}
        <p class="weave-palette-foot">
          <span>{PALETTE_HINT}</span>
          {props.onLightUp && model.lightUp > 0 ? (
            <button type="button" class="weave-palette-light" onClick={() => run(lightUpIntent(model))}>
              {lightUpLabel(model.lightUp)} <kbd class="weave-palette-kbd">{LIGHT_UP_KEY}</kbd>
            </button>
          ) : null}
        </p>
      </div>
    </div>
  );
}
