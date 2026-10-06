import type { GraphTheme } from "../../shared/themes";
import { findNonce } from "../shell/theme";

interface RendererWindow { weaveSceneRenderer?: (scene: unknown, theme?: GraphTheme) => Promise<string>; EXCALIDRAW_ASSET_PATH?: string }
interface Script { nonce: string; src: string; onload: () => void; onerror: () => void; remove(): void }
interface PreviewDocument {
  createElement(name: "script"): Script;
  querySelector(selector: string): { nonce?: string; textContent: string | null } | null;
  head: { appendChild(script: Script): void };
}
let loading: Promise<void> | null = null;

/** Only diagrams request the separately shipped official renderer. */
export async function renderScenePreview(scene: unknown, theme?: GraphTheme): Promise<string> {
  const { window: host, document, location } = globalThis as unknown as {
    window: RendererWindow; document: PreviewDocument; location: { origin: string };
  };
  if (!host.weaveSceneRenderer) {
    loading ??= new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      const nonce = findNonce(document);
      if (nonce) script.nonce = nonce;
      host.EXCALIDRAW_ASSET_PATH = `${location.origin}/scene-assets/`;
      script.src = "/scene-assets/renderer.js";
      script.onload = () => {
        if (host.weaveSceneRenderer) resolve();
        else { loading = null; script.remove(); reject(new Error("Could not initialize the diagram renderer.")); }
      };
      script.onerror = () => { loading = null; script.remove(); reject(new Error("Could not load the diagram renderer.")); };
      document.head.appendChild(script);
    });
    await loading;
  }
  return host.weaveSceneRenderer!(scene, theme);
}
