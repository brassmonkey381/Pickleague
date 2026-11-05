# Play group offer

"Group session: Ladder Night": the league event or tournament I'm in that is around now, offered on
the Play sheet so my session joins the group.

- **Current version:** `play-group-offer-v1`
- **Defined by:** `mobile/src/lib/playStartRules.ts:366` (`pickGroupOffer`). Caller:
  `mobile/src/components/play/PlayStartSheet.tsx:253` (only on the slim sheet with no fixed kind).

## Candidates

My calendar items of kind `event` or `tournament` that have a group id (lines 368-369).

## Filters

Around now: 60 minutes before the start to 60 minutes after it, or to its end if later
(`aroundNow`, `AROUND_NOW_MS`, line 130).

## Scoring

None.

## Tie-breaks

Start nearest now (line 370). Equal: schedule order.

## What is shown

At most one offer. Accepting it logs `group_session.start` with `from: 'sheet_offer'`
(`PlayStartSheet.tsx:450`).

## Known weaknesses

- No impression is logged, so the accept rate can't be computed.
- Two groups at the same time: only the nearest start is offered.

## Changelog

| Version | Date | Change | Why | Commit or migration |
| --- | --- | --- | --- | --- |
| v1 | 2026-10-30 | First version. | Group sessions for league events and tournaments (PKL-013) | `2a44d05` "Group sessions for league events and tournaments" |
