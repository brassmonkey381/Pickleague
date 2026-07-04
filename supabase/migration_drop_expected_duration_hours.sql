-- Collapse the duration column split-brain.
--
-- migration_tournament_duration.sql added expected_duration_hours (default 3)
-- and CreateTournamentScreen wrote it — but every READER uses
-- expected_length_hours (migration_add_tournament_length.sql):
-- TournamentDetailScreen (display + edit), DrillScreen schedule overlays, and
-- the wager-settlement RPCs (get_my_wagers_with_details / get_wagers_on_player
-- compute wager end as start_time + expected_length_hours). So a duration
-- typed at creation was silently dropped. The app now writes
-- expected_length_hours; this migration preserves any intentional values and
-- drops the dead column.
--
-- Backfill note: expected_duration_hours defaulted to 3, so a value of 3 is
-- indistinguishable from "never touched" — only non-default values are copied.
-- (At apply time prod had zero non-default rows; this is belt-and-braces.)

update public.tournaments
   set expected_length_hours = expected_duration_hours
 where expected_length_hours is null
   and expected_duration_hours is not null
   and expected_duration_hours <> 3
   -- respect the length column's check constraint
   and expected_duration_hours between 0.5 and 168;

alter table public.tournaments
  drop column if exists expected_duration_hours;
