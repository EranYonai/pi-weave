import { describe, expect, it } from "vitest";
import { BOOTSTRAP_ELEMENT_ID } from "../../src/web/shared/wire";

describe("wire constants", () => {
  it("uses a safe bootstrap element id", () => {
    expect(BOOTSTRAP_ELEMENT_ID).toBe("weave-bootstrap");
    expect(BOOTSTRAP_ELEMENT_ID).toMatch(/^[a-z][a-z0-9-]*$/);
  });
});
