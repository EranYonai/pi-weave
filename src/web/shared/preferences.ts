/** Validated preferences, stored alongside the workspace's existing snapshots. */
import { FORCE_DEFAULTS } from "./forces";
import type { ForceConstants } from "./forces";
import { ACCENTS, THEMES, isThemeChoice } from "./themes";
import type { AccentChoice, PaletteChoice } from "./themes";

/** One slider: which constant it drives, and the range it may drive it over. */
export interface SliderSpec {
  readonly key: keyof ForceConstants;
  readonly label: string;
  /** One line under the label saying what moving it does. */
  readonly hint: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

/** Graph forces, ordered from group cohesion to repulsion and centering. */
export const FORCE_SLIDERS: readonly SliderSpec[] = [
  { key: "containsStrength", label: "Group cohesion", hint: "how hard a parent holds its children — group cohesion", min: 0, max: 1, step: 0.01 },
  { key: "containsRest", label: "Group radius", hint: "how far children sit from their parent — rosette radius", min: 10, max: 300, step: 5 },
  { key: "relationStrength", label: "Link strength", hint: "pull of links-to / mentions across groups", min: 0, max: 1, step: 0.01 },
  { key: "relationDistance", label: "Link distance", hint: "how long those cross-group springs are", min: 20, max: 600, step: 10 },
  { key: "charge", label: "Repulsion", hint: "node-to-node repulsion — more negative pushes harder", min: -1200, max: 0, step: 10 },
  { key: "chargeMax", label: "Repulsion range", hint: "distance past which repulsion stops — caps overall spread", min: 100, max: 4000, step: 50 },
  { key: "center", label: "Center gravity", hint: "pull toward the origin — too much makes one blob", min: 0, max: 0.3, step: 0.005 },
];


export interface Preferences {
  readonly lightTheme: PaletteChoice;
  readonly darkTheme: PaletteChoice;
  readonly accent: AccentChoice;
  readonly fontSize: number;
  readonly readable: boolean;
  readonly spellcheck: boolean;
  readonly defaultEdit: boolean;
  readonly startup: "restore" | "empty";
  readonly focusNewTabs: boolean;
  readonly groupColors: boolean;
  readonly forces: ForceConstants;
}

export const DEFAULT_PREFERENCES: Preferences = {
  lightTheme: "light", darkTheme: "dark", accent: "theme", fontSize: 14, readable: true, spellcheck: true, defaultEdit: false,
  startup: "restore", focusNewTabs: true, groupColors: true, forces: { ...FORCE_DEFAULTS },
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePreferences(input: unknown): Preferences | null {
  if (!record(input)) return null;
  const legacy = !Object.hasOwn(input, "lightTheme") && !Object.hasOwn(input, "darkTheme");
  const value = legacy ? { ...input, lightTheme: "light", darkTheme: "dark" } : input;
  if (Object.keys(value).length !== Object.keys(DEFAULT_PREFERENCES).length) return null;
  for (const scheme of ["light", "dark"] as const) {
    const theme = value[`${scheme}Theme`];
    if (!isThemeChoice(theme) || theme === "system" || THEMES[theme].scheme !== scheme) return null;
  }
  if (value["accent"] !== "theme" && (typeof value["accent"] !== "string" || !Object.hasOwn(ACCENTS, value["accent"]))) return null;
  if (typeof value["fontSize"] !== "number" || !Number.isInteger(value["fontSize"]) || value["fontSize"] < 12 || value["fontSize"] > 22) return null;
  for (const key of ["readable", "spellcheck", "defaultEdit", "focusNewTabs", "groupColors"] as const) {
    if (typeof value[key] !== "boolean") return null;
  }
  if (value["startup"] !== "restore" && value["startup"] !== "empty") return null;
  const forces = value["forces"];
  if (!record(forces) || Object.keys(forces).length !== FORCE_SLIDERS.length) return null;
  for (const { key, min, max } of FORCE_SLIDERS) {
    const force = forces[key];
    if (typeof force !== "number" || !Number.isFinite(force) || force < min || force > max) return null;
  }
  return value as unknown as Preferences;
}

