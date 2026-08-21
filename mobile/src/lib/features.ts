// Build-time feature flags.
//
// A flag here is for work that is MERGED but not SHIPPABLE - the code stays
// on master so it does not rot on a branch, while every user-visible entry
// point stays dark until the flag flips.

/**
 * Pickle wagering (bet earned pickles on match outcomes, exact scores, and
 * tournament finishes).
 *
 * OFF since 2026-08-16, for App Store review. The UI merged ahead of its
 * backend: every wager RPC the client calls is absent from the production
 * database - `calculate_wager_odds`, `place_wager`, `cancel_wager`,
 * `get_league_wager_totals`, `get_tournament_wager_totals`, `list_my_wagers`,
 * `get_player_wagers` all return PGRST202 (verified 2026-08-16). Only the
 * `wagers` table exists. So the flows fail at the point of use, and the
 * member lists fired failing lookups on mount.
 *
 * Two reasons this must stay OFF until the backend lands AND the store
 * position is decided:
 *   1. Guideline 2.1 - a reviewer who opens any wager flow hits a missing
 *      function. That reads as an unfinished app.
 *   2. Guideline 5.3 + age rating - wagering is a gambling-adjacent
 *      feature. The App Store listing declares a 4+ rating with no
 *      gambling, and Apple's rating questionnaire asks about simulated
 *      gambling explicitly. Turning this on means revisiting that
 *      declaration, virtual currency or not.
 *
 * To re-enable: ship the RPCs, flip this to true, re-answer the age-rating
 * questionnaire, and re-check the store copy (marketing-studio
 * apps/pickleague/app.yaml lists wagering under doNotMarket).
 */
export const WAGERS_ENABLED = false;
