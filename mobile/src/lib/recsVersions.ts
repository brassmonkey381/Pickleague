/**
 * The current version of every recommender (docs/recommendations/README.md, the index's "Current
 * version" column). trackRecShown / trackRecActed (lib/analytics) stamp each `recs.*` event with
 * the version from HERE, never from the call site, so one version of a rule can be compared with
 * the next.
 *
 * Any change to a recommender's candidates, filters, scoring, tie-breaks, cap or fallback bumps
 * its version HERE, in the same commit as the rule change, and adds the changelog row on that
 * recommender's page (docs/recommendations/<name>.md). The string must equal the README's.
 */
export const RECS_VERSIONS = {
  'suggest-friends': 'suggest-friends-v2',
  'players-near': 'players-near-v1',
  'player-search': 'player-search-v1',
  'league-invite-suggestions': 'league-invite-suggestions-v4',
  'tournament-invite-suggestions': 'tournament-invite-suggestions-v3',
  'invite-picker-suggestions': 'invite-picker-suggestions-v1',
  'drill-partner-search': 'drill-partner-search-v4',
  'routine-suggestions': 'routine-suggestions-v1',
  'play-chip-pick': 'play-chip-pick-v2',
  'play-group-offer': 'play-group-offer-v1',
  'home-league-spotlight': 'home-league-spotlight-v1',
  'home-join-a-league': 'home-join-a-league-v2',
  'home-open-near-you': 'home-open-near-you-v2',
  'discover-league-order': 'discover-league-order-v2',
  'saved-league-suggestions': 'saved-league-suggestions-v1',
  'courts-nearby': 'courts-nearby-v1',
  'home-feed-court-cards': 'home-feed-court-cards-v2',
  'suggested-courts': 'suggested-courts-v1',
} as const;

/** A recommender's name, as in the README index (kebab case). */
export type Recommender = keyof typeof RECS_VERSIONS;
