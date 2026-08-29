/**
 * The global keyboard map (weave-workspace §11 P4).
 *
 * > Global keys: `⌘K` search, `⌘1/2/3` focus column, `/` filter tree, `g` fit
 * > graph, `?` help, `Esc` clear selection. Vim-ish `j/k` in the tree.
 * > *Exit: the whole workspace is drivable without a mouse.*
 *
 * One pure function, {@link shellKey}, maps an **event descriptor** and a
 * **context** to an action or to `null`. Nothing here listens, nothing here
 * calls `preventDefault`, and nothing here knows what a `KeyboardEvent` is —
 * {@link KeyDescriptor} is five booleans and a string. `keys.ts` does the
 * subscribing and `Shell.tsx` does the dispatching, which is what makes the
 * whole keymap coverable without a DOM (§10).
 *
 * ## `null` means "the browser keeps it", and it is the important case
 *
 * This is `treeKey`'s `handled: false` contract, promoted to the document.
 * The stakes are higher here: `treeKey` sits on one column, while this
 * handler sees **every** keystroke in the workspace. A global handler that
 * swallows Tab traps keyboard users; one that swallows ⌘R breaks reload; one
 * that fires `g` while a user is typing "graph" into the filter box makes
 * text entry impossible. So the default is `null` and every claim is narrow:
 *
 * | | Claimed when |
 * | --- | --- |
 * | `⌘K` / `Ctrl K` | always — a modifier shortcut is unambiguous even mid-word |
 * | `⌘1` `⌘2` `⌘3` | always |
 * | `⌘E` `⌘S` | always — the editor's two keys (§11 P5.4) |
 * | `Esc` | an overlay is open, or something is selected. Never otherwise |
 * | `/` `g` `?` `t` | **only** when focus is not in a text field and no overlay is open |
 *
 * `⌘S` is claimed **even while typing**, which is the one place this map
 * deliberately overrides the browser. It has to be: the browser's `⌘S` is
 * "save this page as HTML", which in a note editor is never what the user
 * meant, and the moment they most want to save is the moment their cursor is
 * in the textarea. `⌘E` is claimed on the same grounds — the browser has no
 * default for it, and toggling out of the editor is a thing to do *from*
 * inside the editor. Neither fires when an overlay is open, because the
 * palette owns every key but `Escape`.
 *
 * `j` / `k` are not here at all: they are tree-scoped, so they live in
 * `tree.model.ts`'s `normalizeTreeKey` where the tree's own handler applies
 * them — a global `j` would move the tree selection while the user is looking
 * at the graph.
 *
 * ## While an overlay is open, the global map is one key wide
 *
 * The palette contains a text input and its own listbox navigation, and the
 * help sheet is a trap the user must be able to leave. Anything beyond
 * `Escape` reaching the document from inside a modal is a bug — most sharply
 * `⌘K`, which would otherwise re-open the palette on top of itself.
 */

import { COLUMNS, columnsAt } from "./layout.model";
import type { ColumnId } from "./layout.model";
import type { OverlayId } from "./shell.model";

// --- the event, without the DOM ---------------------------------------------------

/**
 * A keystroke, reduced to what a decision needs.
 *
 * `typing` rather than a target element: whether focus sits in a text field
 * is the only property of the target this map cares about, and passing the
 * element would drag `HTMLElement` into a module the root `tsconfig.json`
 * project compiles.
 */
export interface KeyDescriptor {
  /** `KeyboardEvent.key` — `"k"`, `"Escape"`, `"/"`, `"?"`. */
  readonly key: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  /** Focus is in an `<input>`, `<textarea>`, `<select>` or contenteditable. */
  readonly typing: boolean;
}

/** What the shell knows that changes what a key means. */
export interface KeyContext {
  readonly overlay: OverlayId;
  /** Whether §1.3's `selectedId` holds anything. Decides what `Esc` does. */
  readonly hasSelection: boolean;
}

// --- actions ----------------------------------------------------------------------

/**
 * Everything a global key can ask the shell to do.
 *
 * A discriminated union rather than callbacks, so the map is *data* the tests
 * can assert equality against — P4's exit criterion is "every action
 * reachable by keyboard has a tested mapping", and a table of callbacks is
 * not something you can write that assertion about.
 */
export type ShellAction =
  | { readonly type: "openSearch" }
  | { readonly type: "openHelp" }
  | { readonly type: "closeOverlay" }
  | { readonly type: "focusColumn"; readonly column: ColumnId }
  /** Focus the tree's filter box — `/`. */
  | { readonly type: "filterTree" }
  | { readonly type: "fitGraph" }
  | { readonly type: "clearSelection" }
  /** `⌘E` — toggle the note column between read and edit (§11 P5.4). */
  | { readonly type: "toggleEdit" }
  /** `⌘S` — save the open draft. */
  | { readonly type: "saveNote" }
  /** `t` — cycle the colour theme: system → light → dark → system. */
  | { readonly type: "cycleTheme" };

/**
 * The command-key letters, as data.
 *
 * A table for the same reason {@link COLUMN_DIGITS} is one: "every editor key
 * has a mapping" becomes a test over this object rather than three
 * hand-written cases, and the help sheet is generated from it so it cannot
 * document a key the code does not implement.
 */
export const COMMAND_KEYS: Readonly<Record<string, ShellAction>> = {
  k: { type: "openSearch" },
  e: { type: "toggleEdit" },
  s: { type: "saveNote" },
};

/**
 * `⌘1/2/3` → column, in §1.2's left-to-right order.
 *
 * A table rather than an `if` chain so the digits and the columns cannot
 * drift apart, and so "there is a shortcut for every column" is a test over
 * `COLUMNS` rather than three hand-written cases.
 */
export const COLUMN_DIGITS: Readonly<Record<string, ColumnId>> = { "1": "tree", "2": "note", "3": "graph" };

/**
 * The columns a breakpoint can put off screen — the graph at `"medium"`, the
 * tree too at `"narrow"`, never the note. The help sheet's derived rows use it
 * to stay honest about `⌘1`/`⌘3`: at 900 px the `⌘3` command is a documented
 * no-op, and a help line that hides that is the same lie the `disabled`
 * search button once was. Derived from `columnsAt`, not listed, so the caveat
 * cannot drift from the breakpoints the sheet is attached to.
 */
const COLLAPSIBLE_COLUMNS: ReadonlySet<ColumnId> = new Set(
  COLUMNS.filter((c) => columnsAt("medium").includes(c) === false || columnsAt("narrow").includes(c) === false),
);

/**
 * Whether a modifier combination counts as "the platform's command key".
 *
 * Meta **or** Control, never both, and never with Alt or Shift. Accepting
 * either is what makes one keymap work on both platforms without the model
 * knowing which one it is on; rejecting the combinations keeps `⌥⌘K` and
 * `⇧⌘K` — which browsers and extensions bind — out of our hands.
 */
export function isCommand(event: KeyDescriptor): boolean {
  return event.ctrl !== event.meta && !event.alt && !event.shift;
}

/**
 * Whether a bare-letter shortcut may fire.
 *
 * No modifiers of any kind. Shift is deliberately *not* excluded: `?` is
 * Shift+`/` on most layouts, and `KeyboardEvent.key` has already resolved
 * that to `"?"`, so testing Shift here would make the help key unreachable on
 * exactly the keyboards it was designed for.
 */
export function isBare(event: KeyDescriptor): boolean {
  return !event.ctrl && !event.meta && !event.alt;
}

/**
 * The bare-letter shortcuts, as data.
 *
 * `j` and `k` are absent on purpose — see the module header.
 */
export const BARE_KEYS: Readonly<Record<string, ShellAction>> = {
  "/": { type: "filterTree" },
  g: { type: "fitGraph" },
  "?": { type: "openHelp" },
  t: { type: "cycleTheme" },
};

/**
 * Map a keystroke to an action, or to `null` to leave it to the browser.
 *
 * Ordered deliberately: the overlay gate first (a modal narrows the whole map
 * to one key), then the modifier shortcuts (which fire even mid-word), then
 * `Escape`, then the bare letters (which do not).
 */
export function shellKey(event: KeyDescriptor, ctx: KeyContext): ShellAction | null {
  if (ctx.overlay !== null) return event.key === "Escape" ? { type: "closeOverlay" } : null;

  if (isCommand(event)) {
    // Lower-cased because ⌘K with caps lock on reports `"K"`, and a shortcut
    // that stops working under caps lock is a bug report nobody can reproduce.
    const letter = COMMAND_KEYS[event.key.toLowerCase()];
    if (letter !== undefined) return letter;
    const column = COLUMN_DIGITS[event.key];
    return column === undefined ? null : { type: "focusColumn", column };
  }

  // Only claimed when there is a selection to clear. With nothing selected,
  // `Esc` belongs to whatever else the browser or a future dialog wants it
  // for, and swallowing it silently would be the kind of key theft this
  // module exists to avoid.
  if (event.key === "Escape") return ctx.hasSelection ? { type: "clearSelection" } : null;

  if (!isBare(event) || event.typing) return null;
  return BARE_KEYS[event.key] ?? null;
}

// --- the typing guard -------------------------------------------------------------

/**
 * Element names that swallow a bare letter.
 *
 * `SELECT` is included, and it is the one people forget: a `<select>` does
 * type-ahead, so `g` inside the graph column's depth control should jump to
 * an option beginning with "g" rather than refit the graph. The workspace has
 * exactly one such control today (`[depth 1 ▾]`) and that is enough.
 */
export const TEXT_ENTRY_TAGS: readonly string[] = ["INPUT", "TEXTAREA", "SELECT"];

/**
 * Whether focus is somewhere a bare letter must be left alone.
 *
 * Takes the tag name and the contenteditable flag rather than an element, so
 * it is pure and so this module names no DOM type. `null` — no target at all,
 * which a synthetic event can produce — is not typing.
 */
export function isTextEntry(tagName: string | null, contentEditable: boolean): boolean {
  if (contentEditable) return true;
  return tagName !== null && TEXT_ENTRY_TAGS.includes(tagName.toUpperCase());
}

/**
 * The slice of an event target this module reads.
 *
 * Both members optional, which is what lets the platform's `EventTarget` —
 * which has neither — satisfy it structurally. A `window` or a `document`
 * target therefore reads as "not typing", which is correct.
 */
export interface KeyTarget {
  readonly tagName?: string | undefined;
  readonly isContentEditable?: boolean | undefined;
}

/**
 * The slice of `KeyboardEvent` the subscription reads.
 *
 * Structural, so the platform's satisfies it without a cast and a fake is an
 * object literal — the same port shape `EventSourceLike` and `HttpResponse`
 * use, for the same reason: there is no DOM test environment (§10).
 */
export interface KeyboardEventLike {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly target: KeyTarget | null;
  preventDefault(): void;
}

/** Reduce a platform event to a {@link KeyDescriptor}. */
export function describeKey(event: KeyboardEventLike): KeyDescriptor {
  return {
    key: event.key,
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    shift: event.shiftKey,
    alt: event.altKey,
    typing: isTextEntry(event.target?.tagName ?? null, event.target?.isContentEditable === true),
  };
}

// --- where an action points ---------------------------------------------------------

/**
 * `⌘1/2/3` → the element to focus in that column.
 *
 * Selectors rather than refs, and the reason is the breakpoint: below 1100 px
 * the graph column does not exist and below 800 px the tree does not either,
 * so a ref would be `null` for a column that is legitimately absent and the
 * shell would need a branch per column to cope. A `querySelector` that finds
 * nothing is already the same answer, expressed once.
 *
 * Each target is the column's *content*, not its `<section>`: focusing the
 * section would put the ring around the whole pane and leave the arrow keys
 * pointing at nothing.
 */
export const COLUMN_FOCUS_SELECTORS: Readonly<Record<ColumnId, string>> = {
  tree: ".weave-col-tree .weave-rows",
  note: ".weave-col-note .weave-note-body",
  graph: ".weave-col-graph .weave-graph-canvas",
};

/** `/` → the tree's filter box. */
export const TREE_FILTER_SELECTOR = ".weave-col-tree .weave-filter";

/** The slice of an element {@link focusable} produces. */
export interface Focusable {
  focus(): void;
}

/**
 * Narrow an unknown `querySelector` result to something focusable.
 *
 * The port is typed `unknown` rather than `Element` for a compiler reason
 * with an architectural upside. `Element` has no `focus()`, so a port
 * declaring `querySelector(s): Focusable | null` is *not* satisfied by the
 * real `document` in either direction and would need a cast at the one call
 * site — which is exactly where a cast is least welcome. Taking `unknown` and
 * checking here keeps `document` structurally valid, keeps this module free
 * of DOM types, and turns "the element vanished at this breakpoint" into a
 * tested branch rather than a `TypeError`.
 */
export function focusable(value: unknown): Focusable | null {
  const candidate = value as { focus?: unknown } | null | undefined;
  return typeof candidate?.focus === "function" ? (candidate as Focusable) : null;
}

/** The slice of `document` {@link focusSelector} needs. */
export interface QueryHost {
  querySelector(selector: string): unknown;
}

/**
 * Focus the first match, and report whether there was one.
 *
 * A miss is **normal**, not an error: below 1100 px the graph column does not
 * exist and below 800 px neither does the tree, so `⌘3` on a narrow window
 * legitimately finds nothing. Returning `false` rather than throwing is what
 * lets the caller stay a one-liner, and the boolean is what the test asserts.
 */
export function focusSelector(host: QueryHost, selector: string): boolean {
  const element = focusable(host.querySelector(selector));
  if (element === null) return false;
  element.focus();
  return true;
}

// --- performing an action --------------------------------------------------------

/**
 * The four capabilities an action needs, injected.
 *
 * Named capabilities rather than a component's `setState` closures, so
 * {@link runShellAction} — which is a seven-armed switch, and therefore
 * exactly the kind of thing §10 forbids putting in a `.tsx` — is testable
 * with an object literal that records calls.
 */
export interface ShellEffects {
  setOverlay(overlay: OverlayId): void;
  /** Focus the first element matching a selector. */
  focusSelector(selector: string): boolean;
  /** Frame the whole graph — the `[fit]` control's action. */
  fitGraph(): void;
  /** Write `null` to §1.3's `selectedId`. */
  clearSelection(): void;
  /** `⌘E` — dispatch `toggle` into the note editor. */
  toggleEdit(): void;
  /** `⌘S` — dispatch `save` into the note editor. */
  saveNote(): void;
  /** `t` — advance the user's theme choice by one step in its cycle. */
  cycleTheme(): void;
}

/** Perform an action. Total over {@link ShellAction}. */
export function runShellAction(action: ShellAction, fx: ShellEffects): void {
  switch (action.type) {
    case "openSearch":
      return fx.setOverlay("search");
    case "openHelp":
      return fx.setOverlay("help");
    case "closeOverlay":
      return fx.setOverlay(null);
    case "focusColumn":
      // The boolean is deliberately dropped: a column that is not on screen
      // at this breakpoint is a miss with nothing to report to.
      return void fx.focusSelector(COLUMN_FOCUS_SELECTORS[action.column]);
    case "filterTree":
      return void fx.focusSelector(TREE_FILTER_SELECTOR);
    case "fitGraph":
      return fx.fitGraph();
    case "clearSelection":
      return fx.clearSelection();
    case "toggleEdit":
      return fx.toggleEdit();
    case "saveNote":
      return fx.saveNote();
    case "cycleTheme":
      return fx.cycleTheme();
  }
}

// --- the help sheet -----------------------------------------------------------------

/** One row of the `?` overlay. */
export interface KeyHelpEntry {
  /** Rendered combination, with `⌘` or `Ctrl` already resolved. */
  readonly combo: string;
  readonly what: string;
}

/** A titled group of rows. */
export interface KeyHelpGroup {
  readonly title: string;
  readonly entries: readonly KeyHelpEntry[];
}

/**
 * The help sheet's contents.
 *
 * Derived from the same constants the map is built from wherever it can be —
 * `COLUMN_DIGITS` drives the three column rows — because a help overlay that
 * documents a key the code does not implement is worse than no help overlay.
 * The rows that cannot be derived (the arrows, which belong to `treeKey` and
 * `searchKey`) are asserted against those modules by the test suite instead.
 *
 * @param cmd the platform's command-key spelling, from `searchShortcut`'s
 *   `looksApple` — so the sheet says `⌘K` on a Mac and `Ctrl K` elsewhere,
 *   rather than teaching half its readers a key they do not have.
 */
export function keyHelp(cmd: string): readonly KeyHelpGroup[] {
  return [
    {
      title: "Global",
      entries: [
        { combo: `${cmd}K`, what: "Search notes and the repository" },
        ...Object.entries(COLUMN_DIGITS).map(([digit, column]) => ({
          combo: `${cmd}${digit}`,
          what: `Focus the ${column} column${COLLAPSIBLE_COLUMNS.has(column) ? " (when on screen)" : ""}`,
        })),
        { combo: "?", what: "This help" },
        { combo: "t", what: "Cycle the colour theme (system / light / dark)" },
        { combo: "Esc", what: "Clear the selection, or close an overlay" },
      ],
    },
    {
      title: "Tree",
      entries: [
        { combo: "/", what: "Filter the tree" },
        { combo: "j / ↓", what: "Next row" },
        { combo: "k / ↑", what: "Previous row" },
        { combo: "→", what: "Expand, or step into" },
        { combo: "←", what: "Collapse, or step out" },
        { combo: "Home / End", what: "First / last row" },
      ],
    },
    {
      title: "Note",
      entries: [
        { combo: `${cmd}E`, what: "Toggle read / edit" },
        { combo: `${cmd}S`, what: "Save the open draft" },
      ],
    },
    {
      title: "Graph",
      entries: [{ combo: "g", what: "Fit the whole graph" }],
    },
    {
      title: "Search",
      entries: [
        { combo: "↑ / ↓", what: "Move through results" },
        { combo: "↵", what: "Open the highlighted result" },
        { combo: "Esc", what: "Close the palette" },
      ],
    },
  ];
}

/** The help dialog's accessible name and heading. */
export const HELP_TITLE = "Keyboard shortcuts";

/** The help dialog's footer hint. */
export const HELP_HINT = "esc close";
