/**
 * src/core/view/time.ts — relTime + formatTreeMeta.
 *
 * `formatTreeMeta` must reproduce, byte for byte, the strings `TreeRow.meta`
 * used to carry when it was a pre-formatted string, so promoting the
 * view-models left terminal output unchanged.
 */

import { describe, expect, it } from "vitest";
import { formatTreeMeta, relTime, type TreeMeta } from "../../../src/core/view";

const NOW = Date.parse("2026-06-01T00:00:00.000Z");

describe("relTime", () => {
  it("renders relative human time across every bucket", () => {
    const now = Date.parse("2026-03-01T12:00:00Z");
    expect(relTime("2026-03-01T11:59:30Z", now)).toBe("just now");
    expect(relTime("2026-03-01T11:30:00Z", now)).toBe("30m ago");
    expect(relTime("2026-03-01T09:00:00Z", now)).toBe("3h ago");
    expect(relTime("2026-02-20T12:00:00Z", now)).toBe("9d ago");
    expect(relTime("2025-12-01T12:00:00Z", now)).toBe("3mo ago");
    expect(relTime("2024-03-01T12:00:00Z", now)).toBe("2y ago");
  });
  it("empty, undefined and unparseable inputs render as empty", () => {
    const now = Date.parse("2026-03-01T12:00:00Z");
    expect(relTime("", now)).toBe("");
    expect(relTime(undefined, now)).toBe("");
    expect(relTime("not-a-date", now)).toBe("");
  });
  it("a future timestamp clamps to just now rather than going negative", () => {
    const now = Date.parse("2026-03-01T12:00:00Z");
    expect(relTime("2026-03-02T12:00:00Z", now)).toBe("just now");
  });
});

describe("formatTreeMeta", () => {
  it("null renders as the empty string", () => {
    expect(formatTreeMeta(null, NOW)).toBe("");
  });
  it("relTime delegates to relTime against the supplied clock", () => {
    expect(formatTreeMeta({ kind: "relTime", iso: "2026-05-01T00:00:00.000Z" }, NOW)).toBe("1mo ago");
    // same value, a later clock → a different string (the reason meta is structured)
    const later = Date.parse("2027-06-01T00:00:00.000Z");
    expect(formatTreeMeta({ kind: "relTime", iso: "2026-05-01T00:00:00.000Z" }, later)).toBe("1y ago");
  });
  it("count renders unit=n for attribute phrasing and n unit for prose", () => {
    expect(formatTreeMeta({ kind: "count", n: 8, unit: "files", phrasing: "attribute" }, NOW)).toBe("files=8");
    expect(formatTreeMeta({ kind: "count", n: 5, unit: "files", phrasing: "prose" }, NOW)).toBe("5 files");
  });
  it("commit abbreviates to a 7-character sha and leaves short shas alone", () => {
    expect(formatTreeMeta({ kind: "commit", sha: "abcdef1234567890" }, NOW)).toBe("abcdef1");
    expect(formatTreeMeta({ kind: "commit", sha: "abc" }, NOW)).toBe("abc");
  });
  it("text passes through verbatim", () => {
    expect(formatTreeMeta({ kind: "text", text: "npm" }, NOW)).toBe("npm");
    expect(formatTreeMeta({ kind: "text", text: "summary" }, NOW)).toBe("summary");
  });
  it("covers every variant of the union", () => {
    const all: TreeMeta[] = [
      null,
      { kind: "relTime", iso: "2026-05-01T00:00:00.000Z" },
      { kind: "count", n: 1, unit: "files", phrasing: "attribute" },
      { kind: "count", n: 1, unit: "files", phrasing: "prose" },
      { kind: "commit", sha: "0123456789" },
      { kind: "text", text: "x" },
    ];
    expect(all.map((m) => formatTreeMeta(m, NOW))).toEqual(["", "1mo ago", "files=1", "1 files", "0123456", "x"]);
  });
});
