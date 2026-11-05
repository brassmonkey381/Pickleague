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

What exists today: `mobile/src/lib/analytics.ts` `track(name, props)` writes to `analytics_events`
(no PII in props). Nothing logs a recommender version yet, and no recommender logs what it showed
(impressions). Only a few log a tap or an accept.

| Recommender | Shown | Accepted | What is missing |
| --- | --- | --- | --- |
| Suggest friends | `discover.players_view` (view only, `PlayersPanel.tsx:415`) | none | impression with count, Add tap with position, version |
| Players near | `discover.players_view` (view only) | none | row tap (profile open) with position, version |
| Player search | none | `discover.players_search_pick` (`PlayersPanel.tsx:333`, no position, no section) | position, section (near or everywhere), version |
| League invite suggestions | none | none | impression, invite sent with rank, source (place, area, anywhere), version |
| Tournament invite suggestions | none | none | same as league invites |
| Invite picker suggestions | none | none | whether a picked player came from the suggested block |
| Drill partner search | none | none | impression, sort mode, request sent with rank, version |
| Routine suggestions | none | none | shown, Add, Not now (the dismiss is stored only on the device) |
| Play chip pick | `play.start_sheet`, `play.quick_start` log `chip` and `why` (`PlayStartSheet.tsx:455`, `quickPlay.ts:57`) | partly | the picked chip is not logged next to the final chip, so an override can't be counted; version |
| Play group offer | none | `group_session.start` with `from: 'sheet_offer'` (`PlayStartSheet.tsx:450`) | impression of the offer, version |
| Home league spotlight | none | `home.tap` section `spotlight` (`HomeScreen.tsx:771`) | whether the shown league was the default pick or a remembered chip |
| Home join a league | none | `home.tap` section `join`, targets `row`, `join`, `request` with position (`HomeScreen.tsx:620`) | impression (which leagues, how many), sort used, version |
| Home open near you | none | `home.tap` section `open_near_you`, target `league` or `tournament` with position (`HomeScreen.tsx:828`) | impression, sorted or not, version |
| Discover league order | `discover.tab` (tab only) | none (`trackPlayFilter` exists but has no caller) | sort in effect, row tap with position, join from Discover |
| Saved league suggestions | none | `saved_suggestion_save` (`BookmarksScreen.tsx:144`), `saved_league_open` with `from: 'suggested'` | impression, position |
| Courts nearby | `courts.open`, `courts.filter` (sort, radius) | `courts.view` on the court page, no position or source | row tap with position and sort, version |
| Home feed court cards | none | `home.tap` section `feed`, target `court` (no position, `PickleagueFeedSection.tsx:671`) | card position, why the card is there (star, mine, friend) |

The cheapest common fix: one helper, `trackRec(name, version, event, props)`, called on show and on
accept, with the version string from each page.
