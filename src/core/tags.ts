/**
 * The tags that name a CIGE case wherever it runs: `cige` on every case,
 * `cige:<id>` on one, `cige:<id>/<variant>` on one of its variants. A hosted
 * runner (e2e) filters its tests by them; an owned run (`cige run`) selects
 * cases by the same strings, so `--tag cige:<id>` means one thing everywhere.
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
