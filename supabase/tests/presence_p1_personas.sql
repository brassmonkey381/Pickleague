-- ============================================================
-- Presence Phase 1 persona tests (docs/play-sessions-presence-api.md).
--
-- NOT runnable on its own: build-presence-test.mjs wraps it as
--   begin; <this file up to the marker> <the presence migrations, Phase 1.5 included>
--   <re-runs, migration_rls_hardening_2026q3.sql re-run> <the rest of this file,
--   with validity_personas.sql (Phase 1.5) at -- @@VALIDITY@@> rollback;
-- and the last statement selects the results. Run (from the linked checkout):
--   node supabase/tests/build-presence-test.mjs <out.sql>
--   supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary.
--
-- Personas are temporary accounts created inside the transaction (auth.users
-- insert; the signup trigger makes the profile), on temporary courts near
-- 40.0 N, 100.0 W, far from every real venue:
--   O owner · F friend · C close friend (O starred C) · L closed-league mate
--   P open-league mate · S stranger · B blocked by O · K blocks O
--   G guest pass (profiles.is_guest) · D deletes their account · U unclaimed
--   DUPR placeholder · R1-R3 rated players · X/Y crossing requests
--   Q/W decline cooldown · Z block teardown · N played a match with O
--   M friend-request cap · AT league admin who tries to enrol V (victim)
--   J joins an open league that is closed later · I admitted to closed
--   leagues · CM admitted to a closed league before it reopened · RV rated
--   viewer, RF their rated friend, RH/RX/RY rated strangers (crowd band) ·
--   E fix rules, extensions, early End / check-out
-- Each block switches persona with pg_temp.as_user (request.jwt.claims + role
-- authenticated) and records assertions in _results. now() is fixed for the
-- whole transaction, so times compare exactly.
-- ============================================================

create temp table _pre as select (select count(*) from public.venues) as n_venues;

-- @@MIGRATIONS@@


-- ════ Harness ════════════════════════════════════════════════════════════
create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);
grant select, insert on _results to authenticated;
grant usage on sequence _results_n_seq to authenticated;

create temp table _p (k text primary key, id uuid not null);
insert into _p values
  ('O',  'a0000000-0000-4000-8000-000000000001'), ('F',  'a0000000-0000-4000-8000-000000000002'),
  ('C',  'a0000000-0000-4000-8000-000000000003'), ('L',  'a0000000-0000-4000-8000-000000000004'),
  ('P',  'a0000000-0000-4000-8000-000000000005'), ('S',  'a0000000-0000-4000-8000-000000000006'),
  ('B',  'a0000000-0000-4000-8000-000000000007'), ('K',  'a0000000-0000-4000-8000-000000000008'),
  ('G',  'a0000000-0000-4000-8000-000000000009'), ('D',  'a0000000-0000-4000-8000-00000000000a'),
  ('U',  'a0000000-0000-4000-8000-00000000000b'), ('R1', 'a0000000-0000-4000-8000-00000000000c'),
  ('R2', 'a0000000-0000-4000-8000-00000000000d'), ('R3', 'a0000000-0000-4000-8000-00000000000e'),
  ('X',  'a0000000-0000-4000-8000-00000000000f'), ('Y',  'a0000000-0000-4000-8000-000000000010'),
  ('Q',  'a0000000-0000-4000-8000-000000000011'), ('W',  'a0000000-0000-4000-8000-000000000012'),
  ('Z',  'a0000000-0000-4000-8000-000000000013'), ('N',  'a0000000-0000-4000-8000-000000000014'),
  ('M',  'a0000000-0000-4000-8000-000000000015'), ('AT', 'a0000000-0000-4000-8000-000000000016'),
  ('V',  'a0000000-0000-4000-8000-000000000017'), ('J',  'a0000000-0000-4000-8000-000000000018'),
  ('I',  'a0000000-0000-4000-8000-000000000019'), ('RV', 'a0000000-0000-4000-8000-00000000001a'),
  ('RF', 'a0000000-0000-4000-8000-00000000001b'), ('RH', 'a0000000-0000-4000-8000-00000000001c'),
  ('RX', 'a0000000-0000-4000-8000-00000000001d'), ('RY', 'a0000000-0000-4000-8000-00000000001e'),
  ('E',  'a0000000-0000-4000-8000-00000000001f'), ('CM', 'a0000000-0000-4000-8000-000000000020');
grant select on _p to authenticated;

create function pg_temp.p(text) returns uuid language sql stable as $$ select id from _p where k = $1 $$;

create function pg_temp.ok(p_test text, p_ok boolean, p_detail text default null) returns void
language sql as $$ insert into _results (test, ok, detail) values (p_test, coalesce(p_ok, false), p_detail) $$;

create function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create function pg_temp.as_admin() returns void language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

-- A confirmed check-in for persona k: a fresh 10 m-accuracy fix 11 m north of
-- the court (every test court is at -100.0; Alpha at 40.0, so 40.0001).
-- Leaves the role as that persona.
create function pg_temp.checkin(k text, p_id uuid, p_venue text default 'test:p1-alpha', p_minutes int default 120,
                                p_lat double precision default 40.0001)
returns public.venue_checkins language plpgsql as $$
declare r public.venue_checkins;
begin
  perform pg_temp.as_user(pg_temp.p(k));
  select * into r from public.checkin_venue(p_id => p_id, p_venue => p_venue, p_minutes => p_minutes,
    p_source => 'manual', p_at => null, p_lat => p_lat, p_lng => -100.0, p_accuracy_m => 10, p_fix_at => now());
  return r;
end $$;

-- Whether `viewer` sees `who` by name at court Alpha, and how many rows
-- `viewer` gets there. Both leave the role as `viewer`.
create function pg_temp.sees(viewer text, who text) returns boolean language plpgsql as $$
declare v boolean;
begin
  perform pg_temp.as_user(pg_temp.p(viewer));
  select exists (select 1 from public.court_presence('test:p1-alpha') c where c.user_id = pg_temp.p(who)) into v;
  return v;
end $$;

-- The same at any court.
create function pg_temp.sees_at(viewer text, who text, p_venue text) returns boolean language plpgsql as $$
declare v boolean;
begin
  perform pg_temp.as_user(pg_temp.p(viewer));
  select exists (select 1 from public.court_presence(p_venue) c where c.user_id = pg_temp.p(who)) into v;
  return v;
end $$;

create function pg_temp.rows_at_alpha(viewer text) returns int language plpgsql as $$
declare v int;
begin
  perform pg_temp.as_user(pg_temp.p(viewer));
  select count(*) into v from public.court_presence('test:p1-alpha');
  return v;
end $$;

-- Whether any anonymous row `viewer` gets at Alpha (court_presence or
-- venue_players_here) still carries something of a named row they saw
-- before: its id, md5(id || viewer), or its exact arrival and expiry.
create function pg_temp.links_back(viewer text, p_id uuid, p_in timestamptz, p_exp timestamptz) returns boolean
language plpgsql as $$
declare
  v  boolean;
  me uuid := pg_temp.p(viewer);
begin
  perform pg_temp.as_user(me);
  select exists (select 1 from public.court_presence('test:p1-alpha') c
                  where c.anonymous
                    and (c.checkin_id in (p_id, md5(p_id::text || me::text)::uuid)
                         or (c.checked_in_at = p_in and c.expires_at = p_exp)))
      or exists (select 1 from public.venue_players_here('test:p1-alpha') c
                  where c.user_id is null
                    and (c.checkin_id in (p_id, md5(p_id::text || me::text)::uuid)
                         or (c.checked_in_at = p_in and c.expires_at = p_exp)))
    into v;
  return v;
end $$;

-- The (checked_in_at, expires_at) of every anonymous row `viewer` gets at
-- Alpha, sorted: a multiset, to compare two viewers' views.
create function pg_temp.anon_times_at_alpha(viewer text) returns text[] language plpgsql as $$
declare v text[];
begin
  perform pg_temp.as_user(pg_temp.p(viewer));
  select array_agg(x.t order by x.t) into v
    from (select c.checked_in_at::text || '|' || c.expires_at::text as t
            from public.court_presence('test:p1-alpha') c where c.anonymous) x;
  return v;
end $$;

-- Friend notices to p_to about p_from (read past RLS).
create function pg_temp.notices(p_to text, p_from text, p_kind text) returns int
language sql security definer as $$
  select count(*)::int from public.notifications n
   where n.user_id = pg_temp.p(p_to) and n.entity_type = 'friend'
     and n.entity_id = pg_temp.p(p_from) and n.push_data ->> 'kind' = p_kind;
$$;


-- ════ Setup ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data)
select id, 'p1-' || lower(k) || '@pickleague.test',
       jsonb_build_object('full_name', case k
         when 'O' then 'Olive Owner' when 'F' then 'Fran Friend' when 'C' then 'Cleo Close'
         when 'L' then 'Lena League' when 'P' then 'Pat Open' when 'S' then 'Sam Stranger'
         when 'B' then 'Bo Blocked' when 'K' then 'Kit Blocker' when 'G' then 'Gus Guest'
         when 'D' then 'Dee Deleted' when 'N' then 'Ned Partner' when 'AT' then 'Ari Attacker'
         when 'V' then 'Val Victim' when 'J' then 'Jo Joiner' when 'I' then 'Ivy Invited'
         when 'RV' then 'Rae Viewer' when 'RF' then 'Rex Friend' when 'E' then 'Eve Early'
         when 'CM' then 'Cam Curated'
         else 'Player ' || k end)
  from _p where k <> 'U';
-- An unclaimed DUPR placeholder has a profile and no account.
insert into public.profiles (id, username, full_name, gender, is_unclaimed)
values (pg_temp.p('U'), 'p1_unclaimed', 'Una Unclaimed', 'prefer-not-to-say', true);
update public.profiles set is_guest = true, guest_expires_at = now() + interval '1 day' where id = pg_temp.p('G');

insert into public.venues (id, sport, name, kind, lat, lng, source, geofence_radius_m) values
  ('test:p1-alpha',     array['pickleball'], 'P1 Test Courts Alpha', 'court', 40.0,      -100.0, 'google', 100),
  ('test:p1-alpha-osm', array['pickleball'], 'P1 Test Courts Alpha', 'court', 40.00005,  -100.0, 'osm',    100),
  ('test:p1-bravo',     array['pickleball'], 'P1 Test Courts Bravo', 'court', 40.01,     -100.0, 'google', 100),
  ('test:p1-c3',        array['pickleball'], 'P1 Test Courts Three', 'court', 40.03,     -100.0, 'google', 100),
  ('test:p1-c4',        array['pickleball'], 'P1 Test Courts Four',  'court', 40.04,     -100.0, 'google', 100),
  ('test:p1-c5',        array['pickleball'], 'P1 Test Courts Five',  'court', 40.05,     -100.0, 'google', 100),
  ('test:p1-c6',        array['pickleball'], 'P1 Test Courts Six',   'court', 40.06,     -100.0, 'google', 100),
  ('test:p1-delta',     array['pickleball'], 'P1 Test Courts Delta', 'court', 40.07,     -100.0, 'google', 100),
  ('test:p1-hoops',     array['basketball'], 'P1 Test Hoops',        'court', 40.02,     -100.0, 'google', 100);
select public._pl_dedupe_venues('pickleball');

insert into public.leagues (id, name, is_open, created_by) values
  ('b0000000-0000-4000-8000-000000000001', 'P1 Test Closed',  false, pg_temp.p('O')),
  ('b0000000-0000-4000-8000-000000000002', 'P1 Test Open',    true,  pg_temp.p('O')),
  ('b0000000-0000-4000-8000-000000000003', 'P1 Test Trigger', true,  pg_temp.p('N'));
insert into public.league_members (league_id, user_id, role) values
  ('b0000000-0000-4000-8000-000000000001', pg_temp.p('O'), 'admin'),
  ('b0000000-0000-4000-8000-000000000001', pg_temp.p('L'), 'member'),
  ('b0000000-0000-4000-8000-000000000002', pg_temp.p('O'), 'admin'),
  ('b0000000-0000-4000-8000-000000000002', pg_temp.p('P'), 'member')
on conflict do nothing;

insert into public.friendships (requester_id, addressee_id, status, responded_at) values
  (pg_temp.p('O'), pg_temp.p('F'), 'accepted', now()),
  (pg_temp.p('C'), pg_temp.p('O'), 'accepted', now());
insert into public.close_friends (user_id, friend_id) values (pg_temp.p('O'), pg_temp.p('C'));
insert into public.user_blocks (blocker_id, blocked_id) values
  (pg_temp.p('O'), pg_temp.p('B')),
  (pg_temp.p('K'), pg_temp.p('O'));


-- ════ T1 grants ══════════════════════════════════════════════════════════
do $$
declare
  f text;
  v_client text[] := array[
    'public.checkin_venue(uuid,text,integer,text,timestamptz,double precision,double precision,double precision,timestamptz,double precision)',
    -- Phase 1.5 (migration_validity_rules.sql) added the optional check-out fix.
    'public.checkout_venue(uuid,text,timestamptz,double precision,double precision,double precision,double precision)',
    'public.extend_checkin(uuid,timestamptz,double precision,double precision,double precision,timestamptz,double precision)',
    'public.start_play_session(uuid,text,uuid,text,timestamptz,double precision,double precision,double precision,timestamptz,double precision)',
    'public.end_play_session(uuid,timestamptz)',
    'public.resolve_court(double precision,double precision,double precision,text)',
    'public.venue_players_here(text)', 'public.court_presence(text)', 'public.venue_crowd(text[])',
    'public.friends_at_courts(integer)', 'public.get_my_presence_settings()',
    'public.set_presence_settings(text,text,timestamptz,boolean,boolean)',
    'public.hide_presence_from(uuid,boolean)', 'public.list_presence_hidden()',
    'public.set_court_favorite(text,boolean)', 'public.list_my_court_favorites()',
    'public.send_friend_request(uuid)', 'public.respond_friend_request(uuid,boolean)',
    'public.cancel_friend_request(uuid)', 'public.remove_friend(uuid)',
    'public.set_close_friend(uuid,boolean)', 'public.friendship_status_with(uuid)',
    'public.list_my_friends()', 'public.list_friend_requests()', 'public.suggest_friends(integer)',
    'public.delete_my_account()'];
  v_internal text[] := array[
    'public.are_friends(uuid,uuid)', 'public.share_closed_league(uuid,uuid)',
    'public._pl_can_see_presence(uuid,uuid,text)', 'public._pl_presence_viewer_is_guest(uuid)',
    'public._pl_canonical_venue(text)', 'public._pl_dedupe_venues(text)',
    'public._pl_similar_court_names(text,text)',
    'public._pl_match_court(double precision,double precision,text,text,double precision)',
    'public._pl_check_fix(text,double precision,double precision,double precision,timestamptz,double precision)',
    'public._pl_require_fix_shape(double precision,double precision)',
    'public._pl_raise_unconfirmed_fix(boolean,boolean,boolean,double precision,boolean,text)',
    'public._pl_blocked_pair(uuid,uuid)', 'public._league_members_lock_identity()',
    'public._league_members_set_admitted_closed()', 'public._leagues_closed_admit_creator()',
    'public._pl_venue_crowd(uuid,text)', 'public._pl_notify_friend(uuid,uuid,text)',
    'public._pl_display_name(uuid)', 'public._pl_friendable(uuid)', 'public._pl_lock_pair(uuid,uuid)',
    'public._pl_clear_friend_request_notices(uuid,uuid)', 'public._purge_account(uuid)',
    'public.prune_presence_history()', 'public.expire_play_sessions()', 'public.expire_venue_checkins()',
    'public._leagues_sync_home_venue()', 'public._court_locations_sync_venue()',
    'public._user_blocks_presence_teardown()', 'public.backfill_venue_cities()'];
  v_names text[] := array[
    'accept_drill_slot','admin_review_venue','analytics_claim','analytics_touch','cancel_tournament',
    'checkin_venue','checkout_venue','claim_my_dupr_profile','close_event_vote','dismiss_dupr_import',
    'end_play_session','extend_checkin','find_nearby_venue_submissions','import_my_dupr_rating',
    'is_godmode_user','list_admin_venue_reviews','moderator_eject_user','moderator_resolve_report',
    'moderator_take_down_avatar','my_dupr_match','relabel_league_home_court','resolve_venue',
    'respond_drill_request','rsvp_drill_session','search_venues','set_pickleague_time_zone',
    'start_play_session','submit_venue','vote_event_slots','blocked_between','is_expired_guest',
    'is_scope_admin'];
  v_bad text;
begin
  foreach f in array v_client loop
    perform pg_temp.ok('T1 authenticated may execute ' || f,
      to_regprocedure(f) is not null and has_function_privilege('authenticated', f, 'EXECUTE'));
    perform pg_temp.ok('T1 anon may not execute ' || f,
      to_regprocedure(f) is not null and not has_function_privilege('anon', f, 'EXECUTE'));
  end loop;
  foreach f in array v_internal loop
    perform pg_temp.ok('T1 internal, clients may not execute ' || f,
      to_regprocedure(f) is not null
      and not has_function_privilege('authenticated', f, 'EXECUTE')
      and not has_function_privilege('anon', f, 'EXECUTE'));
  end loop;
  -- The hardening file was re-run after the migrations: nothing the app calls went offline.
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef and p.proname = any(v_names)
     and not has_function_privilege('authenticated', p.oid, 'EXECUTE');
  perform pg_temp.ok('T1 hardening re-run keeps the 29 client RPCs + policy helpers executable', v_bad is null, v_bad);
  perform pg_temp.ok('T1 all 32 allowlist additions exist',
    (select count(distinct p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef and p.proname = any(v_names)) = cardinality(v_names));
  perform pg_temp.ok('T1 old 5-arg checkin_venue is gone',
    to_regprocedure('public.checkin_venue(uuid,text,integer,text,timestamptz)') is null);
  perform pg_temp.ok('T1 old 2-arg checkout_venue is gone', to_regprocedure('public.checkout_venue(uuid,text)') is null);
  perform pg_temp.ok('T1 Phase 1 3-arg checkout_venue is gone (Phase 1.5 replaced it)',
    to_regprocedure('public.checkout_venue(uuid,text,timestamptz)') is null);
  perform pg_temp.ok('T1 old 5-arg start_play_session is gone',
    to_regprocedure('public.start_play_session(uuid,text,uuid,text,timestamptz)') is null);
  perform pg_temp.ok('T1 venue_players_here is SECURITY DEFINER',
    (select p.prosecdef from pg_proc p where p.oid = 'public.venue_players_here(text)'::regprocedure));
  -- migration_venue_checkins.sql and migration_play_sessions.sql were re-run
  -- after the presence files: their guards kept every presence version.
  select string_agg(p.proname || ' x' || p.n, ', ') into v_bad
    from (select p.proname, count(*) as n from pg_proc p
           where p.pronamespace = 'public'::regnamespace
             and p.proname in ('checkin_venue', 'checkout_venue', 'extend_checkin', 'start_play_session', 'end_play_session')
           group by p.proname) p
   where p.n <> 1;
  perform pg_temp.ok('T1 re-running the superseded files adds no second overload', v_bad is null, v_bad);
  perform pg_temp.ok('T1 ...and keeps the owner-only read policies',
    (select bool_and(qual ilike '%auth.uid()%') and count(*) = 2 from pg_policies
      where schemaname = 'public' and policyname in ('venue_checkins_read', 'play_sessions_read')));
  perform pg_temp.ok('T1 ...and the presence End / expiry (they close the session''s check-in)',
    (select prosrc like '%presence_closed_ids%' from pg_proc where oid = 'public.end_play_session(uuid,timestamptz)'::regprocedure)
    and (select prosrc like '%venue_checkins%' from pg_proc where oid = 'public.expire_play_sessions()'::regprocedure));
  -- Clients may change a member's role and nothing else (league_members).
  perform pg_temp.ok('T1 league_members: clients may update role only',
    not has_table_privilege('authenticated', 'public.league_members', 'UPDATE')
    and not has_table_privilege('anon', 'public.league_members', 'UPDATE')
    and has_column_privilege('authenticated', 'public.league_members', 'role', 'UPDATE')
    and not has_column_privilege('authenticated', 'public.league_members', 'league_id', 'UPDATE')
    and not has_column_privilege('authenticated', 'public.league_members', 'user_id', 'UPDATE')
    and not has_column_privilege('authenticated', 'public.league_members', 'admitted_closed', 'UPDATE')
    and not has_column_privilege('authenticated', 'public.league_members', 'expires_at', 'UPDATE'));
exception when others then
  perform pg_temp.ok('T1 block crashed', false, sqlerrm);
end $$;


-- ════ T2 duplicate courts, league home courts (live data 2026-10-15) ═════
do $$
begin
  perform pg_temp.ok('T2 no venue deleted', (select count(*) from public.venues) = (select n_venues from _pre) + 9);
  perform pg_temp.ok('T2 test duplicate resolves to the Google row',
    public._pl_canonical_venue('test:p1-alpha-osm') = 'test:p1-alpha');
  perform pg_temp.ok('T2 Pickle Athletics OSM copy -> Google row',
    public._pl_canonical_venue('osm:way/37016795') = 'g:ChIJN4PR9uB9hYARVhLyCfsCXuQ');
  perform pg_temp.ok('T2 Montclair OSM copy -> Google row',
    public._pl_canonical_venue('osm:way/22916669') = 'g:ChIJbRu_MAqHj4ARxpMD4kpXYGg');
  perform pg_temp.ok('T2 OSM per-court rows 1-8 -> one facility',
    public._pl_canonical_venue('osm:way/1419556034') = 'osm:way/1419556027');
  perform pg_temp.ok('T2 PikLab Concord and Indoor Pickleball X stay separate (names differ)',
    public._pl_canonical_venue('osm:node/13879571446') = 'osm:node/13879571446'
    and public._pl_canonical_venue('g:ChIJcWUzMjxnhYARcx2wgmkhhnw') = 'g:ChIJcWUzMjxnhYARcx2wgmkhhnw');
  perform pg_temp.ok('T2 no canonical chains',
    not exists (select 1 from public.venues v join public.venues c on c.id = v.canonical_id where c.canonical_id is not null));
  perform pg_temp.ok('T2 re-running the dedupe changes nothing', public._pl_dedupe_venues('pickleball') = 0);
  perform pg_temp.ok('T2 Bladium leagues and Hub 4.5+ -> The Hub Sports Club - Alameda',
    (select bool_and(home_venue_id = 'g:ChIJo2-kG7CBj4ARoopbGC-os-s') from public.leagues
      where id in ('6228dce2-37c4-42bb-93d4-2593bf94cab3', '07996d06-e652-4cc7-b577-4146aab17b70',
                   'a24adaef-0fe4-4ee7-b939-a8b0d553adc9')));
  perform pg_temp.ok('T2 Crocker-Amazon -> Crocker Amazon Pickleball Courts (name match, 752 m)',
    (select home_venue_id from public.leagues where id = '53dd4e97-1acc-4670-9bab-3c2862dbcfe9')
      = 'g:ChIJ5wbTIQB_j4AR36lRFNb1Jgg');
  perform pg_temp.ok('T2 Bay Meadows court location stays unresolved (nearest pickleball row is 246 m)',
    (select venue_id from public.court_locations where id = 'beedfe95-a599-48a5-a271-4f73f2832495') is null);
  perform pg_temp.ok('T2 Bladium court location (nickname The HUB Alameda) -> The Hub',
    (select venue_id from public.court_locations where id = '572bf625-073a-4878-b62e-eb6cf493aec6')
      = 'g:ChIJo2-kG7CBj4ARoopbGC-os-s');

  -- A 1.0.4 app edits the home court by name and coordinates only.
  update public.leagues set home_court = 'P1 Test Courts Alpha', home_court_lat = 40.00004, home_court_lng = -100.0
   where id = 'b0000000-0000-4000-8000-000000000003';
  perform pg_temp.ok('T2 home court edit by coordinates re-resolves home_venue_id',
    (select home_venue_id from public.leagues where id = 'b0000000-0000-4000-8000-000000000003') = 'test:p1-alpha');
  -- A new app picks the court itself (here a duplicate row): stored canonical.
  update public.leagues set home_venue_id = 'test:p1-alpha-osm', home_court_lat = 40.01, home_court_lng = -100.0
   where id = 'b0000000-0000-4000-8000-000000000003';
  perform pg_temp.ok('T2 a picked home court is stored canonical and wins over coordinates',
    (select home_venue_id from public.leagues where id = 'b0000000-0000-4000-8000-000000000003') = 'test:p1-alpha');

  -- 1.0.4 builds its arrival fences from resolve_venue: it answers the
  -- canonical row now, so its fences and check-ins key on the stored id.
  perform pg_temp.ok('T2 resolve_venue at a duplicate answers the canonical row',
    (select public.resolve_venue(v.lat, v.lng, 200) ->> 'id' from public.venues v where v.id = 'osm:way/22916669')
      = 'g:ChIJbRu_MAqHj4ARxpMD4kpXYGg'
    and (select (public.resolve_venue(v.lat, v.lng, 200) ->> 'distance_meters')::numeric from public.venues v
          where v.id = 'osm:way/22916669') = 0
    and public.resolve_venue(40.00005, -100.0, 200) ->> 'id' = 'test:p1-alpha');

  -- A bare pitch label between two differently named facilities joins one of
  -- them at most, and never merges the two (also through a chain of labels).
  insert into public.venues (id, sport, name, kind, lat, lng, source, geofence_radius_m) values
    ('test:p1-x-club', array['pickleball'], 'Lakeside Racquet Club',  'court', 40.10,      -100.10, 'google', 100),
    ('test:p1-x-park', array['pickleball'], 'Rotary Park Pickleball', 'court', 40.100603,  -100.10, 'google', 100),
    ('test:p1-x-3',    array['pickleball'], '3',                      'court', 40.1003015, -100.10, 'osm',    100),
    ('test:p1-y-club', array['pickleball'], 'Harbor Tennis Club',     'court', 40.12,      -100.10, 'google', 100),
    ('test:p1-y-park', array['pickleball'], 'Elm Grove Courts',       'court', 40.1209,    -100.10, 'google', 100),
    ('test:p1-y-1',    array['pickleball'], 'Court 1',                'court', 40.1203,    -100.10, 'osm',    100),
    ('test:p1-y-2',    array['pickleball'], 'Court 2',                'court', 40.1206,    -100.10, 'osm',    100),
    ('test:p1-z-park', array['pickleball'], 'Birch Park Pickleball',  'court', 40.14,      -100.10, 'google', 100),
    ('test:p1-z-1',    array['pickleball'], '1',                      'court', 40.1403,    -100.10, 'osm',    100),
    ('test:p1-z-2',    array['pickleball'], '2',                      'court', 40.1406,    -100.10, 'osm',    100),
    ('test:p1-z-3',    array['pickleball'], '3',                      'court', 40.1409,    -100.10, 'osm',    100);
  perform public._pl_dedupe_venues('pickleball');
  perform pg_temp.ok('T2 a pitch between two facilities does not merge them',
    public._pl_canonical_venue('test:p1-x-club') = 'test:p1-x-club'
    and public._pl_canonical_venue('test:p1-x-park') = 'test:p1-x-park'
    and public._pl_canonical_venue('test:p1-x-3') in ('test:p1-x-club', 'test:p1-x-park'));
  perform pg_temp.ok('T2 ...nor does a chain of two pitches',
    public._pl_canonical_venue('test:p1-y-club') = 'test:p1-y-club'
    and public._pl_canonical_venue('test:p1-y-park') = 'test:p1-y-park'
    and public._pl_canonical_venue('test:p1-y-1') = public._pl_canonical_venue('test:p1-y-2'));
  perform pg_temp.ok('T2 a row of numbered courts joins the one named court beside it',
    (select bool_and(public._pl_canonical_venue(id) = 'test:p1-z-park') from public.venues
      where id in ('test:p1-z-1', 'test:p1-z-2', 'test:p1-z-3')));
  perform pg_temp.ok('T2 after the bridge cases: re-running changes nothing, no chains',
    public._pl_dedupe_venues('pickleball') = 0
    and not exists (select 1 from public.venues v join public.venues c on c.id = v.canonical_id
                     where c.canonical_id is not null));
exception when others then
  perform pg_temp.ok('T2 block crashed', false, sqlerrm);
end $$;


-- ════ T3 check-ins: confirmed, private, quiet, checkout time ═════════════
do $$
declare
  o  uuid := pg_temp.p('O');
  r  public.venue_checkins;
  n  int;
begin
  -- 1.0.4: no fix -> private row.
  perform pg_temp.as_user(o);
  select * into r from public.checkin_venue(p_id => 'c0000000-0000-4000-8000-000000000001',
    p_venue => 'test:p1-alpha', p_minutes => 120, p_source => 'manual', p_at => null);
  perform pg_temp.ok('T3 1.0.4 check-in without a fix is stored unconfirmed', not r.location_confirmed, r::text);
  select count(*) into n from public.venue_players_here('test:p1-alpha');
  perform pg_temp.ok('T3 owner still sees their own private row', n = 1, n::text);
  perform pg_temp.as_user(pg_temp.p('S'));
  select count(*) into n from public.venue_players_here('test:p1-alpha');
  perform pg_temp.ok('T3 private row hidden from others (venue_players_here)', n = 0, n::text);
  select count(*) into n from public.court_presence('test:p1-alpha');
  perform pg_temp.ok('T3 private row hidden from others (court_presence)', n = 0, n::text);
  select c.here_now into n from public.venue_crowd(array['test:p1-alpha']) c;
  perform pg_temp.ok('T3 private row counted nowhere (venue_crowd)', n = 0, n::text);

  -- A fix too far away, a stale fix, half a fix.
  perform pg_temp.as_user(o);
  begin
    perform public.checkin_venue(p_id => 'c0000000-0000-4000-8000-000000000002', p_venue => 'test:p1-alpha',
      p_lat => 40.003, p_lng => -100.0, p_accuracy_m => 10, p_fix_at => now());
    perform pg_temp.ok('T3 fix too far raises', false, 'no error');
  exception when others then
    perform pg_temp.ok('T3 fix too far raises', sqlerrm = 'You need to be at the court to check in (about 328 m away).', sqlerrm);
  end;
  begin
    perform public.checkin_venue(p_id => 'c0000000-0000-4000-8000-000000000002', p_venue => 'test:p1-alpha',
      p_lat => 40.0001, p_lng => -100.0, p_accuracy_m => 10, p_fix_at => now() - interval '5 minutes');
    perform pg_temp.ok('T3 stale fix raises', false, 'no error');
  exception when others then
    perform pg_temp.ok('T3 stale fix raises', sqlerrm like 'Your location is out of date%', sqlerrm);
  end;
  begin
    perform public.checkin_venue(p_id => 'c0000000-0000-4000-8000-000000000002', p_venue => 'test:p1-alpha',
      p_lat => 40.0001, p_lng => null, p_accuracy_m => 10, p_fix_at => now());
    perform pg_temp.ok('T3 half a fix raises', false, 'no error');
  exception when others then
    perform pg_temp.ok('T3 half a fix raises', sqlerrm like 'Your location didn''t come through%', sqlerrm);
  end;
  perform pg_temp.ok('T3 failed check-ins stored nothing',
    not exists (select 1 from public.venue_checkins where id = 'c0000000-0000-4000-8000-000000000002'));

  -- Confirmed, at the duplicate row's id, queued 30 minutes ago.
  select * into r from public.checkin_venue(p_id => 'c0000000-0000-4000-8000-000000000003',
    p_venue => 'test:p1-alpha-osm', p_minutes => 120, p_source => 'manual', p_at => now() - interval '30 minutes',
    p_lat => 40.0001, p_lng => -100.0, p_accuracy_m => 10, p_fix_at => now());
  perform pg_temp.ok('T3 confirmed check-in stores the canonical court and the fix',
    r.id = 'c0000000-0000-4000-8000-000000000003' and r.venue_id = 'test:p1-alpha' and r.location_confirmed
    and r.fix_distance_m between 5 and 6 and r.fix_accuracy_m = 10
    and r.checked_in_at = now() - interval '30 minutes' and r.expires_at = now() + interval '90 minutes', r::text);
  perform pg_temp.ok('T3 the private row was closed',
    (select checked_out_at is not null from public.venue_checkins where id = 'c0000000-0000-4000-8000-000000000001'));

  -- Second check-in at the same court: quiet.
  select * into r from public.checkin_venue(p_id => 'c0000000-0000-4000-8000-000000000004',
    p_venue => 'test:p1-alpha', p_minutes => 240, p_source => 'manual', p_at => null,
    p_lat => 40.0001, p_lng => -100.0, p_accuracy_m => 10, p_fix_at => now());
  perform pg_temp.ok('T3 second check-in at the same court returns the open row, extended',
    r.id = 'c0000000-0000-4000-8000-000000000003' and r.expires_at = now() + interval '240 minutes'
    and r.checked_out_at is null, r::text);
  select count(*) into n from public.venue_checkins where user_id = o;
  perform pg_temp.ok('T3 ...and adds no row', n = 2, n::text);
  select * into r from public.checkin_venue(p_id => 'c0000000-0000-4000-8000-000000000005',
    p_venue => 'test:p1-alpha', p_minutes => 120, p_source => 'manual', p_at => null);
  perform pg_temp.ok('T3 a 1.0.4 call at the same court returns the confirmed row unchanged',
    r.id = 'c0000000-0000-4000-8000-000000000003' and r.location_confirmed
    and r.expires_at = now() + interval '240 minutes', r::text);

  -- Check out with an id the server never stored (1.0.4 kept its own), at the real time.
  select public.checkout_venue(p_id => 'c0000000-0000-4000-8000-000000000004', p_source => null,
    p_at => now() - interval '10 minutes') into n;
  perform pg_temp.ok('T3 checkout with an unknown id closes my open row', n = 1, n::text);
  perform pg_temp.ok('T3 checkout records p_at',
    (select checked_out_at from public.venue_checkins where id = 'c0000000-0000-4000-8000-000000000003')
      = now() - interval '10 minutes');
  select public.checkout_venue(p_id => 'c0000000-0000-4000-8000-000000000003', p_source => null, p_at => now()) into n;
  perform pg_temp.ok('T3 checkout replay is a no-op', n = 0, n::text);
  begin
    perform public.extend_checkin('c0000000-0000-4000-8000-000000000003', now() + interval '1 hour');
    perform pg_temp.ok('T3 extending a closed check-in raises', false, 'no error');
  exception when others then
    perform pg_temp.ok('T3 extending a closed check-in raises', sqlerrm = 'Check-in is no longer open', sqlerrm);
  end;

  -- p_source is a filter (a geofence exit never closes a manual check-in); 'signout' is not.
  perform pg_temp.checkin('O', 'c0000000-0000-4000-8000-000000000006');
  select public.checkout_venue(p_id => 'c0000000-0000-4000-8000-000000000006', p_source => 'geofence') into n;
  perform pg_temp.ok('T3 geofence checkout leaves a manual check-in open', n = 0, n::text);
  select public.checkout_venue(null, 'signout', now()) into n;
  perform pg_temp.ok('T3 sign-out checkout closes everything', n = 1, n::text);

  -- extend_checkin with an unknown id extends my open row.
  perform pg_temp.checkin('O', 'c0000000-0000-4000-8000-000000000007');
  select * into r from public.extend_checkin('c0000000-0000-4000-8000-000000000008', now() + interval '3 hours');
  perform pg_temp.ok('T3 extend with an unknown id extends my open row',
    r.id = 'c0000000-0000-4000-8000-000000000007' and r.expires_at = now() + interval '3 hours', r::text);
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.ok('T3 block crashed', false, sqlerrm);
end $$;


-- ════ T4 sessions check you in ═══════════════════════════════════════════
do $$
declare
  s  public.play_sessions;
  c  public.venue_checkins;
  n  int;
begin
  perform pg_temp.as_user(pg_temp.p('F'));
  select * into s from public.start_play_session(p_id => 'e0000000-0000-4000-8000-000000000001',
    p_kind => 'open_play', p_source => null, p_venue => 'test:p1-alpha-osm', p_at => null,
    p_lat => 40.0001, p_lng => -100.0, p_accuracy_m => 10, p_fix_at => now());
  select * into c from public.venue_checkins where id = 'e0000000-0000-4000-8000-000000000001';
  perform pg_temp.ok('T4 a session at a court opens a session check-in (same id, 180 min)',
    s.venue_id = 'test:p1-alpha' and c.source = 'session' and c.location_confirmed
    and c.venue_id = 'test:p1-alpha' and c.expires_at = now() + interval '180 minutes', c::text);
  select public.end_play_session('e0000000-0000-4000-8000-000000000001', now()) into n;
  perform pg_temp.ok('T4 ending the session closes its check-in',
    n = 1 and (select checked_out_at is not null from public.venue_checkins
                where id = 'e0000000-0000-4000-8000-000000000001'));

  -- Adopt: an open confirmed check-in stays, covering the session.
  perform pg_temp.checkin('F', 'c0000000-0000-4000-8000-000000000021');
  select * into s from public.start_play_session(p_id => 'e0000000-0000-4000-8000-000000000002',
    p_kind => 'drill', p_source => null, p_venue => 'test:p1-alpha', p_at => null);
  perform pg_temp.ok('T4 a session adopts my check-in instead of adding one',
    not exists (select 1 from public.venue_checkins where id = 'e0000000-0000-4000-8000-000000000002')
    and (select expires_at from public.venue_checkins where id = 'c0000000-0000-4000-8000-000000000021')
          = now() + interval '180 minutes');
  perform public.end_play_session('e0000000-0000-4000-8000-000000000002', now());
  perform pg_temp.ok('T4 ending the session leaves the adopted check-in open',
    (select checked_out_at is null from public.venue_checkins where id = 'c0000000-0000-4000-8000-000000000021'));

  -- Replacing a session closes the check-in it opened.
  perform public.checkout_venue(null, null, now());
  perform public.start_play_session(p_id => 'e0000000-0000-4000-8000-000000000003', p_kind => 'open_play',
    p_venue => 'test:p1-alpha', p_lat => 40.0001, p_lng => -100.0, p_accuracy_m => 10, p_fix_at => now());
  perform public.start_play_session(p_id => 'e0000000-0000-4000-8000-000000000004', p_kind => 'open_play');
  perform pg_temp.ok('T4 starting a new session closes the previous session and its check-in',
    (select ended_at is not null from public.play_sessions where id = 'e0000000-0000-4000-8000-000000000003')
    and (select checked_out_at is not null from public.venue_checkins where id = 'e0000000-0000-4000-8000-000000000003'));
  perform public.end_play_session('e0000000-0000-4000-8000-000000000004', now());

  -- A session without a confirming fix runs untracked, no error.
  perform pg_temp.as_user(pg_temp.p('S'));
  select * into s from public.start_play_session(p_id => 'e0000000-0000-4000-8000-000000000005',
    p_kind => 'open_play', p_venue => 'test:p1-alpha', p_lat => 40.003, p_lng => -100.0,
    p_accuracy_m => 10, p_fix_at => now());
  perform pg_temp.ok('T4 a session with a far fix starts without a check-in',
    s.id = 'e0000000-0000-4000-8000-000000000005'
    and not exists (select 1 from public.venue_checkins where id = 'e0000000-0000-4000-8000-000000000005'));
  perform public.end_play_session('e0000000-0000-4000-8000-000000000005', now());

  -- The 1.0.4 call shape still resolves.
  select * into s from public.start_play_session(p_id => 'e0000000-0000-4000-8000-000000000006',
    p_kind => 'open_play', p_source => null, p_venue => null, p_at => null);
  perform pg_temp.ok('T4 1.0.4 start_play_session call still works', s.id = 'e0000000-0000-4000-8000-000000000006');
  perform public.end_play_session(p_id => 'e0000000-0000-4000-8000-000000000006', p_at => null);
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.ok('T4 block crashed', false, sqlerrm);
end $$;


-- ════ T7 court favorites (before T5: Home reads them) ════════════════════
do $$
declare
  v boolean;
  n int;
begin
  perform pg_temp.as_user(pg_temp.p('O'));
  v := public.set_court_favorite('test:p1-alpha-osm', true);
  perform pg_temp.ok('T7 a favorite is stored canonical',
    v and (select array_agg(venue_id) from public.court_favorites) = array['test:p1-alpha']);
  perform public.set_court_favorite('test:p1-bravo', true);
  perform public.set_court_favorite('test:p1-c3', true);
  perform public.set_court_favorite('test:p1-c4', true);
  perform public.set_court_favorite('test:p1-c5', true);
  begin
    perform public.set_court_favorite('test:p1-c6', true);
    perform pg_temp.ok('T7 a 6th favorite raises', false, 'no error');
  exception when others then
    perform pg_temp.ok('T7 a 6th favorite raises', sqlerrm like 'You can star up to 5 courts%', sqlerrm);
  end;
  perform pg_temp.ok('T7 re-starring a favorite at the cap is fine', public.set_court_favorite('test:p1-alpha', true));
  select count(*) into n from public.list_my_court_favorites();
  perform pg_temp.ok('T7 list shows 5, Alpha first',
    n = 5 and (select venue_id from public.list_my_court_favorites() limit 1) = 'test:p1-alpha', n::text);
  v := public.set_court_favorite('test:p1-c5', false);
  select count(*) into n from public.list_my_court_favorites();
  perform pg_temp.ok('T7 unstar', not v and n = 4, n::text);
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.ok('T7 block crashed', false, sqlerrm);
end $$;


-- ════ T5 who sees whom at the court ══════════════════════════════════════
-- Everyone checks in at Alpha (O already is). B is blocked by O and K blocks
-- O. R1 and R2 are rated (have played); R3 is rated mid-test.
do $$
declare
  k text;
  i int := 0;
begin
  foreach k in array array['F','C','L','P','S','B','K','G','R1','R2','R3'] loop
    i := i + 1;
    perform pg_temp.checkin(k, ('c0000000-0000-4000-8000-0000000001' || lpad(to_hex(i), 2, '0'))::uuid,
      case when i % 2 = 0 then 'test:p1-alpha-osm' else 'test:p1-alpha' end);
  end loop;
  perform pg_temp.as_admin();
  update public.profiles set total_matches_played = 5, doubles_rating = 3.0 where id = pg_temp.p('R1');
  update public.profiles set total_matches_played = 5, doubles_rating = 3.5 where id = pg_temp.p('R2');
exception when others then
  perform pg_temp.ok('T5 setup crashed', false, sqlerrm);
end $$;

do $$
declare
  n   int;
  na  int;
  v   boolean;
  r   record;
  j   jsonb;
  ids uuid[];
  ids2 uuid[];
  x   public.venue_checkins;
  ts  text[];
begin
  -- The owner's view. B (blocked by O) and K (blocks O) are invisible to O,
  -- and O to them: not shown, not counted.
  perform pg_temp.as_user(pg_temp.p('O'));
  select count(*), count(*) filter (where c.anonymous) into n, na from public.court_presence('test:p1-alpha') c;
  perform pg_temp.ok('T5 O sees 10 (the blocked pair B and K left out), 6 anonymous', n = 10 and na = 6, n || '/' || na);
  perform pg_temp.ok('T5 O sees their own row first',
    (select c.user_id from public.court_presence('test:p1-alpha') c limit 1) = pg_temp.p('O'));
  select * into r from public.court_presence('test:p1-alpha') c where c.user_id = pg_temp.p('F');
  perform pg_temp.ok('T5 friend: named, is_friend', r.user_id is not null and not r.anonymous and r.is_friend
    and not r.is_close_friend and r.full_name = 'Fran Friend', r::text);
  select * into r from public.court_presence('test:p1-alpha') c where c.user_id = pg_temp.p('C');
  perform pg_temp.ok('T5 close friend: is_close_friend', r.is_close_friend and r.is_friend, r::text);
  select * into r from public.court_presence('test:p1-alpha') c where c.user_id = pg_temp.p('L');
  perform pg_temp.ok('T5 closed-league mate: named, not a friend', r.user_id is not null and not r.is_friend, r::text);
  perform pg_temp.ok('T5 open-league mate, stranger, guest: not named',
    not exists (select 1 from public.court_presence('test:p1-alpha') c
                 where c.user_id in (pg_temp.p('P'), pg_temp.p('S'), pg_temp.p('G'))));
  perform pg_temp.ok('T5 anonymous rows carry no ids, name or rating',
    not exists (select 1 from public.court_presence('test:p1-alpha') c
                 where c.anonymous and (c.user_id is not null or c.full_name is not null or c.doubles_rating is not null
                                        or c.avatar_url is not null or c.is_friend or c.is_close_friend)));
  select count(*) into n from public.venue_players_here('test:p1-alpha-osm');
  perform pg_temp.ok('T5 venue_players_here by a duplicate id finds the facility', n = 10, n::text);
  perform pg_temp.ok('T5 1.0.4 anonymous rows: null ids/names/ratings, hour-rounded times',
    (select count(*) from public.venue_players_here('test:p1-alpha') vp where vp.user_id is null) = 6
    and not exists (select 1 from public.venue_players_here('test:p1-alpha') vp
                     where vp.user_id is null
                       and (vp.full_name is not null or vp.avatar_url is not null or vp.rating is not null
                            or vp.doubles_rating is not null
                            or vp.checked_in_at <> date_trunc('hour', vp.checked_in_at)
                            or vp.expires_at <> date_trunc('hour', vp.expires_at))));
  -- Anonymous ids: random on every call, never a real check-in id or the old
  -- md5(id || viewer) anyone who saw the named row could recompute.
  select array_agg(vp.checkin_id) into ids from public.venue_players_here('test:p1-alpha') vp where vp.user_id is null;
  select array_agg(c.checkin_id) into ids2 from public.court_presence('test:p1-alpha') c where c.anonymous;
  perform pg_temp.as_admin();
  perform pg_temp.ok('T5 anonymous ids are random: unique, never a real id or md5(id || viewer), new each call',
    cardinality(ids) = 6 and (select count(distinct u) from unnest(ids) u) = 6
    and not exists (select 1 from public.venue_checkins c, unnest(ids || ids2) u
                     where u = c.id or u = md5(c.id::text || pg_temp.p('O')::text)::uuid)
    and not (ids && ids2));
  perform pg_temp.as_user(pg_temp.p('O'));
  select count(*) into n from public.venue_crowd(array['test:p1-alpha', 'test:p1-alpha-osm', 'test:nope']) c
   where c.here_now = 10 and c.friends_here = 2 and c.band_low is null;
  perform pg_temp.ok('T5 crowd: 10 here (blocked pair not counted), 2 friends, no band with 2 rated; both ids answer, unknown skipped', n = 2, n::text);
  perform pg_temp.as_admin();
  update public.profiles set total_matches_played = 5, doubles_rating = 4.0 where id = pg_temp.p('R3');
  perform pg_temp.as_user(pg_temp.p('O'));
  select * into r from public.venue_crowd(array['test:p1-alpha']) c;
  perform pg_temp.ok('T5 band appears with 3 rated: 3.25-3.75', r.band_low = 3.25 and r.band_high = 3.75, r::text);
  begin
    perform public.venue_crowd((select array_agg('v' || g) from generate_series(1, 51) g));
    perform pg_temp.ok('T5 more than 50 courts raises', false, 'no error');
  exception when others then
    perform pg_temp.ok('T5 more than 50 courts raises', sqlerrm like 'At most 50%', sqlerrm);
  end;

  -- Other viewers.
  n := pg_temp.rows_at_alpha('S');
  select count(*) into na from public.court_presence('test:p1-alpha') c where not c.anonymous;
  perform pg_temp.ok('T5 stranger sees all 12, only themself by name', n = 12 and na = 1, n || '/' || na);
  perform pg_temp.ok('T5 stranger: anonymous rows carry hour-rounded times and no session',
    not exists (select 1 from public.court_presence('test:p1-alpha') c
                 where c.anonymous
                   and (c.checked_in_at <> date_trunc('hour', c.checked_in_at)
                        or c.expires_at <> date_trunc('hour', c.expires_at)
                        or c.via_session or c.session_kind is not null)));
  select c.here_now, c.friends_here into n, na from public.venue_crowd(array['test:p1-alpha']) c;
  perform pg_temp.ok('T5 stranger crowd: 12 here, 0 friends', n = 12 and na = 0, n || '/' || na);
  -- A blocked pair sees nothing of each other: no row, no count.
  n := pg_temp.rows_at_alpha('B');
  perform pg_temp.ok('T5 the user O blocked gets no row for O (11 rows)',
    n = 11 and not pg_temp.sees('B', 'O'), n::text);
  perform pg_temp.as_user(pg_temp.p('B'));
  select c.here_now into n from public.venue_crowd(array['test:p1-alpha']) c;
  perform pg_temp.ok('T5 ...and does not count O (11)', n = 11, n::text);
  perform pg_temp.as_user(pg_temp.p('B'));
  select count(*) into n from public.venue_players_here('test:p1-alpha');
  perform pg_temp.ok('T5 ...nor in the 1.0.4 roster (11)', n = 11, n::text);
  n := pg_temp.rows_at_alpha('K');
  perform pg_temp.ok('T5 the user who blocked O gets no row for O either (11)', n = 11 and not pg_temp.sees('K', 'O'), n::text);
  perform pg_temp.as_user(pg_temp.p('K'));
  select c.here_now into n from public.venue_crowd(array['test:p1-alpha']) c;
  perform pg_temp.ok('T5 ...and does not count O (11)', n = 11, n::text);
  -- Guests get counts only: no rows but their own, in both rosters.
  n := pg_temp.rows_at_alpha('G');
  select count(*) into na from public.court_presence('test:p1-alpha') c where c.user_id = pg_temp.p('G');
  perform pg_temp.ok('T5 guest gets only their own row', n = 1 and na = 1, n || '/' || na);
  perform pg_temp.as_user(pg_temp.p('G'));
  select count(*) into n from public.venue_players_here('test:p1-alpha') vp where vp.user_id is distinct from pg_temp.p('G');
  perform pg_temp.ok('T5 guest: no other rows in the 1.0.4 roster', n = 0, n::text);
  perform pg_temp.as_user(pg_temp.p('G'));
  select c.here_now into n from public.venue_crowd(array['test:p1-alpha']) c;
  perform pg_temp.ok('T5 guest still sees the count (12)', n = 12, n::text);
  perform pg_temp.ok('T5 closed-league mate sees O by name', pg_temp.sees('L', 'O'));
  perform pg_temp.ok('T5 open-league mate does not', not pg_temp.sees('P', 'O'));
  perform pg_temp.ok('T5 friend sees O by name', pg_temp.sees('F', 'O'));
  perform pg_temp.ok('T5 a friend of O does not see O''s other friend C', not pg_temp.sees('F', 'C'));

  -- Levels, pause, hide-from.
  perform pg_temp.as_user(pg_temp.p('O'));
  j := public.set_presence_settings('everyone');
  perform pg_temp.ok('T5 set everyone', j ->> 'checkins_level' = 'everyone', j::text);
  perform pg_temp.ok('T5 everyone: stranger sees O', pg_temp.sees('S', 'O'));
  perform pg_temp.ok('T5 everyone: guest still does not', not pg_temp.sees('G', 'O'));
  perform pg_temp.ok('T5 everyone: the blocked user still does not see O by name',
    not pg_temp.sees('B', 'O') and pg_temp.rows_at_alpha('B') = 11);
  perform pg_temp.as_user(pg_temp.p('O'));
  perform public.set_presence_settings('friends');
  perform pg_temp.ok('T5 friends: league mate loses O', not pg_temp.sees('L', 'O'));
  perform pg_temp.ok('T5 friends: friend keeps O', pg_temp.sees('F', 'O'));
  perform pg_temp.as_user(pg_temp.p('O'));
  perform public.set_presence_settings('hidden');
  perform pg_temp.ok('T5 hidden: friend loses O', not pg_temp.sees('F', 'O'));
  select c.here_now into n from public.venue_crowd(array['test:p1-alpha']) c;
  perform pg_temp.ok('T5 hidden: O still counts in the friend''s crowd (12)', n = 12, n::text);
  perform pg_temp.as_user(pg_temp.p('O'));
  j := public.set_presence_settings('leaguemates', null, now() + interval '1 hour');
  perform pg_temp.ok('T5 pause stored', j ->> 'checkins_level' = 'leaguemates' and j ->> 'paused_until' is not null, j::text);
  v := pg_temp.sees('F', 'O');
  n := pg_temp.rows_at_alpha('F');
  perform pg_temp.ok('T5 paused: the friend sees O anonymously', not v and n = 12, n::text);
  perform pg_temp.as_user(pg_temp.p('O'));
  j := public.set_presence_settings(p_clear_pause => true);
  perform pg_temp.ok('T5 pause cleared', j ->> 'paused_until' is null and pg_temp.sees('F', 'O'), j::text);
  perform pg_temp.as_user(pg_temp.p('O'));
  perform pg_temp.ok('T5 hide from F', public.hide_presence_from(pg_temp.p('F'), true));
  perform pg_temp.ok('T5 hidden-from friend sees O anonymously', not pg_temp.sees('F', 'O'));
  perform pg_temp.ok('T5 ...the close friend still sees O', pg_temp.sees('C', 'O'));
  perform pg_temp.as_user(pg_temp.p('O'));
  perform pg_temp.ok('T5 list_presence_hidden shows F',
    (select array_agg(h.user_id) from public.list_presence_hidden() h) = array[pg_temp.p('F')]);
  v := public.hide_presence_from(pg_temp.p('F'), false);
  perform pg_temp.ok('T5 unhide', not v and pg_temp.sees('F', 'O'));

  -- A hide-from or a pause can't be undone by linking: F saw O's named row
  -- (its id, its exact times); afterwards no anonymous row carries any of it.
  perform pg_temp.as_user(pg_temp.p('F'));
  select c.checkin_id, c.checked_in_at, c.expires_at into r
    from public.court_presence('test:p1-alpha') c where c.user_id = pg_temp.p('O');
  perform pg_temp.as_user(pg_temp.p('O'));
  perform public.hide_presence_from(pg_temp.p('F'), true);
  perform pg_temp.ok('T5 after a hide-from, no anonymous row links back to O''s named row',
    r.checkin_id is not null and not pg_temp.sees('F', 'O')
    and not pg_temp.links_back('F', r.checkin_id, r.checked_in_at, r.expires_at), r::text);
  perform pg_temp.as_user(pg_temp.p('O'));
  perform public.hide_presence_from(pg_temp.p('F'), false);
  perform public.set_presence_settings(p_paused_until => now() + interval '2 hours');
  perform pg_temp.ok('T5 after a pause, no anonymous row links back either (friend or league-mate)',
    not pg_temp.sees('F', 'O') and not pg_temp.links_back('F', r.checkin_id, r.checked_in_at, r.expires_at)
    and not pg_temp.sees('L', 'O') and not pg_temp.links_back('L', r.checkin_id, r.checked_in_at, r.expires_at));
  perform pg_temp.as_user(pg_temp.p('O'));
  perform public.set_presence_settings(p_clear_pause => true);

  -- Session fields ride named rows only.
  perform pg_temp.as_user(pg_temp.p('C'));
  perform public.start_play_session(p_id => 'e0000000-0000-4000-8000-000000000101', p_kind => 'drill',
    p_venue => 'test:p1-alpha');
  perform pg_temp.as_user(pg_temp.p('O'));
  perform pg_temp.ok('T5 a friend''s session shows on their named row',
    exists (select 1 from public.court_presence('test:p1-alpha') c
             where c.user_id = pg_temp.p('C') and c.via_session and c.session_kind = 'drill'));
  perform pg_temp.as_user(pg_temp.p('S'));
  perform pg_temp.ok('T5 ...and never on an anonymous row',
    not exists (select 1 from public.court_presence('test:p1-alpha') c
                 where c.anonymous and (c.via_session or c.session_kind is not null)));
  perform pg_temp.as_user(pg_temp.p('C'));
  perform public.end_play_session('e0000000-0000-4000-8000-000000000101', now());
  perform pg_temp.as_user(pg_temp.p('O'));
  begin
    perform public.set_presence_settings('strangers');
    perform pg_temp.ok('T5 bad level raises', false, 'no error');
  exception when others then
    perform pg_temp.ok('T5 bad level raises', sqlerrm = 'Pick who can see you at the courts', sqlerrm);
  end;
  j := public.set_presence_settings(p_consent_seen => true);
  perform pg_temp.ok('T5 consent stamped once',
    j ->> 'consent_seen_at' is not null
    and (public.set_presence_settings(p_consent_seen => true) ->> 'consent_seen_at') = j ->> 'consent_seen_at', j::text);
  perform pg_temp.as_user(pg_temp.p('R1'));
  j := public.get_my_presence_settings();
  perform pg_temp.ok('T5 defaults without a row',
    j = jsonb_build_object('checkins_level', 'leaguemates', 'plans_level', 'friends', 'paused_until', null,
                           'consent_seen_at', null, 'auto_checkin', false), j::text);

  -- Home: friends at the courts.
  perform pg_temp.as_user(pg_temp.p('O'));
  j := public.friends_at_courts();
  perform pg_temp.ok('T5 O friends_at_courts: one court, F C L by name, 6 others',
    jsonb_array_length(j -> 'now') = 1
    and j -> 'now' -> 0 ->> 'venue_id' = 'test:p1-alpha'
    and jsonb_array_length(j -> 'now' -> 0 -> 'people') = 3
    and (j -> 'now' -> 0 ->> 'others_here')::int = 6
    and (select bool_and((pp ->> 'user_id')::uuid in (pg_temp.p('F'), pg_temp.p('C'), pg_temp.p('L')))
           from jsonb_array_elements(j -> 'now' -> 0 -> 'people') pp), j::text);
  perform pg_temp.ok('T5 the close friend is starred',
    exists (select 1 from jsonb_array_elements(j -> 'now' -> 0 -> 'people') pp
             where (pp ->> 'user_id')::uuid = pg_temp.p('C') and (pp ->> 'is_close_friend')::boolean));
  perform pg_temp.ok('T5 your courts: every favorite (O has 4), oldest first, with the crowd',
    jsonb_array_length(j -> 'courts') = 4
    and (select bool_and(c ->> 'reason' = 'favorite') from jsonb_array_elements(j -> 'courts') c)
    and j -> 'courts' -> 0 ->> 'venue_id' = 'test:p1-alpha'
    and (j -> 'courts' -> 0 ->> 'here_now')::int = 10 and (j -> 'courts' -> 0 ->> 'friends_here')::int = 2,
    (j -> 'courts')::text);
  perform public.set_court_favorite('test:p1-c5', true);
  j := public.friends_at_courts();
  perform pg_temp.ok('T5 your courts: a 5th star shows too (the newest)',
    jsonb_array_length(j -> 'courts') = 5
    and exists (select 1 from jsonb_array_elements(j -> 'courts') c where c ->> 'venue_id' = 'test:p1-c5'),
    (j -> 'courts')::text);
  perform pg_temp.as_user(pg_temp.p('F'));
  j := public.friends_at_courts();
  perform pg_temp.ok('T5 your courts: no favorites, so the fill to 3 (F: one frequent court)',
    jsonb_array_length(j -> 'courts') = 1 and j -> 'courts' -> 0 ->> 'reason' = 'frequent', (j -> 'courts')::text);
  perform pg_temp.as_user(pg_temp.p('F'));
  j := public.friends_at_courts();
  perform pg_temp.ok('T5 F friends_at_courts: only O',
    jsonb_array_length(j -> 'now') = 1 and jsonb_array_length(j -> 'now' -> 0 -> 'people') = 1
    and (j -> 'now' -> 0 -> 'people' -> 0 ->> 'user_id')::uuid = pg_temp.p('O'), j::text);
  perform pg_temp.as_user(pg_temp.p('G'));
  j := public.friends_at_courts();
  perform pg_temp.ok('T5 guest friends_at_courts: nobody by name', jsonb_array_length(j -> 'now') = 0, j::text);
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.ok('T5 block crashed', false, sqlerrm);
end $$;


-- ════ T6 friends ═════════════════════════════════════════════════════════
do $$
declare
  t  text;
  v  boolean;
  v2 boolean;
  n  int;
begin
  -- Request, accept.
  perform pg_temp.as_user(pg_temp.p('O'));
  t := public.send_friend_request(pg_temp.p('S'));
  perform pg_temp.ok('T6 send -> pending', t = 'pending', t);
  perform pg_temp.as_admin();
  perform pg_temp.ok('T6 the request notice (copy, category, link)',
    exists (select 1 from public.notifications nt
             where nt.user_id = pg_temp.p('S') and nt.entity_type = 'friend' and nt.entity_id = pg_temp.p('O')
               and nt.type = 'info' and nt.category = 'notifyFriendRequests'
               and nt.title = '🤝 Olive Owner wants to be friends' and nt.body = 'Accept to see each other at the courts.'
               and nt.push_data ->> 'kind' = 'friend_request' and nt.push_data ->> 'deep_link' = 'friends/-'));
  perform pg_temp.ok('T6 the request rides the push outbox with its link',
    exists (select 1 from public.push_outbox o join public.notifications nt on nt.id = o.notification_id
             where nt.user_id = pg_temp.p('S') and nt.push_data ->> 'kind' = 'friend_request'
               and o.deep_link = 'friends/-' and o.category = 'notifyFriendRequests'));
  perform pg_temp.as_user(pg_temp.p('O'));
  t := public.send_friend_request(pg_temp.p('S'));
  perform pg_temp.ok('T6 send again -> already', t = 'already', t);
  perform pg_temp.ok('T6 status pending_outgoing',
    public.friendship_status_with(pg_temp.p('S')) ->> 'status' = 'pending_outgoing');
  perform pg_temp.ok('T6 O lists it outgoing',
    (select fr.direction from public.list_friend_requests() fr where fr.user_id = pg_temp.p('S')) = 'outgoing');
  perform pg_temp.as_user(pg_temp.p('S'));
  perform pg_temp.ok('T6 status pending_incoming',
    public.friendship_status_with(pg_temp.p('O')) ->> 'status' = 'pending_incoming');
  perform pg_temp.ok('T6 S lists it incoming',
    (select fr.direction from public.list_friend_requests() fr where fr.user_id = pg_temp.p('O')) = 'incoming');
  t := public.respond_friend_request(pg_temp.p('O'), true);
  perform pg_temp.ok('T6 accept -> accepted', t = 'accepted', t);
  perform pg_temp.ok('T6 accepting clears the request notice', pg_temp.notices('S', 'O', 'friend_request') = 0);
  perform pg_temp.as_admin();
  perform pg_temp.ok('T6 the requester hears back (copy, link)',
    exists (select 1 from public.notifications nt
             where nt.user_id = pg_temp.p('O') and nt.entity_type = 'friend' and nt.entity_id = pg_temp.p('S')
               and nt.title = '🤝 Sam Stranger accepted your friend request'
               and nt.body = 'You''ll see each other at the courts now.'
               and nt.push_data ->> 'kind' = 'friend_accepted'
               and nt.push_data ->> 'deep_link' = 'player/' || pg_temp.p('S')::text));
  perform pg_temp.as_user(pg_temp.p('S'));
  perform pg_temp.ok('T6 accept replay -> accepted', public.respond_friend_request(pg_temp.p('O'), true) = 'accepted');
  perform pg_temp.ok('T6 status friends', public.friendship_status_with(pg_temp.p('O')) ->> 'status' = 'friends');
  perform pg_temp.as_user(pg_temp.p('O'));
  perform pg_temp.ok('T6 list_my_friends has S, F, C',
    (select count(*) from public.list_my_friends() mf
      where mf.user_id in (pg_temp.p('S'), pg_temp.p('F'), pg_temp.p('C'))) = 3);

  -- Crossing requests auto-accept.
  perform pg_temp.as_user(pg_temp.p('X'));
  t := public.send_friend_request(pg_temp.p('Y'));
  perform pg_temp.as_user(pg_temp.p('Y'));
  perform pg_temp.ok('T6 a crossing request auto-accepts',
    t = 'pending' and public.send_friend_request(pg_temp.p('X')) = 'accepted');
  perform pg_temp.as_admin();
  perform pg_temp.ok('T6 ...friends now, X told, Y''s notice cleared',
    public.are_friends(pg_temp.p('X'), pg_temp.p('Y'))
    and pg_temp.notices('X', 'Y', 'friend_accepted') = 1 and pg_temp.notices('Y', 'X', 'friend_request') = 0);

  -- Decline, then a quiet re-request.
  perform pg_temp.as_user(pg_temp.p('Q'));
  perform public.send_friend_request(pg_temp.p('W'));
  perform pg_temp.as_user(pg_temp.p('W'));
  t := public.respond_friend_request(pg_temp.p('Q'), false);
  perform pg_temp.ok('T6 decline -> declined, notice cleared', t = 'declined' and pg_temp.notices('W', 'Q', 'friend_request') = 0, t);
  perform pg_temp.ok('T6 decline replay -> declined', public.respond_friend_request(pg_temp.p('Q'), false) = 'declined');
  perform pg_temp.as_user(pg_temp.p('Q'));
  perform pg_temp.ok('T6 after a decline the requester reads none', public.friendship_status_with(pg_temp.p('W')) ->> 'status' = 'none');
  t := public.send_friend_request(pg_temp.p('W'));
  perform pg_temp.ok('T6 re-request within 30 days: pending, nobody notified',
    t = 'pending' and pg_temp.notices('W', 'Q', 'friend_request') = 0, t);
  perform pg_temp.as_user(pg_temp.p('W'));
  perform pg_temp.ok('T6 ...but it is in their requests',
    exists (select 1 from public.list_friend_requests() fr where fr.user_id = pg_temp.p('Q') and fr.direction = 'incoming'));

  -- Cancel then re-send: one push a day.
  perform pg_temp.as_user(pg_temp.p('O'));
  perform public.send_friend_request(pg_temp.p('R1'));
  n := pg_temp.notices('R1', 'O', 'friend_request');
  v := public.cancel_friend_request(pg_temp.p('R1'));
  perform pg_temp.ok('T6 cancel -> true, notice deleted',
    n = 1 and v and pg_temp.notices('R1', 'O', 'friend_request') = 0, n::text);
  t := public.send_friend_request(pg_temp.p('R1'));
  perform pg_temp.ok('T6 re-send after a cancel within a day is quiet',
    t = 'pending' and pg_temp.notices('R1', 'O', 'friend_request') = 0, t);
  v := public.cancel_friend_request(pg_temp.p('R1'));
  v2 := public.cancel_friend_request(pg_temp.p('R1'));
  perform pg_temp.ok('T6 cancel twice -> true, false', v and not v2);

  -- Who can't be asked.
  foreach t in array array['U', 'G', 'B', 'K'] loop
    begin
      perform public.send_friend_request(pg_temp.p(t));
      perform pg_temp.ok('T6 request to ' || t || ' refused', false, 'no error');
    exception when others then
      perform pg_temp.ok('T6 request to ' || t || ' refused', sqlerrm = 'This player isn''t available', sqlerrm);
    end;
  end loop;
  begin
    perform public.send_friend_request(pg_temp.p('O'));
    perform pg_temp.ok('T6 request to self refused', false, 'no error');
  exception when others then
    perform pg_temp.ok('T6 request to self refused', sqlerrm like 'You can''t add yourself%', sqlerrm);
  end;
  perform pg_temp.ok('T6 status: unclaimed / blocked either way unavailable; self',
    public.friendship_status_with(pg_temp.p('U')) ->> 'status' = 'unavailable'
    and public.friendship_status_with(pg_temp.p('B')) ->> 'status' = 'unavailable'
    and public.friendship_status_with(pg_temp.p('K')) ->> 'status' = 'unavailable'
    and public.friendship_status_with(pg_temp.p('O')) ->> 'status' = 'self');
  perform pg_temp.as_user(pg_temp.p('G'));
  begin
    perform public.send_friend_request(pg_temp.p('O'));
    perform pg_temp.ok('T6 a guest cannot send', false, 'no error');
  exception when others then
    perform pg_temp.ok('T6 a guest cannot send', sqlerrm = 'Create an account to add friends', sqlerrm);
  end;
  perform pg_temp.ok('T6 a guest reads unavailable', public.friendship_status_with(pg_temp.p('O')) ->> 'status' = 'unavailable');

  -- 20 a day.
  perform pg_temp.as_admin();
  insert into public.friend_request_log (sender_id, addressee_id, notified)
  select pg_temp.p('M'), pg_temp.p('S'), true from generate_series(1, 20);
  perform pg_temp.as_user(pg_temp.p('M'));
  begin
    perform public.send_friend_request(pg_temp.p('N'));
    perform pg_temp.ok('T6 the 21st request in a day is refused', false, 'no error');
  exception when others then
    perform pg_temp.ok('T6 the 21st request in a day is refused', sqlerrm like 'You''ve sent 20 friend requests today%', sqlerrm);
  end;

  -- Close friends need a friendship.
  perform pg_temp.as_user(pg_temp.p('O'));
  begin
    perform public.set_close_friend(pg_temp.p('L'), true);
    perform pg_temp.ok('T6 starring a non-friend raises', false, 'no error');
  exception when others then
    perform pg_temp.ok('T6 starring a non-friend raises', sqlerrm = 'Only friends can be close friends', sqlerrm);
  end;
  v := public.set_close_friend(pg_temp.p('F'), true);
  perform pg_temp.ok('T6 star a friend',
    v and (public.friendship_status_with(pg_temp.p('F')) ->> 'is_close_friend')::boolean);
  perform pg_temp.ok('T6 unstar', not public.set_close_friend(pg_temp.p('F'), false));

  -- Unfriending clears stars both ways.
  perform pg_temp.as_user(pg_temp.p('S'));
  perform public.set_close_friend(pg_temp.p('O'), true);
  perform pg_temp.as_user(pg_temp.p('O'));
  perform public.set_close_friend(pg_temp.p('S'), true);
  perform pg_temp.ok('T6 remove_friend', public.remove_friend(pg_temp.p('S')));
  perform pg_temp.as_admin();
  perform pg_temp.ok('T6 ...stars gone both ways, not friends',
    not exists (select 1 from public.close_friends where pg_temp.p('S') in (user_id, friend_id))
    and not public.are_friends(pg_temp.p('O'), pg_temp.p('S')));
  perform pg_temp.as_user(pg_temp.p('O'));
  perform pg_temp.ok('T6 remove again -> false', not public.remove_friend(pg_temp.p('S')));

  -- A block tears everything down.
  perform pg_temp.as_admin();
  insert into public.friendships (requester_id, addressee_id, status, responded_at)
  values (pg_temp.p('O'), pg_temp.p('Z'), 'accepted', now());
  insert into public.close_friends values (pg_temp.p('O'), pg_temp.p('Z'), now()), (pg_temp.p('Z'), pg_temp.p('O'), now());
  insert into public.presence_hidden_from values (pg_temp.p('O'), pg_temp.p('Z'), now()), (pg_temp.p('Z'), pg_temp.p('O'), now());
  perform public._pl_notify_friend(pg_temp.p('Z'), pg_temp.p('O'), 'friend_accepted');
  perform pg_temp.as_user(pg_temp.p('Z'));
  insert into public.user_blocks (blocker_id, blocked_id) values (pg_temp.p('Z'), pg_temp.p('O'));
  perform pg_temp.as_admin();
  perform pg_temp.ok('T6 a block deletes the friendship, stars and notices; hide-from rows survive',
    not exists (select 1 from public.friendships where pg_temp.p('Z') in (requester_id, addressee_id))
    and not exists (select 1 from public.close_friends where pg_temp.p('Z') in (user_id, friend_id))
    and exists (select 1 from public.presence_hidden_from where user_id = pg_temp.p('O') and hidden_user_id = pg_temp.p('Z'))
    and exists (select 1 from public.presence_hidden_from where user_id = pg_temp.p('Z') and hidden_user_id = pg_temp.p('O'))
    and pg_temp.notices('Z', 'O', 'friend_accepted') = 0);
  perform pg_temp.as_user(pg_temp.p('Z'));
  perform pg_temp.ok('T6 ...and the pair reads unavailable',
    public.friendship_status_with(pg_temp.p('O')) ->> 'status' = 'unavailable');

  -- A hide survives a block and an unblock by the other person, and the
  -- hider's own list never shows that they were blocked.
  perform pg_temp.ok('T6 (setup) O sees closed-league mate L by name', pg_temp.sees('O', 'L'));
  perform pg_temp.as_user(pg_temp.p('L'));
  perform public.hide_presence_from(pg_temp.p('O'), true);
  perform pg_temp.ok('T6 L hides from O', not pg_temp.sees('O', 'L'));
  perform pg_temp.as_user(pg_temp.p('O'));
  insert into public.user_blocks (blocker_id, blocked_id) values (pg_temp.p('O'), pg_temp.p('L'));
  perform pg_temp.as_user(pg_temp.p('L'));
  perform pg_temp.ok('T6 O blocks L: L''s own hide list still has O (no tell)',
    exists (select 1 from public.list_presence_hidden() h where h.user_id = pg_temp.p('O')));
  perform pg_temp.as_user(pg_temp.p('O'));
  delete from public.user_blocks where blocker_id = pg_temp.p('O') and blocked_id = pg_temp.p('L');
  perform pg_temp.as_admin();
  perform pg_temp.ok('T6 O unblocks L: L''s hide-from row is still there',
    exists (select 1 from public.presence_hidden_from where user_id = pg_temp.p('L') and hidden_user_id = pg_temp.p('O')));
  perform pg_temp.ok('T6 ...and O still does not see L by name', not pg_temp.sees('O', 'L'));
  perform pg_temp.as_user(pg_temp.p('L'));
  perform public.hide_presence_from(pg_temp.p('O'), false);
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.ok('T6 block crashed', false, sqlerrm);
end $$;


-- ════ T8 raw rows are owner-only ═════════════════════════════════════════
do $$
declare n int;
begin
  perform pg_temp.as_user(pg_temp.p('S'));
  select count(*) into n from public.venue_checkins where user_id <> pg_temp.p('S');
  perform pg_temp.ok('T8 others'' check-ins unreadable', n = 0, n::text);
  select count(*) into n from public.venue_checkins;
  perform pg_temp.ok('T8 own check-ins readable', n >= 1, n::text);
  select count(*) into n from public.play_sessions where user_id <> pg_temp.p('S');
  perform pg_temp.ok('T8 others'' play sessions unreadable', n = 0, n::text);
  perform pg_temp.ok('T8 own play sessions readable', exists (select 1 from public.play_sessions));
  perform pg_temp.ok('T8 friendships: the two parties only',
    not exists (select 1 from public.friendships f where pg_temp.p('S') not in (f.requester_id, f.addressee_id)));
  perform pg_temp.ok('T8 presence_settings, hide-from, stars, favorites: own only',
    not exists (select 1 from public.presence_settings where user_id <> pg_temp.p('S'))
    and not exists (select 1 from public.presence_hidden_from where user_id <> pg_temp.p('S'))
    and not exists (select 1 from public.close_friends where user_id <> pg_temp.p('S'))
    and not exists (select 1 from public.court_favorites where user_id <> pg_temp.p('S')));
  begin
    perform 1 from public.friend_request_log limit 1;
    perform pg_temp.ok('T8 friend_request_log closed to clients', false, 'readable');
  exception when others then
    perform pg_temp.ok('T8 friend_request_log closed to clients', sqlstate = '42501', sqlerrm);
  end;
  begin
    perform 1 from public.presence_closed_ids limit 1;
    perform pg_temp.ok('T8 presence_closed_ids closed to clients', false, 'readable');
  exception when others then
    perform pg_temp.ok('T8 presence_closed_ids closed to clients', sqlstate = '42501', sqlerrm);
  end;
  begin
    insert into public.venue_checkins (user_id, venue_id, expires_at, location_confirmed)
    values (pg_temp.p('S'), 'test:p1-bravo', now() + interval '1 hour', true);
    perform pg_temp.ok('T8 no direct check-in writes', false, 'inserted');
  exception when others then
    perform pg_temp.ok('T8 no direct check-in writes', true, sqlerrm);
  end;
  begin
    insert into public.presence_settings (user_id, checkins_level) values (pg_temp.p('S'), 'everyone');
    perform pg_temp.ok('T8 no direct settings writes', false, 'inserted');
  exception when others then
    perform pg_temp.ok('T8 no direct settings writes', true, sqlerrm);
  end;
  begin
    insert into public.friendships (requester_id, addressee_id, status) values (pg_temp.p('S'), pg_temp.p('N'), 'accepted');
    perform pg_temp.ok('T8 no direct friendship writes', false, 'inserted');
  exception when others then
    perform pg_temp.ok('T8 no direct friendship writes', true, sqlerrm);
  end;
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.ok('T8 block crashed', false, sqlerrm);
end $$;


-- ════ T9 resolve_court ═══════════════════════════════════════════════════
do $$
declare j jsonb;
begin
  perform pg_temp.as_user(pg_temp.p('S'));
  j := public.resolve_court(40.00006, -100.0);
  perform pg_temp.ok('T9 a point at Alpha resolves to the canonical row, inside',
    j ->> 'id' = 'test:p1-alpha' and (j ->> 'inside')::boolean and (j ->> 'distance_m')::numeric < 2, j::text);
  j := public.resolve_court(40.02005, -100.0, 150, 'basketball');
  perform pg_temp.ok('T9 sport-aware: basketball finds the hoops', j ->> 'id' = 'test:p1-hoops', j::text);
  perform pg_temp.ok('T9 sport-aware: pickleball ignores the hoops', public.resolve_court(40.02005, -100.0) is null);
  perform pg_temp.ok('T9 out of radius -> null', public.resolve_court(40.0015, -100.0, 150) is null);
  j := public.resolve_court(40.0015, -100.0, 200);
  perform pg_temp.ok('T9 a wider radius finds Alpha, outside its fence',
    j ->> 'id' = 'test:p1-alpha' and not (j ->> 'inside')::boolean, j::text);
  perform pg_temp.ok('T9 no point -> null', public.resolve_court(null, -100.0) is null);
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.ok('T9 block crashed', false, sqlerrm);
end $$;


-- ════ T10 delete_my_account clears presence ══════════════════════════════
do $$
declare
  d uuid := pg_temp.p('D');
  n int;
begin
  perform pg_temp.checkin('D', 'c0000000-0000-4000-8000-000000000201');
  perform public.start_play_session(p_id => 'e0000000-0000-4000-8000-000000000201', p_kind => 'open_play');
  perform public.set_presence_settings('friends');
  perform public.hide_presence_from(pg_temp.p('F'), true);
  perform public.set_court_favorite('test:p1-bravo', true);
  perform public.end_play_session('e0000000-0000-4000-8000-000000000209', now());   -- never started: a tombstone
  perform pg_temp.as_admin();
  insert into public.friendships (requester_id, addressee_id, status, responded_at) values (pg_temp.p('O'), d, 'accepted', now());
  insert into public.close_friends values (pg_temp.p('O'), d, now()), (d, pg_temp.p('O'), now());
  insert into public.presence_hidden_from values (pg_temp.p('O'), d, now());
  insert into public.friend_request_log (sender_id, addressee_id) values (d, pg_temp.p('S'));
  perform public._pl_notify_friend(pg_temp.p('O'), d, 'friend_accepted');
  perform pg_temp.ok('T10 (setup) the account has presence and friend rows',
    exists (select 1 from public.venue_checkins where user_id = d)
    and exists (select 1 from public.court_favorites where user_id = d)
    and exists (select 1 from public.presence_closed_ids where user_id = d)
    and pg_temp.notices('O', 'D', 'friend_accepted') = 1);

  perform pg_temp.as_user(d);
  perform public.delete_my_account();
  perform pg_temp.as_admin();
  select (select count(*) from public.venue_checkins where user_id = d)
       + (select count(*) from public.play_sessions where user_id = d)
       + (select count(*) from public.presence_settings where user_id = d)
       + (select count(*) from public.presence_hidden_from where d in (user_id, hidden_user_id))
       + (select count(*) from public.close_friends where d in (user_id, friend_id))
       + (select count(*) from public.friendships where d in (requester_id, addressee_id))
       + (select count(*) from public.friend_request_log where d in (sender_id, addressee_id))
       + (select count(*) from public.court_favorites where user_id = d)
       + (select count(*) from public.presence_closed_ids where user_id = d)
       + pg_temp.notices('O', 'D', 'friend_accepted')
    into n;
  perform pg_temp.ok('T10 delete_my_account removes every presence and friend row, both columns', n = 0, n::text);
  perform pg_temp.ok('T10 the profile is a tombstone',
    (select deleted_at is not null and full_name = '[deleted account]' from public.profiles where id = d));
  perform pg_temp.ok('T10 a deleted viewer gets counts only; a deleted owner is not shown',
    public._pl_can_see_presence(d, pg_temp.p('F'), 'checkins') = 'anonymous'
    and public._pl_can_see_presence(pg_temp.p('F'), d, 'checkins') = 'none');
  perform pg_temp.as_user(pg_temp.p('O'));
  begin
    perform public.send_friend_request(d);
    perform pg_temp.ok('T10 a deleted account cannot be asked', false, 'no error');
  exception when others then
    perform pg_temp.ok('T10 a deleted account cannot be asked', sqlerrm = 'This player isn''t available', sqlerrm);
  end;
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.ok('T10 block crashed', false, sqlerrm);
end $$;


-- ════ T11 retention and the expiry crons ═════════════════════════════════
do $$
begin
  insert into public.venue_checkins (id, user_id, venue_id, checked_in_at, expires_at, checked_out_at, location_confirmed) values
    ('c0000000-0000-4000-8000-000000000301', pg_temp.p('S'), 'test:p1-bravo',
     now() - interval '200 days', now() - interval '200 days' + interval '2 hours', now() - interval '200 days' + interval '1 hour', true),
    ('c0000000-0000-4000-8000-000000000302', pg_temp.p('S'), 'test:p1-bravo',
     now() - interval '100 days', now() - interval '100 days' + interval '2 hours', now() - interval '100 days' + interval '1 hour', true),
    ('c0000000-0000-4000-8000-000000000303', pg_temp.p('N'), 'test:p1-bravo',
     now() - interval '3 hours', now() - interval '1 hour', null, true);
  insert into public.friend_request_log (sender_id, addressee_id, sent_at) values (pg_temp.p('N'), pg_temp.p('S'), now() - interval '40 days');
  insert into public.presence_closed_ids (user_id, id, closed_at, created_at) values
    (pg_temp.p('N'), 'c0000000-0000-4000-8000-000000000304', now() - interval '3 days', now() - interval '3 days'),
    (pg_temp.p('N'), 'c0000000-0000-4000-8000-000000000305', now(), now());
  perform public.prune_presence_history();
  perform pg_temp.ok('T11 retention drops closed-id tombstones after 2 days',
    (select array_agg(id) from public.presence_closed_ids where user_id = pg_temp.p('N'))
      = array['c0000000-0000-4000-8000-000000000305'::uuid]);
  perform pg_temp.ok('T11 retention deletes check-ins that ended over 180 days ago, keeps newer ones',
    not exists (select 1 from public.venue_checkins where id = 'c0000000-0000-4000-8000-000000000301')
    and exists (select 1 from public.venue_checkins where id = 'c0000000-0000-4000-8000-000000000302'));
  perform pg_temp.ok('T11 retention prunes the request log after 30 days',
    not exists (select 1 from public.friend_request_log where sender_id = pg_temp.p('N'))
    and (select count(*) from public.friend_request_log where sender_id = pg_temp.p('M')) = 20);
  perform pg_temp.ok('T11 the retention cron runs daily',
    exists (select 1 from cron.job where jobname = 'pickleague-presence-retention'
             and schedule = '50 4 * * *' and command like '%prune_presence_history%'));
  perform pg_temp.ok('T11 the expiry crons still call live functions',
    exists (select 1 from cron.job where jobname = 'pickleague-expire-venue-checkins' and command like '%public.expire_venue_checkins()%')
    and exists (select 1 from cron.job where jobname = 'pickleague-expire-play-sessions' and command like '%public.expire_play_sessions()%')
    and to_regprocedure('public.expire_venue_checkins()') is not null
    and to_regprocedure('public.expire_play_sessions()') is not null);
  perform public.expire_venue_checkins();
  perform pg_temp.ok('T11 expire_venue_checkins closes a lapsed row at its expiry',
    (select checked_out_at = expires_at from public.venue_checkins where id = 'c0000000-0000-4000-8000-000000000303'));

  -- A session replayed from 7 hours ago, with a session check-in.
  perform pg_temp.as_user(pg_temp.p('Q'));
  perform public.start_play_session(p_id => 'e0000000-0000-4000-8000-000000000301', p_kind => 'open_play',
    p_venue => 'test:p1-bravo', p_at => now() - interval '7 hours',
    p_lat => 40.0101, p_lng => -100.0, p_accuracy_m => 10, p_fix_at => now());
  perform pg_temp.as_admin();
  perform pg_temp.ok('T11 (setup) the replayed session opened its check-in',
    exists (select 1 from public.venue_checkins where id = 'e0000000-0000-4000-8000-000000000301' and checked_out_at is null));
  perform public.expire_play_sessions();
  perform pg_temp.ok('T11 expire_play_sessions ends the session and its check-in at started + 6 h',
    (select ended_at = now() - interval '1 hour' from public.play_sessions where id = 'e0000000-0000-4000-8000-000000000301')
    and (select checked_out_at = now() - interval '1 hour' from public.venue_checkins
          where id = 'e0000000-0000-4000-8000-000000000301'));
exception when others then
  perform pg_temp.ok('T11 block crashed', false, sqlerrm);
end $$;


-- ════ T12 suggestions from real co-play ══════════════════════════════════
do $$
declare
  r record;
  n int;
begin
  -- O played N (closed test league); O drilled with P, the unclaimed U and the guest G.
  insert into public.matches (league_id, player1_id, player2_id, player1_score, player2_score, match_type, status, played_at)
  values ('b0000000-0000-4000-8000-000000000001', pg_temp.p('O'), pg_temp.p('N'), 11, 5, 'singles', 'completed', now());
  insert into public.drill_sessions (player1_id, player2_id, session_date, session_slot) values
    (pg_temp.p('O'), pg_temp.p('U'), current_date - 3, 18),
    (pg_temp.p('G'), pg_temp.p('O'), current_date - 2, 18),
    (pg_temp.p('O'), pg_temp.p('P'), current_date - 1, 18);
  perform pg_temp.as_user(pg_temp.p('O'));
  select * into r from public.suggest_friends() limit 1;
  perform pg_temp.ok('T12 a match together ranks first', r.user_id = pg_temp.p('N') and r.reason = '1 match together', r::text);
  perform pg_temp.ok('T12 a drill partner is suggested',
    (select sf.reason from public.suggest_friends() sf where sf.user_id = pg_temp.p('P')) = 'Drilled 1x');
  perform pg_temp.ok('T12 a closed-league mate is suggested',
    (select sf.reason from public.suggest_friends() sf where sf.user_id = pg_temp.p('L')) = 'Both in P1 Test Closed');
  select count(*) into n from public.suggest_friends() sf
   where sf.user_id in (pg_temp.p('U'), pg_temp.p('G'), pg_temp.p('F'), pg_temp.p('C'), pg_temp.p('B'), pg_temp.p('D'));
  perform pg_temp.ok('T12 no unclaimed, guest, friend, blocked or deleted accounts', n = 0, n::text);
  perform pg_temp.as_user(pg_temp.p('G'));
  perform pg_temp.ok('T12 guests get no suggestions', not exists (select 1 from public.suggest_friends()));
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.ok('T12 block crashed', false, sqlerrm);
end $$;


-- ════ T13 closed-league membership is consent ════════════════════════════
-- AT runs closed leagues; V never joined one. J self-joins an open league
-- that AT closes later; I and CM are admitted to closed leagues the usual
-- way (an invite or an approval: a server insert).
do $$
declare
  at  uuid := pg_temp.p('AT');
  v   uuid := pg_temp.p('V');
  n   int;
  ok2 boolean;
begin
  perform pg_temp.as_user(at);
  insert into public.leagues (id, name, is_open, created_by) values
    ('b0000000-0000-4000-8000-000000000011', 'P1 Test Attack One', false, at),
    ('b0000000-0000-4000-8000-000000000012', 'P1 Test Attack Two', false, at);
  insert into public.league_members (league_id, user_id, role) values
    ('b0000000-0000-4000-8000-000000000011', at, 'admin'),
    ('b0000000-0000-4000-8000-000000000012', at, 'admin')
  on conflict do nothing;

  -- Moving a membership onto someone who never joined.
  begin
    update public.league_members
       set league_id = 'b0000000-0000-4000-8000-000000000011', user_id = v, role = 'member'
     where league_id = 'b0000000-0000-4000-8000-000000000012' and user_id = at;
    get diagnostics n = row_count;
    perform pg_temp.ok('T13 an admin cannot move a membership onto another player', false, n || ' rows');
  exception when others then
    perform pg_temp.ok('T13 an admin cannot move a membership onto another player', sqlstate = '42501', sqlerrm);
  end;
  begin
    update public.league_members set user_id = v
     where league_id = 'b0000000-0000-4000-8000-000000000011' and user_id = at;
    get diagnostics n = row_count;
    perform pg_temp.ok('T13 ...nor within one league', false, n || ' rows');
  exception when others then
    perform pg_temp.ok('T13 ...nor within one league', sqlstate = '42501', sqlerrm);
  end;
  perform pg_temp.as_admin();
  begin
    update public.league_members set user_id = v
     where league_id = 'b0000000-0000-4000-8000-000000000011' and user_id = at;
    perform pg_temp.ok('T13 the trigger refuses a move even with full UPDATE (server code)', false, 'moved');
  exception when others then
    perform pg_temp.ok('T13 the trigger refuses a move even with full UPDATE (server code)', sqlstate = '42501', sqlerrm);
  end;
  perform pg_temp.checkin('V', 'c0000000-0000-4000-8000-000000000401', 'test:p1-c3', 120, 40.0301);
  perform pg_temp.as_admin();
  ok2 := not public.share_closed_league(at, v);
  ok2 := ok2 and not pg_temp.sees_at('AT', 'V', 'test:p1-c3');   -- leaves the role as AT
  perform pg_temp.ok('T13 so V is no league-mate of AT and is not named to AT',
    ok2 and not exists (select 1 from jsonb_array_elements(public.friends_at_courts() -> 'now') g,
                             jsonb_array_elements(g -> 'people') pp
                         where (pp ->> 'user_id')::uuid = v));

  -- What an admin may still do: change a member's role. Nothing else.
  perform pg_temp.as_admin();
  insert into public.league_members (league_id, user_id, role)
  values ('b0000000-0000-4000-8000-000000000011', pg_temp.p('E'), 'member');   -- an invite
  perform pg_temp.as_user(at);
  update public.league_members set role = 'co-admin'
   where league_id = 'b0000000-0000-4000-8000-000000000011' and user_id = pg_temp.p('E');
  get diagnostics n = row_count;
  perform pg_temp.ok('T13 an admin can still promote a member', n = 1, n::text);
  begin
    update public.league_members set admitted_closed = true
     where league_id = 'b0000000-0000-4000-8000-000000000011' and user_id = pg_temp.p('E');
    perform pg_temp.ok('T13 a client cannot write admitted_closed', false, 'updated');
  exception when others then
    perform pg_temp.ok('T13 a client cannot write admitted_closed', sqlstate = '42501', sqlerrm);
  end;

  -- An open league closed later: whoever joined while it was open stays anonymous.
  perform pg_temp.as_user(at);
  insert into public.leagues (id, name, is_open, created_by)
  values ('b0000000-0000-4000-8000-000000000013', 'P1 Test Open Then Closed', true, at);
  insert into public.league_members (league_id, user_id, role)
  values ('b0000000-0000-4000-8000-000000000013', at, 'admin') on conflict do nothing;
  perform pg_temp.as_user(pg_temp.p('J'));
  insert into public.league_members (league_id, user_id, role, admitted_closed)
  values ('b0000000-0000-4000-8000-000000000013', pg_temp.p('J'), 'member', true);
  perform pg_temp.as_admin();
  perform pg_temp.ok('T13 a self-join cannot claim admitted_closed',
    (select not admitted_closed from public.league_members
      where league_id = 'b0000000-0000-4000-8000-000000000013' and user_id = pg_temp.p('J')));
  perform pg_temp.checkin('J', 'c0000000-0000-4000-8000-000000000402', 'test:p1-c3', 120, 40.0301);
  perform pg_temp.checkin('AT', 'c0000000-0000-4000-8000-000000000403', 'test:p1-c3', 120, 40.0301);
  perform pg_temp.ok('T13 (setup) open league: AT does not see J by name', not pg_temp.sees_at('AT', 'J', 'test:p1-c3'));
  perform pg_temp.as_user(at);
  update public.leagues set is_open = false where id = 'b0000000-0000-4000-8000-000000000013';
  get diagnostics n = row_count;
  perform pg_temp.ok('T13 closing it later names nobody who joined while it was open',
    n = 1 and not pg_temp.sees_at('AT', 'J', 'test:p1-c3') and not pg_temp.sees_at('J', 'AT', 'test:p1-c3'), n::text);
  perform pg_temp.as_user(at);
  perform pg_temp.ok('T13 ...nor lists them in Friends at the courts or suggestions',
    not exists (select 1 from jsonb_array_elements(public.friends_at_courts() -> 'now') g,
                     jsonb_array_elements(g -> 'people') pp
                 where (pp ->> 'user_id')::uuid = pg_temp.p('J'))
    and not exists (select 1 from public.suggest_friends() sf where sf.user_id = pg_temp.p('J')));
  perform pg_temp.as_admin();
  insert into public.league_members (league_id, user_id, role)
  values ('b0000000-0000-4000-8000-000000000013', pg_temp.p('I'), 'member');   -- an invite after it closed
  perform pg_temp.checkin('I', 'c0000000-0000-4000-8000-000000000404', 'test:p1-c3', 120, 40.0301);
  perform pg_temp.ok('T13 the creator who closed it and a member admitted since see each other by name',
    pg_temp.sees_at('I', 'AT', 'test:p1-c3') and pg_temp.sees_at('AT', 'I', 'test:p1-c3'));

  -- Closed, opened, closed again: the member admitted while closed stays
  -- named; whoever joined in the open window does not.
  perform pg_temp.as_user(at);
  insert into public.leagues (id, name, is_open, created_by)
  values ('b0000000-0000-4000-8000-000000000014', 'P1 Test Reopened', false, at);
  insert into public.league_members (league_id, user_id, role)
  values ('b0000000-0000-4000-8000-000000000014', at, 'admin') on conflict do nothing;
  perform pg_temp.as_admin();
  insert into public.league_members (league_id, user_id, role)
  values ('b0000000-0000-4000-8000-000000000014', pg_temp.p('CM'), 'member');
  perform pg_temp.as_user(at);
  update public.leagues set is_open = true where id = 'b0000000-0000-4000-8000-000000000014';
  perform pg_temp.as_user(pg_temp.p('J'));
  insert into public.league_members (league_id, user_id, role)
  values ('b0000000-0000-4000-8000-000000000014', pg_temp.p('J'), 'member');
  perform pg_temp.as_user(at);
  update public.leagues set is_open = false where id = 'b0000000-0000-4000-8000-000000000014';
  perform pg_temp.checkin('CM', 'c0000000-0000-4000-8000-000000000405', 'test:p1-c3', 120, 40.0301);
  perform pg_temp.ok('T13 closed, opened, closed: the curated member stays named, the open-window joiner does not',
    pg_temp.sees_at('AT', 'CM', 'test:p1-c3') and not pg_temp.sees_at('AT', 'J', 'test:p1-c3'));

  -- blocked_between answers a signed-in caller only about their own pairs.
  perform pg_temp.as_user(pg_temp.p('S'));
  perform pg_temp.ok('T13 a third party cannot ask who blocked whom',
    not public.blocked_between(pg_temp.p('O'), pg_temp.p('B'))
    and not public.blocked_between(pg_temp.p('K'), pg_temp.p('O')));
  perform pg_temp.as_user(pg_temp.p('O'));
  perform pg_temp.ok('T13 the people in a block still get the answer (O)',
    public.blocked_between(pg_temp.p('O'), pg_temp.p('B')) and public.blocked_between(pg_temp.p('K'), pg_temp.p('O')));
  perform pg_temp.as_user(pg_temp.p('K'));
  perform pg_temp.ok('T13 the people in a block still get the answer (K)', public.blocked_between(pg_temp.p('K'), pg_temp.p('O')));
  perform pg_temp.as_admin();
  perform pg_temp.ok('T13 server code (no session) gets the full answer', public.blocked_between(pg_temp.p('O'), pg_temp.p('B')));
exception when others then
  perform pg_temp.ok('T13 block crashed', false, sqlerrm);
end $$;


-- ════ T14 the crowd band never describes someone the viewer can name ═════
-- At Delta: RV (rated 4.0) and their friend RF (3.0, named to RV, rating on
-- the row) with one rated stranger RH (5.0). Then RX (3.5) and RY (4.5).
do $$
declare
  r record;
  j jsonb;
begin
  perform pg_temp.as_admin();
  update public.profiles set total_matches_played = 5, doubles_rating = 4.0 where id = pg_temp.p('RV');
  update public.profiles set total_matches_played = 5, doubles_rating = 3.0 where id = pg_temp.p('RF');
  update public.profiles set total_matches_played = 5, doubles_rating = 5.0 where id = pg_temp.p('RH');
  update public.profiles set total_matches_played = 5, doubles_rating = 3.5 where id = pg_temp.p('RX');
  update public.profiles set total_matches_played = 5, doubles_rating = 4.5 where id = pg_temp.p('RY');
  insert into public.friendships (requester_id, addressee_id, status, responded_at)
  values (pg_temp.p('RV'), pg_temp.p('RF'), 'accepted', now());
  perform pg_temp.checkin('RV', 'c0000000-0000-4000-8000-000000000501', 'test:p1-delta', 120, 40.0701);
  perform pg_temp.checkin('RF', 'c0000000-0000-4000-8000-000000000502', 'test:p1-delta', 120, 40.0701);
  perform pg_temp.checkin('RH', 'c0000000-0000-4000-8000-000000000503', 'test:p1-delta', 120, 40.0701);
  perform pg_temp.as_user(pg_temp.p('RV'));
  perform pg_temp.ok('T14 (setup) RV sees RF by name with their rating',
    exists (select 1 from public.court_presence('test:p1-delta') c
             where c.user_id = pg_temp.p('RF') and c.doubles_rating = 3.0));
  select * into r from public.venue_crowd(array['test:p1-delta']) c;
  perform pg_temp.ok('T14 viewer + named friend + one rated stranger: no band (it would be the stranger''s rating)',
    r.here_now = 3 and r.band_low is null and r.band_high is null, r::text);
  perform pg_temp.checkin('RX', 'c0000000-0000-4000-8000-000000000504', 'test:p1-delta', 120, 40.0701);
  perform pg_temp.checkin('RY', 'c0000000-0000-4000-8000-000000000505', 'test:p1-delta', 120, 40.0701);
  perform pg_temp.as_user(pg_temp.p('RV'));
  select * into r from public.venue_crowd(array['test:p1-delta']) c;
  perform pg_temp.ok('T14 three rated strangers: the band is theirs alone (4.00-4.75, not 3.50-4.50)',
    r.here_now = 5 and r.band_low = 4.0 and r.band_high = 4.75, r::text);
  j := public.friends_at_courts();
  perform pg_temp.ok('T14 Friends at the courts shows the same band',
    exists (select 1 from jsonb_array_elements(j -> 'courts') c
             where c ->> 'venue_id' = 'test:p1-delta'
               and (c ->> 'band_low')::numeric = 4.0 and (c ->> 'band_high')::numeric = 4.75), (j -> 'courts')::text);
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.ok('T14 block crashed', false, sqlerrm);
end $$;


-- ════ T15 the fix: precise, aged on one clock; extensions stay confirmed ══
-- E at court Four (40.04): a fix 11 m north is 40.0401.
do $$
declare
  e uuid := pg_temp.p('E');
  r public.venue_checkins;
  s public.play_sessions;
begin
  perform pg_temp.as_user(e);
  -- An approximate location (km wide) can't confirm a court even when its
  -- centre lands on it; neither can a fix with no accuracy.
  begin
    perform public.checkin_venue(p_id => 'c0000000-0000-4000-8000-000000000601', p_venue => 'test:p1-c4',
      p_lat => 40.0401, p_lng => -100.0, p_accuracy_m => 5000, p_fix_at => now());
    perform pg_temp.ok('T15 a 5 km-accuracy fix is refused', false, 'no error');
  exception when others then
    perform pg_temp.ok('T15 a 5 km-accuracy fix is refused', sqlerrm like 'Your location isn''t precise enough%', sqlerrm);
  end;
  begin
    perform public.checkin_venue(p_id => 'c0000000-0000-4000-8000-000000000601', p_venue => 'test:p1-c4',
      p_lat => 40.0401, p_lng => -100.0, p_accuracy_m => null, p_fix_at => now());
    perform pg_temp.ok('T15 a fix with no accuracy is refused', false, 'no error');
  exception when others then
    perform pg_temp.ok('T15 a fix with no accuracy is refused', sqlerrm like 'Your location isn''t precise enough%', sqlerrm);
  end;
  select * into r from public.checkin_venue(p_id => 'c0000000-0000-4000-8000-000000000602', p_venue => 'test:p1-c4',
    p_lat => 40.0401, p_lng => -100.0, p_accuracy_m => 150, p_fix_at => now());
  perform pg_temp.ok('T15 a 150 m-accuracy fix 11 m away confirms', r.location_confirmed, r::text);
  perform public.checkout_venue(null, null, now());

  -- The fix's age, measured on the device's clock: off clocks still work.
  select * into r from public.checkin_venue(p_id => 'c0000000-0000-4000-8000-000000000603', p_venue => 'test:p1-c4',
    p_lat => 40.0401, p_lng => -100.0, p_accuracy_m => 10, p_fix_at => now() + interval '90 seconds',
    p_fix_age_ms => 1000);
  perform pg_temp.ok('T15 a phone 90 s fast with a 1 s-old fix confirms; fix_at is on the server clock',
    r.location_confirmed and r.fix_at = now() - interval '1 second', r::text);
  perform public.checkout_venue(null, null, now());
  begin
    perform public.checkin_venue(p_id => 'c0000000-0000-4000-8000-000000000604', p_venue => 'test:p1-c4',
      p_lat => 40.0401, p_lng => -100.0, p_accuracy_m => 10, p_fix_at => now(), p_fix_age_ms => 180000);
    perform pg_temp.ok('T15 a 3-minute-old fix (by its age) is refused', false, 'no error');
  exception when others then
    perform pg_temp.ok('T15 a 3-minute-old fix (by its age) is refused',
      sqlerrm = 'Your location is out of date. Try again at the court.', sqlerrm);
  end;
  begin
    perform public.checkin_venue(p_id => 'c0000000-0000-4000-8000-000000000604', p_venue => 'test:p1-c4',
      p_lat => 40.0401, p_lng => -100.0, p_accuracy_m => 10, p_fix_at => now() - interval '3 minutes');
    perform pg_temp.ok('T15 without an age, a stale fix names the phone''s clock', false, 'no error');
  exception when others then
    perform pg_temp.ok('T15 without an age, a stale fix names the phone''s clock',
      sqlerrm like 'Your location is out of date. Check that your phone''s date and time%', sqlerrm);
  end;
  select * into s from public.start_play_session(p_id => 'e0000000-0000-4000-8000-000000000601', p_kind => 'open_play',
    p_venue => 'test:p1-c4', p_lat => 40.0401, p_lng => -100.0, p_accuracy_m => 5000, p_fix_at => now());
  perform pg_temp.ok('T15 a session with a 5 km-accuracy fix starts without a check-in',
    s.id = 'e0000000-0000-4000-8000-000000000601'
    and not exists (select 1 from public.venue_checkins where id = 'e0000000-0000-4000-8000-000000000601'));
  perform public.start_play_session(p_id => 'e0000000-0000-4000-8000-000000000602', p_kind => 'open_play',
    p_venue => 'test:p1-c4', p_lat => 40.0401, p_lng => -100.0, p_accuracy_m => 10,
    p_fix_at => now() - interval '10 minutes', p_fix_age_ms => 5000);
  perform pg_temp.ok('T15 a session from a phone 10 min slow still checks in (fix age 5 s)',
    exists (select 1 from public.venue_checkins where id = 'e0000000-0000-4000-8000-000000000602'
             and location_confirmed and checked_out_at is null and fix_at = now() - interval '5 seconds'));
  perform public.end_play_session('e0000000-0000-4000-8000-000000000602', now());

  -- A confirmed check-in can't be stretched from anywhere: without a fix it
  -- goes at most 4 h past its last confirming fix.
  perform pg_temp.checkin('E', 'c0000000-0000-4000-8000-000000000605', 'test:p1-c4', 120, 40.0401);
  perform pg_temp.as_admin();
  update public.venue_checkins
     set checked_in_at = now() - interval '3 hours', fix_at = now() - interval '3 hours',
         expires_at = now() + interval '30 minutes'
   where id = 'c0000000-0000-4000-8000-000000000605';
  perform pg_temp.as_user(e);
  select * into r from public.extend_checkin('c0000000-0000-4000-8000-000000000605', now() + interval '2 hours');
  perform pg_temp.ok('T15 a fix-less extension stops 4 h after the last fix',
    r.expires_at = now() + interval '1 hour', r::text);
  select * into r from public.extend_checkin('c0000000-0000-4000-8000-000000000605', now() + interval '1 hour');
  perform pg_temp.ok('T15 ...a replay of that end time is fine', r.expires_at = now() + interval '1 hour', r::text);
  begin
    perform public.extend_checkin('c0000000-0000-4000-8000-000000000605', now() + interval '3 hours');
    perform pg_temp.ok('T15 ...and past the cap it asks for the court', false, 'no error');
  exception when others then
    perform pg_temp.ok('T15 ...and past the cap it asks for the court',
      sqlerrm like 'To stay checked in, open Pickleague at the court%', sqlerrm);
  end;
  begin
    perform public.extend_checkin(p_id => 'c0000000-0000-4000-8000-000000000605', p_until => now() + interval '3 hours',
      p_lat => 40.043, p_lng => -100.0, p_accuracy_m => 10, p_fix_at => now(), p_fix_age_ms => 1000);
    perform pg_temp.ok('T15 an extension with a far fix is refused', false, 'no error');
  exception when others then
    perform pg_temp.ok('T15 an extension with a far fix is refused',
      sqlerrm like 'You need to be at the court to stay checked in (about%', sqlerrm);
  end;
  select * into r from public.extend_checkin(p_id => 'c0000000-0000-4000-8000-000000000605',
    p_until => now() + interval '3 hours', p_lat => 40.0401, p_lng => -100.0, p_accuracy_m => 10,
    p_fix_at => now(), p_fix_age_ms => 0);
  perform pg_temp.ok('T15 an extension with a confirming fix goes on and becomes the latest fix',
    r.expires_at = now() + interval '3 hours' and r.fix_at = now(), r::text);
  -- A session adopting it without a fix can't stretch it past that either.
  perform pg_temp.as_admin();
  update public.venue_checkins set fix_at = now() - interval '3 hours', expires_at = now() + interval '30 minutes'
   where id = 'c0000000-0000-4000-8000-000000000605';
  perform pg_temp.as_user(e);
  perform public.start_play_session(p_id => 'e0000000-0000-4000-8000-000000000603', p_kind => 'open_play',
    p_venue => 'test:p1-c4');
  perform pg_temp.ok('T15 a session adopting it without a fix covers it to 4 h after that fix',
    (select expires_at from public.venue_checkins where id = 'c0000000-0000-4000-8000-000000000605')
      = now() + interval '1 hour');
  perform public.end_play_session('e0000000-0000-4000-8000-000000000603', now());
  perform public.checkout_venue(null, null, now());
  -- A private (1.0.4, no fix) row extends as before: nobody sees it.
  perform public.checkin_venue(p_id => 'c0000000-0000-4000-8000-000000000606', p_venue => 'test:p1-c4',
    p_minutes => 240, p_source => 'manual', p_at => now() - interval '3 hours');
  select * into r from public.extend_checkin('c0000000-0000-4000-8000-000000000606', now() + interval '2 hours');
  perform pg_temp.ok('T15 a private row still extends without a fix',
    not r.location_confirmed and r.expires_at = now() + interval '2 hours', r::text);
  perform public.checkout_venue(null, null, now());
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.ok('T15 block crashed', false, sqlerrm);
end $$;


-- ════ T16 an End or a check-out that arrives first wins ══════════════════
-- E again, at courts Five (40.05) and Six (40.06).
do $$
declare
  r public.venue_checkins;
  s public.play_sessions;
  n int;
begin
  perform pg_temp.as_user(pg_temp.p('E'));
  -- The check-out lands first (its check-in timed out and is still on its way).
  select public.checkout_venue(p_id => 'c0000000-0000-4000-8000-000000000701', p_source => null, p_at => now()) into n;
  perform pg_temp.ok('T16 a check-out of a check-in not stored yet closes nothing', n = 0, n::text);
  perform pg_temp.checkin('E', 'c0000000-0000-4000-8000-000000000702', 'test:p1-c6', 120, 40.0601);
  select * into r from public.checkin_venue(p_id => 'c0000000-0000-4000-8000-000000000701', p_venue => 'test:p1-c5',
    p_minutes => 120, p_source => 'manual', p_at => now() - interval '1 minute',
    p_lat => 40.0501, p_lng => -100.0, p_accuracy_m => 10, p_fix_at => now(), p_fix_age_ms => 1000);
  perform pg_temp.ok('T16 the late check-in lands closed: nothing stored, nothing else closed',
    r.id = 'c0000000-0000-4000-8000-000000000701' and r.checked_out_at is not null
    and not exists (select 1 from public.venue_checkins where id = 'c0000000-0000-4000-8000-000000000701')
    and (select checked_out_at is null from public.venue_checkins where id = 'c0000000-0000-4000-8000-000000000702'),
    r::text);
  -- The End lands first (its Start timed out and is still on its way).
  select public.end_play_session('e0000000-0000-4000-8000-000000000701', now()) into n;
  perform pg_temp.ok('T16 an End of a session not stored yet ends nothing', n = 0, n::text);
  perform public.start_play_session(p_id => 'e0000000-0000-4000-8000-000000000702', p_kind => 'open_play');
  select * into s from public.start_play_session(p_id => 'e0000000-0000-4000-8000-000000000701', p_kind => 'open_play',
    p_venue => 'test:p1-c5', p_at => now() - interval '1 minute',
    p_lat => 40.0501, p_lng => -100.0, p_accuracy_m => 10, p_fix_at => now(), p_fix_age_ms => 1000);
  perform pg_temp.ok('T16 the late Start is stored ended, with no check-in',
    s.id = 'e0000000-0000-4000-8000-000000000701' and s.ended_at is not null
    and not exists (select 1 from public.venue_checkins where id = 'e0000000-0000-4000-8000-000000000701'), s::text);
  perform pg_temp.ok('T16 ...and touches nothing opened since',
    (select ended_at is null from public.play_sessions where id = 'e0000000-0000-4000-8000-000000000702')
    and (select checked_out_at is null from public.venue_checkins where id = 'c0000000-0000-4000-8000-000000000702'));
  perform pg_temp.ok('T16 a replay of the late Start stays ended',
    (public.start_play_session(p_id => 'e0000000-0000-4000-8000-000000000701', p_kind => 'open_play')).ended_at is not null);
  perform public.end_play_session('e0000000-0000-4000-8000-000000000702', now());
  perform public.checkout_venue(null, null, now());
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.ok('T16 block crashed', false, sqlerrm);
end $$;


-- @@VALIDITY@@


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
