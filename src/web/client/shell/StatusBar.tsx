/**
 * The status bar (weave-workspace §1.2).
 *
 * Working directory, current selection, data-as-of stamp, connection. The
 * model is built by `statusBarModel`; this renders it.
 */

import type { StatusBarModel } from "./shell.model";
import { shortStamp } from "./shell.model";

export function StatusBar({ model }: { model: StatusBarModel }) {
  return (
    <footer class="weave-status">
      <span class="weave-status-cwd" title={model.cwd}>
        {model.cwd}
      </span>
      <span class="weave-status-sel" title="the §1.3 context bus — one signal, every column">
        {model.selection}
      </span>
      <span class="weave-status-stamp" title="data as of">
        {shortStamp(model.stamp)}
      </span>
      <span class={`weave-conn weave-conn-${model.connection.tone}`} title={model.connection.hint}>
        {model.connection.label}
      </span>
    </footer>
  );
}
