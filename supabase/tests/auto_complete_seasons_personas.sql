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
-- show what the first run did to REAL seasons (rolled back with the rest).
--
-- now() is fixed for the whole transaction, so "today" is computed once below.
-- Personas (temporary accounts, example.invalid emails): AD (admin of every
-- test league), M1-M4 (members), NM (not a member), KZ (a creator in
-- Pacific/Kiritimati, UTC+14), PZ (a creator in Pacific/Pago_Pago, UTC-11),
-- BZ (a creator whose stored zone no longer parses: written straight to the
-- table, as if tzdata had retired a once-valid name).
-- Seasons (one league each, 5 members, weekly locks, baseline 4.00; "today"
-- is the default zone's, America/Los_Angeles, unless said):
--   A  ended yesterday, all 3 periods locked        -> the job completes it
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
        pg_temp.d('la') - 23, pg_temp.d('la') - 2, 3, 'active');

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
       pg_temp.lock('Z', 1), pg_temp.lock('Z', 2), pg_temp.lock('Z', 3);

-- complete_season's grants before the migration (it must keep them).
create temp table _acl_before as
select (select proacl::text from pg_proc where oid = 'public.complete_season(uuid)'::regprocedure) as acl,
       has_function_privilege('authenticated', 'public.complete_season(uuid)', 'execute') as auth_x,
       has_function_privilege('anon', 'public.complete_season(uuid)', 'execute') as anon_x;

-- @@MIGRATION@@


-- ════ G1 grants, attributes, the job ═════════════════════════════════════
do $$
declare
  f_in  text := 'public._complete_season_unchecked(uuid)';
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
  perform pg_temp.ok('G1 one definition each (no overloads)',
    (select count(*) = 3 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('complete_season', '_complete_season_unchecked', 'auto_complete_due_seasons')));
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
  perform pg_temp.as_anon();
  e := pg_temp.err(format('select public.complete_season(%L::uuid)', pg_temp.s('D')));
  perform pg_temp.as_admin();
  perform pg_temp.ok('G3 the anon key: admins and co-admins only (was let through)',
    e = 'Only admins and co-admins can complete a season', e);
  e := pg_temp.complete_as('AD', pg_temp.s('N'));
  perform pg_temp.ok('G3 nothing locked yet: lock a period first',
    e = 'Lock in at least one period before completing the season', e);
  e := pg_temp.complete_as('AD', pg_temp.s('X'));
  perform pg_temp.ok('G3 already completed: the reset has been applied',
    e = 'ELO reset has already been applied for this season', e);
  perform pg_temp.ok('G3 the refused seasons are untouched',
    pg_temp.state('D') = 'active/f' and pg_temp.finals('D') = 0 and pg_temp.state('N') = 'upcoming/f' and pg_temp.finals('N') = 0);
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
  perform pg_temp.ok('J1 the job returns how many seasons it completed', v_run = v_flipped and v_run >= 3,
    format('returned %s, seasons flipped to completed %s', v_run, v_flipped));

  perform pg_temp.ok('J1 A (ended yesterday, all locked): completed, reset applied',
    pg_temp.state('A') = 'completed/t', pg_temp.state('A'));
  select string_agg(k.k || ' #' || f.final_rank || ' m' || f.median_rank || ' ' || f.new_elo || ' (+' || f.elo_bonus || ')',
                    ', ' order by f.final_rank) into v_rows
    from public.season_final_standings f join _p k on k.id = f.user_id
   where f.season_id = pg_temp.s('A');
  perform pg_temp.ok('J1 A final standings by median rank, new PLUPR = baseline 4.00 + 0.20 / 0.15 / 0.10 / 0.05 / 0.02',
    v_rows = 'AD #1 m1 4.200 (+0.200), M1 #2 m2 4.150 (+0.150), M2 #3 m3 4.100 (+0.100), M3 #4 m4 4.050 (+0.050), M4 #5 m5 4.020 (+0.020)',
    v_rows);
  perform pg_temp.ok('J1 A league ratings reset to the new PLUPR, every facet',
    (select bool_and(r.rating = f.new_elo and r.singles_rating = f.new_elo and r.doubles_rating = f.new_elo
                     and r.mixed_doubles_rating = f.new_elo) and count(*) = 5
       from public.season_final_standings f
       join public.league_player_ratings r on r.league_id = f.league_id and r.user_id = f.user_id
      where f.season_id = pg_temp.s('A')));
  select string_agg(k.k || ' ' || b.name, ', ' order by b.name, k.k) into v_rows
    from public.player_badges pb join public.badges b on b.id = pb.badge_id join _p k on k.id = pb.user_id
   where pb.league_id = pg_temp.l('A') and pb.context = 'Autoseason A';
  perform pg_temp.ok('J1 A badges: Period Sweeper (AD), Season Bronze (M2), Season Crown (AD), Season Silver (M1)',
    v_rows = 'AD Period Sweeper, M2 Season Bronze, AD Season Crown, M1 Season Silver', v_rows);

  perform pg_temp.ok('J1 K (creator in Kiritimati, ended there yesterday or before): completed',
    pg_temp.state('K') = 'completed/t' and pg_temp.finals('K') = 5, pg_temp.state('K') || ' ' || pg_temp.finals('K'));
  perform pg_temp.ok('J1 Z setup: its creator''s stored zone really does not parse',
    pg_temp.err('select now() at time zone ''Mars/Olympus_Mons''') is not null
    and (select tz from public.pickleague_time_zones where profile_id = pg_temp.p('BZ')) = 'Mars/Olympus_Mons');
  perform pg_temp.ok('J1 Z (creator''s zone unparseable, ended 2 days ago): the default zone is used, completed',
    pg_temp.state('Z') = 'completed/t' and pg_temp.finals('Z') = 5, pg_temp.state('Z') || ' ' || pg_temp.finals('Z'));
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
  perform pg_temp.ok('J1 N (upcoming) and X (completed) untouched; X gets no finals',
    pg_temp.state('N') = 'upcoming/f' and pg_temp.state('X') = 'completed/t' and pg_temp.finals('X') = 0);
  perform pg_temp.ok('J1 the untouched leagues keep their ratings (B, C, D, P)',
    (select bool_and(rating = 3.33 and singles_rating = 3.33) from public.league_player_ratings
      where league_id in (pg_temp.l('B'), pg_temp.l('C'), pg_temp.l('D'), pg_temp.l('P'))));

  -- The badge triggers still fire: +150 pickles per new badge, and its notification + push.
  perform pg_temp.ok('J1 +150 pickles for every badge the run awarded (AD: crown + sweeper in A, K and Z)',
    (select bool_and(coalesce(p.pickles, 0) - b.pickles
                     = 150 * (select count(*) from public.player_badges pb
                               where pb.user_id = p.id and pb.id not in (select id from _bdg)))
       from public.profiles p join _pk b on b.id = p.id)
    and (select coalesce(p.pickles, 0) - b.pickles from public.profiles p join _pk b on b.id = p.id
          where p.id = pg_temp.p('AD')) = 900,
    (select string_agg(k.k || ' +' || (coalesce(p.pickles, 0) - b.pickles), ', ' order by k.k)
       from public.profiles p join _pk b on b.id = p.id join _p k on k.id = p.id));
  perform pg_temp.ok('J1 the badge notification ("+150 pickles for earning Season Crown!") and its push are queued',
    exists (select 1 from public.notifications n
             where n.user_id = pg_temp.p('AD') and n.id not in (select id from _ntf)
               and n.title = '🥒 +150 pickles for earning Season Crown!'
               and exists (select 1 from public.push_outbox o where o.notification_id = n.id)));
end $$;

-- What the first run did to real seasons (it is rolled back with the rest).
insert into _results (test, ok, detail)
select 'INFO the run also completed (live, rolled back): ' || l.name || ' / ' || s.name, true,
       format('ended %s; final: %s', s.end_date,
              (select string_agg('#' || f.final_rank || ' ' || coalesce(pr.full_name, '?') || ' ' || f.new_elo,
                                 ', ' order by f.final_rank)
                 from public.season_final_standings f left join public.profiles pr on pr.id = f.user_id
                where f.season_id = s.id))
  from _before b
  join public.league_seasons s on s.id = b.id
  left join public.leagues l on l.id = s.league_id
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
