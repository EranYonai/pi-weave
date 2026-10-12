import { describe, expect, it } from "vitest";
import { joinRawOpening, joinRawTail, rawTailBoundary, splitRawOpening, splitRawTail } from "../../../src/core/view/rawTail";

const NOTICE = "<!-- NEVER edit below this line. Verbatim user input preserved here. -->";
const TAIL = `---\n\n## Raw\n${NOTICE}\n\n\`\`\`\ndictated\n\`\`\``;

describe("splitRawTail", () => {
  it("splits at the rule above the heading, not at the heading", () => {
    expect(splitRawTail(`Body.\n\n${TAIL}\n`)).toEqual({ head: "Body.", tail: TAIL });
  });

  it("returns the whole body as head when there is no tail", () => {
    expect(splitRawTail("Just prose.\n\n")).toEqual({ head: "Just prose.", tail: "" });
    expect(splitRawTail("")).toEqual({ head: "", tail: "" });
  });

  it("treats a body that is only a tail as an empty head", () => {
    expect(splitRawTail(TAIL)).toEqual({ head: "", tail: TAIL });
  });

  it("splits at the heading when no rule precedes it", () => {
    expect(splitRawTail("Body.\n\n## Raw\nscribble")).toEqual({ head: "Body.", tail: "## Raw\nscribble" });
  });

  it("ignores a `## Raw` inside a fenced sample and a `## Rawhide` heading", () => {
    const sample = "Docs:\n\n```md\n## Raw\n```\n\n## Rawhide\nmore";
    expect(splitRawTail(sample)).toEqual({ head: sample, tail: "" });
    expect(splitRawTail(`${sample}\n\n${TAIL}`)).toEqual({ head: sample, tail: TAIL });
  });

  it("reports the body length as the boundary of a tail-less body", () => {
    expect(rawTailBoundary("abc")).toBe(3);
  });
});

describe("joinRawTail", () => {
  it("is the inverse of splitRawTail", () => {
    const body = `Body.\n\n${TAIL}`;
    const { head, tail } = splitRawTail(body);
    expect(joinRawTail(head, tail)).toBe(body);
  });

  it("leaves an absent tail and an empty head alone", () => {
    expect(joinRawTail("Body.", "")).toBe("Body.");
    expect(joinRawTail("", TAIL)).toBe(TAIL);
  });
});

describe("splitRawOpening / joinRawOpening", () => {
  const OPENING = `---\n\n## Raw\n${NOTICE}`;
  const ENTRY = "<!-- appended 2026-10-11 09:04 -->\n```\ndictated\n```";

  it("keeps the rule, heading and notice out of the editable entries", () => {
    expect(splitRawOpening(`${OPENING}\n\n${ENTRY}`)).toEqual({ opening: OPENING, entries: ENTRY });
  });

  it("round-trips an unchanged tail", () => {
    const tail = `${OPENING}\n\n${ENTRY}\n\n${ENTRY}`;
    const { opening, entries } = splitRawOpening(tail);
    expect(joinRawOpening(opening, entries)).toBe(tail);
  });

  it("does not take an appended entry for the notice", () => {
    expect(splitRawOpening(`## Raw\n${ENTRY}`)).toEqual({ opening: "## Raw", entries: ENTRY });
  });

  it("handles a heading with nothing under it, or a tail without a heading", () => {
    expect(splitRawOpening("## Raw")).toEqual({ opening: "## Raw", entries: "" });
    expect(splitRawOpening(OPENING)).toEqual({ opening: OPENING, entries: "" });
    expect(splitRawOpening("")).toEqual({ opening: "", entries: "" });
  });

  it("drops the whole tail when the entries are cleared, and trims edited ones", () => {
    expect(joinRawOpening(OPENING, "  \n ")).toBe("");
    expect(joinRawOpening(OPENING, "\n\nmy words\n\n")).toBe(`${OPENING}\n\nmy words`);
  });
});
