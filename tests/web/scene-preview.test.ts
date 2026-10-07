import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

function environment(nonce = "server-nonce") {
  const host: { weaveSceneRenderer?: (scene: unknown) => Promise<string>; EXCALIDRAW_ASSET_PATH?: string } = {};
  const script = { nonce: "", src: "", onload: () => {}, onerror: () => {}, remove: vi.fn() };
  const appendChild = vi.fn();
  vi.stubGlobal("window", host);
  vi.stubGlobal("location", { origin: "http://localhost:1234" });
  vi.stubGlobal("document", { createElement: () => script, querySelector: () => ({ nonce }), head: { appendChild } });
  return { host, script, appendChild };
}

describe("lazy official scene renderer", () => {
  it("shares one nonce-authorized script across concurrent previews and uses local font assets", async () => {
    const { host, script, appendChild } = environment();
    const { renderScenePreview } = await import("../../src/web/client/note/scene-preview");
    const first = { elements: ["one"] }; const second = { elements: ["two"] };
    const a = renderScenePreview(first, "paper-blue"); const b = renderScenePreview(second, "dark");
    expect(appendChild).toHaveBeenCalledTimes(1);
    expect(script.src).toBe("/scene-assets/renderer.js");
    expect(script.nonce).toBe("server-nonce");
    expect(host.EXCALIDRAW_ASSET_PATH).toBe("http://localhost:1234/scene-assets/");
    host.weaveSceneRenderer = vi.fn().mockResolvedValue("data:image/png;base64,preview");
    script.onload();
    expect(await a).toBe("data:image/png;base64,preview");
    expect(await b).toBe("data:image/png;base64,preview");
    expect(host.weaveSceneRenderer).toHaveBeenCalledWith(first, "paper-blue");
    expect(host.weaveSceneRenderer).toHaveBeenCalledWith(second, "dark");
    await renderScenePreview(first);
    expect(appendChild).toHaveBeenCalledTimes(1);
  });

  it("removes failed loads so the UI can retry without weakening CSP", async () => {
    const { host, script, appendChild } = environment("");
    const { renderScenePreview } = await import("../../src/web/client/note/scene-preview");
    const failure = renderScenePreview({});
    script.onerror();
    await expect(failure).rejects.toThrow("Could not load");
    expect(script.remove).toHaveBeenCalledOnce();
    expect(script.nonce).toBe("");
    const retry = renderScenePreview({});
    host.weaveSceneRenderer = async () => "data:image/png;base64,retry";
    script.onload();
    expect(await retry).toContain("retry");
    expect(appendChild).toHaveBeenCalledTimes(2);
  });

  it("reports an incomplete renderer script and propagates scene rendering errors", async () => {
    const { host, script } = environment();
    const { renderScenePreview } = await import("../../src/web/client/note/scene-preview");
    const failure = renderScenePreview({});
    script.onload();
    await expect(failure).rejects.toThrow("Could not initialize");
    host.weaveSceneRenderer = async () => { throw new Error("Bad scene geometry"); };
    await expect(renderScenePreview({})).rejects.toThrow("Bad scene geometry");
  });
});
