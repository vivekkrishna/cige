/**
 * The tags that name a CIGE case wherever it runs: `cige` on every case,
 * `cige:<id>` on one, `cige:<id>/<variant>` on one of its variants. A hosted
 * runner (e2e) filters its tests by them; an owned run (`cige run`) selects
 * cases by the same strings, so `--tag cige:<id>` means one thing everywhere.
 * Playwright Test tags start with `@`, so there a case carries `@cige:<id>`
 * and is picked out by `--grep` (`cigeGrep`).
 */

/** The tag every CIGE test carries. */
export const CIGE_TAG = 'cige';

/** The tag that selects one case by its id, or one of its variants. */
export function cigeTag(id: string, variant?: string): string {
  return variant === undefined ? `${CIGE_TAG}:${id}` : `${CIGE_TAG}:${id}/${variant}`;
}

/** Every tag a resolved case carries. */
export function tagsOf(id: string, variant?: string): string[] {
  return [CIGE_TAG, cigeTag(id), ...(variant === undefined ? [] : [cigeTag(id, variant)])];
}

/** A tag as Playwright Test writes it: with a leading `@`. */
export function playwrightTag(tag: string): string {
  return `@${tag}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The `--grep` pattern that selects exactly the tests carrying these tags in
 * Playwright Test: `@cige:checkout` and not `@cige:checkout-v2`, since grep
 * matches the title and tags as text.
 */
export function cigeGrep(tags: readonly string[]): string {
  return tags.map((tag) => `${escapeRegExp(playwrightTag(tag))}(?![\\w:./-])`).join('|');
}
