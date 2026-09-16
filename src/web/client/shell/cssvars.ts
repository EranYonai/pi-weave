export interface StyleTarget { setProperty(property: string, value: string): void }
export interface StyledElement { readonly style: StyleTarget }

export function applyVars(element: StyledElement | null, vars: readonly (readonly [string, string])[]): number {
  if (element === null) return 0;
  for (const [name, value] of vars) element.style.setProperty(name, value);
  return vars.length;
}
