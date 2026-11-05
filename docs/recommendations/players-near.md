# Players near

The players who play inside the search area, nearest first. Shown in Discover > Players > Nearby
(`mobile/src/components/discover/PlayersPanel.tsx:247`) and in the player search before a name is
typed. It is also the candidate pool for the league, tournament and invite picker suggestions and for
Find drillers (with an area).

- **Current version:** `players-near-v1`
- **Defined by:** `supabase/migration_discover_players_near.sql:47`, `public.discover_players_near`.
  Last commit on that file: `c55a5c0`.
- **App:** `mobile/src/data/playersNear.ts` (`listPlayersNear`), pure rules in
  `mobile/src/lib/playersNear.ts`. Before the SQL is applied on a server, the app uses a fallback with
  the same placement rule (`lib/playersNear.ts:72`, `leagueAnchorsInArea`).

## Candidates

One source only (the user, 2026-10-24: "League courts only"). A player is placed at the home court of
an active league they belong to (lines 113-128):

- the league has a home court with coordinates, not 0/0;
- the membership has not expired (guest passes that ran out don't count);
- the league is open, or the viewer is in it too (a closed roster is not public).

Never a starred court, a check-in, or live location. A player in several leagues is placed at the
nearest of those courts (`distinct on`, line 142).

## Filters

- Inside the circle: great-circle distance to the court `<= radius` (lines 130-141). Radius is
  clamped to 100 m .. 80,468 m (50 mi) (line 100). The server default is 8,047 m (5 mi); the app sends
  the search area's radius (5, 10, 25 or 50 mi, `mobile/src/lib/searchArea.ts:28`, default 5 at
  line 30).
- Left out (lines 150-156): the viewer, `p_exclude`, deleted accounts, test accounts while God mode
  hides them, blocked pairs both ways (`_pl_blocked_pair`), and with `p_real_people_only` unclaimed
  placeholders and guest passes. `p_drilling_only` keeps only players with drilling on.
- `p_query` narrows by name or @username.

Fallback differences: it can leave out only the players I blocked (who blocked me is not readable),
and it reads at most 500 players from `discover_players` (`data/playersNear.ts:79`).

## Scoring

Distance only. `distance_m` is the haversine distance from the area centre to the player's nearest
league court.

## Tie-breaks

`order by distance, full_name, id` (line 157). Fallback: distance, then name
(`lib/playersNear.ts:108`).

## What is shown

Nearby asks for 200 real people (`PlayersPanel.tsx:249`); the search's empty-query list asks for 500
(`PlayersPanel.tsx:319`). Server cap 1 to 500 (line 158). Each row reads "Plays at <court>, 1.2 mi"
(`lib/playersNear.ts:119`).

## Known weaknesses

- Only a handful of players are in a league with a located court, so most players can never appear.
- Everyone at the same league court ties on distance and falls to alphabetical order.
- No level, activity or recency: a member who has not played in a year ranks the same as a regular.
- Data that would help: last match date per player, and (with consent) the courts they check in at.

## Changelog

| Version | Date | Change | Why | Commit or migration |
| --- | --- | --- | --- | --- |
| v1 | 2026-10-24 | First version: placed by league home courts only, nearest first. An earlier draft that also used starred and frequent courts was never applied on a server, so it is not a version. | Discover's one search area limits every search; the user: "League courts only" | `1c0e0ed` "Discover: one search area", `7a3e7f1`, `c55a5c0` "Players near: league courts only", `migration_discover_players_near.sql` |
