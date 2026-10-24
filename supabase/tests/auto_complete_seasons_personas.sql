-- ============================================================
-- Seasons complete themselves (persona tests for
-- migration_auto_complete_seasons.sql).
--
-- NOT runnable on its own: build-auto-complete-seasons-test.mjs puts
-- migration_auto_complete_seasons.sql (twice: it must be re-runnable) at the
-- marker line below. Everything runs inside the begin / rollback below, so the
-- linked (live) database is left untouched:
--   node supabase/tests/build-auto-complete-seasons-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary. INFO rows
-- show what the first run did to REAL seasons (rolled back with the rest) and
-- whether their league's PLUPR reset ran (pg_temp.reset_verdict). Their ok:
-- ended 7 or fewer days before the run -> every finisher's league rating row
-- now holds their new PLUPR and no other row changed (true when the league has
-- no rows for its finishers: nothing to reset); more than 7 days -> no league
-- rating row changed.
--
-- now() is fixed for the whole transaction, so "today" is computed once below.
-- Personas (temporary accounts, example.invalid emails): AD (admin of every
-- test league), M1-M4 (members), NM (not a member), KZ (a creator in
-- Pacific/Kiritimati, UTC+14), PZ (a creator in Pacific/Pago_Pago, UTC-11),
-- BZ (a creator whose stored zone no longer parses: written straight to the
-- table, as if tzdata had retired a once-valid name).
-- Seasons (one league each, 5 members, weekly locks, baseline 4.00; "today"
-- is the default zone's, America/Los_Angeles, unless said):
--   A  ended yesterday, all 3 periods locked        -> the job completes it, reset applied
--   W  ended 7 days ago, all locked                 -> completed, reset applied (the window's last day)
--   E  ended 8 days ago, all locked                 -> completed WITHOUT the reset (first day past it)
--   S  ended 30 days ago, all locked                -> completed WITHOUT the reset: finals and badges
--                                                      saved, league ratings unchanged
--   H  ended 30 days ago, all locked; the admin presses Complete before the job runs
--                                                   -> reset applied (the button always resets)
--   V  ended 3 days ago, all locked, its members have no league rating rows
--                                                   -> completed; nothing to reset, and the INFO
--                                                      check (reset_verdict) still reads ok
--   B  ends in 6 days, 2 of 3 locked                -> untouched
--   C  ended yesterday, P3 (due) not locked         -> waits; completes once P3 locks
--   D  ends TODAY, all locked                       -> the job leaves it; the admin may complete it
--   F  ended 2 days ago, all locked, its finals
--      insert fails (a test trigger)                -> rolled back alone, the others still complete
--   K  creator in Kiritimati, ends today in Pago Pago (already past in Kiritimati) -> completes
--   P  creator in Pago Pago, same dates             -> untouched (ends today there)
--   Z  creator's zone unparseable, ended 2 days ago, all locked
--                                                   -> the default zone is used; completes, the run goes on
--   N  upcoming, nothing locked                     -> complete_season's refusal
--   X  already completed                            -> untouched
-- ============================================================

begin;

-- ════ Harness ════════════════════════════════════════════════════════════
create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);
grant select, insert on _results to authenticated, anon;
grant usage on sequence _results_n_seq to authenticated, anon;

create temp table _p (k text primary key, id uuid not null);
insert into _p values
  ('AD', 'a9a00000-0000-4000-8000-000000000001'), ('M1', 'a9a00000-0000-4000-8000-000000000002'),
  ('M2', 'a9a00000-0000-4000-8000-000000000003'), ('M3', 'a9a00000-0000-4000-8000-000000000004'),
  ('M4', 'a9a00000-0000-4000-8000-000000000005'), ('NM', 'a9a00000-0000-4000-8000-000000000006'),
  ('KZ', 'a9a00000-0000-4000-8000-000000000007'), ('PZ', 'a9a00000-0000-4000-8000-000000000008'),
  ('BZ', 'a9a00000-0000-4000-8000-000000000009');
grant select on _p to authenticated, anon;

-- k, league, season, creator, first day, last day (end_date), periods, status
create temp table _s (
  k text primary key, league_id uuid not null, season_id uuid not null, creator text not null,
  start_date date, end_date date, periods int, status text
);
grant select on _s to authenticated, anon;

-- "today" in the zones the job reads (now() is fixed for the transaction).
create temp table _d (k text primary key, d date not null);
insert into _d values
  ('la',   (now() at time zone public._pickleague_default_tz())::date),
  ('pago', (now() at time zone 'Pacific/Pago_Pago')::date),
  ('kir',  (now() at time zone 'Pacific/Kiritimati')::date);

create function pg_temp.p(text) returns uuid language sql stable as $$ select id from _p where k = $1 $$;
create function pg_temp.s(text) returns uuid language sql stable as $$ select season_id from _s where k = $1 $$;
create function pg_temp.l(text) returns uuid language sql stable as $$ select league_id from _s where k = $1 $$;
create function pg_temp.d(text) returns date language sql stable as $$ select d from _d where k = $1 $$;

create function pg_temp.ok(p_test text, p_ok boolean, p_detail text default null) returns void
language sql as $$ insert into _results (test, ok, detail) values (p_test, coalesce(p_ok, false), p_detail) $$;

create function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create function pg_temp.as_signed_out() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role": "authenticated"}', true);
  perform set_config('role', 'authenticated', true);
end $$;

create function pg_temp.as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role": "anon"}', true);
  perform set_config('role', 'anon', true);
end $$;

create function pg_temp.as_admin() returns void language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

-- Runs p_sql; null if it went through, else the error's message.
create function pg_temp.err(p_sql text) returns text language plpgsql as $$
declare v_msg text;
begin
  execute p_sql;
  return null;
exception when others then
  get stacked diagnostics v_msg = message_text;
  return coalesce(v_msg, '(no message)');
end $$;

-- complete_season as one persona (null persona = signed out); the error, or null.
create function pg_temp.complete_as(p_who text, p_season uuid) returns text language plpgsql as $$
declare v text;
begin
  if p_who is null then perform pg_temp.as_signed_out(); else perform pg_temp.as_user(pg_temp.p(p_who)); end if;
  v := pg_temp.err(format('select public.complete_season(%L::uuid)', p_season));
  perform pg_temp.as_admin();
  return v;
end $$;

-- Locks period p_n of season p_k: five snapshot rows with a fixed rank pattern
-- (median ranks AD 1, M1 2, M2 3, M3 4, M4 5 over 3 periods; AD is first
-- every time, so AD also sweeps).
create function pg_temp.lock(p_k text, p_n int) returns void language sql as $$
  insert into public.season_snapshots (
    season_id, league_id, period_number, snapshot_date, user_id, elo_at_snapshot,
    rank_at_snapshot, wins_in_season, losses_in_season)
  select s.season_id, s.league_id, p_n, s.start_date + p_n * 7, pg_temp.p(r.k), 4.00,
         (array[r.r1, r.r2, r.r3])[p_n], 0, 0
    from _s s,
         (values ('AD', 1, 1, 1), ('M1', 2, 2, 3), ('M2', 3, 3, 2), ('M3', 4, 5, 4), ('M4', 5, 4, 5)) r(k, r1, r2, r3)
   where s.k = p_k
$$;

-- A season's status and whether its reset ran, e.g. 'active/f'.
create function pg_temp.state(p_k text) returns text language sql stable as $$
  select status || '/' || case when elo_reset_applied then 't' else 'f' end
    from public.league_seasons where id = pg_temp.s(p_k)
$$;
create function pg_temp.finals(p_k text) returns int language sql stable as $$
  select count(*)::int from public.season_final_standings where season_id = pg_temp.s(p_k)
$$;
-- A season's final standings, e.g. 'AD #1 m1 4.200 (+0.200), M1 #2 ...'.
create function pg_temp.finals_text(p_k text) returns text language sql stable as $$
  select string_agg(k.k || ' #' || f.final_rank || ' m' || f.median_rank || ' ' || f.new_elo || ' (+' || f.elo_bonus || ')',
                    ', ' order by f.final_rank)
    from public.season_final_standings f join _p k on k.id = f.user_id
   where f.season_id = pg_temp.s(p_k)
$$;
-- The badges a season awarded in its league, e.g. 'AD Period Sweeper, ...'.
create function pg_temp.badges_text(p_k text) returns text language sql stable as $$
  select string_agg(k.k || ' ' || b.name, ', ' order by b.name, k.k)
    from public.player_badges pb join public.badges b on b.id = pb.badge_id join _p k on k.id = pb.user_id
   where pb.league_id = pg_temp.l(p_k) and pb.context = 'Autoseason ' || p_k
$$;
-- The league ratings of a season's five members (AD, M1-M4), every facet:
-- 'reset' (each = their new PLUPR in the final standings), 'kept' (each still
-- the seeded 3.33), else what they are.
create function pg_temp.ratings(p_k text) returns text language sql stable as $$
  select case
    when count(*) = 5 and bool_and(f.new_elo is not null and r.rating = f.new_elo and r.singles_rating = f.new_elo
                                   and r.doubles_rating = f.new_elo and r.mixed_doubles_rating = f.new_elo) then 'reset'
    when count(*) = 5 and bool_and(r.rating = 3.33 and r.singles_rating = 3.33 and r.doubles_rating = 3.33
                                   and r.mixed_doubles_rating = 3.33) then 'kept'
    else count(*) || ' rows: ' || coalesce(string_agg(r.rating || '/' || r.singles_rating || '/' || r.doubles_rating
                                                       || '/' || r.mixed_doubles_rating, ' ' order by r.user_id), '') end
    from public.league_player_ratings r
    left join public.season_final_standings f on f.season_id = pg_temp.s(p_k) and f.user_id = r.user_id
   where r.league_id = pg_temp.l(p_k)
     and r.user_id in (select id from _p where k in ('AD', 'M1', 'M2', 'M3', 'M4'))
$$;
-- "Today" for a league's creator, as the job reads it (an unparseable stored
-- zone: the default).
create function pg_temp.today_for(p_creator uuid) returns date language plpgsql stable as $$
begin
  return (now() at time zone public._pickleague_tz_for(p_creator))::date;
exception when others then
  return (now() at time zone public._pickleague_default_tz())::date;
end $$;


-- ════ Setup (before the migration) ══════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data)
select id, 'autoseason-' || lower(k) || '@example.invalid', jsonb_build_object('full_name', 'Autoseason ' || k)
  from _p;
insert into public.pickleague_time_zones (profile_id, tz) values
  (pg_temp.p('KZ'), 'Pacific/Kiritimati'), (pg_temp.p('PZ'), 'Pacific/Pago_Pago'),
  (pg_temp.p('BZ'), 'Mars/Olympus_Mons')
on conflict (profile_id) do update set tz = excluded.tz;

insert into _s (k, league_id, season_id, creator, start_date, end_date, periods, status) values
  ('A', 'a9a10000-0000-4000-8000-000000000001', 'a9a20000-0000-4000-8000-000000000001', 'AD',
        pg_temp.d('la') - 22, pg_temp.d('la') - 1, 3, 'active'),
  ('B', 'a9a10000-0000-4000-8000-000000000002', 'a9a20000-0000-4000-8000-000000000002', 'AD',
        pg_temp.d('la') - 15, pg_temp.d('la') + 6, 3, 'active'),
  ('C', 'a9a10000-0000-4000-8000-000000000003', 'a9a20000-0000-4000-8000-000000000003', 'AD',
        pg_temp.d('la') - 22, pg_temp.d('la') - 1, 3, 'active'),
  ('D', 'a9a10000-0000-4000-8000-000000000004', 'a9a20000-0000-4000-8000-000000000004', 'AD',
        pg_temp.d('la') - 21, pg_temp.d('la'), 3, 'active'),
  ('F', 'a9a10000-0000-4000-8000-000000000005', 'a9a20000-0000-4000-8000-000000000005', 'AD',
        pg_temp.d('la') - 23, pg_temp.d('la') - 2, 3, 'active'),
  ('K', 'a9a10000-0000-4000-8000-000000000006', 'a9a20000-0000-4000-8000-000000000006', 'KZ',
        pg_temp.d('pago') - 14, pg_temp.d('pago'), 2, 'active'),
  ('P', 'a9a10000-0000-4000-8000-000000000007', 'a9a20000-0000-4000-8000-000000000007', 'PZ',
        pg_temp.d('pago') - 14, pg_temp.d('pago'), 2, 'active'),
  ('N', 'a9a10000-0000-4000-8000-000000000008', 'a9a20000-0000-4000-8000-000000000008', 'AD',
        pg_temp.d('la') + 7, pg_temp.d('la') + 28, 3, 'upcoming'),
  ('X', 'a9a10000-0000-4000-8000-000000000009', 'a9a20000-0000-4000-8000-000000000009', 'AD',
        pg_temp.d('la') - 60, pg_temp.d('la') - 39, 3, 'completed'),
  ('Z', 'a9a10000-0000-4000-8000-00000000000a', 'a9a20000-0000-4000-8000-00000000000a', 'BZ',
        pg_temp.d('la') - 23, pg_temp.d('la') - 2, 3, 'active'),
  ('W', 'a9a10000-0000-4000-8000-00000000000b', 'a9a20000-0000-4000-8000-00000000000b', 'AD',
        pg_temp.d('la') - 28, pg_temp.d('la') - 7, 3, 'active'),
  ('E', 'a9a10000-0000-4000-8000-00000000000c', 'a9a20000-0000-4000-8000-00000000000c', 'AD',
        pg_temp.d('la') - 29, pg_temp.d('la') - 8, 3, 'active'),
  ('S', 'a9a10000-0000-4000-8000-00000000000d', 'a9a20000-0000-4000-8000-00000000000d', 'AD',
        pg_temp.d('la') - 51, pg_temp.d('la') - 30, 3, 'active'),
  ('H', 'a9a10000-0000-4000-8000-00000000000e', 'a9a20000-0000-4000-8000-00000000000e', 'AD',
        pg_temp.d('la') - 51, pg_temp.d('la') - 30, 3, 'active'),
  ('V', 'a9a10000-0000-4000-8000-00000000000f', 'a9a20000-0000-4000-8000-00000000000f', 'AD',
        pg_temp.d('la') - 24, pg_temp.d('la') - 3, 3, 'active');

insert into public.leagues (id, name, created_by, is_open)
select league_id, '[TEST] autoseason ' || k, pg_temp.p(creator), true from _s;
insert into public.league_members (league_id, user_id, role)
select s.league_id, pg_temp.p(m.k), case when m.k = 'AD' then 'admin' else 'member' end
  from _s s, (values ('AD'), ('M1'), ('M2'), ('M3'), ('M4')) m(k)
on conflict (league_id, user_id) do update set role = excluded.role;
-- League ratings the reset must overwrite (the member trigger seeds the rows).
insert into public.league_player_ratings (league_id, user_id, rating, singles_rating, doubles_rating, mixed_doubles_rating)
select s.league_id, pg_temp.p(m.k), 3.33, 3.33, 3.33, 3.33
  from _s s, (values ('AD'), ('M1'), ('M2'), ('M3'), ('M4')) m(k)
on conflict (league_id, user_id) do update
  set rating = 3.33, singles_rating = 3.33, doubles_rating = 3.33, mixed_doubles_rating = 3.33;
-- V: its finishers have no league rating rows (the reset has nothing to write).
delete from public.league_player_ratings where league_id = 'a9a10000-0000-4000-8000-00000000000f';

-- total_periods is generated (total_weeks / lock_frequency_weeks).
insert into public.league_seasons (
  id, league_id, name, start_date, end_date, total_weeks, lock_frequency_weeks,
  status, elo_reset_applied, baseline_plupr, created_by)
select season_id, league_id, 'Autoseason ' || k, start_date, end_date, periods, 1,
       status, status = 'completed', 4.00, pg_temp.p(creator)
  from _s;

select pg_temp.lock('A', 1), pg_temp.lock('A', 2), pg_temp.lock('A', 3),
       pg_temp.lock('B', 1), pg_temp.lock('B', 2),
       pg_temp.lock('C', 1), pg_temp.lock('C', 2),
       pg_temp.lock('D', 1), pg_temp.lock('D', 2), pg_temp.lock('D', 3),
       pg_temp.lock('F', 1), pg_temp.lock('F', 2), pg_temp.lock('F', 3),
       pg_temp.lock('K', 1), pg_temp.lock('K', 2),
       pg_temp.lock('P', 1), pg_temp.lock('P', 2),
       pg_temp.lock('X', 1), pg_temp.lock('X', 2), pg_temp.lock('X', 3),
       pg_temp.lock('Z', 1), pg_temp.lock('Z', 2), pg_temp.lock('Z', 3),
       pg_temp.lock('W', 1), pg_temp.lock('W', 2), pg_temp.lock('W', 3),
       pg_temp.lock('E', 1), pg_temp.lock('E', 2), pg_temp.lock('E', 3),
       pg_temp.lock('S', 1), pg_temp.lock('S', 2), pg_temp.lock('S', 3),
       pg_temp.lock('H', 1), pg_temp.lock('H', 2), pg_temp.lock('H', 3),
       pg_temp.lock('V', 1), pg_temp.lock('V', 2), pg_temp.lock('V', 3);

-- A stale one-arg helper, as an earlier draft of the migration would have
-- left it (never on live): the migration must drop it, or a one-arg call is
-- ambiguous. Called by mistake, it says so.
create function public._complete_season_unchecked(p_season_id uuid) returns void
language plpgsql as $$ begin raise exception 'test: the stale one-arg helper was called'; end $$;

-- complete_season's grants before the migration (it must keep them).
create temp table _acl_before as
select (select proacl::text from pg_proc where oid = 'public.complete_season(uuid)'::regprocedure) as acl,
       has_function_privilege('authenticated', 'public.complete_season(uuid)', 'execute') as auth_x,
       has_function_privilege('anon', 'public.complete_season(uuid)', 'execute') as anon_x;

-- @@MIGRATION@@


-- ════ G1 grants, attributes, the job ═════════════════════════════════════
do $$
declare
  f_in  text := 'public._complete_season_unchecked(uuid, boolean)';
  f_job text := 'public.auto_complete_due_seasons()';
  b     record;
begin
  perform pg_temp.as_admin();
  select * into b from _acl_before;
  perform pg_temp.ok('G1 complete_season keeps its grants (same ACL; signed-in players may call it)',
    (select proacl::text from pg_proc where oid = 'public.complete_season(uuid)'::regprocedure) is not distinct from b.acl
    and has_function_privilege('authenticated', 'public.complete_season(uuid)', 'execute') = b.auth_x
    and has_function_privilege('anon', 'public.complete_season(uuid)', 'execute') = b.anon_x
    and b.auth_x, b.acl);
  perform pg_temp.ok('G1 complete_season now checks the admin, then calls the helper',
    (select prosrc like '%Only admins and co-admins can complete a season%'
            and prosrc like '%not coalesce(public.is_godmode_user(), false)%'
            and prosrc like '%public._complete_season_unchecked(p_season_id)%'
       from pg_proc where oid = 'public.complete_season(uuid)'::regprocedure));
  perform pg_temp.ok('G1 the helper and the job: no EXECUTE for anon, authenticated or PUBLIC; service_role keeps it',
    not has_function_privilege('authenticated', f_in, 'execute') and not has_function_privilege('anon', f_in, 'execute')
    and not has_function_privilege('authenticated', f_job, 'execute') and not has_function_privilege('anon', f_job, 'execute')
    and has_function_privilege('service_role', f_in, 'execute') and has_function_privilege('service_role', f_job, 'execute')
    and not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                     where p.oid in (f_in::regprocedure, f_job::regprocedure) and a.grantee = 0));
  perform pg_temp.ok('G1 both are security definer with search_path ''''',
    (select bool_and(prosecdef and proconfig = array['search_path=""'])
       from pg_proc where oid in (f_in::regprocedure, f_job::regprocedure)));
  perform pg_temp.ok('G1 one definition each (no overloads), after the file ran twice',
    (select count(*) = 3 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('complete_season', '_complete_season_unchecked', 'auto_complete_due_seasons')));
  perform pg_temp.ok('G1 the helper takes (p_season_id uuid, p_apply_reset boolean DEFAULT true); the stale one-arg one is gone',
    pg_get_function_arguments(f_in::regprocedure) = 'p_season_id uuid, p_apply_reset boolean DEFAULT true'
    and to_regprocedure('public._complete_season_unchecked(uuid)') is null,
    pg_get_function_arguments(f_in::regprocedure));
  perform pg_temp.ok('G1 one cron job, hourly at :08, after the :05 auto-lock (which is still there)',
    (select count(*) = 1 from cron.job where jobname = 'pickleague-auto-complete-seasons')
    and exists (select 1 from cron.job where jobname = 'pickleague-auto-complete-seasons' and schedule = '8 * * * *'
                  and command ilike '%select public.auto_complete_due_seasons()%' and active)
    and exists (select 1 from cron.job where jobname = 'pickleague-auto-lock-periods' and active),
    (select string_agg(jobname || ' ' || schedule, '; ') from cron.job where jobname like 'pickleague-auto-%'));
end $$;


-- ════ G2 clients cannot run the internals ════════════════════════════════
do $$
declare e text;
begin
  perform pg_temp.as_user(pg_temp.p('AD'));
  e := pg_temp.err(format('select public._complete_season_unchecked(%L::uuid)', pg_temp.s('A')));
  perform pg_temp.ok('G2 an admin (signed in) cannot call _complete_season_unchecked', e ilike 'permission denied%', e);
  e := pg_temp.err('select public.auto_complete_due_seasons()');
  perform pg_temp.ok('G2 a signed-in player cannot call auto_complete_due_seasons', e ilike 'permission denied%', e);
  perform pg_temp.as_anon();
  e := pg_temp.err(format('select public._complete_season_unchecked(%L::uuid)', pg_temp.s('A')));
  perform pg_temp.ok('G2 anon cannot call _complete_season_unchecked', e ilike 'permission denied%', e);
  e := pg_temp.err('select public.auto_complete_due_seasons()');
  perform pg_temp.ok('G2 anon cannot call auto_complete_due_seasons', e ilike 'permission denied%', e);
  perform pg_temp.as_admin();
  perform pg_temp.ok('G2 nothing was completed by those calls', pg_temp.state('A') = 'active/f' and pg_temp.finals('A') = 0);
end $$;


-- ════ G3 complete_season's refusals are unchanged ════════════════════════
do $$
declare e text;
begin
  e := pg_temp.complete_as('AD', gen_random_uuid());
  perform pg_temp.ok('G3 unknown season: Season not found', e = 'Season not found', e);
  e := pg_temp.complete_as('NM', pg_temp.s('D'));
  perform pg_temp.ok('G3 not a member: admins and co-admins only', e = 'Only admins and co-admins can complete a season', e);
  e := pg_temp.complete_as('M1', pg_temp.s('D'));
  perform pg_temp.ok('G3 a member: admins and co-admins only', e = 'Only admins and co-admins can complete a season', e);
  -- Before this migration both of these went through: is_godmode_user() is
  -- NULL without a user, which made the old refusal condition NULL.
  e := pg_temp.complete_as(null, pg_temp.s('D'));
  perform pg_temp.ok('G3 signed out: admins and co-admins only (was let through)',
    e = 'Only admins and co-admins can complete a season', e);
  -- The anon key: refused by the check above, or (once
  -- migration_godmode_anon_revoke.sql is applied, as on live since
  -- 2026-10-24) before the call by the grant.
  perform pg_temp.as_anon();
  e := pg_temp.err(format('select public.complete_season(%L::uuid)', pg_temp.s('D')));
  perform pg_temp.as_admin();
  perform pg_temp.ok('G3 the anon key: refused, by the admin check or by the grant (was let through)',
    e in ('Only admins and co-admins can complete a season', 'permission denied for function complete_season'), e);
  e := pg_temp.complete_as('AD', pg_temp.s('N'));
  perform pg_temp.ok('G3 nothing locked yet: lock a period first',
    e = 'Lock in at least one period before completing the season', e);
  e := pg_temp.complete_as('AD', pg_temp.s('X'));
  perform pg_temp.ok('G3 already completed: the reset has been applied',
    e = 'ELO reset has already been applied for this season', e);
  perform pg_temp.ok('G3 the refused seasons are untouched',
    pg_temp.state('D') = 'active/f' and pg_temp.finals('D') = 0 and pg_temp.state('N') = 'upcoming/f' and pg_temp.finals('N') = 0);
end $$;


-- ════ H1 the admin's button resets, however late ═════════════════════════
-- H ended 30 days ago with every period locked, so the job would complete it
-- without the reset (like S). The admin presses Complete first: the button
-- calls the helper with its default and resets, as it always has.
do $$
declare e text;
begin
  e := pg_temp.complete_as('AD', pg_temp.s('H'));
  perform pg_temp.ok('H1 the admin completes H (ended 30 days ago) by hand: completed, finals saved, league ratings reset',
    e is null and pg_temp.state('H') = 'completed/t' and pg_temp.finals('H') = 5 and pg_temp.ratings('H') = 'reset',
    coalesce(e, pg_temp.state('H') || ' ' || pg_temp.finals('H') || ' ' || pg_temp.ratings('H')));
end $$;


-- ════ J1 the first run ══════════════════════════════════════════════════
-- Before: every season's status, the test players' pickles, badges and
-- notifications. F's finals insert is made to fail (a test trigger, rolled
-- back with everything else).
create temp table _before as select id, status from public.league_seasons;
create temp table _pk as select id, coalesce(pickles, 0) as pickles from public.profiles where id in (select id from _p);
create temp table _bdg as select id from public.player_badges where user_id in (select id from _p);
create temp table _ntf as select id from public.notifications where user_id in (select id from _p);
create temp table _run (n int primary key, completed int not null);
-- Every league with an active season (real and test): its league ratings
-- before the run, to tell whether the run reset them (reset_verdict, the INFO
-- rows).
create temp table _lpr as
select r.league_id, r.user_id, r.rating, r.singles_rating, r.doubles_rating, r.mixed_doubles_rating, r.updated_at
  from public.league_player_ratings r
 where r.league_id in (select league_id from public.league_seasons where status = 'active');

-- After a run: did it apply season p_season's league PLUPR reset, and is that
-- what the 7-day rule asks (in the league's day, as the job reads it)?
--   ended 7 or fewer days before: every finisher row in _lpr now holds the
--     finisher's new PLUPR on all four facets (changed by the run), and no
--     other row of the league changed. A league with no rows for its
--     finishers has nothing to reset: ok.
--   more than 7 days: no row of the league changed.
create function pg_temp.reset_verdict(p_season uuid)
returns table (outcome text, ok boolean, detail text) language sql stable as $$
  with s as (
    select s.id, s.league_id, s.end_date, pg_temp.today_for(l.created_by) - s.end_date as days_late
      from public.league_seasons s
      left join public.leagues l on l.id = s.league_id
     where s.id = p_season
  ), r as (
    select (cur.rating, cur.singles_rating, cur.doubles_rating, cur.mixed_doubles_rating, cur.updated_at)
             is distinct from (o.rating, o.singles_rating, o.doubles_rating, o.mixed_doubles_rating, o.updated_at) as changed,
           f.user_id is not null as finisher,
           coalesce(cur.rating = f.new_elo and cur.singles_rating = f.new_elo
                    and cur.doubles_rating = f.new_elo and cur.mixed_doubles_rating = f.new_elo, false) as at_new_elo
      from s
      join _lpr o on o.league_id = s.league_id
      left join public.league_player_ratings cur on cur.league_id = o.league_id and cur.user_id = o.user_id
      left join public.season_final_standings f on f.season_id = s.id and f.user_id = o.user_id
  ), c as (
    select count(*) as total,
           count(*) filter (where changed) as changed,
           count(*) filter (where finisher) as fin_rows,
           count(*) filter (where finisher and changed and at_new_elo) as fin_reset
      from r
  )
  select case when c.changed > 0 then 'PLUPR reset applied'
              when c.fin_rows = 0 then 'no league ratings to reset'
              else 'PLUPR reset NOT applied' end,
         case when s.days_late <= 7 then c.fin_reset = c.fin_rows and c.changed = c.fin_reset
              else c.changed = 0 end,
         format('ended %s, %s day(s) before the run; league ratings changed: %s of %s; finishers'' rows at their new PLUPR: %s of %s',
                s.end_date, s.days_late, c.changed, c.total, c.fin_reset, c.fin_rows)
    from s cross join c
$$;

create function pg_temp.refuse_f() returns trigger language plpgsql as $$
begin
  if new.season_id = 'a9a20000-0000-4000-8000-000000000005' then
    raise exception 'test: season F refuses its final standings';
  end if;
  return new;
end $$;
create trigger _test_autoseason_refuse_f before insert on public.season_final_standings
  for each row execute function pg_temp.refuse_f();

do $$
begin
  perform pg_temp.as_admin();
  insert into _run values (1, public.auto_complete_due_seasons());
end $$;

do $$
declare
  v_run     int := (select completed from _run where n = 1);
  v_flipped int;
  v_rows    text;
begin
  select count(*) into v_flipped
    from _before b join public.league_seasons s on s.id = b.id
   where b.status = 'active' and s.status = 'completed';
  perform pg_temp.ok('J1 the job returns how many seasons it completed (A, E, K, S, V, W, Z at least)', v_run = v_flipped and v_run >= 7,
    format('returned %s, seasons flipped to completed %s', v_run, v_flipped));

  perform pg_temp.ok('J1 A (ended yesterday, all locked): completed',
    pg_temp.state('A') = 'completed/t', pg_temp.state('A'));
  v_rows := pg_temp.finals_text('A');
  perform pg_temp.ok('J1 A final standings by median rank, new PLUPR = baseline 4.00 + 0.20 / 0.15 / 0.10 / 0.05 / 0.02',
    v_rows = 'AD #1 m1 4.200 (+0.200), M1 #2 m2 4.150 (+0.150), M2 #3 m3 4.100 (+0.100), M3 #4 m4 4.050 (+0.050), M4 #5 m5 4.020 (+0.020)',
    v_rows);
  perform pg_temp.ok('J1 A league ratings reset to the new PLUPR, every facet (completed 1 day after its end: within 7)',
    pg_temp.ratings('A') = 'reset', pg_temp.ratings('A'));
  v_rows := pg_temp.badges_text('A');
  perform pg_temp.ok('J1 A badges: Period Sweeper (AD), Season Bronze (M2), Season Crown (AD), Season Silver (M1)',
    v_rows = 'AD Period Sweeper, M2 Season Bronze, AD Season Crown, M1 Season Silver', v_rows);

  -- S ended 30 days ago: completed with no reset. Everything else as for A.
  perform pg_temp.ok('J1 S (ended 30 days ago, all locked): completed by the job',
    pg_temp.state('S') = 'completed/t', pg_temp.state('S'));
  v_rows := pg_temp.finals_text('S');
  perform pg_temp.ok('J1 S final standings saved as A''s (rank, median, bonus, and the new PLUPR the app shows)',
    v_rows = pg_temp.finals_text('A'), v_rows);
  v_rows := pg_temp.badges_text('S');
  perform pg_temp.ok('J1 S badges awarded as A''s (Period Sweeper, Season Bronze / Crown / Silver)',
    v_rows = 'AD Period Sweeper, M2 Season Bronze, AD Season Crown, M1 Season Silver', v_rows);
  perform pg_temp.ok('J1 S league ratings UNCHANGED, every facet (completed more than 7 days late: no reset)',
    pg_temp.ratings('S') = 'kept', pg_temp.ratings('S'));
  perform pg_temp.ok('J1 W (ended 7 days ago, the last day of the window): completed, finals saved, reset applied',
    pg_temp.state('W') = 'completed/t' and pg_temp.finals('W') = 5 and pg_temp.ratings('W') = 'reset',
    pg_temp.state('W') || ' ' || pg_temp.finals('W') || ' ' || pg_temp.ratings('W'));
  perform pg_temp.ok('J1 E (ended 8 days ago, the first day past it): completed, finals saved, NO reset',
    pg_temp.state('E') = 'completed/t' and pg_temp.finals('E') = 5 and pg_temp.ratings('E') = 'kept',
    pg_temp.state('E') || ' ' || pg_temp.finals('E') || ' ' || pg_temp.ratings('E'));
  perform pg_temp.ok('J1 V (ended 3 days ago, no league rating rows): completed, finals saved, still no rows',
    pg_temp.state('V') = 'completed/t' and pg_temp.finals('V') = 5
    and not exists (select 1 from public.league_player_ratings where league_id = pg_temp.l('V')),
    pg_temp.state('V') || ' ' || pg_temp.finals('V') || ' ' || pg_temp.ratings('V'));

  perform pg_temp.ok('J1 K (creator in Kiritimati, ended there 1 or 2 days ago): completed, reset applied',
    pg_temp.state('K') = 'completed/t' and pg_temp.finals('K') = 5 and pg_temp.ratings('K') = 'reset',
    pg_temp.state('K') || ' ' || pg_temp.finals('K') || ' ' || pg_temp.ratings('K'));
  perform pg_temp.ok('J1 Z setup: its creator''s stored zone really does not parse',
    pg_temp.err('select now() at time zone ''Mars/Olympus_Mons''') is not null
    and (select tz from public.pickleague_time_zones where profile_id = pg_temp.p('BZ')) = 'Mars/Olympus_Mons');
  perform pg_temp.ok('J1 Z (creator''s zone unparseable, ended 2 days ago): the default zone is used, completed, reset applied',
    pg_temp.state('Z') = 'completed/t' and pg_temp.finals('Z') = 5 and pg_temp.ratings('Z') = 'reset',
    pg_temp.state('Z') || ' ' || pg_temp.finals('Z') || ' ' || pg_temp.ratings('Z'));
  perform pg_temp.ok('J1 P (creator in Pago Pago, ends there today): untouched',
    pg_temp.state('P') = 'active/f' and pg_temp.finals('P') = 0, pg_temp.state('P'));
  perform pg_temp.ok('J1 B (ends in 6 days): untouched',
    pg_temp.state('B') = 'active/f' and pg_temp.finals('B') = 0, pg_temp.state('B'));
  perform pg_temp.ok('J1 C (ended, but its due P3 is not locked): waits for the auto-lock',
    pg_temp.state('C') = 'active/f' and pg_temp.finals('C') = 0, pg_temp.state('C'));
  perform pg_temp.ok('J1 D (ends today): left for tomorrow',
    pg_temp.state('D') = 'active/f' and pg_temp.finals('D') = 0, pg_temp.state('D'));
  perform pg_temp.ok('J1 F (its completion fails): rolled back alone, no partial finals or reset',
    pg_temp.state('F') = 'active/f' and pg_temp.finals('F') = 0
    and (select bool_and(rating = 3.33) from public.league_player_ratings where league_id = pg_temp.l('F')),
    pg_temp.state('F'));
  perform pg_temp.ok('J1 N (upcoming) and X (completed) untouched; X gets no finals; H (the admin completed it) not redone',
    pg_temp.state('N') = 'upcoming/f' and pg_temp.state('X') = 'completed/t' and pg_temp.finals('X') = 0
    and pg_temp.state('H') = 'completed/t' and pg_temp.finals('H') = 5 and pg_temp.ratings('H') = 'reset');
  perform pg_temp.ok('J1 the untouched leagues keep their ratings (B, C, D, P)',
    (select bool_and(rating = 3.33 and singles_rating = 3.33) from public.league_player_ratings
      where league_id in (pg_temp.l('B'), pg_temp.l('C'), pg_temp.l('D'), pg_temp.l('P'))));

  -- The badge triggers still fire: +150 pickles per new badge, and its notification + push.
  perform pg_temp.ok('J1 +150 pickles for every badge the run awarded (AD: crown + sweeper in A, E, K, S, V, W and Z)',
    (select bool_and(coalesce(p.pickles, 0) - b.pickles
                     = 150 * (select count(*) from public.player_badges pb
                               where pb.user_id = p.id and pb.id not in (select id from _bdg)))
       from public.profiles p join _pk b on b.id = p.id)
    and (select coalesce(p.pickles, 0) - b.pickles from public.profiles p join _pk b on b.id = p.id
          where p.id = pg_temp.p('AD')) = 2100,
    (select string_agg(k.k || ' +' || (coalesce(p.pickles, 0) - b.pickles), ', ' order by k.k)
       from public.profiles p join _pk b on b.id = p.id join _p k on k.id = p.id));
  perform pg_temp.ok('J1 the badge notification ("+150 pickles for earning Season Crown!") and its push are queued',
    exists (select 1 from public.notifications n
             where n.user_id = pg_temp.p('AD') and n.id not in (select id from _ntf)
               and n.title = '🥒 +150 pickles for earning Season Crown!'
               and exists (select 1 from public.push_outbox o where o.notification_id = n.id)));
end $$;

-- ════ J1v the INFO check (reset_verdict) on the test seasons ═════════════
-- The rule the INFO rows hold real seasons to, run on seasons whose outcome is
-- known: ok for the right outcome (V: no rows to reset, which once read as a
-- failure), and not ok for a wrong one (tried in a subtransaction, undone).
do $$
declare
  v      text;
  v_late boolean;
  v_part boolean;
begin
  v := (select string_agg(k || ' ' || r.outcome || ' ' || r.ok, ', ' order by k)
          from _s, pg_temp.reset_verdict(_s.season_id) r where k in ('A', 'E', 'S', 'V', 'W'));
  perform pg_temp.ok('J1v reset_verdict reads the run right: A, W applied; E, S not applied; V nothing to reset (all ok)',
    v = 'A PLUPR reset applied true, E PLUPR reset NOT applied true, S PLUPR reset NOT applied true, '
        || 'V no league ratings to reset true, W PLUPR reset applied true', v);
  -- S reset anyway (30 days late), then A only partly reset (one row put back).
  begin
    update public.league_player_ratings r
       set rating = f.new_elo, singles_rating = f.new_elo, doubles_rating = f.new_elo,
           mixed_doubles_rating = f.new_elo, updated_at = now()
      from public.season_final_standings f
     where f.season_id = pg_temp.s('S') and r.league_id = pg_temp.l('S') and r.user_id = f.user_id;
    v_late := (select ok from pg_temp.reset_verdict(pg_temp.s('S')));
    update public.league_player_ratings
       set rating = 3.33, singles_rating = 3.33, doubles_rating = 3.33, mixed_doubles_rating = 3.33
     where league_id = pg_temp.l('A') and user_id = pg_temp.p('M4');
    v_part := (select ok from pg_temp.reset_verdict(pg_temp.s('A')));
    raise exception 'undo';
  exception when others then
    null;
  end;
  perform pg_temp.ok('J1v reset_verdict catches a wrong run: a reset 30 days late, a reset that missed a finisher (not ok)',
    v_late = false and v_part = false and pg_temp.ratings('S') = 'kept' and pg_temp.ratings('A') = 'reset',
    format('late %s, partial %s; after the undo S %s, A %s', v_late, v_part, pg_temp.ratings('S'), pg_temp.ratings('A')));
end $$;

-- What the first run did to real seasons (it is rolled back with the rest),
-- and whether it reset their league's ratings; ok as reset_verdict says
-- (The League, Season 1, ended 2026-08-19: NOT applied).
insert into _results (test, ok, detail)
select 'INFO the run also completed (live, rolled back): ' || coalesce(l.name, '?') || ' / ' || s.name || ' - ' || v.outcome,
       v.ok,
       format('%s; final: %s', v.detail,
              (select string_agg('#' || f.final_rank || ' ' || coalesce(pr.full_name, '?') || ' ' || f.new_elo,
                                 ', ' order by f.final_rank)
                 from public.season_final_standings f left join public.profiles pr on pr.id = f.user_id
                where f.season_id = s.id))
  from _before b
  join public.league_seasons s on s.id = b.id
  left join public.leagues l on l.id = s.league_id
  cross join lateral pg_temp.reset_verdict(s.id) v
 where b.status = 'active' and s.status = 'completed' and s.id not in (select season_id from _s);


-- ════ J2 a second run is a no-op ════════════════════════════════════════
create temp table _bdg2 as select id from public.player_badges where user_id in (select id from _p);
create temp table _pk2 as select id, coalesce(pickles, 0) as pickles from public.profiles where id in (select id from _p);
do $$
begin
  perform pg_temp.as_admin();
  insert into _run values (2, public.auto_complete_due_seasons());
end $$;
do $$
begin
  perform pg_temp.ok('J2 run again: nothing to do (0), no new badges or pickles, A''s finals as they were',
    (select completed from _run where n = 2) = 0
    and not exists (select 1 from public.player_badges where user_id in (select id from _p) and id not in (select id from _bdg2))
    and (select bool_and(coalesce(p.pickles, 0) = b.pickles) from public.profiles p join _pk2 b on b.id = p.id)
    and pg_temp.finals('A') = 5,
    'returned ' || (select completed from _run where n = 2));
end $$;


-- ════ J3 C completes once its due period locks ═══════════════════════════
select pg_temp.lock('C', 3);
do $$
begin
  perform pg_temp.as_admin();
  insert into _run values (3, public.auto_complete_due_seasons());
end $$;
do $$
begin
  perform pg_temp.ok('J3 with P3 locked, the next run completes C (and only C)',
    (select completed from _run where n = 3) = 1 and pg_temp.state('C') = 'completed/t' and pg_temp.finals('C') = 5,
    'returned ' || (select completed from _run where n = 3) || ', C ' || pg_temp.state('C'));
end $$;


-- ════ J4 F is retried: it completes once it can ══════════════════════════
drop trigger _test_autoseason_refuse_f on public.season_final_standings;
do $$
begin
  perform pg_temp.as_admin();
  insert into _run values (4, public.auto_complete_due_seasons());
end $$;
do $$
begin
  perform pg_temp.ok('J4 the failed season is retried by the next run and completes',
    (select completed from _run where n = 4) = 1 and pg_temp.state('F') = 'completed/t' and pg_temp.finals('F') = 5,
    'returned ' || (select completed from _run where n = 4) || ', F ' || pg_temp.state('F'));
end $$;


-- ════ M1 the admin's button still works (before the end date, too) ══════
do $$
declare e text;
begin
  e := pg_temp.complete_as('AD', pg_temp.s('D'));
  perform pg_temp.ok('M1 the admin completes D (ends today) by hand',
    e is null and pg_temp.state('D') = 'completed/t' and pg_temp.finals('D') = 5, coalesce(e, pg_temp.state('D')));
  e := pg_temp.complete_as('AD', pg_temp.s('D'));
  perform pg_temp.ok('M1 pressing it again: the reset has already been applied',
    e = 'ELO reset has already been applied for this season', e);
  perform pg_temp.as_admin();
  insert into _run values (5, public.auto_complete_due_seasons());
  perform pg_temp.ok('M1 the job never completes a season twice (0 after the admin did D)',
    (select completed from _run where n = 5) = 0 and pg_temp.finals('D') = 5,
    'returned ' || (select completed from _run where n = 5));
end $$;


-- ════ R whose league ratings were reset, in the end ══════════════════════
-- The job resets within 7 days of the end date (A, K, Z in the first run, C
-- and F in later ones, W on the 7th day); the admin's button always does (D,
-- H). More than 7 days late the job does not (E, S). The rest never completed
-- here (B, N, P; X was completed before the test). V has no rows to check.
do $$
declare v_all text := (select string_agg(k || ' ' || pg_temp.ratings(k), ', ' order by k) from _s);
begin
  perform pg_temp.ok('R reset: A, C, F, K, W, Z (the job, 7 days or less after the end) and D, H (the admin''s button)',
    (select bool_and(pg_temp.ratings(k) = 'reset') and count(*) = 8 from _s where k in ('A', 'C', 'D', 'F', 'H', 'K', 'W', 'Z')),
    v_all);
  perform pg_temp.ok('R kept: E, S (the job, more than 7 days late) and B, N, P, X (not completed by this test)',
    (select bool_and(pg_temp.ratings(k) = 'kept') and count(*) = 6 from _s where k in ('B', 'E', 'N', 'P', 'S', 'X')),
    v_all);
end $$;


-- ════ Results ════════════════════════════════════════════════════════════
select test, ok, detail
  from (
    select 0 as n,
           'SUMMARY: ' || count(*) filter (where ok and test not like 'INFO%') || ' passed, '
             || count(*) filter (where not ok) || ' failed' as test,
           bool_and(ok) as ok, null::text as detail
      from _results
    union all
    select n, test, ok, detail from _results
  ) x
 order by n;

rollback;
