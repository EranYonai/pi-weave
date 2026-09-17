import { COLUMNS, resizeAt } from "./layout.model";
import type { DividerId, LayoutState } from "./layout.model";

export interface DragState { readonly divider: DividerId; readonly origin: number; readonly base: LayoutState }
export function beginDrag(divider: DividerId, origin: number, base: LayoutState): DragState { return { divider, origin, base }; }
export function dragTo(drag: DragState, clientX: number, available: number): LayoutState { return resizeAt(drag.base, drag.divider, clientX - drag.origin, available); }
export function dragChanged(drag: DragState, final: LayoutState): boolean {
  return COLUMNS.some((id) => drag.base.fractions[id] !== final.fractions[id]);
}
export const NUDGE_PX = 24;
export function nudgeFor(key: string): number { return key === "ArrowLeft" ? -NUDGE_PX : key === "ArrowRight" ? NUDGE_PX : 0; }

export function dividerHandlers(host: {
  layout(): LayoutState;
  width(): number;
  setLayout(next: LayoutState): void;
  persist(layout: LayoutState): void;
}) {
  let active: DragState | null = null;
  return {
    onDown(divider: DividerId, clientX: number) { active = beginDrag(divider, clientX, host.layout()); },
    onMove(clientX: number) { if (active !== null) host.setLayout(dragTo(active, clientX, host.width())); },
    onUp() {
      const drag = active;
      active = null;
      if (drag !== null && dragChanged(drag, host.layout())) host.persist(host.layout());
    },
    onKey(divider: DividerId, key: string) {
      const next = resizeAt(host.layout(), divider, nudgeFor(key), host.width());
      if (next === host.layout()) return;
      host.setLayout(next);
      host.persist(next);
    },
  };
}
