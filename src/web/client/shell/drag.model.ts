/**
 * Divider dragging, as pure state (weave-workspace §1.2).
 *
 * `layout.model.ts` already owns the arithmetic — {@link resizeAt} converts a
 * pixel delta into clamped, normalised fractions. What it does not own is the
 * *gesture*: where the pointer went down, how far it has travelled since, and
 * when the result should be persisted. That is this file, and it is separate
 * for the usual reason — a gesture living inside `Divider.tsx` would be
 * untestable without a DOM (§10), and a drag that mis-clamps is exactly the
 * bug a unit test catches and a glance at the screen does not.
 *
 * ## Deltas are measured from the gesture's origin, never frame to frame
 *
 * A `pointermove` handler that applied `event.movementX` to the current
 * layout would accumulate error: `resizeAt` clamps, so any movement the clamp
 * swallowed is lost, and the divider then trails the pointer by however much
 * was discarded. Storing the layout as it was at `pointerdown` and applying
 * the *total* offset each time makes the divider track the pointer exactly,
 * and makes dragging into a wall and back out again return to where it
 * started rather than to wherever the drift left it.
 */

import type { DividerId, LayoutState } from "./layout.model";
import { resizeAt } from "./layout.model";

/**
 * A gesture in progress.
 *
 * `origin` is the pointer x at `pointerdown`; `base` is the layout as it was
 * at that instant. Both are needed to satisfy the total-offset rule above.
 */
export interface DragState {
  readonly divider: DividerId;
  readonly origin: number;
  readonly base: LayoutState;
  /** `setPointerCapture` id, so the shell can release exactly this pointer. */
  readonly pointerId: number;
}

/** Begin a drag. */
export function beginDrag(divider: DividerId, clientX: number, layout: LayoutState, pointerId: number): DragState {
  return { divider, origin: clientX, base: layout, pointerId };
}

/**
 * The layout for a pointer position during a drag.
 *
 * Always derived from `base`, never from the previous frame — see the module
 * header. `resizeAt` returns its input identically when nothing moved, so a
 * pointer jittering by a subpixel at a clamped edge produces the same object
 * and wakes no signal subscribers.
 */
export function dragTo(drag: DragState, clientX: number, available: number): LayoutState {
  return resizeAt(drag.base, drag.divider, clientX - drag.origin, available);
}

/**
 * Whether a completed drag actually changed anything.
 *
 * The persistence trigger. A click on a divider with no movement is a
 * `pointerdown`/`pointerup` pair that should not write to `localStorage`, and
 * a drag that was entirely absorbed by the clamp should not either. Compares
 * the three fractions rather than object identity, because `resizeAt`
 * normalises and can return an equal-but-distinct object.
 */
export function dragChanged(drag: DragState, final: LayoutState): boolean {
  const a = drag.base.fractions;
  const b = final.fractions;
  return a.tree !== b.tree || a.note !== b.note || a.graph !== b.graph;
}

/**
 * The keyboard nudge, in pixels.
 *
 * A divider is a `separator` with `tabindex`, so it must be operable from the
 * keyboard — §11's P4 makes the whole workspace keyboard-drivable, and a
 * control that can only be dragged is one that has to be retrofitted then. 24
 * px is a visible step without being a jump.
 */
export const NUDGE_PX = 24;

/**
 * Map an arrow key to a signed nudge, or `0` for any other key.
 *
 * Returning `0` rather than `null` lets the caller feed the result straight
 * into `resizeAt`, which already treats a zero delta as "return the state
 * unchanged" — one branch instead of two, and the one that exists is already
 * covered.
 */
export function nudgeFor(key: string): number {
  if (key === "ArrowLeft") return -NUDGE_PX;
  if (key === "ArrowRight") return NUDGE_PX;
  return 0;
}

// --- the gesture, as a unit -----------------------------------------------------

/**
 * What {@link dividerHandlers} needs from the component around it.
 *
 * Accessors rather than values, because a handler installed on one render
 * must see the layout as it is when the pointer moves, not as it was when the
 * closure was built. A stale `layout` here is the classic React/Preact
 * gesture bug: the drag applies to a snapshot and the divider jumps back on
 * the next render.
 */
export interface DragHost {
  layout(): LayoutState;
  /** Container width in CSS pixels. */
  width(): number;
  /** Publish a new layout (a `setState`). */
  setLayout(next: LayoutState): void;
  /** Persist a layout. Called on release and on a keyboard nudge, never per frame. */
  persist(layout: LayoutState): void;
}

/** The four callbacks a {@link Divider} needs. */
export interface DividerHandlers {
  onDown(divider: DividerId, clientX: number, pointerId: number): void;
  onMove(clientX: number): void;
  onUp(): void;
  onKey(divider: DividerId, key: string): void;
}

/**
 * Build the divider gesture handlers over a host.
 *
 * This lives here rather than as four `useCallback`s in `Shell.tsx` for the
 * reason §10 gives: the ordering rules they encode are real logic — persist
 * on release but not per frame, ignore a move with no gesture in progress,
 * persist a keyboard nudge immediately because there is no release to wait
 * for — and logic inside a `.tsx` is logic no test can reach. The component
 * is left holding a ref and a `setState`.
 *
 * The mutable gesture is kept in the closure rather than in component state
 * on purpose: a `pointermove` at 120 Hz writing to `useState` would rerender
 * the whole shell on every frame to store a value nothing renders.
 */
export function dividerHandlers(host: DragHost): DividerHandlers {
  let active: DragState | null = null;

  return {
    onDown(divider, clientX, pointerId) {
      active = beginDrag(divider, clientX, host.layout(), pointerId);
    },

    onMove(clientX) {
      // No gesture in progress: a plain hover over the divider, which fires
      // `pointermove` just as a drag does.
      if (active !== null) host.setLayout(dragTo(active, clientX, host.width()));
    },

    onUp() {
      const finished = active;
      active = null;
      // Persisted only if something actually moved — a click on a divider,
      // and a drag entirely absorbed by the clamp, both write nothing.
      if (finished !== null && dragChanged(finished, host.layout())) host.persist(host.layout());
    },

    onKey(divider, key) {
      const next = resizeAt(host.layout(), divider, nudgeFor(key), host.width());
      // `resizeAt` returns its input identically for an unhandled key, so a
      // `Tab` or an `Enter` on a focused divider costs nothing.
      if (next === host.layout()) return;
      host.setLayout(next);
      host.persist(next);
    },
  };
}
