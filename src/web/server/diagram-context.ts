import { resolve } from "node:path";
import { NOTES_DIR, resolveVaultRoot } from "../../core/paths";
import { createWorkspaceStateStore } from "./workspace-state";
import { DEFAULT_PREFERENCES } from "../shared/preferences";
import { excalidrawPalette } from "../shared/excalidrawTheme";
import { ACCENTS, isThemeChoice } from "../shared/themes";
import type { AccentChoice, ThemeChoice } from "../shared/themes";

interface ContextOptions {
  cwd?: string;
  theme?: ThemeChoice;
  accent?: AccentChoice;
  scheme?: "light" | "dark";
}

export function parseDiagramArgs(args: readonly string[]): ContextOptions {
  const options: ContextOptions = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    if (flag === "--cwd") options.cwd = value;
    else if (flag === "--theme" && isThemeChoice(value)) options.theme = value;
    else if (flag === "--accent" && (value === "theme" || Object.hasOwn(ACCENTS, value))) options.accent = value as AccentChoice;
    else if (flag === "--scheme" && (value === "light" || value === "dark")) options.scheme = value;
    else throw new Error(`Invalid option: ${flag} ${value}`);
  }
  return options;
}

/** Read the same validated, canonical workspace snapshot as the viewer. */
export async function diagramContext(options: ContextOptions, stateDir?: string) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const vaultRoot = resolve(cwd, resolveVaultRoot());
  const layout = await createWorkspaceStateStore(cwd, vaultRoot, stateDir).readLatest();
  const preferences = layout?.preferences ?? DEFAULT_PREFERENCES;
  const choice = options.theme ?? layout?.theme ?? "system";
  const accent = options.accent ?? preferences.accent;
  const themes = { light: preferences.lightTheme, dark: preferences.darkTheme };
  const common = {
    vaultRoot, notesRoot: resolve(vaultRoot, NOTES_DIR), cwd,
    themeSource: options.theme !== undefined ? "explicit" : layout ? "workspace" : "default",
    selectedTheme: choice,
  };
  if (choice === "system" && options.scheme === undefined) {
    return { ...common, needsScheme: true, palettes: {
      light: excalidrawPalette(themes.light, accent),
      dark: excalidrawPalette(themes.dark, accent),
    } };
  }
  return { ...common, needsScheme: false, palette: excalidrawPalette(choice === "system" ? themes[options.scheme!] : choice, accent) };
}

export async function runDiagramContext(args: readonly string[], write: (text: string) => void = (text) => { process.stdout.write(text); }) {
  write(JSON.stringify(await diagramContext(parseDiagramArgs(args)), null, 2) + "\n");
}
