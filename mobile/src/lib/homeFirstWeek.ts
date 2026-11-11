// The new-player Home (PKL-020 change 4). For a new player's first 7 days, Home
// leads with what to do next instead of numbers they don't have yet:
//   - Get started first, then JOIN A LEAGUE (leagues near you) right under it;
//   - no stat card (streak, pickles, shop, My Place, Court Pass): the band's
//     pills still show the streak and pickles;
//   - no feed while they're in no league (it would be empty or other people's).
// Once they join a league the feed comes back, so UP NEXT shows their first
// session. After 7 days Home is the usual one.
//
// PURE (no React Native), so vitest reads it.

export const FIRST_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** True while the account is under 7 days old. Unknown age: false (the usual Home). */
export function inFirstWeek(createdAt: string | null | undefined, nowMs: number): boolean {
  if (!createdAt) return false;
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return false;
  return nowMs - t < FIRST_WEEK_MS;
}

export type HomeFirstWeekLayout = {
  /** Get started and JOIN A LEAGUE go first, above the quick tiles. */
  leadWithStart: boolean;
  hideStats: boolean;
  hideFeed: boolean;
};

export function homeFirstWeekLayout(firstWeek: boolean, isMember: boolean): HomeFirstWeekLayout {
  return {
    leadWithStart: firstWeek,
    hideStats: firstWeek,
    hideFeed: firstWeek && !isMember,
  };
}
