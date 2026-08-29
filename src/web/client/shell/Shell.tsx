/**
 * The workspace shell (weave-workspace §1.2).
 *
 * Header, three resizable columns, context rail, status bar. This component
 * holds the wiring and nothing else — every value it renders comes from a
 * pure function in `shell.model.ts`, `layout.model.ts` or `drag.model.ts`,
 * and the fetch/SSE loop is `workspace.ts`. What is left here is hooks:
 * signals in, callbacks out.
 *
 * The three effects, all one-liners over injected units:
 *
 *  1. **mount** — `startWorkspace` fetches the graph and opens the stream;
 *     the returned `stop` is the cleanup, so a hot reload cannot leak a
 *     socket.
 *  2. **resize** — `watchViewport` keeps `width` current, because the width
 *     picks the breakpoint, which decides how many columns exist.
 *  3. **keys** — `watchKeys` attaches the one global `keydown` listener
 *     (§11 P4). Its context is read through `live`, because a listener
 *     registered at mount outlives every render and a captured overlay flag
 *     would let `⌘K` stack a palette on top of itself.
 *
 * Layout persistence is not an effect: `dividerHandlers` writes to
 * `localStorage` on release and on a keyboard nudge, never per frame.
 */

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { fetchJson } from "../api.dom";
import type { ColorScheme } from "../graph/graph.model";
import { schemeOf, watchScheme } from "../graph/scheme";
import { createSigmaRenderer } from "../graph/renderer.dom";
import { domEventSource } from "../live";
import { createEditor, watchUnload, type EditorHandle } from "../note/editor.controller";
import { editorPrompt, editorToolbar, initialEditorState, shouldBlockUnload } from "../note/editor.model";
import { SearchPalette } from "../search/SearchPalette";
import { restoreSelection, saveSelection } from "../selection.storage";
import { connection, graph, graphFailed, noteBody, selectedId } from "../state";
import type { WorkspaceHandle } from "../workspace";
import { observeNotes, select, startWorkspace } from "../workspace";
import { Columns } from "./Columns";
import { deeplinkSelection, formatHash } from "./deeplink.model";
import { dividerHandlers } from "./drag.model";
import { Header } from "./Header";
import { HelpOverlay } from "./HelpOverlay";
import { watchKeys } from "./keys";
import { focusSelector, runShellAction } from "./keys.model";
import type { LayoutState } from "./layout.model";
import { breakpointFor, loadLayout, resolveColumns, saveLayout } from "./layout.model";
import { StatusBar } from "./StatusBar";
import type { OverlayId } from "./shell.model";
import { TICK_MS, connectionView, looksApple, searchShortcut, statusBarModel, summarize } from "./shell.model";
import { cycleTheme, effectiveScheme, loadTheme, saveTheme, themeAttr, themeButton } from "./theme.model";
import type { ThemeChoice } from "./theme.model";
import { watchViewport } from "./viewport";

/**
 * Write the choice onto `<html>`, so the sheet's attribute branch and the
 * media query agree on who is in charge (see `theme.model.ts`'s header). The
 * one DOM write the theme needs, and it is here rather than in the model for
 * the same reason `applyVars` is: it is an effect, not a decision.
 */
function applyThemeAttr(choice: ReturnType<typeof themeAttr>): void {
  if (choice === null) delete document.documentElement.dataset.weaveTheme;
  else document.documentElement.dataset.weaveTheme = choice;
}

export interface ShellProps {
  /** From the page bootstrap. Shown in the status bar. */
  cwd: string;
  /** `window.innerWidth` at mount. Injected so the first render is testable. */
  initialWidth: number;
  /** `navigator.platform`, for the `⌘K` vs `Ctrl K` hint. */
  platform: string;
}

export function Shell(props: ShellProps) {
  const [width, setWidth] = useState(props.initialWidth);
  const [overlay, setOverlay] = useState<OverlayId>(null);
  const [layout, setLayout] = useState<LayoutState>(() => loadLayout(localStorage, props.initialWidth));
  const [editorState, setEditorState] = useState(initialEditorState);
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
  // The gesture and the global key listener read through these so a handler
  // built on an early render still sees current state — see `DragHost`.
  const live = useRef({ layout, width, overlay });
  live.current = { layout, width, overlay };

  // Built once and owned by the shell, not by the note column. The column is
  // unmounted by a resize below 800 px, and an editor whose lifetime was the
  // column's would lose an unsaved draft to a window drag.
  const editor: EditorHandle = useMemo(
    () => createEditor({ fetch: fetchJson, select: (id) => void select(fetchJson, id), onChange: setEditorState }),
    [],
  );

  useEffect(() => {
    const handle = startWorkspace({ fetch: fetchJson, open: domEventSource });
    workspace.current = handle;
    return () => handle.stop();
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
    saveSelection(localStorage, selectedId.value);
    // replaceState, not pushState: the address bar mirrors the note on
    // screen, and reading three notes is not three history entries. The
    // *string* is the model's (`formatHash`); this is the write itself.
    history.replaceState(null, "", formatHash(selectedId.value));
  }, [selectedId.value]);
  useEffect(() => {
    if (selectionRestored.current || graph.value === null) return;
    selectionRestored.current = true;
    if (selectedId.value !== null) return;
    // A link wins over storage: the address bar is an explicit instruction,
    // the saved note is a habit. A link to a note the graph does not hold is
    // refused (see `deeplink.model.ts`) and continuity falls through.
    const linked = deeplinkSelection(bootHash.current, graph.value);
    if (linked !== null) void select(fetchJson, linked);
    else {
      const saved = restoreSelection(graph.value, localStorage);
      if (saved !== null) void select(fetchJson, saved);
    }
  }, [graph.value]);

  // Every note that arrives, from any of the three directions it can arrive
  // from (mount, selection, SSE refetch), so the editor can decide whether it
  // is news or an interruption — see `editor.model.ts`'s header.
  useEffect(() => observeNotes((payload) => editor.send({ type: "loaded", payload })), []);

  // Read through a thunk, not captured: a listener registered at mount
  // outlives every render, so a captured state would always look clean and
  // the guard would be installed but inert.
  useEffect(() => watchUnload(window, () => shouldBlockUnload(editor.state())), []);

  useEffect(() => watchViewport(window, setWidth), []);

  // The relative-time clock. Every "8h ago" in the tree and the note meta is
  // computed from a `now` stamped per render, and a resting workspace never
  // re-renders on its own — so the minutes used to go stale until the next
  // SSE frame. One interval at `TICK_MS` (the reasoning is in `shell.model.ts`);
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
        context: () => ({ overlay: live.current.overlay, hasSelection: selectedId.value !== null }),
        run: (action) =>
          runShellAction(action, {
            setOverlay,
            focusSelector: (selector) => focusSelector(document, selector),
            fitGraph: () => fit.current?.(),
            // Through the editor, not straight to `select`: clearing the
            // selection while a draft is dirty must be refused like any
            // other navigation, and `Esc` is the easiest way to do it by
            // accident.
            clearSelection: () => editor.send({ type: "navigate", id: null }),
            toggleEdit: () => editor.send({ type: "toggle" }),
            saveNote: () => editor.send({ type: "save" }),
            cycleTheme: () => setTheme((current) => cycleTheme(current)),
          }),
      }),
    [],
  );

  const resolved = useMemo(() => resolveColumns(layout, width, breakpointFor(width)), [layout, width]);

  // Built once: the handlers read state through `live`, so they never go
  // stale and never need to be rebuilt.
  const drag = useMemo(
    () =>
      dividerHandlers({
        layout: () => live.current.layout,
        width: () => live.current.width,
        setLayout,
        persist: (next) => void saveLayout(localStorage, next),
      }),
    [],
  );

  return (
    <>
      <Header
        summary={summarize(graph.value)}
        connection={connectionView(connection.value)}
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
        bootFailed={graphFailed.value}
        graph={graph.value}
        note={noteBody.value}
        selectedId={selectedId.value}
        // Through the editor: a selection made while a draft is dirty is
        // parked rather than performed, and the column then asks. Every
        // column's `onSelect` routes here, so there is one guarded door
        // rather than three that each had to remember.
        onSelect={(id) => editor.send({ type: "navigate", id })}
        now={now}
        toolbar={editorToolbar(editorState)}
        prompt={editorPrompt(editorState)}
        draft={editorState.draft}
        send={editor.send}
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
        since §15.6 `stamp` is a content digest (a hex validator for the ETag
        and the SSE dedupe) and would render as `a3f9c2…` under a label that
        says "data as of". `generatedAt` kept the data-as-of job, which is
        exactly what this bar wants.
      */}
      <StatusBar
        model={statusBarModel(props.cwd, selectedId.value, connection.value, graph.value?.model.generatedAt ?? null)}
      />
      {overlay === "search" ? (
        <SearchPalette
          graph={graph.value}
          // Through the editor, like every column's `onSelect`: choosing a hit
          // while a draft is dirty must park behind the UNSAVED prompt, not
          // wipe it. This was the one navigation path that skipped the guard.
          onSelect={(id) => editor.send({ type: "navigate", id })}
          onClose={() => setOverlay(null)}
          ports={{ fetch: fetchJson, now: Date.now, delay: (run, ms) => void setTimeout(run, ms) }}
        />
      ) : null}
      {overlay === "help" ? (
        <HelpOverlay shortcut={searchShortcut(looksApple(props.platform))} onClose={() => setOverlay(null)} />
      ) : null}
    </>
  );
}
