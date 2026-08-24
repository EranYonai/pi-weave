/**
 * surface/detail.ts — the Detail surface as a Component (weave-view-tui-v2 §6).
 *
 * Shows a node's meta, its (real Markdown) body, and links/backlinks. Each
 * Detail pane owns its own bound node + selection/scroll. Enter on a link
 * rebinds the pane in place (decision: a Detail pane re-navigates within
 * itself); the body is rendered through the pi-tui `Markdown` component with
 * a MarkdownTheme mapped from the weave theme (decision 7).
 */

import { Markdown, matchesKey, type MarkdownTheme, truncateToWidth } from "@earendil-works/pi-tui";
import { detailModel, sanitizeTerminalText, type DetailModel } from "../model";
import { kindStyle, provenanceStyle, type ThemeSlot } from "../theme";
import { type Surface, type SurfaceEvent, type SurfaceInit } from "./base";
import type { GraphModel } from "../../../../core/graph/model";
import type { NoteSource } from "../../../../core/types";

/** A flattened Detail render line. `id` marks a selectable row (meta/links/
 *  backlinks); `target` is the node id an Enter on that row rebinds to. Both
 *  are optional and may be explicitly `undefined` (body/header lines have
 *  neither) — declared `| undefined` so the object literals below type-check
 *  under `exactOptionalPropertyTypes`. */
type DetailLine = { text: string; id?: string | undefined; target?: string | undefined };

export interface DetailSurfaceState {
  nodeId: string | null;
  selectedId: string | null;
  scrollOffset: number;
  /** Goto-line buffer: `null`/undefined = not in goto mode; a string (possibly
   *  empty) = the user is typing a line number to jump to. `/` enters goto,
   *  digits append, Enter jumps, Backspace deletes, Esc cancels. The workspace
   *  root treats a non-null `gotoBuf` as a sub-mode so Esc cancels instead of
   *  quitting (mirrors Explore's `searching`). */
  gotoBuf?: string | null;
}

export function bindDetail(init: SurfaceInit, nodeId: string): DetailSurface {
  const s = new DetailSurface(init);
  s.state = { nodeId, selectedId: nodeId, scrollOffset: 0 };
  return s;
}

export class DetailSurface implements Surface {
  readonly kind = "detail" as const;
  private readonly ctx;
  private readonly onEvent: ((e: SurfaceEvent) => void) | undefined;
  state: DetailSurfaceState;
  paneRows = 24;
  /** Cached flattened render lines (with ids/targets) from the last render, so
   *  handleInput can compute the viewport center / active row + max scroll
   *  offset without re-rendering. Bust on invalidate / rebind. */
  private _lines: DetailLine[] | undefined;

  constructor(init: SurfaceInit) {
    this.ctx = init.context;
    this.onEvent = init.onEvent;
    this.state = { nodeId: init.context.model.nodes[0]?.id ?? null, selectedId: null, scrollOffset: 0 };
  }

  title(): string {
    return "Detail";
  }

  setFocused(_focused: boolean): void {
    // detail has no focus-only state
  }

  invalidate(): void {
    // Drop the cached line layout so the next render rebuilds it from the
    // current body (BodyStore loads fire onChange at the root → invalidate).
    this._lines = undefined;
  }

  rebind(model: GraphModel): void {
    // After a refresh, a detail pane may be bound to a node that was removed.
    // Rebind to the first surviving node so the pane never shows a stale
    // "(node not found)" after the model is rebuilt.
    if (this.state.nodeId && !model.nodes.some((n) => n.id === this.state.nodeId)) {
      const first = model.nodes[0]?.id ?? null;
      this.state = { nodeId: first, selectedId: first, scrollOffset: 0, gotoBuf: null };
      this._lines = undefined;
    }
  }

  handleInput(data: string): void {
    const paneRows = Math.max(5, this.paneRows);
    if (!this._lines) this._lines = this.buildLines(80);
    const maxOffset = Math.max(0, this._lines.length - paneRows);
    const clamp = (n: number): number => Math.max(0, Math.min(maxOffset, n));

    // Goto-line sub-mode: digits build a line number, Enter jumps, Esc/bs exit.
    if (this.state.gotoBuf != null) {
      if (matchesKey(data, "escape")) {
        this.state = { ...this.state, gotoBuf: null };
        return;
      }
      if (matchesKey(data, "enter")) {
        const n = parseInt(this.state.gotoBuf, 10);
        this.state = { ...this.state, scrollOffset: clamp(Number.isNaN(n) || n < 1 ? 0 : n - 1), gotoBuf: null };
        return;
      }
      if (matchesKey(data, "backspace")) {
        const b = this.state.gotoBuf.slice(0, -1);
        this.state = { ...this.state, gotoBuf: b.length ? b : null };
        return;
      }
      if (data.length === 1 && data >= "0" && data <= "9" && this.state.gotoBuf.length < 5) {
        this.state = { ...this.state, gotoBuf: this.state.gotoBuf + data };
        return;
      }
      return; // ignore unmapped keys while typing a line number
    }

    if (data === "o") {
      if (this.state.nodeId) this.onEvent?.({ type: "openEditor", id: this.state.nodeId });
      return;
    }
    // Scroll-primary: arrows/page/home/end move the viewport; the selectable
    // row nearest the viewport center is the active (›) row — Enter opens it.
    if (matchesKey(data, "up")) {
      this.state = { ...this.state, scrollOffset: clamp(this.state.scrollOffset - 1) };
      return;
    }
    if (matchesKey(data, "down")) {
      this.state = { ...this.state, scrollOffset: clamp(this.state.scrollOffset + 1) };
      return;
    }
    if (matchesKey(data, "pageUp")) {
      this.state = { ...this.state, scrollOffset: clamp(this.state.scrollOffset - paneRows) };
      return;
    }
    if (matchesKey(data, "pageDown")) {
      this.state = { ...this.state, scrollOffset: clamp(this.state.scrollOffset + paneRows) };
      return;
    }
    if (matchesKey(data, "home")) {
      this.state = { ...this.state, scrollOffset: 0 };
      return;
    }
    if (matchesKey(data, "end")) {
      this.state = { ...this.state, scrollOffset: maxOffset };
      return;
    }
    if (data === "/") {
      this.state = { ...this.state, gotoBuf: "" };
      return;
    }
    if (matchesKey(data, "enter")) {
      const row = this.activeRow();
      if (row?.target) {
        // rebind this detail pane to the target (Obsidian "open in main" in place)
        this.state = { nodeId: row.target, selectedId: row.target, scrollOffset: 0, gotoBuf: null };
        this._lines = undefined;
        this.requestBody(row.target);
      }
      return;
    }
  }

  /** The selectable row (meta/links/backlinks) nearest the viewport center. */
  private activeRow(): { id: string; target?: string | undefined } | undefined {
    const lines = this._lines;
    if (!lines) return undefined;
    const paneRows = Math.max(5, this.paneRows);
    const center = this.state.scrollOffset + Math.floor(paneRows / 2);
    let bestI = -1;
    let best = Infinity;
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i]!;
      if (!ln.id) continue;
      const d = Math.abs(i - center);
      if (d < best) {
        best = d;
        bestI = i;
      }
    }
    return bestI >= 0 ? { id: lines[bestI]!.id!, target: lines[bestI]!.target } : undefined;
  }

  /** Flatten the detail (title + meta + body + links + backlinks) into lines. */
  private buildLines(width: number): DetailLine[] {
    const t = this.ctx.theme;
    const id = this.state.nodeId;
    if (!id) return [];
    const d = detailModel(this.ctx.model, id);
    if (!d) return [];
    const lines: DetailLine[] = [];
    const marker = this.rowMarker(d.kind, d.provenance);
    const provBadge = d.provenance ? ` ${provenanceStyle(d.provenance).glyph} ${provenanceStyle(d.provenance).word}` : "";
    lines.push({ text: t.bold(`${marker}${sanitizeTerminalText(d.label)}`) + t.fg("muted", ` (${d.kind}${provBadge})`) });
    for (const m of d.meta) {
      lines.push({ text: `${t.fg("muted", sanitizeTerminalText(m.label))}: ${sanitizeTerminalText(m.value)}`, id: m.id });
    }
    const body = this.bodyLinesFor(id, width);
    for (const b of body) lines.push({ text: b });
    if (d.links.length > 0) {
      lines.push({ text: t.fg("accent", "Links") });
      for (const lk of d.links) {
        lines.push({ text: `  ${this.rowMarker(lk.kind, lk.provenance)}${sanitizeTerminalText(lk.label)}`, id: lk.id, target: lk.target });
      }
    }
    if (d.backlinks.length > 0) {
      lines.push({ text: t.fg("accent", "Backlinks") });
      for (const lk of d.backlinks) {
        lines.push({ text: `  ${this.rowMarker(lk.kind, lk.provenance)}${sanitizeTerminalText(lk.label)}`, id: lk.id, target: lk.target });
      }
    }
    return lines;
  }

  render(width: number): string[] {
    const t = this.ctx.theme;
    const id = this.state.nodeId;
    if (!id) return [t.fg("dim", "(no selection)")];
    const d = detailModel(this.ctx.model, id);
    if (!d) return [t.fg("dim", "(node not found)")];

    const lines = this.buildLines(width);
    this._lines = lines;
    const paneRows = Math.max(5, this.paneRows);
    const maxOffset = Math.max(0, lines.length - paneRows);
    const scrollOffset = Math.max(0, Math.min(this.state.scrollOffset, maxOffset));
    if (scrollOffset !== this.state.scrollOffset) {
      this.state = { ...this.state, scrollOffset };
    }

    // Active row = selectable row nearest the viewport center.
    const center = scrollOffset + Math.floor(paneRows / 2);
    let activeI = -1;
    let best = Infinity;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]!.id) continue;
      const dist = Math.abs(i - center);
      if (dist < best) {
        best = dist;
        activeI = i;
      }
    }
    const activeId = activeI >= 0 ? (lines[activeI]!.id ?? null) : null;
    if (this.state.selectedId !== activeId) {
      this.state = { ...this.state, selectedId: activeId };
    }

    const inGoto = this.state.gotoBuf != null;
    // Reserve the last viewport line for the goto prompt when active.
    const contentRows = inGoto ? Math.max(1, paneRows - 1) : paneRows;
    const start = scrollOffset;
    const end = Math.min(lines.length, start + contentRows);
    const marker2 = (text: string) => `› ${this.ctx.theme.bg("selectedBg", text)}`;
    const out: string[] = [];
    for (let i = start; i < end; i++) {
      out.push(i === activeI ? marker2(lines[i]!.text) : `  ${lines[i]!.text}`);
    }
    if (inGoto) {
      out.push(`${t.fg("accent", "/")}${this.state.gotoBuf}`);
    }
    return out.map((l) => truncateToWidth(l, width));
  }

  private rowMarker(kind: string, prov: NoteSource | null): string {
    const ks = kindStyle(kind as never);
    if (kind === "note") {
      const ps = provenanceStyle(prov);
      return ps.glyph ? `${ps.glyph} ` : "";
    }
    return `${this.ctx.theme.fg(ks.slot as ThemeSlot, `${ks.glyph} `)}`;
  }

  private requestBody(id: string): void {
    const node = this.ctx.model.nodes.find((n) => n.id === id);
    if (!node) return;
    if (node.kind === "note") this.ctx.bodies.load(id, "note", node.detail.slug);
    else if (node.kind === "file") this.ctx.bodies.load(id, "file", node.detail.path);
  }

  /** The node body, rendered through the real Markdown component (decision 7). */
  private bodyLinesFor(id: string, width: number): string[] {
    const node = this.ctx.model.nodes.find((n) => n.id === id);
    if (!node || (node.kind !== "note" && node.kind !== "file")) return [];
    if (this.ctx.bodies.isLoading(id)) return [this.ctx.theme.fg("dim", "(loading…)")];
    const body = this.ctx.bodies.get(id);
    if (body === undefined) {
      queueMicrotask(() => this.requestBody(id));
      return [this.ctx.theme.fg("dim", "(loading…)")];
    }
    if (body === null || body === "") return [];
    const md = new Markdown(sanitizeTerminalText(body), 0, 0, markdownTheme(this.ctx.theme), { color: (t) => this.ctx.theme.fg("text", t) }, { renderLatex: false });
    return md.render(Math.max(10, width - 2)).map((l) => `  ${l}`);
  }
}

/** Map the weave theme slots onto a pi-tui MarkdownTheme. */
export function markdownTheme(theme: {
  fg: (slot: ThemeSlot, text: string) => string;
  bold: (text: string) => string;
}): MarkdownTheme {
  return {
    heading: (t) => theme.bold(t),
    link: (t) => theme.fg("accent", t),
    linkUrl: (t) => theme.fg("muted", t),
    code: (t) => theme.fg("warning", t),
    codeBlock: (t) => theme.fg("text", t),
    codeBlockBorder: (t) => theme.fg("dim", t),
    quote: (t) => theme.fg("dim", t),
    quoteBorder: (t) => theme.fg("dim", t),
    hr: (t) => theme.fg("dim", t),
    listBullet: (t) => theme.fg("accent", t),
    bold: (t) => theme.bold(t),
    italic: (t) => t,
    strikethrough: (t) => t,
    underline: (t) => t,
  };
}

export type { DetailModel, GraphModel };
