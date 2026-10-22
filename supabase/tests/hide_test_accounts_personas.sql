-- ============================================================
-- Hide test accounts from discovery (persona tests for
-- migration_hide_test_accounts.sql).
--
-- NOT runnable on its own: build-hide-test-accounts-test.mjs puts, at the
-- marker line below, migration_hide_test_accounts.sql twice (it must be
-- re-runnable) and then migration_rls_hardening_2026q3.sql (a re-run must keep
-- the new RPCs online). Everything runs inside the begin / rollback below, so
-- the linked (live) database is left untouched:
--   node supabase/tests/build-hide-test-accounts-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary.
--
-- Personas (temporary accounts created inside the transaction; the switch is
-- set explicitly in each pass, whatever live has):
--   HO  an ordinary player (example.invalid email): the viewer who must not
--       see test accounts while the switch is on
--   HN  an ordinary player HO has drilled with (example.invalid)
--   HT  a test account HO has drilled with (@pickleague.test, so the backfill
--       marks it; on a re-run the new-account trigger does)
--   HF  a test account who is HO's friend (@pickleague.test)
--   HV  a test account viewer (@pickleague.test): still sees test accounts
--   HQ  a QA account made AFTER the migration (qa_player_<n>@pickleague.club):
--       the new-account trigger marks it
--   AD  the God mode account (is_godmode_user): still sees everything
-- All of them except HO and HQ are checked in at a temporary court near
-- 41.5 N, 101.5 W (far from every real venue), visible to everyone.
-- ============================================================

begin;

-- ════ Harness ════════════════════════════════════════════════════════════
create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);
grant select, insert on _results to authenticated;
grant usage on sequence _results_n_seq to authenticated;

create temp table _p (k text primary key, id uuid not null);
insert into _p values
  ('HO', 'a6000000-0000-4000-8000-000000000001'), ('HN', 'a6000000-0000-4000-8000-000000000002'),
  ('HT', 'a6000000-0000-4000-8000-000000000003'), ('HF', 'a6000000-0000-4000-8000-000000000004'),
  ('HV', 'a6000000-0000-4000-8000-000000000005'), ('HQ', 'a6000000-0000-4000-8000-000000000006'),
  ('AD', '252a36e1-5d89-4ad2-8a3e-b786579f019a');
grant select on _p to authenticated;

-- Whether app_settings existed before the migration (then its value is live's).
create temp table _pre as select to_regclass('public.app_settings') is not null as had_settings;
grant select on _pre to authenticated;

create function pg_temp.p(text) returns uuid language sql stable as $$ select id from _p where k = $1 $$;

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

-- The database owner, with p's claims: to call the internal helpers (revoked
-- from clients) as if p were signed in.
create function pg_temp.owner_as(p uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
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

-- What viewer k finds, as k. Each leaves the role as k.
create function pg_temp.discovers(k text, who text) returns boolean language plpgsql as $$
declare v boolean;
begin
  perform pg_temp.as_user(pg_temp.p(k));
  select exists (select 1 from public.discover_players(p_min_rating => 77.770, p_max_rating => 77.790) d
                  where d.id = pg_temp.p(who)) into v;
  return v;
end $$;

create function pg_temp.suggested(k text, who text) returns boolean language plpgsql as $$
declare v boolean;
begin
  perform pg_temp.as_user(pg_temp.p(k));
  select exists (select 1 from public.suggest_friends(50) s where s.user_id = pg_temp.p(who)) into v;
  return v;
end $$;

-- For a viewer with a long history (the God mode account on live), `who` can be
-- cut by suggest_friends' 50-row cap: true when k got 50 rows that all
-- outrank p_score, so a miss there says nothing about the filter.
create function pg_temp.suggest_full_above(k text, p_score int) returns boolean language plpgsql as $$
declare v boolean;
begin
  perform pg_temp.as_user(pg_temp.p(k));
  select count(*) = 50 and min(s.score) > p_score from public.suggest_friends(50) s into v;
  return v;
end $$;

-- Whether viewer k sees `who` by name at the test court (court_presence), and
-- how many rows k gets there (named and anonymous), venue_players_here's rows
-- and venue_crowd's here_now.
create function pg_temp.at_court(k text, who text) returns boolean language plpgsql as $$
declare v boolean;
begin
  perform pg_temp.as_user(pg_temp.p(k));
  select exists (select 1 from public.court_presence('test:ht-court') c where c.user_id = pg_temp.p(who)) into v;
  return v;
end $$;

create function pg_temp.court_rows(k text) returns int language plpgsql as $$
declare v int;
begin
  perform pg_temp.as_user(pg_temp.p(k));
  select count(*)::int from public.court_presence('test:ht-court') into v;
  return v;
end $$;

create function pg_temp.here_rows(k text) returns int language plpgsql as $$
declare v int;
begin
  perform pg_temp.as_user(pg_temp.p(k));
  select count(*)::int from public.venue_players_here('test:ht-court') into v;
  return v;
end $$;

create function pg_temp.crowd(k text) returns int language plpgsql as $$
declare v int;
begin
  perform pg_temp.as_user(pg_temp.p(k));
  select c.here_now from public.venue_crowd(array['test:ht-court']) c into v;
  return v;
end $$;

-- plpgsql: the column doesn't exist yet when this is created.
create function pg_temp.flag(k text) returns boolean language plpgsql stable as $$
begin
  return (select is_test_account from public.profiles where id = pg_temp.p(k));
end $$;


-- ════ Setup (before the migration) ══════════════════════════════════════
-- The God mode account exists on live; on a fresh database, make one.
insert into auth.users (id, email, raw_user_meta_data)
values (pg_temp.p('AD'), 'ht-admin@example.invalid', jsonb_build_object('full_name', 'HT Admin'))
on conflict (id) do nothing;

insert into auth.users (id, email, raw_user_meta_data)
select id,
       case k when 'HO' then 'ht-ordinary@example.invalid'
               when 'HN' then 'ht-normal@example.invalid'
               else 'ht-' || lower(k) || '@pickleague.test' end,
       jsonb_build_object('full_name', 'Hide Test ' || k)
  from _p where k in ('HO', 'HN', 'HT', 'HF', 'HV');

-- A rating band no real player has, so discover_players' 500-row cap can't cut them.
update public.profiles set rating = 77.780, drilling_enabled = true
 where id in (select id from _p where k in ('HO', 'HN', 'HT', 'HF', 'HV'));

insert into public.venues (id, sport, name, kind, lat, lng, source, geofence_radius_m) values
  ('test:ht-court', array['pickleball'], 'HT Test Courts', 'court', 41.50, -101.50, 'google', 100);

insert into public.presence_settings (user_id, checkins_level)
select id, 'everyone' from _p where k in ('HN', 'HT', 'HF', 'HV');

insert into public.venue_checkins (user_id, venue_id, expires_at, location_confirmed)
select id, 'test:ht-court', now() + interval '1 hour', true from _p where k in ('HN', 'HT', 'HF', 'HV');

insert into public.friendships (requester_id, addressee_id, status, responded_at) values
  (pg_temp.p('HO'), pg_temp.p('HF'), 'accepted', now());

-- Drilled together (suggest_friends' "Drilled 1x").
insert into public.drill_sessions (player1_id, player2_id, session_date, session_slot) values
  (pg_temp.p('HO'), pg_temp.p('HN'), current_date - 1, 18),
  (pg_temp.p('HT'), pg_temp.p('HO'), current_date - 2, 18),
  -- So the exempt viewers have the test account to be suggested (H4).
  (pg_temp.p('HT'), pg_temp.p('HV'), current_date - 2, 19),
  (pg_temp.p('HT'), pg_temp.p('AD'), current_date - 2, 20);

-- @@MIGRATION@@


-- ════ H0 the flag and the backfill ═══════════════════════════════════════
do $$
begin
  perform pg_temp.as_admin();
  -- A QA account made after the migration: the new-account trigger marks it.
  insert into auth.users (id, email, raw_user_meta_data)
  values (pg_temp.p('HQ'), 'qa_player_9901@pickleague.club', jsonb_build_object('full_name', 'Hide Test HQ'));
  update public.profiles set rating = 77.780 where id = pg_temp.p('HQ');

  perform pg_temp.ok('H0 @pickleague.test accounts are test accounts (HT, HF, HV)',
    pg_temp.flag('HT') and pg_temp.flag('HF') and pg_temp.flag('HV'));
  perform pg_temp.ok('H0 a new qa_player_<n>@pickleague.club account starts marked', pg_temp.flag('HQ'));
  perform pg_temp.ok('H0 ordinary accounts are not (HO, HN)', not pg_temp.flag('HO') and not pg_temp.flag('HN'));
  perform pg_temp.ok('H0 the God mode account is never marked', not pg_temp.flag('AD'));
  perform pg_temp.ok('H0 the setting row exists',
    exists (select 1 from public.app_settings where key = 'hide_test_accounts'));
  perform pg_temp.ok('H0 a first apply leaves the switch off',
    (select had_settings from _pre)
    or (select value = 'false'::jsonb from public.app_settings where key = 'hide_test_accounts'));
end $$;


-- ════ H1 grants and attributes ═══════════════════════════════════════════
do $$
declare
  f text;
begin
  perform pg_temp.as_admin();
  foreach f in array array[
    'public.discover_players(numeric,numeric,uuid[],boolean,boolean,integer,numeric)',
    'public.get_hide_test_accounts()', 'public.set_hide_test_accounts(boolean)',
    'public.get_profile_test_account(uuid)', 'public.set_profile_test_account(uuid,boolean)',
    'public.suggest_friends(integer)', 'public.court_presence(text)',
    'public.venue_players_here(text)', 'public.venue_crowd(text[])'] loop
    perform pg_temp.ok('H1 ' || f || ': authenticated may call it, anon may not (after the hardening re-run)',
      has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute'));
    perform pg_temp.ok('H1 ' || f || ': security definer, search_path ''''',
      (select prosecdef and proconfig = array['search_path=""'] from pg_proc where oid = f::regprocedure));
  end loop;
  foreach f in array array[
    'public._pl_hide_test_accounts_for(uuid)', 'public._pl_test_account_viewer_exempt(uuid)',
    'public.discovery_hidden(uuid)', 'public._pl_is_test_email(uuid)', 'public._pl_venue_crowd(uuid,text)'] loop
    perform pg_temp.ok('H1 ' || f || ': internal, no client may call it',
      not has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute'));
  end loop;
  perform pg_temp.ok('H1 app_settings: no client access',
    not has_table_privilege('authenticated', 'public.app_settings', 'select')
    and not has_table_privilege('anon', 'public.app_settings', 'select')
    and not has_table_privilege('authenticated', 'public.app_settings', 'update'));
  perform pg_temp.ok('H1 app_settings: RLS on',
    (select relrowsecurity from pg_class where oid = 'public.app_settings'::regclass));
end $$;


-- ════ H2 only an admin may read or change it ═════════════════════════════
do $$
declare
  e jsonb;
begin
  perform pg_temp.as_admin();
  update public.app_settings set value = 'false'::jsonb where key = 'hide_test_accounts';

  perform pg_temp.as_user(pg_temp.p('HO'));
  e := pg_temp.err($q$select public.set_hide_test_accounts(true)$q$);
  perform pg_temp.ok('H2 an ordinary player can''t turn it on: pl:admin.only, and the message says why',
    e ->> 'hint' = 'pl:admin.only' and e ->> 'msg' ilike '%admin%', e::text);
  e := pg_temp.err($q$select public.get_hide_test_accounts()$q$);
  perform pg_temp.ok('H2 ... or read it', e ->> 'hint' = 'pl:admin.only', e::text);
  e := pg_temp.err(format('select public.set_profile_test_account(%L, true)', pg_temp.p('HN')));
  perform pg_temp.ok('H2 ... or mark someone', e ->> 'hint' = 'pl:admin.only' and e ->> 'msg' ilike '%admin%', e::text);
  e := pg_temp.err(format('select public.get_profile_test_account(%L)', pg_temp.p('HT')));
  perform pg_temp.ok('H2 ... or read someone''s flag', e ->> 'hint' = 'pl:admin.only', e::text);
  e := pg_temp.err(format('update public.profiles set is_test_account = true where id = %L', pg_temp.p('HO')));
  perform pg_temp.ok('H2 ... or mark themselves through the profiles table', e ->> 'hint' = 'pl:admin.only', e::text);
  e := pg_temp.err($q$select * from public.app_settings$q$);
  perform pg_temp.ok('H2 ... or read app_settings directly', e is not null, e::text);
  e := pg_temp.err(format('update public.profiles set tagline = %L where id = %L', 'still editable', pg_temp.p('HO')));
  perform pg_temp.ok('H2 ... while the rest of their own profile still saves', e is null, e::text);

  perform pg_temp.as_user(pg_temp.p('HV'));
  e := pg_temp.err($q$select public.set_hide_test_accounts(true)$q$);
  perform pg_temp.ok('H2 a test account is no admin either', e ->> 'hint' = 'pl:admin.only', e::text);
  e := pg_temp.err(format('update public.profiles set is_test_account = false where id = %L', pg_temp.p('HV')));
  perform pg_temp.ok('H2 ... and can''t unmark itself', e ->> 'hint' = 'pl:admin.only', e::text);

  perform pg_temp.as_signed_out();
  e := pg_temp.err($q$select public.set_hide_test_accounts(true)$q$);
  perform pg_temp.ok('H2 signed out: pl:auth.signed_out', e ->> 'hint' = 'pl:auth.signed_out', e::text);
  e := pg_temp.err($q$select * from public.discover_players()$q$);
  perform pg_temp.ok('H2 discover_players signed out: pl:auth.signed_out', e ->> 'hint' = 'pl:auth.signed_out', e::text);

  perform pg_temp.as_admin();
  perform pg_temp.ok('H2 ... and nothing changed',
    (select value = 'false'::jsonb from public.app_settings where key = 'hide_test_accounts')
    and not pg_temp.flag('HO') and pg_temp.flag('HV') and not pg_temp.flag('HN'));
end $$;


-- ════ H3 switch off: everyone shows, as before ═══════════════════════════
do $$
begin
  perform pg_temp.as_user(pg_temp.p('AD'));
  perform pg_temp.ok('H3 the admin turns it off', public.set_hide_test_accounts(false) = false);
  perform pg_temp.ok('H3 ... and reads it back off', not public.get_hide_test_accounts());

  perform pg_temp.ok('H3 off: HO finds the test account in player search', pg_temp.discovers('HO', 'HT'));
  perform pg_temp.ok('H3 off: HO finds the ordinary player', pg_temp.discovers('HO', 'HN'));
  perform pg_temp.ok('H3 off: HO finds the QA account', pg_temp.discovers('HO', 'HQ'));
  -- p_near_rating keeps the nearest when the limit cuts, not the first names.
  perform pg_temp.as_admin();
  update public.profiles set rating = 77.789 where id = pg_temp.p('HN');
  perform pg_temp.as_user(pg_temp.p('HO'));
  perform pg_temp.ok('H3 p_near_rating: the nearest player comes first',
    (select d.id from public.discover_players(p_min_rating => 77.770, p_max_rating => 77.790,
                                              p_limit => 1, p_near_rating => 77.789) d) = pg_temp.p('HN'));
  perform pg_temp.ok('H3 no p_near_rating: by name (Hide Test HF before Hide Test HN)',
    (select d.id from public.discover_players(p_min_rating => 77.770, p_max_rating => 77.790,
                                              p_limit => 1) d) = pg_temp.p('HF'));
  perform pg_temp.as_admin();
  update public.profiles set rating = 77.780 where id = pg_temp.p('HN');
  perform pg_temp.ok('H3 off: suggest_friends suggests the test account', pg_temp.suggested('HO', 'HT'));
  perform pg_temp.ok('H3 off: court_presence shows the test account', pg_temp.at_court('HO', 'HT'));
  perform pg_temp.ok('H3 off: court_presence has all 4 rows', pg_temp.court_rows('HO') = 4, pg_temp.court_rows('HO')::text);
  perform pg_temp.ok('H3 off: venue_players_here has all 4 rows', pg_temp.here_rows('HO') = 4, pg_temp.here_rows('HO')::text);
  perform pg_temp.ok('H3 off: venue_crowd counts 4', pg_temp.crowd('HO') = 4, pg_temp.crowd('HO')::text);
  perform pg_temp.owner_as(pg_temp.p('HO'));
  perform pg_temp.ok('H3 off: discovery_hidden(test account) is false', not public.discovery_hidden(pg_temp.p('HT')));
  perform pg_temp.as_admin();
end $$;


-- ════ H4 switch on ═══════════════════════════════════════════════════════
do $$
begin
  perform pg_temp.as_user(pg_temp.p('AD'));
  perform pg_temp.ok('H4 the admin turns it on', public.set_hide_test_accounts(true));
  perform pg_temp.ok('H4 ... and reads it back on', public.get_hide_test_accounts());
  perform pg_temp.as_admin();
  perform pg_temp.ok('H4 ... stamped with who and when',
    (select updated_by = pg_temp.p('AD') and updated_at = now() from public.app_settings where key = 'hide_test_accounts'));

  -- An ordinary viewer.
  perform pg_temp.ok('H4 on: player search leaves the test account out for HO', not pg_temp.discovers('HO', 'HT'));
  perform pg_temp.ok('H4 on: ... and the QA account', not pg_temp.discovers('HO', 'HQ'));
  perform pg_temp.ok('H4 on: ... and the test-account friend (search is for new people)', not pg_temp.discovers('HO', 'HF'));
  perform pg_temp.ok('H4 on: ... but still finds the ordinary player', pg_temp.discovers('HO', 'HN'));
  perform pg_temp.as_user(pg_temp.p('HO'));
  perform pg_temp.ok('H4 on: Find Drillers (p_drilling_only) leaves it out too',
    not exists (select 1 from public.discover_players(p_min_rating => 77.770, p_max_rating => 77.790, p_drilling_only => true) d
                 where d.id = pg_temp.p('HT'))
    and exists (select 1 from public.discover_players(p_min_rating => 77.770, p_max_rating => 77.790, p_drilling_only => true) d
                 where d.id = pg_temp.p('HN')));
  perform pg_temp.ok('H4 on: suggest_friends drops the test account', not pg_temp.suggested('HO', 'HT'));
  perform pg_temp.ok('H4 on: ... and keeps the ordinary player', pg_temp.suggested('HO', 'HN'));
  perform pg_temp.ok('H4 on: court_presence hides the test stranger', not pg_temp.at_court('HO', 'HT'));
  perform pg_temp.ok('H4 on: ... not even an anonymous row: HN, HF only (HV hidden too)',
    pg_temp.court_rows('HO') = 2, pg_temp.court_rows('HO')::text);
  perform pg_temp.ok('H4 on: ... the friend who is a test account still shows', pg_temp.at_court('HO', 'HF'));
  perform pg_temp.ok('H4 on: venue_players_here: HN and HF only', pg_temp.here_rows('HO') = 2, pg_temp.here_rows('HO')::text);
  perform pg_temp.ok('H4 on: venue_crowd counts 2 for HO', pg_temp.crowd('HO') = 2, pg_temp.crowd('HO')::text);
  perform pg_temp.owner_as(pg_temp.p('HO'));
  perform pg_temp.ok('H4 on: discovery_hidden(test account) is true for HO', public.discovery_hidden(pg_temp.p('HT')));
  perform pg_temp.ok('H4 on: discovery_hidden(ordinary player) is false', not public.discovery_hidden(pg_temp.p('HN')));

  -- Friends lists are not discovery.
  perform pg_temp.as_user(pg_temp.p('HO'));
  perform pg_temp.ok('H4 on: list_my_friends still lists the test-account friend',
    exists (select 1 from public.list_my_friends() f where f.user_id = pg_temp.p('HF')));

  -- A test-account viewer sees everything.
  perform pg_temp.ok('H4 on: a test account still finds test accounts', pg_temp.discovers('HV', 'HT'));
  perform pg_temp.ok('H4 on: ... and sees them at the court', pg_temp.at_court('HV', 'HT'));
  perform pg_temp.ok('H4 on: ... all 4 rows', pg_temp.court_rows('HV') = 4, pg_temp.court_rows('HV')::text);
  perform pg_temp.ok('H4 on: ... and counts 4', pg_temp.crowd('HV') = 4, pg_temp.crowd('HV')::text);
  perform pg_temp.ok('H4 on: ... venue_players_here: all 4 rows', pg_temp.here_rows('HV') = 4, pg_temp.here_rows('HV')::text);
  perform pg_temp.ok('H4 on: ... and suggest_friends still suggests the test account', pg_temp.suggested('HV', 'HT'));
  perform pg_temp.owner_as(pg_temp.p('HV'));
  perform pg_temp.ok('H4 on: discovery_hidden is false for a test-account viewer', not public.discovery_hidden(pg_temp.p('HT')));

  -- The admin sees everything.
  perform pg_temp.ok('H4 on: the admin still finds test accounts', pg_temp.discovers('AD', 'HT'));
  perform pg_temp.ok('H4 on: ... and sees them at the court', pg_temp.at_court('AD', 'HT'));
  perform pg_temp.ok('H4 on: ... and counts 4', pg_temp.crowd('AD') = 4, pg_temp.crowd('AD')::text);
  perform pg_temp.ok('H4 on: ... court_presence: all 4 rows', pg_temp.court_rows('AD') = 4, pg_temp.court_rows('AD')::text);
  perform pg_temp.ok('H4 on: ... venue_players_here: all 4 rows', pg_temp.here_rows('AD') = 4, pg_temp.here_rows('AD')::text);
  -- Drilled 1x scores 100; on live the admin's 50 suggestions can all outrank it.
  perform pg_temp.ok('H4 on: ... and suggest_friends still suggests the test account (unless 50 stronger suggestions fill the list)',
    pg_temp.suggested('AD', 'HT') or pg_temp.suggest_full_above('AD', 100));
  perform pg_temp.as_admin();
end $$;


-- ════ H5 marking one account ═════════════════════════════════════════════
do $$
declare
  e jsonb;
begin
  perform pg_temp.as_user(pg_temp.p('AD'));
  perform pg_temp.ok('H5 the admin reads a flag', public.get_profile_test_account(pg_temp.p('HT'))
    and not public.get_profile_test_account(pg_temp.p('HN')));
  perform pg_temp.ok('H5 the admin marks HN', public.set_profile_test_account(pg_temp.p('HN'), true));
  perform pg_temp.ok('H5 ... and reads it back', public.get_profile_test_account(pg_temp.p('HN')));
  perform pg_temp.ok('H5 ... HO stops finding HN', not pg_temp.discovers('HO', 'HN'));
  perform pg_temp.ok('H5 ... or seeing HN at the court', not pg_temp.at_court('HO', 'HN'));

  perform pg_temp.as_user(pg_temp.p('AD'));
  perform pg_temp.ok('H5 the admin unmarks HN', not public.set_profile_test_account(pg_temp.p('HN'), false));
  perform pg_temp.ok('H5 ... HO finds HN again', pg_temp.discovers('HO', 'HN'));

  perform pg_temp.as_user(pg_temp.p('AD'));
  e := pg_temp.err($q$select public.set_profile_test_account('a6000000-0000-4000-8000-0000000000ff', true)$q$);
  perform pg_temp.ok('H5 an unknown account: pl:player.gone', e ->> 'hint' = 'pl:player.gone', e::text);
  e := pg_temp.err($q$select public.get_profile_test_account('a6000000-0000-4000-8000-0000000000ff')$q$);
  perform pg_temp.ok('H5 ... reading it too', e ->> 'hint' = 'pl:player.gone', e::text);
  e := pg_temp.err(format('select public.set_profile_test_account(%L, null)', pg_temp.p('HN')));
  perform pg_temp.ok('H5 no value: pl:request.bad', e ->> 'hint' = 'pl:request.bad', e::text);
  e := pg_temp.err($q$select public.set_hide_test_accounts(null)$q$);
  perform pg_temp.ok('H5 the switch with no value: pl:request.bad', e ->> 'hint' = 'pl:request.bad', e::text);
  perform pg_temp.as_admin();
end $$;


-- ════ H6 not discovery: friend requests already received ════════════════
do $$
begin
  perform pg_temp.as_admin();
  insert into public.friendships (requester_id, addressee_id, status) values (pg_temp.p('HT'), pg_temp.p('HO'), 'pending');
  perform pg_temp.as_user(pg_temp.p('HO'));
  perform pg_temp.ok('H6 on: a friend request from a test account still shows',
    exists (select 1 from public.list_friend_requests() r where r.user_id = pg_temp.p('HT')));
  perform pg_temp.as_admin();
end $$;


-- ════ H7 switch off again: back as before ═══════════════════════════════
do $$
begin
  perform pg_temp.as_user(pg_temp.p('AD'));
  perform pg_temp.ok('H7 the admin turns it off again', not public.set_hide_test_accounts(false));
  perform pg_temp.ok('H7 off: HO finds the test account again', pg_temp.discovers('HO', 'HT'));
  perform pg_temp.ok('H7 off: court_presence has all 4 rows again', pg_temp.court_rows('HO') = 4, pg_temp.court_rows('HO')::text);
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
