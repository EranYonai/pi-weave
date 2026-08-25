/**
 * surface/explore.ts — the Explore surface as a Component (weave-view-tui-v2 §6).
 *
 * Wraps the v1 tree view-model (`treeRows` + `reduce`/`ExplorerState`) so each
 * Explore pane owns its own selection, expansion, filter, provenance cycle,
 * and search sub-mode — independent of other panes. Cross-pane navigation
 * (enter → open detail, f → open focus) is emitted as a `SurfaceEvent` that
 * the workspace root resolves (e.g. into the nearest Detail pane).
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import { decodeAction } from "../explorer";
import {
  formatTreeMeta,
  graphRoots,
  initialState,
  reduce,
  treeEmptyHint,
  treeRows,
  type Action,
  type ExplorerState,
} from "../model";
import { chevron, kindStyle, provenanceStyle, SELECTION_MARKER, type ThemeSlot } from "../theme";
import type { GraphModel } from "../../../../core/graph/model";
import type { NoteSource } from "../../../../core/types";
import { windowLines, type Surface, type SurfaceEvent, type SurfaceInit, type SurfaceRender } from "./base";

/** The Explore surface's own state (wraps the v1 ExplorerState for the tree). */
export interface ExploreSurfaceState {
  selectedId: string | null;
  expanded: Set<string>;
  showInternals: boolean;
  provFilter: NoteSource | null;
  query: string;
  searching: boolean;
  scrollOffset: number;
}

export function initialExploreState(model: GraphModel): ExploreSurfaceState {
  const s = initialState(graphRoots(model));
  return {
    selectedId: s.selectedId,
    expanded: s.expanded,
    showInternals: s.showInternals,
    provFilter: s.provFilter,
    query: s.query,
    searching: s.searching,
    scrollOffset: 0,
  };
}

export class ExploreSurface implements Surface {
  readonly kind = "explore" as const;
  private readonly ctx;
  private readonly onEvent: ((e: SurfaceEvent) => void) | undefined;
  state: ExploreSurfaceState;
  private focused = false;
  /** Pane viewport height (rows); set by the workspace root. */
  paneRows = 24;
  private renderCache = new Map<string, string[]>();

  constructor(init: SurfaceInit) {
    this.ctx = init.context;
    this.onEvent = init.onEvent;
    this.state = initialExploreState(this.ctx.model);
  }

  title(): string {
    return "Explore";
  }

  setFocused(focused: boolean): void {
    this.focused = focused;
  }

  invalidate(): void {
    this.renderCache.clear();
  }

  /** Navigate the tree with a key sequence (delegates to v1 decodeAction + reduce). */
  handleInput(data: string): void {
    // o opens the selected node in the external editor (parity with v1's
    // WeaveExplorer and the Detail surface; the workspace root resolves the
    // event into loaders.openNote/openFile).
    if (data === "o" && !this.state.searching) {
      if (this.state.selectedId) this.onEvent?.({ type: "openEditor", id: this.state.selectedId });
      return;
    }
    const action = decodeAction(data, toExplorerState(this.state));
    if (!action) return;
    this.applyAction(action);
  }

  private applyAction(action: Action): void {
    // Cross-pane navigation: enter → open detail; f → open focus.
    if (action.type === "enter" && !this.state.searching) {
      if (this.state.selectedId) this.onEvent?.({ type: "openDetail", id: this.state.selectedId });
      return;
    }
    if (action.type === "focus" && !this.state.searching) {
      if (this.state.selectedId) this.onEvent?.({ type: "focusNode", id: this.state.selectedId });
      return;
    }
    const rows = this.renderRows(80);
    const prev = toExplorerState(this.state);
    const next = reduce(prev, action, { rows, window: Math.max(5, this.paneRows) });
    this.state = fromExplorerState(next);
  }

  private renderRows(width: number): { id: string; target?: string }[] {
    return this.renderSurface(width).rows;
  }

  render(width: number): string[] {
    const key = `${width}:${this.state.scrollOffset}:${this.state.selectedId}:${this.state.query}:${this.state.provFilter ?? ""}:${this.state.showInternals}:${this.state.searching}`;
    const cached = this.renderCache.get(key);
    if (cached) return cached;
    const out = this.renderSurface(width).lines.map((l) => truncateToWidth(l, width));
    this.renderCache.set(key, out);
    return out;
  }

  private renderSurface(width: number): SurfaceRender {
    const t = this.ctx.theme;
    const rows = treeRows(this.ctx.model, {
      expanded: this.state.expanded,
      showInternals: this.state.showInternals,
      provFilter: this.state.provFilter,
      query: this.state.query,
    });
    const now = this.ctx.now();
    const hint = treeEmptyHint(this.ctx.model);
    if (rows.length === 0 && hint) {
      return { lines: [t.fg("dim", hint)], rows: [] };
    }
    const lines: { text: string; id: string }[] = rows.map((r) => {
      const chev = chevron(r.expanded, r.hasKids);
      const marker = this.rowMarker(r.kind, r.provenance);
      const label = sanitize(r.label);
      const metaText = formatTreeMeta(r.meta, now);
      const meta = metaText ? t.fg("dim", `  ${sanitize(metaText)}`) : "";
      const indent = "  ".repeat(r.depth);
      const body = `${indent}${chev} ${marker}${label}`;
      return { text: meta ? `${body}${meta}` : body, id: r.id };
    });
    const selId = this.state.selectedId;
    const selLine = selId ? lines.findIndex((l) => l.id === selId) : -1;
    const marker = (text: string) => `${SELECTION_MARKER} ${this.ctx.theme.bg("selectedBg", text)}`;
    const out: string[] = windowLines(
      lines.map((l) => l.text),
      selLine,
      this.state.scrollOffset,
      Math.max(5, this.paneRows),
      marker,
    );
    if (this.state.searching) {
      const prompt = t.fg("accent", "/");
      out.push(`${prompt}${sanitize(this.state.query)}`);
    }
    return { lines: out, rows: rows.map((r) => ({ id: r.id })) };
  }

  private rowMarker(kind: string, prov: NoteSource | null): string {
    const ks = kindStyle(kind as never);
    if (kind === "note") {
      const ps = provenanceStyle(prov);
      return ps.glyph ? `${ps.glyph} ` : "";
    }
    return `${this.ctx.theme.fg(ks.slot as ThemeSlot, `${ks.glyph} `)}`;
  }
}

function sanitize(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b/g, "").replace(/\x9b/g, "").replace(/\x07/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

function toExplorerState(s: ExploreSurfaceState): ExplorerState {
  return {
    surface: "tree",
    searching: s.searching,
    selectedId: s.selectedId,
    focusId: null,
    detailId: null,
    expanded: s.expanded,
    showInternals: s.showInternals,
    provFilter: s.provFilter,
    query: s.query,
    helpOpen: false,
    refreshing: false,
    version: 0,
    scrollOffset: s.scrollOffset,
  };
}

function fromExplorerState(s: ExplorerState): ExploreSurfaceState {
  return {
    selectedId: s.selectedId,
    expanded: s.expanded,
    showInternals: s.showInternals,
    provFilter: s.provFilter,
    query: s.query,
    searching: s.searching,
    scrollOffset: s.scrollOffset,
  };
}
