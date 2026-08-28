/**
 * The `?` keyboard-shortcut sheet (weave-workspace §11 P4).
 *
 * Props in, JSX out. The rows come from `keyHelp` in `keys.model.ts` — the
 * same module the map itself is built from, so the sheet cannot document a
 * key the code does not implement — and the trap is `useFocusTrap`. There is
 * no branch in this file.
 *
 * `Escape` is not handled here: the global listener already answers it with
 * `closeOverlay` whenever an overlay is open, and a second handler claiming
 * the same key is how a dialog ends up closing twice.
 */

import { useFocusTrap } from "./FocusTrap";
import type { KeyHelpGroup } from "./keys.model";
import { HELP_HINT, HELP_TITLE, keyHelp } from "./keys.model";

export interface HelpOverlayProps {
  /** `⌘K` or `Ctrl K`, from `searchShortcut`. */
  shortcut: string;
  onClose: () => void;
}

function Group({ group }: { group: KeyHelpGroup }) {
  return (
    <div>
      <p class="weave-key-group">{group.title}</p>
      {group.entries.map((entry) => (
        <div key={entry.combo} class="weave-key-row">
          <kbd class="weave-key-combo">{entry.combo}</kbd>
          <span class="weave-key-what">{entry.what}</span>
        </div>
      ))}
    </div>
  );
}

export function HelpOverlay(props: HelpOverlayProps) {
  const trap = useFocusTrap();
  // `⌘K` reduced to `⌘` / `Ctrl `: the sheet composes its own combinations.
  const cmd = props.shortcut.slice(0, -1);

  return (
    <div class="weave-scrim" onClick={props.onClose}>
      <div
        class="weave-help"
        role="dialog"
        aria-modal="true"
        aria-label={HELP_TITLE}
        tabIndex={-1}
        ref={trap.ref as { current: HTMLDivElement | null }}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => void trap.onKeyDown(event as unknown as KeyboardEvent)}
      >
        <h2 class="weave-help-title">{HELP_TITLE}</h2>
        <div class="weave-keys">
          {keyHelp(cmd).map((group) => (
            <Group key={group.title} group={group} />
          ))}
        </div>
        <p class="weave-help-foot">
          <button type="button" class="weave-chip" onClick={props.onClose}>
            close
          </button>
          <span class="weave-help-hint">{HELP_HINT}</span>
        </p>
      </div>
    </div>
  );
}
