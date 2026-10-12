-- ============================================================
-- Backfill: move UPCOMING drill sessions off the wall-clock-as-UTC start time
-- (see migration_drill_start_time_fix.sql). One transaction; prints every row
-- it changes. Safe to re-run: a fixed row no longer equals the old UTC value,
-- so it is never touched twice. Past sessions are left alone.
--
-- Also clears those sessions' drill reminder log entries, so the 24 h / 2 h
-- reminders fire at the right time instead of being "already sent" (they were
-- sent hours early).
--
-- Run only after migration_drill_start_time_fix.sql.
-- Apply:  supabase db query --linked -f supabase/backfill_drill_start_times.sql
-- 2026-10-12: production had 0 drill sessions, so this changes nothing today.
-- ============================================================
begin;

with candidates as (
  select ds.id,
         ds.starts_at as old_starts_at,
         public._drill_slot_starts_at(
           ds.session_date, ds.session_slot,
           public._pickleague_tz_for(coalesce(dr.from_user_id, ds.player1_id))
         ) as new_starts_at
    from public.drill_sessions ds
    left join public.drill_requests dr on dr.id = ds.request_id
   where ds.session_date is not null
     and ds.session_slot is not null
     -- still holding the buggy value: the slot read as UTC
     and ds.starts_at = (ds.session_date::timestamp + ds.session_slot * interval '30 minutes') at time zone 'UTC'
),
fixed as (
  update public.drill_sessions ds
     set starts_at = c.new_starts_at
    from candidates c
   where ds.id = c.id
     and c.new_starts_at > now()                    -- upcoming only
     and c.new_starts_at is distinct from c.old_starts_at
  returning ds.id, c.old_starts_at, ds.starts_at as new_starts_at
),
relogged as (
  delete from public.reminder_log rl
   using fixed f
   where rl.entity_id = f.id
     and rl.kind in ('drill_session_24h', 'drill_session_2h')
  returning rl.entity_id
)
select f.id as session_id,
       f.old_starts_at,
       f.new_starts_at,
       (select count(*) from relogged r where r.entity_id = f.id) as reminders_reset
  from fixed f
 order by f.new_starts_at;

commit;
