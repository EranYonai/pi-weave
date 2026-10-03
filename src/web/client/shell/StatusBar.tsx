/**
 * The status bar (weave-workspace §1.2).
 *
 * Working directory and current selection. The
 * model is built by `statusBarModel`; this renders it.
 */

import type { StatusBarModel } from "./shell.model";

export function StatusBar({ model }: { model: StatusBarModel }) {
  return (
    <footer class="weave-status">
      <span class="weave-status-cwd" title={model.cwd}>
        {model.cwd}
      </span>
      <span class="weave-status-sel" title="Current item">
        {model.selection}
      </span>
    </footer>
  );
}
