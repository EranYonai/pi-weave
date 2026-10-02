/** Shared browser/desktop workspace: one data source, two optional tab groups. */
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { GraphPayload, NotePayload } from "../../shared/wire";
import { activePane, activeTab, activateTab, closePane, closeTab, initialLayout, moveTab, navigateTab, openDocument, openGraph, parseWorkspaceLayout, splitPane, tabSelection } from "../../shared/workspace";
import type { Pane, WorkspaceLayout, WorkspaceTab } from "../../shared/workspace";
import { fetchJson } from "../api.dom";
import { openNote, saveNote } from "../api";
import { Graph } from "../graph/Graph";
import { schemeOf, watchScheme } from "../graph/scheme";
import { createSigmaRenderer } from "../graph/renderer.dom";
import { Note } from "../note/Note";
import { createDraftStore, mayRemoveDrafts } from "../note/drafts";
import type { DraftStore } from "../note/drafts";
import { DISCARD_PROMPT } from "../note/note.model";
import { SearchPalette } from "../search/SearchPalette";
import { Tree } from "../tree/Tree";
import { initialWorkspaceState } from "../state";
import { startWorkspace, watchNote } from "../workspace";
import type { WorkspaceHandle } from "../workspace";
import { ContextRail } from "./ContextRail";
import { deeplinkSelection, formatHash } from "./deeplink.model";
import { Header } from "./Header";
import { HelpOverlay } from "./HelpOverlay";
import { watchKeys } from "./keys";
import { COLUMN_FOCUS_SELECTORS, TREE_FILTER_SELECTOR, focusSelector, runShellAction } from "./keys.model";
import { StatusBar } from "./StatusBar";
import type { OverlayId } from "./shell.model";
import { TICK_MS, looksApple, searchShortcut, statusBarModel, summarize } from "./shell.model";
import { cycleTheme, effectiveScheme, loadTheme, saveTheme, themeAttr, themeButton } from "./theme.model";

export interface ShellProps { cwd: string; initialWidth: number; platform: string; tuner?: boolean }

function titleOf(tab: WorkspaceTab, graph: GraphPayload | null): string {
  if (tab.kind === "graph") return "Graph view";
  const id = tabSelection(tab);
  return id === null ? "New tab" : graph?.model.nodes.find((node) => node.id === id)?.label ?? id.replace(/^[^:]+:/, "");
}

/** A tab view can unmount; the shared draft store outlives it. */
function DocumentView(props: {
  tab: WorkspaceTab; graph: GraphPayload | null; drafts: DraftStore; revision: number;
  onSelect: (id: string, newTab?: boolean) => void; onSave: (slug: string, body: string) => Promise<boolean>;
  now: number; onScroll: (value: number) => void; onSearch: () => void; onGraph: () => void;
}) {
  const id = tabSelection(props.tab);
  const slug = id?.startsWith("note:") ? id.slice(5) : null;
  const [loaded, setLoaded] = useState<{ slug: string; note: NotePayload | null; failed: boolean } | null>(null);
  const element = useRef<HTMLDivElement | null>(null);
  const savedScroll = useRef(props.tab.scroll);
  useEffect(() => {
    if (slug === null) return;
    return watchNote(fetchJson, slug, (result) => {
      setLoaded({ slug, note: result.ok ? result.data : null, failed: !result.ok });
    });
  }, [slug, props.graph?.stamp, props.revision]);
  const payload = loaded?.slug === slug ? loaded : null;
  useLayoutEffect(() => {
    const note = element.current?.querySelector<HTMLElement>(".weave-note");
    if (note !== null && note !== undefined) note.scrollTop = savedScroll.current;
  }, [id, payload?.note?.note.slug]);
  if (id === null) return <div class="weave-welcome">
    <span class="weave-welcome-mark" aria-hidden="true">✳</span><h1>Your knowledge, connected.</h1>
    <p>Open a note from the sidebar, find something you remember, or follow a connection.</p>
    <div><button type="button" onClick={props.onSearch}>Search workspace <kbd>⌘K</kbd></button><button type="button" onClick={props.onGraph}>Explore graph</button></div>
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
  }}><Note note={payload?.note ?? null} loadFailed={payload?.failed ?? false} graph={props.graph} selectedId={id}
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
  const [now, setNow] = useState(Date.now);
  const [width, setWidth] = useState(props.initialWidth);
  const [scheme, setScheme] = useState(() => schemeOf(window));
  const [ready, setReady] = useState(false);
  const [persistError, setPersistError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [, setDraftRevision] = useState(0);
  const [graphSelection, setGraphSelection] = useState<string | null>(null);
  const [recentMode, setRecentMode] = useState(false);
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
  const selectedId = tab.kind === "graph" ? graphSelection : tabSelection(tab);
  const graphPane = layout.panes.find((group) => group.tabs.some((entry) => entry.id === group.activeTab && entry.kind === "graph"));
  const graphVisible = graphPane !== undefined && (width >= 850 || graphPane.id === layout.activePane);
  const hasGraph = layout.panes.some((group) => group.tabs.some((entry) => entry.kind === "graph"));
  const live = useRef({ layout, overlay, selectedId, select: (_id: string | null) => {} });

  const change = (next: WorkspaceLayout): void => {
    if (mayRemoveDrafts(drafts, layout, next, () => window.confirm(DISCARD_PROMPT))) setLayout(next);
  };
  const select = (id: string | null, newTab = false, paneId = layout.activePane): void => {
    const next = openDocument(layout, id, { newTab, paneId });
    change(width < 850 ? { ...next, treeVisible: false } : next);
    setCompactContext(false);
  };
  const showGraph = (): void => setLayout((current) => ({ ...openGraph(current), ...(width < 850 ? { treeVisible: false } : {}) }));
  const selectGraph = (id: string | null): void => {
    setGraphSelection(id);
    if (id === null) return;
    const other = layout.panes.find((group) => group.id !== graphPane?.id);
    select(id, false, other?.id ?? graphPane?.id ?? layout.activePane);
  };
  live.current = { layout, overlay, selectedId, select };
  const mayMutate = (): boolean => {
    const dirty = drafts.dirtySlugs();
    if (dirty.length && !window.confirm(`Discard all ${dirty.length} unsaved note draft${dirty.length === 1 ? "" : "s"} before changing files?`)) return false;
    dirty.forEach((slug) => drafts.discard(slug));
    return true;
  };
  const save = async (slug: string, body: string): Promise<boolean> => {
    const result = await saveNote(fetchJson, slug, body);
    if (!result.ok) { window.alert(result.message); return false; }
    setRevision((value) => value + 1); workspace.current?.refresh(); return true;
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
        const value = await response.json() as { viewId?: unknown; layout?: unknown };
        if (!current) return;
        if (response.ok && typeof value.viewId === "string") {
          viewId.current = value.viewId;
          const restored = parseWorkspaceLayout(value.layout);
          if (restored) setLayout(restored);
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
  useEffect(() => {
    if (!ready) return;
    history.replaceState(null, "", formatHash(selectedId));
    const attr = themeAttr(layout.theme);
    if (attr === null) delete document.documentElement.dataset.weaveTheme;
    else document.documentElement.dataset.weaveTheme = attr;
    saveTheme(localStorage, layout.theme);
  }, [ready, selectedId, layout.theme]);
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
    const unload = (event: BeforeUnloadEvent): void => {
      if (!drafts.dirtySlugs().length) return;
      event.preventDefault(); event.returnValue = "";
    };
    const persist = (): void => {
      if (viewId.current) void fetch("/api/workspace-state", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ viewId: viewId.current, layout: live.current.layout }), credentials: "same-origin", keepalive: true }).catch(() => {});
    };
    window.addEventListener("pagehide", persist);
    window.addEventListener("beforeunload", unload);
    return () => { window.clearInterval(tick); window.removeEventListener("resize", resize); window.removeEventListener("beforeunload", unload); window.removeEventListener("pagehide", persist); stopScheme(); };
  }, []);
  useEffect(() => watchKeys(document, {
    context: () => ({ overlay: live.current.overlay, hasSelection: live.current.selectedId !== null }),
    run: (action) => runShellAction(action, {
      setOverlay,
      fitGraph: () => fit.current?.(),
      clearSelection: () => activeTab(live.current.layout).kind === "graph" ? setGraphSelection(null) : live.current.select(null),
      cycleTheme: () => setLayout((current) => ({ ...current, theme: cycleTheme(current.theme) })),
      focusSelector: (selector) => {
        if (selector === COLUMN_FOCUS_SELECTORS.graph) setLayout((current) => ({ ...openGraph(current), ...(window.innerWidth < 850 ? { treeVisible: false } : {}) }));
        else if (selector === COLUMN_FOCUS_SELECTORS.tree || selector === TREE_FILTER_SELECTOR) setLayout((current) => ({ ...current, treeVisible: true }));
        else setLayout((current) => {
          const group = activePane(current);
          const noteTab = [...group.tabs].reverse().find((entry) => entry.kind === "document");
          return noteTab ? activateTab(current, group.id, noteTab.id) : openDocument(current, null);
        });
        requestAnimationFrame(() => focusSelector(document, selector));
        return true;
      },
    }),
  }), []);
  useLayoutEffect(() => {
    const slot = graphSlot.current;
    const parent = root.current;
    if (!graphVisible || !slot || !parent) return;
    const measure = (): void => {
      const at = slot.getBoundingClientRect(); const base = parent.getBoundingClientRect();
      setGraphBox({ left: at.left - base.left, top: at.top - base.top, width: at.width, height: at.height });
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(slot); observer.observe(parent);
    return () => observer.disconnect();
  }, [graphVisible, layout, width]);

  const rememberScroll = (tabId: string, scroll: number): void => setLayout((current) => ({ ...current,
    panes: current.panes.map((group) => ({ ...group, tabs: group.tabs.map((entry) => entry.id === tabId ? { ...entry, scroll } : entry) })),
  }));
  const renderPane = (group: Pane) => {
    const current = group.tabs.find((entry) => entry.id === group.activeTab)!;
    const isActive = group.id === layout.activePane;
    return <section key={group.id} class={`weave-pane${isActive ? " weave-pane-active" : ""}`} aria-label={`Workspace pane ${layout.panes.indexOf(group) + 1}`}
      hidden={width < 850 && !isActive} onFocusCapture={() => { if (!isActive) setLayout((value) => ({ ...value, activePane: group.id })); }}
      onPointerDown={() => { if (!isActive) setLayout((value) => ({ ...value, activePane: group.id })); }}>
      <div class="weave-tabs" role="tablist" aria-label="Open documents">
        {group.tabs.map((entry) => <div key={entry.id} class={`weave-tab${entry.id === current.id ? " weave-tab-active" : ""}`}>
          <button type="button" role="tab" id={`tab-${entry.id}`} aria-selected={entry.id === current.id} aria-controls={`panel-${group.id}`} tabIndex={entry.id === current.id ? 0 : -1}
            onClick={() => setLayout(activateTab(layout, group.id, entry.id))}
            onKeyDown={(event) => {
              const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
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
        <details class="weave-pane-menu"><summary aria-label="Pane options">···</summary><div onClick={(event) => { const details = event.currentTarget.closest("details"); if (details) details.open = false; }}>
          <button type="button" onClick={() => setLayout(splitPane({ ...layout, activePane: group.id }, "right"))}>Split right</button>
          <button type="button" onClick={() => setLayout(splitPane({ ...layout, activePane: group.id }, "down"))}>Split down</button>
          {layout.panes.length > 1 ? <><button type="button" onClick={() => setLayout(moveTab(layout, group.id, current.id))}>Move tab to other pane</button><button type="button" onClick={() => setLayout(closePane(layout, group.id))}>Close pane</button></> : null}
        </div></details>
      </div>
      <div class="weave-pane-content" role="tabpanel" id={`panel-${group.id}`} aria-labelledby={`tab-${current.id}`} {...(current.kind === "graph" ? { ref: graphSlot } : {})}>
        {current.kind === "document" ? <DocumentView key={`${current.id}:${current.cursor}:${tabSelection(current)}`} tab={current} graph={data.graph} drafts={drafts} revision={revision} now={now}
          onSelect={(id, newTab) => select(id, newTab, group.id)} onSave={save} onScroll={(value) => rememberScroll(current.id, value)}
          onSearch={() => setOverlay("search")} onGraph={showGraph} /> : null}
      </div>
    </section>;
  };

  return <>
    <Header summary={summarize(data.graph)} shortcut={searchShortcut(looksApple(props.platform))} onRefresh={() => { workspace.current?.refresh(); setRevision((value) => value + 1); }} onSearch={() => setOverlay("search")}
      theme={themeButton(layout.theme)} onTheme={() => setLayout({ ...layout, theme: cycleTheme(layout.theme) })} />
    <div class="weave-workbench" ref={root}>
      <nav class="weave-ribbon" aria-label="Workspace tools">
        <button type="button" aria-label="Toggle notes sidebar" aria-pressed={layout.treeVisible} title="Notes" onClick={() => setLayout({ ...layout, treeVisible: !layout.treeVisible })}>▤</button>
        <button type="button" aria-label="Open graph view" title="Graph view" onClick={showGraph}>◌</button>
        <button type="button" aria-label="Search workspace" title="Search" onClick={() => setOverlay("search")}>⌕</button>
        <span class="weave-ribbon-space" />
        <button type="button" aria-label="Toggle context sidebar" aria-pressed={width < 1050 ? compactContext : layout.contextVisible} title="Context" onClick={() => width < 1050 ? setCompactContext(!compactContext) : setLayout({ ...layout, contextVisible: !layout.contextVisible })}>☷</button>
        <button type="button" aria-label="Keyboard shortcuts" onClick={() => setOverlay("help")}>?</button>
      </nav>
      {layout.treeVisible ? <><aside class="weave-sidebar weave-sidebar-notes" aria-label="Notes sidebar" style={{ width: Math.min(layout.treeWidth, width - 90) }}>
        <div class="weave-sidebar-heading"><button type="button" aria-pressed={!recentMode} onClick={() => setRecentMode(false)}>Files</button><button type="button" aria-pressed={recentMode} onClick={() => setRecentMode(true)}>Recent</button><button type="button" aria-label="Hide notes sidebar" onClick={() => setLayout({ ...layout, treeVisible: false })}>«</button></div>
        {recentMode ? <div class="weave-recents">{[...new Set(layout.panes.flatMap((group) => group.tabs.flatMap((entry) => entry.history)).filter((id): id is string => id !== null))].reverse().map((id) => <button type="button" key={id} onClick={(event) => select(id, event.metaKey || event.ctrlKey)}>{data.graph?.model.nodes.find((node) => node.id === id)?.label ?? id}</button>)}</div> : <Tree graph={data.graph} selectedId={selectedId} recentIds={data.recentIds} onSelect={select} onMutate={mayMutate} onRefresh={() => workspace.current?.refresh()} now={now} />}
        <div class="weave-vault-label"><span>Workspace</span><strong title={props.cwd}>{props.cwd.split(/[\\/]/).filter(Boolean).pop() ?? "Weave"}</strong></div>
      </aside><ResizeHandle label="Resize notes sidebar" min={180} max={420} value={layout.treeWidth} onChange={(delta) => setLayout((value) => ({ ...value, treeWidth: Math.max(180, Math.min(420, value.treeWidth + delta)) }))} /></> : null}
      <main class={`weave-panes weave-split-${layout.split}`} style={layout.panes.length === 2 && width >= 850 ? { [layout.split === "right" ? "gridTemplateColumns" : "gridTemplateRows"]: `minmax(0, ${layout.ratio}fr) 4px minmax(0, ${1 - layout.ratio}fr)` } : {}}>
        {!ready ? <div class="weave-welcome" role="status">Opening workspace…</div> : layout.panes.map((group, index) => <>{index > 0 && width >= 850 ? <ResizeHandle label="Resize split panes" min={20} max={80} horizontal={layout.split === "down"} value={layout.ratio * 100} onChange={(delta) => {
          const extent = layout.split === "right" ? root.current?.querySelector("main")?.clientWidth : root.current?.querySelector("main")?.clientHeight;
          setLayout((value) => ({ ...value, ratio: Math.max(.2, Math.min(.8, value.ratio + delta / (extent ?? 800))) }));
        }} /> : null}{renderPane(group)}</>)}
      </main>
      {(width < 1050 ? compactContext : layout.contextVisible) ? <><ResizeHandle label="Resize context sidebar" min={180} max={400} value={layout.contextWidth} onChange={(delta) => setLayout((value) => ({ ...value, contextWidth: Math.max(180, Math.min(400, value.contextWidth - delta)) }))} /><aside class="weave-sidebar weave-sidebar-context" style={{ width: layout.contextWidth }} aria-label="Context sidebar"><div class="weave-sidebar-heading"><strong>Context</strong><button type="button" aria-label="Hide context sidebar" onClick={() => { setCompactContext(false); setLayout({ ...layout, contextVisible: false }); }}>»</button></div><ContextRail graph={data.graph} selectedId={selectedId} onSelect={select} /></aside></> : null}
      {hasGraph ? <div class="weave-graph-host" onPointerDown={() => { if (graphPane) setLayout((current) => ({ ...current, activePane: graphPane.id })); }} onFocusCapture={() => { if (graphPane) setLayout((current) => ({ ...current, activePane: graphPane.id })); }} aria-hidden={!graphVisible} style={{ ...graphBox, visibility: graphVisible ? "visible" : "hidden", pointerEvents: graphVisible ? "auto" : "none" }}>
        <Graph graph={data.graph} selectedId={selectedId} onSelect={selectGraph} renderer={createSigmaRenderer} storage={localStorage} host={window} scheme={effectiveScheme(layout.theme, scheme)} bootFailed={data.graphFailed} fit={fit} tuner={props.tuner === true} />
      </div> : null}
    </div>
    <div class="weave-footer"><StatusBar model={statusBarModel(props.cwd, selectedId, data.graph?.model.generatedAt ?? null)} />
      {persistError ? <span role="status">Workspace restoration unavailable</span> : null}
      {drafts.dirtySlugs().length ? <span>{drafts.dirtySlugs().length} unsaved</span> : null}
      {width < 850 && layout.panes.length > 1 ? <button type="button" onClick={() => setLayout({ ...layout, activePane: layout.panes.find((group) => group.id !== pane.id)!.id })}>Switch pane</button> : null}
    </div>
    {overlay === "search" ? <SearchPalette graph={data.graph} onSelect={select} onClose={() => setOverlay(null)} ports={{ fetch: fetchJson }} /> : null}
    {overlay === "help" ? <HelpOverlay shortcut={searchShortcut(looksApple(props.platform))} onClose={() => setOverlay(null)} /> : null}
  </>;
}
