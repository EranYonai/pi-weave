/**
 * The tree column (weave-workspace §1.2, P2.3).
 *
 * Props in, JSX out. Every string, glyph, branch and key binding comes from
 * `tree.model.ts`; what is left here is a `useState`, a `map` and four
 * handlers that forward into it. §10's rule, and the reason the 95 % gate
 * survives a UI phase with no DOM test environment.
 */

import { useState } from "preact/hooks";
import { recentIds } from "../state";
import { isTextEntry, type KeyTarget } from "../shell/keys.model";
import type { GraphPayload } from "../../shared/wire";
import type { TreeRowView, TreeViewState } from "./tree.model";
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
  /** Epoch ms for relative times. Injected so the render is deterministic. */
  now: number;
}

function Row({ view, onSelect, onToggle }: { view: TreeRowView; onSelect: () => void; onToggle: () => void }) {
  return (
    <li
      id={view.domId}
      class={`weave-row weave-row-${view.kind}${view.selected ? " weave-row-on" : ""}${
        recentIds.value.has(view.id) ? " weave-row-new" : ""
      }`}
      role="treeitem"
      aria-level={view.level}
      aria-posinset={view.posinset}
      aria-setsize={view.setsize}
      aria-selected={view.selected}
      aria-expanded={view.hasKids ? view.expanded : undefined}
      style={depthVar(view.depth)}
      onClick={onSelect}
    >
      {/* The glyphs are decoration: the twisty duplicates `aria-expanded`,
          the kind glyph duplicates nothing a screen reader needs, and the
          provenance shape is announced through its `title` instead. */}
      <span
        class="weave-twisty"
        aria-hidden="true"
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
      >
        {view.twistyGlyph}
      </span>
      <span class="weave-kind" aria-hidden="true">
        {view.kindGlyph}
      </span>
      <span class={`weave-prov weave-prov-${view.provenance ?? "none"}`} title={view.provenanceTitle}>
        {view.provenanceGlyph}
      </span>
      <span class="weave-label">{view.label}</span>
      <span class="weave-meta">{view.meta}</span>
    </li>
  );
}

export function Tree(props: TreeProps) {
  const [state, setState] = useState<TreeViewState>(initialTreeView);
  const rows = rowsFor(props.graph, state);
  const empty = treeEmptyMessage(props.graph, rows, state);

  return (
    <div
      class="weave-tree"
      onKeyDown={(event) => {
        // The filter box sits inside this listener, so its keystrokes arrive
        // here too: a `j` meant for the query must stay a character, not an
        // alias the tree consumes. The model refuses when `typing` is true.
        const target = event.target as KeyTarget;
        const typing = isTextEntry(target?.tagName ?? null, target?.isContentEditable === true);
        const next = treeKey(rows, state, props.selectedId, event.key, typing);
        if (!next.handled) return;
        event.preventDefault();
        setState(next.state);
        if (next.selectedId !== null) props.onSelect(next.selectedId);
      }}
    >
      <div class="weave-tree-controls">
        <input
          type="search"
          class="weave-filter"
          value={state.query}
          placeholder={FILTER_PLACEHOLDER}
          aria-label={FILTER_LABEL}
          title={FILTER_HINT}
          onInput={(event) => setState(setQuery(state, event.currentTarget.value))}
        />
        <button type="button" class="weave-chip" title={provenanceHint(state.provFilter)} onClick={() => setState(cycleProvenance(state))}>
          ◧ {provenanceLabel(state.provFilter)}
        </button>
        <button type="button" class="weave-chip" title={internalsHint(state.showInternals)} onClick={() => setState(toggleInternals(state))}>
          ◧ {internalsLabel(state.showInternals)}
        </button>
      </div>
      {empty === null ? (
        <ul
          class="weave-rows"
          role="tree"
          tabIndex={0}
          aria-label={TREE_LABEL}
          // Focus stays on the `<ul>` and the *active* row is named by
          // reference — the alternative, a roving `tabindex`, would put every
          // row in the Tab order and make Tab a fourth way to walk the tree.
          // `null` when the selection is not visible; see the model.
          aria-activedescendant={treeActiveDescendant(rows, props.selectedId) ?? undefined}
        >
          {rowViews(rows, props.selectedId, props.now).map((view) => (
            <Row key={view.id} view={view} onSelect={() => props.onSelect(view.id)} onToggle={() => setState(toggleExpanded(state, view.id))} />
          ))}
        </ul>
      ) : (
        <p class="weave-tree-empty">{empty}</p>
      )}
      <p class="weave-tree-count">{rowCountLabel(rows)}</p>
    </div>
  );
}
