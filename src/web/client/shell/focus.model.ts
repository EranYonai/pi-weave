/**
 * Focus management for the modal surfaces (weave-workspace P4).
 *
 * P4's exit criterion is "the whole workspace is drivable without a mouse",
 * and a dialog that does not trap focus fails it in the most literal way
 * available: Tab from the last control lands on the header behind the
 * overlay, the user is now typing into a search box they cannot see, and
 * `Esc` goes to whatever they landed on. So the palette and the help overlay
 * both trap, and both restore.
 *
 * ## Why this is a model and not three lines in a `useEffect`
 *
 * Trapping is arithmetic — "which element is next, given the current one, a
 * direction, and a wrap" — and arithmetic in a `.tsx` is arithmetic no test
 * can reach (§10). {@link trapTarget} takes an array of focusables and an
 * index and returns an index; the component supplies the array from a
 * `querySelectorAll` and calls `.focus()` on the answer. Everything that can
 * be wrong is on this side of that line.
 *
 * The DOM types are deliberately absent: {@link Focusable} is a one-method
 * structural port that a real `HTMLElement` satisfies, so this file compiles
 * under the root `tsconfig.json` (no `DOM` lib) and the tests that import it
 * need no browser.
 */

/** The slice of an element this module uses. `HTMLElement` satisfies it. */
export interface Focusable {
  focus(): void;
}

/**
 * The selector for "things a user can Tab to", inside a dialog.
 *
 * `:not([disabled])` matters — a disabled control is not in the tab order,
 * and including one produces a trap with a dead stop in it. `tabindex="-1"`
 * is excluded for the same reason: it means *programmatically* focusable,
 * which is the opposite of what a Tab cycle wants.
 *
 * Kept here rather than in the component so the two overlays cannot drift
 * into two different definitions of what is focusable.
 */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * Where Tab should land next, or `null` to leave the event alone.
 *
 * Returns an **index** rather than an element so the whole thing is testable
 * with an array of numbers if you like. `null` means "not our business":
 * a trap over zero or one focusable elements has nothing to cycle, and
 * calling `preventDefault` in that case would strand the user on a dialog
 * that eats Tab and does nothing with it — strictly worse than an untrapped
 * one they can at least escape.
 *
 * @param count how many focusables the dialog contains
 * @param at the index of the currently focused one, or `-1` when focus is on
 *   the dialog container itself (which is where it starts)
 * @param backwards Shift+Tab
 */
export function trapTarget(count: number, at: number, backwards: boolean): number | null {
  if (count <= 1) return null;
  // Focus on the container itself: Tab enters at the top, Shift+Tab at the
  // bottom. Without this the first Tab out of a freshly-opened dialog would
  // compute from -1 and land on the second control, skipping the input.
  if (at < 0) return backwards ? count - 1 : 0;
  if (!backwards) return at === count - 1 ? 0 : at + 1;
  return at === 0 ? count - 1 : at - 1;
}

/**
 * Whether an event is the Tab a trap should act on.
 *
 * Modified Tab — ⌘Tab, Ctrl+Tab, Alt+Tab — belongs to the operating system or
 * the browser's tab strip, and intercepting it is both futile and rude. Shift
 * is the one modifier that is ours, because Shift+Tab *is* backwards Tab.
 */
export function isTrapTab(key: string, ctrl: boolean, meta: boolean, alt: boolean): boolean {
  return key === "Tab" && !ctrl && !meta && !alt;
}

/**
 * Restore focus to where it was before a dialog opened.
 *
 * A separate function for one reason: the null check. The previously-focused
 * element is whatever `document.activeElement` was at open time, and that is
 * legitimately `null` — a fresh page load where nothing has been clicked, or
 * a body that was itself focused. Returning `false` rather than throwing lets
 * the caller stay a one-liner, and the boolean is what the test asserts.
 */
export function restoreFocus(previous: Focusable | null): boolean {
  if (previous === null) return false;
  previous.focus();
  return true;
}
