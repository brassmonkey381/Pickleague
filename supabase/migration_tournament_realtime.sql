-- ============================================================
-- PKL-037 (live updates): tournaments, tournament_rounds and
-- tournament_matches join the supabase_realtime publication, so the
-- tournament screen gets postgres_changes instead of its 5 s poll.
--
-- Checked read-only 2026-11-18: supabase_realtime exists in prod with no
-- tables at all. Realtime applies each table's SELECT policies per
-- subscriber, so a closed league's matches still reach only the people
-- who can already read them ("Closed league privacy: ..." policies).
--
-- Idempotent: a table already in the publication is skipped, and nothing
-- happens where the publication does not exist (a bare local Postgres).
-- Apply: supabase db query --linked -f supabase/migration_tournament_realtime.sql
-- ============================================================
do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'supabase_realtime publication not found; nothing to do';
    return;
  end if;
  foreach t in array array['tournaments', 'tournament_rounds', 'tournament_matches'] loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
      raise notice 'added public.% to supabase_realtime', t;
    end if;
  end loop;
end $$;
