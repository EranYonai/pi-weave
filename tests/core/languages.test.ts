import { describe, expect, it } from "vitest";
import { languageForExtension } from "../../src/core/languages";

describe("languageForExtension", () => {
  it("maps common extensions", () => {
    expect(languageForExtension(".ts")).toBe("TypeScript");
    expect(languageForExtension(".py")).toBe("Python");
    expect(languageForExtension(".rs")).toBe("Rust");
    expect(languageForExtension(".go")).toBe("Go");
  });

  it("accepts extensions without a leading dot", () => {
    expect(languageForExtension("md")).toBe("Markdown");
  });

  it("is case-insensitive", () => {
    expect(languageForExtension(".TS")).toBe("TypeScript");
    expect(languageForExtension("YAML")).toBe("YAML");
  });

  it("returns undefined for unknown extensions", () => {
    expect(languageForExtension(".xyz")).toBeUndefined();
  });

  it("handles compound/scripting domains", () => {
    expect(languageForExtension(".tf")).toBe("Terraform");
    expect(languageForExtension(".vue")).toBe("Vue");
    expect(languageForExtension(".dockerfile")).toBe("Dockerfile");
  });
});
