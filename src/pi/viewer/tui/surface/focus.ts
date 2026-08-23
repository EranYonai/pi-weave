/**
 * surface/focus.ts — the Focus surface as a Component (weave-view-tui-v2 §6).
 *
 * The 1-hop graph neighborhood (`focusModel`). Enter re-centers the focus on
 * the selected neighbor, walking the graph. Each Focus pane owns its own
 * center node + selection/scroll.
 */

import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { focusModel, sanitizeTerminalText } from "../model";
import { kindStyle, provenanceStyle, type ThemeSlot } from "../theme";
import { windowLines, type Surface, type SurfaceEvent, type SurfaceInit } from "./base";
import type { NoteSource } from "../../../../core/types";

export interface FocusSurfaceState {
  focusId: string | null;
  selectedId: string | null;
  scrollOffset: number;
}

export class FocusSurface implements Surface {
  readonly kind = "focus" as const;
  private readonly ctx;
  private readonly onEvent: ((e: SurfaceEvent) => void) | undefined;
  state: FocusSurfaceState;
  paneRows = 24;

  constructor(init: SurfaceInit) {
    this.ctx = init.context;
    this.onEvent = init.onEvent;
    this.state = { focusId: null, selectedId: null, scrollOffset: 0 };
  }

  /** Bind the focus center node (called when opening/`f`). */
  setFocus(nodeId: string): void {
    this.state = { focusId: nodeId, selectedId: nodeId, scrollOffset: 0 };
  }

  setFocused(_focused: boolean): void {}

  title(): string {
    return "Focus";
  }

  invalidate(): void {}

  handleInput(data: string): void {
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
      if (row && row.target && row.target !== this.state.focusId) {
        this.state = { focusId: row.target, selectedId: row.target, scrollOffset: 0 };
      }
      return;
    }
    if (data === "g") {
      this.onEvent?.({ type: "focusNode", id: this.state.focusId ?? "" });
      return;
    }
  }

  private move(delta: 1 | -1): void {
    const rows = this.rows();
    if (rows.length === 0) return;
    const idx = rows.findIndex((r) => r.id === this.state.selectedId);
    const nextIdx = Math.max(0, Math.min(rows.length - 1, (idx < 0 ? -1 : idx) + delta));
    const row = rows[nextIdx]!;
    this.state = { ...this.state, selectedId: row.id };
  }

  private movePage(dir: 1 | -1): void {
    const rows = this.rows();
    const idx = rows.findIndex((r) => r.id === this.state.selectedId);
    const target = idx < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, idx + dir * this.paneRows));
    const row = rows[target];
    if (row) this.state = { ...this.state, selectedId: row.id };
  }

  private rows(): { id: string; target?: string }[] {
    if (!this.state.focusId) return [];
    const f = focusModel(this.ctx.model, this.state.focusId);
    const center: { id: string; target?: string } = f.center.target ? { id: f.center.id, target: f.center.target } : { id: f.center.id };
    return [center, ...f.groups.flatMap((g) => g.rows.map((r): { id: string; target?: string } => ({ id: r.id, target: r.target! })))];
  }

  render(width: number): string[] {
    const t = this.ctx.theme;
    const id = this.state.focusId;
    if (!id) return [t.fg("dim", "(no focus node)")];
    const f = focusModel(this.ctx.model, id);
    const lines: { text: string; id?: string }[] = [];
    const cm = this.rowMarker(f.center.kind, f.center.provenance);
    lines.push({ text: t.bold(`${cm}${sanitizeTerminalText(f.center.label)}`) + t.fg("dim", "  (focus — g/esc to exit)"), id: f.center.id });
    for (const g of f.groups) {
      lines.push({ text: t.fg("accent", g.heading) });
      for (const r of g.rows) {
        lines.push({ text: `  ${this.rowMarker(r.kind, r.provenance)}${sanitizeTerminalText(r.label)}`, id: r.id });
      }
    }
    const selId = this.state.selectedId;
    const selLine = selId ? lines.findIndex((l) => l.id === selId) : -1;
    const marker = (text: string) => `› ${this.ctx.theme.bg("selectedBg", text)}`;
    const windowed = windowLines(lines.map((l) => l.text), selLine, this.state.scrollOffset, Math.max(5, this.paneRows), marker);
    return windowed.map((l) => truncateToWidth(l, width));
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
