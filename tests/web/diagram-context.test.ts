import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { diagramContext, parseDiagramArgs, runDiagramContext } from "../../src/web/server/diagram-context";
import { createWorkspaceStateStore } from "../../src/web/server/workspace-state";
import { initialLayout } from "../../src/web/shared/workspace";
import { makeTempDir, withVaultEnv } from "../helpers";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("diagram authoring context", () => {
  it("parses explicit overrides and rejects invalid or missing values", () => {
    expect(parseDiagramArgs(["--cwd", "repo", "--theme", "paper-blue", "--accent", "rose", "--scheme", "dark"]))
      .toEqual({ cwd: "repo", theme: "paper-blue", accent: "rose", scheme: "dark" });
    expect(parseDiagramArgs(["--accent", "theme"])).toEqual({ accent: "theme" });
    for (const args of [["--cwd"], ["--cwd", "--theme"], ["--theme", "bogus"], ["--accent", "toString"], ["--scheme", "system"], ["--unknown", "x"]]) {
      expect(() => parseDiagramArgs(args)).toThrow();
    }
  });

  it("reports unsaved defaults and exposes both system palettes without writing", async () => {
    const cwd = await makeTempDir();
    const vault = await makeTempDir();
    const state = await makeTempDir();
    await withVaultEnv(vault, async () => {
      const result = await diagramContext({ cwd }, state);
      expect(result).toMatchObject({ vaultRoot: vault, notesRoot: join(vault, "notes"), themeSource: "default", selectedTheme: "system", needsScheme: true });
      expect("palettes" in result && result.palettes.light.scheme).toBe("light");
      expect("palettes" in result && result.palettes.dark.scheme).toBe("dark");
      expect(await fs.readdir(state)).toEqual([]);
      expect(await fs.readdir(vault)).toEqual([]);
    });
  });

  it("uses saved explicit theme/accent and lets explicit overrides win", async () => {
    const cwd = await makeTempDir();
    const vault = await makeTempDir();
    const state = await makeTempDir();
    await createWorkspaceStateStore(cwd, vault, state).write("1e7d9d0a-21f2-4d27-a522-5673e4e31f7b", {
      ...initialLayout(), theme: "ink-blue", preferences: { ...initialLayout().preferences, accent: "rose" },
    });
    await withVaultEnv(vault, async () => {
      const saved = await diagramContext({ cwd, scheme: "light" }, state);
      expect(saved).toMatchObject({ themeSource: "workspace", needsScheme: false, palette: { theme: "ink-blue", accent: "rose", scheme: "dark" } });
      expect(await diagramContext({ cwd, theme: "paper-blue", accent: "theme" }, state))
        .toMatchObject({ themeSource: "explicit", palette: { theme: "paper-blue", accent: "theme" } });
    });
  });

  it("anchors a relative vault override to the requested workspace", async () => {
    const cwd = await makeTempDir();
    const vault = join(cwd, "review-vault");
    const state = await makeTempDir();
    await fs.mkdir(vault);
    await createWorkspaceStateStore(cwd, vault, state).write("1e7d9d0a-21f2-4d27-a522-5673e4e31f7b", {
      ...initialLayout(), theme: "ink-blue",
    });
    await withVaultEnv("./review-vault", async () => {
      expect(await diagramContext({ cwd }, state)).toMatchObject({
        vaultRoot: vault, notesRoot: join(vault, "notes"), themeSource: "workspace", selectedTheme: "ink-blue",
      });
    });
  });

  it("resolves only an explicit system scheme using saved light/dark choices", async () => {
    const cwd = await makeTempDir();
    const vault = await makeTempDir();
    const state = await makeTempDir();
    await createWorkspaceStateStore(cwd, vault, state).write("1e7d9d0a-21f2-4d27-a522-5673e4e31f7b", {
      ...initialLayout(), preferences: { ...initialLayout().preferences, lightTheme: "mist-teal", darkTheme: "forest-teal" },
    });
    await withVaultEnv(vault, async () => {
      const unresolved = await diagramContext({ cwd }, state);
      expect("palettes" in unresolved && unresolved.palettes.light.theme).toBe("mist-teal");
      expect("palettes" in unresolved && unresolved.palettes.dark.theme).toBe("forest-teal");
      for (const scheme of ["light", "dark"] as const) {
        expect(await diagramContext({ cwd, scheme }, state)).toMatchObject({ needsScheme: false, palette: { theme: scheme === "light" ? "mist-teal" : "forest-teal" } });
      }
    });
  });

  it("prints machine-readable context and fails invalid arguments", async () => {
    const vault = await makeTempDir();
    vi.stubEnv("XDG_CONFIG_HOME", await makeTempDir());
    await withVaultEnv(vault, async () => {
      let output = "";
      await runDiagramContext(["--theme", "dark"], (text) => { output = text; });
      expect(JSON.parse(output)).toMatchObject({ themeSource: "explicit", palette: { theme: "dark" } });
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      await runDiagramContext(["--scheme", "light"]);
      expect(JSON.parse(stdout.mock.calls[0]![0] as string)).toMatchObject({ needsScheme: false, palette: { scheme: "light" } });
      await expect(runDiagramContext(["--theme", "missing"])).rejects.toThrow("Invalid option");
    });
  });
});
