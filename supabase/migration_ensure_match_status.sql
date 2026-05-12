-- ============================================================
-- Prerequisite for migration_plupr_weighted_scoring.sql:
-- ensure the `matches.status` column exists and that every historical
-- row is marked 'completed'.
--
-- This duplicates the column-add from migration_add_scheduling.sql but
-- in an idempotent form, safe to run in any project state.  No-op if
-- the column is already present and populated.
-- ============================================================

-- 1. Add the column if missing.  Default 'completed' fills new rows AND
--    existing rows when the column is being added for the first time.
alter table public.matches
  add column if not exists status text not null default 'completed';

-- 2. Re-affirm the status check constraint.  Some older databases never
--    had it; some had a different version.  Drop and recreate to converge.
alter table public.matches
  drop constraint if exists matches_status_check;
alter table public.matches
  add constraint matches_status_check
  check (status in ('scheduled', 'completed'));

-- 3. Defensive sweep: any null or empty status becomes 'completed'.
--    (The not-null default makes new rows safe; this catches any rows
--    that survived a pre-default schema state.)
update public.matches
   set status = 'completed'
 where status is null or status = '';

-- 4. Quick sanity report — count of rows by status.
do $$
declare
  v_completed integer;
  v_scheduled integer;
begin
  select count(*) into v_completed from public.matches where status = 'completed';
  select count(*) into v_scheduled from public.matches where status = 'scheduled';
  raise notice 'matches.status: % completed, % scheduled', v_completed, v_scheduled;
end$$;
