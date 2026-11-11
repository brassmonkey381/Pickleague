# Recommendations

Every place Pickleague picks or orders something for the player: people, partners, courts, leagues,
routines, the Play chip. One page per recommender, with its current rules and a changelog.

Pickleague is early here. Most of these are fixed rules (distance, level band, schedule overlap), not
learned models. That is fine. What matters is that the rules are written down and every change is
dated.

A plain sort the player picks for themselves (alphabetical lists, newest-first history, Name A-Z) is
not a recommender and is not listed.

## Index

| Recommender | What it recommends | Where it shows | Current version | Source of truth |
| --- | --- | --- | --- | --- |
| [Suggest friends](suggest-friends.md) | People to add as friends | Discover > Players > Played with | `suggest-friends-v2` | `supabase/migration_hide_test_accounts.sql`, `suggest_friends` (line 429) |
| [Players near](players-near.md) | Players who play in the search area | Discover > Players > Nearby, and the candidate pool for 4 others | `players-near-v1` | `supabase/migration_discover_players_near.sql`, `discover_players_near` (line 47); app fallback `mobile/src/lib/playersNear.ts:72` |
| [Player search](player-search.md) | Order of name-search results | Discover > Players search, people pickers | `player-search-v1` | `supabase/migration_search_players.sql`, `search_players` (line 51) |
| [League invite suggestions](league-invite-suggestions.md) | Players to invite to a league | League members > Suggest | `league-invite-suggestions-v4` | `mobile/src/screens/LeagueMembersScreen.tsx:244` (`loadSuggestionsInner`) |
| [Tournament invite suggestions](tournament-invite-suggestions.md) | Players to invite to a tournament | Tournament > Invite players | `tournament-invite-suggestions-v3` | `mobile/src/screens/TournamentInvitePlayersScreen.tsx:153` (`loadInner`) |
| [Invite picker suggestions](invite-picker-suggestions.md) | Players listed first in the invite picker | Invite code > Send in app | `invite-picker-suggestions-v1` | `mobile/src/components/MultiUserPickerModal.tsx:87` |
| [Drill partner search](drill-partner-search.md) | Drill partners, ranked | Drills > Find drillers | `drill-partner-search-v4` | `mobile/src/screens/DrillSearchScreen.tsx:76` (`toCandidate`), `:212` (sort) |
| [Routine suggestions](routine-suggestions.md) | A weekly court routine from my check-ins | Home feed card, My routine > Suggested | `routine-suggestions-v1` | `supabase/migration_court_routines.sql`, `suggest_court_routines` (line 1208) |
| [Play chip pick](play-chip-pick.md) | Which chip (Open play, Closed group, Drill) Play starts on | Play sheet, one-tap Check in | `play-chip-pick-v2` | `mobile/src/lib/playStartRules.ts:214` (`pickPlayChip`) |
| [Play group offer](play-group-offer.md) | "Group session: X" offer on the Play sheet | Play sheet | `play-group-offer-v1` | `mobile/src/lib/playStartRules.ts:366` (`pickGroupOffer`) |
| [Home league spotlight](home-league-spotlight.md) | Which of my leagues Home shows | Home > Your leagues | `home-league-spotlight-v1` | `mobile/src/lib/agenda.ts:608` (`pickSpotlightLeague`) |
| [Home join a league](home-join-a-league.md) | 3 leagues to join, for a player in none | Home > Join a league | `home-join-a-league-v2` | `mobile/src/screens/HomeScreen.tsx:502` (`joinLeagues`) |
| [Home open near you](home-open-near-you.md) | 3 open tournaments or leagues, for a member | Home > Open near you | `home-open-near-you-v2` | `mobile/src/screens/HomeScreen.tsx:519` (`openItems`) |
| [Discover league order](discover-league-order.md) | Default order of leagues to join | Discover > Leagues | `discover-league-order-v2` | `mobile/src/lib/playFilters.ts:286` (`resolveLeagueSort`), `:317` (`sortLeagues`) |
| [Saved league suggestions](saved-league-suggestions.md) | My leagues to save | Saved > Your leagues | `saved-league-suggestions-v1` | `mobile/src/lib/savedStandings.ts:269` (`leagueSuggestions`) |
| [Courts nearby](courts-nearby.md) | Courts near me, nearest first | Discover > Courts | `courts-nearby-v1` | `supabase/migration_court_discovery_p1.sql`, `list_courts_nearby` (line 128); `mobile/src/lib/courtDiscovery.ts:310` |
| [Home feed court cards](home-feed-court-cards.md) | Which court cards Home shows, and in what order | Home > Pickleague Feed | `home-feed-court-cards-v2` | `mobile/src/lib/pickleagueFeed.ts:491` (card rank), `:293` (`sortCourtLines`) |
| [Suggested courts](suggested-courts.md) | Courts to star, ranked by activity, leagues and distance | First run > Your courts | `suggested-courts-v1` | `supabase/migration_suggested_courts.sql`, `suggested_courts` |

Shared building block: `discover_players` (`supabase/migration_hide_test_accounts.sql:346`) with
`p_near_rating` orders by `abs(rating - p_near_rating)`, then name (line 376). It is the "anywhere"
fallback pool for the league, tournament and drill recommenders. It is not listed on its own: a change
to it is a change to each of those, and bumps each one.

## Rules

1. Any change to a recommender's candidates, filters, scoring, tie-breaks, cap or fallback bumps its
   version (`<name>-v1` to `<name>-v2`).
2. The same commit adds a changelog row to its page (version, date, change, why, commit or
   migration) and updates the version in the index above.
3. Copy-only changes (labels, separators, glyphs) do not bump the version.
4. A change to a shared piece (`discover_players`, `discover_players_near`, `lib/inviteSuggestions`)
   bumps every recommender that uses it. Each page lists what it depends on.
5. Every weight, threshold and cap on a page cites its file and line. If the code moves, fix the
   citation in the same commit.
6. Once a recommender logs its version (see Tracking), the logged string must equal the version here.

## Tracking

Two events, the same shape as Doggle's, written by `mobile/src/lib/analytics.ts` to
`analytics_events`:

- `recs.shown`: a recommender's list or card appeared. Props `recommender`, `version`, `surface`,
  `count`, plus extras. Once per appearance, not per render (`mobile/src/lib/useRecShown.ts`, keyed on
  the list's ids and props, or fired at the load's completion point). An empty list logs nothing.
- `recs.acted`: the player took (`action: 'accepted'`) or turned down (`'dismissed'`) a pick. Props
  `recommender`, `version`, `surface`, `action`, `rank` (1-based in the list as shown, null for a
  one-item card), plus extras.

Call `trackRecShown(name, { surface, count, ... })` and `trackRecActed(name, { surface, action, rank,
... })`. The version is never passed: it comes from `mobile/src/lib/recsVersions.ts`, which must equal
the index above (a vitest, `recsTracking.test.ts`, fails when they differ). Bump it there in the same
commit as the rule change. Extras are counts, ranks, surface slugs and enums (sort, source, section,
reason, target) only: never a name, nor another person's id.

| Recommender | Shown (surface, extras) | Acted | Not tracked yet |
| --- | --- | --- | --- |
| Suggest friends | `discover_players` | accepted on Add or row open (`target`), rank | dismiss (none exists) |
| Players near | `discover_players`, `radius_mi` | accepted on Add or row open (`target`), rank | none |
| Player search | `find_player` per search result list, `near` count | accepted on pick, rank, `section` (near or everywhere) | other people pickers |
| League invite suggestions | `league_members` per Suggest load, `source` (place, area, anywhere), `with_overlap` | accepted on Invite, rank | which player was finally invited (Invite opens the invite screen) |
| Tournament invite suggestions | `tournament_invite` per load, `source` | accepted on Invite of a suggested player, rank, `source`, `searched` | none |
| Invite picker suggestions | `league_invite_picker` or `tournament_invite_picker` | on Send: accepted when a suggested player was picked (`picked`, `picked_suggested`, `picked_ranks`), else dismissed | none |
| Drill partner search | `drill_search` per list and sort (not while searching), `sort`, `with_overlap` | accepted when a request is sent, rank, `sort`, `searched` | none |
| Routine suggestions | `home_card`, `my_routine` | accepted on Add, dismissed on Not now, rank | none |
| Play chip pick | `play_sheet` (`chip`, `why`), `quick_start` | on Start: accepted when the auto-picked chip is kept, dismissed when changed (`chip`, `picked_chip`, `why`). `play.start_sheet` and `play.quick_start` also carry `version` and `picked_chip` | one-tap Start (applied with no choice, shown only) |
| Play group offer | `play_sheet`, `kind` | on Start: accepted when taken, dismissed when passed over. `group_session.start` from the offer carries `version` | none |
| Home league spotlight | not tracked | not tracked | all: the card is not rendered while `HOME_FEED_ENABLED` is on (the feed replaced it); `home.tap` section `spotlight` remains |
| Home join a league | `home`, `sort` (nearest or open_busiest) | accepted on row, join or request (`target`), rank | none |
| Home open near you | `home`, `sorted`, `tournaments` | accepted on a row (`target` league or tournament), rank | none |
| Discover league order | `discover_leagues` per order (not while searching), `sort`, `filters_on` | accepted on row open, join or request (`target`), rank, `sort`, `searched` | none |
| Saved league suggestions | `saved` per load | accepted on Save or open (`target`), rank | none |
| Courts nearby | `courts` or `discover_courts` per first page (not while filtering), `sort`, `radius_mi`, `chips` | accepted on a row or a map pin's details (`target`), rank, `sort`, `filtered` | none |
| Home feed court cards | `home_feed`, `today`, and why each card is there (`star`, `mine`, `friend` counts) | accepted on a card's court open, rank in its day, `day`, `reason` | none |

The older events (`home.tap`, `discover.players_view`, `discover.players_search_pick`,
`saved_suggestion_save`, `courts.view`) still fire next to these.
