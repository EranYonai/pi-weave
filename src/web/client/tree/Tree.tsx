/** The read-only tree column. */

import { useState } from "preact/hooks";
import { recentIds } from "../state";
import { isTextEntry, type KeyTarget } from "../shell/keys.model";
import { ICON_BOX, ICON_STROKE, ICONS } from "../shell/icons.model";
import type { IconName } from "../shell/icons.model";
import type { GraphPayload } from "../../shared/wire";
import {
  FILTER_HINT,
  FILTER_LABEL,
  FILTER_PLACEHOLDER,
  TREE_LABEL,
  treeActiveDescendant,
  cycleProvenance,
  depthVar,
  initialTreeView,
  internalsHint,
  internalsLabel,
  provenanceHint,
  provenanceLabel,
  rowCountLabel,
  rowViews,
  rowsFor,
  setQuery,
  toggleExpanded,
  toggleInternals,
  treeEmptyMessage,
  treeKey,
} from "./tree.model";

export interface TreeProps {
  graph: GraphPayload | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  now: number;
}

export function Icon({ name, class: className }: { name: IconName; class?: string }) {
  const def = ICONS[name];
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

function Row({ view, onSelect, onToggle }: { view: ReturnType<typeof rowViews>[number]; onSelect: () => void; onToggle: () => void }) {
  return (
    <li
      id={view.domId}
      data-row-id={view.id}
      class={`weave-row weave-row-${view.kind}${view.selected ? " weave-row-on" : ""}${view.muted ? " weave-row-muted" : ""}${recentIds.value.has(view.id) ? " weave-row-new" : ""}`}
      role="treeitem"
      aria-level={view.level}
      aria-posinset={view.posinset}
      aria-setsize={view.setsize}
      aria-selected={view.selected}
      aria-expanded={view.hasKids ? view.expanded : undefined}
      style={depthVar(view.depth)}
      onClick={onSelect}
    >
      <span class="weave-twisty" aria-hidden="true" onClick={(event) => { event.stopPropagation(); onToggle(); }}>
        {view.hasKids ? <Icon name="chevron" class={view.expanded ? "weave-icon weave-icon-open" : "weave-icon"} /> : null}
      </span>
      <span class="weave-kind" aria-hidden="true"><Icon name={view.kindIcon} class="weave-icon" /></span>
      <span class={`weave-prov weave-prov-${view.provenance ?? "none"}`} title={view.provenanceTitle}>{view.provenanceGlyph}</span>
      <span class="weave-label">{view.label}</span>
      <span class="weave-meta">{view.meta}</span>
    </li>
  );
}

export function Tree(props: TreeProps) {
  const [state, setState] = useState(initialTreeView);
  const rows = rowsFor(props.graph, state);
  const empty = treeEmptyMessage(props.graph, rows, state);
  return (
    <div class="weave-tree" onKeyDown={(event) => {
      const target = event.target as KeyTarget;
      const next = treeKey(rows, state, props.selectedId, event.key, isTextEntry(target?.tagName ?? null, target?.isContentEditable === true));
      if (!next.handled) return;
      event.preventDefault();
      setState(next.state);
      if (next.selectedId !== null) props.onSelect(next.selectedId);
    }}>
      <div class="weave-tree-controls">
        <input type="search" class="weave-filter" value={state.query} placeholder={FILTER_PLACEHOLDER} aria-label={FILTER_LABEL} title={FILTER_HINT} onInput={(event) => setState(setQuery(state, event.currentTarget.value))} />
        <button type="button" class="weave-chip" title={provenanceHint(state.provFilter)} onClick={() => setState(cycleProvenance(state))}>◧ {provenanceLabel(state.provFilter)}</button>
        <button type="button" class="weave-chip" title={internalsHint(state.showInternals)} onClick={() => setState(toggleInternals(state))}>◧ {internalsLabel(state.showInternals)}</button>
      </div>
      {empty === null ? (
        <ul class="weave-rows" role="tree" tabIndex={0} aria-label={TREE_LABEL} aria-activedescendant={treeActiveDescendant(rows, props.selectedId) ?? undefined}>
          {rowViews(rows, props.selectedId, props.now).map((view) => <Row key={view.id} view={view} onSelect={() => { props.onSelect(view.id); if (view.hasKids) setState((current) => toggleExpanded(current, view.id)); }} onToggle={() => setState(toggleExpanded(state, view.id))} />)}
        </ul>
      ) : <p class="weave-tree-empty">{empty}</p>}
      <p class="weave-tree-count">{rowCountLabel(rows)}</p>
    </div>
  );
}
