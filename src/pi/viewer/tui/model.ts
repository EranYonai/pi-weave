/**
 * TUI-specific view-model for the weave-view explorer (weave-view-tui-design
 * §5, §10.1).
 *
 * The portable projections (`treeRows`, `detailModel`, `focusModel`,
 * `healthModel`, …) now live in `src/core/view` so the browser workspace can
 * share them (weave-workspace §3). What stays here is what is genuinely about
 * a terminal: the explorer's `ExplorerState`/`Action`/`reduce` state machine,
 * terminal-escape sanitising, and the theme glue.
 *
 * Everything moved is re-exported below, so TUI files keep importing from
 * `./model`.
 */

import type { NoteSource } from "../../../core/types";
import type { SelectableRow, TreeRow } from "../../../core/view";
import { MAX_FILTER_LEN, PROVENANCE_CYCLE, provenanceStyle, type ProvenanceStyle } from "./theme";

// ---------------------------------------------------------------------------
// sanitizeTerminalText — the TUI's XSS analog (design §9.3)
// ---------------------------------------------------------------------------

/** Strip terminal-escape/control sequences from disk/user content before
 *  styling or handing to Markdown: ESC (0x1b), CSI (0x9b), BEL (0x07), and
 *  other C0 controls except newline (0x0a) and tab (0x09). */
export function sanitizeTerminalText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b/g, "").replace(/\x9b/g, "").replace(/\x07/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

// ---------------------------------------------------------------------------
// ExplorerState + reduce — key→state transitions (design §6, §10.1)
// ---------------------------------------------------------------------------

export type Surface = "tree" | "detail" | "focus" | "health";

export interface ExplorerState {
  surface: Surface;
  /** Inline search sub-mode (only meaningful on the tree surface). */
  searching: boolean;
  /** Selected node id (source of truth; the cursor index is derived). */
  selectedId: string | null;
  /** Node pinned for focus mode. */
  focusId: string | null;
  /** Node open in detail. */
  detailId: string | null;
  /** Tree expansion (when no filter is active). */
  expanded: Set<string>;
  showInternals: boolean;
  provFilter: NoteSource | null;
  query: string;
  helpOpen: boolean;
  refreshing: boolean;
  /** Bumped on every mutation so the render cache can key off it. */
  version: number;
  /** Scroll offset (top visible row index) for the current surface. */
  scrollOffset: number;
}

export function initialState(roots: readonly string[]): ExplorerState {
  const expanded = new Set<string>();
  for (const r of roots) expanded.add(r);
  const selectedId = roots[0] ?? null;
  return {
    surface: "tree",
    searching: false,
    selectedId,
    focusId: null,
    detailId: null,
    expanded,
    showInternals: false,
    provFilter: null,
    query: "",
    helpOpen: false,
    refreshing: false,
    version: 0,
    scrollOffset: 0,
  };
}

export type Action =
  | { type: "up" }
  | { type: "down" }
  | { type: "pageUp" }
  | { type: "pageDown" }
  | { type: "home" }
  | { type: "end" }
  | { type: "left" }
  | { type: "right" }
  | { type: "enter" }
  | { type: "searchStart" }
  | { type: "searchChar"; ch: string }
  | { type: "searchBackspace" }
  | { type: "searchCommit" }
  | { type: "cycleProvenance" }
  | { type: "toggleInternals" }
  | { type: "focus" }
  | { type: "focusExit" }
  | { type: "surfaceTree" }
  | { type: "surfaceHealth" }
  | { type: "refresh" }
  | { type: "refreshDone" }
  | { type: "toggleHelp" }
  | { type: "quit" }
  | { type: "esc" };

/** Context reduce needs for movement: the selectable rows of the current
 *  surface (in display order) and the viewport window size. */
export interface ReduceCtx {
  rows: readonly SelectableRow[];
  window: number;
}

function bump(s: ExplorerState): ExplorerState {
  return { ...s, version: s.version + 1 };
}

function clampIndex(idx: number, len: number): number {
  if (len === 0) return -1;
  if (idx >= len) return len - 1;
  return idx;
}

function scrollForSelection(idx: number, window: number, prev: number): number {
  if (window <= 0) return 0;
  // keep selection visible: offset <= idx < offset + window
  if (idx < prev) return idx;
  if (idx >= prev + window) return idx - window + 1;
  return prev;
}

function provenanceCycleNext(current: NoteSource | null): NoteSource | null {
  const i = PROVENANCE_CYCLE.indexOf(current);
  const next = PROVENANCE_CYCLE[(i + 1) % PROVENANCE_CYCLE.length];
  return next ?? null;
}

/**
 * Apply an action to the explorer state. Pure: returns a new state.
 *
 * Movement uses `ctx.rows` (the current surface's selectable rows) and
 * `ctx.window` (viewport height) to clamp the cursor and adjust scroll.
 * The component builds `ctx.rows` from the surface's model function.
 */
export function reduce(state: ExplorerState, action: Action, ctx: ReduceCtx = { rows: [], window: 24 }): ExplorerState {
  const rows = ctx.rows;
  const len = rows.length;
  const currentIdx = state.selectedId ? rows.findIndex((r) => r.id === state.selectedId || r.target === state.selectedId) : -1;

  switch (action.type) {
    case "up":
    case "down":
    case "pageUp":
    case "pageDown":
    case "home":
    case "end": {
      if (len === 0) return state;
      let nextIdx: number;
      if (action.type === "up") nextIdx = currentIdx <= 0 ? 0 : currentIdx - 1;
      else if (action.type === "down") nextIdx = currentIdx < 0 ? 0 : Math.min(currentIdx + 1, len - 1);
      else if (action.type === "pageUp") nextIdx = currentIdx < 0 ? 0 : Math.max(0, currentIdx - ctx.window);
      else if (action.type === "pageDown") nextIdx = currentIdx < 0 ? 0 : Math.min(len - 1, currentIdx + ctx.window);
      else if (action.type === "home") nextIdx = 0;
      else nextIdx = len - 1; // end
      nextIdx = clampIndex(nextIdx, len);
      const row = rows[nextIdx];
      if (!row) return state;
      const selectedId = row.target ?? row.id;
      const scrollOffset = scrollForSelection(nextIdx, ctx.window, state.scrollOffset);
      return bump({ ...state, selectedId, scrollOffset });
    }

    case "left":
    case "right": {
      if (state.surface !== "tree") return state;
      if (!state.selectedId) return state;
      // operate on the tree: find the row for selectedId
      const treeRowIdx = rows.findIndex((r) => r.id === state.selectedId);
      const treeRow = treeRowIdx >= 0 ? (rows[treeRowIdx] as TreeRow | undefined) : undefined;
      const isExpanded = state.expanded.has(state.selectedId);
      if (action.type === "right") {
        if (treeRow && treeRow.hasKids && !isExpanded) {
          const expanded = new Set(state.expanded).add(state.selectedId);
          return bump({ ...state, expanded });
        }
        if (treeRow && isExpanded) {
          // move to first child
          const child = rows[treeRowIdx + 1];
          if (child) return bump({ ...state, selectedId: child.id, scrollOffset: scrollForSelection(treeRowIdx + 1, ctx.window, state.scrollOffset) });
        }
        return state;
      }
      // left: collapse, or jump to parent
      if (treeRow && isExpanded) {
        const expanded = new Set(state.expanded);
        expanded.delete(state.selectedId);
        return bump({ ...state, expanded });
      }
      // jump to parent: the nearest preceding row with smaller depth
      for (let i = treeRowIdx - 1; i >= 0; i--) {
        const r = rows[i] as TreeRow | undefined;
        if (r && r.depth < (treeRow?.depth ?? 0)) {
          return bump({ ...state, selectedId: r.id, scrollOffset: scrollForSelection(i, ctx.window, state.scrollOffset) });
        }
      }
      return state;
    }

    case "enter": {
      if (state.searching) {
        // commit search: keep filter, exit search mode
        return bump({ ...state, searching: false, scrollOffset: 0 });
      }
      if (!state.selectedId) return state;
      const row = currentIdx >= 0 ? rows[currentIdx] : undefined;
      if (state.surface === "tree") {
        return bump({ ...state, surface: "detail", detailId: state.selectedId, scrollOffset: 0 });
      }
      if (state.surface === "detail") {
        // jump to the selected link/backlink target
        if (row && row.target) {
          return bump({ ...state, surface: "detail", detailId: row.target, selectedId: row.target, scrollOffset: 0 });
        }
        return state;
      }
      if (state.surface === "focus") {
        // re-center on the selected neighbor
        if (row && row.target) {
          return bump({ ...state, focusId: row.target, selectedId: row.target, scrollOffset: 0 });
        }
        return state;
      }
      if (state.surface === "health") {
        if (row && row.target) {
          return bump({ ...state, surface: "detail", detailId: row.target, selectedId: row.target, scrollOffset: 0 });
        }
        return state;
      }
      return state;
    }

    case "searchStart": {
      if (state.searching) return state;
      if (state.surface === "detail") return state;
      return bump({ ...state, searching: true });
    }

    case "searchChar": {
      if (!state.searching) return state;
      const q = (state.query + action.ch).slice(0, MAX_FILTER_LEN);
      return bump({ ...state, query: q, scrollOffset: 0 });
    }

    case "searchBackspace": {
      if (!state.searching) return state;
      return bump({ ...state, query: state.query.slice(0, -1), scrollOffset: 0 });
    }

    case "searchCommit": {
      if (!state.searching) return state;
      return bump({ ...state, searching: false, scrollOffset: 0 });
    }

    case "esc": {
      // precedence: search > surface-exit > quit
      if (state.searching) {
        return bump({ ...state, searching: false, query: "", scrollOffset: 0 });
      }
      if (state.surface === "detail") {
        return bump({ ...state, surface: "tree", scrollOffset: 0 });
      }
      if (state.surface === "focus") {
        return bump({ ...state, surface: "tree", focusId: null, scrollOffset: 0 });
      }
      if (state.surface === "health") {
        return bump({ ...state, surface: "tree", scrollOffset: 0 });
      }
      // tree → quit (component resolves done(null))
      return bump({ ...state });
    }

    case "quit": {
      return bump({ ...state });
    }

    case "cycleProvenance": {
      if (state.searching) return state;
      return bump({ ...state, provFilter: provenanceCycleNext(state.provFilter), scrollOffset: 0 });
    }

    case "toggleInternals": {
      if (state.searching) return state;
      return bump({ ...state, showInternals: !state.showInternals, scrollOffset: 0 });
    }

    case "focus": {
      if (state.searching) return state;
      if (!state.selectedId) return state;
      return bump({ ...state, surface: "focus", focusId: state.selectedId, scrollOffset: 0 });
    }

    case "focusExit": {
      return bump({ ...state, surface: "tree", focusId: null, scrollOffset: 0 });
    }

    case "surfaceTree": {
      if (state.searching) return state;
      return bump({ ...state, surface: "tree", scrollOffset: 0 });
    }

    case "surfaceHealth": {
      if (state.searching) return state;
      return bump({ ...state, surface: "health", scrollOffset: 0 });
    }

    case "refresh": {
      return bump({ ...state, refreshing: true });
    }

    case "refreshDone": {
      return bump({ ...state, refreshing: false });
    }

    case "toggleHelp": {
      if (state.searching) return state;
      return bump({ ...state, helpOpen: !state.helpOpen });
    }
  }
  // Exhaustive over Action; unreachable for valid inputs.
  return state;
}

/**
 * Merge explorer state across a refresh (design §6): keep the expanded set,
 * filter, surface, and selected node id. A selected/expanded id that no
 * longer exists drops out; selection falls back to the first root.
 */
export function mergeAfterRefresh(prev: ExplorerState, nextRoots: readonly string[]): ExplorerState {
  let selectedId = prev.selectedId;
  if (selectedId !== null && !nextRoots.includes(selectedId)) {
    // selectedId may be a non-root; the component re-resolves it against the
    // new tree rows. Roots fallback only when it is null.
  }
  if (selectedId === null) selectedId = nextRoots[0] ?? null;
  return {
    ...prev,
    refreshing: false,
    selectedId,
    version: prev.version + 1,
    scrollOffset: 0,
  };
}

// ---------------------------------------------------------------------------
// Re-exports — the portable view-models, kept importable from `./model` so no
// TUI file needs to know they moved to src/core/view.
// ---------------------------------------------------------------------------

export {
  countProvenance,
  degreeOf,
  deriveBacklinks,
  detailModel,
  focusModel,
  focusNeighborhood,
  formatTreeMeta,
  graphRoots,
  healthModel,
  listLabel,
  relTime,
  treeEmptyHint,
  treeRows,
  type DetailLinkRow,
  type DetailMetaRow,
  type DetailModel,
  type FocusGroup,
  type FocusModel,
  type FocusRow,
  type HealthModel,
  type HealthRow,
  type HealthSection,
  type ProvenanceCounts,
  type SelectableRow,
  type TreeMeta,
  type TreeRow,
  type TreeState,
} from "../../../core/view";

// Re-export theme helpers some tests reach for.
export { provenanceStyle, type ProvenanceStyle };
