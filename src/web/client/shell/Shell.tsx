/**
 * The workspace shell.
 *
 * Header, resizable columns, context rail, status bar. This component holds
 * the wiring and nothing else — every value it renders comes from pure
 * functions in the shell models,
 * and the fetch/poll loop is `workspace.ts`. What is left here is hooks:
 * state in, callbacks out.
 *
 * The main effects are one-liners over injected units:
 *
 *  1. **mount** — `startWorkspace` fetches the graph and starts polling;
 *     the returned `stop` is the cleanup, so a hot reload cannot leak a timer.
 *  2. **keys** — `watchKeys` attaches the one global `keydown` listener
 *     (§11 P4). Its context is read through `live`, because a listener
 *     registered at mount outlives every render and a captured overlay flag
 *     would let `⌘K` stack a palette on top of itself.
 */

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { fetchJson } from "../api.dom";
import { openNote } from "../api";
import type { ColorScheme } from "../graph/graph.model";
import { schemeOf, watchScheme } from "../graph/scheme";
import { createSigmaRenderer } from "../graph/renderer.dom";
import { SearchPalette } from "../search/SearchPalette";
import { restoreSelection, saveSelection } from "../selection.storage";
import { initialWorkspaceState } from "../state";
import type { WorkspaceState } from "../state";
import type { WorkspaceHandle } from "../workspace";
import { startWorkspace } from "../workspace";
import { Columns } from "./Columns";
import { deeplinkSelection, formatHash } from "./deeplink.model";
import { dividerHandlers } from "./drag.model";
import { Header } from "./Header";
import { HelpOverlay } from "./HelpOverlay";
import { watchKeys } from "./keys";
import { focusSelector, runShellAction } from "./keys.model";
import { StatusBar } from "./StatusBar";
import type { LayoutState } from "./layout.model";
import { breakpointFor, loadLayout, resolveColumns, saveLayout } from "./layout.model";
import type { OverlayId } from "./shell.model";
import { TICK_MS, looksApple, searchShortcut, statusBarModel, summarize } from "./shell.model";
import { cycleTheme, effectiveScheme, loadTheme, saveTheme, themeAttr, themeButton } from "./theme.model";
import type { ThemeChoice } from "./theme.model";

/**
 * Write the choice onto `<html>`, so the sheet's attribute branch and the
 * media query agree on who is in charge (see `theme.model.ts`'s header).
 */
function applyThemeAttr(choice: ReturnType<typeof themeAttr>): void {
  if (choice === null) delete document.documentElement.dataset.weaveTheme;
  else document.documentElement.dataset.weaveTheme = choice;
}

export interface ShellProps {
  /** From the page bootstrap. Shown in the status bar. */
  cwd: string;
  /** `window.innerWidth` at mount, used for the first breakpoint/layout. */
  initialWidth: number;
  /** `navigator.platform`, for the `⌘K` vs `Ctrl K` hint. */
  platform: string;
}

export function Shell(props: ShellProps) {
  const [workspaceState, setWorkspaceState] = useState<WorkspaceState>(initialWorkspaceState);
  const [overlay, setOverlay] = useState<OverlayId>(null);
  const [width, setWidth] = useState(props.initialWidth);
  const [layout, setLayout] = useState<LayoutState>(() => loadLayout(localStorage, props.initialWidth));
  // The theme: what the user picked, and what the OS is currently saying. Two
  // states because they answer different questions — `theme` changes on a
  // button press or the `t` key, `systemScheme` on an OS flip while the user
  // is in system mode — and `effectiveScheme` is where the two resolve.
  const [theme, setTheme] = useState<ThemeChoice>(() => loadTheme(localStorage) ?? "system");
  const [systemScheme, setSystemScheme] = useState<ColorScheme>(() => schemeOf(window));
  const workspace = useRef<WorkspaceHandle | null>(null);
  // Filled by the graph column at mount, cleared on unmount. The global `g`
  // key's only route to the renderer — see `Graph.tsx`'s `fit` prop.
  const fit = useRef<(() => void) | null>(null);
  // The global key listener reads through this so a handler registered at
  // mount still sees the current overlay.
  const live = useRef({ overlay, selectedId: workspaceState.selectedId, layout, width });
  live.current = { overlay, selectedId: workspaceState.selectedId, layout, width };

  useEffect(() => {
    const handle = startWorkspace({ fetch: fetchJson, state: workspaceState, setState: setWorkspaceState });
    workspace.current = handle;
    return () => handle.stop();
  }, []);

  useEffect(() => {
    const onResize = (): void => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // §1.3 continuity: a reload keeps the note you were reading. Saving is
  // gated on the restore decision so the mount-time `null` cannot wipe the
  // saved id before the first graph arrives to validate it against.
  const selectionRestored = useRef(false);
  // The deep link is read once, at mount, into a ref — the URL is an input
  // to boot only, and the hash-write effect below must never clear a link
  // this effect has not read yet.
  const bootHash = useRef(location.hash);
  useEffect(() => {
    if (!selectionRestored.current) return;
    saveSelection(localStorage, workspaceState.selectedId);
    // replaceState, not pushState: the address bar mirrors the note on
    // screen, and reading three notes is not three history entries. The
    // *string* is the model's (`formatHash`); this is the write itself.
    history.replaceState(null, "", formatHash(workspaceState.selectedId));
  }, [workspaceState.selectedId]);
  useEffect(() => {
    if (selectionRestored.current || workspaceState.graph === null) return;
    selectionRestored.current = true;
    if (workspaceState.selectedId !== null) return;
    // A link wins over storage: the address bar is an explicit instruction,
    // the saved note is a habit. A link to a note the graph does not hold is
    // refused (see `deeplink.model.ts`) and continuity falls through.
    const linked = deeplinkSelection(bootHash.current, workspaceState.graph);
    if (linked !== null) void workspace.current?.select(linked);
    else {
      const saved = restoreSelection(workspaceState.graph, localStorage);
      if (saved !== null) void workspace.current?.select(saved);
    }
  }, [workspaceState.graph]);

  // The relative-time clock. Every "8h ago" in the tree and the note meta is
  // computed from a `now` stamped per render, and a resting workspace never
  // re-renders on its own — so the minutes used to go stale until the next
  // poll. One interval at `TICK_MS` (the reasoning is in `shell.model.ts`);
  // `setNow` with a new value re-renders, and a re-render is all the copy
  // needs to catch up.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(tick);
  }, []);

  // The theme's two effects: the attribute decides what the sheet paints, the
  // save decides what a reload restores. Both keyed on the choice alone — a
  // system-scheme flip touches neither, because the media query repaints the
  // stylesheet by itself and the shell only re-resolves the graph's scheme.
  useEffect(() => applyThemeAttr(themeAttr(theme)), [theme]);
  useEffect(() => void saveTheme(localStorage, theme), [theme]);
  // Live OS flips, needed only in system mode but harmless always: the
  // stylesheet follows the OS on its own; this is what lets the *graph* (and
  // the header button, which shows the resolved scheme nowhere — it shows the
  // choice) keep up while the choice is "system".
  useEffect(() => watchScheme(window, setSystemScheme), []);

  useEffect(
    () =>
      watchKeys(document, {
        context: () => ({ overlay: live.current.overlay, hasSelection: live.current.selectedId !== null }),
        run: (action) =>
          runShellAction(action, {
            setOverlay,
            focusSelector: (selector) => focusSelector(document, selector),
            fitGraph: () => fit.current?.(),
            clearSelection: () => { void workspace.current?.select(null); },
            cycleTheme: () => setTheme((current) => cycleTheme(current)),
          }),
      }),
    [],
  );

  const resolved = useMemo(() => resolveColumns(layout, width, breakpointFor(width)), [layout, width]);
  const drag = useMemo(() => dividerHandlers({
    layout: () => live.current.layout,
    width: () => live.current.width,
    setLayout,
    persist: (next) => void saveLayout(localStorage, next),
  }), []);

  return (
    <>
      <Header
        summary={summarize(workspaceState.graph)}
        shortcut={searchShortcut(looksApple(props.platform))}
        onRefresh={() => workspace.current?.refresh()}
        onSearch={() => setOverlay("search")}
        theme={themeButton(theme)}
        onTheme={() => setTheme((current) => cycleTheme(current))}
      />
      <Columns
        resolved={resolved}
        onDown={drag.onDown}
        onMove={drag.onMove}
        onUp={drag.onUp}
        onKey={drag.onKey}
        scheme={effectiveScheme(theme, systemScheme)}
        bootFailed={workspaceState.graphFailed}
        graph={workspaceState.graph}
        note={workspaceState.note}
        selectedId={workspaceState.selectedId}
        recentIds={workspaceState.recentIds}
        onSelect={(id) => void workspace.current?.select(id)}
        onOpen={(slug) => void openNote(fetchJson, slug)}
        now={now}
        // The graph column's three ports (§7.5, §10). Supplied here, at the
        // one place that is already allowed to name browser globals, so
        // `Graph.tsx` and everything under it takes its world as parameters.
        renderer={createSigmaRenderer}
        storage={localStorage}
        host={window}
        fit={fit}
      />
      {/*
        `model.generatedAt`, not `stamp`. The two used to be the same string;
        since §15.6 `stamp` is the ETag's content digest and would render as
        `a3f9c2…` under a label that
        says "data as of". `generatedAt` kept the data-as-of job, which is
        exactly what this bar wants.
      */}
      <StatusBar
        model={statusBarModel(props.cwd, workspaceState.selectedId, workspaceState.graph?.model.generatedAt ?? null)}
      />
      {overlay === "search" ? (
        <SearchPalette
          graph={workspaceState.graph}
          onSelect={(id) => void workspace.current?.select(id)}
          onClose={() => setOverlay(null)}
          ports={{ fetch: fetchJson }}
        />
      ) : null}
      {overlay === "help" ? (
        <HelpOverlay shortcut={searchShortcut(looksApple(props.platform))} onClose={() => setOverlay(null)} />
      ) : null}
    </>
  );
}
