/**
 * Turn a human title into a stable, filesystem-safe slug.
 *
 * Slugs are the identity of vault notes, so this function is deliberately
 * simple and deterministic: lowercase, ASCII-fold, dashes.
 */
export function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return slug.length > 0 ? slug : "note";
}

/**
 * Find a free slug in the vault given a desired base, appending -2, -3, ...
 * `exists` is injected so this stays pure and trivially testable.
 */
export function uniqueSlug(base: string, exists: (slug: string) => boolean): string {
  if (!exists(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!exists(candidate)) return candidate;
  }
}
