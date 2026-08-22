/**
 * WeaveExplorer — the weave-view TUI component (weave-view-tui-design §4, §10.2).
 *
 * A thin input/render shell: it holds the GraphModel + ExplorerState, builds
 * per-surface row models from the pure `model.ts`, decodes keys into actions,
 * applies `reduce`, and renders a windowed header + body + footer. All
 * branching logic lives in `model.ts`; this file only maps keys → actions and
 * strings → styled lines. Bodies (note markdown, .okf file text) load lazily
 * through injected async loaders and are cached per node id.
 *
 * Dependencies are injected (`theme`, `tui`, loaders, `rebuild`, `openNote`,
 * `done`) so the component is fully testable without a real terminal.
 */

import { matchesKey, parseKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

import type { GraphModel, GraphNode, NodeKind } from "../../../core/graph/model";
import type { NoteSource } from "../../../core/types";
import type { ViewNote } from "../../../core/graph/current";
import {
  detailModel,
  focusModel,
  graphRoots,
  healthModel,
  initialState,
  reduce,
  sanitizeTerminalText,
  treeEmptyHint,
  treeRows,
  type Action,
  type ExplorerState,
  type ReduceCtx,
  type SelectableRow,
  type TreeRow,
} from "./model";
import { chevron, kindStyle, provenanceStyle, SELECTION_MARKER, type ThemeSlot } from "./theme";

/** Minimal theme surface the component uses (the real pi Theme satisfies it). */
export interface WeaveTheme {
  fg(slot: ThemeSlot, text: string): string;
  bg(slot: "selectedBg", text: string): string;
  bold(text: string): string;
  dim(text: string): string;
}

/** Minimal TUI surface the component uses (the real pi TUI satisfies it). */
export interface WeaveTui {
  requestRender(force?: boolean): void;
  terminal: { rows: number; columns: number };
}

/** Injected body loaders (bound to vault root / cwd by run.ts). */
export interface WeaveLoaders {
  loadNote: (slug: string) => Promise<ViewNote | null>;
  loadOkf: (rel: string) => Promise<{ path: string; body: string } | null>;
  /** Open a note in $EDITOR (the `o` key); returns false when the note is gone/unsafe. */
  openNote: (slug: string) => Promise<boolean>;
  /** Rebuild the graph from disk (the `r` key). */
  rebuild: () => Promise<GraphModel>;
}

export interface WeaveExplorerOptions {
  model: GraphModel;
  theme: WeaveTheme;
  tui: WeaveTui;
  loaders: WeaveLoaders;
  done: (result: null) => void;
  /** Terminal rows for windowing; falls back to 24 (tests / unavailable). */
  rows?: number;
  /** Reference clock for relative-time meta (epoch ms); defaults to Date.now(). */
  now?: () => number;
}

interface RenderedLine {
  text: string;
  /** Node id this line selects (for highlight + scroll-into-view). */
  selectId?: string;
}

interface SurfaceRender {
  lines: RenderedLine[];
  rows: SelectableRow[];
}

const HEADER_LINES = 2;
const FOOTER_LINES = 1;
const MIN_WINDOW = 5;

/**
 * Decode a raw terminal key sequence into an explorer action, given the
 * current state (search mode changes how printable keys are interpreted).
 * Exported for unit testing the decode path with real byte sequences.
 */
export function decodeAction(data: string, state: ExplorerState): Action | null {
  // Keys that work in every mode (arrows, enter, esc, paging).
  if (matchesKey(data, "up")) return { type: "up" };
  if (matchesKey(data, "down")) return { type: "down" };
  if (matchesKey(data, "left")) return { type: "left" };
  if (matchesKey(data, "right")) return { type: "right" };
  if (matchesKey(data, "enter")) return { type: "enter" };
  if (matchesKey(data, "escape")) return { type: "esc" };
  if (matchesKey(data, "pageUp")) return { type: "pageUp" };
  if (matchesKey(data, "pageDown")) return { type: "pageDown" };
  if (matchesKey(data, "home")) return { type: "home" };
  if (matchesKey(data, "end")) return { type: "end" };

  // Search sub-mode: printable characters edit the filter; backspace deletes.
  if (state.searching) {
    if (matchesKey(data, "backspace")) return { type: "searchBackspace" };
    const ch = parseKey(data);
    if (ch === undefined) return null;
    if (ch === "space") return { type: "searchChar", ch: " " };
    if (ch.length === 1) return { type: "searchChar", ch };
    return null;
  }

  // Vim-style hjkl duplicates (deliberate for the drill-down flow) + letters.
  if (data === "k") return { type: "up" };
  if (data === "j") return { type: "down" };
  if (data === "h") return { type: "left" };
  if (data === "l") return { type: "right" };
  if (data === "/") return { type: "searchStart" };
  if (data === "p") return { type: "cycleProvenance" };
  if (data === "i") return { type: "toggleInternals" };
  if (data === "f") return { type: "focus" };
  if (data === "g") return { type: "focusExit" };
  if (data === "1") return { type: "surfaceTree" };
  if (data === "2") return { type: "surfaceHealth" };
  if (data === "r") return { type: "refresh" };
  if (data === "?") return { type: "toggleHelp" };
  if (data === "q") return { type: "quit" };
  return null;
}

export class WeaveExplorer implements Component {
  private model: GraphModel;
  private readonly theme: WeaveTheme;
  private readonly tui: WeaveTui;
  private readonly loaders: WeaveLoaders;
  private readonly done: (result: null) => void;
  private readonly rows: number;
  private readonly nowFn: () => number;

  state: ExplorerState;
  /** Cached note/okf bodies keyed by node id; null = not yet loaded. */
  private bodyCache = new Map<string, string | null>();
  /** In-flight body loads, keyed by node id. */
  private bodyLoading = new Set<string>();
  /** Render cache keyed by `${width}:${version}`. */
  private renderCache = new Map<string, string[]>();
  wantsKeyRelease = false;

  constructor(opts: WeaveExplorerOptions) {
    this.model = opts.model;
    this.theme = opts.theme;
    this.tui = opts.tui;
    this.loaders = opts.loaders;
    this.done = opts.done;
    this.rows = opts.rows ?? opts.tui.terminal?.rows ?? 24;
    this.nowFn = opts.now ?? Date.now;
    this.state = initialState(graphRoots(this.model));
  }

  /** Replace the graph (used by the `r` refresh). Preserves selection by id. */
  setModel(model: GraphModel): void {
    this.model = model;
    this.bodyCache.clear();
    this.bodyLoading.clear();
    this.state = reduce(this.state, { type: "refreshDone" });
    // Re-resolve selection: keep id if still present, else first root.
    if (this.state.selectedId && !this.nodeExists(this.state.selectedId)) {
      this.state = { ...this.state, selectedId: graphRoots(this.model)[0] ?? null, scrollOffset: 0 };
    }
    this.invalidate();
  }

  invalidate(): void {
    this.renderCache.clear();
  }

  handleInput(data: string): void {
    // Side-effect keys resolved before reduce (they don't change model state).
    if (data === "o" && !this.state.searching) {
      this.openSelectedInEditor();
      return;
    }
    const action = decodeAction(data, this.state);
    if (action === null) return;

    // q / tree-esc quit the explorer.
    if (action.type === "quit" || (action.type === "esc" && this.state.surface === "tree" && !this.state.searching)) {
      this.done(null);
      return;
    }

    // r refresh: rebuild from disk; old view stays up, banner flips to refreshing.
    if (action.type === "refresh") {
      if (this.state.refreshing) return;
      this.state = reduce(this.state, { type: "refresh" });
      this.invalidate();
      this.tui.requestRender();
      void this.loaders
        .rebuild()
        .then((model) => {
          this.setModel(model);
        })
        .catch(() => {
          this.state = reduce(this.state, { type: "refreshDone" });
          this.invalidate();
          this.tui.requestRender();
        });
      return;
    }

    const rows = this.currentRows();
    const ctx: ReduceCtx = { rows, window: this.windowSize() };
    const prev = this.state;
    let next = reduce(prev, action, ctx);

    // When entering detail for a note/okf node, kick off the body load.
    if (next.surface === "detail" && next.detailId !== prev.detailId && next.detailId !== null) {
      this.maybeLoadBody(next.detailId);
    }
    // When focus re-centers on a note, no body needed.

    this.state = next;
    this.invalidate();
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const key = `${width}:${this.state.version}`;
    const cached = this.renderCache.get(key);
    if (cached) return cached;

    const lines: string[] = [];
    lines.push(...this.renderHeader(width));
    lines.push(...this.renderBody(width));
    if (this.state.searching) lines.push(...this.renderSearchLine(width));
    lines.push(...this.renderFooter(width));

    // Pad/truncate every line to the viewport width and clamp to terminal rows.
    const out: string[] = [];
    const maxRows = this.rows;
    for (let i = 0; i < lines.length && i < maxRows; i++) {
      const line = lines[i] ?? "";
      const w = visibleWidth(line);
      if (w > width) out.push(truncateToWidth(line, width));
      else out.push(line);
    }

    this.renderCache.set(key, out);
    return out;
  }

  // ----- rendering -----

  private renderHeader(width: number): string[] {
    const t = this.theme;
    const line1 = t.bold(`🧵 weave view — data as of ${this.model.generatedAt || "now"}`) + `  ${this.surfaceName()}`;
    const counts = this.countNotes();
    const repo = this.model.nodes.find((n) => n.kind === "repository");
    const repoPart = repo
      ? ` · repo ${repo.detail.state || this.model.staleness?.state || "?"}: ${this.model.staleness?.state ?? "missing"}`
      : "";
    const line2 = `notes ${counts.total} (● ${counts.human} / ◐ ${counts.agent} / ○ ${counts.generated})${repoPart}`;
    const lines = [line1, line2];
    // conditional filter/focus banner (line 3)
    const banner = this.bannerText();
    if (banner) lines.push(t.fg("warning", banner));
    return lines.map((l) => truncateToWidth(l, width));
  }

  private renderFooter(width: number): string[] {
    const t = this.theme;
    if (this.state.helpOpen) {
      const help = [
        "↑↓/jk move · ←→/hl collapse/expand · enter open · / filter · p prov · i internals",
        "f focus · g/esc exit focus · 1 tree · 2 health · r refresh · o editor · ? help · q quit",
      ];
      return help.map((l) => t.fg("dim", truncateToWidth(l, width)));
    }
    const hint = this.state.searching
      ? "search: type to filter · enter keep · esc clear"
      : "↑↓ move · enter open · / filter · f focus · 2 health · r refresh · o editor · ? help · q quit";
    return [t.fg("dim", truncateToWidth(hint, width))];
  }

  private renderSearchLine(width: number): string[] {
    const t = this.theme;
    const prompt = t.fg("accent", "/");
    const q = sanitizeTerminalText(this.state.query);
    return [truncateToWidth(`${prompt}${q}`, width)];
  }

  private renderBody(width: number): string[] {
    const surface = this.renderSurface(width);
    const lines = surface.lines;
    // find selected line index
    const selId = this.state.selectedId;
    let selLine = -1;
    if (selId) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]?.selectId === selId) {
          selLine = i;
          break;
        }
      }
    }
    // window
    const window = Math.max(MIN_WINDOW, this.windowSize());
    let offset = this.state.scrollOffset;
    if (selLine >= 0) {
      if (selLine < offset) offset = selLine;
      else if (selLine >= offset + window) offset = selLine - window + 1;
    }
    offset = Math.max(0, Math.min(offset, Math.max(0, lines.length - window)));
    const out: string[] = [];
    const end = Math.min(lines.length, offset + window);
    for (let i = offset; i < end; i++) {
      const ln = lines[i];
      if (!ln) continue;
      const isSel = i === selLine;
      let text = ln.text;
      if (isSel) {
        text = `${SELECTION_MARKER} ${this.theme.bg("selectedBg", text)}`;
      } else {
        text = `  ${text}`;
      }
      out.push(truncateToWidth(text, width));
    }
    // scroll indicators
    if (offset > 0) out.unshift(this.theme.fg("dim", "▲ more"));
    if (end < lines.length) out.push(this.theme.fg("dim", "▼ more"));
    return out;
  }

  private renderSurface(width: number): SurfaceRender {
    switch (this.state.surface) {
      case "tree":
        return this.renderTree(width);
      case "detail":
        return this.renderDetail(width);
      case "focus":
        return this.renderFocus(width);
      case "health":
        return this.renderHealth(width);
    }
  }

  private renderTree(width: number): SurfaceRender {
    const t = this.theme;
    const rows = treeRows(this.model, {
      expanded: this.state.expanded,
      showInternals: this.state.showInternals,
      provFilter: this.state.provFilter,
      query: this.state.query,
      now: this.nowFn(),
    });
    const hint = treeEmptyHint(this.model);
    if (rows.length === 0 && hint) {
      return { lines: [{ text: t.fg("dim", hint) }], rows: [] };
    }
    const lines: RenderedLine[] = rows.map((r) => {
      const chev = chevron(r.expanded, r.hasKids);
      const marker = this.rowMarker(r.kind, r.provenance);
      const label = sanitizeTerminalText(r.label);
      const meta = r.meta ? t.fg("dim", `  ${sanitizeTerminalText(r.meta)}`) : "";
      const indent = "  ".repeat(r.depth);
      const body = `${indent}${chev} ${marker}${label}`;
      const text = meta ? `${body}${meta}` : body;
      return { text, selectId: r.id };
    });
    return { lines, rows };
  }

  private renderDetail(width: number): SurfaceRender {
    const t = this.theme;
    const id = this.state.detailId;
    if (!id) return { lines: [{ text: t.fg("dim", "(no selection)") }], rows: [] };
    const d = detailModel(this.model, id);
    if (!d) return { lines: [{ text: t.fg("dim", "(node not found)") }], rows: [] };

    const lines: RenderedLine[] = [];
    // title
    const marker = this.rowMarker(d.kind, d.provenance);
    const provBadge = d.provenance ? ` ${provenanceStyle(d.provenance).glyph} ${provenanceStyle(d.provenance).word}` : "";
    lines.push({ text: t.bold(`${marker}${sanitizeTerminalText(d.label)}`) + t.fg("muted", ` (${d.kind}${provBadge})`) });

    // meta rows (selectable for scroll)
    for (const m of d.meta) {
      lines.push({
        text: `${t.fg("muted", sanitizeTerminalText(m.label))}: ${sanitizeTerminalText(m.value)}`,
        selectId: m.id,
      });
    }

    // body
    const bodyLines = this.bodyLinesFor(id, width);
    for (const bl of bodyLines) lines.push({ text: bl });

    // links
    if (d.links.length > 0) {
      lines.push({ text: t.fg("accent", "Links") });
      for (const lk of d.links) {
        lines.push({ text: `  ${this.rowMarker(lk.kind, lk.provenance)}${sanitizeTerminalText(lk.label)}`, selectId: lk.id, });
      }
    }
    if (d.backlinks.length > 0) {
      lines.push({ text: t.fg("accent", "Backlinks") });
      for (const lk of d.backlinks) {
        lines.push({ text: `  ${this.rowMarker(lk.kind, lk.provenance)}${sanitizeTerminalText(lk.label)}`, selectId: lk.id });
      }
    }

    const rows: SelectableRow[] = [...d.meta.map((m) => ({ id: m.id })), ...d.links, ...d.backlinks];
    return { lines, rows };
  }

  private renderFocus(width: number): SurfaceRender {
    const t = this.theme;
    const id = this.state.focusId;
    if (!id) return { lines: [{ text: t.fg("dim", "(no focus node)") }], rows: [] };
    const f = focusModel(this.model, id);
    const lines: RenderedLine[] = [];
    const cm = this.rowMarker(f.center.kind, f.center.provenance);
    lines.push({ text: t.bold(`${cm}${sanitizeTerminalText(f.center.label)}`) + t.fg("dim", "  (focus — g/esc to exit)"), selectId: f.center.id });
    for (const g of f.groups) {
      lines.push({ text: t.fg("accent", g.heading) });
      for (const r of g.rows) {
        lines.push({ text: `  ${this.rowMarker(r.kind, r.provenance)}${sanitizeTerminalText(r.label)}`, selectId: r.id });
      }
    }
    const rows: SelectableRow[] = [{ id: f.center.id, target: f.center.id }, ...f.groups.flatMap((g) => g.rows)];
    return { lines, rows };
  }

  private renderHealth(width: number): SurfaceRender {
    const t = this.theme;
    const h = healthModel(this.model);
    const lines: RenderedLine[] = [];
    const rows: SelectableRow[] = [];
    for (const s of h.sections) {
      lines.push({ text: t.bold(s.heading) });
      for (const r of s.rows) {
        lines.push(r.target ? { text: sanitizeTerminalText(r.text), selectId: r.id } : { text: sanitizeTerminalText(r.text) });
        if (r.target) rows.push({ id: r.id, target: r.target });
      }
    }
    return { lines, rows };
  }

  // ----- helpers -----

  private rowMarker(kind: NodeKind, prov: NoteSource | null): string {
    const ks = kindStyle(kind);
    if (kind === "note") {
      const ps = provenanceStyle(prov);
      return ps.glyph ? `${ps.glyph} ` : "";
    }
    return ks.glyph ? `${t_fg(this.theme, ks.slot, `${ks.glyph} `)}` : "";
  }

  private windowSize(): number {
    const banner = this.bannerText() ? 1 : 0;
    const search = this.state.searching ? 1 : 0;
    return Math.max(MIN_WINDOW, this.rows - HEADER_LINES - banner - search - FOOTER_LINES);
  }

  private bannerText(): string | null {
    const parts: string[] = [];
    if (this.state.provFilter) parts.push(`prov: ${provenanceStyle(this.state.provFilter).glyph} ${provenanceStyle(this.state.provFilter).word}`);
    if (this.state.query) parts.push(`filter: ${this.state.query}`);
    if (this.state.focusId && this.state.surface !== "focus") parts.push(`focus: ${this.state.focusId}`);
    if (this.state.refreshing) parts.push("refreshing…");
    return parts.length > 0 ? parts.join(" · ") : null;
  }

  private surfaceName(): string {
    switch (this.state.surface) {
      case "tree": return "Explore";
      case "detail": return "Detail";
      case "focus": return "Focus";
      case "health": return "Health";
    }
  }

  private countNotes(): { total: number; human: number; agent: number; generated: number } {
    let human = 0, agent = 0, generated = 0, total = 0;
    for (const n of this.model.nodes) {
      if (n.kind !== "note") continue;
      total++;
      if (n.provenance === "human") human++;
      else if (n.provenance === "agent") agent++;
      else if (n.provenance === "generated") generated++;
    }
    return { total, human, agent, generated };
  }

  private currentRows(): SelectableRow[] {
    return this.renderSurface(80).rows;
  }

  private nodeExists(id: string): boolean {
    return this.model.nodes.some((n) => n.id === id);
  }

  private maybeLoadBody(id: string): void {
    if (this.bodyCache.has(id) || this.bodyLoading.has(id)) return;
    const node = this.model.nodes.find((n) => n.id === id);
    if (!node) return;
    if (node.kind === "note") {
      const slug = node.detail.slug;
      if (!slug) return;
      this.bodyLoading.add(id);
      void this.loaders.loadNote(slug).then((note) => {
        this.bodyCache.set(id, note?.body ?? null);
        this.bodyLoading.delete(id);
        this.state = { ...this.state, version: this.state.version + 1 };
        this.invalidate();
        this.tui.requestRender();
      });
    } else if (node.kind === "file") {
      const rel = node.detail.path;
      if (!rel) return;
      this.bodyLoading.add(id);
      void this.loaders.loadOkf(rel).then((file) => {
        this.bodyCache.set(id, file?.body ?? null);
        this.bodyLoading.delete(id);
        this.state = { ...this.state, version: this.state.version + 1 };
        this.invalidate();
        this.tui.requestRender();
      });
    }
  }

  private bodyLinesFor(id: string, width: number): string[] {
    if (this.bodyLoading.has(id)) return [this.theme.fg("dim", "(loading…)")];
    const body = this.bodyCache.get(id);
    if (body === undefined) {
      // not yet requested — trigger a load (render is sync, so show placeholder)
      queueMicrotask(() => this.maybeLoadBody(id));
      return [this.theme.fg("dim", "(loading…)")];
    }
    if (body === null) return [];
    // Render body lines, wrapped by visible width (no Markdown component in v1
    // to keep the component single-file and testable; bodies wrap as plain text).
    const wrapped = wrapPlain(body, Math.max(10, width - 2));
    return wrapped.map((l) => `  ${this.theme.fg("text", sanitizeTerminalText(l))}`);
  }

  private openSelectedInEditor(): void {
    const id = this.state.selectedId ?? this.state.detailId;
    if (!id) return;
    const node = this.model.nodes.find((n) => n.id === id);
    if (!node || node.kind !== "note") return;
    const slug = node.detail.slug;
    if (!slug) return;
    void this.loaders.openNote(slug);
  }
}

/** Wrap plain text to a visible width, preserving newlines. */
function wrapPlain(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (para.length === 0) {
      out.push("");
      continue;
    }
    let col = 0;
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      if (col + visibleWidth(word) > width && line.length > 0) {
        out.push(line);
        line = word.trimStart();
        col = visibleWidth(line);
      } else {
        line += word;
        col += visibleWidth(word);
      }
    }
    out.push(line);
  }
  return out;
}

function t_fg(theme: WeaveTheme, slot: ThemeSlot, text: string): string {
  return theme.fg(slot, text);
}

// Re-export types the wiring/tests reach for.
export type { Component, GraphNode };