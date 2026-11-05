# Routine suggestions

"Weekdays around 9 AM at Lakeside? Make it a routine?": a weekly court routine found in my own
check-ins. Shown as a card in the Home feed (`mobile/src/components/routines/RoutineSuggestionCard.tsx`,
rendered by `mobile/src/components/feed/PickleagueFeedSection.tsx:867`) and as a Suggested list in My
routine (`mobile/src/screens/CourtRoutinesScreen.tsx:287`). Behind `ROUTINES_ENABLED` (on,
`mobile/src/lib/features.ts:114`).

- **Current version:** `routine-suggestions-v1`
- **Defined by:** `supabase/migration_court_routines.sql:1208`, `public.suggest_court_routines(p_tz)`
  (the only definition). Ported from Doggle's `suggest_checkin_routines`. Last commit on the file:
  `d2889dd` (no change to this function since `b79594a`).
- **App:** `mobile/src/data/courtRoutines.ts:158` (cached 1 hour, kept 1 day), parsed by
  `mobile/src/lib/courtRoutineRules.ts:227`.

## Candidates

My check-ins in the last 42 days (line 1233) that are location-confirmed and not taken back (line
1232), at a court I star (`_pl_is_starred`, line 1237). Alias venues fold into their canonical court.
Times are read in my time zone (the device's, else my saved one).

## Filters

- A habit needs 3 or more different days (line 1252).
- Weekdays (Mon to Fri) and weekends are separate habits.
- A habit already covered by one of my routines is dropped: same court, a shared weekday, routine time
  within 45 minutes (line 1276).
- The app hides any suggestion I said "Not now" to. That list is stored on the device only
  (`pickleague_routine_suggestions_dismissed_v1`, `RoutineSuggestionCard.tsx:25`), keyed by court, days
  and time.

## Scoring

For each check-in, the cluster is every check-in at the same court, same weekday or weekend group,
within 40 minutes of its time of day (line 1246). Its strength `n` is the number of distinct days.

- Best cluster per court and group: `n desc`, then earlier median time (line 1250). A weaker cluster
  is kept only if its median is more than 60 minutes from every stronger one (line 1265).
- Time: the median check-in time, rounded to 15 minutes (line 1256).
- Length: the median stay rounded to 30 minutes, clamped 30 to 240 minutes (line 1257).
- Days, weekdays: Mon to Fri when the habit touched 3 or more different weekdays, else just the
  weekdays seen (line 1259). Weekends: the weekend days seen (line 1260).

## Tie-breaks

`n desc`, then time of day (lines 1277, 1287).

## What is shown

At most 3 from the server (line 1278). Home shows the first one not dismissed; My routine lists every
one not dismissed. One tap adds it with the habit's length and no play windows
(`RoutineSuggestionCard.tsx:67`).

## Known weaknesses

- Unstarred courts never produce a suggestion, even with daily check-ins.
- Only location-confirmed check-ins count, so players who check in by hand never get one.
- The dismiss list lives on one device; a second phone shows the same suggestion again.
- Data that would help: shown, Add and Not now counts, and whether an added routine is kept 4 weeks
  later.

## Changelog

| Version | Date | Change | Why | Commit or migration |
| --- | --- | --- | --- | --- |
| v1 | 2026-10-21 | First version: 3+ days in 42, within 40 minutes, starred courts, confirmed check-ins, top 3. | Routine check-ins (Doggle parity) | `b79594a` "Routine check-ins (server)", `1748d51` "Routines (app)", `migration_court_routines.sql` |
