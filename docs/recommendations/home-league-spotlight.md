# Home league spotlight

Which of my leagues Home's Your leagues card opens on when I have not picked one. Shown on Home
(`mobile/src/components/home/LeagueSpotlight.tsx`).

- **Current version:** `home-league-spotlight-v1`
- **Defined by:** `mobile/src/lib/agenda.ts:608` (`pickSpotlightLeague`), used by
  `useLeagueSpotlight` (`LeagueSpotlight.tsx:72`). Last commit on `agenda.ts`: `dc3ed01` (copy only;
  the function is unchanged since `8b5c4c7`).

## Candidates

My leagues from Home's payload (`mobile/src/components/home/homeData.ts`).

## Filters

None. A league I chose by chip wins over the pick: the choice is remembered per user
(`home:spotlight:<userId>`, `LeagueSpotlight.tsx:74`), until I leave that league.

## Scoring

A tier per league (`agenda.ts:613`):

| Tier | Rule |
| --- | --- |
| 0 | has an open vote |
| 1 | has an upcoming next event |
| 2 | has an active season |
| 3 | anything else |

## Tie-breaks

In order (`agenda.ts:616-622`): tier asc; in tier 0, the vote that closes soonest; in tiers 0 and 1,
the soonest next event; then the newest match first; then list order. Missing times sort last.

## What is shown

One league card: header, status line, top 3 standings rows (`SPOTLIGHT_ROWS = 3`,
`LeagueSpotlight.tsx:50`) with my row pinned, and a "Next" line. With 2 or more leagues, chips switch.

## Known weaknesses

- The newest match is read for the first 12 leagues only (`LAST_MATCH_LEAGUES = 12`,
  `homeData.ts:189`); later leagues tie on it.
- No signal from my own play: a league I never play in but that has a vote outranks my busiest one.
- Data that would help: how often the default pick is switched away from (log default versus chosen
  on the spotlight's `home.tap`).

## Changelog

| Version | Date | Change | Why | Commit or migration |
| --- | --- | --- | --- | --- |
| v1 | 2026-10-13 | First version: open vote, next event, active season, newest match. | League spotlight replaced Yours on Home | `8b5c4c7` "ui: clear-all notifications, league spotlight on Home, open standings on LeagueDetail" |
