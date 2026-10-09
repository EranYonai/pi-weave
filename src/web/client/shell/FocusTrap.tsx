/**
 * The DOM half of the focus trap (weave-workspace P4, §10).
 *
 * `focus.model.ts` decides *which* index Tab should land on; this hook does
 * the three things that require a real document and cannot be decided:
 * remember what was focused, focus the dialog, and put focus back on unmount.
 * There is no branch here that `trapTarget` and `restoreFocus` do not already
 * own — the `?? null`s are DOM nullability, not decisions.
 *
 * Isolated in a `.tsx` for `renderer.dom.ts`'s reason: it names
 * `document.activeElement` and `HTMLElement`, which do not exist in the root
 * `tsconfig.json` project, so anything importing it can only be compiled by
 * `tsconfig.web.json`.
 */

import { useEffect, useRef } from "preact/hooks";
import { FOCUSABLE_SELECTOR, isTrapTab, restoreFocus, trapTarget } from "./focus.model";

/** What {@link useFocusTrap} hands back to the dialog. */
export interface FocusTrapHandle {
  /** Put on the dialog element. */
  readonly ref: { current: HTMLElement | null };
  /** Call from the dialog's `onKeyDown`. Returns whether it consumed the key. */
  onKeyDown(event: KeyboardEvent): boolean;
}

/**
 * Trap focus inside an element while it is mounted, and restore it after.
 *
 * The dialog itself is focused on mount rather than its first control,
 * deliberately: a screen reader announces the dialog's `aria-label` and role
 * on arrival, which a jump straight to the input would skip. `trapTarget`
 * handles the resulting `at === -1` explicitly for exactly this case.
 */
export function useFocusTrap(): FocusTrapHandle {
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.focus();
    return () => void restoreFocus(previous instanceof HTMLElement ? previous : null);
  }, []);

  return {
    ref,
    onKeyDown(event) {
      if (!isTrapTab(event.key, event.ctrlKey, event.metaKey, event.altKey)) return false;
      const items = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])];
      const target = trapTarget(items.length, items.indexOf(document.activeElement as HTMLElement), event.shiftKey);
      if (target === null) return false;
      event.preventDefault();
      items[target]?.focus();
      return true;
    },
  };
}
