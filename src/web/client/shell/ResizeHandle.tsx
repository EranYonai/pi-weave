import { useRef } from "preact/hooks";

export function ResizeHandle(props: { label: string; horizontal?: boolean; value: number; min: number; max: number; onChange: (delta: number) => void }) {
  const last = useRef<number | null>(null);
  return <div class="weave-workspace-divider" role="separator" tabIndex={0} aria-label={props.label}
    aria-orientation={props.horizontal ? "horizontal" : "vertical"} aria-valuenow={Math.round(props.value)} aria-valuemin={props.min} aria-valuemax={props.max}
    onPointerDown={(event) => { last.current = props.horizontal ? event.clientY : event.clientX; event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerMove={(event) => {
      if (last.current === null) return;
      const at = props.horizontal ? event.clientY : event.clientX;
      props.onChange(at - last.current); last.current = at;
    }}
    onPointerUp={(event) => { last.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }}
    onPointerCancel={() => { last.current = null; }}
    onKeyDown={(event) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault(); props.onChange(event.key === "ArrowLeft" || event.key === "ArrowUp" ? -20 : 20);
    }} />;
}
