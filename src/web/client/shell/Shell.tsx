/** Shared browser/desktop workspace: one data source, two optional tab groups. */
import { useEffect, useLayoutEffect, useRef, useState, useMemo } from "preact/hooks";
import type { GraphPayload, NotePayload } from "../../shared/wire";
import { activePane, activeTab, activateTab, closePane, closeTab, focusDocument, initialLayout, reorderTab, moveTab, navigateTab, openDocument, openWithPreferences, restoreWorkspace, openGraph, parseWorkspaceLayout, splitPane, tabDropSource, tabSelection } from "../../shared/workspace";
import type { Pane, WorkspaceLayout, WorkspaceTab } from "../../shared/workspace";
import { fetchJson } from "../api.dom";
import { createNote, fetchGraph, openNote, saveNote } from "../api";
import { Graph } from "../graph/Graph";
import { schemeOf, watchScheme } from "../graph/scheme";
import { createSigmaRenderer } from "../graph/renderer.dom";
import { Note } from "../note/Note";
import { createDraftStore, mayMutateDrafts, mayRemoveDrafts } from "../note/drafts";
import type { DraftStore } from "../note/drafts";
import { DISCARD_PROMPT } from "../note/note.model";
import { SearchPalette } from "../search/SearchPalette";
import { Icon, Tree } from "../tree/Tree";
import { initialWorkspaceState } from "../state";
import { startWorkspace, watchNote } from "../workspace";
import type { WorkspaceHandle } from "../workspace";
import { ContextRail } from "./ContextRail";
import { deeplinkSelection, formatHash } from "./deeplink.model";
import { Settings } from "./Settings";
import type { Preferences } from "../../shared/preferences";
import { THEMES } from "../../shared/themes";
import { useFocusTrap } from "./FocusTrap";
import { HelpOverlay } from "./HelpOverlay";
import { watchKeys } from "./keys";
import { COLUMN_FOCUS_SELECTORS, TREE_FILTER_SELECTOR, focusSelector, runShellAction } from "./keys.model";
import { StatusBar } from "./StatusBar";
import type { OverlayId } from "./shell.model";
import { NOTE_DRAG_TYPE, noteDropId, TICK_MS, graphClickOpensTab, looksApple, recentEntries, recordVisit, searchHint, searchShortcut, statusBarModel } from "./shell.model";
import { toggleTheme, effectiveScheme, loadTheme, saveTheme, themeButton } from "./theme.model";

export interface ShellProps { cwd: string; initialWidth: number; platform: string }

function titleOf(tab: WorkspaceTab, graph: GraphPayload | null): string {
  if (tab.kind === "graph") return "Graph view";
  const id = tabSelection(tab);
  return id === null ? "New tab" : graph?.model.nodes.find((node) => node.id === id)?.label ?? id.replace(/^[^:]+:/, "");
}

function RecentList(props: { visits: readonly string[]; graph: GraphPayload | null; selectedId: string | null; onSelect: (id: string, newTab?: boolean) => void }) {
  const [snapshot] = useState(props.visits);
  return <div class="weave-recents">{recentEntries(snapshot, props.graph, props.selectedId).map((entry) => <button type="button" key={entry.id}
    aria-current={entry.selected ? "page" : undefined} title={entry.label}
    onClick={(event) => props.onSelect(entry.id, event.metaKey || event.ctrlKey)}>
    <span class="weave-kind"><Icon name={entry.icon} class="weave-icon" /></span><span class="weave-recent-label">{entry.label}</span>
  </button>)}</div>;
}

/** A tab view can unmount; the shared draft store outlives it. */
function DocumentView(props: {
  preferences: Preferences; tab: WorkspaceTab; graph: GraphPayload | null; drafts: DraftStore; revision: number;
  onSelect: (id: string, newTab?: boolean) => void; onSave: (slug: string, body: string) => Promise<boolean>;
  now: number; onScroll: (value: number) => void; onSearch: () => void; onGraph: () => void; onCreate: (title: string) => Promise<boolean>;
}) {
  const id = tabSelection(props.tab);
  const slug = id?.startsWith("note:") ? id.slice(5) : null;
  const [loaded, setLoaded] = useState<{ slug: string; note: NotePayload | null; failed: boolean; version: number } | null>(null);
  const element = useRef<HTMLDivElement | null>(null);
  const savedScroll = useRef(props.tab.scroll);
  const [newNote, setNewNote] = useState(false);
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const titleInput = useRef<HTMLInputElement | null>(null);
  useLayoutEffect(() => { if (newNote) titleInput.current?.focus(); }, [newNote]);
  useEffect(() => {
    if (slug === null) return;
    const version = props.drafts.nextLoadVersion();
    return watchNote(fetchJson, slug, (result) => {
      setLoaded({ slug, note: result.ok ? result.data : null, failed: !result.ok, version });
    });
  }, [slug, props.graph?.stamp, props.revision]);
  const payload = loaded?.slug === slug ? loaded : null;
  useLayoutEffect(() => {
    const note = element.current?.querySelector<HTMLElement>(".weave-note");
    if (note !== null && note !== undefined) note.scrollTop = savedScroll.current;
    if (slug !== null && props.drafts.get(slug) !== null) element.current?.querySelector<HTMLTextAreaElement>(".weave-note-editor")?.focus();
  }, [id, payload?.note?.note.slug]);
  if (id === null) return <div class="weave-welcome">
    <span class="weave-welcome-mark" aria-hidden="true">✳</span><h1>Your knowledge, connected.</h1>
    <p>Ask your agent to write, organize, and connect your notes. Browse that knowledge here, or start a note yourself.</p>
    <div><button type="button" onClick={props.onSearch}>Search workspace <kbd>⌘K</kbd></button><button type="button" onClick={props.onGraph}>Explore graph</button><button type="button" onClick={() => setNewNote(true)}>New note</button></div>
    {newNote ? <form class="weave-new-note" onSubmit={(event) => {
      event.preventDefault();
      if (creating || !title.trim()) return;
      setCreating(true);
      void props.onCreate(title.trim()).finally(() => setCreating(false));
    }} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); if (!creating) setNewNote(false); } }}>
      <label for={`new-note-${props.tab.id}`}>Note title</label>
      <input id={`new-note-${props.tab.id}`} ref={titleInput} required value={title} disabled={creating} onInput={(event) => setTitle(event.currentTarget.value)} />
      <div><button type="submit" disabled={creating || !title.trim()}>{creating ? "Creating…" : "Create note"}</button><button type="button" disabled={creating} onClick={() => setNewNote(false)}>Cancel</button></div>
    </form> : null}
  </div>;
  const missing = props.graph !== null && !props.graph.model.nodes.some((node) => node.id === id);
  if (missing || (payload?.failed && props.drafts.isDirty(slug ?? ""))) {
    const draft = slug === null ? null : props.drafts.get(slug);
    if (draft !== null && slug !== null && props.drafts.isDirty(slug)) return <div class="weave-welcome">
      <h2>{missing ? "This item is no longer here" : "This note could not be loaded"}</h2>
      <p>Your unsaved draft is preserved below. Select and copy it before closing this workspace. {missing ? "Saving cannot restore or recreate the missing note." : "Reopen this tab to retry loading the note."}</p>
      <label class="weave-note-meta" for={`missing-draft-${props.tab.id}`}>Unsaved draft (read-only)</label>
      <textarea id={`missing-draft-${props.tab.id}`} class="weave-note-editor" aria-label="Unsaved draft for missing note" rows={16} readOnly value={draft.body} />
      <button type="button" onClick={props.onSearch}>Find another note</button>
    </div>;
    return <div class="weave-welcome"><h2>This item is no longer here</h2><p>It may have been moved or deleted. Your other tabs are still available.</p><button type="button" onClick={props.onSearch}>Find another note</button></div>;
  }
  return <div class="weave-document" ref={element} onScrollCapture={(event) => {
    const target = event.target as HTMLElement;
    if (target.classList.contains("weave-note")) { savedScroll.current = target.scrollTop; props.onScroll(target.scrollTop); }
  }}><Note spellcheck={props.preferences.spellcheck} defaultEdit={props.preferences.defaultEdit} note={payload?.note ?? null} loadFailed={payload?.failed ?? false} loadVersion={payload?.version ?? 0} graph={props.graph} selectedId={id}
    onSelect={props.onSelect} onOpen={(noteSlug) => void openNote(fetchJson, noteSlug).then((result) => {
      if (!result.ok) window.alert(result.message); else if (!result.data.opened) window.alert("Could not open the note in an editor.");
    })} onSave={props.onSave} drafts={props.drafts} idPrefix={props.tab.id} now={props.now} /></div>;
}

function ResizeHandle(props: { label: string; horizontal?: boolean; value: number; min: number; max: number; onChange: (delta: number) => void }) {
  const last = useRef<number | null>(null);
  return <div class="weave-workspace-divider" role="separator" tabIndex={0} aria-label={props.label}
    aria-orientation={props.horizontal ? "horizontal" : "vertical"} aria-valuenow={Math.round(props.value)} aria-valuemin={props.min} aria-valuemax={props.max}
    onPointerDown={(event) => { last.current = props.horizontal ? event.clientY : event.clientX; event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerMove={(event) => {
      if (last.current === null) return;
      const at = props.horizontal ? event.clientY : event.clientX;
      props.onChange(at - last.current); last.current = at;
    }}
    onPointerUp={(event) => { last.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }}
    onPointerCancel={() => { last.current = null; }}
    onKeyDown={(event) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault(); props.onChange(event.key === "ArrowLeft" || event.key === "ArrowUp" ? -20 : 20);
    }} />;
}

export function Shell(props: ShellProps) {
  const [data, setData] = useState(initialWorkspaceState);
  const [layout, setLayout] = useState(() => ({ ...initialLayout(), theme: loadTheme(localStorage) ?? "system" }));
  const [overlay, setOverlay] = useState<OverlayId>(null);
  const graphOverlay = overlay === "graph";
  const graphTrap = useFocusTrap(graphOverlay);
  const [now, setNow] = useState(Date.now);
  const [width, setWidth] = useState(props.initialWidth);
  const [scheme, setScheme] = useState(() => schemeOf(window));
  const [ready, setReady] = useState(false);
  const [info, setInfo] = useState({ version: "", vaultRoot: "" });
  const [persistError, setPersistError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [, setDraftRevision] = useState(0);
  const [graphSelection, setGraphSelection] = useState<string | null>(null);
  const [graphPreviewId, setGraphPreviewId] = useState<string | null>(null);
  const draggedTab = useRef<string | null>(null);
  const [dropTab, setDropTab] = useState<{ paneId: string; before: string | null } | null>(null);
  const [dropPane, setDropPane] = useState<string | null>(null);
  const [recentMode, setRecentMode] = useState(false);
  const [visits, setVisits] = useState<readonly string[]>([]);
  const [compactContext, setCompactContext] = useState(false);
  const [drafts] = useState(createDraftStore);
  const workspace = useRef<WorkspaceHandle | null>(null);
  const viewId = useRef<string | null>(null);
  const bootHash = useRef(location.hash);
  const linked = useRef(false);
  const root = useRef<HTMLDivElement | null>(null);
  const graphSlot = useRef<HTMLDivElement | null>(null);
  const fit = useRef<(() => void) | null>(null);
  const [graphBox, setGraphBox] = useState({ left: 0, top: 0, width: 600, height: 500 });
  const pane = activePane(layout);
  const tab = activeTab(layout);
  const theme = themeButton(layout.theme, scheme, layout.preferences);
  const palette = effectiveScheme(layout.theme, scheme, layout.preferences);
  const graphTheme = useMemo(() => ({ theme: palette, accent: layout.preferences.accent }), [palette, layout.preferences.accent]);
  const selectedId = graphOverlay || tab.kind === "graph" ? graphSelection : tabSelection(tab);
  const graphPane = layout.panes.find((group) => group.tabs.some((entry) => entry.id === group.activeTab && entry.kind === "graph"));
  const graphVisible = graphOverlay || graphPane !== undefined && (width >= 850 || graphPane.id === layout.activePane);
  const contextVisible = width < 1050 ? compactContext : layout.contextVisible;
  const hasGraph = layout.panes.some((group) => group.tabs.some((entry) => entry.kind === "graph"));
  const live = useRef({ layout, overlay, selectedId, graphPreviewId, select: (_id: string | null) => {} });
  const previewGraphNode = (id: string | null): void => {
    live.current.graphPreviewId = id;
    setGraphPreviewId(id);
  };
  useEffect(() => { if (!graphVisible) previewGraphNode(null); }, [graphVisible]);

  const change = (next: WorkspaceLayout): void => {
    if (mayRemoveDrafts(drafts, live.current.layout, next, () => window.confirm(DISCARD_PROMPT))) setLayout(next);
  };
  const select = (id: string | null, newTab = false, paneId = layout.activePane, keepSidebar = false): void => {
    const next = (id === null ? openDocument : openWithPreferences)(layout, id, { newTab, paneId });
    change(width < 850 && !keepSidebar ? { ...next, treeVisible: false } : next);
    setCompactContext(false);
  };
  const showGraph = (): void => setLayout((current) => ({ ...openGraph(current), ...(width < 850 ? { treeVisible: false } : {}) }));
  const openGraphNode = (id: string): void => {
    previewGraphNode(null);
    if (graphOverlay) { select(id, true); setOverlay(null); return; }
    const other = layout.panes.find((group) => group.id !== graphPane?.id);
    select(id, true, other?.id ?? graphPane?.id ?? layout.activePane);
  };
  const selectGraph = (id: string | null): void => {
    setGraphSelection(id);
    if (graphClickOpensTab(live.current.graphPreviewId, id)) openGraphNode(id);
    else previewGraphNode(id);
  };
  live.current = { layout, overlay, selectedId, graphPreviewId, select };
  const mayMutate = (slugs: readonly string[]): boolean => mayMutateDrafts(drafts, slugs, () => window.confirm("Discard unsaved changes to the affected notes before changing files?"));
  const save = async (slug: string, body: string): Promise<boolean> => {
    const result = await saveNote(fetchJson, slug, body);
    if (!result.ok) { window.alert(result.message); return false; }
    setRevision((value) => value + 1); workspace.current?.refresh(); return true;
  };
  const create = async (title: string, paneId: string): Promise<boolean> => {
    const result = await createNote(fetchJson, title);
    if (!result.ok) { window.alert(result.message); return false; }
    const graph = await fetchGraph(fetchJson);
    setData((current) => ({ ...current, graph: graph.ok ? graph.data : null, graphFailed: !graph.ok }));
    drafts.open(result.data.note.slug, result.data.note.body);
    change(openDocument(live.current.layout, `note:${result.data.note.slug}`, { paneId }));
    workspace.current?.refresh();
    return true;
  };
  useEffect(() => drafts.subscribe(() => setDraftRevision((value) => value + 1)), [drafts]);
  useEffect(() => {
    workspace.current = startWorkspace({ fetch: fetchJson, state: initialWorkspaceState(), setState: setData });
    return () => workspace.current?.stop();
  }, []);
  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const response = await fetchJson("/api/workspace-state");
        const value = await response.json() as { viewId?: unknown; layout?: unknown; info?: { version: string; vaultRoot: string } };
        if (!current) return;
        if (response.ok && typeof value.viewId === "string") {
          viewId.current = value.viewId;
          if (value.info) setInfo(value.info);
          const restored = parseWorkspaceLayout(value.layout);
          if (restored) {
            setLayout(restoreWorkspace(restored));
            setVisits(restored.panes.flatMap((pane) => pane.tabs.flatMap((tab) => tab.history)).reduce<readonly string[]>(recordVisit, []));
          }
        } else setPersistError(true);
      } catch { if (current) setPersistError(true); }
      finally { if (current) setReady(true); }
    })();
    return () => { current = false; };
  }, []);
  useEffect(() => {
    if (!ready || data.graph === null || linked.current) return;
    linked.current = true;
    const id = deeplinkSelection(bootHash.current, data.graph);
    if (id !== null) setLayout((current) => openDocument(current, id));
  }, [ready, data.graph]);
  useEffect(() => { if (ready) setVisits((previous) => recordVisit(previous, selectedId)); }, [ready, selectedId]);
  useEffect(() => {
    if (!ready) return;
    history.replaceState(null, "", formatHash(selectedId));
    document.documentElement.dataset.weaveTheme = palette;
    document.documentElement.dataset.weaveScheme = THEMES[palette].scheme;
    document.documentElement.dataset.weaveAccent = layout.preferences.accent;
    saveTheme(localStorage, layout.theme);
  }, [ready, selectedId, layout.theme, palette, layout.preferences.accent]);
  const pendingSave = useRef(Promise.resolve());
  useEffect(() => {
    if (!ready || !viewId.current) return;
    const id = viewId.current;
    const timer = window.setTimeout(() => {
      pendingSave.current = pendingSave.current.then(async () => {
        try {
          const response = await fetchJson("/api/workspace-state", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ viewId: id, layout }) });
          setPersistError(!response.ok);
        } catch { setPersistError(true); }
      });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [layout, ready]);
  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), TICK_MS);
    const resize = (): void => setWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    const stopScheme = watchScheme(window, setScheme);
    const dismissMenus = (event: PointerEvent): void => {
      for (const menu of document.querySelectorAll<HTMLDetailsElement>(".weave-pane-menu[open]")) {
        if (!menu.contains(event.target as Node)) menu.open = false;
      }
    };
    document.addEventListener("pointerdown", dismissMenus);
    const unload = (event: BeforeUnloadEvent): void => {
      if (!drafts.dirtySlugs().length) return;
      event.preventDefault(); event.returnValue = "";
    };
    const persist = (): void => {
      if (viewId.current) void fetch("/api/workspace-state", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ viewId: viewId.current, layout: live.current.layout }), credentials: "same-origin", keepalive: true }).catch(() => {});
    };
    window.addEventListener("pagehide", persist);
    window.addEventListener("beforeunload", unload);
    return () => { window.clearInterval(tick); window.removeEventListener("resize", resize); window.removeEventListener("beforeunload", unload); window.removeEventListener("pagehide", persist); document.removeEventListener("pointerdown", dismissMenus); stopScheme(); };
  }, []);
  useEffect(() => watchKeys(document, {
    context: () => ({ overlay: live.current.overlay, hasSelection: live.current.selectedId !== null }),
    run: (action) => runShellAction(action, {
      setOverlay,
      fitGraph: () => fit.current?.(),
      clearSelection: () => {
        if (activeTab(live.current.layout).kind === "graph") { setGraphSelection(null); previewGraphNode(null); }
        else live.current.select(null);
      },
      closeTab: () => { const current = live.current.layout; change(closeTab(current, current.activePane, activeTab(current).id)); },
      toggleTheme: () => setLayout((current) => ({ ...current, theme: toggleTheme(current.theme, schemeOf(window), current.preferences) })),
      focusSelector: (selector) => {
        if (selector === COLUMN_FOCUS_SELECTORS.graph) setLayout((current) => ({ ...openGraph(current), ...(window.innerWidth < 850 ? { treeVisible: false } : {}) }));
        else if (selector === COLUMN_FOCUS_SELECTORS.tree || selector === TREE_FILTER_SELECTOR) setLayout((current) => ({ ...current, treeVisible: true }));
        else setLayout(focusDocument);
        requestAnimationFrame(() => {
          if (selector === COLUMN_FOCUS_SELECTORS.note && focusSelector(document, ".weave-pane-active .weave-note-editor")) return;
          if (!focusSelector(document, selector) && selector === COLUMN_FOCUS_SELECTORS.note) focusSelector(document, ".weave-pane-active .weave-pane-content");
        });
        return true;
      },
    }),
  }), []);
  useLayoutEffect(() => {
    for (const group of layout.panes) {
      document.getElementById(`tab-${group.activeTab}`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [layout.panes.map((group) => group.activeTab).join(","), layout.activePane, width, ready, data.graph?.stamp,
    layout.treeVisible, layout.treeWidth, layout.contextVisible, layout.contextWidth, layout.ratio, layout.split]);
  useLayoutEffect(() => {
    const slot = graphSlot.current;
    const parent = root.current;
    if (graphOverlay || !graphVisible || !slot || !parent) return;
    const measure = (): void => {
      const at = slot.getBoundingClientRect(); const base = parent.getBoundingClientRect();
      setGraphBox({ left: at.left - base.left, top: at.top - base.top, width: at.width, height: at.height });
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(slot); observer.observe(parent);
    return () => observer.disconnect();
  }, [graphOverlay, graphVisible, layout, width]);

  const rememberScroll = (tabId: string, scroll: number): void => setLayout((current) => ({ ...current,
    panes: current.panes.map((group) => ({ ...group, tabs: group.tabs.map((entry) => entry.id === tabId ? { ...entry, scroll } : entry) })),
  }));
  const tabDragOver = (paneId: string, event: DragEvent): void => {
    if (tabDropSource(layout, paneId, draggedTab.current) === null && !event.dataTransfer?.types.includes(NOTE_DRAG_TYPE)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = draggedTab.current === null ? "copy" : "move";
    setDropTab(null);
    setDropPane(paneId);
  };
  const tabDrop = (paneId: string, event: DragEvent): void => {
    const noteId = noteDropId(data.graph, event.dataTransfer?.getData(NOTE_DRAG_TYPE) ?? "");
    if (noteId !== null) { event.preventDefault(); select(noteId, true, paneId); setDropPane(null); return; }
    const id = draggedTab.current;
    if (tabDropSource(layout, paneId, id) === null) return;
    event.preventDefault();
    setLayout((value) => {
      const source = tabDropSource(value, paneId, id);
      return source === null ? value : moveTab(value, source, id!);
    });
    draggedTab.current = null;
    setDropPane(null);
    setDropTab(null);
  };
  const reorderDragOver = (pane: Pane, before: string | null, event: DragEvent): void => {
    if (!pane.tabs.some((tab) => tab.id === draggedTab.current)) return;
    event.preventDefault(); event.stopPropagation();
    event.dataTransfer!.dropEffect = "move";
    setDropPane(null); setDropTab({ paneId: pane.id, before });
  };
  const reorderDrop = (pane: Pane, event: DragEvent): void => {
    const id = draggedTab.current;
    if (id === null || !pane.tabs.some((tab) => tab.id === id)) return;
    event.preventDefault(); event.stopPropagation();
    setLayout((current) => reorderTab(current, pane.id, id, dropTab?.paneId === pane.id ? dropTab.before : null));
    draggedTab.current = null; setDropTab(null); setDropPane(null);
  };
  const renderPane = (group: Pane) => {
    const current = group.tabs.find((entry) => entry.id === group.activeTab)!;
    const isActive = group.id === layout.activePane;
    return <section key={group.id} class={`weave-pane${isActive ? " weave-pane-active" : ""}${dropPane === group.id ? " weave-pane-drop" : ""}`} data-drop-label={draggedTab.current === null ? "Open note here" : "Move tab here"} aria-label={`Workspace pane ${layout.panes.indexOf(group) + 1}`}
      onDragOver={(event) => tabDragOver(group.id, event)} onDrop={(event) => tabDrop(group.id, event)}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropPane(null); }}
      hidden={width < 850 && !isActive} onFocusCapture={() => { if (!isActive) setLayout((value) => ({ ...value, activePane: group.id })); }}
      onPointerDown={() => { if (!isActive) setLayout((value) => ({ ...value, activePane: group.id })); }}>
      <div class="weave-tabs" role="tablist" aria-label="Open documents" onDragOver={(event) => reorderDragOver(group, null, event)} onDrop={(event) => reorderDrop(group, event)}>
        {group.tabs.map((entry) => <div key={entry.id} class={`weave-tab${entry.id === current.id ? " weave-tab-active" : ""}${dropTab?.paneId === group.id && dropTab.before === entry.id ? " weave-tab-drop-before" : ""}${dropTab?.paneId === group.id && dropTab.before === null && entry === group.tabs.at(-1) ? " weave-tab-drop-after" : ""}`}
          onDragOver={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            const before = event.clientX < bounds.left + bounds.width / 2 ? entry.id : group.tabs[group.tabs.indexOf(entry) + 1]?.id ?? null;
            reorderDragOver(group, before, event);
          }} onDrop={(event) => reorderDrop(group, event)}>
          <button type="button" role="tab" title={titleOf(entry, data.graph)} id={`tab-${entry.id}`} aria-selected={entry.id === current.id} aria-controls={`panel-${group.id}`} tabIndex={entry.id === current.id ? 0 : -1}
            draggable
            onDragStart={(event) => { draggedTab.current = entry.id; event.dataTransfer!.effectAllowed = "move"; event.dataTransfer!.setData("application/x-weave-tab", entry.id); }}
            onClick={() => setLayout(activateTab(layout, group.id, entry.id))}
            onKeyDown={(event) => {
              const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
              if (offset && event.altKey && !event.ctrlKey && !event.metaKey) {
                event.preventDefault(); event.stopPropagation();
                const index = group.tabs.indexOf(entry);
                const before = offset < 0 ? group.tabs[Math.max(0, index - 1)]!.id : group.tabs[index + 2]?.id ?? null;
                setLayout(reorderTab(layout, group.id, entry.id, before));
                requestAnimationFrame(() => document.getElementById(`tab-${entry.id}`)?.focus());
                return;
              }
              if (!offset && event.key !== "Home" && event.key !== "End") return;
              event.preventDefault();
              const index = event.key === "Home" ? 0 : event.key === "End" ? group.tabs.length - 1 : (group.tabs.indexOf(entry) + offset + group.tabs.length) % group.tabs.length;
              const next = group.tabs[index]!; setLayout(activateTab(layout, group.id, next.id));
              requestAnimationFrame(() => document.getElementById(`tab-${next.id}`)?.focus());
            }}><span aria-hidden="true">{entry.kind === "graph" ? "◌" : "▤"}</span><span>{titleOf(entry, data.graph)}</span>
            {drafts.isDirty((tabSelection(entry) ?? "").slice(5)) ? <span class="weave-dirty" aria-label="Unsaved changes">●</span> : null}</button>
          <button type="button" class="weave-tab-close" aria-label={`Close ${titleOf(entry, data.graph)}`} onClick={() => change(closeTab(layout, group.id, entry.id))}>×</button>
        </div>)}
        <button type="button" class="weave-new-tab" aria-label="New tab" onClick={() => select(null, true, group.id)}>+</button>
      </div>
      <div class="weave-pane-toolbar">
        <button type="button" aria-label="Navigate back" disabled={current.kind === "graph" || current.cursor === 0} onClick={() => change(navigateTab({ ...layout, activePane: group.id }, group.id, -1))}>←</button>
        <button type="button" aria-label="Navigate forward" disabled={current.kind === "graph" || current.cursor >= current.history.length - 1} onClick={() => change(navigateTab({ ...layout, activePane: group.id }, group.id, 1))}>→</button>
        <span class="weave-breadcrumb">{titleOf(current, data.graph)}</span>
        <details class="weave-pane-menu" onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false;
          event.currentTarget.querySelector("summary")?.focus();
        }}><summary aria-label="Pane options" title="Pane options">···</summary><div onClick={(event) => { const details = event.currentTarget.closest("details"); if (details) details.open = false; }}>
          <button type="button" onClick={() => setLayout(splitPane({ ...layout, activePane: group.id }, "right"))}>{layout.panes.length > 1 ? "Arrange side by side" : "Split right"}</button>
          <button type="button" onClick={() => setLayout(splitPane({ ...layout, activePane: group.id }, "down"))}>{layout.panes.length > 1 ? "Stack panes" : "Split down"}</button>
          {layout.panes.length > 1 ? <><button type="button" onClick={() => setLayout(moveTab(layout, group.id, current.id))}>Move tab to other pane</button><button type="button" title="Move all tabs to the other pane and close this pane" onClick={() => setLayout(closePane(layout, group.id))}>Close pane</button></> : null}
        </div></details>
      </div>
      <div class="weave-pane-content" role="tabpanel" tabIndex={-1} id={`panel-${group.id}`} aria-labelledby={`tab-${current.id}`} {...(current.kind === "graph" ? { ref: graphSlot } : {})}>
        {current.kind === "document" ? <DocumentView key={`${current.id}:${current.cursor}:${tabSelection(current)}`} preferences={layout.preferences} tab={current} graph={data.graph} drafts={drafts} revision={revision} now={now}
          onSelect={(id, newTab) => select(id, newTab, group.id)} onSave={save} onScroll={(value) => rememberScroll(current.id, value)}
          onSearch={() => setOverlay("search")} onGraph={showGraph} onCreate={(title) => create(title, group.id)} /> : null}
      </div>
    </section>;
  };

  return <>
    <div class="weave-workbench" style={{ "--weave-note-size": `${layout.preferences.fontSize}px`, "--weave-reading-width": layout.preferences.readable ? "760px" : "100%" }} ref={root} onDragEnd={() => { draggedTab.current = null; setDropPane(null); setDropTab(null); }}>
      <nav class="weave-ribbon" aria-label="Workspace tools">
        <button type="button" aria-label="Toggle notes sidebar" aria-pressed={layout.treeVisible} title="Notes" onClick={() => setLayout({ ...layout, treeVisible: !layout.treeVisible })}>▤</button>
        <button type="button" aria-label="Open graph view" title="Graph view" onClick={showGraph}>◌</button>
        <button type="button" aria-label="Open graph overlay" title="Graph overlay" onClick={() => setOverlay("graph")}><svg viewBox="0 0 20 20" width={18} height={18} fill="none" stroke="currentColor" stroke-width={1.5} aria-hidden="true"><rect x="2" y="2" width="16" height="16" rx="3" /><circle cx="10" cy="10" r="4" /></svg></button>
        <button type="button" aria-label="Search notes and repository" title={searchHint(searchShortcut(looksApple(props.platform)))} onClick={() => setOverlay("search")}>
          <svg viewBox="0 0 20 20" width={16} height={16} fill="none" stroke="currentColor" stroke-width={1.7} aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></svg>
        </button>
        <span class="weave-ribbon-space" />
        <button type="button" aria-label="Toggle context sidebar" aria-pressed={contextVisible} title="Context" onClick={() => width < 1050 ? setCompactContext(!compactContext) : setLayout({ ...layout, contextVisible: !layout.contextVisible })}>☷</button>
        <button type="button" aria-label="Refresh workspace" title="Refresh workspace" onClick={() => { workspace.current?.refresh(); setRevision((value) => value + 1); }}>↻</button>
        <button type="button" aria-label={theme.hint} title={theme.hint} onClick={() => setLayout({ ...layout, theme: toggleTheme(layout.theme, scheme, layout.preferences) })}>{theme.glyph}</button>
        <button type="button" aria-label="Settings" title="Settings" onClick={() => setOverlay("settings")}>⚙</button>
      </nav>
      <div class="weave-sidebar-dock weave-notes-dock" data-open={layout.treeVisible} inert={!layout.treeVisible} aria-hidden={!layout.treeVisible} style={{ "--weave-sidebar-width": `${Math.min(layout.treeWidth, width - 90)}px` }}><aside class="weave-sidebar weave-sidebar-notes" aria-label="Notes sidebar">
        <div class="weave-sidebar-heading"><button type="button" aria-pressed={!recentMode} onClick={() => setRecentMode(false)}>Files</button><button type="button" aria-pressed={recentMode} onClick={() => setRecentMode(true)}>Recent</button><button type="button" aria-label="Hide notes sidebar" onClick={() => { root.current?.querySelector<HTMLButtonElement>('[aria-label="Toggle notes sidebar"]')?.focus(); setLayout({ ...layout, treeVisible: false }); }}>«</button></div>
        {recentMode ? <RecentList visits={visits} graph={data.graph} selectedId={selectedId} onSelect={select} /> : <Tree graph={data.graph} selectedId={selectedId} recentIds={data.recentIds} onSelect={(id, newTab, keepSidebar) => select(id, newTab, layout.activePane, keepSidebar)} onMutate={mayMutate} onRefresh={() => workspace.current?.refresh()} now={now} />}
        <div class="weave-vault-label"><span>Workspace</span><strong title={props.cwd}>{props.cwd.split(/[\\/]/).filter(Boolean).pop() ?? "Weave"}</strong></div>
      </aside><ResizeHandle label="Resize notes sidebar" min={180} max={420} value={layout.treeWidth} onChange={(delta) => setLayout((value) => ({ ...value, treeWidth: Math.max(180, Math.min(420, value.treeWidth + delta)) }))} /></div>
      <main class={`weave-panes weave-split-${layout.split}`} style={layout.panes.length === 2 && width >= 850 ? { [layout.split === "right" ? "gridTemplateColumns" : "gridTemplateRows"]: `minmax(0, ${layout.ratio}fr) 4px minmax(0, ${1 - layout.ratio}fr)` } : {}}>
        {!ready ? <div class="weave-welcome" role="status">Opening workspace…</div> : layout.panes.map((group, index) => <>{index > 0 && width >= 850 ? <ResizeHandle label="Resize split panes" min={20} max={80} horizontal={layout.split === "down"} value={layout.ratio * 100} onChange={(delta) => {
          const extent = layout.split === "right" ? root.current?.querySelector("main")?.clientWidth : root.current?.querySelector("main")?.clientHeight;
          setLayout((value) => ({ ...value, ratio: Math.max(.2, Math.min(.8, value.ratio + delta / (extent ?? 800))) }));
        }} /> : null}{renderPane(group)}</>)}
      </main>
      <div class="weave-sidebar-dock weave-context-dock" data-open={contextVisible} inert={!contextVisible} aria-hidden={!contextVisible} style={{ "--weave-sidebar-width": `${layout.contextWidth}px` }}><ResizeHandle label="Resize context sidebar" min={180} max={400} value={layout.contextWidth} onChange={(delta) => setLayout((value) => ({ ...value, contextWidth: Math.max(180, Math.min(400, value.contextWidth - delta)) }))} /><aside class="weave-sidebar weave-sidebar-context" aria-label="Context sidebar"><div class="weave-sidebar-heading"><strong>Context</strong><button type="button" aria-label="Hide context sidebar" onClick={() => { root.current?.querySelector<HTMLButtonElement>('[aria-label="Toggle context sidebar"]')?.focus(); setCompactContext(false); setLayout({ ...layout, contextVisible: false }); }}>»</button></div><ContextRail graph={data.graph} selectedId={selectedId} onSelect={select} /></aside></div>
      {hasGraph || graphOverlay ? <div class={graphOverlay ? "weave-scrim weave-graph-scrim" : "weave-graph-host"}
        onClick={() => { if (graphOverlay) setOverlay(null); }}
        onDragOver={(event) => { if (!graphOverlay && graphPane) tabDragOver(graphPane.id, event); }} onDrop={(event) => { if (!graphOverlay && graphPane) tabDrop(graphPane.id, event); }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropPane(null); }}
        onPointerDown={() => { if (!graphOverlay && graphPane) setLayout((current) => ({ ...current, activePane: graphPane.id })); }}
        onFocusCapture={() => { if (!graphOverlay && graphPane) setLayout((current) => ({ ...current, activePane: graphPane.id })); }}
        aria-hidden={!graphVisible} style={graphOverlay ? {} : { ...graphBox, visibility: graphVisible ? "visible" : "hidden", pointerEvents: graphVisible ? "auto" : "none" }}>
        <div class="weave-graph-surface" role={graphOverlay ? "dialog" : undefined} aria-modal={graphOverlay ? "true" : undefined} aria-label={graphOverlay ? "Graph overlay" : undefined}
          tabIndex={-1} ref={graphTrap.ref as { current: HTMLDivElement | null }} onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => { if (graphOverlay) graphTrap.onKeyDown(event); }}>
          <div class="weave-graph-overlay-heading" hidden={!graphOverlay}><h2>Knowledge graph</h2><button type="button" aria-label="Close graph overlay" onClick={() => setOverlay(null)}>×</button></div>
          <Graph graph={data.graph} selectedId={selectedId} previewId={graphPreviewId} onSelect={selectGraph} onOpen={openGraphNode} renderer={createSigmaRenderer} storage={localStorage} host={window} scheme={graphTheme} forces={layout.preferences.forces} groupColors={layout.preferences.groupColors} bootFailed={data.graphFailed} fit={fit} />
        </div>
      </div> : null}
    </div>
    <div class="weave-footer"><StatusBar model={statusBarModel(props.cwd, selectedId)} />
      {persistError ? <span role="status">Workspace restoration unavailable</span> : null}
      {drafts.dirtySlugs().length ? <span>{drafts.dirtySlugs().length} unsaved</span> : null}
      {width < 850 && layout.panes.length > 1 ? <button type="button" onClick={() => setLayout({ ...layout, activePane: layout.panes.find((group) => group.id !== pane.id)!.id })}>Switch pane</button> : null}
    </div>
    {overlay === "search" ? <SearchPalette graph={data.graph} onSelect={select} onClose={() => setOverlay(null)} ports={{ fetch: fetchJson }} /> : null}
    {overlay === "settings" ? <Settings compact={width <= 650} layout={layout} info={info} cwd={props.cwd} shortcut={searchShortcut(looksApple(props.platform))} onChange={(next) => { change(next); setCompactContext(next.contextVisible); }} onRefresh={() => { workspace.current?.refresh(); setRevision((value) => value + 1); }} onClose={() => setOverlay(null)} /> : null}
    {overlay === "help" ? <HelpOverlay shortcut={searchShortcut(looksApple(props.platform))} onClose={() => setOverlay(null)} /> : null}
  </>;
}
