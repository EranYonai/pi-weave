/**
 * workspaceRoot.ts — the v2 workspace ROOT component (weave-view-tui-v2 §4, §7).
 *
 * Sits above the pure `workspace.ts` split-tree model and the `surface/*`
 * components. It composes panes from a `Workspace` value into a real pi-tui
 * tree (VStack/HStack/Pane), owns the single input listener, routes keys
 * (workspace §7.1 / pane §7.2) and cross-pane SurfaceEvents, renders the
 * branded header + footer + narrow-mode tab bar (§9.2, decision 5), and
 * applies responsive collapse.
 *
 * It is drivable with a fake tui/theme/loaders exactly like v1's WeaveExplorer.
 * `WeaveExplorer` (v1 single-pane path) is kept intact for backward
 * compatibility; the workspace root is the v2 multi-pane path wired in run.ts.
 */

import { HStack, matchesKey, truncateToWidth, visibleWidth, VStack, type Component } from "@earendil-works/pi-tui";
import { BodyStore } from "./bodyStore";
import { renderMark } from "./branding";
import type { WeaveLoaders, WeaveTheme, WeaveTui } from "./explorer";
import { countProvenance } from "./model";
import type { GraphModel, GraphNode } from "../../../core/graph/model";
import { Pane } from "./surface/base";
import type { Surface, SurfaceEvent, SurfaceContext } from "./surface/base";
import { ExploreSurface } from "./surface/explore";
import { bindDetail, DetailSurface } from "./surface/detail";
import { FocusSurface } from "./surface/focus";
import { HealthSurface } from "./surface/health";
import {
  close,
  collapseForWidth,
  defaultWorkspace,
  focusNext,
  resize,
  setPaneSurface,
  split,
  workspacePanes,
  type PaneNode,
  type Workspace,
  type WorkspaceNode,
} from "./workspace";

export interface WeaveWorkspaceOptions {
  model: GraphModel;
  theme: WeaveTheme;
  tui: WeaveTui;
  loaders: WeaveLoaders;
  done: (result: null) => void;
  rows?: number;
  now?: () => number;
  /** Pre-rendered brand mark line (from branding.renderMark). */
  logo?: string;
  /** Optional initial workspace (defaults to the Explore default). */
  workspace?: Workspace;
}

/** Decode a workspace-level key (returns null when it's a pane key). */
export function decodeWorkspaceKey(data: string): string | null {
  if (data === "\\") return "splitV";
  if (data === "|") return "splitH";
  if (data === "x") return "close";
  if (data === "w") return "workspace";
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
  /** The workspace split tree + focus. */
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
    this.logo = opts.logo ?? renderMark("glyph", opts.theme, 20);
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
    this.workspace = opts.workspace ?? defaultWorkspace(opts.model);
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
    const wsKey = decodeWorkspaceKey(data);
    if (wsKey) {
      this.applyWorkspaceKey(wsKey);
      return;
    }
    if (data === "e" || data === "d" || data === "h") {
      this.swapSurface(data);
      return;
    }
    // Ctrl+letters resize — only the four resize bytes are intercepted so
    // enter (\r/0x0d), esc (0x1b) and other control keys reach the pane.
    const ctrl = charCode(data);
    if (ctrl !== undefined && (ctrl === 0x08 || ctrl === 0x0a || ctrl === 0x0b || ctrl === 0x0c)) {
      this.applyResize(ctrl);
      return;
    }
    const active = this.activePane();
    if (active?.handleInput) active.handleInput(data);
  }

  private applyWorkspaceKey(key: string): void {
    switch (key) {
      case "splitV":
        this.workspace = split(this.workspace, this.workspace.activePaneId, "vertical");
        this.syncPanes();
        this.invalidateAndRender();
        return;
      case "splitH":
        this.workspace = split(this.workspace, this.workspace.activePaneId, "horizontal");
        this.syncPanes();
        this.invalidateAndRender();
        return;
      case "close":
        this.workspace = close(this.workspace, this.workspace.activePaneId);
        this.syncPanes();
        this.invalidateAndRender();
        return;
      case "quit":
        if (!this.quitted) {
          this.quitted = true;
          this.done(null);
        }
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
      case "workspace":
        // TODO(M5): named-workspace switcher overlay; for now toggles help.
        this.helpOpen = !this.helpOpen;
        this.invalidateAndRender();
        return;
      case "help":
        this.helpOpen = !this.helpOpen;
        this.invalidateAndRender();
        return;
    }
  }

  /** Ctrl+h/l adjust row weights; Ctrl+j/k adjust column weights. */
  private applyResize(byte: number): void {
    const active = this.workspace.activePaneId;
    const d = 2;
    if (byte === 0x08) this.workspace = resize(this.workspace, active, "row", -d); // Ctrl-h
    else if (byte === 0x0c) this.workspace = resize(this.workspace, active, "row", d); // Ctrl-l
    else if (byte === 0x0a) this.workspace = resize(this.workspace, active, "column", d); // Ctrl-j
    else if (byte === 0x0b) this.workspace = resize(this.workspace, active, "column", -d); // Ctrl-k
    this.syncPanes();
    this.invalidateAndRender();
  }

  /** e/d/h — swap the active pane's surface in place (f stays the pane focus key). */
  private swapSurface(key: string): void {
    const kind = key === "e" ? "explore" : key === "d" ? "detail" : "health";
    const activeId = this.workspace.activePaneId;
    this.workspace = setPaneSurface(this.workspace, activeId, kind);
    const s = this.createSurface({ type: "pane", id: activeId, surface: kind, nodeId: null });
    this.panes.set(activeId, s);
    this.invalidateAndRender();
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

  /** Obsidian "open in main": nearest Detail pane to the right, else split. */
  private openDetail(id: string): void {
    // (The active Detail surface already rebinds itself on enter, so no
    // active-pane special case is needed here.)
    const panes = workspacePanes(this.workspace);
    const activeIdx = panes.findIndex((p) => p.id === this.workspace.activePaneId);
    const toRight = panes.slice(activeIdx + 1).find((p) => p.surface === "detail");
    if (toRight) {
      this.bindDetail(toRight.id, id);
      this.setActive(toRight.id);
      return;
    }
    // none to the right — split the active pane horizontally into a Detail
    this.workspace = split(this.workspace, this.workspace.activePaneId, "horizontal", "detail");
    this.syncPanes();
    const detail = workspacePanes(this.workspace).find((p) => p.surface === "detail");
    if (detail) {
      this.bindDetail(detail.id, id);
      this.setActive(detail.id);
    }
    this.invalidateAndRender();
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
      return;
    }
    this.workspace = split(this.workspace, this.workspace.activePaneId, "horizontal", "focus");
    this.syncPanes();
    const fp = workspacePanes(this.workspace).find((p) => p.surface === "focus");
    if (fp) {
      (this.panes.get(fp.id) as FocusSurface).setFocus(id);
      this.setActive(fp.id);
    }
    this.invalidateAndRender();
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
    const head = `${this.logo} ${t.bold("weave view")}`;
    const fill = "─".repeat(Math.max(1, width - visibleWidth(head) - 2));
    const line1 = `${head} ${fill} ${this.workspace.name} · ${workspacePanes(this.workspace).length} panes${repoPart}`;
    const out = [truncateToWidth(line1, width)];
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
    const bodyRows = Math.max(1, this.rows - (width < 80 ? 4 : 4));
    const tree = this.buildSplit(effective.root, bodyRows);
    return tree.render(width);
  }

  private buildSplit(node: WorkspaceNode, rows: number): Component {
    if (node.type === "pane") {
      const s = this.panes.get(node.id);
      if (!s) return { render: () => [], invalidate: () => {} };
      (s as { paneRows?: number }).paneRows = rows;
      const p = new Pane(s, this.theme);
      p.rows = rows;
      p.setFocused(node.id === this.workspace.activePaneId);
      return p;
    }
    const StackCtor = node.direction === "row" ? HStack : VStack;
    const stack = new StackCtor();
    node.children.forEach((c, i) => {
      stack.addChild(this.buildSplit(c, rows), { grow: node.sizes[i] ?? 1 });
    });
    return stack;
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
        "Tab focus · \\ | split · Ctrl-hjkl resize · x close · e/d/f/h swap",
        "↑↓/jk move · ←→/hl expand · enter open · / filter · p prov · f focus · r refresh · ? help · q quit",
      ];
      return help.map((l) => t.fg("dim", truncateToWidth(l, width)));
    }
    const hint = "Tab focus · \\ split · Ctrl-hjkl resize · e/d/f/h pane · r refresh · ? help · q quit";
    return [t.fg("dim", truncateToWidth(hint, width))];
  }
}

function charCode(data: string): number | undefined {
  if (data.length !== 1) return undefined;
  const c = data.charCodeAt(0);
  return c >= 0 && c < 0x20 ? c : undefined;
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
