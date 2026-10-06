import { exportToBlob } from "@excalidraw/excalidraw";
type ExportData = Parameters<typeof exportToBlob>[0];

/** Raster output isolates scene links/embeds from the workspace document. */
async function render(scene: unknown): Promise<string> {
  if (scene === null || typeof scene !== "object" || !("elements" in scene) || !Array.isArray(scene.elements)) {
    throw new Error("Invalid Excalidraw scene.");
  }
  const data = scene as ExportData;
  for (const file of Object.values(data.files ?? {}) as { dataURL?: unknown }[]) {
    if (typeof file?.dataURL !== "string" || !/^data:image\/[a-z0-9.+-]+(?:;[^,]*)?,/i.test(file.dataURL)) {
      throw new Error("Diagram images must be embedded image data; external image URLs are not loaded.");
    }
  }
  if (data.elements.every((element: { isDeleted?: boolean }) => element.isDeleted)) {
    throw new Error("This diagram has no visible elements.");
  }
  const blob = await exportToBlob({
    elements: data.elements.filter((element: { isDeleted?: boolean }) => !element.isDeleted),
    appState: { ...data.appState, exportEmbedScene: false, exportWithDarkMode: false, exportBackground: true, exportScale: 1 },
    files: data.files ?? {}, maxWidthOrHeight: 4096, mimeType: "image/png",
  });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Could not read the rendered diagram."));
    reader.readAsDataURL(blob);
  });
}

(window as Window & { weaveSceneRenderer?: typeof render }).weaveSceneRenderer = render;
