/**
 * Format a PLUPR for display.
 *
 * Players who haven't played any matches show "Not Rated" instead of the
 * default 3.25 base value — keeps brand-new accounts from looking like they
 * already have a real rating.
 *
 * `matchesPlayed` is `profiles.total_matches_played` (or any equivalent
 * counter). Pass `null`/`undefined` when the count isn't loaded — falls back
 * to the numeric display so the UI never silently hides a real rating.
 */
export function formatPlupr(
  rating: number | null | undefined,
  matchesPlayed: number | null | undefined,
): string {
  if (matchesPlayed === 0) return 'Not Rated';
  if (rating == null) return 'Not Rated';
  return Number(rating).toFixed(2);
}

/** Short "NR" variant for tight columns (tables, pills). */
export function formatPluprShort(
  rating: number | null | undefined,
  matchesPlayed: number | null | undefined,
): string {
  if (matchesPlayed === 0) return 'NR';
  if (rating == null) return 'NR';
  return Number(rating).toFixed(2);
}
