-- matches.scheduled_at was originally added by migration_add_scheduling.sql
-- but it's missing in production (likely dropped during a later schema
-- consolidation). ScheduleMatchScreen writes to this column when users
-- schedule a future league match, and the MyWagers Markets tab + the
-- MatchHistory Upcoming section both read it. Re-add idempotently.

alter table public.matches add column if not exists scheduled_at timestamptz;

-- Allow 'pending' alongside 'scheduled' and 'completed' (match-confirm flow
-- inserts as pending; some older code uses 'scheduled' for future games).
do $$ begin
  if exists (select 1 from information_schema.constraint_column_usage
             where table_name='matches' and constraint_name='matches_status_check') then
    alter table public.matches drop constraint matches_status_check;
  end if;
  alter table public.matches
    add constraint matches_status_check
    check (status in ('pending','scheduled','completed'));
end $$;
