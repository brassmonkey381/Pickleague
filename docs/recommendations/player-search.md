# Player search

The order of name-search results. Typing 2 or more letters searches every player; the ones who play
near the search area come first. Shown in Discover > Players search (`UserPickerModal` through
`mobile/src/components/discover/PlayersPanel.tsx:322`).

- **Current version:** `player-search-v1`
- **Defined by:** `supabase/migration_search_players.sql:51`, `public.search_players`. Commit
  `3e776f3`.
- **App:** `mobile/src/data/playerSearch.ts`, grouping in `mobile/src/lib/playerSearch.ts:36`
  (`groupSearchResults`).

## Candidates

Everyone whose full name or @username contains the query (line 142). The query: leading @ dropped,
trimmed, at least 2 characters (line 99, app `lib/playerSearch.ts:15`), at most 80 kept. `%` and `_`
are literal.

Placement: the players `discover_players_near` places in the area, called with the same name and a
limit of 500 (line 119). Everyone else comes back unplaced.

## Filters

Left out (lines 136-141): the viewer, `p_exclude`, deleted accounts, test accounts while God mode
hides them, blocked pairs both ways, and with `p_real_people_only` unclaimed placeholders and guest
passes. The Discover search passes real people only and excludes me and the players I blocked
(`PlayersPanel.tsx:325`).

## Scoring

No score. A fixed sort (lines 143-147):

1. placed players first;
2. then by distance (placed only);
3. then names that start with the query, or have a word starting with it, or a username starting
   with it, before names that only contain it;
4. then full name, then id.

## Tie-breaks

Full name, then id (line 147).

## What is shown

The app asks for 60 (`PlayersPanel.tsx:325`); the server caps at 1 to 200, default 60 (line 148).
The app splits them into "Near <area>" and "Everywhere else" (or "Everywhere else (no one near
<area>)") (`lib/playerSearch.ts:36-51`). With no area, one group, no heading.

## Known weaknesses

- Among unplaced players the order is alphabetical after the prefix rule: no level, friends or
  activity signal.
- Two players with the same name are ordered by id, which means nothing to the viewer.
- Data that would help: friends and friends-of-friends first, recent activity, and which result
  position gets picked (today `discover.players_search_pick` has no position).

## Changelog

| Version | Date | Change | Why | Commit or migration |
| --- | --- | --- | --- | --- |
| v1 | 2026-10-24 | First version: everyone by name, players near the area first. | The user: "typing a NAME finds anyone, with the players near the search area listed first" | `3e776f3`, `migration_search_players.sql` |
