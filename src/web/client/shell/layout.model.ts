/** Pure model for the resizable workspace columns. */

export type ColumnId = "tree" | "note" | "graph";
export const COLUMNS: readonly ColumnId[] = ["tree", "note", "graph"];
export type Columns<T> = { readonly [K in ColumnId]: T };
export const MIN_WIDTHS: Columns<number> = { tree: 180, note: 320, graph: 260 };
export const DEFAULT_FRACTIONS: Columns<number> = { tree: 0.22, note: 0.46, graph: 0.32 };

export type Breakpoint = "wide" | "medium" | "narrow";
export const BREAKPOINT_MEDIUM = 1100;
export const BREAKPOINT_NARROW = 800;

export function breakpointFor(width: number): Breakpoint {
  if (!Number.isFinite(width) || width < BREAKPOINT_NARROW) return "narrow";
  return width < BREAKPOINT_MEDIUM ? "medium" : "wide";
}

export function columnsAt(breakpoint: Breakpoint): readonly ColumnId[] {
  return breakpoint === "wide" ? COLUMNS : breakpoint === "medium" ? ["tree", "note"] : ["note"];
}

export function isCollapsed(breakpoint: Breakpoint, column: ColumnId): boolean {
  return !columnsAt(breakpoint).includes(column);
}

export interface LayoutState { readonly fractions: Columns<number> }

function normalizeOver(ids: readonly ColumnId[], fractions: Columns<number>, floors: Columns<number>): Columns<number> {
  const clean: Record<ColumnId, number> = { tree: 0, note: 0, graph: 0 };
  let total = 0;
  for (const id of ids) {
    const value = fractions[id];
    clean[id] = Number.isFinite(value) && value > 0 ? value : DEFAULT_FRACTIONS[id];
    total += clean[id];
  }
  for (const id of ids) clean[id] /= total;
  let deficit = 0;
  let slack = 0;
  const atFloor: Record<ColumnId, boolean> = { tree: false, note: false, graph: false };
  for (const id of ids) {
    const floor = floors[id];
    if (clean[id] < floor) {
      deficit += floor - clean[id];
      clean[id] = floor;
      atFloor[id] = true;
    } else slack += clean[id] - floor;
  }
  if (deficit > 0 && slack > 0) {
    const rate = Math.min(deficit, slack) / slack;
    for (const id of ids) if (!atFloor[id]) clean[id] -= (clean[id] - floors[id]) * rate;
  }
  return { tree: clean.tree, note: clean.note, graph: clean.graph };
}

export function normalizeFractions(fractions: Columns<number>, minShare: Columns<number>): Columns<number> {
  return normalizeOver(COLUMNS, fractions, minShare);
}

export function minShares(available: number): Columns<number> {
  const width = Number.isFinite(available) && available > 0 ? available : 1;
  const raw = { tree: MIN_WIDTHS.tree / width, note: MIN_WIDTHS.note / width, graph: MIN_WIDTHS.graph / width };
  const total = raw.tree + raw.note + raw.graph;
  if (total <= 0.9) return raw;
  const scale = 0.9 / total;
  return { tree: raw.tree * scale, note: raw.note * scale, graph: raw.graph * scale };
}

export function makeLayout(fractions: Columns<number>, available: number): LayoutState {
  return { fractions: normalizeFractions(fractions, minShares(available)) };
}

export function defaultLayout(available: number): LayoutState {
  return makeLayout(DEFAULT_FRACTIONS, available);
}

export interface ResolvedColumn { readonly id: ColumnId; readonly width: number }

export function resolveColumns(state: LayoutState, available: number, breakpoint: Breakpoint): readonly ResolvedColumn[] {
  const width = Number.isFinite(available) && available > 0 ? available : 0;
  const shares = normalizeOver(columnsAt(breakpoint), state.fractions, minShares(width));
  return columnsAt(breakpoint).map((id) => ({ id, width: shares[id] * width }));
}

export type DividerId = "tree" | "note";
export const DIVIDERS: readonly DividerId[] = ["tree", "note"];
export function dividerPair(divider: DividerId): readonly [ColumnId, ColumnId] {
  return divider === "tree" ? ["tree", "note"] : ["note", "graph"];
}

export function resizeAt(state: LayoutState, divider: DividerId, deltaPx: number, available: number): LayoutState {
  const width = Number.isFinite(available) && available > 0 ? available : 0;
  if (width === 0 || !Number.isFinite(deltaPx) || deltaPx === 0) return state;
  const [left, right] = dividerPair(divider);
  const floors = minShares(width);
  const delta = Math.max(-(Math.max(0, state.fractions[left] - floors[left])), Math.min(Math.max(0, state.fractions[right] - floors[right]), deltaPx / width));
  if (delta === 0) return state;
  return { fractions: normalizeFractions({ ...state.fractions, [left]: state.fractions[left] + delta, [right]: state.fractions[right] - delta }, floors) };
}

export interface LayoutStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export const LAYOUT_STORAGE_KEY = "pi-weave.layout.v1";
const round4 = (value: number): number => Math.round(value * 10000) / 10000;

export function serializeLayout(state: LayoutState): string {
  return JSON.stringify({ v: 1, tree: round4(state.fractions.tree), note: round4(state.fractions.note), graph: round4(state.fractions.graph) });
}

export function deserializeLayout(raw: string | null, available: number): LayoutState | null {
  if (raw === null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record["v"] !== 1) return null;
  const fractions = {} as Record<ColumnId, number>;
  for (const id of COLUMNS) {
    const value = record[id];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
    fractions[id] = value;
  }
  return makeLayout(fractions, available);
}

export function loadLayout(storage: LayoutStorage, available: number): LayoutState {
  try { return deserializeLayout(storage.getItem(LAYOUT_STORAGE_KEY), available) ?? defaultLayout(available); }
  catch { return defaultLayout(available); }
}

export function saveLayout(storage: LayoutStorage, state: LayoutState): boolean {
  try { storage.setItem(LAYOUT_STORAGE_KEY, serializeLayout(state)); return true; }
  catch { return false; }
}

export function columnVar(column: ColumnId): string { return `--weave-col-${column}`; }
export function columnValue(width: number): string { return `${Math.round(width)}px`; }
export function columnVars(resolved: readonly ResolvedColumn[]): readonly (readonly [string, string])[] {
  return resolved.map((column) => [columnVar(column.id), columnValue(column.width)] as const);
}
