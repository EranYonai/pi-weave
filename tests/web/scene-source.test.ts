import { afterEach, expect, it, vi } from "vitest";
import { fetchScene, SCENE_PREVIEW_LIMIT } from "../../src/web/client/note/scene-source";

afterEach(() => vi.unstubAllGlobals());

it("loads exact scene paths and decodes split UTF-8 characters", async () => {
  const bytes = new TextEncoder().encode('{"label":"café"}');
  const response = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(bytes.slice(0, 14));
    controller.enqueue(bytes.slice(14));
    controller.close();
  } }));
  const fetch = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetch);
  const signal = new AbortController().signal;
  expect(await fetchScene("diagrams/Auth Flow.excalidraw", signal)).toEqual({ label: "café" });
  expect(fetch).toHaveBeenCalledWith("/api/scene/diagrams%2FAuth%20Flow.excalidraw", { signal });
});

it("reports missing files and invalid JSON without modifying the source", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response("", { status: 404 }))
    .mockResolvedValueOnce(new Response(null)).mockResolvedValueOnce(new Response("{unfinished"));
  vi.stubGlobal("fetch", fetch);
  const signal = new AbortController().signal;
  await expect(fetchScene("missing.excalidraw", signal)).rejects.toThrow("Could not load");
  await expect(fetchScene("empty.excalidraw", signal)).rejects.toThrow("Could not load");
  await expect(fetchScene("broken.excalidraw", signal)).rejects.toThrow("invalid JSON");
});

it("cancels previews above the size limit instead of buffering the complete download", async () => {
  const cancel = vi.fn();
  const chunk = new Uint8Array(1024 * 1024);
  let reads = 0;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({
    pull(controller) { reads++; controller.enqueue(chunk); }, cancel,
  }))));
  await expect(fetchScene("huge.excalidraw", new AbortController().signal)).rejects.toThrow("too large to preview");
  expect(cancel).toHaveBeenCalledOnce();
  expect(reads).toBeLessThanOrEqual(SCENE_PREVIEW_LIMIT / chunk.length + 2);
});
