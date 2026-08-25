/**
 * Applying computed layout widths to an element, under a strict CSP
 * (weave-workspace §5.2).
 *
 * ## The constraint, stated precisely
 *
 * `page.ts` serves `style-src 'nonce-{N}'` with **no `'unsafe-inline'`**. In
 * CSP terms that blocks a literal `style="…"` *attribute in the markup the
 * parser sees*. It does **not** block mutation of an element's
 * `CSSStyleDeclaration` from script: `el.style.setProperty(...)`,
 * `el.style.width = …` and `el.style.cssText = …` are CSSOM writes, and CSP
 * has no hook on them. This is why a strict-CSP app can still have dynamic
 * layout at all.
 *
 * Preact reaches the same place: `setProperty` in `preact/src/diff/props.js`
 * handles a `style` prop by assigning `dom.style.cssText` for a string, or by
 * `style.setProperty` / `style[key] = …` for an object. It never calls
 * `setAttribute("style", …)`. So a `style={{…}}` prop in a component would in
 * fact survive the CSP — verified in the installed source, not assumed.
 *
 * We still do not use one. The widths are written as **custom properties** by
 * this module, and the nonce'd stylesheet owns the `grid-template-columns`
 * rule that consumes them. The reason is not CSP but ownership: a `style`
 * prop would put a second layout implementation in the bundle, competing with
 * the one in CSS, and the browser's devtools would show a computed width with
 * no rule to trace it back to. One number per column in, one rule in CSS —
 * that is the whole contribution.
 *
 * ## Why the element is a parameter and the API is one function
 *
 * There is no DOM test environment (§10). Everything *decidable* about the
 * widths already lives in `layout.model.ts` as pure functions returning
 * `[name, value]` pairs; what remains here is a loop that hands those pairs
 * to a `setProperty` this module does not own. The port below is that method
 * and nothing else, so the untestable surface is one line long and a fake is
 * an object literal.
 */

/**
 * The slice of `CSSStyleDeclaration` used to apply a layout.
 *
 * A real `HTMLElement.style` satisfies it structurally. Declared here rather
 * than imported from the DOM lib because this module is compiled by the root
 * `tsconfig.json` when a test imports it, and that project has no `DOM` lib.
 */
export interface StyleTarget {
  setProperty(property: string, value: string): void;
}

/** An element with a `style`. `HTMLElement` satisfies it. */
export interface StyledElement {
  readonly style: StyleTarget;
}

/**
 * Write custom properties onto an element.
 *
 * Tolerates a `null` element so the caller — a `useLayoutEffect` holding a
 * ref — does not need a guard of its own. A ref is `null` on the render
 * before the element exists and on the one after it is removed, and both are
 * ordinary rather than exceptional.
 *
 * Returns the number of properties written, which is what makes the function
 * observable in a test without a DOM: `0` for a null element, `n` otherwise.
 */
export function applyVars(element: StyledElement | null, vars: readonly (readonly [string, string])[]): number {
  if (element === null) return 0;
  for (const [name, value] of vars) element.style.setProperty(name, value);
  return vars.length;
}
