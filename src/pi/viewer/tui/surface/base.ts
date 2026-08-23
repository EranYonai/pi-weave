/**
 * surface/base.ts — the shared Pane<Surface> wrapper (weave-view-tui-v2 §6).
 *
 * A **Surface** is a harness-free, self-owned component: it holds its own
 * selection/scroll/filter/expansion state, renders its lines, and handles its
 * own keys. Surfaces share the GraphModel, BodyStore, and loaders via a
 * `SurfaceContext`. A **Pane** is a `Component` that hosts a Surface inside a
 * bordered Box with a title and a focus ring (accent when active, dim `line`
 * when inactive — conveyed by border + a leading `◆`, not color alone, per
 * §10).
 *
 * The pane owns scrolling via the injected scroll/offset on the surface; the
 * workspace root routes input to the single active pane's surface.
 */

import type { Component } from "@earendil-works/pi-tui";
import type { GraphModel } from "../../../../core/graph/model";
import { BodyStore } from "../bodyStore";
import type { WeaveLoaders, WeaveTheme } from "../explorer";
import type { SurfaceKind } from "../workspace";
import type { ThemeSlot } from "../theme";

/** A cross-pane navigation request a surface emits (resolved by the root). */
export type SurfaceEvent =
  | { type: "openDetail"; id: string }
  | { type: "focusNode"; id: string }
  | { type: "openEditor"; id: string };

/** A surface emits events (e.g. "open detail") that the workspace root resolves. */
export type SurfaceEventHandler = (event: SurfaceEvent) => void;

/** Shared, session-level deps every surface reads. */
export interface SurfaceContext {
  model: GraphModel;
  theme: WeaveTheme;
  loaders: WeaveLoaders;
  bodies: BodyStore;
  /** Reference clock (epoch ms); defaults to Date.now at the root. */
  now: () => number;
}

/** A surface can also be constructed with a render callback (test seam). */
export interface SurfaceInit {
  context: SurfaceContext;
  /** Emit a cross-pane navigation event. */
  onEvent?: SurfaceEventHandler;
}

/** What a surface component must expose on top of the pi-tui Component contract. */
export interface Surface extends Component {
  /** The surface kind this hosts. */
  readonly kind: SurfaceKind;
  /** Called by the workspace root when focus moves to/from this surface. */
  setFocused(focused: boolean): void;
  /** The pane title (surface name), shown in the border. */
  title(): string;
}

/** Minimal theme surface the pane chrome needs. */
export interface PaneTheme {
  fg(slot: ThemeSlot, text: string): string;
  bold(text: string): string;
}

/** A selectable row within a rendered surface (mirrors model.SelectableRow). */
export interface PaneRow {
  id: string;
  /** Node id a row jumps to on enter (links/backlinks/neighbors). */
  target?: string;
}

/** The render result of a surface: lines plus the selectable rows. */
export interface SurfaceRender {
  lines: string[];
  rows: PaneRow[];
}

/** A generic selectable, windowed body builder used by the surfaces. */
export function windowLines(
  lines: string[],
  selLine: number,
  scrollOffset: number,
  window: number,
  marker: (text: string) => string,
): string[] {
  const win = Math.max(1, window);
  let offset = scrollOffset;
  if (selLine >= 0) {
    if (selLine < offset) offset = selLine;
    else if (selLine >= offset + win) offset = selLine - win + 1;
  }
  offset = Math.max(0, Math.min(offset, Math.max(0, lines.length - win)));
  const out: string[] = [];
  const end = Math.min(lines.length, offset + win);
  for (let i = offset; i < end; i++) {
    const ln = lines[i]!;
    out.push(i === selLine ? marker(ln) : `  ${ln}`);
  }
  return out;
}

/**
 * Pane — a bordered Box hosting a Surface. Renders a title + focus ring on
 * the first line, then the surface's (windowed) lines. This is the v1 single
 * pane chrome lifted into a reusable wrapper; the workspace root instantiates
 * one Pane per pane node.
 */
export class Pane implements Component {
  private readonly surface: Surface;
  private readonly theme: PaneTheme;
  private readonly borderFn: (slot: ThemeSlot, text: string) => string;
  /** Current viewport height in rows (for windowing). */
  rows = 24;
  focused = false;
  private cacheKey = "";

  constructor(
    surface: Surface,
    theme: PaneTheme,
    // Bind through the theme object: a bare `theme.fg` default would detach
    // `this`, so the real pi theme's `fg` (which reads `this.fgColors.get(...)`)
    // would crash with "Cannot read properties of undefined (reading 'get')".
    borderFn: (slot: ThemeSlot, text: string) => string = (slot, text) => theme.fg(slot, text),
  ) {
    this.surface = surface;
    this.theme = theme;
    this.borderFn = borderFn;
  }

  get surfaceComponent(): Surface {
    return this.surface;
  }

  setFocused(focused: boolean): void {
    this.focused = focused;
    this.surface.setFocused(focused);
  }

  invalidate(): void {
    this.cacheKey = "";
    this.surface.invalidate();
  }

  render(width: number): string[] {
    const surfaceLines = this.surface.render(Math.max(2, width - 2));
    const title = this.surface.title();
    const active = this.focused;
    const borderSlot = active ? "accent" : "dim";
    const marker = active ? "◆ " : "  ";
    const titleText = `${marker}${title}  `;
    const top = `${this.borderFn(borderSlot, "┌")}${this.borderFn("dim", "─".repeat(Math.max(0, width - 2)))}${this.borderFn(borderSlot, "┐")}`;
    const titleLine = `${this.borderFn(borderSlot, "│")}${this.theme.bold(titleText)}${" ".repeat(Math.max(0, width - 2 - (this.theme.bold(titleText).length > width - 2 ? 0 : titleText.length)))}${this.borderFn(borderSlot, "│")}`;
    const win = Math.max(1, this.rows - 2);
    const body = windowLines(surfaceLines, -1, 0, win, (t) => t);
    const out = [top, titleLine];
    for (const l of body) out.push(`${this.borderFn(borderSlot, "│")}${l.slice(0, Math.max(0, width - 2))}${this.borderFn(borderSlot, "│")}`);
    const bottom = `${this.borderFn(borderSlot, "└")}${this.borderFn("dim", "─".repeat(Math.max(0, width - 2)))}${this.borderFn(borderSlot, "┘")}`;
    out.push(bottom);
    return out;
  }
}

export type { Component, SurfaceKind };
