/** The vault and repository tree column. */

import { useState } from "preact/hooks";
import { createFolder, deleteFolder, deleteNote, moveNote, renameFolder, renameNote } from "../api";
import { fetchJson } from "../api.dom";
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
  deletesSelection,
  deleteNeedsConfirmation,
  depthVar,
  dropFolder,
  expand,
  initialTreeView,
  internalsHint,
  internalsLabel,
  mutableTreeRow,
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
  recentIds: ReadonlySet<string>;
  onSelect: (id: string) => void;
  onRefresh: () => void;
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

function Row({ view, recentIds, edit, onEdit, onRename, onSelect, onToggle, onMenu, onDrop }: { view: ReturnType<typeof rowViews>[number]; recentIds: ReadonlySet<string>; edit: string | null; onEdit: (value: string) => void; onRename: (value: string | null) => void; onSelect: () => void; onToggle: () => void; onMenu: (x: number, y: number) => void; onDrop: (id: string) => void }) {
  const folder = dropFolder(view.id);
  return (
    <li
      id={view.domId}
      data-row-id={view.id}
      class={`weave-row weave-row-${view.kind}${view.selected ? " weave-row-on" : ""}${recentIds.has(view.id) ? " weave-row-new" : ""}`}
      role="treeitem"
      aria-level={view.level}
      aria-posinset={view.posinset}
      aria-setsize={view.setsize}
      aria-selected={view.selected}
      aria-expanded={view.hasKids ? view.expanded : undefined}
      style={depthVar(view.depth)}
      onClick={onSelect}
      draggable={view.id.startsWith("note:")}
      onDragStart={(event) => event.dataTransfer?.setData("text/plain", view.id)}
      onDragOver={folder === undefined ? undefined : (event) => event.preventDefault()}
      onDrop={folder === undefined ? undefined : (event) => { event.preventDefault(); onDrop(event.dataTransfer?.getData("text/plain") ?? ""); }}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); onMenu(event.clientX, event.clientY); }}
    >
      <span class="weave-twisty" aria-hidden="true" onClick={(event) => { event.stopPropagation(); onToggle(); }}>
        {view.hasKids ? <Icon name="chevron" class={view.expanded ? "weave-icon weave-icon-open" : "weave-icon"} /> : null}
      </span>
      <span class="weave-kind" aria-hidden="true"><Icon name={view.kindIcon} class="weave-icon" /></span>
      <span class={`weave-prov weave-prov-${view.provenance ?? "none"}`} title={view.provenanceTitle}>{view.provenanceGlyph}</span>
      {edit === null ? <span class="weave-label">{view.label}</span> : <input class="weave-tree-rename" value={edit} autoFocus onClick={(event) => event.stopPropagation()} onInput={(event) => onEdit(event.currentTarget.value)} onBlur={(event) => onRename(event.currentTarget.value)} onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Enter") event.currentTarget.blur(); else if (event.key === "Escape") onRename(null); }} />}
      <span class="weave-meta">{view.meta}</span>
    </li>
  );
}

export function Tree(props: TreeProps) {
  const [state, setState] = useState(initialTreeView);
  const [menu, setMenu] = useState<{ id: string; label: string; x: number; y: number } | null>(null);
  const [editing, setEditing] = useState<{ id: string; label: string; value: string } | null>(null);
  const rows = rowsFor(props.graph, state);
  const empty = treeEmptyMessage(props.graph, rows, state);
  const run = async (pending: ReturnType<typeof deleteNote>, select?: string): Promise<void> => {
    const result = await pending;
    if (!result.ok) window.alert(result.message);
    else {
      const id = result.data.id ?? select;
      if (id !== undefined) props.onSelect(id);
      props.onRefresh();
    }
  };
  const act = async (action: "rename" | "delete" | "newFolder"): Promise<void> => {
    if (menu === null) return;
    const target = mutableTreeRow(menu.id);
    setMenu(null);
    if (target === null) return;
    if (action === "newFolder") {
      const name = window.prompt("Folder name:")?.trim();
      if (!name) return;
      const parent = target.type === "vault" ? "" : target.type === "folder" ? target.path : target.path.split("/").slice(0, -1).join("/");
      const targetPath = parent ? `${parent}/${name}` : name;
      if (parent) setState((current) => expand(current, `vfolder:${parent}`));
      await run(createFolder(fetchJson, targetPath));
    } else if (action === "rename") {
      setEditing({ id: menu.id, label: menu.label, value: menu.label });
    } else if (target.type !== "vault" && (!deleteNeedsConfirmation(target) || window.confirm(`Permanently delete folder “${menu.label}” and everything inside it?`))) {
      await run(target.type === "note" ? deleteNote(fetchJson, target.path) : deleteFolder(fetchJson, target.path), deletesSelection(props.selectedId, target) ? "vault" : undefined);
    }
  };
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
        <ul
          class="weave-rows"
          role="tree"
          tabIndex={0}
          aria-label={TREE_LABEL}
          aria-activedescendant={treeActiveDescendant(rows, props.selectedId) ?? undefined}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenu({ id: "vault", label: "Vault", x: event.clientX, y: event.clientY });
          }}
        >
          {rowViews(rows, props.selectedId, props.now).map((view) => <Row key={view.id} view={view} recentIds={props.recentIds} edit={editing?.id === view.id ? editing.value : null} onEdit={(value) => setEditing((current) => current === null ? null : { ...current, value })} onRename={(value) => { const current = editing; setEditing(null); const target = current === null ? null : mutableTreeRow(current.id); const name = value?.trim(); const label = current?.label; if (target !== null && name && label !== undefined && name !== label && window.confirm(`Rename “${label}”? Existing links to it may break.`)) void run(target.type === "note" ? renameNote(fetchJson, target.path, name) : renameFolder(fetchJson, target.path, name)); }} onSelect={() => { props.onSelect(view.id); if (view.hasKids) setState((current) => toggleExpanded(current, view.id)); }} onToggle={() => setState(toggleExpanded(state, view.id))} onMenu={(x, y) => setMenu({ id: view.id, label: view.label, x, y })} onDrop={(dragged) => { const folder = dropFolder(view.id); if (dragged.startsWith("note:") && folder !== undefined) void run(moveNote(fetchJson, dragged.slice("note:".length), folder)); }} />)}
        </ul>
      ) : <p class="weave-tree-empty">{empty}</p>}
      <p class="weave-tree-count">{rowCountLabel(rows)}</p>
      {menu !== null && mutableTreeRow(menu.id) !== null ? (() => {
        const target = mutableTreeRow(menu.id)!;
        return (
          <>
            <button type="button" class="weave-menu-backdrop" aria-label="Close context menu" onClick={() => setMenu(null)} />
            <div class="weave-menu" role="menu" style={{ left: `${menu.x}px`, top: `${menu.y}px` }}>
              <button type="button" role="menuitem" onClick={() => void act("newFolder")}>New folder…</button>
              {target.type !== "vault" ? (
                <>
                  <button type="button" role="menuitem" onClick={() => void act("rename")}>Rename…</button>
                  <button type="button" role="menuitem" class="weave-menu-danger" onClick={() => void act("delete")}>Delete</button>
                </>
              ) : null}
            </div>
          </>
        );
      })() : null}
    </div>
  );
}
