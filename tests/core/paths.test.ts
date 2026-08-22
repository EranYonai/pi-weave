import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoIndexDir, repoKnowledgeDir, resolveVaultRoot } from "../../src/core/paths";

describe("resolveVaultRoot", () => {
  it("defaults to ~/.okf", () => {
    expect(resolveVaultRoot({})).toBe(join(homedir(), ".okf"));
  });

  it("honours the PI_WEAVE_VAULT override", () => {
    expect(resolveVaultRoot({ PI_WEAVE_VAULT: "/tmp/custom-vault" })).toBe("/tmp/custom-vault");
  });

  it("ignores blank overrides", () => {
    expect(resolveVaultRoot({ PI_WEAVE_VAULT: "   " })).toBe(join(homedir(), ".okf"));
  });
});

describe("repo index paths", () => {
  it("builds the .okf index dir", () => {
    expect(repoIndexDir("/repo")).toBe(join("/repo", ".okf"));
  });

  it("builds the repository knowledge dir", () => {
    expect(repoKnowledgeDir("/repo")).toBe(join("/repo", ".okf", "repository"));
  });
});
