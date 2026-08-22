/**
 * Provenance & kind → glyph + theme color-slot maps for the weave-view TUI
 * (weave-view-tui-design §7).
 *
 * Pure data: imports only core types. Theme slots are names only
 * (`theme.fg(slot, …)` applies the actual color), so pi themes restyle
 * everything — never hardcoded hex. Style-first per v2 P1: provenance is
 * glyph + dimness, color is the weak secondary channel.
 */

import type { NodeKind } from "../../../core/graph/model";
import type { NoteSource } from "../../../core/types";

/** Theme foreground color-slot names understood by pi's `Theme`. */
export type ThemeSlot =
  | "accent"
  | "success"
  | "warning"
  | "dim"
  | "muted"
  | "text";

/** Provenance rendering: glyph prefix, whole-row dimness, and theme slot. */
export interface ProvenanceStyle {
  glyph: string;
  /** When true, the whole row is rendered dim (generated knowledge). */
  dim: boolean;
  slot: ThemeSlot;
  /** Word printed in the provenance cycle / header banner, e.g. "human". */
  word: string;
}

/** The provenance cycle order for the `p` key: all → human → agent → generated → all. */
export const PROVENANCE_CYCLE: readonly (NoteSource | null)[] = [null, "human", "agent", "generated"];

export function provenanceStyle(prov: NoteSource | null): ProvenanceStyle {
  switch (prov) {
    case "human":
      return { glyph: "●", dim: false, slot: "success", word: "human" };
    case "agent":
      return { glyph: "◐", dim: false, slot: "accent", word: "agent" };
    case "generated":
      return { glyph: "○", dim: true, slot: "dim", word: "generated" };
    default:
      // structural node — no provenance glyph; kind glyph leads.
      return { glyph: "", dim: false, slot: "muted", word: "" };
  }
}

export interface KindStyle {
  glyph: string;
  slot: ThemeSlot;
}

/** Kind → glyph + slot. Notes defer to their provenance glyph (trust-first). */
export function kindStyle(kind: NodeKind): KindStyle {
  switch (kind) {
    case "vault":
      return { glyph: "◆", slot: "accent" };
    case "note":
      // provenance glyph leads; kind slot unused for the marker.
      return { glyph: "", slot: "text" };
    case "repository":
      return { glyph: "■", slot: "accent" };
    case "module":
      return { glyph: "▪", slot: "success" };
    case "package":
      return { glyph: "▲", slot: "success" };
    case "entryPoint":
      return { glyph: "▹", slot: "warning" };
    case "gitState":
      return { glyph: "⎇", slot: "warning" };
    case "external":
      return { glyph: "↗", slot: "warning" };
    case "file":
      return { glyph: "·", slot: "dim" };
  }
}

/** Chevron shown for an expandable tree row. */
export function chevron(expanded: boolean, hasKids: boolean): string {
  if (!hasKids) return " ";
  return expanded ? "▾" : "▸";
}

/** Selection gutter marker. */
export const SELECTION_MARKER = "›";

/** Maximum length of the inline search/filter string (design §9.4). */
export const MAX_FILTER_LEN = 200;