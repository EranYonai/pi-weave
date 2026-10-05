// Generated from src/web/server/diagram-context.ts; npm run build:diagram-context. pi-weave MIT; Catppuccin palette MIT.

// src/web/server/diagram-context.ts
import { resolve as resolve2 } from "node:path";

// src/core/paths.ts
import { homedir } from "node:os";
import { join } from "node:path";
var OKF_DIR = ".okf";
var NOTES_DIR = "notes";
var VAULT_ENV_VAR = "PI_WEAVE_VAULT";
function resolveVaultRoot(env = process.env) {
  const override = env[VAULT_ENV_VAR];
  if (override && override.trim().length > 0) {
    return override;
  }
  return join(homedir(), OKF_DIR);
}

// src/web/server/workspace-state.ts
import { createHash, randomUUID } from "node:crypto";
import { promises as fs2 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join2, resolve } from "node:path";

// src/core/git.ts
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
var DEFAULT_TIMEOUT_MS = 5e3;
var spawnCount = 0;
async function git(args, cwd, timeoutMs) {
  spawnCount += 1;
  return new Promise((resolve3) => {
    execFile("git", args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) resolve3(null);
      else resolve3(stdout);
    });
  });
}
async function findGitRoot(cwd, options = {}) {
  const out = await git(["rev-parse", "--show-toplevel"], cwd, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const root = out?.trim();
  if (!root || root.length === 0) return null;
  try {
    return await fs.realpath(root);
  } catch {
    return root;
  }
}

// src/core/mutex.ts
var queues = /* @__PURE__ */ new Map();
function withMutationQueue(key, task) {
  const prior = queues.get(key) ?? Promise.resolve();
  const result = prior.then(() => task(), () => task());
  queues.set(
    key,
    result.then(
      () => void 0,
      () => void 0
    )
  );
  return result;
}

// src/web/shared/themes.ts
var latte = {
  bg: "#eff1f5",
  panel: "#e6e9ef",
  page: "#dce0e8",
  raise: "#ccd0da",
  fg: "#4c4f69",
  dim: "#56586a",
  faint: "#606274",
  line: "#ccd0da",
  "line-strong": "#bcc0cc",
  accent: "#7113ec",
  ok: "#28641b",
  warn: "#7c4f10",
  bad: "#b20d30"
};
var macchiato = {
  bg: "#24273a",
  panel: "#1e2030",
  page: "#181926",
  raise: "#363a4f",
  fg: "#cad3f5",
  dim: "#a5adcb",
  faint: "#939ab7",
  line: "#363a4f",
  "line-strong": "#494d64",
  accent: "#c6a0f6",
  ok: "#a6da95",
  warn: "#eed49f",
  bad: "#ed8796"
};
var THEMES = {
  light: { name: "Catppuccin Latte · Mauve", scheme: "light", colors: latte },
  "latte-blue": { name: "Catppuccin Latte · Blue", scheme: "light", colors: { ...latte, accent: "#1750bf" } },
  "frappe-teal": { name: "Catppuccin Frappé · Teal", scheme: "dark", colors: {
    bg: "#303446",
    panel: "#292c3c",
    page: "#232634",
    raise: "#414559",
    fg: "#c6d0f5",
    dim: "#b5bfe2",
    faint: "#a5adce",
    line: "#414559",
    "line-strong": "#51576d",
    accent: "#81c8be",
    ok: "#a6d189",
    warn: "#e5c890",
    bad: "#f4a4a6"
  } },
  dark: { name: "Catppuccin Macchiato · Mauve", scheme: "dark", colors: macchiato },
  "macchiato-peach": { name: "Catppuccin Macchiato · Peach", scheme: "dark", colors: { ...macchiato, accent: "#f5a97f" } },
  "mocha-lavender": { name: "Catppuccin Mocha · Lavender", scheme: "dark", colors: {
    bg: "#1e1e2e",
    panel: "#181825",
    page: "#11111b",
    raise: "#313244",
    fg: "#cdd6f4",
    dim: "#a6adc8",
    faint: "#9399b2",
    line: "#313244",
    "line-strong": "#45475a",
    accent: "#b4befe",
    ok: "#a6e3a1",
    warn: "#f9e2af",
    bad: "#f38ba8"
  } },
  "paper-blue": { name: "Paper · Blue", scheme: "light", colors: {
    bg: "#f4f6f8",
    panel: "#e9edf2",
    page: "#ffffff",
    raise: "#dce3eb",
    fg: "#182334",
    dim: "#42536a",
    faint: "#526176",
    line: "#dce3eb",
    "line-strong": "#bac6d4",
    accent: "#174ea6",
    ok: "#21623b",
    warn: "#805300",
    bad: "#a3223c"
  } },
  "ink-blue": { name: "Ink · Blue", scheme: "dark", colors: {
    bg: "#1b2430",
    panel: "#141c27",
    page: "#101720",
    raise: "#2b3748",
    fg: "#edf2f8",
    dim: "#becadc",
    faint: "#a5b5cb",
    line: "#2b3748",
    "line-strong": "#46566d",
    accent: "#8bbcff",
    ok: "#91d5a5",
    warn: "#edc47b",
    bad: "#ff9fae"
  } },
  "sand-amber": { name: "Sand · Amber", scheme: "light", colors: {
    bg: "#f7f3ec",
    panel: "#ede6da",
    page: "#fffdf8",
    raise: "#e2d8c8",
    fg: "#30291f",
    dim: "#5b4e3f",
    faint: "#675847",
    line: "#e2d8c8",
    "line-strong": "#c7b8a2",
    accent: "#814500",
    ok: "#365c2a",
    warn: "#795000",
    bad: "#a12c32"
  } },
  "ember-amber": { name: "Ember · Amber", scheme: "dark", colors: {
    bg: "#29231f",
    panel: "#211c19",
    page: "#191512",
    raise: "#3c322b",
    fg: "#f3e9dc",
    dim: "#d0bfab",
    faint: "#bfa991",
    line: "#3c322b",
    "line-strong": "#5c4d40",
    accent: "#edb96b",
    ok: "#b5cf8a",
    warn: "#efc57a",
    bad: "#f69a91"
  } },
  "mist-teal": { name: "Mist · Teal", scheme: "light", colors: {
    bg: "#eff5f3",
    panel: "#e1ece8",
    page: "#fafffd",
    raise: "#d2e2dc",
    fg: "#18342e",
    dim: "#3c5b52",
    faint: "#48655b",
    line: "#d2e2dc",
    "line-strong": "#acc5bc",
    accent: "#006457",
    ok: "#2a5e35",
    warn: "#795300",
    bad: "#a52a43"
  } },
  "forest-teal": { name: "Forest · Teal", scheme: "dark", colors: {
    bg: "#1c2b27",
    panel: "#16221e",
    page: "#101b17",
    raise: "#2b4038",
    fg: "#e6f2ec",
    dim: "#b8d0c4",
    faint: "#a2bfb0",
    line: "#2b4038",
    "line-strong": "#456255",
    accent: "#7cd8bb",
    ok: "#a5d6a0",
    warn: "#e6c582",
    bad: "#f5a2ac"
  } }
};
var THEME_CHOICES = ["system", ...Object.keys(THEMES)];
function isThemeChoice(value) {
  return typeof value === "string" && THEME_CHOICES.includes(value);
}
var ACCENTS = {
  mauve: { name: "Mauve", light: "#7113ec", dark: "#cba9f8" },
  blue: { name: "Blue", light: "#1750bf", dark: "#8bbcff" },
  teal: { name: "Teal", light: "#006457", dark: "#7cd8bb" },
  peach: { name: "Peach", light: "#814500", dark: "#f5a97f" },
  rose: { name: "Rose", light: "#a52a43", dark: "#f4a4a6" },
  green: { name: "Green", light: "#28641b", dark: "#a6da95" },
  amber: { name: "Amber", light: "#775000", dark: "#edb96b" },
  lavender: { name: "Lavender", light: "#445198", dark: "#b4befe" }
};
function accentColor(theme, accent) {
  return accent === "theme" ? THEMES[theme].colors.accent : ACCENTS[accent][THEMES[theme].scheme];
}

// src/web/shared/forces.ts
var FORCES = {
  containsRest: 55,
  containsStrength: 0.12,
  relationDistance: 50,
  relationStrength: 0.07,
  charge: -200,
  chargeMax: 800,
  center: 0.05
};
var FORCE_DEFAULTS = { ...FORCES };

// src/web/shared/preferences.ts
var FORCE_SLIDERS = [
  { key: "containsStrength", label: "Group cohesion", hint: "how hard a parent holds its children — group cohesion", min: 0, max: 1, step: 0.01 },
  { key: "containsRest", label: "Group radius", hint: "how far children sit from their parent — rosette radius", min: 10, max: 300, step: 5 },
  { key: "relationStrength", label: "Link strength", hint: "pull of links-to / mentions across groups", min: 0, max: 1, step: 0.01 },
  { key: "relationDistance", label: "Link distance", hint: "how long those cross-group springs are", min: 20, max: 600, step: 10 },
  { key: "charge", label: "Repulsion", hint: "node-to-node repulsion — more negative pushes harder", min: -1200, max: 0, step: 10 },
  { key: "chargeMax", label: "Repulsion range", hint: "distance past which repulsion stops — caps overall spread", min: 100, max: 4e3, step: 50 },
  { key: "center", label: "Center gravity", hint: "pull toward the origin — too much makes one blob", min: 0, max: 0.3, step: 5e-3 }
];
var DEFAULT_PREFERENCES = {
  lightTheme: "light",
  darkTheme: "dark",
  accent: "theme",
  fontSize: 14,
  readable: true,
  spellcheck: true,
  defaultEdit: false,
  startup: "restore",
  focusNewTabs: true,
  groupColors: true,
  forces: { ...FORCE_DEFAULTS }
};
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parsePreferences(input) {
  if (!record(input)) return null;
  const legacy = !Object.hasOwn(input, "lightTheme") && !Object.hasOwn(input, "darkTheme");
  const value = legacy ? { ...input, lightTheme: "light", darkTheme: "dark" } : input;
  if (Object.keys(value).length !== Object.keys(DEFAULT_PREFERENCES).length) return null;
  for (const scheme of ["light", "dark"]) {
    const theme = value[`${scheme}Theme`];
    if (!isThemeChoice(theme) || theme === "system" || THEMES[theme].scheme !== scheme) return null;
  }
  if (value["accent"] !== "theme" && (typeof value["accent"] !== "string" || !Object.hasOwn(ACCENTS, value["accent"]))) return null;
  if (typeof value["fontSize"] !== "number" || !Number.isInteger(value["fontSize"]) || value["fontSize"] < 12 || value["fontSize"] > 22) return null;
  for (const key of ["readable", "spellcheck", "defaultEdit", "focusNewTabs", "groupColors"]) {
    if (typeof value[key] !== "boolean") return null;
  }
  if (value["startup"] !== "restore" && value["startup"] !== "empty") return null;
  const forces = value["forces"];
  if (!record(forces) || Object.keys(forces).length !== FORCE_SLIDERS.length) return null;
  for (const { key, min, max } of FORCE_SLIDERS) {
    const force = forces[key];
    if (typeof force !== "number" || !Number.isFinite(force) || force < min || force > max) return null;
  }
  return value;
}

// src/web/shared/workspace.ts
var MAX_TABS = 40;
var MAX_HISTORY = 100;
var MAX_SCROLL = 1e9;
function exactKeys(value, keys) {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function record2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function boundedId(value, prefix) {
  return typeof value === "string" && value.length <= 2048 && (prefix === void 0 ? value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value) : new RegExp(`^${prefix}-[1-9][0-9]{0,8}$`).test(value));
}
function parseWorkspaceLayout(value) {
  if (!record2(value) || !exactKeys(value, ["version", "panes", "activePane", "split", "ratio", "treeVisible", "contextVisible", "treeWidth", "contextWidth", "theme", ...Object.hasOwn(value, "preferences") ? ["preferences"] : []])) return null;
  if (value["version"] !== 1 || !Array.isArray(value["panes"]) || value["panes"].length < 1 || value["panes"].length > 2 || !boundedId(value["activePane"], "pane")) return null;
  if (value["split"] !== "right" && value["split"] !== "down") return null;
  if (typeof value["ratio"] !== "number" || !Number.isFinite(value["ratio"]) || value["ratio"] < 0.1 || value["ratio"] > 0.9) return null;
  if (typeof value["treeVisible"] !== "boolean" || typeof value["contextVisible"] !== "boolean") return null;
  if (typeof value["treeWidth"] !== "number" || !Number.isFinite(value["treeWidth"]) || value["treeWidth"] < 120 || value["treeWidth"] > 800) return null;
  if (typeof value["contextWidth"] !== "number" || !Number.isFinite(value["contextWidth"]) || value["contextWidth"] < 120 || value["contextWidth"] > 800) return null;
  if (!isThemeChoice(value["theme"])) return null;
  let preferences = Object.hasOwn(value, "preferences") ? parsePreferences(value["preferences"]) : DEFAULT_PREFERENCES;
  if (preferences === null) return null;
  const previousPreferences = value["preferences"];
  if (value["theme"] !== "system" && (!record2(previousPreferences) || !Object.hasOwn(previousPreferences, "lightTheme"))) {
    preferences = { ...preferences, [`${THEMES[value["theme"]].scheme}Theme`]: value["theme"] };
  }
  const ids = /* @__PURE__ */ new Set();
  let count = 0;
  let graphs = 0;
  const panes = [];
  for (const rawPane of value["panes"]) {
    if (!record2(rawPane) || !exactKeys(rawPane, Object.hasOwn(rawPane, "lastDocumentTab") ? ["id", "tabs", "activeTab", "lastDocumentTab"] : ["id", "tabs", "activeTab"]) || !boundedId(rawPane["id"], "pane") || !Array.isArray(rawPane["tabs"]) || rawPane["tabs"].length < 1 || !boundedId(rawPane["activeTab"], "tab") || ids.has(rawPane["id"])) return null;
    ids.add(rawPane["id"]);
    const tabs = [];
    let activeFound = false;
    for (const rawTab of rawPane["tabs"]) {
      if (!record2(rawTab) || !exactKeys(rawTab, ["id", "kind", "history", "cursor", "scroll"]) || !boundedId(rawTab["id"], "tab") || ids.has(rawTab["id"])) return null;
      ids.add(rawTab["id"]);
      if (rawTab["kind"] !== "document" && rawTab["kind"] !== "graph") return null;
      const kind = rawTab["kind"];
      if (!Array.isArray(rawTab["history"]) || rawTab["history"].length < 1 || rawTab["history"].length > MAX_HISTORY || !Number.isInteger(rawTab["cursor"]) || rawTab["cursor"] < 0 || rawTab["cursor"] >= rawTab["history"].length) return null;
      if (rawTab["history"].some((id) => id !== null && !boundedId(id))) return null;
      if (typeof rawTab["scroll"] !== "number" || !Number.isFinite(rawTab["scroll"]) || rawTab["scroll"] < 0 || rawTab["scroll"] > MAX_SCROLL) return null;
      if (kind === "graph") graphs++;
      count++;
      if (rawTab["id"] === rawPane["activeTab"]) activeFound = true;
      tabs.push({ id: rawTab["id"], kind, history: rawTab["history"], cursor: rawTab["cursor"], scroll: rawTab["scroll"] });
    }
    if (!activeFound) return null;
    const lastDocumentTab = rawPane["lastDocumentTab"];
    if (Object.hasOwn(rawPane, "lastDocumentTab") && (!boundedId(lastDocumentTab, "tab") || !tabs.some((tab) => tab.id === lastDocumentTab && tab.kind === "document"))) return null;
    panes.push({ id: rawPane["id"], tabs, activeTab: rawPane["activeTab"], ...typeof lastDocumentTab === "string" ? { lastDocumentTab } : {} });
  }
  if (count > MAX_TABS || graphs > 1 || !panes.some((pane) => pane.id === value["activePane"])) return null;
  return { version: 1, panes, activePane: value["activePane"], split: value["split"], ratio: value["ratio"], treeVisible: value["treeVisible"], contextVisible: value["contextVisible"], treeWidth: value["treeWidth"], contextWidth: value["contextWidth"], theme: value["theme"], preferences };
}

// src/web/server/workspace-state.ts
var MAX_SNAPSHOTS = 8;
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isWorkspaceViewId(value) {
  return typeof value === "string" && UUID.test(value);
}
function defaultWorkspaceStateDir() {
  return join2(process.env.XDG_CONFIG_HOME || join2(homedir2(), ".config"), "pi-weave", "presentation");
}
function createWorkspaceStateStore(cwd, vaultRoot, stateDir = defaultWorkspaceStateDir()) {
  let directoryPromise = null;
  const directory = () => {
    directoryPromise ??= (async () => {
      const [vault, repo] = await Promise.all([canonical(vaultRoot), findGitRoot(cwd)]);
      const workspaceRoot = await canonical(repo ?? cwd);
      const id = createHash("sha256").update(JSON.stringify([vault, workspaceRoot])).digest("hex");
      return join2(stateDir, id);
    })();
    return directoryPromise;
  };
  return {
    async readLatest() {
      return (await readSnapshots(await directory()))[0]?.layout ?? null;
    },
    async write(viewId, layout) {
      if (!isWorkspaceViewId(viewId)) throw new Error("viewId must be a UUID");
      const dir = await directory();
      const file = join2(dir, `${viewId}.json`);
      await withMutationQueue(file, async () => {
        await writeSnapshot(dir, file, { version: 1, viewId, layout });
      });
    }
  };
}
async function canonical(path) {
  const absolute = resolve(path);
  try {
    return await fs2.realpath(absolute);
  } catch {
    return absolute;
  }
}
async function readSnapshots(directory) {
  let names;
  try {
    names = await fs2.readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const snapshots = await Promise.all(names.filter((name) => UUID.test(name.slice(0, -5)) && name.endsWith(".json")).map(async (name) => {
    const file = join2(directory, name);
    try {
      const [text, info] = await Promise.all([fs2.readFile(file, "utf8"), fs2.stat(file)]);
      const raw = JSON.parse(text);
      const layout = raw.version === 1 && raw.viewId === name.slice(0, -5) ? parseWorkspaceLayout(raw.layout) : null;
      return layout ? { viewId: raw.viewId, savedAt: info.mtimeMs, layout } : null;
    } catch {
      return null;
    }
  }));
  return snapshots.filter((item) => item !== null).sort((a, b) => b.savedAt - a.savedAt).slice(0, MAX_SNAPSHOTS);
}
async function writeSnapshot(directory, file, state) {
  await fs2.mkdir(directory, { recursive: true, mode: 448 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs2.writeFile(temporary, JSON.stringify(state), { encoding: "utf8", flag: "wx", mode: 384 });
    await fs2.rename(temporary, file);
    const entries = await Promise.all((await fs2.readdir(directory)).filter((name) => name.endsWith(".json")).map(async (name) => {
      const path = join2(directory, name);
      try {
        return { path, mtime: (await fs2.stat(path)).mtimeMs };
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    }));
    const existing = entries.filter((entry) => entry !== null);
    existing.sort((a, b) => b.mtime - a.mtime);
    await Promise.all(existing.slice(MAX_SNAPSHOTS).map(({ path }) => fs2.rm(path, { force: true })));
  } catch (error) {
    await fs2.rm(temporary, { force: true });
    throw error;
  }
}

// src/web/shared/excalidrawTheme.ts
function excalidrawPalette(theme, accent = "theme") {
  const { colors, scheme } = THEMES[theme];
  return {
    theme,
    accent,
    scheme,
    canvas: colors.bg,
    text: colors.fg,
    stroke: colors.fg,
    primary: { fill: colors.panel, stroke: accentColor(theme, accent) },
    secondary: { fill: colors.raise, stroke: colors.fg },
    accentNode: { fill: colors.panel, stroke: accentColor(theme, accent) },
    group: { fill: colors.page, stroke: colors.dim },
    annotation: colors.dim,
    edge: colors.dim
  };
}

// src/web/server/diagram-context.ts
function parseDiagramArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    if (flag === "--cwd") options.cwd = value;
    else if (flag === "--theme" && isThemeChoice(value)) options.theme = value;
    else if (flag === "--accent" && (value === "theme" || Object.hasOwn(ACCENTS, value))) options.accent = value;
    else if (flag === "--scheme" && (value === "light" || value === "dark")) options.scheme = value;
    else throw new Error(`Invalid option: ${flag} ${value}`);
  }
  return options;
}
async function diagramContext(options, stateDir) {
  const cwd = resolve2(options.cwd ?? process.cwd());
  const vaultRoot = resolve2(cwd, resolveVaultRoot());
  const layout = await createWorkspaceStateStore(cwd, vaultRoot, stateDir).readLatest();
  const preferences = layout?.preferences ?? DEFAULT_PREFERENCES;
  const choice = options.theme ?? layout?.theme ?? "system";
  const accent = options.accent ?? preferences.accent;
  const themes = { light: preferences.lightTheme, dark: preferences.darkTheme };
  const common = {
    vaultRoot,
    notesRoot: resolve2(vaultRoot, NOTES_DIR),
    cwd,
    themeSource: options.theme !== void 0 ? "explicit" : layout ? "workspace" : "default",
    selectedTheme: choice
  };
  if (choice === "system" && options.scheme === void 0) {
    return { ...common, needsScheme: true, palettes: {
      light: excalidrawPalette(themes.light, accent),
      dark: excalidrawPalette(themes.dark, accent)
    } };
  }
  return { ...common, needsScheme: false, palette: excalidrawPalette(choice === "system" ? themes[options.scheme] : choice, accent) };
}
async function runDiagramContext(args, write = (text) => {
  process.stdout.write(text);
}) {
  write(JSON.stringify(await diagramContext(parseDiagramArgs(args)), null, 2) + "\n");
}
export {
  diagramContext,
  parseDiagramArgs,
  runDiagramContext
};
runDiagramContext(process.argv.slice(2)).catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
