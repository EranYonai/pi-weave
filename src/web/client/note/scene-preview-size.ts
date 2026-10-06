/** One scale keeps bitmap dimensions in proportion in both preview modes. */
export function scenePreviewSize(width: number, height: number, paneWidth: number, paneHeight: number, enlarged: boolean) {
  const fit = Math.min(1.3, paneWidth / width, paneHeight / height);
  const scale = enlarged ? Math.max(1, fit * 1.5) : fit;
  return { width: width * scale, height: height * scale };
}
