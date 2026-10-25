-- ============================================================
-- Closed league privacy persona tests (migration_closed_league_privacy.sql).
--
-- NOT runnable on its own: build-closed-league-privacy-test.mjs puts, at the
-- marker line below, migration_closed_league_privacy.sql twice (it must be
-- re-runnable) and then migration_rls_hardening_2026q3.sql (a re-run must not
-- take the helper or the previews offline). Everything runs inside the
-- begin / rollback below, so the linked (live) database is left untouched:
--   node supabase/tests/build-closed-league-privacy-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary.
--
-- Leagues:  CL  closed, home court "Hidden Test Court" (37.8044, -122.2712)
--           PB  public
--           CX  closed and no longer active (never previewed)
-- Personas (temporary accounts made inside the transaction):
--   AD  CL's creator and admin       MB  a CL member
--   EX  a CL guest whose membership expired
--   OL  played in CL and left it (own standings row and match remain)
--   NM  a signed-in player in no league (the stranger)
--   PA  PB's admin                   GM  godmode (the real godmode account)
--   anon: signed out
-- ============================================================

begin;

-- ════ Harness ════════════════════════════════════════════════════════════
create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);
grant select, insert on _results to authenticated, anon;
grant usage on sequence _results_n_seq to authenticated, anon;

create temp table _p (k text primary key, id uuid not null);
insert into _p values
  ('AD', 'a9100000-0000-4000-8000-000000000001'), ('MB', 'a9100000-0000-4000-8000-000000000002'),
  ('EX', 'a9100000-0000-4000-8000-000000000003'), ('OL', 'a9100000-0000-4000-8000-000000000004'),
  ('NM', 'a9100000-0000-4000-8000-000000000005'), ('PA', 'a9100000-0000-4000-8000-000000000006'),
  ('GM', '252a36e1-5d89-4ad2-8a3e-b786579f019a');
grant select on _p to authenticated, anon;

create function pg_temp.p(text) returns uuid language sql stable as $$ select id from _p where k = $1 $$;
create function pg_temp.cl() returns uuid language sql immutable as $$ select 'b9100000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.pb() returns uuid language sql immutable as $$ select 'b9100000-0000-4000-8000-000000000002'::uuid $$;
create function pg_temp.cx() returns uuid language sql immutable as $$ select 'b9100000-0000-4000-8000-000000000003'::uuid $$;

create function pg_temp.ok(p_test text, p_ok boolean, p_detail text default null) returns void
language sql as $$ insert into _results (test, ok, detail) values (p_test, coalesce(p_ok, false), p_detail) $$;

create function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
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

-- Become persona k ('anon' = signed out).
create function pg_temp.become(k text) returns void language plpgsql as $$
begin
  if k = 'anon' then perform pg_temp.as_anon(); else perform pg_temp.as_user(pg_temp.p(k)); end if;
end $$;

-- The number of rows p_sql returns as persona k; -1 (and the error in
-- _last_err) when it failed.
create temp table _last_err (msg text);
grant select, insert, delete on _last_err to authenticated, anon;
create function pg_temp.cnt(k text, p_sql text) returns integer language plpgsql as $$
declare v integer;
begin
  delete from _last_err;
  perform pg_temp.become(k);
  begin
    execute 'select count(*) from (' || p_sql || ') x' into v;
  exception when others then
    perform pg_temp.as_admin();
    insert into _last_err values (sqlerrm);
    return -1;
  end;
  perform pg_temp.as_admin();
  return v;
end $$;
create function pg_temp.err() returns text language sql stable as $$ select coalesce(max(msg), '') from _last_err $$;

-- One JSON value p_sql returns as persona k; {"error": ...} when it failed.
create function pg_temp.json_as(k text, p_sql text) returns jsonb language plpgsql as $$
declare j jsonb;
begin
  perform pg_temp.become(k);
  begin
    execute p_sql into j;
  exception when others then
    perform pg_temp.as_admin();
    return jsonb_build_object('error', sqlerrm);
  end;
  perform pg_temp.as_admin();
  return j;
end $$;

-- @@MIGRATION@@


-- ════ Setup (after the migrations, so every trigger is live) ═════════════
create temp table _ids (k text primary key, id uuid);
grant select on _ids to authenticated, anon;

do $$
declare
  v_season uuid;
  v_event  uuid;
  v_match  uuid;
begin
  perform pg_temp.as_admin();
  insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
  select id, 'privacy-' || lower(k) || '@pickleague.test', jsonb_build_object('full_name', 'Privacy Player ' || k), now()
    from _p where k <> 'GM';

  insert into public.leagues (id, name, description, is_open, created_by, home_court, home_court_lat, home_court_lng)
  values (pg_temp.cl(), 'Privacy Closed League', 'Members only', false, pg_temp.p('AD'), 'Hidden Test Court', 37.8044, -122.2712),
         (pg_temp.pb(), 'Privacy Public League', 'Everyone welcome', true, pg_temp.p('PA'), 'Open Test Court', 37.70, -122.10),
         (pg_temp.cx(), 'Privacy Closed Inactive', null, false, pg_temp.p('AD'), null, null, null);
  update public.leagues set is_active = false where id = pg_temp.cx();

  insert into public.league_members (league_id, user_id, role, expires_at) values
    (pg_temp.cl(), pg_temp.p('AD'), 'admin', null),
    (pg_temp.cl(), pg_temp.p('MB'), 'member', null),
    (pg_temp.cl(), pg_temp.p('EX'), 'member', now() + interval '1 day'),
    (pg_temp.pb(), pg_temp.p('PA'), 'admin', null),
    (pg_temp.pb(), pg_temp.p('MB'), 'member', null)
  on conflict (league_id, user_id) do nothing;
  -- The guest's membership runs out (set after the insert, in case a trigger
  -- refuses an already-expired row).
  update public.league_members set expires_at = now() - interval '1 hour'
   where league_id = pg_temp.cl() and user_id = pg_temp.p('EX');

  insert into public.league_player_ratings (league_id, user_id, rating)
  values (pg_temp.cl(), pg_temp.p('AD'), 3.5), (pg_temp.cl(), pg_temp.p('MB'), 3.5),
         (pg_temp.cl(), pg_temp.p('OL'), 3.5), (pg_temp.pb(), pg_temp.p('PA'), 3.5)
  on conflict do nothing;

  insert into public.league_seasons (league_id, name, start_date, end_date, total_weeks, lock_frequency_weeks,
                                     status, elo_reset_applied, created_by)
  values (pg_temp.cl(), 'Privacy Season', current_date - 14, current_date + 60, 10, 1, 'active', true, pg_temp.p('AD'))
  returning id into v_season;
  insert into _ids values ('season', v_season);
  insert into public.season_snapshots (season_id, league_id, period_number, snapshot_date, user_id, elo_at_snapshot,
                                       rank_at_snapshot, wins_in_season, losses_in_season)
  values (v_season, pg_temp.cl(), 1, current_date - 7, pg_temp.p('AD'), 4.0, 1, 1, 0),
         (v_season, pg_temp.cl(), 1, current_date - 7, pg_temp.p('OL'), 3.5, 2, 0, 1);
  insert into public.season_final_standings (season_id, league_id, user_id, final_rank, median_rank, elo_bonus, new_elo)
  values (v_season, pg_temp.cl(), pg_temp.p('AD'), 1, 1, 0, 4.0), (v_season, pg_temp.cl(), pg_temp.p('OL'), 2, 2, 0, 3.5);

  insert into public.league_events (league_id, title, created_by, status, vote_ends_at)
  values (pg_temp.cl(), 'Privacy Closed Event', pg_temp.p('AD'), 'voting', now() + interval '2 days')
  returning id into v_event;
  insert into _ids values ('event', v_event);
  insert into public.league_events (league_id, title, created_by, status, vote_ends_at)
  values (pg_temp.pb(), 'Privacy Public Event', pg_temp.p('PA'), 'voting', now() + interval '2 days');

  -- OL played AD in CL (OL's own match), then left CL.
  insert into public.league_members (league_id, user_id, role) values (pg_temp.cl(), pg_temp.p('OL'), 'member')
  on conflict do nothing;
  insert into public.matches (league_id, player1_id, player2_id, player1_score, player2_score, match_type, status, played_at)
  values (pg_temp.cl(), pg_temp.p('AD'), pg_temp.p('OL'), 11, 5, 'singles', 'completed', now() - interval '3 days');
  insert into public.matches (league_id, player1_id, player2_id, player1_score, player2_score, match_type, status, played_at)
  values (pg_temp.cl(), pg_temp.p('AD'), pg_temp.p('MB'), 11, 8, 'singles', 'completed', now() - interval '40 days');
  insert into public.matches (league_id, player1_id, player2_id, player1_score, player2_score, match_type, status, played_at)
  values (pg_temp.pb(), pg_temp.p('PA'), pg_temp.p('MB'), 11, 9, 'singles', 'completed', now() - interval '1 day');
  delete from public.league_members where league_id = pg_temp.cl() and user_id = pg_temp.p('OL');

  insert into public.invite_codes (scope_type, scope_id, created_by, token, expires_at, max_uses, used_count, is_active)
  values ('league', pg_temp.cl(), pg_temp.p('AD'), 'PRIVTESTCL1', now() + interval '7 days', 10, 0, true),
         ('tournament', gen_random_uuid(), pg_temp.p('AD'), 'PRIVTESTTO1', now() + interval '7 days', 10, 0, true);
  insert into public.league_invites (league_id, created_by, token, expires_at, max_uses, used_count, is_active)
  values (pg_temp.cl(), pg_temp.p('AD'), 'privtest-legacy-token', now() + interval '7 days', 10, 0, true);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('SETUP crashed', false, sqlerrm);
end $$;


-- ════ C1 installed the way the house rules want ═════════════════════════
do $$
declare
  v_true text;
  v_conf text[];
  v_def  boolean;
begin
  select string_agg(pol.tablename || '.' || pol.policyname, ', ') into v_true
    from pg_policies pol
   where pol.schemaname = 'public'
     and pol.tablename in ('leagues', 'league_members', 'league_player_ratings', 'league_seasons',
                           'season_snapshots', 'season_final_standings', 'league_events', 'matches')
     and pol.cmd in ('SELECT', 'ALL') and pol.qual = 'true';
  perform pg_temp.ok('C1 no "everyone" SELECT policy is left on the eight league tables', v_true is null, v_true);
  perform pg_temp.ok('C1 the open invite_codes lookup and the legacy token lookup are gone',
    not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'invite_codes' and policyname = 'Invite codes lookup')
    and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'league_invites'
                     and policyname = 'Anyone can look up invite by token'), null);
  perform pg_temp.ok('C1 each table has exactly one "Closed league privacy" policy',
    (select count(*) from pg_policies where schemaname = 'public' and policyname like 'Closed league privacy:%') = 9,
    (select count(*)::text from pg_policies where schemaname = 'public' and policyname like 'Closed league privacy:%'));

  for v_def, v_conf in
    select p.prosecdef, p.proconfig from pg_proc p
     where p.oid in ('public._pl_can_see_league(uuid)'::regprocedure, 'public.get_league_preview(uuid)'::regprocedure,
                     'public.list_league_previews()'::regprocedure)
  loop
    perform pg_temp.ok('C1 a new function is SECURITY DEFINER with search_path pinned to ''''',
      v_def and v_conf @> array['search_path=""'], coalesce(v_conf::text, 'no config'));
  end loop;
  perform pg_temp.ok('C1 the policy helper is executable by anon and authenticated (policies run it as the caller)',
    has_function_privilege('anon', 'public._pl_can_see_league(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public._pl_can_see_league(uuid)', 'execute'), null);
  perform pg_temp.ok('C1 the previews are signed-in only (authenticated yes, anon no)',
    has_function_privilege('authenticated', 'public.get_league_preview(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.list_league_previews()', 'execute')
    and not has_function_privilege('anon', 'public.get_league_preview(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.list_league_previews()', 'execute'), null);
end $$;


-- ════ C2 signed out (the anon key, the OG cards) ═════════════════════════
do $$
declare q text;
begin
  perform pg_temp.ok('C2 anon: the public league is readable',
    pg_temp.cnt('anon', format('select 1 from public.leagues where id = %L', pg_temp.pb())) = 1, pg_temp.err());
  perform pg_temp.ok('C2 anon: the closed league row is not (OG league card falls back)',
    pg_temp.cnt('anon', format('select 1 from public.leagues where id = %L', pg_temp.cl())) = 0, pg_temp.err());
  perform pg_temp.ok('C2 anon: the closed league home court cannot be read by any column filter',
    pg_temp.cnt('anon', 'select 1 from public.leagues where home_court = ''Hidden Test Court''') = 0, pg_temp.err());
  perform pg_temp.ok('C2 anon: the public roster is readable',
    pg_temp.cnt('anon', format('select 1 from public.league_members where league_id = %L', pg_temp.pb())) = 2, pg_temp.err());
  foreach q in array array[
    'league_members', 'league_player_ratings', 'league_seasons', 'season_snapshots', 'season_final_standings',
    'league_events', 'matches']
  loop
    perform pg_temp.ok('C2 anon: no ' || q || ' rows of the closed league',
      pg_temp.cnt('anon', format('select 1 from public.%I where league_id = %L', q, pg_temp.cl())) = 0, pg_temp.err());
  end loop;
  perform pg_temp.ok('C2 anon: the public league''s match and event are readable',
    pg_temp.cnt('anon', format('select 1 from public.matches where league_id = %L', pg_temp.pb())) = 1
    and pg_temp.cnt('anon', format('select 1 from public.league_events where league_id = %L', pg_temp.pb())) = 1, pg_temp.err());
  perform pg_temp.ok('C2 anon: the closed league''s invite code cannot be listed (was: every code, redeemable)',
    pg_temp.cnt('anon', 'select 1 from public.invite_codes where token = ''PRIVTESTCL1''') = 0, pg_temp.err());
  perform pg_temp.ok('C2 anon: a tournament code keeps its open lookup (unchanged; tournaments are a follow-up)',
    pg_temp.cnt('anon', 'select 1 from public.invite_codes where token = ''PRIVTESTTO1''') = 1, pg_temp.err());
  perform pg_temp.ok('C2 anon: the legacy league_invites token is not listable',
    pg_temp.cnt('anon', 'select 1 from public.league_invites where token = ''privtest-legacy-token''') = 0, pg_temp.err());
  perform pg_temp.ok('C2 anon: get_league_preview is refused',
    pg_temp.json_as('anon', format('select to_jsonb(x) from public.get_league_preview(%L) x', pg_temp.cl())) ? 'error', null);
  perform pg_temp.ok('C2 anon: list_league_previews is refused',
    pg_temp.json_as('anon', 'select jsonb_agg(x) from public.list_league_previews() x') ? 'error', null);
  perform pg_temp.ok('C2 anon: the helper answers false for the closed league, true for the public one',
    pg_temp.json_as('anon', format('select to_jsonb(array[public._pl_can_see_league(%L), public._pl_can_see_league(%L)])',
                                   pg_temp.cl(), pg_temp.pb())) = '[false, true]'::jsonb, null);
end $$;


-- ════ C3 a signed-in stranger (NM) ═══════════════════════════════════════
do $$
declare
  q text;
  j jsonb;
begin
  perform pg_temp.ok('C3 stranger: the public league, its roster and match are readable',
    pg_temp.cnt('NM', format('select 1 from public.leagues where id = %L', pg_temp.pb())) = 1
    and pg_temp.cnt('NM', format('select 1 from public.league_members where league_id = %L', pg_temp.pb())) = 2
    and pg_temp.cnt('NM', format('select 1 from public.matches where league_id = %L', pg_temp.pb())) = 1, pg_temp.err());
  perform pg_temp.ok('C3 stranger: the closed league row is not readable',
    pg_temp.cnt('NM', format('select 1 from public.leagues where id = %L', pg_temp.cl())) = 0, pg_temp.err());
  foreach q in array array[
    'league_members', 'league_player_ratings', 'league_seasons', 'season_snapshots', 'season_final_standings',
    'league_events', 'matches']
  loop
    perform pg_temp.ok('C3 stranger: no ' || q || ' rows of the closed league',
      pg_temp.cnt('NM', format('select 1 from public.%I where league_id = %L', q, pg_temp.cl())) = 0, pg_temp.err());
  end loop;
  perform pg_temp.ok('C3 stranger: no closed league invite code',
    pg_temp.cnt('NM', 'select 1 from public.invite_codes where token = ''PRIVTESTCL1''') = 0, pg_temp.err());

  j := pg_temp.json_as('NM', format('select to_jsonb(x) from public.get_league_preview(%L) x', pg_temp.cl()));
  perform pg_temp.ok('C3 stranger: get_league_preview gives name, description, Private and the live member count (expired guest not counted)',
    j ->> 'name' = 'Privacy Closed League' and j ->> 'description' = 'Members only'
    and (j ->> 'is_open')::boolean = false and (j ->> 'member_count')::int = 2, j::text);
  perform pg_temp.ok('C3 stranger: the preview carries match counts (2 completed, 1 in 30 days, 2 days)',
    (j ->> 'match_count')::int = 2 and (j ->> 'recent_match_count')::int = 1 and (j ->> 'play_days')::int = 2, j::text);
  perform pg_temp.ok('C3 stranger: the preview never names the home court, its venue, the admin or the roster',
    not (j ?| array['home_court', 'home_venue_id', 'home_court_lat', 'home_court_lng', 'created_by', 'members'])
    and position('Hidden Test Court' in j::text) = 0, j::text);
  perform pg_temp.ok('C3 stranger: the preview point is rounded to 0.02 degrees (37.80, -122.28), not the court',
    (j ->> 'approx_lat')::numeric = 37.8 and (j ->> 'approx_lng')::numeric = -122.28, j::text);
  j := pg_temp.json_as('NM', 'select jsonb_agg(x.id) from public.list_league_previews() x');
  perform pg_temp.ok('C3 stranger: list_league_previews lists the active closed league, not the public or the inactive one',
    j @> to_jsonb(array[pg_temp.cl()]) and not j @> to_jsonb(array[pg_temp.pb()]) and not j @> to_jsonb(array[pg_temp.cx()]), j::text);
  j := pg_temp.json_as('NM', format('select to_jsonb(x) from public.get_league_preview(%L) x', gen_random_uuid()));
  perform pg_temp.ok('C3 stranger: get_league_preview of an unknown id is empty', j is null, coalesce(j::text, 'null'));

  -- Request to join (the "Request code" / "Want in?" button) still works, and
  -- the stranger reads their own pending request back.
  j := pg_temp.json_as('NM', format('select to_jsonb(x) from public.request_league_join(%L) x', pg_temp.cl()));
  perform pg_temp.ok('C3 stranger: request_league_join on the closed league goes through', not (j ? 'error'), j::text);
  perform pg_temp.ok('C3 stranger: reads their own pending request',
    pg_temp.cnt('NM', format('select 1 from public.league_join_requests where league_id = %L and user_id = %L and status = ''pending''',
                             pg_temp.cl(), pg_temp.p('NM'))) = 1, pg_temp.err());
  perform pg_temp.ok('C3 admin: sees the stranger''s request',
    pg_temp.cnt('AD', format('select 1 from public.league_join_requests where league_id = %L and user_id = %L',
                             pg_temp.cl(), pg_temp.p('NM'))) = 1, pg_temp.err());
end $$;


-- ════ C4 members, the admin, godmode ═════════════════════════════════════
do $$
declare
  k text;
  q text;
  j jsonb;
begin
  foreach k in array array['MB', 'AD', 'GM'] loop
    perform pg_temp.ok('C4 ' || k || ': reads the closed league row with its home court',
      pg_temp.cnt(k, format('select 1 from public.leagues where id = %L and home_court = ''Hidden Test Court''', pg_temp.cl())) = 1,
      pg_temp.err());
    perform pg_temp.ok('C4 ' || k || ': reads the whole closed roster (AD, MB, the expired guest)',
      pg_temp.cnt(k, format('select 1 from public.league_members where league_id = %L', pg_temp.cl())) = 3, pg_temp.err());
    perform pg_temp.ok('C4 ' || k || ': reads seasons, snapshots, final standings, ratings, events and both matches',
      pg_temp.cnt(k, format('select 1 from public.league_seasons where league_id = %L', pg_temp.cl())) = 1
      and pg_temp.cnt(k, format('select 1 from public.season_snapshots where league_id = %L', pg_temp.cl())) = 2
      and pg_temp.cnt(k, format('select 1 from public.season_final_standings where league_id = %L', pg_temp.cl())) = 2
      and pg_temp.cnt(k, format('select 1 from public.league_player_ratings where league_id = %L', pg_temp.cl())) >= 3
      and pg_temp.cnt(k, format('select 1 from public.league_events where league_id = %L', pg_temp.cl())) = 1
      and pg_temp.cnt(k, format('select 1 from public.matches where league_id = %L', pg_temp.cl())) = 2, pg_temp.err());
    j := pg_temp.json_as(k, 'select coalesce(jsonb_agg(x.id), ''[]'') from public.list_league_previews() x');
    perform pg_temp.ok('C4 ' || k || ': list_league_previews leaves out a league they can already see',
      not j @> to_jsonb(array[pg_temp.cl()]), j::text);
  end loop;
  perform pg_temp.ok('C4 MB: a plain member does not see the league''s invite codes',
    pg_temp.cnt('MB', 'select 1 from public.invite_codes where token = ''PRIVTESTCL1''') = 0, pg_temp.err());
  perform pg_temp.ok('C4 AD: the admin sees the league code (InviteCodeManager)',
    pg_temp.cnt('AD', 'select 1 from public.invite_codes where token = ''PRIVTESTCL1''') = 1, pg_temp.err());
  perform pg_temp.ok('C4 MB: still reads the legacy league_invites row as a member',
    pg_temp.cnt('MB', 'select 1 from public.league_invites where token = ''privtest-legacy-token''') = 1, pg_temp.err());
  perform pg_temp.ok('C4 PA: the public league''s admin, a stranger to CL, sees nothing of it',
    pg_temp.cnt('PA', format('select 1 from public.league_members where league_id = %L', pg_temp.cl())) = 0
    and pg_temp.cnt('PA', format('select 1 from public.leagues where id = %L', pg_temp.cl())) = 0, pg_temp.err());
  -- A member's view of the public league is unchanged, and the cross-league
  -- profile read ("leagues you're both in") shows only what the viewer may see.
  perform pg_temp.ok('C4 PA: MB''s memberships as PA shows the public league only (profile "leagues in common")',
    pg_temp.cnt('PA', format('select 1 from public.league_members lm join public.leagues l on l.id = lm.league_id where lm.user_id = %L',
                             pg_temp.p('MB'))) = 1, pg_temp.err());
end $$;


-- ════ C5 expired guest, a player who left ════════════════════════════════
do $$
begin
  perform pg_temp.ok('C5 expired guest: the closed league row is gone',
    pg_temp.cnt('EX', format('select 1 from public.leagues where id = %L', pg_temp.cl())) = 0, pg_temp.err());
  perform pg_temp.ok('C5 expired guest: sees only their own membership row',
    pg_temp.cnt('EX', format('select 1 from public.league_members where league_id = %L', pg_temp.cl())) = 1, pg_temp.err());
  perform pg_temp.ok('C5 left: OL still sees their own final standing, snapshot, rating and match',
    pg_temp.cnt('OL', format('select 1 from public.season_final_standings where league_id = %L', pg_temp.cl())) = 1
    and pg_temp.cnt('OL', format('select 1 from public.season_snapshots where league_id = %L', pg_temp.cl())) = 1
    and pg_temp.cnt('OL', format('select 1 from public.league_player_ratings where league_id = %L', pg_temp.cl())) = 1
    and pg_temp.cnt('OL', format('select 1 from public.matches where league_id = %L', pg_temp.cl())) = 1, pg_temp.err());
  perform pg_temp.ok('C5 left: OL no longer sees the roster, the league, the season or the other match',
    pg_temp.cnt('OL', format('select 1 from public.league_members where league_id = %L', pg_temp.cl())) = 0
    and pg_temp.cnt('OL', format('select 1 from public.leagues where id = %L', pg_temp.cl())) = 0
    and pg_temp.cnt('OL', format('select 1 from public.league_seasons where league_id = %L', pg_temp.cl())) = 0, pg_temp.err());
end $$;


-- ════ C6 flows that write: create, record, redeem ════════════════════════
do $$
declare j jsonb;
begin
  -- LeaguesScreen creates a closed league with insert ... select(): the
  -- creator must read it back before their admin row exists.
  j := pg_temp.json_as('NM', $q$
    with ins as (
      insert into public.leagues (name, is_open, created_by, home_court, home_court_lat, home_court_lng)
      values ('Privacy New Closed', false, (select auth.uid()), 'New Court', 37.9, -122.3)
      returning id, name)
    select to_jsonb(ins) from ins $q$);
  perform pg_temp.ok('C6 a closed league''s creator reads it back in the INSERT ... RETURNING', j ->> 'name' = 'Privacy New Closed', j::text);
  if j ? 'id' then
    j := pg_temp.json_as('NM', format($q$
      with ins as (insert into public.league_members (league_id, user_id, role) values (%L, (select auth.uid()), 'admin') returning id)
      select to_jsonb(count(*)) from ins $q$, j ->> 'id'));
    perform pg_temp.ok('C6 ...and adds themselves as its admin', j = '1'::jsonb, j::text);
  end if;

  -- An old bundle's Join is PostgREST's merge upsert (ON CONFLICT DO UPDATE):
  -- the UPDATE policy's league_members subquery expands the SELECT policy, so
  -- a sublink in it would be "infinite recursion detected in policy".
  j := pg_temp.json_as('PA', format($q$
    with ins as (
      insert into public.league_members (league_id, user_id, role) values (%L, (select auth.uid()), 'admin')
      on conflict (id) do update set role = excluded.role
      returning id)
    select to_jsonb(count(*)) from ins $q$, pg_temp.pb()));
  perform pg_temp.ok('C6 an ON CONFLICT DO UPDATE on league_members is never a policy recursion (old bundle Join)',
    position('recursion' in coalesce(j ->> 'error', '')) = 0, j::text);

  -- A member records a pending match in the closed league and reads it back.
  j := pg_temp.json_as('MB', format($q$
    with ins as (
      insert into public.matches (league_id, player1_id, player2_id, player1_score, player2_score, match_type,
                                  winner_id, winner_team, status)
      values (%L, (select auth.uid()), %L, 11, 6, 'singles', (select auth.uid()), 'team1', 'pending')
      returning id)
    select to_jsonb(count(*)) from ins $q$, pg_temp.cl(), pg_temp.p('AD')));
  perform pg_temp.ok('C6 a member records a match in the closed league and reads it back', j = '1'::jsonb, j::text);

  -- The stranger redeems the league code (the Enter code / push Join path).
  j := pg_temp.json_as('NM', 'select to_jsonb(x) from public.redeem_invite_code(''PRIVTESTCL1'') x');
  perform pg_temp.ok('C6 the stranger redeems the closed league''s code', coalesce((j ->> 'success')::boolean, false), j::text);
  perform pg_temp.ok('C6 ...and now sees the league, its roster and its matches',
    pg_temp.cnt('NM', format('select 1 from public.leagues where id = %L', pg_temp.cl())) = 1
    and pg_temp.cnt('NM', format('select 1 from public.league_members where league_id = %L', pg_temp.cl())) = 4
    and pg_temp.cnt('NM', format('select 1 from public.matches where league_id = %L', pg_temp.cl())) >= 2, pg_temp.err());
  j := pg_temp.json_as('NM', 'select coalesce(jsonb_agg(x.id), ''[]'') from public.list_league_previews() x');
  perform pg_temp.ok('C6 ...and the league leaves their previews', not j @> to_jsonb(array[pg_temp.cl()]), j::text);
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
