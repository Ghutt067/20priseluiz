/**
 * Normalize a search query for consistent fuzzy matching.
 * Lowercases, trims, removes diacritics.
 */
export function normalizeLookupQuery(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replaceAll(/\p{Diacritic}/gu, '')
}
