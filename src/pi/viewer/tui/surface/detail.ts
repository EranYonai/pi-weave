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
import { windowLines, type Surface, type SurfaceEvent, type SurfaceInit } from "./base";
import type { GraphModel } from "../../../../core/graph/model";
import type { NoteSource } from "../../../../core/types";

export interface DetailSurfaceState {
  nodeId: string | null;
  selectedId: string | null;
  scrollOffset: number;
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
    // body loads bust through BodyStore onChange at the root
  }

  handleInput(data: string): void {
    if (data === "o") {
      if (this.state.nodeId) this.onEvent?.({ type: "openEditor", id: this.state.nodeId });
      return;
    }
    if (matchesKey(data, "up")) return this.move(-1);
    if (matchesKey(data, "down")) return this.move(1);
    if (matchesKey(data, "pageUp")) return this.movePage(-1);
    if (matchesKey(data, "pageDown")) return this.movePage(1);
    if (matchesKey(data, "home")) {
      this.state = { ...this.state, selectedId: this.rows()[0]?.id ?? null, scrollOffset: 0 };
      return;
    }
    if (matchesKey(data, "end")) {
      const r = this.rows();
      const last = r[r.length - 1];
      this.state = { ...this.state, selectedId: last?.id ?? null, scrollOffset: Math.max(0, r.length - this.paneRows) };
      return;
    }
    if (matchesKey(data, "enter")) {
      const rows = this.rows();
      const idx = rows.findIndex((r) => r.id === this.state.selectedId);
      const row = idx >= 0 ? rows[idx] : undefined;
      if (row && row.target) {
        // rebind this detail pane to the target (Obsidian "open in main" in place)
        this.state = { nodeId: row.target, selectedId: row.target, scrollOffset: 0 };
        this.requestBody(row.target);
      }
      return;
    }
  }

  private move(delta: 1 | -1): void {
    const rows = this.rows();
    if (rows.length === 0) return;
    const idx = rows.findIndex((r) => r.id === this.state.selectedId);
    const nextIdx = Math.max(0, Math.min(rows.length - 1, (idx < 0 ? -1 : idx) + delta));
    const row = rows[nextIdx]!;
    this.state = { ...this.state, selectedId: row.id, scrollOffset: this.state.scrollOffset };
  }

  private movePage(dir: 1 | -1): void {
    const rows = this.rows();
    const idx = rows.findIndex((r) => r.id === this.state.selectedId);
    const target = idx < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, idx + dir * this.paneRows));
    const row = rows[target];
    if (row) this.state = { ...this.state, selectedId: row.id };
  }

  /** Selectable rows: meta + links + backlinks. */
  private rows(): { id: string; target?: string }[] {
    const d = this.state.nodeId ? detailModel(this.ctx.model, this.state.nodeId) : null;
    if (!d) return [];
    return [
      ...d.meta.map((m) => ({ id: m.id })),
      ...d.links.map((l) => ({ id: l.id, target: l.target })),
      ...d.backlinks.map((l) => ({ id: l.id, target: l.target })),
    ];
  }

  render(width: number): string[] {
    const t = this.ctx.theme;
    const id = this.state.nodeId;
    if (!id) return [t.fg("dim", "(no selection)")];
    const d = detailModel(this.ctx.model, id);
    if (!d) return [t.fg("dim", "(node not found)")];

    const lines: { text: string; id?: string }[] = [];
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
        lines.push({ text: `  ${this.rowMarker(lk.kind, lk.provenance)}${sanitizeTerminalText(lk.label)}`, id: lk.id });
      }
    }
    if (d.backlinks.length > 0) {
      lines.push({ text: t.fg("accent", "Backlinks") });
      for (const lk of d.backlinks) {
        lines.push({ text: `  ${this.rowMarker(lk.kind, lk.provenance)}${sanitizeTerminalText(lk.label)}`, id: lk.id });
      }
    }

    const selId = this.state.selectedId;
    const selLine = selId ? lines.findIndex((l) => l.id === selId) : -1;
    const marker2 = (text: string) => `› ${this.ctx.theme.bg("selectedBg", text)}`;
    const windowed = windowLines(lines.map((l) => l.text), selLine, this.state.scrollOffset, Math.max(5, this.paneRows), marker2);
    return windowed.map((l) => truncateToWidth(l, width));
  }

  private rowMarker(kind: string, prov: NoteSource | null): string {
    const ks = kindStyle(kind as never);
    if (kind === "note") {
      const ps = provenanceStyle(prov);
      return ps.glyph ? `${ps.glyph} ` : "";
    }
    return ks.glyph ? `${this.ctx.theme.fg(ks.slot as ThemeSlot, `${ks.glyph} `)}` : "";
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
