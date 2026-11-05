# Play chip pick

Which chip the Play sheet opens on (Open play, Closed group, Drill), with a "From your 6 PM routine"
hint. The one-tap Check in uses the same pick without showing the sheet.

- **Current version:** `play-chip-pick-v2`
- **Defined by:** `mobile/src/lib/playStartRules.ts:214` (`pickPlayChip`). Last commit on the file:
  `dc3ed01` (copy only; last rule change `600ef24`).
- **Callers:** `mobile/src/components/play/PlayStartSheet.tsx:377` and
  `mobile/src/lib/quickPlay.ts:31` (one-tap; waits at most 1,500 ms for its inputs,
  `PICK_WAIT_MS`, line 21, else Open play).
- **Inputs:** `mobile/src/lib/playStartSchedule.ts` (my routine stop due at the court, my calendar),
  and the chip I used last (saved on the device).

## Candidates

Rules in order, the first that applies wins (lines 222-249):

1. **Routine:** a routine occurrence due at this court now. The chip is the play window's mode in
   force now: closed gives Closed group, drill gives Drill, anything else Open play. It also sets the
   length (time left to the planned end, clamped 30 to 240 minutes, else 120; line 184) and the
   windows.
2. **Drill:** a drill session or drill request around now gives Drill.
3. **Event:** an event, match or tournament around now gives Open play.
4. **Last used:** the chip I picked last time.
5. Else Open play, no hint.

"Around now" is 60 minutes before the start to 60 minutes after it, or to its end if later
(`AROUND_NOW_MS = 60 * 60_000`, line 130; `aroundNow`, line 202).

## Filters

Only items on my own calendar. Nothing about other players.

## Scoring

None. Inside a rule, the item whose start is nearest now wins (lines 233-236).

## Tie-breaks

Equal distance to now: the first in schedule order (sort is stable).

## What is shown

One chip, selected, with the hint line. The player can change it.

## Known weaknesses

- Tracking logs the final chip and `why`, not the picked chip, so overrides can't be counted.
- An event around now always means Open play, even for a closed league session.
- Data that would help: picked chip next to final chip in `play.start_sheet`.

## Changelog

| Version | Date | Change | Why | Commit or migration |
| --- | --- | --- | --- | --- |
| v1 | 2026-10-22 | First version: routine, drill, event, last used, default. Routine windows gave Open play or Closed group. | P1: one-tap Play and Check in | `caf194a` "P1: bottom bar (Home, Play, Check in, Discover, Me), one-tap Play and Check in" |
| v2 | 2026-10-29 | A routine window in Drill mode now picks the Drill chip. | Drill joins Closed group and Open play as a window mode | `600ef24` "One-off plans: edit length and play windows; Drill joins Closed group and Open play" |
