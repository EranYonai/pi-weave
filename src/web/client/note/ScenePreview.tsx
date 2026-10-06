import type { GraphTheme } from "../../shared/themes";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { fetchScene } from "./scene-source";
import { renderScenePreview } from "./scene-preview";
import { scenePreviewSize } from "./scene-preview-size";

export function ScenePreview(props: { path: string; version: string; title: string; theme: GraphTheme }) {
  const [image, setImage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [enlarged, setEnlarged] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  const bitmap = useRef<HTMLImageElement | null>(null);
  useLayoutEffect(() => {
    const container = box.current;
    const img = bitmap.current;
    if (container === null || img === null) return;
    const resize = () => {
      if (img.naturalWidth === 0 || img.naturalHeight === 0) return;
      const size = scenePreviewSize(img.naturalWidth, img.naturalHeight, Math.max(1, container.clientWidth - 2), Math.max(1, container.clientHeight - 2), enlarged);
      img.style.setProperty("--weave-scene-width", `${size.width}px`);
      img.style.setProperty("--weave-scene-height", `${size.height}px`);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    img.addEventListener("load", resize);
    resize();
    return () => { observer.disconnect(); img.removeEventListener("load", resize); };
  }, [image, enlarged]);
  useEffect(() => {
    const controller = new AbortController();
    setImage(null);
    setError(null);
    void fetchScene(props.path, controller.signal).then((scene) => renderScenePreview(scene, props.theme)).then((source) => {
      if (!controller.signal.aborted) setImage(source);
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Could not render this diagram.");
    });
    return () => controller.abort();
  }, [props.path, props.version, attempt, props.theme]);
  return <section class="weave-scene-preview" aria-label="Diagram preview">
    {error !== null ? <div role="status"><p>{error}</p><button type="button" onClick={() => setAttempt(attempt + 1)}>Retry preview</button></div>
      : image === null ? <p role="status">Rendering diagram…</p>
      : <>
        <div class="weave-scene-preview-tools"><button type="button" aria-label={enlarged ? "Restore diagram size" : "Enlarge diagram"} title={enlarged ? "Restore diagram size" : "Enlarge diagram"} aria-pressed={enlarged} onClick={() => setEnlarged(!enlarged)}>
          <svg class="weave-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d={enlarged ? "M9 3v6H3m12-6v6h6M9 21v-6H3m12 6v-6h6" : "M3 9V3h6m6 0h6v6M3 15v6h6m6 0h6v-6"} />
          </svg>
        </button></div>
        <div ref={box} class="weave-scene-preview-image">
          <img ref={bitmap} src={image} alt={`${props.title} diagram`} onError={() => setError("Could not display this diagram. Download the source to open it in Excalidraw.")} />
        </div>
      </>}
  </section>;
}
