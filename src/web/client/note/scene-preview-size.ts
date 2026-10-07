/** One scale keeps bitmap dimensions in proportion in both preview modes. */
export function scenePreviewSize(width: number, height: number, paneWidth: number, enlarged: boolean) {
  const fit = paneWidth / width;
  const scale = enlarged ? Math.max(1, fit * 1.5) : fit;
  return { width: width * scale, height: height * scale };
}
