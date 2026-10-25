-- ============================================================
-- Player search by name (persona tests for migration_search_players.sql).
--
-- NOT runnable on its own: build-search-players-test.mjs puts
-- migration_discover_players_near.sql and migration_search_players.sql (twice:
-- it must be re-runnable) at the marker line below. Everything runs inside
-- the begin / rollback below, so the linked (live) database is left untouched:
--   node supabase/tests/build-search-players-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary.
--
-- Every persona's name starts "Zqsrch " (no real player matches it). The
-- search centre is 43.2 N, 104.2 W (far from every real venue), radius
-- 8,047 m (5 mi). Personas (temporary accounts, example.invalid emails
-- unless noted):
--   NV  the viewer
--   NR  in an OPEN league ~2 km away             -> found, placed, first
--   NE  in that open league too (same court): placed; same distance, so by name
--   NC  in a CLOSED league ~2 km away NV is not in -> found by name, NOT placed
--   FA  in an open league ~200 km away            -> found, not placed
--   NO  no league at all                          -> found, not placed
--   ST  starred a court ~3 km away, presence "everyone", checked in there now,
--       no league                                 -> found, not placed
--   B1  NV blocked them                           -> not found
--   B2  they blocked NV                           -> not found
--   TA  a test account (@pickleague.test)         -> hidden while the switch is on
--   DL  account deleted                           -> not found
--   UN  an unclaimed DUPR placeholder             -> left out with real people only
--   GU  a guest pass                              -> left out with real people only
--   (B1, B2, TA, DL, UN, GU and XX are all in the open league ~2 km away: a
--   placed row is still left out by each rule.)
--   XX  named "Someone Else" (no match)           -> never found by "zqsrch"
-- ============================================================

begin;

-- ════ Harness ════════════════════════════════════════════════════════════
create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);
grant select, insert on _results to authenticated;
grant usage on sequence _results_n_seq to authenticated;

create temp table _p (k text primary key, id uuid not null);
insert into _p values
  ('NV', 'a7200000-0000-4000-8000-000000000001'), ('NR', 'a7200000-0000-4000-8000-000000000002'),
  ('NE', 'a7200000-0000-4000-8000-000000000003'), ('NC', 'a7200000-0000-4000-8000-000000000004'),
  ('FA', 'a7200000-0000-4000-8000-000000000005'), ('NO', 'a7200000-0000-4000-8000-000000000006'),
  ('ST', 'a7200000-0000-4000-8000-000000000007'), ('B1', 'a7200000-0000-4000-8000-000000000008'),
  ('B2', 'a7200000-0000-4000-8000-000000000009'), ('TA', 'a7200000-0000-4000-8000-00000000000a'),
  ('DL', 'a7200000-0000-4000-8000-00000000000b'), ('UN', 'a7200000-0000-4000-8000-00000000000c'),
  ('GU', 'a7200000-0000-4000-8000-00000000000d'), ('XX', 'a7200000-0000-4000-8000-00000000000e');
grant select on _p to authenticated;

create temp table _lg (k text primary key, id uuid not null);
insert into _lg values
  ('OPEN',   'a7300000-0000-4000-8000-000000000001'),
  ('CLOSED', 'a7300000-0000-4000-8000-000000000002'),
  ('FAR',    'a7300000-0000-4000-8000-000000000003');
grant select on _lg to authenticated;

create function pg_temp.p(text) returns uuid language sql stable as $$ select id from _p where k = $1 $$;
create function pg_temp.lg(text) returns uuid language sql stable as $$ select id from _lg where k = $1 $$;

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

create function pg_temp.as_admin() returns void language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

create function pg_temp.err(p_sql text) returns jsonb language plpgsql as $$
declare
  v_msg  text;
  v_hint text;
begin
  execute p_sql;
  return null;
exception when others then
  get stacked diagnostics v_msg = message_text, v_hint = pg_exception_hint;
  return jsonb_build_object('msg', v_msg, 'hint', v_hint);
end $$;

-- The persona keys NV finds (as NV), in the function's order, comma-joined;
-- a placed row is written KEY@ (so the order and the placement show at once).
create function pg_temp.found(
  p_query text default 'zqsrch', p_area boolean default true, p_real boolean default false,
  p_exclude uuid[] default null, p_limit int default 60
) returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.as_user(pg_temp.p('NV'));
  select string_agg(x.k || case when x.placed then '@' else '' end, ',' order by x.ord) into v
    from (select k.k, d.ord, d.placed
            from (select r.id, r.distance_m is not null as placed, row_number() over () as ord
                    from public.search_players(
                           p_query,
                           case when p_area then 43.2 end, case when p_area then -104.2 end,
                           8047, p_real, p_exclude, p_limit) r) d
            join _p k on k.id = d.id) x;
  return coalesce(v, '');
end $$;

create function pg_temp.has(p_list text, p_key text) returns boolean language sql immutable as $$
  select p_key = any (string_to_array(replace(p_list, '@', ''), ','))
$$;
create function pg_temp.placed(p_list text, p_key text) returns boolean language sql immutable as $$
  select (p_key || '@') = any (string_to_array(p_list, ','))
$$;
create function pg_temp.pos(p_list text, p_key text) returns int language sql immutable as $$
  select array_position(string_to_array(replace(p_list, '@', ''), ','), p_key)
$$;


-- ════ Setup (before the migration) ══════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data)
select id,
       case when k = 'TA' then 'sp-ta@pickleague.test' else 'sp-' || lower(k) || '@example.invalid' end,
       jsonb_build_object('full_name', case when k = 'XX' then 'Someone Else' else 'Zqsrch ' || k end)
  from _p;

-- Names fixed (whatever the signup trigger made of them) and usernames known.
update public.profiles pr
   set full_name = case when x.k = 'XX' then 'Someone Else' else 'Zqsrch ' || x.k end,
       username  = 'sp_' || lower(x.k) || '_' || substr(md5(x.id::text), 1, 6)
  from _p x where pr.id = x.id;
update public.profiles set is_test_account = true where id = pg_temp.p('TA');
update public.profiles set deleted_at = now() where id = pg_temp.p('DL');
update public.profiles set is_unclaimed = true where id = pg_temp.p('UN');
update public.profiles set is_guest = true where id = pg_temp.p('GU');

insert into public.leagues (id, name, is_open, is_active, home_court, home_court_lat, home_court_lng) values
  (pg_temp.lg('OPEN'),   'Zqsrch Open',   true,  true, 'Zqsrch Park',   43.2180, -104.2000),
  (pg_temp.lg('CLOSED'), 'Zqsrch Closed', false, true, 'Zqsrch Club',   43.2180, -104.2010),
  (pg_temp.lg('FAR'),    'Zqsrch Far',    true,  true, 'Zqsrch Far',    45.0000, -104.2000);

insert into public.league_members (league_id, user_id)
select pg_temp.lg(m.lg), pg_temp.p(m.k)
  from (values ('OPEN', 'NR'), ('OPEN', 'NE'), ('CLOSED', 'NC'), ('FAR', 'FA'),
               ('OPEN', 'B1'), ('OPEN', 'B2'), ('OPEN', 'TA'), ('OPEN', 'DL'),
               ('OPEN', 'UN'), ('OPEN', 'GU'), ('OPEN', 'XX')) m(lg, k);

insert into public.venues (id, sport, name, kind, lat, lng, source, geofence_radius_m) values
  ('test:sp-star', array['pickleball'], 'Zqsrch Star Courts', 'court', 43.2270, -104.2000, 'google', 100);
insert into public.court_favorites (user_id, venue_id) values (pg_temp.p('ST'), 'test:sp-star');
insert into public.presence_settings (user_id, checkins_level) values (pg_temp.p('ST'), 'everyone');
insert into public.venue_checkins (user_id, venue_id, checked_in_at, expires_at, location_confirmed)
values (pg_temp.p('ST'), 'test:sp-star', now() - interval '10 minutes', now() + interval '1 hour', true);

insert into public.user_blocks (blocker_id, blocked_id) values
  (pg_temp.p('NV'), pg_temp.p('B1')),
  (pg_temp.p('B2'), pg_temp.p('NV'));

-- @@MIGRATION@@


-- ════ S1 grants and attributes ═══════════════════════════════════════════
do $$
declare
  f text := 'public.search_players(text,double precision,double precision,double precision,boolean,uuid[],integer)';
begin
  perform pg_temp.as_admin();
  perform pg_temp.ok('S1 authenticated may call it, anon may not',
    has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute'));
  perform pg_temp.ok('S1 security definer, search_path ''''',
    (select prosecdef and proconfig = array['search_path=""'] from pg_proc where oid = f::regprocedure));
  perform pg_temp.ok('S1 returns no phone or email column',
    (select not (pg_get_function_result(f::regprocedure) ~* '\m(phone|email)\M')));
  perform pg_temp.ok('S1 the body reads no starred court, check-in or presence setting',
    (select prosrc !~* '(court_favorites|venue_checkins|presence_settings|presence_hidden_from|_pl_can_see_presence|fix_lat|fix_lng)'
       from pg_proc where oid = f::regprocedure));
  perform pg_temp.ok('S1 one definition (no overload for PostgREST to choose between)',
    (select count(*) = 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'search_players'));
end $$;


-- ════ S2 refusals ════════════════════════════════════════════════════════
do $$
declare e jsonb;
begin
  perform pg_temp.as_signed_out();
  e := pg_temp.err('select * from public.search_players(''zqsrch'')');
  perform pg_temp.ok('S2 signed out: refused with pl:auth.signed_out', e->>'hint' = 'pl:auth.signed_out', e::text);
  perform pg_temp.as_user(pg_temp.p('NV'));
  e := pg_temp.err('select * from public.search_players(''z'')');
  perform pg_temp.ok('S2 one letter: refused with pl:input.invalid', e->>'hint' = 'pl:input.invalid', e::text);
  e := pg_temp.err('select * from public.search_players(''  @z '')');
  perform pg_temp.ok('S2 "@z" (one letter after the @): refused', e->>'hint' = 'pl:input.invalid', e::text);
  e := pg_temp.err('select * from public.search_players(null)');
  perform pg_temp.ok('S2 no query: refused', e->>'hint' = 'pl:input.invalid', e::text);
  e := pg_temp.err('select * from public.search_players(''zqsrch'', 43.2, null)');
  perform pg_temp.ok('S2 half a centre: refused', e->>'hint' = 'pl:input.invalid', e::text);
  e := pg_temp.err('select * from public.search_players(''zqsrch'', 91, -104.2)');
  perform pg_temp.ok('S2 latitude out of range: refused', e->>'hint' = 'pl:input.invalid', e::text);
  perform pg_temp.as_admin();
end $$;


-- ════ S3 who is found, who is placed, and the order ═════════════════════
do $$
declare v text;
begin
  perform pg_temp.as_admin();
  insert into public.app_settings (key, value) values ('hide_test_accounts', 'false'::jsonb)
    on conflict (key) do update set value = excluded.value;
  v := pg_temp.found();
  perform pg_temp.ok('S3 open-league member near: found AND placed (NR)', pg_temp.placed(v, 'NR'), v);
  perform pg_temp.ok('S3 closed league the viewer is not in: found by name, NOT placed (NC)',
    pg_temp.has(v, 'NC') and not pg_temp.placed(v, 'NC'), v);
  perform pg_temp.ok('S3 league ~200 km away: found, not placed (FA)', pg_temp.has(v, 'FA') and not pg_temp.placed(v, 'FA'), v);
  perform pg_temp.ok('S3 no league: found, not placed (NO)', pg_temp.has(v, 'NO') and not pg_temp.placed(v, 'NO'), v);
  perform pg_temp.ok('S3 starred court + live check-in nearby, presence everyone: found, NOT placed (ST)',
    pg_temp.has(v, 'ST') and not pg_temp.placed(v, 'ST'), v);
  perform pg_temp.ok('S3 blocked by the viewer: not found (B1)', not pg_temp.has(v, 'B1'), v);
  perform pg_temp.ok('S3 blocked the viewer: not found (B2)', not pg_temp.has(v, 'B2'), v);
  perform pg_temp.ok('S3 switch off: a test account is found (TA)', pg_temp.has(v, 'TA'), v);
  perform pg_temp.ok('S3 deleted account: not found (DL)', not pg_temp.has(v, 'DL'), v);
  perform pg_temp.ok('S3 never the viewer', not pg_temp.has(v, 'NV'), v);
  perform pg_temp.ok('S3 a name without the query: not found (XX)', not pg_temp.has(v, 'XX'), v);
  perform pg_temp.ok('S3 placeholders and guests found without real-people-only (UN, GU)',
    pg_temp.has(v, 'UN') and pg_temp.has(v, 'GU'), v);
  perform pg_temp.ok('S3 the placed players come first (NE, NR before every unplaced row)',
    greatest(pg_temp.pos(v, 'NE'), pg_temp.pos(v, 'NR')) < least(pg_temp.pos(v, 'FA'), pg_temp.pos(v, 'NC'), pg_temp.pos(v, 'NO'), pg_temp.pos(v, 'ST')), v);
  perform pg_temp.ok('S3 the rest by name (FA, NC, NO, ST)',
    pg_temp.pos(v, 'FA') < pg_temp.pos(v, 'NC') and pg_temp.pos(v, 'NC') < pg_temp.pos(v, 'NO')
    and pg_temp.pos(v, 'NO') < pg_temp.pos(v, 'ST'), v);

  v := pg_temp.found(p_real => true);
  perform pg_temp.ok('S3 real people only: no placeholder, no guest (UN, GU)',
    not pg_temp.has(v, 'UN') and not pg_temp.has(v, 'GU') and pg_temp.has(v, 'NR'), v);

  v := pg_temp.found(p_area => false);
  perform pg_temp.ok('S3 no centre: everyone found by name, nobody placed',
    pg_temp.has(v, 'NR') and pg_temp.has(v, 'FA') and position('@' in v) = 0, v);

  v := pg_temp.found(p_exclude => array[pg_temp.p('NR'), pg_temp.p('FA')]);
  perform pg_temp.ok('S3 p_exclude leaves them out (NR, FA)', not pg_temp.has(v, 'NR') and not pg_temp.has(v, 'FA') and pg_temp.has(v, 'NE'), v);

  v := pg_temp.found(p_limit => 2, p_real => true);
  perform pg_temp.ok('S3 p_limit 2 (real people only): the two nearest, by name (NE, NR)', v = 'NE@,NR@', v);
end $$;


-- ════ S4 the query ═══════════════════════════════════════════════════════
do $$
declare v text;
begin
  v := pg_temp.found(p_query => 'ZQSRCH fa');
  perform pg_temp.ok('S4 any case, full name: FA only', v = 'FA', v);
  v := pg_temp.found(p_query => 'zqsrch nr');
  perform pg_temp.ok('S4 a placed match keeps its place', v = 'NR@', v);
  v := pg_temp.found(p_query => '@' || (select username from public.profiles where id = pg_temp.p('NO')));
  perform pg_temp.ok('S4 @username finds them', v = 'NO', v);
  v := pg_temp.found(p_query => '%%');
  perform pg_temp.ok('S4 % is literal, not a wildcard', v = '', v);
  v := pg_temp.found(p_query => 'sp\_');
  perform pg_temp.ok('S4 a backslash is literal too', v = '', v);
  v := pg_temp.found(p_query => 'srch');
  perform pg_temp.ok('S4 a match inside a name still finds them (NR)', pg_temp.has(v, 'NR'), v);
end $$;


-- ════ S5 the God mode switch hides test accounts ════════════════════════
do $$
declare v text;
begin
  perform pg_temp.as_admin();
  insert into public.app_settings (key, value) values ('hide_test_accounts', 'true'::jsonb)
    on conflict (key) do update set value = excluded.value;
  v := pg_temp.found();
  perform pg_temp.ok('S5 switch on: the test account is hidden (TA)', not pg_temp.has(v, 'TA'), v);
  perform pg_temp.ok('S5 switch on: everyone else still found (NR, NO)', pg_temp.has(v, 'NR') and pg_temp.has(v, 'NO'), v);
  perform pg_temp.as_admin();
end $$;


-- ════ Results ════════════════════════════════════════════════════════════
select test, ok, detail
  from (
    select 0 as n,
           'SUMMARY: ' || count(*) filter (where ok) || ' passed, ' || count(*) filter (where not ok) || ' failed' as test,
           bool_and(ok) as ok, null::text as detail
      from _results
    union all
    select n, test, ok, detail from _results
  ) x
 order by n;

rollback;
