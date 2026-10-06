import { useEffect, useState } from "preact/hooks";
import { fetchScene } from "./scene-source";
import { renderScenePreview } from "./scene-preview";

export function ScenePreview(props: { path: string; version: string; title: string }) {
  const [image, setImage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [actualSize, setActualSize] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setImage(null);
    setError(null);
    void fetchScene(props.path, controller.signal).then(renderScenePreview).then((source) => {
      if (!controller.signal.aborted) setImage(source);
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Could not render this diagram.");
    });
    return () => controller.abort();
  }, [props.path, props.version, attempt]);
  return <section class="weave-scene-preview" aria-label="Diagram preview">
    {error !== null ? <div role="status"><p>{error}</p><button type="button" onClick={() => setAttempt(attempt + 1)}>Retry preview</button></div>
      : image === null ? <p role="status">Rendering diagram…</p>
      : <>
        <div class="weave-scene-preview-tools"><button type="button" aria-pressed={actualSize} onClick={() => setActualSize(!actualSize)}>{actualSize ? "Fit to pane" : "Actual size"}</button></div>
        <div class={`weave-scene-preview-image${actualSize ? " weave-scene-preview-actual" : ""}`}>
          <img src={image} alt={`${props.title} diagram`} onError={() => setError("Could not display this diagram. Download the source to open it in Excalidraw.")} />
        </div>
      </>}
  </section>;
}
