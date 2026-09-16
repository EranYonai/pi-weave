import type { DividerId } from "./layout.model";

export interface DividerProps {
  id: DividerId;
  label: string;
  onDown: (clientX: number, pointerId: number) => void;
  onMove: (clientX: number) => void;
  onUp: () => void;
  onKey: (key: string) => void;
}

export function Divider(props: DividerProps) {
  return <div class="weave-divider" role="separator" aria-orientation="vertical" aria-label={props.label} tabIndex={0}
    onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); props.onDown(event.clientX, event.pointerId); }}
    onPointerMove={(event) => props.onMove(event.clientX)}
    onPointerUp={(event) => { event.currentTarget.releasePointerCapture(event.pointerId); props.onUp(); }}
    onKeyDown={(event) => props.onKey(event.key)} />;
}
