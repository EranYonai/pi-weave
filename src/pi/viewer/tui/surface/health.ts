/**
 * surface/health.ts — the Health surface as a Component (weave-view-tui-v2 §6).
 *
 * Renders `healthModel` (staleness + link health). Enter on a health row with
 * a target opens that node in detail (emitted as a SurfaceEvent).
 */

import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { healthModel, sanitizeTerminalText } from "../model";
import { windowLines, type Surface, type SurfaceEvent, type SurfaceInit } from "./base";

export interface HealthSurfaceState {
  selectedId: string | null;
  scrollOffset: number;
}

export class HealthSurface implements Surface {
  readonly kind = "health" as const;
  private readonly ctx;
  private readonly onEvent: ((e: SurfaceEvent) => void) | undefined;
  state: HealthSurfaceState;
  paneRows = 24;

  constructor(init: SurfaceInit) {
    this.ctx = init.context;
    this.onEvent = init.onEvent;
    this.state = { selectedId: null, scrollOffset: 0 };
  }

  title(): string {
    return "Health";
  }

  setFocused(_focused: boolean): void {}

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
      if (row && row.target) this.onEvent?.({ type: "openDetail", id: row.target });
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
    const h = healthModel(this.ctx.model);
    return h.sections.flatMap((s) =>
      s.rows.filter((r) => r.target).map((r): { id: string; target?: string } => ({ id: r.id, target: r.target! })),
    );
  }

  render(width: number): string[] {
    const t = this.ctx.theme;
    const h = healthModel(this.ctx.model);
    const lines: { text: string; id?: string }[] = [];
    for (const s of h.sections) {
      lines.push({ text: t.bold(s.heading) });
      for (const r of s.rows) {
        lines.push({ text: sanitizeTerminalText(r.text), id: r.id });
      }
    }
    const selId = this.state.selectedId;
    const selLine = selId ? lines.findIndex((l) => l.id === selId) : -1;
    const marker = (text: string) => `› ${this.ctx.theme.bg("selectedBg", text)}`;
    const windowed = windowLines(lines.map((l) => l.text), selLine, this.state.scrollOffset, Math.max(5, this.paneRows), marker);
    return windowed.map((l) => truncateToWidth(l, width));
  }
}
