/**
 * The focus trap (weave-workspace P4, §10).
 *
 * P4's exit criterion is "the whole workspace is drivable without a mouse",
 * and the way a modal fails it is specific: Tab from the last control escapes
 * to the header behind the overlay, the user is typing into a box they cannot
 * see, and the next `Esc` goes somewhere unrelated. So the arithmetic —
 * "given a count, a position and a direction, where does Tab land" — is a
 * pure function, tested here, and `FocusTrap.tsx` is left with the three
 * lines that genuinely need a document.
 *
 * The two negative cases matter as much as the cycle. A trap that
 * `preventDefault`s a Tab it has nowhere to send strands the user on a dialog
 * that eats the key and does nothing — strictly worse than no trap at all —
 * and a trap that intercepts ⌘Tab is fighting the operating system.
 */

import { describe, expect, it } from "vitest";
import { FOCUSABLE_SELECTOR, isTrapTab, restoreFocus, trapTarget } from "../../src/web/client/shell/focus.model";

describe("trapTarget", () => {
  it("cycles forwards, wrapping at the end", () => {
    expect(trapTarget(3, 0, false)).toBe(1);
    expect(trapTarget(3, 1, false)).toBe(2);
    expect(trapTarget(3, 2, false)).toBe(0);
  });

  it("cycles backwards, wrapping at the start", () => {
    expect(trapTarget(3, 2, true)).toBe(1);
    expect(trapTarget(3, 0, true)).toBe(2);
  });

  it("enters at the top from the dialog container itself", () => {
    // Focus starts on the dialog (so a screen reader announces its role and
    // label), which is index -1. Without this branch the first Tab would
    // compute from -1 and land on the *second* control, skipping the input.
    expect(trapTarget(3, -1, false)).toBe(0);
    expect(trapTarget(3, -1, true)).toBe(2);
  });

  it("declines to act when there is nothing to cycle", () => {
    // `null` means "leave the event alone". Calling `preventDefault` here
    // would produce a dialog that swallows Tab and does nothing with it.
    expect(trapTarget(0, -1, false)).toBeNull();
    expect(trapTarget(1, 0, false)).toBeNull();
    expect(trapTarget(1, 0, true)).toBeNull();
  });
});

describe("isTrapTab", () => {
  it("claims plain Tab and Shift+Tab", () => {
    expect(isTrapTab("Tab", false, false, false)).toBe(true);
  });

  it("leaves OS and browser combinations alone", () => {
    // ⌘Tab, Ctrl+Tab and Alt+Tab belong to the window manager or the tab
    // strip. Intercepting them is both futile and rude.
    expect(isTrapTab("Tab", true, false, false)).toBe(false);
    expect(isTrapTab("Tab", false, true, false)).toBe(false);
    expect(isTrapTab("Tab", false, false, true)).toBe(false);
  });

  it("is not interested in any other key", () => {
    expect(isTrapTab("Enter", false, false, false)).toBe(false);
  });
});

describe("restoreFocus", () => {
  it("focuses the remembered element and says so", () => {
    let focused = 0;
    expect(restoreFocus({ focus: () => void focused++ })).toBe(true);
    expect(focused).toBe(1);
  });

  it("is a no-op when nothing was focused before the dialog opened", () => {
    // Legitimately reachable: a fresh page where nothing has been clicked.
    expect(restoreFocus(null)).toBe(false);
  });
});

describe("FOCUSABLE_SELECTOR", () => {
  it("excludes disabled controls, which are not in the tab order", () => {
    // Including one produces a cycle with a dead stop in it.
    expect(FOCUSABLE_SELECTOR).toContain("button:not([disabled])");
    expect(FOCUSABLE_SELECTOR).toContain("input:not([disabled])");
  });

  it('excludes tabindex="-1", which means programmatically focusable', () => {
    // Which is the opposite of what a Tab cycle wants — and it is what the
    // dialog container itself carries.
    expect(FOCUSABLE_SELECTOR).toContain('[tabindex]:not([tabindex="-1"])');
  });

  it("is one definition, shared by both overlays", () => {
    // Two dialogs with two ideas of what is focusable is how one of them
    // silently stops trapping.
    expect(FOCUSABLE_SELECTOR.split(",").length).toBeGreaterThan(3);
  });
});
