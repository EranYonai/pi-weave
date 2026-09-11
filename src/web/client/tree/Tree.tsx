/**
 * The tree column (weave-workspace §1.2, P2.3).
 *
 * Props in, JSX out. Every string, glyph, branch and key binding comes from
 * `tree.model.ts`; what is left here is a `useState`, a `map` and four
 * handlers that forward into it. §10's rule, and the reason the 95 % gate
 * survives a UI phase with no DOM test environment.
 */

import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { recentIds } from "../state";
import { isTextEntry, type KeyTarget } from "../shell/keys.model";
import { ICON_BOX, ICON_STROKE, ICONS } from "../shell/icons.model";
import type { IconName } from "../shell/icons.model";
import type { GraphPayload, WireNodeKind } from "../../shared/wire";
import type { TreeContextMenuState, TreeRowView, TreeViewState } from "./tree.model";
import type { FetchLike } from "../api";
import { fetchJson } from "../api.dom";
import { createFolder, deleteFolder, deleteNote, moveNote, renameFolder, renameNote } from "../api";
import {
  FILTER_HINT,
  FILTER_LABEL,
  FILTER_PLACEHOLDER,
  FOLDER_BTN_HINT,
  FOLDER_PLACEHOLDER,
  TREE_LABEL,
  treeActiveDescendant,
  contextMenuItemsForRow,
  contextMenuPlacement,
  cycleProvenance,
  deletableTarget,
  depthVar,
  expand,
  folderPathFromId,
  initialTreeView,
  internalsHint,
  internalsLabel,
  isDraggableNote,
  isDropTarget,
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
  fetch?: FetchLike | undefined;
}

/**
 * One sprite glyph, as a real `<svg>`.
 *
 * The element is built from {@link ICONS}' path data rather than injected as
 * an HTML string — CSP-identical (neither path touches a `script-src` hook),
 * but the string form would carry a whole `<svg>` per row and Preact can
 * branch the two paint modes with a spread and no `if`. Every attribute here
 * is a presentation *attribute*, not a `style` one: `style-src` never sees it.
 * Sizing rides the width/height attributes rather than CSS for the same
 * reason — the box is part of the icon, not of its context.
 */
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
      {def.d.map((d) => (
        <path d={d} />
      ))}
    </svg>
  );
}

function Row({
  view,
  onSelect,
  onToggle,
  onDelete,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  isDragOver,
}: {
  view: TreeRowView;
  onSelect: () => void;
  onToggle: () => void;
  onDelete?: (() => void) | undefined;
  onDragStart?: (event: DragEvent) => void;
  onDragOver?: (event: DragEvent) => void;
  onDragLeave?: (event: DragEvent) => void;
  onDrop?: (event: DragEvent) => void;
  isDragOver?: boolean;
}) {
  return (
    <li
      id={view.domId}
      data-row-id={view.id}
      data-row-label={view.label}
      data-row-kind={view.kind}
      class={`weave-row weave-row-${view.kind}${view.selected ? " weave-row-on" : ""}${view.muted ? " weave-row-muted" : ""}${
        recentIds.value.has(view.id) ? " weave-row-new" : ""
      }${isDragOver ? " weave-row-droptarget" : ""}`}
      role="treeitem"
      aria-level={view.level}
      aria-posinset={view.posinset}
      aria-setsize={view.setsize}
      aria-selected={view.selected}
      aria-expanded={view.hasKids ? view.expanded : undefined}
      style={depthVar(view.depth)}
      onClick={onSelect}
      draggable={isDraggableNote(view.kind, view.id)}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* The glyphs are decoration: the twisty duplicates `aria-expanded`,
          the kind glyph duplicates nothing a screen reader needs, and the
          provenance shape is announced through its `title` instead. The
          chevron rotates through CSS, so "open" is a class, not a different
          sprite. */}
      <span
        class="weave-twisty"
        aria-hidden="true"
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
      >
        {view.hasKids ? <Icon name="chevron" class={view.expanded ? "weave-icon weave-icon-open" : "weave-icon"} /> : null}
      </span>
      <span class="weave-kind" aria-hidden="true">
        <Icon name={view.kindIcon} class="weave-icon" />
      </span>
      <span class={`weave-prov weave-prov-${view.provenance ?? "none"}`} title={view.provenanceTitle}>
        {view.provenanceGlyph}
      </span>
      <span class="weave-label">{view.label}</span>
      <span class="weave-meta">{view.meta}</span>
      {onDelete ? (
        <button
          type="button"
          class="weave-row-del"
          title={`Delete ${view.label}`}
          aria-label={`Delete ${view.label}`}
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
        >
          ×
        </button>
      ) : null}
    </li>
  );
}

export function Tree(props: TreeProps) {
  const [state, setState] = useState<TreeViewState>(initialTreeView);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [menu, setMenu] = useState<TreeContextMenuState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; label: string; isFolder: boolean } | null>(null);
  const [pendingRename, setPendingRename] = useState<{ slug: string; currentName: string; value: string } | null>(null);
  const [pendingRenameFolder, setPendingRenameFolder] = useState<{ oldPath: string; currentName: string; value: string } | null>(null);
  const [pendingSubfolder, setPendingSubfolder] = useState<{ parentPath: string; value: string } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const rows = rowsFor(props.graph, state);
  const empty = treeEmptyMessage(props.graph, rows, state);
  const fetcher = props.fetch ?? fetchJson;

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el || !menu) return;
    const placement = contextMenuPlacement(
      menu.x,
      menu.y,
      el.offsetWidth || 170,
      el.offsetHeight || 130,
      window.innerWidth,
      window.innerHeight,
    );
    el.style.setProperty("--weave-menu-x", `${placement.x}px`);
    el.style.setProperty("--weave-menu-y", `${placement.y}px`);
  }, [menu]);

  const confirmDeleteRow = (id: string, label: string) => {
    const target = deletableTarget(id);
    if (!target) return;
    setPendingDelete({ id, label, isFolder: target.type === "folder" });
  };

  const executeDelete = async (target: { id: string; label: string; isFolder: boolean }) => {
    const desc = deletableTarget(target.id);
    if (!desc) return;
    if (desc.type === "note") {
      await deleteNote(fetcher, desc.slug);
      if (props.selectedId === target.id) {
        props.onSelect("");
      }
    } else {
      await deleteFolder(fetcher, desc.path);
      if (props.selectedId && props.selectedId.startsWith(`note:${desc.path}/`)) {
        props.onSelect("");
      }
    }
  };

  const handleMenuAction = async (actionId: string) => {
    if (!menu) return;
    const current = menu;
    setMenu(null);
    switch (actionId) {
      case "open":
        props.onSelect(current.rowId);
        break;
      case "new-folder":
        setCreatingFolder(true);
        break;
      case "new-subfolder": {
        const parentPath = current.rowId.slice("vfolder:".length);
        setPendingSubfolder({ parentPath, value: "" });
        break;
      }
      case "rename": {
        if (!current.rowId.startsWith("note:")) break;
        const currentSlug = current.rowId.slice("note:".length);
        setPendingRename({ slug: currentSlug, currentName: current.rowLabel, value: current.rowLabel });
        break;
      }
      case "rename-folder": {
        if (!current.rowId.startsWith("vfolder:")) break;
        const folderPath = current.rowId.slice("vfolder:".length);
        const currentLeaf = folderPath.split("/").pop() ?? current.rowLabel;
        setPendingRenameFolder({ oldPath: folderPath, currentName: currentLeaf, value: currentLeaf });
        break;
      }
      case "delete-note":
      case "delete-folder":
        confirmDeleteRow(current.rowId, current.rowLabel);
        break;
      case "collapse-all":
        setState((curr) => ({ ...curr, expanded: new Set() }));
        break;
      case "copy-id":
        if (typeof navigator !== "undefined" && navigator.clipboard) {
          await navigator.clipboard.writeText(current.rowId);
        }
        break;
    }
  };

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
        <button
          type="button"
          class="weave-chip"
          title={FOLDER_BTN_HINT}
          onClick={() => setCreatingFolder((prev) => !prev)}
        >
          + folder
        </button>
      </div>
      {creatingFolder ? (
        <form
          class="weave-tree-new-folder"
          onSubmit={async (event) => {
            event.preventDefault();
            const name = folderName.trim();
            if (name) {
              await createFolder(fetcher, name);
              setCreatingFolder(false);
              setFolderName("");
            }
          }}
        >
          <input
            type="text"
            class="weave-filter"
            placeholder={FOLDER_PLACEHOLDER}
            value={folderName}
            onInput={(event) => setFolderName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                setCreatingFolder(false);
                setFolderName("");
              }
            }}
            autoFocus
          />
          <button type="submit" class="weave-chip">Create</button>
          <button
            type="button"
            class="weave-chip"
            onClick={() => {
              setCreatingFolder(false);
              setFolderName("");
            }}
          >
            Cancel
          </button>
        </form>
      ) : null}
      {empty === null ? (
        <ul
          class="weave-rows"
          role="tree"
          tabIndex={0}
          aria-label={TREE_LABEL}
          onContextMenu={(event: MouseEvent) => {
            event.preventDefault();
            const target = event.target as HTMLElement | null;
            const rowEl = target?.closest(".weave-row") as HTMLElement | null;
            if (rowEl) {
              const rowId = rowEl.getAttribute("data-row-id");
              const rowLabel = rowEl.getAttribute("data-row-label") ?? "";
              const rowKind = (rowEl.getAttribute("data-row-kind") ?? "note") as WireNodeKind;
              if (rowId) {
                setMenu({
                  x: event.clientX,
                  y: event.clientY,
                  rowId,
                  rowLabel,
                  kind: rowKind,
                });
                return;
              }
            }
            setMenu({
              x: event.clientX,
              y: event.clientY,
              rowId: "vault",
              rowLabel: "Vault",
              kind: "vault",
            });
          }}
          // Focus stays on the `<ul>` and the *active* row is named by
          // reference — the alternative, a roving `tabindex`, would put every
          // row in the Tab order and make Tab a fourth way to walk the tree.
          // `null` when the selection is not visible; see the model.
          aria-activedescendant={treeActiveDescendant(rows, props.selectedId) ?? undefined}
        >
          {rowViews(rows, props.selectedId, props.now).map((view) => (
            <Row
              key={view.id}
              view={view}
              onSelect={() => {
                props.onSelect(view.id);
                if (view.hasKids || view.id.startsWith("vfolder:")) {
                  setState((curr) => toggleExpanded(curr, view.id));
                }
              }}
              onToggle={() => setState(toggleExpanded(state, view.id))}
              onDelete={deletableTarget(view.id) ? () => confirmDeleteRow(view.id, view.label) : undefined}
              isDragOver={dragOverId === view.id}
              onDragStart={(event) => {
                event.dataTransfer?.setData("text/plain", view.id);
                if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(event) => {
                if (isDropTarget(view.id)) {
                  event.preventDefault();
                  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
                  setDragOverId(view.id);
                }
              }}
              onDragLeave={() => {
                if (dragOverId === view.id) setDragOverId(null);
              }}
              onDrop={async (event) => {
                event.preventDefault();
                setDragOverId(null);
                const draggedId = event.dataTransfer?.getData("text/plain");
                if (!draggedId || !draggedId.startsWith("note:")) return;
                const noteSlug = draggedId.slice("note:".length);
                const targetFolder = folderPathFromId(view.id);
                await moveNote(fetcher, noteSlug, targetFolder);
                if (view.id.startsWith("vfolder:")) {
                  setState((current) => expand(current, view.id));
                }
              }}
            />
          ))}
        </ul>
      ) : (
        <p class="weave-tree-empty">{empty}</p>
      )}
      <p class="weave-tree-count">{rowCountLabel(rows)}</p>
      {menu !== null ? (
        <>
          <div
            class="weave-menu-backdrop"
            onClick={() => setMenu(null)}
            onContextMenu={(e: MouseEvent) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <div
            ref={menuRef}
            class="weave-menu"
            role="menu"
            aria-label={`Context menu for ${menu.rowLabel}`}
          >
            {contextMenuItemsForRow(menu.rowId, menu.kind).map((item, idx) =>
              item.kind === "separator" ? (
                <hr key={idx} class="weave-menu-sep" />
              ) : (
                <button
                  key={item.id}
                  type="button"
                  class={`weave-menu-item${item.destructive ? " weave-menu-item-bad" : ""}`}
                  role="menuitem"
                  onClick={() => void handleMenuAction(item.id)}
                >
                  {item.icon ? <span aria-hidden="true">{item.icon}</span> : null}
                  <span>{item.label}</span>
                </button>
              ),
            )}
          </div>
        </>
      ) : null}
      {pendingDelete !== null ? (
        <div class="weave-scrim" onClick={() => setPendingDelete(null)}>
          <div
            class="weave-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-label="Confirm deletion"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") setPendingDelete(null);
            }}
          >
            <h3 class="weave-dialog-title">Delete {pendingDelete.isFolder ? "folder" : "note"}?</h3>
            <p class="weave-dialog-body">
              Are you sure you want to delete <strong>“{pendingDelete.label}”</strong>?
              {pendingDelete.isFolder ? " All notes inside will be permanently deleted." : " This cannot be undone."}
            </p>
            <div class="weave-dialog-actions">
              <button
                type="button"
                class="weave-chip"
                onClick={() => setPendingDelete(null)}
                autoFocus
              >
                Cancel
              </button>
              <button
                type="button"
                class="weave-chip weave-chip-bad"
                onClick={async () => {
                  const target = pendingDelete;
                  setPendingDelete(null);
                  await executeDelete(target);
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {pendingRename !== null ? (
        <div class="weave-scrim" onClick={() => setPendingRename(null)}>
          <div
            class="weave-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Rename note"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 class="weave-dialog-title">Rename note</h3>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const name = pendingRename.value.trim();
                if (name && name !== pendingRename.currentName) {
                  await renameNote(fetcher, pendingRename.slug, name, name);
                }
                setPendingRename(null);
              }}
            >
              <input
                type="text"
                class="weave-filter weave-dialog-input"
                value={pendingRename.value}
                onInput={(e) => setPendingRename({ ...pendingRename, value: e.currentTarget.value })}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setPendingRename(null);
                  }
                }}
                autoFocus
              />
              <div class="weave-dialog-actions">
                <button type="button" class="weave-chip" onClick={() => setPendingRename(null)}>
                  Cancel
                </button>
                <button type="submit" class="weave-chip">
                  Rename
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
      {pendingRenameFolder !== null ? (
        <div class="weave-scrim" onClick={() => setPendingRenameFolder(null)}>
          <div
            class="weave-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Rename folder"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 class="weave-dialog-title">Rename folder</h3>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const name = pendingRenameFolder.value.trim();
                if (name && name !== pendingRenameFolder.currentName) {
                  const prefix = pendingRenameFolder.oldPath.includes("/")
                    ? pendingRenameFolder.oldPath.split("/").slice(0, -1).join("/") + "/"
                    : "";
                  await renameFolder(fetcher, pendingRenameFolder.oldPath, prefix + name);
                }
                setPendingRenameFolder(null);
              }}
            >
              <input
                type="text"
                class="weave-filter weave-dialog-input"
                value={pendingRenameFolder.value}
                onInput={(e) => setPendingRenameFolder({ ...pendingRenameFolder, value: e.currentTarget.value })}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setPendingRenameFolder(null);
                  }
                }}
                autoFocus
              />
              <div class="weave-dialog-actions">
                <button type="button" class="weave-chip" onClick={() => setPendingRenameFolder(null)}>
                  Cancel
                </button>
                <button type="submit" class="weave-chip">
                  Rename
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
      {pendingSubfolder !== null ? (
        <div class="weave-scrim" onClick={() => setPendingSubfolder(null)}>
          <div
            class="weave-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="New subfolder"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 class="weave-dialog-title">New subfolder under “{pendingSubfolder.parentPath}”</h3>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const name = pendingSubfolder.value.trim();
                if (name) {
                  await createFolder(fetcher, `${pendingSubfolder.parentPath}/${name}`);
                  setState((curr) => expand(curr, `vfolder:${pendingSubfolder.parentPath}`));
                }
                setPendingSubfolder(null);
              }}
            >
              <input
                type="text"
                class="weave-filter weave-dialog-input"
                placeholder="Subfolder name…"
                value={pendingSubfolder.value}
                onInput={(e) => setPendingSubfolder({ ...pendingSubfolder, value: e.currentTarget.value })}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setPendingSubfolder(null);
                  }
                }}
                autoFocus
              />
              <div class="weave-dialog-actions">
                <button type="button" class="weave-chip" onClick={() => setPendingSubfolder(null)}>
                  Cancel
                </button>
                <button type="submit" class="weave-chip">
                  Create
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
