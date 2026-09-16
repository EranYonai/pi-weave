import { COLUMNS, resizeAt } from "./layout.model";
import type { DividerId, LayoutState } from "./layout.model";

export interface DragState { readonly divider: DividerId; readonly origin: number; readonly base: LayoutState; readonly pointerId: number }
export function beginDrag(divider: DividerId, origin: number, base: LayoutState, pointerId: number): DragState { return { divider, origin, base, pointerId }; }
export function dragTo(drag: DragState, clientX: number, available: number): LayoutState { return resizeAt(drag.base, drag.divider, clientX - drag.origin, available); }
export function dragChanged(drag: DragState, final: LayoutState): boolean {
  return COLUMNS.some((id) => drag.base.fractions[id] !== final.fractions[id]);
}
export const NUDGE_PX = 24;
export function nudgeFor(key: string): number { return key === "ArrowLeft" ? -NUDGE_PX : key === "ArrowRight" ? NUDGE_PX : 0; }

export interface DragHost {
  layout(): LayoutState;
  width(): number;
  setLayout(next: LayoutState): void;
  persist(layout: LayoutState): void;
}
export interface DividerHandlers {
  onDown(divider: DividerId, clientX: number, pointerId: number): void;
  onMove(clientX: number): void;
  onUp(): void;
  onKey(divider: DividerId, key: string): void;
}

export function dividerHandlers(host: DragHost): DividerHandlers {
  let active: DragState | null = null;
  return {
    onDown(divider, clientX, pointerId) { active = beginDrag(divider, clientX, host.layout(), pointerId); },
    onMove(clientX) { if (active !== null) host.setLayout(dragTo(active, clientX, host.width())); },
    onUp() {
      const drag = active;
      active = null;
      if (drag !== null && dragChanged(drag, host.layout())) host.persist(host.layout());
    },
    onKey(divider, key) {
      const next = resizeAt(host.layout(), divider, nudgeFor(key), host.width());
      if (next === host.layout()) return;
      host.setLayout(next);
      host.persist(next);
    },
  };
}
