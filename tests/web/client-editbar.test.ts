import { describe, expect, it } from "vitest";
import { AUTOSAVE_MS, FORMAT_TOOLS, applyFormat, editStatus, formatForKey } from "../../src/web/client/note/editbar.model";
import type { TextEdit } from "../../src/web/client/note/editbar.model";
import { ICONS } from "../../src/web/client/shell/icons.model";

const at = (value: string, start: number, end = start): TextEdit => ({ value, start, end });
const selected = (edit: TextEdit): string => edit.value.slice(edit.start, edit.end);

describe("edit bar status", () => {
  const base = { saving: false, failed: false, dirty: false, savedAt: null };

  it("puts a write in flight first, then a failure, then waiting edits", () => {
    expect(editStatus({ ...base, saving: true, failed: true, dirty: true })).toEqual({ kind: "saving", label: "Saving…" });
    expect(editStatus({ ...base, failed: true, dirty: true })).toEqual({ kind: "failed", label: "Not saved" });
    expect(editStatus({ ...base, dirty: true, savedAt: 1 })).toEqual({ kind: "pending", label: "Unsaved changes" });
  });

  it("says when the last save landed, or that nothing changed yet", () => {
    const status = editStatus({ ...base, savedAt: new Date("2026-10-12T12:04:00").getTime() });
    expect(status.kind).toBe("saved");
    expect(status.label).toMatch(/^Saved .*04/);
    expect(editStatus(base)).toEqual({ kind: "clean", label: "No changes yet" });
  });

  it("waits a short pause before writing", () => {
    expect(AUTOSAVE_MS).toBeGreaterThanOrEqual(1000);
    expect(AUTOSAVE_MS).toBeLessThanOrEqual(5000);
  });
});

describe("formatting buttons", () => {
  it("draws every tool from the icon sprite and binds the usual keys", () => {
    for (const tool of FORMAT_TOOLS) expect(ICONS[tool.icon], tool.kind).toBeDefined();
    expect(formatForKey("B")).toBe("bold");
    expect(formatForKey("i")).toBe("italic");
    expect(formatForKey("k")).toBe("link");
    expect(formatForKey("x")).toBeNull();
  });

  it("wraps a selection, keeping it selected", () => {
    const bold = applyFormat(at("ship it now", 5, 7), "bold");
    expect(bold.value).toBe("ship **it** now");
    expect(selected(bold)).toBe("it");
    expect(applyFormat(at("a b", 2, 3), "italic").value).toBe("a _b_");
    expect(applyFormat(at("see Launch", 4, 10), "wikilink").value).toBe("see [[Launch]]");
  });

  it("inserts a placeholder and selects it when nothing is selected", () => {
    const bold = applyFormat(at("x ", 2), "bold");
    expect(bold.value).toBe("x **bold text**");
    expect(selected(bold)).toBe("bold text");
    expect(selected(applyFormat(at("", 0), "wikilink"))).toBe("note title");
    const link = applyFormat(at("", 0), "link");
    expect(link.value).toBe("[link text](https://)");
    expect(selected(link)).toBe("link text");
  });

  it("turns selected text into a link and selects the address to type", () => {
    const link = applyFormat(at("read docs please", 5, 9), "link");
    expect(link.value).toBe("read [docs](https://) please");
    expect(selected(link)).toBe("https://");
  });

  it("toggles a heading on every selected line", () => {
    const on = applyFormat(at("one\ntwo\nthree", 1, 5), "heading");
    expect(on.value).toBe("## one\n## two\nthree");
    expect(selected(on)).toBe("## one\n## two");
    expect(applyFormat(at("### Title", 0), "heading").value).toBe("Title");
  });

  it("toggles task lines, upgrading bullets rather than nesting them", () => {
    expect(applyFormat(at("buy milk", 3), "task").value).toBe("- [ ] buy milk");
    expect(applyFormat(at("  - buy milk", 5), "task").value).toBe("  - [ ] buy milk");
    expect(applyFormat(at("- [x] done", 0), "task").value).toBe("done");
    expect(applyFormat(at("a\n- [ ] b", 0, 7), "task").value).toBe("- [ ] a\nb");
  });
});
