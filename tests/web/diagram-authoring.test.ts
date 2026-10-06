import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { executeNoteAction } from "../../src/core/noteAction";
import { getNote } from "../../src/core/vault";
import { diagramContext } from "../../src/web/server/diagram-context";
import { makeTempDir, withVaultEnv } from "../helpers";

const helper = fileURLToPath(new URL("../../skills/weave-excalidraw/scripts/create-flow.mjs", import.meta.url));
const modulePath = helper;
const { createFlow } = await import(modulePath);

describe("packaged diagram authoring", () => {
  it("creates a new scene before a body-only companion and returns its exact link", async () => {
    const root = await makeTempDir();
    const vault = join(root, "vault");
    await withVaultEnv(vault, async () => {
      const context = await diagramContext({ cwd: root, theme: "paper-blue" }, join(root, "settings"));
      await fs.writeFile(join(root, "context.json"), JSON.stringify(context));
      await fs.writeFile(join(root, "labels.json"), JSON.stringify(["Ask the agent\nKeep this line break", "Save durable knowledge without oversized labels", "Browse in Weave"]));
      const result = JSON.parse(execFileSync(process.execPath, [helper, "--context", join(root, "context.json"), "--name", "new-example", "--labels", join(root, "labels.json")], { encoding: "utf8" }));
      expect(result).toMatchObject({ path: join(await fs.realpath(vault), "notes/diagrams/new-example.excalidraw"), wikiLink: "[[diagrams/new-example.excalidraw]]", nodes: 3, arrows: 2 });
      const scene = JSON.parse(await fs.readFile(result.path, "utf8"));
      const elements = scene.elements as { id: string; type: string; x: number; y: number; width: number; height: number; text?: string; originalText?: string; containerId?: string; boundElements?: { id: string; type: string }[]; startBinding?: { elementId: string }; endBinding?: { elementId: string } }[];
      const byId = new Map(elements.map((element) => [element.id, element]));
      expect(byId.size).toBe(elements.length);
      for (const text of elements.filter((element) => element.type === "text")) {
        expect(text.text).not.toContain("\\n");
        const shape = byId.get(text.containerId!)!;
        expect(shape.boundElements).toContainEqual({ id: text.id, type: "text" });
        expect(text.x).toBeGreaterThanOrEqual(shape.x + 24);
        expect(text.x + text.width).toBeLessThanOrEqual(shape.x + shape.width - 24);
        expect(text.y + text.height).toBeLessThanOrEqual(shape.y + shape.height - 24);
      }
      expect(elements.find((element) => element.originalText?.includes("\n"))?.text).toContain("\n");
      for (const arrow of elements.filter((element) => element.type === "arrow")) {
        const start = byId.get(arrow.startBinding!.elementId)!; const end = byId.get(arrow.endBinding!.elementId)!;
        for (const shape of [start, end]) expect(shape.boundElements).toContainEqual({ id: arrow.id, type: "arrow" });
        expect(arrow.y).toBeGreaterThan(start.y + start.height);
        expect(arrow.y + arrow.height).toBeLessThan(end.y);
      }
      const text = `An agent-authored example flow.\n\n${result.wikiLink}\n\nAsk → save → browse.`;
      const added = await executeNoteAction({ action: "add", title: "New example flow", source: "agent", tags: ["diagram"], text });
      const note = await getNote(vault, (added.details.note as { slug: string }).slug);
      expect(note?.body).toBe(text);
      expect(note?.source).toBe("agent");
      expect(note?.body).not.toMatch(/^---/);
      expect((await fs.readFile(result.path, "utf8"))).toContain('"type": "excalidraw"');
    });
  });

  it("fits long, multiline and Unicode labels without breaking grapheme clusters", async () => {
    const root = await makeTempDir();
    const context = await withVaultEnv(join(root, "vault"), () => diagramContext({ cwd: root, theme: "paper-blue" }, join(root, "settings")));
    const labels = ["W".repeat(200), "First line\n\nSecond line with a longer description", "知识图谱保存用户决策并连接项目上下文".repeat(4), `${"a".repeat(19)}e\u0301 👩‍💻 ${"👩‍💻".repeat(12)}`];
    const result = await createFlow(context, "long-labels", labels);
    const { elements } = JSON.parse(await fs.readFile(result.path, "utf8"));
    const rectangles = elements.filter((element: { type: string }) => element.type === "rectangle");
    const text = elements.filter((element: { type: string }) => element.type === "text");
    expect(text.map((element: { originalText: string }) => element.originalText)).toEqual(labels);
    for (let i = 0; i < text.length; i++) {
      const label = text[i]; const rectangle = rectangles[i];
      expect(label.containerId).toBe(rectangle.id);
      expect(rectangle.boundElements).toContainEqual({ id: label.id, type: "text" });
      expect(label.x - rectangle.x).toBeGreaterThanOrEqual(24);
      expect(label.y - rectangle.y).toBeGreaterThanOrEqual(24);
      expect(rectangle.x + rectangle.width - label.x - label.width).toBeGreaterThanOrEqual(24);
      expect(rectangle.y + rectangle.height - label.y - label.height).toBeGreaterThanOrEqual(24);
      expect(label.height).toBe(label.text.split("\n").length * label.fontSize * label.lineHeight);
      expect(label.text).not.toMatch(/\n[\u0300-\u036f\u200d]|\u200d\n/);
      if (i > 0) expect(rectangle.y - rectangles[i - 1].y - rectangles[i - 1].height).toBe(80);
    }
    expect(text[1].text).toContain("\n\n");
    expect(text[3].text.match(/👩‍💻/gu)).toHaveLength(13);
  });

  it("rejects malformed labels/names/context before any note or scene exists", async () => {
    const root = await makeTempDir();
    const context = await withVaultEnv(join(root, "vault"), () => diagramContext({ cwd: root, theme: "paper-blue" }, join(root, "settings")));
    for (const labels of [null, ["one"], ["", "two"], [3, "two"], ["literal\\nnewline", "two"], ["a".repeat(201), "two"], Array(9).fill("node")]) {
      await expect(createFlow(context, "example", labels)).rejects.toThrow();
    }
    for (const name of [undefined, "../outside", "bad/name", "C:\\path", "name.excalidraw"]) await expect(createFlow(context, name, ["a", "b"])).rejects.toThrow();
    await expect(createFlow({ ...context, needsScheme: true }, "example", ["a", "b"])).rejects.toThrow("concrete palette");
    await expect(createFlow({ ...context, notesRoot: root }, "example", ["a", "b"])).rejects.toThrow("notes directory");
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("preserves existing source bytes and rejects notes/diagram symlinks", async () => {
    const root = await makeTempDir();
    const vault = join(root, "vault");
    const context = await withVaultEnv(vault, () => diagramContext({ cwd: root, theme: "paper-blue" }, join(root, "settings")));
    const created = await createFlow(context, "human-scene", ["A", "B"]);
    const original = await fs.readFile(created.path);
    await expect(createFlow(context, "human-scene", ["Changed", "Overwrite"])).rejects.toMatchObject({ code: "EEXIST" });
    expect((await fs.readFile(created.path)).equals(original)).toBe(true);
    const outside = await makeTempDir();
    const notes = join(vault, "notes");
    await fs.rename(join(notes, "diagrams"), join(notes, "original-diagrams"));
    await fs.symlink(outside, join(notes, "diagrams"), "dir");
    await expect(createFlow(context, "escape", ["A", "B"])).rejects.toThrow("Symlinked diagram");
    await fs.unlink(join(notes, "diagrams"));
    await fs.rename(notes, join(vault, "original-notes"));
    await fs.symlink(outside, notes, "dir");
    const reference = await fs.readFile(new URL("../../skills/weave-excalidraw/references/scene-files.md", import.meta.url), "utf8");
    const examplePath = join(root, "create-scene-example.mjs");
    await fs.writeFile(examplePath, `${reference.match(/```js\n([\s\S]*?)\n```/)![1]}\nexport { createScene };\n`);
    const { createScene } = await import(examplePath);
    for (const notesRoot of [notes, `${notes}/`, `${notes}/.`, `${vault}/unused/../notes`]) {
      await expect(createFlow({ ...context, notesRoot }, "escape", ["A", "B"])).rejects.toThrow("Symlinked notes");
      await expect(createScene(notesRoot, "escape.excalidraw", "{}")).rejects.toThrow("Symlinked notes");
    }
    expect(await fs.readdir(outside)).toEqual([]);
  });
});
