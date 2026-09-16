export interface ViewportHost {
  readonly innerWidth: number;
  addEventListener(type: "resize", listener: () => void): void;
  removeEventListener(type: "resize", listener: () => void): void;
}

export function watchViewport(host: ViewportHost, onChange: (width: number) => void): () => void {
  const listener = (): void => onChange(host.innerWidth);
  host.addEventListener("resize", listener);
  return () => host.removeEventListener("resize", listener);
}
