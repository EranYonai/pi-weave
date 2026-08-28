/**
 * A drag handle between two columns (weave-workspace §1.2).
 *
 * All four handlers forward straight to callbacks the shell supplies; the
 * arithmetic is in `drag.model.ts` and `layout.model.ts`. The ARIA role is
 * `separator` with `tabindex={0}` so the divider is reachable and operable
 * from the keyboard, which §11's P4 requires of the whole workspace and which
 * is far cheaper to do now than to retrofit.
 */

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
  return (
    <div
      class="weave-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label={props.label}
      tabIndex={0}
      onPointerDown={(event) => {
        // Capture, so a fast drag that outruns the 1 px handle keeps
        // delivering moves here instead of to whatever is under the pointer.
        event.currentTarget.setPointerCapture(event.pointerId);
        props.onDown(event.clientX, event.pointerId);
      }}
      onPointerMove={(event) => props.onMove(event.clientX)}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture(event.pointerId);
        props.onUp();
      }}
      onKeyDown={(event) => props.onKey(event.key)}
    />
  );
}
