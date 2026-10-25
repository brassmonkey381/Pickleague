-- ============================================================
-- Players near a search area (persona tests for
-- migration_discover_players_near.sql).
--
-- NOT runnable on its own: build-players-near-test.mjs puts
-- migration_discover_players_near.sql (twice: it must be re-runnable) at the
-- marker line below. Everything runs inside the begin / rollback below, so
-- the linked (live) database is left untouched:
--   node supabase/tests/build-players-near-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary.
--
-- The search centre is 43.2 N, 104.2 W (far from every real venue); radius
-- 8,047 m (5 mi) unless a test says otherwise. Players are placed ONLY by the
-- home courts of their leagues (the user, 2026-10-24: "League courts only"):
-- a starred court, a check-in (past or live) and presence settings never
-- place anyone. Personas (temporary accounts, example.invalid emails unless
-- noted):
--   NV  the viewer (an ordinary player)
--   L1  in an OPEN league whose home court is ~2 km away          -> found
--   L2  in a CLOSED league ~2 km away that NV is not in           -> not found
--   L3  in a CLOSED league ~2 km away that NV is in too            -> found
--   LX  in the open league on a guest pass that has run out       -> not found
--   S1  starred a court ~3 km away, presence "everyone", no league -> not found
--   S3  starred it too, presence default, then NV's friend         -> never found
--   F1  checked in twice (location confirmed) at a court ~4 km away in 90
--       days, presence "everyone", no league                       -> not found
--   LV  checked in there NOW (confirmed), presence "everyone", no league
--                                                                  -> not found
--   LP  in a league ~8,039 m due north; ALSO starred the ~3 km court,
--       checked in twice and now at the ~4 km court; sharing PAUSED
--                                      -> found, at the league court only
--   LH  in the open league, presence "hidden" (league placement reads no
--       presence)                                                  -> found
--   E1  in that league ~8,039 m due north (just inside 5 mi, outside the old
--       bounding box)                                              -> found
--   FR  in an open league ~200 km away                            -> never (cap)
--   B1  in the open league, NV blocked them                        -> not found
--   B2  in the open league, they blocked NV                        -> not found
--   TA  in the open league, a test account (@pickleague.test)     -> hidden while
--       the God mode switch is on
--   DL  in the open league, account deleted                        -> not found
--   DR  in the open league, drilling on (the only driller)
-- ============================================================

begin;

-- The pg_temp helpers below are called by the personas (as anon /
-- authenticated). Since migration_anon_audit_rest.sql, functions postgres
-- creates are no longer EXECUTE-able by PUBLIC by default, so this test
-- transaction (rolled back below) gives the helpers the old default back.
alter default privileges for role postgres grant execute on functions to public;

-- ════ Harness ════════════════════════════════════════════════════════════
create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);
grant select, insert on _results to authenticated;
grant usage on sequence _results_n_seq to authenticated;

create temp table _p (k text primary key, id uuid not null);
insert into _p values
  ('NV', 'a7000000-0000-4000-8000-000000000001'), ('L1', 'a7000000-0000-4000-8000-000000000002'),
  ('L2', 'a7000000-0000-4000-8000-000000000003'), ('L3', 'a7000000-0000-4000-8000-000000000004'),
  ('LX', 'a7000000-0000-4000-8000-000000000005'), ('S1', 'a7000000-0000-4000-8000-000000000006'),
  ('LV', 'a7000000-0000-4000-8000-000000000007'), ('S3', 'a7000000-0000-4000-8000-000000000008'),
  ('F1', 'a7000000-0000-4000-8000-000000000009'), ('LP', 'a7000000-0000-4000-8000-00000000000a'),
  ('FR', 'a7000000-0000-4000-8000-00000000000b'), ('B1', 'a7000000-0000-4000-8000-00000000000c'),
  ('B2', 'a7000000-0000-4000-8000-00000000000d'), ('TA', 'a7000000-0000-4000-8000-00000000000e'),
  ('DL', 'a7000000-0000-4000-8000-00000000000f'), ('DR', 'a7000000-0000-4000-8000-000000000010'),
  ('LH', 'a7000000-0000-4000-8000-000000000011'), ('E1', 'a7000000-0000-4000-8000-000000000012');
grant select on _p to authenticated;

create temp table _lg (k text primary key, id uuid not null);
insert into _lg values
  ('OPEN',   'a7100000-0000-4000-8000-000000000001'),
  ('CLOSED', 'a7100000-0000-4000-8000-000000000002'),
  ('SHARED', 'a7100000-0000-4000-8000-000000000003'),
  ('FAR',    'a7100000-0000-4000-8000-000000000004'),
  ('EDGE',   'a7100000-0000-4000-8000-000000000005');
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

-- Runs p_sql; null if it went through, else the error's message and hint.
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

-- The persona keys NV finds (as NV), in the function's order, comma-joined.
create function pg_temp.found(
  p_radius double precision default 8047, p_query text default null, p_drilling boolean default false
) returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.as_user(pg_temp.p('NV'));
  select string_agg(x.k, ',' order by x.ord) into v
    from (select k.k, d.ord
            from (select r.id, row_number() over () as ord
                    from public.discover_players_near(43.2, -104.2, p_radius, p_query, p_drilling) r) d
            join _p k on k.id = d.id) x;
  return coalesce(v, '');
end $$;

create function pg_temp.has(p_list text, p_key text) returns boolean language sql immutable as $$
  select p_key = any (string_to_array(p_list, ','))
$$;


-- ════ Setup (before the migration) ══════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data)
select id,
       case when k = 'TA' then 'pn-ta@pickleague.test' else 'pn-' || lower(k) || '@example.invalid' end,
       jsonb_build_object('full_name', 'Near Test ' || k)
  from _p;

update public.profiles set drilling_enabled = (id = pg_temp.p('DR')) where id in (select id from _p);
update public.profiles set is_test_account = true where id = pg_temp.p('TA');
update public.profiles set deleted_at = now() where id = pg_temp.p('DL');

insert into public.leagues (id, name, is_open, is_active, home_court, home_court_lat, home_court_lng) values
  (pg_temp.lg('OPEN'),   'Near Test Open',   true,  true, 'Near Test Park',   43.2180, -104.2000),
  (pg_temp.lg('CLOSED'), 'Near Test Closed', false, true, 'Near Test Club',   43.2180, -104.2010),
  (pg_temp.lg('SHARED'), 'Near Test Shared', false, true, 'Near Test Shared', 43.2180, -104.2020),
  (pg_temp.lg('FAR'),    'Near Test Far',    true,  true, 'Near Test Far',    45.0000, -104.2000),
  -- 0.0723 degrees north = ~8,039 m: inside 8,047 m, outside a 111,320 m-a-degree box.
  (pg_temp.lg('EDGE'),   'Near Test Edge',   true,  true, 'Near Test Edge',   43.2723, -104.2000);

insert into public.league_members (league_id, user_id, expires_at)
select pg_temp.lg(m.lg), pg_temp.p(m.k), m.exp
  from (values
    ('OPEN', 'L1', null::timestamptz), ('CLOSED', 'L2', null), ('SHARED', 'L3', null), ('SHARED', 'NV', null),
    ('OPEN', 'LX', now() - interval '1 day'), ('FAR', 'FR', null),
    ('OPEN', 'B1', null), ('OPEN', 'B2', null), ('OPEN', 'TA', null), ('OPEN', 'DL', null), ('OPEN', 'DR', null),
    ('OPEN', 'LH', null), ('EDGE', 'E1', null), ('EDGE', 'LP', null)
  ) m(lg, k, exp);

insert into public.venues (id, sport, name, kind, lat, lng, source, geofence_radius_m) values
  ('test:pn-star', array['pickleball'], 'Near Test Star Courts', 'court', 43.2270, -104.2000, 'google', 100),
  ('test:pn-freq', array['pickleball'], 'Near Test Busy Courts', 'court', 43.2360, -104.2000, 'google', 100);

insert into public.court_favorites (user_id, venue_id)
select id, 'test:pn-star' from _p where k in ('S1', 'S3', 'LP');

-- "everyone" would name them at a court to anyone: still no court places them.
-- LP's sharing is paused; LH is hidden.
insert into public.presence_settings (user_id, checkins_level, paused_until)
select id,
       case when k = 'LH' then 'hidden' else 'everyone' end,
       case when k = 'LP' then now() + interval '1 day' end
  from _p where k in ('S1', 'F1', 'LV', 'LP', 'LH');

-- Past check-ins (checked out, location confirmed): the old "frequent" rule.
insert into public.venue_checkins (user_id, venue_id, checked_in_at, expires_at, checked_out_at, location_confirmed)
select pg_temp.p(c.k), 'test:pn-freq', now() - c.ago, now() - c.ago + interval '1 hour', now() - c.ago + interval '1 hour', true
  from (values ('F1', interval '10 days'), ('F1', interval '20 days'),
               ('LP', interval '10 days'), ('LP', interval '20 days')) c(k, ago);

-- Live check-ins (confirmed, open) at the ~4 km court right now.
insert into public.venue_checkins (user_id, venue_id, checked_in_at, expires_at, location_confirmed)
select pg_temp.p(c.k), 'test:pn-freq', now() - interval '10 minutes', now() + interval '1 hour', true
  from (values ('LV'), ('LP')) c(k);

insert into public.user_blocks (blocker_id, blocked_id) values
  (pg_temp.p('NV'), pg_temp.p('B1')),
  (pg_temp.p('B2'), pg_temp.p('NV'));

-- @@MIGRATION@@


-- ════ N1 grants and attributes ═══════════════════════════════════════════
do $$
declare
  f text := 'public.discover_players_near(double precision,double precision,double precision,text,boolean,boolean,uuid[],integer)';
begin
  perform pg_temp.as_admin();
  perform pg_temp.ok('N1 authenticated may call it, anon may not',
    has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute'));
  perform pg_temp.ok('N1 security definer, search_path ''''',
    (select prosecdef and proconfig = array['search_path=""'] from pg_proc where oid = f::regprocedure));
  perform pg_temp.ok('N1 returns no phone or email column',
    (select not (pg_get_function_result(f::regprocedure) ~* '\m(phone|email)\M')));
  perform pg_temp.ok('N1 the body reads no starred court, check-in or presence setting',
    (select prosrc !~* '(court_favorites|venue_checkins|presence_settings|presence_hidden_from|_pl_can_see_presence|fix_lat|fix_lng)'
       from pg_proc where oid = f::regprocedure));
  perform pg_temp.ok('N1 one definition (no overload for PostgREST to choose between)',
    (select count(*) = 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'discover_players_near'));
end $$;


-- ════ N2 refusals ════════════════════════════════════════════════════════
do $$
declare e jsonb;
begin
  perform pg_temp.as_signed_out();
  e := pg_temp.err('select * from public.discover_players_near(43.2, -104.2)');
  perform pg_temp.ok('N2 signed out: refused with pl:auth.signed_out', e->>'hint' = 'pl:auth.signed_out', e::text);
  perform pg_temp.as_user(pg_temp.p('NV'));
  e := pg_temp.err('select * from public.discover_players_near(null, -104.2)');
  perform pg_temp.ok('N2 no centre: refused with pl:input.invalid', e->>'hint' = 'pl:input.invalid', e::text);
  e := pg_temp.err('select * from public.discover_players_near(91, -104.2)');
  perform pg_temp.ok('N2 latitude out of range: refused', e->>'hint' = 'pl:input.invalid', e::text);
  perform pg_temp.as_admin();
end $$;


-- ════ N3 who is found, and who is not ═══════════════════════════════════
do $$
declare v text;
begin
  perform pg_temp.as_admin();
  insert into public.app_settings (key, value) values ('hide_test_accounts', 'false'::jsonb)
    on conflict (key) do update set value = excluded.value;
  v := pg_temp.found();
  perform pg_temp.ok('N3 open-league member near: found (L1)', pg_temp.has(v, 'L1'), v);
  perform pg_temp.ok('N3 closed league the viewer is not in: not found (L2)', not pg_temp.has(v, 'L2'), v);
  perform pg_temp.ok('N3 closed league the viewer is in too: found (L3)', pg_temp.has(v, 'L3'), v);
  perform pg_temp.ok('N3 expired guest pass: not found (LX)', not pg_temp.has(v, 'LX'), v);
  perform pg_temp.ok('N3 starred court only, presence everyone: not found (S1)', not pg_temp.has(v, 'S1'), v);
  perform pg_temp.ok('N3 starred court only, presence default: not found (S3)', not pg_temp.has(v, 'S3'), v);
  perform pg_temp.ok('N3 two confirmed check-ins only, presence everyone: not found (F1)', not pg_temp.has(v, 'F1'), v);
  perform pg_temp.ok('N3 checked in there now, presence everyone: not found (LV)', not pg_temp.has(v, 'LV'), v);
  perform pg_temp.ok('N3 in a league in the area, sharing paused: found by the league court (LP)', pg_temp.has(v, 'LP'), v);
  perform pg_temp.ok('N3 in the open league, presence hidden: found by the league court (LH)', pg_temp.has(v, 'LH'), v);
  perform pg_temp.ok('N3 just inside the radius (~8,039 m due north): found (E1)', pg_temp.has(v, 'E1'), v);
  perform pg_temp.ok('N3 ~200 km away: not found (FR)', not pg_temp.has(v, 'FR'), v);
  perform pg_temp.ok('N3 blocked by the viewer: not found (B1)', not pg_temp.has(v, 'B1'), v);
  perform pg_temp.ok('N3 blocked the viewer: not found (B2)', not pg_temp.has(v, 'B2'), v);
  perform pg_temp.ok('N3 switch off: a test account is found (TA)', pg_temp.has(v, 'TA'), v);
  perform pg_temp.ok('N3 deleted account: not found (DL)', not pg_temp.has(v, 'DL'), v);
  perform pg_temp.ok('N3 never the viewer', not pg_temp.has(v, 'NV'), v);
  perform pg_temp.ok('N3 nearest first: L1 (2.00 km) before L3 (2.01 km) before E1 (8 km)',
    array_position(string_to_array(v, ','), 'L1') < array_position(string_to_array(v, ','), 'L3')
    and array_position(string_to_array(v, ','), 'L3') < array_position(string_to_array(v, ','), 'E1'), v);

  v := pg_temp.found(2500);
  perform pg_temp.ok('N3 radius 2.5 km: the league court (2 km) yes; the ~8 km league court no (E1, LP)',
    pg_temp.has(v, 'L1') and not pg_temp.has(v, 'E1') and not pg_temp.has(v, 'LP'), v);
  v := pg_temp.found(5000);
  perform pg_temp.ok('N3 radius 5 km: LP''s starred (3 km) and check-in (4 km) courts don''t bring anyone in',
    not pg_temp.has(v, 'LP') and not pg_temp.has(v, 'S1') and not pg_temp.has(v, 'F1') and not pg_temp.has(v, 'LV'), v);
  v := pg_temp.found(1e9);
  perform pg_temp.ok('N3 a huge radius is capped at 50 mi: ~200 km still not found', not pg_temp.has(v, 'FR'), v);
end $$;


-- ════ N4 place columns ═══════════════════════════════════════════════════
do $$
declare r record;
begin
  perform pg_temp.as_user(pg_temp.p('NV'));
  select * into r from public.discover_players_near(43.2, -104.2, 8047) d where d.id = pg_temp.p('L1');
  perform pg_temp.ok('N4 L1: plays at the league court, ~2 km',
    r.place_name = 'Near Test Park' and r.place_kind = 'league' and r.distance_m between 1900 and 2100,
    format('%s %s %s', r.place_name, r.place_kind, r.distance_m));
  select * into r from public.discover_players_near(43.2, -104.2, 8047) d where d.id = pg_temp.p('LP');
  perform pg_temp.ok('N4 LP: at the ~8 km league court, never the nearer starred / check-in courts',
    r.place_name = 'Near Test Edge' and r.place_kind = 'league' and r.distance_m between 7900 and 8100,
    format('%s %s %s', r.place_name, r.place_kind, r.distance_m));
  perform pg_temp.ok('N4 every row is placed by a league court',
    (select bool_and(d.place_kind = 'league') and count(*) > 0
       from public.discover_players_near(43.2, -104.2, 80468) d));
  perform pg_temp.as_admin();
end $$;


-- ════ N5 presence settings never place anyone ═══════════════════════════
do $$
declare
  v text;
  r record;
begin
  perform pg_temp.as_admin();
  insert into public.friendships (requester_id, addressee_id, status, responded_at) values
    (pg_temp.p('NV'), pg_temp.p('S3'), 'accepted', now());
  v := pg_temp.found();
  perform pg_temp.ok('N5 S3 becomes the viewer''s friend: still not found (a star places no one)', not pg_temp.has(v, 'S3'), v);
  perform pg_temp.ok('N5 LP''s pause is kept: none of their check-ins or stars shows, only the league court',
    pg_temp.has(v, 'LP'), v);
  perform pg_temp.as_admin();
  update public.presence_settings set paused_until = null where user_id = pg_temp.p('LP');
  perform pg_temp.as_user(pg_temp.p('NV'));
  select * into r from public.discover_players_near(43.2, -104.2, 8047) d where d.id = pg_temp.p('LP');
  perform pg_temp.ok('N5 LP resumes sharing: still the league court (~8 km), never where they are now',
    r.place_name = 'Near Test Edge' and r.distance_m between 7900 and 8100,
    format('%s %s', r.place_name, r.distance_m));
  perform pg_temp.as_admin();
end $$;


-- ════ N6 filters ═════════════════════════════════════════════════════════
do $$
declare v text;
begin
  v := pg_temp.found(p_drilling => true);
  perform pg_temp.ok('N6 drilling only: just the driller (DR)', v = 'DR', v);
  v := pg_temp.found(p_query => 'near test l1');
  perform pg_temp.ok('N6 name search, any case: L1 only', v = 'L1', v);
  v := pg_temp.found(p_query => '%');
  perform pg_temp.ok('N6 % is literal, not a wildcard', v = '', v);
  perform pg_temp.as_admin();
  update public.profiles set username = 'pn_l3_' || substr(md5(random()::text), 1, 8) where id = pg_temp.p('L3');
  v := pg_temp.found(p_query => '@' || (select username from public.profiles where id = pg_temp.p('L3')));
  perform pg_temp.ok('N6 @username finds them', v = 'L3', v);
  perform pg_temp.as_admin();
end $$;


-- ════ N7 the God mode switch hides test accounts ════════════════════════
do $$
declare v text;
begin
  perform pg_temp.as_admin();
  insert into public.app_settings (key, value) values ('hide_test_accounts', 'true'::jsonb)
    on conflict (key) do update set value = excluded.value;
  v := pg_temp.found();
  perform pg_temp.ok('N7 switch on: the test account is hidden (TA)', not pg_temp.has(v, 'TA'), v);
  perform pg_temp.ok('N7 switch on: everyone else still found (L1)', pg_temp.has(v, 'L1'), v);
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
