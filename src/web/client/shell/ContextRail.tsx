/**
 * The context rail beneath the graph column (weave-workspace §1.1, §1.2, P2.5).
 *
 * LINKS, BACKLINKS, TAGS and MENTIONS for whatever is selected — §1.1's
 * "bring related information into the current view", with every entry
 * clickable and nothing requiring a navigation to see.
 *
 * Props in, JSX out. `context.model.ts` decides which groups exist, which
 * rows they hold, what each row is labelled and what it selects; this renders
 * the result.
 */

import type { ContextGroup, ContextRow, TagGroupRow } from "../context/context.model";
import { contextModel } from "../context/context.model";
import type { GraphPayload } from "../../shared/wire";
import { CONTEXT_EMPTY } from "./shell.model";

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
          {row.kindGlyph}
        </span>
        <span class={`weave-prov weave-prov-${row.provenance ?? "none"}`} title={row.provenanceTitle}>
          {row.provenanceGlyph}
        </span>
        <span class="weave-label">{row.label}</span>
      </button>
    </li>
  );
}

function Group({ group, onSelect }: { group: ContextGroup; onSelect: (id: string) => void }) {
  return (
    <section class="weave-ctx-group">
      <h4 class="weave-ctx-heading">{group.heading}</h4>
      <ul class="weave-ctx-rows">
        {group.rows.map((row) => (
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
  const model = contextModel(props.graph, props.selectedId);
  return (
    <div class="weave-rail" aria-label={CONTEXT_EMPTY.title}>
      <h2 class="weave-col-title">{CONTEXT_EMPTY.title}</h2>
      {model.empty === null ? null : <p class="weave-ctx-empty">{model.empty}</p>}
      {model.groups.map((group) => (
        <Group key={group.heading} group={group} onSelect={props.onSelect} />
      ))}
      {model.tags.length === 0 ? null : (
        <section class="weave-ctx-group">
          <h4 class="weave-ctx-heading">TAGS</h4>
          <ul class="weave-ctx-tags">
            {model.tags.map((tag) => (
              <Tag key={tag.tag} tag={tag} onSelect={props.onSelect} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
