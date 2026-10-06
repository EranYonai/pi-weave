import { afterEach, describe, expect, it, vi } from "vitest";

const exportToBlob = vi.hoisted(() => vi.fn());
vi.mock("@excalidraw/excalidraw", () => ({ exportToBlob }));
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); exportToBlob.mockReset(); });

async function renderer(readerFails = false) {
  vi.resetModules();
  const host: { weaveSceneRenderer?: (scene: unknown, theme?: { theme: "dark"; accent: "rose" }) => Promise<string> } = {};
  vi.stubGlobal("window", host);
  vi.stubGlobal("FileReader", class {
    result = "data:image/png;base64,preview";
    onload = () => {}; onerror = () => {};
    readAsDataURL() { if (readerFails) this.onerror(); else this.onload(); }
  });
  // The Node test project deliberately has no DOM types. Runtime stubs exercise
  // this browser-only entry without pulling its DOM declaration into that project.
  const modulePath = "../../src/web/client/note/scene-renderer";
  await import(modulePath);
  return host.weaveSceneRenderer!;
}

describe("official scene export boundary", () => {
  it("rejects malformed or empty scenes before invoking the exporter", async () => {
    const render = await renderer();
    for (const scene of [null, 3, {}, { elements: "bad" }]) await expect(render(scene)).rejects.toThrow("Invalid Excalidraw");
    for (const elements of [[], [{ isDeleted: true }]]) await expect(render({ elements })).rejects.toThrow("no visible elements");
    expect(exportToBlob).not.toHaveBeenCalled();
  });

  it("rejects remote or non-image files without making any renderer request", async () => {
    const render = await renderer();
    for (const dataURL of ["https://example.com/private.png", "/api/note/private", "file:///private.png", "data:text/html,<script>bad</script>", "data:image/png", null]) {
      await expect(render({ elements: [{}], files: { img: { dataURL } } })).rejects.toThrow("embedded image data");
    }
    expect(exportToBlob).not.toHaveBeenCalled();
  });

  it("preserves source colors and embedded files while fixing safe raster export options", async () => {
    const render = await renderer();
    exportToBlob.mockResolvedValue(new Blob([]));
    const source = {
      type: "excalidraw", elements: [{ id: "human", strokeColor: "#f5a97f", isDeleted: false }, { id: "removed", isDeleted: true }],
      appState: { viewBackgroundColor: "#24273a", exportEmbedScene: true, exportWithDarkMode: true, exportBackground: false, exportScale: 1e9 },
      files: { img: { dataURL: "data:image/png;base64,aGVsbG8=" } }, customData: { human: "kept" },
    };
    const before = JSON.stringify(source);
    expect(await render(source)).toBe("data:image/png;base64,preview");
    expect(exportToBlob).toHaveBeenCalledWith({
      elements: [source.elements[0]], files: source.files, maxWidthOrHeight: 4096, mimeType: "image/png",
      appState: { ...source.appState, exportEmbedScene: false, exportWithDarkMode: false, exportBackground: true, exportScale: 1 },
    });
    expect(JSON.stringify(source)).toBe(before);
    await render({ elements: [{}] });
    expect(exportToBlob.mock.calls[1]?.[0].files).toEqual({});
  });

  it("rerenders palette roles without modifying source bytes, custom colors or images", async () => {
    const render = await renderer();
    exportToBlob.mockResolvedValue(new Blob([]));
    const source = { elements: [
      { strokeColor: "#182334", backgroundColor: "#e9edf2" },
      { strokeColor: "#174ea6", backgroundColor: "#ef1234" },
    ], appState: { viewBackgroundColor: "#f4f6f8" }, files: { img: { dataURL: "data:image/png;base64,aGVsbG8=" } } };
    const before = JSON.stringify(source);
    await render(source, { theme: "dark", accent: "rose" });
    expect(exportToBlob.mock.calls[0]?.[0]).toMatchObject({
      elements: [{ strokeColor: "#cad3f5", backgroundColor: "#1e2030" }, { strokeColor: "#f4a4a6", backgroundColor: "#ef1234" }],
      appState: { viewBackgroundColor: "#24273a", exportWithDarkMode: false }, files: source.files,
    });
    expect(JSON.stringify(source)).toBe(before);
  });

  it("propagates export and image reading errors for the UI recovery path", async () => {
    const render = await renderer();
    exportToBlob.mockRejectedValueOnce(new Error("Invalid geometry"));
    await expect(render({ elements: [{}] })).rejects.toThrow("Invalid geometry");
    const failRead = await renderer(true);
    exportToBlob.mockResolvedValue(new Blob([]));
    await expect(failRead({ elements: [{}] })).rejects.toThrow("Could not read the rendered");
  });
});
