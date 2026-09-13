import { visibleWidth } from "@earendil-works/pi-tui";
import type { ThemeSlot } from "./theme";

/** The TUI uses one terminal-safe mark. */
export const MARK_GLYPH = "◈";
export const WORDMARK = "weave view";

export function renderMark(
  theme: { fg: (slot: ThemeSlot, text: string) => string },
  width: number,
): string {
  const mark = theme.fg("accent", MARK_GLYPH);
  return visibleWidth(mark) <= width ? mark : "";
}
