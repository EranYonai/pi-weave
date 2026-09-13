/**
 * workspaceRoot.ts — the v2 workspace ROOT component (weave-view-tui-v2 §4, §7).
 *
 * Sits above the pure fixed `workspace.ts` model and the `surface/*`
 * components. It composes panes from a `Workspace` value into a real pi-tui
 * tree (HStack/Pane), owns the single input listener, routes keys and
 * cross-pane SurfaceEvents, renders the
 * branded header + footer + narrow-mode tab bar (§9.2, decision 5), and
 * applies responsive collapse.
 *
 * It is drivable with a fake tui/theme/loaders and is the path wired in run.ts.
 */

import { HStack, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { BodyStore } from "./bodyStore";
import { renderMark } from "./branding";
import type { WeaveLoaders, WeaveTheme, WeaveTui } from "./surface/base";
import { countProvenance } from "./model";
import type { GraphModel, GraphNode } from "../../../core/graph/model";
import { Pane } from "./surface/base";
import type { Surface, SurfaceEvent, SurfaceContext } from "./surface/base";
import { ExploreSurface } from "./surface/explore";
import { bindDetail, DetailSurface } from "./surface/detail";
import { FocusSurface } from "./surface/focus";
import { HealthSurface } from "./surface/health";
import { collapseForWidth, defaultWorkspace, focusNext, workspacePanes, type PaneNode, type Workspace } from "./workspace";

export interface WeaveWorkspaceOptions {
  model: GraphModel;
  theme: WeaveTheme;
  tui: WeaveTui;
  loaders: WeaveLoaders;
  done: (result: null) => void;
  rows?: number;
  now?: () => number;
}

/** Decode the few root-level keys; all other input belongs to the active surface. */
export function decodeWorkspaceKey(data: string): string | null {
  if (data === "?") return "help";
  if (data === "q") return "quit";
  if (data === "r") return "refresh";
  return null;
}

export class WeaveWorkspace implements Component {
  model: GraphModel;
  private readonly theme: WeaveTheme;
  private readonly tui: WeaveTui;
  private readonly loaders: WeaveLoaders;
  private readonly done: (result: null) => void;
  private readonly rows: number;
  private readonly nowFn: () => number;
  private readonly logo: string;
  private readonly bodies: BodyStore;
  private ctx: SurfaceContext;
  /** paneId → surface instance. */
  private panes = new Map<string, Surface>();
  /** The fixed pane layout + focus. */
  workspace: Workspace;
  private helpOpen = false;
  refreshing = false;
  private quitted = false;
  private renderCache = new Map<string, string[]>();
  wantsKeyRelease = false;

  constructor(opts: WeaveWorkspaceOptions) {
    this.model = opts.model;
    this.theme = opts.theme;
    this.tui = opts.tui;
    this.loaders = opts.loaders;
    this.done = opts.done;
    this.rows = opts.rows ?? 24;
    this.nowFn = opts.now ?? Date.now;
    this.logo = renderMark(opts.theme, 20);
    this.bodies = new BodyStore({
      loaders: opts.loaders,
      onChange: () => this.invalidateAndRender(),
    });
    this.ctx = {
      model: opts.model,
      theme: opts.theme,
      loaders: opts.loaders,
      bodies: this.bodies,
      now: this.nowFn,
    };
    this.workspace = defaultWorkspace(opts.model);
    this.syncPanes();
  }

  invalidate(): void {
    this.renderCache.clear();
    for (const s of this.panes.values()) s.invalidate();
  }

  private invalidateAndRender(): void {
    this.invalidate();
    this.tui.requestRender();
  }

  setModel(model: GraphModel): void {
    this.model = model;
    // Surfaces read the model through the shared context (this.ctx.model), not
    // this.model — so a refresh that only swaps this.model leaves every pane
    // showing the pre-refresh graph. Propagate to the context so `r` actually
    // re-renders the body, then drop stale pane selections that no longer exist.
    this.ctx.model = model;
    for (const s of this.panes.values()) s.rebind?.(model);
    this.bodies.clear();
    this.refreshing = false;
    this.invalidateAndRender();
  }

  /** Rebuild surface instances so every pane node in the tree has one. */
  private syncPanes(): void {
    const wanted = workspacePanes(this.workspace);
    const next = new Map<string, Surface>();
    for (const pn of wanted) {
      let s = this.panes.get(pn.id);
      if (!s) s = this.createSurface(pn);
      next.set(pn.id, s);
    }
    this.panes = next;
  }

  private createSurface(pn: PaneNode): Surface {
    const init = { context: this.ctx, onEvent: (e: SurfaceEvent) => this.onSurfaceEvent(e) };
    switch (pn.surface) {
      case "explore":
        return new ExploreSurface(init);
      case "detail":
        return pn.nodeId ? bindDetail(init, pn.nodeId) : new DetailSurface(init);
      case "focus": {
        const f = new FocusSurface(init);
        if (pn.nodeId) f.setFocus(pn.nodeId);
        return f;
      }
      case "health":
        return new HealthSurface(init);
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, "tab")) return this.cycleFocus(1);
    if (matchesKey(data, "shift+tab")) return this.cycleFocus(-1);
    if (matchesKey(data, "escape")) {
      // Esc precedence (mirrors v1): if the active pane is in a sub-mode
      // (Explore search OR Detail goto-line), Esc clears it; otherwise Esc
      // quits the explorer.
      const active = this.activePane();
      if (active && inSubMode(active)) {
        active.handleInput?.(data);
        this.invalidate();
        this.tui.requestRender();
        return;
      }
      this.quit();
      return;
    }
    const wsKey = decodeWorkspaceKey(data);
    if (wsKey) {
      this.applyWorkspaceKey(wsKey);
      return;
    }
    const active = this.activePane();
    if (active?.handleInput) {
      active.handleInput(data);
      // CRITICAL: the surface updated its own selection/scroll state, but it
      // has no `tui` and the workspace render cache is now stale. Invalidate
      // (clears the workspace + per-surface caches) and request a fresh render
      // — without this, arrow/enter/filter keys change state but the screen
      // never updates (the "arrows don't navigate" bug).
      this.invalidate();
      this.tui.requestRender();
    }
  }

  private quit(): void {
    if (!this.quitted) {
      this.quitted = true;
      this.done(null);
    }
  }

  private applyWorkspaceKey(key: string): void {
    switch (key) {
      case "quit":
        this.quit();
        return;
      case "refresh":
        if (this.refreshing) return;
        this.refreshing = true;
        this.invalidateAndRender();
        void this.loaders
          .rebuild()
          .then((m) => this.setModel(m))
          .catch(() => {
            this.refreshing = false;
            this.invalidateAndRender();
          });
        return;
      case "help":
        this.helpOpen = !this.helpOpen;
        this.invalidateAndRender();
        return;
    }
  }

  private cycleFocus(dir: 1 | -1): void {
    this.workspace = focusNext(this.workspace, dir);
    this.refreshFocusFlags();
    this.invalidateAndRender();
  }

  private refreshFocusFlags(): void {
    for (const pn of workspacePanes(this.workspace)) {
      const s = this.panes.get(pn.id);
      s?.setFocused(pn.id === this.workspace.activePaneId);
    }
  }

  private setActive(paneId: string): void {
    this.workspace = { ...this.workspace, activePaneId: paneId };
    this.refreshFocusFlags();
  }

  private activePane(): Surface | undefined {
    return this.panes.get(this.workspace.activePaneId);
  }

  private onSurfaceEvent(e: SurfaceEvent): void {
    if (e.type === "openEditor") {
      this.openInEditor(e.id);
      return;
    }
    if (e.type === "openDetail") {
      this.openDetail(e.id);
      return;
    }
    if (e.type === "focusNode") {
      this.openFocus(e.id);
    }
  }

  private openInEditor(id: string): void {
    const node = this.model.nodes.find((n) => n.id === id);
    if (!node || node.kind !== "note") return;
    if (node.detail.slug) void this.loaders.openNote(node.detail.slug);
  }

  /** Open a selected node in the fixed Detail pane. */
  private openDetail(id: string): void {
    // (The active Detail surface already rebinds itself on enter, so no
    // active-pane special case is needed here.)
    const panes = workspacePanes(this.workspace);
    const detail = panes.find((p) => p.surface === "detail");
    if (!detail) return;
    this.bindDetail(detail.id, id);
    this.setActive(detail.id);
  }

  private bindDetail(paneId: string, id: string): void {
    const s = this.panes.get(paneId) as DetailSurface;
    if (!s) return;
    s.state = { nodeId: id, selectedId: id, scrollOffset: 0 };
    this.requestBody(id);
    this.invalidateAndRender();
  }

  private openFocus(id: string): void {
    const active = this.activePane();
    if (active && active.kind === "focus") {
      (active as FocusSurface).setFocus(id);
      this.invalidateAndRender();
      return;
    }
    const panes = workspacePanes(this.workspace);
    const focus = panes.find((p) => p.surface === "focus");
    if (focus) {
      (this.panes.get(focus.id) as FocusSurface).setFocus(id);
      this.setActive(focus.id);
      this.invalidateAndRender();
    }
  }

  private requestBody(id: string): void {
    const node = this.model.nodes.find((n) => n.id === id);
    if (!node) return;
    if (node.kind === "note") this.bodies.load(id, "note", node.detail.slug);
    else if (node.kind === "file") this.bodies.load(id, "file", node.detail.path);
  }

  render(width: number): string[] {
    const key = `${width}:${this.workspace.activePaneId}:${this.helpOpen}:${this.refreshing}`;
    const cached = this.renderCache.get(key);
    if (cached) return cached;
    const out: string[] = [];
    out.push(...this.renderHeader(width));
    out.push(...this.renderBody(width));
    if (width < 80) out.push(...this.renderTabBar(width));
    out.push(...this.renderFooter(width));
    const clamped = out.slice(0, Math.max(1, this.rows)).map((l) => (visibleWidth(l) > width ? truncateToWidth(l, width) : l));
    this.renderCache.set(key, clamped);
    return clamped;
  }

  private renderHeader(width: number): string[] {
    const t = this.theme;
    const counts = countProvenance(this.model.nodes);
    const repo = this.model.nodes.find((n) => n.kind === "repository");
    const repoState = repoStaleness(this.model, repo);
    const repoPart = repo ? ` · repo ${repo.label}:${repoState}` : "";
    const mark = this.logo;
    const head = `${mark}${mark ? " " : ""}${t.bold("weave view")}`;
    const fill = "─".repeat(Math.max(1, width - visibleWidth(head) - 2));
    const line1 = `${head} ${fill} ${this.workspace.name} · ${workspacePanes(this.workspace).length} panes${repoPart}`;
    const out: string[] = [truncateToWidth(line1, width)];
    const banner = this.bannerText();
    if (banner) out.push(t.fg("warning", truncateToWidth(banner, width)));
    const countsLine = `notes ${counts.total} (● ${counts.human} / ◐ ${counts.agent} / ○ ${counts.generated})`;
    out.push(truncateToWidth(t.fg("dim", countsLine), width));
    return out;
  }

  private bannerText(): string | null {
    return this.refreshing ? "refreshing…" : null;
  }

  private renderBody(width: number): string[] {
    const effective = collapseForWidth(this.workspace, width);
    const bodyRows = Math.max(1, this.rows - 4);
    const stack = new HStack();
    for (const pane of effective.panes) stack.addChild(this.buildPane(pane, bodyRows), { grow: 1 });
    return stack.render(width);
  }

  private buildPane(node: PaneNode, rows: number): Component {
    const s = this.panes.get(node.id);
    if (!s) return { render: () => [], invalidate: () => {} };
    (s as { paneRows?: number }).paneRows = Math.max(1, rows - 3);
    const p = new Pane(s, this.theme);
    p.rows = rows;
    p.setFocused(node.id === this.workspace.activePaneId);
    return p;
  }

  private renderTabBar(width: number): string[] {
    const panes = workspacePanes(this.workspace);
    const t = this.theme;
    const parts = panes.map((p) => {
      const active = p.id === this.workspace.activePaneId;
      return active ? t.fg("accent", `[${p.surface}]`) : p.surface;
    });
    return [truncateToWidth(parts.join("  "), width)];
  }

  private renderFooter(width: number): string[] {
    const t = this.theme;
    if (this.helpOpen) {
      const help = [
        "Tab focus · ↑↓/jk move · ←→/hl expand · enter open · f focus · r refresh · ? help · q quit",
        "↑↓/jk move · ←→/hl expand · enter open · / filter · p prov · f focus · r refresh · ? help · q quit",
      ];
      return help.map((l) => t.fg("dim", truncateToWidth(l, width)));
    }
    const hint = "Tab focus · ↑↓/jk move · ←→/hl expand · enter open · f focus · r refresh · ? help · q quit";
    return [t.fg("dim", truncateToWidth(hint, width))];
  }
}

/** True when the active surface is in a sub-mode that Esc should clear instead
 *  of quitting — Explore's search (`state.searching`) or Detail's goto-line
 *  (`state.gotoBuf`). Surfaces own their own state; read defensively so a
 *  surface without either field simply returns false. */
function inSubMode(s: Surface | undefined): boolean {
  const st = (s as { state?: { searching?: boolean; gotoBuf?: string | null } }).state;
  return !!st && (st.searching === true || st.gotoBuf != null);
}

function repoStaleness(model: GraphModel, repo: GraphNode | undefined): string {
  if (repo) {
    const st = model.staleness;
    if (st && "state" in st) return st.state;
    return "fresh";
  }
  return "missing";
}

export type { Component };
