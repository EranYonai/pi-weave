import { mkdir, lstat, realpath, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

// A small linear flow, using stock-exported shape/text/arrow fields. Custom
// layouts stay in the skill; this helper does not infer graph structure.
const template = JSON.parse(await readFile(new URL("../references/flow-template.excalidraw", import.meta.url), "utf8"));
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const glyphs = (text) => [...segmenter.segment(text)].map(({ segment }) => segment);
// Conservative monospace cells, not renderer-measured glyph bounds. Keep a
// wide inset and don't split combining marks, emoji sequences or CJK clusters.
const units = (text) => glyphs(text).reduce((sum, glyph) => sum + (/^[\x00-\x7f]$/.test(glyph) ? 1 : 2), 0);
function wrap(label) {
  const lines = [];
  for (const paragraph of label.split("\n")) {
    let line = "";
    for (const word of paragraph.trim().split(/\s+/)) {
      if (line && units(`${line} ${word}`) > 20) { lines.push(line); line = ""; }
      else if (line) line += " ";
      for (const char of glyphs(word)) {
        if (units(line + char) > 20) { lines.push(line); line = ""; }
        line += char;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

export async function createFlow(context, name, labels) {
  const filename = `${name}.excalidraw`;
  if (typeof name !== "string" || basename(filename) !== filename || !/^[a-z0-9][a-z0-9-]*\.excalidraw$/.test(filename)) throw new Error("Use a simple flow name without extension");
  if (!Array.isArray(labels) || labels.length < 2 || labels.length > 8 || labels.some((label) => typeof label !== "string" || !label.trim() || [...label].length > 200)) {
    throw new Error("Supply 2–8 nonempty labels of at most 200 characters");
  }
  if (labels.some((label) => label.includes("\\n"))) throw new Error("Use actual newlines in labels, not literal backslash-n");
  const palette = context.palette;
  if (context.needsScheme || !palette || [palette.canvas, palette.text, palette.primary?.stroke, palette.primary?.fill, palette.edge].some((color) => !/^#[0-9a-f]{6}$/i.test(color))) {
    throw new Error("Resolve a concrete palette with diagram-context.mjs first");
  }
  if (typeof context.notesRoot !== "string" || typeof context.vaultRoot !== "string") throw new Error("Context notesRoot must be the vault's notes directory");
  const notesRoot = resolve(context.notesRoot);
  if (notesRoot !== join(resolve(context.vaultRoot), "notes")) {
    throw new Error("Context notesRoot must be the vault's notes directory");
  }
  const elements = [];
  const shapes = [];
  let y = 60;
  for (const label of labels) {
    const lines = wrap(label);
    const id = randomUUID();
    const textId = randomUUID();
    const height = Math.max(96, lines.length * 24 + 48);
    const textWidth = Math.max(...lines.map(units)) * 12;
    const shape = { ...structuredClone(template.elements[0]), id, x: 80, y, width: 320, height,
      strokeColor: palette.primary.stroke, backgroundColor: palette.primary.fill, boundElements: [{ id: textId, type: "text" }], updated: Date.now() };
    const text = { ...structuredClone(template.elements[2]), id: textId, containerId: id,
      x: 80 + (320 - textWidth) / 2, y: y + (height - lines.length * 24) / 2, width: textWidth, height: lines.length * 24,
      text: lines.join("\n"), originalText: label, fontSize: 20, fontFamily: 3, lineHeight: 1.2, strokeColor: palette.text, updated: Date.now() };
    delete shape.customData; delete text.customData;
    elements.push(shape, text); shapes.push(shape); y += height + 80;
  }
  for (let i = 1; i < shapes.length; i++) {
    const start = shapes[i - 1]; const end = shapes[i]; const id = randomUUID();
    const arrow = { ...structuredClone(template.elements[4]), id, x: 240, y: start.y + start.height + 10, width: 0, height: 60,
      points: [[0, 0], [0, 60]], strokeColor: palette.edge, startBinding: { elementId: start.id, focus: 0, gap: 10 },
      endBinding: { elementId: end.id, focus: 0, gap: 10 }, updated: Date.now() };
    delete arrow.customData;
    start.boundElements.push({ id, type: "arrow" }); end.boundElements.push({ id, type: "arrow" }); elements.push(arrow);
  }
  const scene = { type: "excalidraw", version: 2, source: "pi-weave", elements, appState: { viewBackgroundColor: palette.canvas, gridSize: null }, files: {} };
  await mkdir(notesRoot, { recursive: true });
  if ((await lstat(notesRoot)).isSymbolicLink()) throw new Error("Symlinked notes directory");
  const canonicalNotes = await realpath(notesRoot);
  const directory = join(canonicalNotes, "diagrams");
  await mkdir(directory, { recursive: true });
  if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) throw new Error("Symlinked diagram directory");
  const path = join(directory, filename);
  const content = JSON.stringify(scene, null, 2) + "\n";
  await writeFile(path, content, { flag: "wx", mode: 0o600 });
  if (await readFile(path, "utf8") !== content) throw new Error(`Scene verification failed: ${path}`);
  return { path, wikiLink: `[[diagrams/${filename}]]`, nodes: shapes.length, arrows: shapes.length - 1 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    for (let i = 2; i < process.argv.length; i += 2) {
      const flag = process.argv[i]; const value = process.argv[i + 1];
      if (!["--context", "--name", "--labels"].includes(flag) || !value || value.startsWith("--")) throw new Error("Usage: create-flow.mjs --context context.json --name example-flow --labels labels.json");
      options[flag] = value;
    }
    const context = JSON.parse(await readFile(options["--context"], "utf8"));
    const labels = JSON.parse(await readFile(options["--labels"], "utf8"));
    console.log(JSON.stringify(await createFlow(context, options["--name"], labels), null, 2));
  } catch (error) { process.stderr.write(error.message + "\n"); process.exitCode = 1; }
}
