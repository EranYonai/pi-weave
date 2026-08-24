import { describe, expect, it } from "vitest";
import { openNoteCommand, openNoteInEditor } from "../../src/pi/viewer/tui/openNote";
import { addNote } from "../../src/core/vault";
import { makeTempDir } from "../helpers";

describe("openNoteCommand", () => {
  it("respects $EDITOR and $VISUAL, splitting args", () => {
    expect(openNoteCommand("/v/n.md", { EDITOR: "code --wait" })).toEqual({ command: "code", args: ["--wait", "/v/n.md"] });
    expect(openNoteCommand("/v/n.md", { VISUAL: "vim" })).toEqual({ command: "vim", args: ["/v/n.md"] });
    expect(openNoteCommand("/v/n.md", {})).toHaveProperty("command"); // platform fallback
  });
});

describe("openNoteInEditor", () => {
  it("refuses unsafe slugs and missing notes without shelling out", async () => {
    const vault = await makeTempDir();
    let called = false;
    const spy = () => {
      called = true;
      return { command: "true", args: [] };
    };
    expect(await openNoteInEditor(vault, "../escape", spy)).toBe(false);
    expect(await openNoteInEditor(vault, "missing", spy)).toBe(false);
    expect(called).toBe(false);
  });

  it("opens an existing note via the injected command", async () => {
    const vault = await makeTempDir();
    await addNote(vault, { title: "Open Me", body: "x", tags: [], source: "human" });
    const opened: string[] = [];
    const spy = (p: string) => {
      opened.push(p);
      return { command: "true", args: [] };
    };
    expect(await openNoteInEditor(vault, "open-me", spy)).toBe(true);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain("open-me.md");
  });
});