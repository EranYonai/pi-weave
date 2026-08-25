/**
 * Compatibility re-export.
 *
 * The implementation moved to `src/core/openInEditor.ts` (weave-workspace
 * §5.3): the browser workspace's `POST /api/open` needs it and
 * `src/web/server/**` may not import `src/pi`. Keeping this module as a
 * one-line re-export means `run.ts` and every TUI test kept working without
 * an edit; there is nothing TUI-specific left to live here.
 */

export { openNoteCommand, openNoteInEditor } from "../../../core/openInEditor";
