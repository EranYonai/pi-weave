/**
 * The context rail beneath the graph column (weave-workspace §1.1, §1.2, P2.5).
 *
 * LINKS, BACKLINKS, TAGS and MENTIONS for whatever is selected — §1.1's
 * "bring related information into the current view", with every entry
 * clickable and nothing requiring a navigation to see.
 *
 * Props in, JSX out. `context.model.ts` decides which groups exist, which
 * rows they hold, what each row is labelled and what it selects — and, since
 * Tier 6, how many of them there are and whether the group is open. This
 * renders the result, plus one `useState` for the toggles the model needs to
 * resolve it.
 */

import { useState } from "preact/hooks";
import type { ContextModel, ContextRow, RailSectionView, RailToggles, TagGroupRow } from "../context/context.model";
import { contextModel, emptyRailToggles, railPanelId, railSectionView, railTagsView, railToggled } from "../context/context.model";
import type { GraphPayload } from "../../shared/wire";
import { CONTEXT_EMPTY } from "./shell.model";
import { Icon } from "../tree/Tree";

export interface ContextRailProps {
  graph: GraphPayload | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

function Row({ row, onSelect }: { row: ContextRow; onSelect: () => void }) {
  return (
    <li class={`weave-ctx-row${row.selected ? " weave-row-on" : ""}`}>
      <button type="button" class="weave-ctx-link" onClick={onSelect}>
        <span class="weave-kind" aria-hidden="true">
          <Icon name={row.kindIcon} class="weave-icon" />
        </span>
        <span class={`weave-prov weave-prov-${row.provenance ?? "none"}`} title={row.provenanceTitle}>
          {row.provenanceGlyph}
        </span>
        <span class="weave-label">{row.label}</span>
      </button>
    </li>
  );
}

/**
 * One collapsible section heading.
 *
 * The heading is a `<button>`, not a bare `<h4>` with a click handler: a
 * disclosure control that is not a button is not focusable and cannot answer
 * Enter or Space, and every group this rail renders is one. `aria-expanded`
 * and `aria-controls` travel with it, and the ids they name come from the
 * model so a re-render cannot orphan them.
 */
function Heading({ view, onToggle }: { view: RailSectionView; onToggle: () => void }) {
  return (
    <h4 class="weave-ctx-head">
      <button type="button" class="weave-ctx-heading" aria-expanded={!view.collapsed} aria-controls={railPanelId(view.heading)} onClick={onToggle}>
        <span class="weave-ctx-chevron" aria-hidden="true">
          <Icon name="chevron" class={view.collapsed ? "weave-icon" : "weave-icon weave-icon-open"} />
        </span>
        {view.heading}
        <span class="weave-ctx-count">{view.count}</span>
      </button>
    </h4>
  );
}

function Group({ view, onSelect, onToggle }: { view: RailSectionView; onSelect: (id: string) => void; onToggle: () => void }) {
  return (
    <section class="weave-ctx-group">
      <Heading view={view} onToggle={onToggle} />
      <ul class="weave-ctx-rows" id={railPanelId(view.heading)} hidden={view.collapsed}>
        {view.rows.map((row) => (
          <Row key={row.id} row={row} onSelect={() => onSelect(row.target)} />
        ))}
      </ul>
    </section>
  );
}

function Tag({ tag, onSelect }: { tag: TagGroupRow; onSelect: (id: string) => void }) {
  return (
    <li class="weave-ctx-tag">
      <span class="weave-tag">#{tag.tag}</span>
      <ul class="weave-ctx-rows">
        {tag.siblings.map((row) => (
          <Row key={row.id} row={row} onSelect={() => onSelect(row.target)} />
        ))}
      </ul>
    </li>
  );
}

export function ContextRail(props: ContextRailProps) {
  const model: ContextModel = contextModel(props.graph, props.selectedId);
  // The user's open/closed word lives in this component — it is view state,
  // not a workspace fact, so it does not cross the §1.3 bus and does not
  // survive a reload. Resolving it against the model is the model's job.
  const [toggles, setToggles] = useState<RailToggles>(emptyRailToggles);
  // The view carries the section's current state, so the click handler needs
  // no lookup — "which way am I going" was resolved a few lines up.
  const toggleFor = (view: RailSectionView): (() => void) => () => setToggles(railToggled(toggles, view.heading, view.collapsed));
  const tags = railTagsView(model.tags, toggles);
  return (
    <div class="weave-rail" aria-label={CONTEXT_EMPTY.title}>
      <h2 class="weave-col-title">{CONTEXT_EMPTY.title}</h2>
      {model.empty === null ? null : <p class="weave-ctx-empty">{model.empty}</p>}
      {model.groups.map((group) => {
        const view = railSectionView(group, toggles);
        return <Group key={group.heading} view={view} onSelect={props.onSelect} onToggle={toggleFor(view)} />;
      })}
      {model.tags.length === 0 ? null : (
        <section class="weave-ctx-group">
          <Heading view={tags} onToggle={toggleFor(tags)} />
          <ul class="weave-ctx-tags" id={railPanelId(tags.heading)} hidden={tags.collapsed}>
            {model.tags.map((tag) => (
              <Tag key={tag.tag} tag={tag} onSelect={props.onSelect} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}