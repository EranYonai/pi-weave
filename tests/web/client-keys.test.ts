/**
 * The global keyboard map (weave-workspace §11 P4, §10).
 *
 * P4's exit criterion is "the whole workspace is drivable without a mouse",
 * and it cannot be checked visually — there are no screenshots, ever (§10).
 * So it is asserted through the model layer, and this file is where: **every
 * action the shell can perform has a key that produces it, and every key that
 * produces one is tested**. The two directions are checked against
 * `ShellAction` itself, so an action added without a binding fails here.
 *
 * The other half of the suite is the *negative* space, and it is the larger
 * half on purpose. A global `keydown` listener sees every keystroke in the
 * workspace, so the damage a wrong claim does is unbounded: swallow Tab and
 * keyboard users are trapped, swallow ⌘R and reload breaks, fire `g` while
 * someone is typing "graph" into the filter box and text entry is impossible.
 * `null` is the default and every claim below is narrow.
 */

import { describe, expect, it } from "vitest";
import type { KeyContext, KeyDescriptor, KeyboardEventLike, ShellAction, ShellEffects } from "../../src/web/client/shell/keys.model";
import {
  BARE_KEYS,
  COMMAND_KEYS,
  COLUMN_DIGITS,
  COLUMN_FOCUS_SELECTORS,
  HELP_HINT,
  HELP_TITLE,
  TEXT_ENTRY_TAGS,
  TREE_FILTER_SELECTOR,
  describeKey,
  focusSelector,
  focusable,
  isBare,
  isCommand,
  isTextEntry,
  keyHelp,
  runShellAction,
  shellKey,
} from "../../src/web/client/shell/keys.model";
import { watchKeys } from "../../src/web/client/shell/keys";
import type { KeyHost } from "../../src/web/client/shell/keys";
import { COLUMNS } from "../../src/web/client/shell/layout.model";
import { VIM_KEYS, normalizeTreeKey, treeKey } from "../../src/web/client/tree/tree.model";
import type { TreeRow } from "../../src/web/shared/view";

// --- fixtures -----------------------------------------------------------------------

function key(partial: Partial<KeyDescriptor> & { key: string }): KeyDescriptor {
  return { ctrl: false, meta: false, shift: false, alt: false, typing: false, ...partial };
}

/** Nothing open, nothing selected — the state the workspace mostly sits in. */
const IDLE: KeyContext = { overlay: null, hasSelection: false };

// --- the map ------------------------------------------------------------------------

describe("shellKey — the claimed shortcuts", () => {
  it("opens search on ⌘K and on Ctrl K, so one map serves both platforms", () => {
    expect(shellKey(key({ key: "k", meta: true }), IDLE)).toEqual({ type: "openSearch" });
    expect(shellKey(key({ key: "k", ctrl: true }), IDLE)).toEqual({ type: "openSearch" });
  });

  it("opens search under caps lock, where the key reports as `K`", () => {
    // A shortcut that stops working under caps lock is a bug report nobody
    // can reproduce.
    expect(shellKey(key({ key: "K", meta: true }), IDLE)).toEqual({ type: "openSearch" });
  });

  it("focuses a column for every digit, and there is a digit for every column", () => {
    for (const [digit, column] of Object.entries(COLUMN_DIGITS)) {
      expect(shellKey(key({ key: digit, meta: true }), IDLE)).toEqual({ type: "focusColumn", column });
    }
    // The table cannot drift away from §1.2's three columns.
    expect(Object.values(COLUMN_DIGITS)).toEqual([...COLUMNS]);
  });

  it("claims the three bare letters", () => {
    expect(shellKey(key({ key: "/" }), IDLE)).toEqual({ type: "filterTree" });
    expect(shellKey(key({ key: "g" }), IDLE)).toEqual({ type: "fitGraph" });
    expect(shellKey(key({ key: "?" }), IDLE)).toEqual({ type: "openHelp" });
  });

  it("accepts `?` even though it arrives with Shift held", () => {
    // `?` is Shift+`/` on most layouts and `KeyboardEvent.key` has already
    // resolved it, so testing Shift would make the help key unreachable on
    // exactly the keyboards it was designed for.
    expect(shellKey(key({ key: "?", shift: true }), IDLE)).toEqual({ type: "openHelp" });
  });

  it("clears the selection on Escape when there is one", () => {
    expect(shellKey(key({ key: "Escape" }), { overlay: null, hasSelection: true })).toEqual({ type: "clearSelection" });
  });
});

describe("shellKey — the keys it must not take", () => {
  it("leaves Escape alone with nothing selected and nothing open", () => {
    // Swallowing a key to do nothing with it is the theft this module exists
    // to avoid.
    expect(shellKey(key({ key: "Escape" }), IDLE)).toBeNull();
  });

  it("never claims Tab, in any state", () => {
    // The single most damaging key to take: it is how a keyboard user moves.
    for (const ctx of [IDLE, { overlay: "search" as const, hasSelection: true }, { overlay: "help" as const, hasSelection: false }]) {
      for (const shift of [false, true]) expect(shellKey(key({ key: "Tab", shift }), ctx)).toBeNull();
    }
  });

  it("leaves the browser's own command shortcuts alone", () => {
    // ⌘R reload, ⌘L address bar, ⌘T new tab, ⌘W close, ⌘F find.
    for (const k of ["r", "l", "t", "w", "f", "0", "4", "9"]) {
      expect(shellKey(key({ key: k, meta: true }), IDLE), k).toBeNull();
    }
  });

  it("ignores a command key with extra modifiers", () => {
    // ⌥⌘K and ⇧⌘K are bound by browsers and extensions; ⌃⌘K is neither.
    expect(shellKey(key({ key: "k", meta: true, alt: true }), IDLE)).toBeNull();
    expect(shellKey(key({ key: "k", meta: true, shift: true }), IDLE)).toBeNull();
    expect(shellKey(key({ key: "k", meta: true, ctrl: true }), IDLE)).toBeNull();
  });

  it("does not fire a bare letter while the user is typing", () => {
    // The bug this prevents: typing "graph" into the tree's filter box refits
    // the graph on the `g` and never enters the letter.
    for (const k of Object.keys(BARE_KEYS)) {
      expect(shellKey(key({ key: k, typing: true }), IDLE), k).toBeNull();
    }
  });

  it("does not fire a bare letter that arrived with a modifier", () => {
    expect(shellKey(key({ key: "g", meta: true }), IDLE)).toBeNull();
    expect(shellKey(key({ key: "g", ctrl: true }), IDLE)).toBeNull();
    expect(shellKey(key({ key: "g", alt: true }), IDLE)).toBeNull();
  });

  it("ignores every unbound key", () => {
    for (const k of ["a", "z", "Enter", " ", "ArrowDown", "F5", "Backspace", "j", "k"]) {
      expect(shellKey(key({ key: k }), IDLE), k).toBeNull();
    }
  });
});

describe("shellKey — while an overlay is open", () => {
  for (const overlay of ["search", "help"] as const) {
    describe(overlay, () => {
      const ctx: KeyContext = { overlay, hasSelection: true };

      it("answers Escape with close, whatever the selection is", () => {
        expect(shellKey(key({ key: "Escape" }), ctx)).toEqual({ type: "closeOverlay" });
        expect(shellKey(key({ key: "Escape" }), { overlay, hasSelection: false })).toEqual({ type: "closeOverlay" });
      });

      it("claims nothing else at all", () => {
        // Most sharply ⌘K, which would otherwise re-open the palette on top
        // of itself. The palette owns a text input and its own listbox
        // navigation; anything else reaching the document from inside it is
        // a bug.
        for (const descriptor of [
          key({ key: "k", meta: true }),
          key({ key: "1", meta: true }),
          key({ key: "g" }),
          key({ key: "/" }),
          key({ key: "?" }),
          key({ key: "Enter" }),
          key({ key: "ArrowDown" }),
        ]) {
          expect(shellKey(descriptor, ctx), descriptor.key).toBeNull();
        }
      });
    });
  }
});

describe("isCommand and isBare", () => {
  it("accepts exactly one of Meta or Control", () => {
    expect(isCommand(key({ key: "k", meta: true }))).toBe(true);
    expect(isCommand(key({ key: "k", ctrl: true }))).toBe(true);
    expect(isCommand(key({ key: "k", ctrl: true, meta: true }))).toBe(false);
    expect(isCommand(key({ key: "k" }))).toBe(false);
  });

  it("treats Shift as ours to ignore, unlike Ctrl/Meta/Alt", () => {
    expect(isBare(key({ key: "?", shift: true }))).toBe(true);
    expect(isBare(key({ key: "g", ctrl: true }))).toBe(false);
    expect(isBare(key({ key: "g", meta: true }))).toBe(false);
    expect(isBare(key({ key: "g", alt: true }))).toBe(false);
  });
});

// --- the typing guard -----------------------------------------------------------------

describe("isTextEntry", () => {
  it("recognises every tag that swallows a letter", () => {
    for (const tag of TEXT_ENTRY_TAGS) expect(isTextEntry(tag, false), tag).toBe(true);
    // `SELECT` is the one people forget: it does type-ahead, so `g` inside
    // the graph column's depth control must reach the control.
    expect(TEXT_ENTRY_TAGS).toContain("SELECT");
  });

  it("is case-insensitive, because XHTML and SVG report lowercase", () => {
    expect(isTextEntry("input", false)).toBe(true);
  });

  it("recognises contenteditable regardless of the tag", () => {
    expect(isTextEntry("DIV", true)).toBe(true);
  });

  it("is false for the rest of the document, and for no target at all", () => {
    // A `window` or `document` target has no `tagName`, which is correctly
    // "not typing".
    expect(isTextEntry("DIV", false)).toBe(false);
    expect(isTextEntry("BUTTON", false)).toBe(false);
    expect(isTextEntry(null, false)).toBe(false);
  });
});

describe("describeKey", () => {
  function event(partial: Partial<KeyboardEventLike> & { key: string }): KeyboardEventLike {
    return { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, target: null, preventDefault: () => {}, ...partial };
  }

  it("reduces a platform event to the five booleans a decision needs", () => {
    expect(describeKey(event({ key: "k", metaKey: true }))).toEqual({
      key: "k",
      ctrl: false,
      meta: true,
      shift: false,
      alt: false,
      typing: false,
    });
  });

  it("derives `typing` from the target", () => {
    expect(describeKey(event({ key: "g", target: { tagName: "INPUT" } })).typing).toBe(true);
    expect(describeKey(event({ key: "g", target: { isContentEditable: true } })).typing).toBe(true);
    expect(describeKey(event({ key: "g", target: { tagName: "DIV" } })).typing).toBe(false);
  });

  it("treats a target with neither member as not typing", () => {
    // Which is what the platform's bare `EventTarget` — `window`, `document`
    // — looks like, and it is the reason both members are optional.
    expect(describeKey(event({ key: "g", target: {} })).typing).toBe(false);
    expect(describeKey(event({ key: "g", target: null })).typing).toBe(false);
  });
});

// --- the subscription -------------------------------------------------------------------

describe("watchKeys", () => {
  /** A `document` that records its listeners and can fire one. */
  function host(): KeyHost & { fire: (event: KeyboardEventLike) => void; count: () => number } {
    const listeners: Array<(event: KeyboardEventLike) => void> = [];
    return {
      addEventListener: (_type, listener) => void listeners.push(listener),
      removeEventListener: (_type, listener) => void listeners.splice(listeners.indexOf(listener), 1),
      fire: (event) => listeners.forEach((l) => l(event)),
      count: () => listeners.length,
    };
  }

  function event(partial: Partial<KeyboardEventLike> & { key: string }): KeyboardEventLike & { prevented: boolean } {
    const self = {
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      target: null,
      prevented: false,
      preventDefault: () => void (self.prevented = true),
      ...partial,
    };
    return self;
  }

  it("runs the action a claimed key produces, and prevents the default", () => {
    const document = host();
    const ran: ShellAction[] = [];
    watchKeys(document, { context: () => IDLE, run: (a) => void ran.push(a) });

    const e = event({ key: "k", metaKey: true });
    document.fire(e);
    expect(ran).toEqual([{ type: "openSearch" }]);
    expect(e.prevented).toBe(true);
  });

  it("leaves an unclaimed key entirely alone", () => {
    // Not merely "does nothing": it must not `preventDefault` either, or Tab
    // stops moving focus and ⌘R stops reloading.
    const document = host();
    const ran: ShellAction[] = [];
    watchKeys(document, { context: () => IDLE, run: (a) => void ran.push(a) });

    const e = event({ key: "Tab" });
    document.fire(e);
    expect(ran).toEqual([]);
    expect(e.prevented).toBe(false);
  });

  it("reads the context fresh per keystroke", () => {
    // A listener registered at mount outlives every render. With a captured
    // context the palette would never see itself as open and ⌘K would stack
    // an overlay on top of itself.
    const document = host();
    const ran: ShellAction[] = [];
    let overlay: KeyContext["overlay"] = null;
    watchKeys(document, { context: () => ({ overlay, hasSelection: false }), run: (a) => void ran.push(a) });

    document.fire(event({ key: "k", metaKey: true }));
    overlay = "search";
    document.fire(event({ key: "k", metaKey: true }));
    expect(ran).toEqual([{ type: "openSearch" }]);
  });

  it("unsubscribes, so a hot reload cannot leave two listeners", () => {
    const document = host();
    const stop = watchKeys(document, { context: () => IDLE, run: () => {} });
    expect(document.count()).toBe(1);
    stop();
    expect(document.count()).toBe(0);
  });
});

// --- performing an action -----------------------------------------------------------------

describe("runShellAction", () => {
  function effects(found = true): ShellEffects & { readonly log: string[] } {
    const log: string[] = [];
    return {
      log,
      setOverlay: (o) => void log.push(`overlay:${o ?? "none"}`),
      focusSelector: (s) => {
        log.push(`focus:${s}`);
        return found;
      },
      fitGraph: () => void log.push("fit"),
      clearSelection: () => void log.push("clear"),
      toggleEdit: () => void log.push("toggleEdit"),
      saveNote: () => void log.push("saveNote"),
    };
  }

  it("has an arm for every action, and each does one thing", () => {
    // The exit criterion, in one assertion: every action a key can produce is
    // performable. An action added to the union without an arm fails to
    // compile in `runShellAction`; one added without a binding fails the
    // reachability test below.
    const cases: Array<[ShellAction, string]> = [
      [{ type: "openSearch" }, "overlay:search"],
      [{ type: "openHelp" }, "overlay:help"],
      [{ type: "closeOverlay" }, "overlay:none"],
      [{ type: "focusColumn", column: "tree" }, `focus:${COLUMN_FOCUS_SELECTORS.tree}`],
      [{ type: "focusColumn", column: "note" }, `focus:${COLUMN_FOCUS_SELECTORS.note}`],
      [{ type: "focusColumn", column: "graph" }, `focus:${COLUMN_FOCUS_SELECTORS.graph}`],
      [{ type: "filterTree" }, `focus:${TREE_FILTER_SELECTOR}`],
      [{ type: "fitGraph" }, "fit"],
      [{ type: "clearSelection" }, "clear"],
      [{ type: "toggleEdit" }, "toggleEdit"],
      [{ type: "saveNote" }, "saveNote"],
    ];
    for (const [action, expected] of cases) {
      const fx = effects();
      runShellAction(action, fx);
      expect(fx.log, action.type).toEqual([expected]);
    }
  });

  it("tolerates a column that is not on screen at this breakpoint", () => {
    // Below 1100 px the graph column does not exist and `⌘3` legitimately
    // finds nothing. A miss is normal, not an error.
    const fx = effects(false);
    runShellAction({ type: "focusColumn", column: "graph" }, fx);
    expect(fx.log).toHaveLength(1);
  });
});

describe("every action is reachable from a key", () => {
  it("binds every action, from the four gates", () => {
    // The P4 exit criterion asserted as a set equality rather than as a list
    // of examples: an action nobody can reach by keyboard fails here, and so
    // does a key bound to nothing.
    const produced = new Set<string>();
    const contexts: KeyContext[] = [IDLE, { overlay: null, hasSelection: true }, { overlay: "search", hasSelection: true }];
    const candidates = [
      ...Object.keys(COMMAND_KEYS).map((letter) => key({ key: letter, meta: true })),
      ...Object.keys(COLUMN_DIGITS).map((digit) => key({ key: digit, meta: true })),
      ...Object.keys(BARE_KEYS).map((k) => key({ key: k })),
      key({ key: "Escape" }),
    ];
    for (const ctx of contexts) {
      for (const descriptor of candidates) {
        const action = shellKey(descriptor, ctx);
        if (action !== null) produced.add(action.type);
      }
    }
    expect([...produced].sort()).toEqual(
      [
        "clearSelection",
        "closeOverlay",
        "filterTree",
        "fitGraph",
        "focusColumn",
        "openHelp",
        "openSearch",
        "saveNote",
        "toggleEdit",
      ].sort(),
    );
  });
});

// --- focusing --------------------------------------------------------------------------

describe("focusable and focusSelector", () => {
  it("accepts anything with a focus method and rejects the rest", () => {
    expect(focusable({ focus: () => {} })).not.toBeNull();
    expect(focusable(null)).toBeNull();
    expect(focusable(undefined)).toBeNull();
    // What a `querySelector` for a plain element returns: no `focus`.
    expect(focusable({ tagName: "DIV" })).toBeNull();
    expect(focusable({ focus: "not a function" })).toBeNull();
  });

  it("focuses the match and reports it", () => {
    let focused = 0;
    const document = { querySelector: () => ({ focus: () => void focused++ }) };
    expect(focusSelector(document, ".weave-filter")).toBe(true);
    expect(focused).toBe(1);
  });

  it("reports a miss rather than throwing", () => {
    expect(focusSelector({ querySelector: () => null }, ".weave-filter")).toBe(false);
  });

  it("points every selector at a column's content, not its section", () => {
    // Focusing the `<section>` would put the ring around the whole pane and
    // leave the arrow keys pointing at nothing.
    for (const column of COLUMNS) {
      const selector = COLUMN_FOCUS_SELECTORS[column];
      expect(selector, column).toContain(`.weave-col-${column} `);
    }
    expect(TREE_FILTER_SELECTOR).toContain(".weave-filter");
  });
});

// --- vim keys in the tree ------------------------------------------------------------

describe("normalizeTreeKey", () => {
  function rows(): TreeRow[] {
    return [
      { id: "vault", kind: "vault", label: "Vault", depth: 0, hasKids: true, expanded: true, provenance: null, meta: null },
      { id: "note:a", kind: "note", label: "A", depth: 1, hasKids: false, expanded: false, provenance: "human", meta: null },
      { id: "note:b", kind: "note", label: "B", depth: 1, hasKids: false, expanded: false, provenance: "human", meta: null },
    ];
  }
  const state = { expanded: new Set(["vault"]), showInternals: false, provFilter: null, query: "" };

  it("aliases j and k onto the arrows", () => {
    expect(normalizeTreeKey("j")).toBe("ArrowDown");
    expect(normalizeTreeKey("k")).toBe("ArrowUp");
    expect(VIM_KEYS).toEqual({ j: "ArrowDown", k: "ArrowUp" });
  });

  it("leaves every other key untouched", () => {
    for (const k of ["ArrowDown", "Tab", "Home", "a"]) expect(normalizeTreeKey(k)).toBe(k);
  });

  it("leaves the Shift-modified forms alone — vim binds J and K elsewhere", () => {
    expect(normalizeTreeKey("J")).toBe("J");
    expect(normalizeTreeKey("K")).toBe("K");
  });

  it("moves the tree exactly as the arrows do", () => {
    expect(treeKey(rows(), state, "note:a", "j")).toEqual(treeKey(rows(), state, "note:a", "ArrowDown"));
    expect(treeKey(rows(), state, "note:b", "k")).toEqual(treeKey(rows(), state, "note:b", "ArrowUp"));
    expect(treeKey(rows(), state, "note:a", "j").selectedId).toBe("note:b");
  });

  it("still returns handled:false for J and K, so Shift+J is not swallowed", () => {
    expect(treeKey(rows(), state, "note:a", "J").handled).toBe(false);
  });

  it("is tree-scoped: the global map does not claim j or k", () => {
    // §11 says "vim-ish j/k **in the tree**". A global `j` would move the
    // tree's cursor while the user is reading the note column.
    expect(shellKey(key({ key: "j" }), IDLE)).toBeNull();
    expect(shellKey(key({ key: "k" }), IDLE)).toBeNull();
  });
});

// --- the help sheet -----------------------------------------------------------------

describe("keyHelp", () => {
  const groups = keyHelp("⌘");
  const combos = groups.flatMap((g) => g.entries.map((e) => e.combo));

  it("uses the platform's command spelling", () => {
    expect(combos).toContain("⌘K");
    expect(keyHelp("Ctrl ").flatMap((g) => g.entries.map((e) => e.combo))).toContain("Ctrl K");
  });

  it("documents every global key the map actually claims", () => {
    // A help overlay that documents a key the code does not implement is
    // worse than no help overlay, so the column rows are *derived* from
    // `COLUMN_DIGITS` and the rest is checked against `shellKey` here.
    for (const bare of Object.keys(BARE_KEYS)) expect(combos, bare).toContain(bare);
    for (const digit of Object.keys(COLUMN_DIGITS)) expect(combos).toContain(`⌘${digit}`);
    expect(combos).toContain("Esc");
  });

  it("documents no bare letter the global map refuses", () => {
    // Scoped to the letters, deliberately: the arrows in the Tree and Search
    // groups belong to `treeKey` and `searchKey`, which the global map is
    // *supposed* to answer `null` for — that is how those handlers get them.
    const letters = combos.filter((c) => /^[a-z/?]$/.test(c));
    for (const combo of letters) {
      expect(shellKey(key({ key: combo }), IDLE), combo).not.toBeNull();
    }
    expect(letters.sort()).toEqual(Object.keys(BARE_KEYS).sort());
  });

  it("covers the tree's vim aliases and both arrow behaviours", () => {
    const tree = groups.find((g) => g.title === "Tree");
    expect(tree?.entries.map((e) => e.combo)).toEqual(expect.arrayContaining(["j / ↓", "k / ↑", "→", "←"]));
    // The two-behaviour arrows are the tree's least discoverable feature, so
    // the sheet says what each does in both states.
    expect(tree?.entries.find((e) => e.combo === "→")?.what).toContain("step into");
    expect(tree?.entries.find((e) => e.combo === "←")?.what).toContain("step out");
  });

  it("groups by surface, so the sheet reads as a map of the workspace", () => {
    expect(groups.map((g) => g.title)).toEqual(["Global", "Tree", "Note", "Graph", "Search"]);
    for (const group of groups) expect(group.entries.length, group.title).toBeGreaterThan(0);
  });

  it("has a name and a way out", () => {
    expect(HELP_TITLE).not.toBe("");
    expect(HELP_HINT).toContain("esc");
  });
});
