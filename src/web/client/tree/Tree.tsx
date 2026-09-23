/** The vault and repository tree column. */

import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { createFolder, deleteFolder, deleteNote, moveNote, renameFolder, renameNote } from "../api";
import { fetchJson } from "../api.dom";
import { isTextEntry, type KeyTarget } from "../shell/keys.model";
import { ICON_BOX, ICON_STROKE, ICONS } from "../shell/icons.model";
import type { IconName } from "../shell/icons.model";
import type { GraphPayload } from "../../shared/wire";
import {
  DRAFT_FOLDER_ID,
  deleteItemLabel,
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
  newFolderParent,
  newFolderPath,
  withDraftRow,
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
  /**
   * Ask before a mutation that would invalidate an open draft in the note
   * column, closing that draft if the user agrees. `false` means keep
   * editing, and the mutation must not run.
   */
  onMutate: () => boolean;
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
      aria-label={view.id === DRAFT_FOLDER_ID ? "New folder" : undefined}
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
      {edit === null ? <span class="weave-label">{view.label}</span> : <RenameInput value={edit} draft={view.id === DRAFT_FOLDER_ID} onEdit={onEdit} onCommit={onRename} />}
      <span class="weave-meta">{view.meta}</span>
    </li>
  );
}

/**
 * The inline editor, as its own component so it **mounts** when an edit
 * starts.
 *
 * That is the whole reason it is not an `<input>` inline in {@link Row}: the
 * existing name has to be selected once, when the editor opens, and neither
 * obvious spelling does that. An inline `ref={(el) => el?.select()}` re-runs
 * on every render — preact's children diff fires a ref whenever its
 * *identity* changes (`oldVNode.ref != childVNode.ref` in
 * `diff/children.js`), and an arrow literal is a new identity each time — so
 * every keystroke would re-select the text being typed. `onFocus` re-selects
 * whenever the tab regains focus mid-edit. A mount effect fires exactly once,
 * which is the actual requirement.
 *
 * `useLayoutEffect`, not `useEffect`, so the selection is in place before
 * paint — otherwise the fix itself flashes unselected text for a frame.
 */
function RenameInput({ value, draft, onEdit, onCommit }: { value: string; draft: boolean; onEdit: (value: string) => void; onCommit: (value: string | null) => void }) {
  const input = useRef<HTMLInputElement | null>(null);
  useLayoutEffect(() => {
    const element = input.current;
    if (element === null) return;
    element.focus();
    // A draft folder has no name yet, and `select()` on an empty input is a
    // no-op — so this needs no branch.
    element.select();
  }, []);
  return (
    <input
      ref={input}
      class="weave-tree-rename"
      value={value}
      placeholder={draft ? "New folder name…" : undefined}
      onClick={(event) => event.stopPropagation()}
      onInput={(event) => onEdit(event.currentTarget.value)}
      onBlur={(event) => onCommit(event.currentTarget.value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") event.currentTarget.blur();
        else if (event.key === "Escape") onCommit(null);
      }}
    />
  );
}

export function Tree(props: TreeProps) {
  const [state, setState] = useState(initialTreeView);
  /**
   * The open context menu. `armed` is the folder-delete confirmation: the
   * first click on `Delete…` sets it, and only then does the item delete —
   * see `deleteItemLabel`. Held on the menu so closing it disarms, which is
   * what makes a mis-click cheap.
   */
  const [menu, setMenu] = useState<{ id: string; label: string; x: number; y: number; armed?: boolean } | null>(null);
  const [editing, setEditing] = useState<{ id: string; label: string; value: string } | null>(null);
  /**
   * The parent path a pending "New folder" will be created under, or `null`.
   *
   * The folder is not created until the name is committed — see
   * {@link withDraftRow}. Escaping leaves nothing behind.
   */
  const [draft, setDraft] = useState<string | null>(null);
  const rows = withDraftRow(rowsFor(props.graph, state), draft);
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
      // A draft row with the cursor in it, not a modal: the same inline
      // gesture `rename` already uses, and it shows *where* the folder will
      // land, which a prompt cannot.
      const parent = newFolderParent(target);
      if (parent !== "") setState((current) => expand(current, `vfolder:${parent}`));
      setDraft(parent);
      setEditing({ id: DRAFT_FOLDER_ID, label: "", value: "" });
    } else if (action === "rename") {
      setEditing({ id: menu.id, label: menu.label, value: menu.label });
    } else if (target.type !== "vault") {
      // The guard runs **before** the request, not after it. Asking on the
      // selection that follows a successful delete would be asking about a
      // file that is already gone — and "keep editing" would leave the draft
      // attached to a slug whose next save is a 404.
      if (deletesSelection(props.selectedId, target) && !props.onMutate()) return;
      await run(target.type === "note" ? deleteNote(fetchJson, target.path) : deleteFolder(fetchJson, target.path), deletesSelection(props.selectedId, target) ? "vault" : undefined);
    }
  };

  /**
   * The delete item was clicked. Arms first for a folder, deletes second.
   *
   * A note deletes on the first click (§#37): it is one file whose name the
   * user just read off the row. A folder is `fs.rm(recursive)` over a subtree
   * the row shows no count for, so it takes two — and the second click's label
   * names the folder, which is the chance to notice the wrong row was hit.
   */
  const clickDelete = (target: { type: "note" | "folder" | "vault" }): void => {
    if (menu === null) return;
    if (deleteNeedsConfirmation(target) && menu.armed !== true) {
      setMenu({ ...menu, armed: true });
      return;
    }
    void act("delete");
  };
  /**
   * The inline editor was committed (Enter or blur) or abandoned (Escape).
   *
   * Two gestures share one input, so this is where they part: the draft row
   * creates a folder, every other row renames. Both clear the editor first,
   * so an abandoned edit and a failed request leave the same clean state.
   */
  const commitEdit = (value: string | null): void => {
    const current = editing;
    const parent = draft;
    setEditing(null);
    setDraft(null);
    if (current === null) return;
    const name = value?.trim();
    if (current.id === DRAFT_FOLDER_ID) {
      // Escape, or an empty name: the draft simply disappears. Nothing was
      // created, so there is nothing to undo.
      const path = parent === null || !name ? null : newFolderPath(parent, name);
      if (path !== null) void run(createFolder(fetchJson, path));
      return;
    }
    const target = mutableTreeRow(current.id);
    // No confirmation about the *rename*. A rename can break wiki-links, but
    // the warning was unactionable — it named no link and offered no way to
    // see them — and it fired on the *commit* of an edit the user had already
    // typed out, which is the least useful moment to ask. Renaming back is one
    // more rename. An open draft on the note being renamed is a different
    // question, and `onMutate` is the one asking it.
    if (target !== null && name && name !== current.label) {
      if (deletesSelection(props.selectedId, target) && !props.onMutate()) return;
      void run(target.type === "note" ? renameNote(fetchJson, target.path, name) : renameFolder(fetchJson, target.path, name));
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
          {rowViews(rows, props.selectedId, props.now).map((view) => <Row key={view.id} view={view} recentIds={props.recentIds} edit={editing?.id === view.id ? editing.value : null} onEdit={(value) => setEditing((current) => current === null ? null : { ...current, value })} onRename={commitEdit} onSelect={() => { props.onSelect(view.id); if (view.hasKids) setState((current) => toggleExpanded(current, view.id)); }} onToggle={() => setState(toggleExpanded(state, view.id))} onMenu={(x, y) => setMenu({ id: view.id, label: view.label, x, y })} onDrop={(dragged) => { const folder = dropFolder(view.id); if (dragged.startsWith("note:") && folder !== undefined) { if (dragged === props.selectedId && !props.onMutate()) return; void run(moveNote(fetchJson, dragged.slice("note:".length), folder)); } }} />)}
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
                  <button type="button" role="menuitem" class="weave-menu-danger" onClick={() => clickDelete(target)}>{deleteItemLabel(target, menu.label, menu.armed === true)}</button>
                </>
              ) : null}
            </div>
          </>
        );
      })() : null}
    </div>
  );
}
