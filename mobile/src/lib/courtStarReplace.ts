// The words of the "Replace a starred court?" sheet (Doggle's
// ReplaceFavoriteModal: "Replace a favorite?", "You already have 3 favorite
// locations. Pick one to replace with “X”.", a row per favorite, Cancel).
// PURE, so vitest covers it (lib/__tests__/courtStarReplace.test.ts);
// components/court/useReplaceCourtStar shows it.

export type ReplaceSheetStar = { venue_id: string; venue_name?: string | null };

export type ReplaceSheetCopy = {
  title: string;
  subtitle: string;
  /** One per starred court, in the list's order; labels are unique (the sheet keys rows by label). */
  rows: { venueId: string; label: string }[];
};

export function replaceSheetCopy(stars: readonly ReplaceSheetStar[], newName?: string | null): ReplaceSheetCopy {
  const name = newName?.trim();
  const n = stars.length;
  const have = `You already have ${n} starred ${n === 1 ? 'court' : 'courts'}.`;
  const seen = new Map<string, number>();
  const rows = stars.map((s) => {
    const base = `Replace ${s.venue_name?.trim() || 'this court'}`;
    const k = (seen.get(base) ?? 0) + 1;
    seen.set(base, k);
    return { venueId: s.venue_id, label: k === 1 ? base : `${base} (${k})` };
  });
  return {
    title: 'Replace a starred court?',
    subtitle: name ? `${have} Pick one to replace with “${name}”.` : `${have} Pick one to replace.`,
    rows,
  };
}
