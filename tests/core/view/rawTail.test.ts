import { describe, expect, it } from "vitest";
import { joinRawTail, rawTailBoundary, splitRawTail } from "../../../src/core/view/rawTail";

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
