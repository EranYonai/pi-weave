/** Keep preview parsing bounded; the source download remains unrestricted. */
export const SCENE_PREVIEW_LIMIT = 20 * 1024 * 1024;

export async function fetchScene(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(`/api/scene/${encodeURIComponent(path)}`, { signal });
  if (!response.ok || response.body === null) throw new Error("Could not load this diagram. Refresh the workspace and try again.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > SCENE_PREVIEW_LIMIT) {
        await reader.cancel();
        throw new Error("This diagram is too large to preview. Download the source to open it in Excalidraw.");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally { reader.releaseLock(); }
  try { return JSON.parse(text); }
  catch { throw new Error("This diagram contains invalid JSON. Download the source to recover it."); }
}
