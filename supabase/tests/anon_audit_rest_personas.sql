-- ============================================================
-- Signed-out audit, the rest: persona tests (migration_anon_audit_rest.sql).
--
-- NOT runnable on its own: build-anon-audit-rest-test.mjs puts, at the marker
-- line below, migration_anon_audit_rest.sql twice (it must be re-runnable)
-- and then migration_rls_hardening_2026q3.sql (a re-run must leave every
-- grant this file checks). Everything runs inside the begin / rollback below,
-- so the linked (live) database is left untouched:
--   node supabase/tests/build-anon-audit-rest-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary. No row
-- carries personal data: referral codes and gift messages are compared inside
-- SQL (md5), details hold counts, booleans and error messages only.
--
-- Personas (temporary accounts made inside the transaction):
--   NM  a signed-in stranger (also the public-tournament viewer)
--   OW  an owner of a referral code              NU  a new sign-up
--   AD  creates closed league CL and its tournaments (their admin)
--   MB  a CL member                              EX  a CL guest whose
--                                                    membership expired
--   IN  not a CL member, invited to CL's tournament TCL
--   TA  admin of open league PB and its tournament TPB, and of the
--       league-less tournament TNL
--   GS  sends a gift                              GR  receives it
--   GM  godmode (the real godmode account)        SR  the service role
--   anon: signed out
-- ============================================================

begin;

-- The pg_temp helpers below are called by the personas (as anon /
-- authenticated). Since migration_anon_audit_rest.sql, functions postgres
-- creates are no longer EXECUTE-able by PUBLIC by default, so this test
-- transaction (rolled back below) gives the helpers the old default back.
alter default privileges for role postgres grant execute on functions to public;

-- ════ Harness ════════════════════════════════════════════════════════════
create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);
grant select, insert on _results to authenticated, anon, service_role;
grant usage on sequence _results_n_seq to authenticated, anon, service_role;

create temp table _p (k text primary key, id uuid not null);
insert into _p values
  ('NM', 'a7c00000-0000-4000-8000-000000000001'), ('OW', 'a7c00000-0000-4000-8000-000000000002'),
  ('NU', 'a7c00000-0000-4000-8000-000000000003'), ('AD', 'a7c00000-0000-4000-8000-000000000004'),
  ('MB', 'a7c00000-0000-4000-8000-000000000005'), ('EX', 'a7c00000-0000-4000-8000-000000000006'),
  ('IN', 'a7c00000-0000-4000-8000-000000000007'), ('TA', 'a7c00000-0000-4000-8000-000000000008'),
  ('GS', 'a7c00000-0000-4000-8000-000000000009'), ('GR', 'a7c00000-0000-4000-8000-00000000000a'),
  ('GM', '252a36e1-5d89-4ad2-8a3e-b786579f019a');
grant select on _p to authenticated, anon, service_role;

create temp table _ids (k text primary key, id uuid);
grant select on _ids to authenticated, anon, service_role;

create function pg_temp.p(text) returns uuid language sql stable as $$ select id from _p where k = $1 $$;
create function pg_temp.i(text) returns uuid language sql stable as $$ select id from _ids where k = $1 $$;

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
create function pg_temp.as_service() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role": "service_role"}', true);
  perform set_config('role', 'service_role', true);
end $$;
create function pg_temp.as_admin() returns void language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
end $$;
create function pg_temp.become(k text) returns void language plpgsql as $$
begin
  if k = 'anon' then perform pg_temp.as_anon();
  elsif k = 'SR' then perform pg_temp.as_service();
  else perform pg_temp.as_user(pg_temp.p(k));
  end if;
end $$;

-- Rows p_sql returns as persona k; -1 (and the error in _last_err) on failure.
create temp table _last_err (msg text);
grant select, insert, delete on _last_err to authenticated, anon, service_role;
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

-- Run p_sql as persona k: 'ok' or 'err: <message>'.
create function pg_temp.run_as(k text, p_sql text) returns text language plpgsql as $$
begin
  perform pg_temp.become(k);
  begin
    execute p_sql;
  exception when others then
    perform pg_temp.as_admin();
    return 'err: ' || sqlerrm;
  end;
  perform pg_temp.as_admin();
  return 'ok';
end $$;

-- ── Before the migration: what to compare against afterwards ─────────────
-- Function EXECUTE of every role that matters, table privileges, and (md5
-- only) the referral codes, inviters and gift messages still on their old
-- columns (a run after the apply finds the columns gone or empty).
create temp table _pre_fn (oid oid primary key, sig text, auth_x boolean, svc_x boolean, anon_x boolean);
insert into _pre_fn
select p.oid, p.oid::regprocedure::text,
       has_function_privilege('authenticated', p.oid, 'EXECUTE'),
       has_function_privilege('service_role', p.oid, 'EXECUTE'),
       has_function_privilege('anon', p.oid, 'EXECUTE')
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace and p.proowner = 'postgres'::regrole;

create temp table _pre_tab (oid oid primary key, rel text, anon_sel boolean, auth_privs text, svc_privs text);
insert into _pre_tab
select c.oid, c.oid::regclass::text,
       has_table_privilege('anon', c.oid, 'SELECT'),
       concat_ws(',', case when has_table_privilege('authenticated', c.oid, 'SELECT') then 'r' end,
                      case when has_table_privilege('authenticated', c.oid, 'INSERT') then 'a' end,
                      case when has_table_privilege('authenticated', c.oid, 'UPDATE') then 'w' end,
                      case when has_table_privilege('authenticated', c.oid, 'DELETE') then 'd' end),
       concat_ws(',', case when has_table_privilege('service_role', c.oid, 'SELECT') then 'r' end,
                      case when has_table_privilege('service_role', c.oid, 'INSERT') then 'a' end,
                      case when has_table_privilege('service_role', c.oid, 'UPDATE') then 'w' end,
                      case when has_table_privilege('service_role', c.oid, 'DELETE') then 'd' end)
  from pg_class c
 where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm');

create temp table _pre_code (id uuid primary key, h text not null);
create temp table _pre_inv (id uuid primary key, inv uuid not null);
create temp table _pre_gift (id uuid primary key, h text not null);
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'profiles' and column_name = 'referral_code') then
    execute 'insert into _pre_code select id, md5(referral_code) from public.profiles
              where deleted_at is null and nullif(btrim(referral_code), '''') is not null';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'profiles' and column_name = 'invited_by') then
    execute 'insert into _pre_inv select id, invited_by from public.profiles where deleted_at is null and invited_by is not null';
  end if;
end $$;
insert into _pre_gift
select id, md5(gift_message) from public.player_shop_purchases where nullif(btrim(gift_message), '') is not null;

-- @@MIGRATION@@


-- ════ Setup (after the migrations, so every trigger is live) ═════════════
create temp table _setup_err (msg text);
do $$
declare
  v_id uuid;
begin
  perform pg_temp.as_admin();
  insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
  select id, 'rest-audit-' || lower(k) || '@pickleague.test',
         jsonb_build_object('full_name', 'Rest Audit ' || k), now()
    from _p where k not in ('GM', 'NU');

  -- Closed league CL (AD admin, MB member, EX an expired guest member) and
  -- open league PB (TA admin).
  insert into public.leagues (id, name, is_open, created_by)
  values ('b7c00000-0000-4000-8000-000000000001', 'Rest Audit Closed League', false, pg_temp.p('AD')),
         ('b7c00000-0000-4000-8000-000000000002', 'Rest Audit Public League', true, pg_temp.p('TA'));
  insert into _ids values ('CL', 'b7c00000-0000-4000-8000-000000000001'), ('PB', 'b7c00000-0000-4000-8000-000000000002');
  insert into public.league_members (league_id, user_id, role, expires_at) values
    (pg_temp.i('CL'), pg_temp.p('AD'), 'admin', null), (pg_temp.i('CL'), pg_temp.p('MB'), 'member', null),
    (pg_temp.i('CL'), pg_temp.p('EX'), 'member', now() - interval '1 day'),
    (pg_temp.i('PB'), pg_temp.p('TA'), 'admin', null)
  on conflict (league_id, user_id) do update set expires_at = excluded.expires_at;

  insert into public.league_seasons (league_id, name, start_date, end_date, total_weeks, lock_frequency_weeks,
                                     status, elo_reset_applied, created_by)
  values (pg_temp.i('CL'), 'Rest Audit Closed Season', current_date - 14, current_date + 60, 10, 1, 'active', true, pg_temp.p('AD'))
  returning id into v_id;
  insert into _ids values ('CLS', v_id);
  insert into public.league_seasons (league_id, name, start_date, end_date, total_weeks, lock_frequency_weeks,
                                     status, elo_reset_applied, created_by)
  values (pg_temp.i('PB'), 'Rest Audit Public Season', current_date - 14, current_date + 60, 10, 1, 'active', true, pg_temp.p('TA'))
  returning id into v_id;
  insert into _ids values ('PBS', v_id);

  -- Tournaments: TCL (CL's, AD's), TCLR (CL's, request mode, for a
  -- self-registration), TPB (PB's, TA's), TNL (no league, TA's).
  insert into public.tournaments (name, league_id, format, match_type, status, registration_mode, created_by)
  values ('Rest Audit Closed Tournament', pg_temp.i('CL'), 'round_robin', 'singles', 'registration', 'invite_only', pg_temp.p('AD'))
  returning id into v_id;
  insert into _ids values ('TCL', v_id);
  insert into public.tournaments (name, league_id, format, match_type, status, registration_mode, created_by)
  values ('Rest Audit Closed Request Tournament', pg_temp.i('CL'), 'round_robin', 'singles', 'registration', 'request', pg_temp.p('AD'))
  returning id into v_id;
  insert into _ids values ('TCLR', v_id);
  insert into public.tournaments (name, league_id, format, match_type, status, registration_mode, created_by)
  values ('Rest Audit Public Tournament', pg_temp.i('PB'), 'round_robin', 'singles', 'registration', 'request', pg_temp.p('TA'))
  returning id into v_id;
  insert into _ids values ('TPB', v_id);
  insert into public.tournaments (name, league_id, format, match_type, status, registration_mode, created_by)
  values ('Rest Audit Leagueless Tournament', null, 'round_robin', 'singles', 'registration', 'request', pg_temp.p('TA'))
  returning id into v_id;
  insert into _ids values ('TNL', v_id);

  -- Each tournament's rows. TCL: AD admin, MB entrant, IN invited (pending);
  -- EX holds a final rank there but no registration (own rows stay visible).
  insert into public.tournament_registrations (tournament_id, user_id, status, role, invited_by) values
    (pg_temp.i('TCL'), pg_temp.p('AD'), 'approved', 'admin', null),
    (pg_temp.i('TCL'), pg_temp.p('MB'), 'approved', 'member', null),
    (pg_temp.i('TCL'), pg_temp.p('IN'), 'pending', 'member', pg_temp.p('AD')),
    (pg_temp.i('TCLR'), pg_temp.p('AD'), 'approved', 'admin', null),
    (pg_temp.i('TPB'), pg_temp.p('TA'), 'approved', 'admin', null),
    (pg_temp.i('TPB'), pg_temp.p('NM'), 'approved', 'member', null),
    (pg_temp.i('TNL'), pg_temp.p('TA'), 'approved', 'admin', null),
    (pg_temp.i('TNL'), pg_temp.p('NM'), 'approved', 'member', null)
  on conflict do nothing;

  insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
  select t.id, 1, 'Round Robin', 'winners' from public.tournaments t
   where t.id in (pg_temp.i('TCL'), pg_temp.i('TPB'), pg_temp.i('TNL'));
  insert into public.tournament_matches (tournament_id, round_id, match_order, match_type, team1_player1, team2_player1, status)
  select r.tournament_id, r.id, 0, 'singles',
         case when r.tournament_id = pg_temp.i('TCL') then pg_temp.p('AD') else pg_temp.p('TA') end,
         case when r.tournament_id = pg_temp.i('TCL') then pg_temp.p('MB') else pg_temp.p('NM') end,
         'pending'
    from public.tournament_rounds r
   where r.tournament_id in (pg_temp.i('TCL'), pg_temp.i('TPB'), pg_temp.i('TNL'));

  insert into public.mlp_teams (tournament_id, name, captain_id, status)
  values (pg_temp.i('TCL'), 'Rest Audit Closed Team', pg_temp.p('MB'), 'forming') returning id into v_id;
  insert into _ids values ('MCL', v_id);
  insert into public.mlp_teams (tournament_id, name, captain_id, status)
  values (pg_temp.i('TPB'), 'Rest Audit Public Team', pg_temp.p('TA'), 'forming') returning id into v_id;
  insert into _ids values ('MPB', v_id);
  insert into public.mlp_team_join_requests (team_id, user_id, direction, status)
  values (pg_temp.i('MCL'), pg_temp.p('AD'), 'invite', 'pending'), (pg_temp.i('MPB'), pg_temp.p('NM'), 'request', 'pending');

  insert into public.doubles_pairs (tournament_id, name, captain_id, status)
  values (pg_temp.i('TCL'), 'Rest Audit Closed Pair', pg_temp.p('MB'), 'forming') returning id into v_id;
  insert into _ids values ('DCL', v_id);
  insert into public.doubles_pairs (tournament_id, name, captain_id, status)
  values (pg_temp.i('TPB'), 'Rest Audit Public Pair', pg_temp.p('TA'), 'forming') returning id into v_id;
  insert into _ids values ('DPB', v_id);
  insert into public.doubles_pair_join_requests (pair_id, user_id, direction, status)
  values (pg_temp.i('DCL'), pg_temp.p('AD'), 'request', 'pending'), (pg_temp.i('DPB'), pg_temp.p('NM'), 'request', 'pending');

  insert into public.tournament_final_ranks (tournament_id, user_id, final_rank, wins, losses) values
    (pg_temp.i('TCL'), pg_temp.p('AD'), 1, 2, 0), (pg_temp.i('TCL'), pg_temp.p('MB'), 2, 1, 1),
    (pg_temp.i('TCL'), pg_temp.p('EX'), 3, 0, 2),
    (pg_temp.i('TPB'), pg_temp.p('TA'), 1, 1, 0);
  insert into public.tournament_plupr_bonuses (tournament_id, user_id, bonus_value, place)
  values (pg_temp.i('TCL'), pg_temp.p('AD'), 0.1, 1), (pg_temp.i('TPB'), pg_temp.p('TA'), 0.1, 1);
  insert into public.tournament_champion_badges (tournament_id, user_id, place)
  values (pg_temp.i('TCL'), pg_temp.p('AD'), 1), (pg_temp.i('TPB'), pg_temp.p('TA'), 1);

  -- Events: ECL (CL's) and EPB (PB's), one slot each. MB and EX (while still
  -- a member) voted in ECL, AD declined it; NM voted in EPB, TA declined it.
  insert into public.league_events (league_id, title, created_by, status, vote_ends_at)
  values (pg_temp.i('CL'), 'Rest Audit Closed Event', pg_temp.p('AD'), 'voting', now() + interval '2 days')
  returning id into v_id;
  insert into _ids values ('ECL', v_id);
  insert into public.league_events (league_id, title, created_by, status, vote_ends_at)
  values (pg_temp.i('PB'), 'Rest Audit Public Event', pg_temp.p('TA'), 'voting', now() + interval '2 days')
  returning id into v_id;
  insert into _ids values ('EPB', v_id);
  insert into public.event_slots (event_id, starts_at, ends_at)
  values (pg_temp.i('ECL'), now() + interval '3 days', now() + interval '3 days 2 hours') returning id into v_id;
  insert into _ids values ('SCL', v_id);
  insert into public.event_slots (event_id, starts_at, ends_at)
  values (pg_temp.i('EPB'), now() + interval '3 days', now() + interval '3 days 2 hours') returning id into v_id;
  insert into _ids values ('SPB', v_id);
  insert into public.event_slot_votes (slot_id, user_id)
  values (pg_temp.i('SCL'), pg_temp.p('MB')), (pg_temp.i('SCL'), pg_temp.p('EX')), (pg_temp.i('SPB'), pg_temp.p('NM'));
  insert into public.event_declines (event_id, user_id)
  values (pg_temp.i('ECL'), pg_temp.p('AD')), (pg_temp.i('EPB'), pg_temp.p('TA'));

  -- Pickle pots: CL league (AD), CL season (MB), TCL payout (MB); PB league
  -- (TA), TPB payout (NM).
  insert into public.pickle_pot_contributions (scope_type, scope_id, user_id, amount_paid, bonus_amount, pool_added, kind) values
    ('league', pg_temp.i('CL'), pg_temp.p('AD'), 100, 25, 125, 'contribution'),
    ('season', pg_temp.i('CLS'), pg_temp.p('MB'), 100, 25, 125, 'contribution'),
    ('league', pg_temp.i('PB'), pg_temp.p('TA'), 100, 25, 125, 'contribution');
  insert into public.pickle_pot_payouts (scope_type, scope_id, user_id, amount, reason, is_automatic) values
    ('tournament', pg_temp.i('TCL'), pg_temp.p('MB'), 50, 'Rest audit', false),
    ('tournament', pg_temp.i('TPB'), pg_temp.p('NM'), 50, 'Rest audit', false);

  -- Gifts: GS can afford one.
  update public.profiles set pickles = 100000 where id = pg_temp.p('GS');
exception when others then
  perform pg_temp.as_admin();
  insert into _setup_err values (sqlerrm);
end $$;
do $$
begin
  perform pg_temp.ok('SETUP ran', not exists (select 1 from _setup_err), (select max(msg) from _setup_err));
end $$;


-- The tables of item 2, each with a query for the closed row(s) and the
-- public row(s) (%1$s / %2$s: the closed / public entity's id).
create temp table _tq (t text primary key, q text not null, closed_k text not null, public_k text not null);
insert into _tq values
  ('tournaments',                'select 1 from public.tournaments where id = %L',                       'TCL', 'TPB'),
  ('tournament_registrations',   'select 1 from public.tournament_registrations where tournament_id = %L', 'TCL', 'TPB'),
  ('tournament_matches',         'select 1 from public.tournament_matches where tournament_id = %L',       'TCL', 'TPB'),
  ('tournament_rounds',          'select 1 from public.tournament_rounds where tournament_id = %L',        'TCL', 'TPB'),
  ('mlp_teams',                  'select 1 from public.mlp_teams where tournament_id = %L',                'TCL', 'TPB'),
  ('mlp_team_join_requests',     'select 1 from public.mlp_team_join_requests where team_id = %L',         'MCL', 'MPB'),
  ('doubles_pairs',              'select 1 from public.doubles_pairs where tournament_id = %L',            'TCL', 'TPB'),
  ('doubles_pair_join_requests', 'select 1 from public.doubles_pair_join_requests where pair_id = %L',     'DCL', 'DPB'),
  ('tournament_final_ranks',     'select 1 from public.tournament_final_ranks where tournament_id = %L',   'TCL', 'TPB'),
  ('tournament_plupr_bonuses',   'select 1 from public.tournament_plupr_bonuses where tournament_id = %L', 'TCL', 'TPB'),
  ('tournament_champion_badges', 'select 1 from public.tournament_champion_badges where tournament_id = %L', 'TCL', 'TPB'),
  ('event_slots',                'select 1 from public.event_slots where event_id = %L',                   'ECL', 'EPB'),
  ('event_slot_votes',           'select 1 from public.event_slot_votes where slot_id = %L',               'SCL', 'SPB'),
  ('event_declines',             'select 1 from public.event_declines where event_id = %L',                'ECL', 'EPB'),
  ('pickle_pot_contributions',   'select 1 from public.pickle_pot_contributions where scope_id = %L',      'CL',  'PB'),
  ('pickle_pot_payouts',         'select 1 from public.pickle_pot_payouts where scope_id = %L',            'TCL', 'TPB');
grant select on _tq to authenticated, anon, service_role;

-- Closed / public row counts of table t as persona k.
create function pg_temp.closed(k text, t text) returns integer language sql as $$
  select pg_temp.cnt(k, format(q.q, pg_temp.i(q.closed_k))) from _tq q where q.t = $2 $$;
create function pg_temp.public_(k text, t text) returns integer language sql as $$
  select pg_temp.cnt(k, format(q.q, pg_temp.i(q.public_k))) from _tq q where q.t = $2 $$;


-- ════ T0 the policies ════════════════════════════════════════════════════
do $$
declare r record;
begin
  for r in select t from _tq order by t loop
    perform pg_temp.ok('T0 ' || r.t || ': one privacy SELECT policy, no `true` one, no subquery',
      (select count(*) from pg_policies where schemaname = 'public' and tablename = r.t and cmd = 'SELECT'
          and policyname = 'Closed league privacy: ' || r.t and qual !~* '\mselect\M') = 1
      and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = r.t
                        and cmd = 'SELECT' and qual = 'true'));
  end loop;
  perform pg_temp.ok('T0 the six helpers: definer, empty search_path, anon + authenticated + service_role execute',
    (select bool_and(coalesce((select p.prosecdef and array_to_string(p.proconfig, ',') = 'search_path=""'
                                      and has_function_privilege('anon', p.oid, 'EXECUTE')
                                      and has_function_privilege('authenticated', p.oid, 'EXECUTE')
                                      and has_function_privilege('service_role', p.oid, 'EXECUTE')
                                 from pg_proc p where p.oid = to_regprocedure(x.sig)), false))
       from (values ('public._pl_can_see_tournament(uuid)'), ('public._pl_can_see_event(uuid)'),
                    ('public._pl_can_see_event_slot(uuid)'), ('public._pl_can_see_mlp_team(uuid)'),
                    ('public._pl_can_see_doubles_pair(uuid)'), ('public._pl_can_see_pot_scope(text,uuid)')) x(sig)));
end $$;


-- ════ T1 signed out, T2 the stranger: closed rows gone, public ones kept ═
do $$
declare r record; c integer; p integer;
begin
  for r in select t from _tq order by t loop
    c := pg_temp.closed('anon', r.t);
    p := pg_temp.public_('anon', r.t);
    perform pg_temp.ok('T1 anon: ' || r.t || ' - none of the closed league''s, the public one''s readable',
      c = 0 and p >= 1, format('closed %s, public %s %s', c, p, pg_temp.err()));
    c := pg_temp.closed('NM', r.t);
    p := pg_temp.public_('NM', r.t);
    perform pg_temp.ok('T2 stranger: ' || r.t || ' - none of the closed league''s, the public one''s readable',
      c = 0 and p >= 1, format('closed %s, public %s %s', c, p, pg_temp.err()));
  end loop;
  perform pg_temp.ok('T1 anon: the league-less tournament, its registrations and match are readable',
    pg_temp.cnt('anon', format('select 1 from public.tournaments where id = %L', pg_temp.i('TNL'))) = 1
    and pg_temp.cnt('anon', format('select 1 from public.tournament_registrations where tournament_id = %L', pg_temp.i('TNL'))) = 2
    and pg_temp.cnt('anon', format('select 1 from public.tournament_matches where tournament_id = %L', pg_temp.i('TNL'))) = 1,
    pg_temp.err());
  perform pg_temp.ok('T2 stranger: no closed-league tournament in a full listing',
    pg_temp.cnt('NM', format('select 1 from public.tournaments where league_id = %L', pg_temp.i('CL'))) = 0, pg_temp.err());
end $$;


-- ════ T3 member, admin, godmode, service role: everything ════════════════
do $$
declare r record; k text; c integer;
begin
  foreach k in array array['MB', 'AD', 'GM', 'SR'] loop
    for r in select t from _tq order by t loop
      c := pg_temp.closed(k, r.t);
      perform pg_temp.ok('T3 ' || k || ': ' || r.t || ' of the closed league readable', c >= 1,
        format('%s %s', c, pg_temp.err()));
    end loop;
  end loop;
  perform pg_temp.ok('T3 the member sees all three TCL registrations (the invitee''s too)',
    pg_temp.cnt('MB', format('select 1 from public.tournament_registrations where tournament_id = %L', pg_temp.i('TCL'))) = 3,
    pg_temp.err());
end $$;


-- ════ T4 the non-member invitee: the tournament, not the league ══════════
do $$
declare r record; c integer;
begin
  for r in select t from _tq where closed_k in ('TCL', 'MCL', 'DCL') order by t loop
    c := pg_temp.closed('IN', r.t);
    perform pg_temp.ok('T4 invitee: TCL''s ' || r.t || ' readable (they must see the invite)', c >= 1,
      format('%s %s', c, pg_temp.err()));
  end loop;
  for r in select t from _tq where closed_k in ('ECL', 'SCL', 'CL') order by t loop
    c := pg_temp.closed('IN', r.t);
    perform pg_temp.ok('T4 invitee: CL''s ' || r.t || ' still hidden', c = 0, format('%s %s', c, pg_temp.err()));
  end loop;
  perform pg_temp.ok('T4 invitee: the other closed tournament (TCLR) is hidden',
    pg_temp.cnt('IN', format('select 1 from public.tournaments where id = %L', pg_temp.i('TCLR'))) = 0, pg_temp.err());
end $$;


-- ════ T5 the expired guest: own rows only ════════════════════════════════
do $$
begin
  perform pg_temp.ok('T5 expired guest: their own vote, not the other one',
    pg_temp.cnt('EX', format('select 1 from public.event_slot_votes where slot_id = %L', pg_temp.i('SCL'))) = 1
    and pg_temp.cnt('EX', format('select 1 from public.event_slot_votes where slot_id = %L and user_id = %L',
                                 pg_temp.i('SCL'), pg_temp.p('EX'))) = 1, pg_temp.err());
  perform pg_temp.ok('T5 expired guest: the slot and event themselves are hidden',
    pg_temp.cnt('EX', format('select 1 from public.event_slots where event_id = %L', pg_temp.i('ECL'))) = 0
    and pg_temp.cnt('EX', format('select 1 from public.league_events where id = %L', pg_temp.i('ECL'))) = 0, pg_temp.err());
  perform pg_temp.ok('T5 expired guest: their own final rank in TCL, nobody else''s, and not TCL itself',
    pg_temp.cnt('EX', format('select 1 from public.tournament_final_ranks where tournament_id = %L', pg_temp.i('TCL'))) = 1
    and pg_temp.cnt('EX', format('select 1 from public.tournaments where id = %L', pg_temp.i('TCL'))) = 0, pg_temp.err());
  perform pg_temp.ok('T5 own rows: MB sees their TCL payout and CL season contribution',
    pg_temp.cnt('MB', format('select 1 from public.pickle_pot_payouts where user_id = %L', pg_temp.p('MB'))) = 1
    and pg_temp.cnt('MB', format('select 1 from public.pickle_pot_contributions where scope_id = %L', pg_temp.i('CLS'))) = 1,
    pg_temp.err());
  perform pg_temp.ok('T5 the stranger: no CL season pot row',
    pg_temp.cnt('NM', format('select 1 from public.pickle_pot_contributions where scope_id = %L', pg_temp.i('CLS'))) = 0,
    pg_temp.err());
end $$;


-- ════ T6 writes through the new policies (RETURNING, upsert, update) ═════
do $$
declare v text;
begin
  v := pg_temp.run_as('AD', format($q$
    with x as (insert into public.tournaments (name, league_id, format, match_type, status, created_by)
               values ('Rest Audit New Closed Tournament', %L, 'round_robin', 'singles', 'registration', %L)
               returning id) select count(*) from x$q$, pg_temp.i('CL'), pg_temp.p('AD')));
  perform pg_temp.ok('T6 the league admin creates a closed-league tournament with RETURNING (CreateTournamentScreen)',
    v = 'ok' and exists (select 1 from public.tournaments where name = 'Rest Audit New Closed Tournament'), v);
  v := pg_temp.run_as('MB', format($q$
    with x as (insert into public.tournament_registrations (tournament_id, user_id, status, role)
               values (%L, %L, 'pending', 'member') returning id) select count(*) from x$q$,
    pg_temp.i('TCLR'), pg_temp.p('MB')));
  perform pg_temp.ok('T6 a member requests a spot with RETURNING',
    v = 'ok' and exists (select 1 from public.tournament_registrations
                          where tournament_id = pg_temp.i('TCLR') and user_id = pg_temp.p('MB')), v);
  v := pg_temp.run_as('AD', format($q$
    update public.tournament_registrations set seed = 7 where tournament_id = %L and user_id = %L$q$,
    pg_temp.i('TCLR'), pg_temp.p('MB')));
  perform pg_temp.ok('T6 the creator updates a registration (Creator can manage registrations)',
    v = 'ok' and (select seed from public.tournament_registrations
                   where tournament_id = pg_temp.i('TCLR') and user_id = pg_temp.p('MB')) = 7, v);
  v := pg_temp.run_as('MB', format($q$
    insert into public.tournament_registrations (tournament_id, user_id, status, role)
    values (%L, %L, 'pending', 'member')
    on conflict (tournament_id, user_id) do update set status = excluded.status$q$,
    pg_temp.i('TCLR'), pg_temp.p('MB')));
  perform pg_temp.ok('T6 an upsert on registrations raises no policy recursion', v not like '%recursion%', v);
  v := pg_temp.run_as('AD', format($q$
    insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
    values (%L, 2, 'Rest Audit Round 2', 'winners')$q$, pg_temp.i('TCL')));
  perform pg_temp.ok('T6 the creator adds a round (Creator can manage rounds)', v = 'ok', v);
  v := pg_temp.run_as('AD', format($q$
    with x as (insert into public.event_slots (event_id, starts_at, ends_at)
               values (%L, now() + interval '4 days', now() + interval '4 days 1 hour') returning id)
    select count(*) from x$q$, pg_temp.i('ECL')));
  perform pg_temp.ok('T6 the event''s creator adds a slot with RETURNING (CreateEventScreen)', v = 'ok', v);
end $$;


-- ════ T7 the OG card's signed-out reads (mobile/api/_lib/cards.tsx) ══════
do $$
begin
  perform pg_temp.ok('T7 public tournament card: tournament, approved roster with names, matches, teams',
    pg_temp.cnt('anon', format('select id, name, status, format, match_type, start_time, location_name, max_players,
                                       registration_closes_at from public.tournaments where id = %L', pg_temp.i('TPB'))) = 1
    and pg_temp.cnt('anon', format('select r.user_id, p.full_name, p.deleted_at from public.tournament_registrations r
                                      join public.profiles p on p.id = r.user_id
                                     where r.tournament_id = %L and r.status = ''approved''', pg_temp.i('TPB'))) = 2
    and pg_temp.cnt('anon', format('select team1_player1, team2_player1, winner_team from public.tournament_matches
                                     where tournament_id = %L', pg_temp.i('TPB'))) = 1
    and pg_temp.cnt('anon', format('select id, name, captain_id from public.mlp_teams where tournament_id = %L',
                                   pg_temp.i('TPB'))) = 1, pg_temp.err());
  perform pg_temp.ok('T7 public event card: event, slots, votes with names, declines',
    pg_temp.cnt('anon', format('select 1 from public.league_events where id = %L', pg_temp.i('EPB'))) = 1
    and pg_temp.cnt('anon', format('select id, starts_at from public.event_slots where event_id = %L', pg_temp.i('EPB'))) = 1
    and pg_temp.cnt('anon', format('select v.slot_id, p.full_name from public.event_slot_votes v
                                      join public.profiles p on p.id = v.user_id where v.slot_id = %L', pg_temp.i('SPB'))) = 1
    and pg_temp.cnt('anon', format('select user_id from public.event_declines where event_id = %L', pg_temp.i('EPB'))) = 1,
    pg_temp.err());
  perform pg_temp.ok('T7 closed tournament / event card: nothing (the generic card)',
    pg_temp.cnt('anon', format('select 1 from public.tournaments where id = %L', pg_temp.i('TCL'))) = 0
    and pg_temp.cnt('anon', format('select 1 from public.league_events where id = %L', pg_temp.i('ECL'))) = 0, pg_temp.err());
  perform pg_temp.ok('T7 og_card_tz still answers signed out',
    pg_temp.cnt('anon', format('select public.og_card_tz(''tournament'', %L) where public.og_card_tz(''tournament'', %L) is not null',
                               pg_temp.i('TPB'), pg_temp.i('TPB'))) = 1, pg_temp.err());
  perform pg_temp.ok('T7 the profile card''s columns are still readable signed out',
    pg_temp.cnt('anon', format('select id, full_name, tagline, rating, singles_rating, doubles_rating, total_matches_played,
                                       badges_public, is_guest, deleted_at from public.profiles where id = %L', pg_temp.p('TA'))) = 1,
    pg_temp.err());
end $$;


-- ════ F profiles: referral code and inviter owner-only ═══════════════════
do $$
declare
  v_missing integer;
  v_diff    integer;
begin
  perform pg_temp.ok('F0 profiles has neither referral_code nor invited_by; profile_private has both',
    not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles'
                  and column_name in ('referral_code', 'invited_by'))
    and (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'profile_private'
          and column_name in ('referral_code', 'invited_by')) = 2);
  perform pg_temp.ok('F0 codes unique case-insensitively; the old guard trigger gone; the new-profile trigger there',
    exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'profile_private_referral_code_uq')
    and not exists (select 1 from pg_trigger where tgname = 'trg_profiles_referral_guard')
    and to_regprocedure('public._pl_profiles_referral_guard()') is null
    and exists (select 1 from pg_trigger where tgname = 'trg_profiles_private_row'
                  and tgrelid = 'public.profiles'::regclass));

  select count(*) into v_missing from _pre_code pre
    left join public.profile_private pp on pp.id = pre.id where pp.referral_code is null;
  select count(*) into v_diff from _pre_code pre
    join public.profile_private pp on pp.id = pre.id where md5(pp.referral_code) <> pre.h;
  perform pg_temp.ok('F1 every referral code moved unchanged (shared links keep working)',
    v_missing = 0 and v_diff = 0,
    format('%s codes before (0 = already moved), %s missing, %s different', (select count(*) from _pre_code), v_missing, v_diff));
  select count(*) into v_diff from _pre_inv pre
    left join public.profile_private pp on pp.id = pre.id where pp.invited_by is distinct from pre.inv;
  perform pg_temp.ok('F1 every inviter moved unchanged', v_diff = 0,
    format('%s inviters before, %s missing or different', (select count(*) from _pre_inv), v_diff));
  perform pg_temp.ok('F2 every live profile has a code',
    not exists (select 1 from public.profiles p left join public.profile_private pp on pp.id = p.id
                 where p.deleted_at is null and pp.referral_code is null));
end $$;

do $$
declare
  v    text;
  c    text;
  r    jsonb;
  n    integer;
  e    text;
begin
  n := pg_temp.cnt('anon', 'select 1 from public.profile_private');
  perform pg_temp.ok('F3 anon: profile_private refused', n = -1, pg_temp.err());
  n := pg_temp.cnt('anon', 'select referral_code from public.profiles');
  e := pg_temp.err();
  perform pg_temp.ok('F3 anon: profiles.referral_code no longer exists', n = -1 and e like '%referral_code%', e);
  n := pg_temp.cnt('NM', format('select 1 from public.profile_private where id <> %L', pg_temp.p('NM')));
  perform pg_temp.ok('F4 the stranger reads nobody else''s private row', n = 0, n::text || ' ' || pg_temp.err());
  perform pg_temp.ok('F4 ...but their own (with its code)',
    pg_temp.cnt('NM', 'select 1 from public.profile_private where referral_code is not null') = 1, pg_temp.err());

  perform pg_temp.become('OW');
  c := public.my_referral_code();
  perform pg_temp.as_admin();
  perform pg_temp.ok('F5 my_referral_code is the owner''s stored code',
    c is not null and c = (select referral_code from public.profile_private where id = pg_temp.p('OW')));
  v := pg_temp.run_as('OW', format('update public.profile_private set referral_code = ''hacked'' where id = %L', pg_temp.p('OW')));
  perform pg_temp.ok('F5 the owner can''t change their code', v like 'err:%', v);
  v := pg_temp.run_as('OW', format('update public.profile_private set invited_by = %L where id = %L', pg_temp.p('NM'), pg_temp.p('OW')));
  perform pg_temp.ok('F5 ...or their inviter', v like 'err:%', v);
  v := pg_temp.run_as('OW', format('update public.profiles set tagline = ''Rest audit'' where id = %L', pg_temp.p('OW')));
  perform pg_temp.ok('F5 the owner still edits their profile',
    v = 'ok' and (select tagline from public.profiles where id = pg_temp.p('OW')) = 'Rest audit', v);

  -- A new sign-up (confirmed) gets a code at once, then claims OW's.
  insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
  values (pg_temp.p('NU'), 'rest-audit-nu@pickleague.test', jsonb_build_object('full_name', 'Rest Audit NU'), now());
  perform pg_temp.ok('F6 a new sign-up gets a private row with a 10-character code',
    (select length(referral_code) = 10 from public.profile_private where id = pg_temp.p('NU')));

  perform pg_temp.as_anon();
  r := public.referral_preview(upper(c))::jsonb;
  perform pg_temp.as_admin();
  perform pg_temp.ok('F7 referral_preview (anon) resolves the owner''s code', r ->> 'referrer_name' = 'Rest', r::text);
  perform pg_temp.become('NU');
  r := public.claim_referral(c);
  perform pg_temp.as_admin();
  perform pg_temp.ok('F7 the new player claims it: linked, paid, inviter stored privately',
    (r ->> 'linked')::boolean and (r ->> 'rewarded')::boolean
    and (select invited_by from public.profile_private where id = pg_temp.p('NU')) = pg_temp.p('OW'), r::text);
  perform pg_temp.ok('F7 the invitee reads their own inviter; the stranger does not',
    pg_temp.cnt('NU', format('select 1 from public.profile_private where invited_by = %L', pg_temp.p('OW'))) = 1
    and pg_temp.cnt('NM', format('select 1 from public.profile_private where id = %L', pg_temp.p('NU'))) = 0, pg_temp.err());

  perform pg_temp.ok('F8 the replaced referral functions: definer, empty search_path; preview anon, the rest not',
    (select bool_and(coalesce((select p.prosecdef and array_to_string(p.proconfig, ',') = 'search_path=""'
                                 from pg_proc p where p.oid = to_regprocedure(x.sig)), false))
       from (values ('public._pl_link_referral(uuid,text)'), ('public.my_referral_code()'),
                    ('public.referral_preview(text)'), ('public._pl_profile_private_on_profile()'),
                    ('public._pl_shop_gift_message_private()')) x(sig))
    and has_function_privilege('anon', 'public.referral_preview(text)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.my_referral_code()', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.my_referral_code()', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public._pl_link_referral(uuid,text)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public._pl_new_referral_code()', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public._pl_profile_private_on_profile()', 'EXECUTE'));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('F block crashed', false, sqlerrm);
end $$;


-- ════ G gift messages ════════════════════════════════════════════════════
create temp table _gift (purchase_id uuid);
grant select, insert on _gift to authenticated, anon, service_role;
do $$
declare
  v_item uuid;
  v_diff integer;
  v      text;
  r      record;
begin
  perform pg_temp.ok('G0 player_shop_gift_messages: RLS on, anon nothing, authenticated select only, one policy',
    (select c.relrowsecurity from pg_class c where c.oid = 'public.player_shop_gift_messages'::regclass)
    and not has_table_privilege('anon', 'public.player_shop_gift_messages', 'SELECT')
    and not has_table_privilege('anon', 'public.player_shop_gift_messages', 'INSERT')
    and has_table_privilege('authenticated', 'public.player_shop_gift_messages', 'SELECT')
    and not has_table_privilege('authenticated', 'public.player_shop_gift_messages', 'INSERT')
    and not has_table_privilege('authenticated', 'public.player_shop_gift_messages', 'UPDATE')
    and (select count(*) from pg_policies where schemaname = 'public' and tablename = 'player_shop_gift_messages') = 1);
  select count(*) into v_diff from _pre_gift pre
    left join public.player_shop_gift_messages g on g.purchase_id = pre.id
   where g.purchase_id is null or md5(g.message) <> pre.h;
  perform pg_temp.ok('G1 every gift message moved unchanged, and none is left on purchases',
    v_diff = 0 and not exists (select 1 from public.player_shop_purchases where gift_message is not null),
    format('%s messages before (0 = already moved), %s missing or different', (select count(*) from _pre_gift), v_diff));

  select id into v_item from public.shop_items
   where is_active and unlock_badge_id is null and category <> 'real_world'
   order by cost, id limit 1;
  perform pg_temp.become('GS');
  select * into r from public.gift_shop_item(v_item, pg_temp.p('GR'), 'Rest audit gift note');
  perform pg_temp.as_admin();
  insert into _gift select id from public.player_shop_purchases where user_id = pg_temp.p('GR') and shop_item_id = v_item;
  set constraints all immediate;
  perform pg_temp.ok('G2 gift_shop_item: the purchase has no message, the private table has it (FK holds)',
    r.success and (select gift_message is null and gifted_by_user_id = pg_temp.p('GS')
                     from public.player_shop_purchases where id = (select purchase_id from _gift))
    and (select sender_id = pg_temp.p('GS') and recipient_id = pg_temp.p('GR') and message = 'Rest audit gift note'
           from public.player_shop_gift_messages where purchase_id = (select purchase_id from _gift)),
    coalesce(r.message, 'no item'));
  set constraints all deferred;
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('G block crashed', false, sqlerrm);
end $$;

do $$
declare
  q text := format('select 1 from public.player_shop_gift_messages where purchase_id = %L', (select purchase_id from _gift));
  qp text := format('select 1 from public.player_shop_purchases where id = %L', (select purchase_id from _gift));
  v text;
begin
  perform pg_temp.ok('G3 the recipient and the sender read the message',
    pg_temp.cnt('GR', q) = 1 and pg_temp.cnt('GS', q) = 1, pg_temp.err());
  perform pg_temp.ok('G3 the stranger does not; anon is refused',
    pg_temp.cnt('NM', q) = 0 and pg_temp.cnt('anon', q) = -1, pg_temp.err());
  perform pg_temp.ok('G4 the stranger sees the (shown) purchase, with no message on it',
    pg_temp.cnt('NM', qp || ' and gift_message is null') = 1, pg_temp.err());
  v := pg_temp.run_as('GR', format('select public.set_purchase_hidden(%L, true)', (select purchase_id from _gift)));
  perform pg_temp.ok('G4 hidden: the stranger no longer lists it; the recipient and the giver still do',
    v = 'ok' and pg_temp.cnt('NM', qp) = 0 and pg_temp.cnt('GR', qp) = 1 and pg_temp.cnt('GS', qp) = 1,
    v || ' ' || pg_temp.err());
  perform pg_temp.ok('G5 anon lists no purchases at all',
    pg_temp.cnt('anon', 'select 1 from public.player_shop_purchases') = 0, pg_temp.err());
  -- A writer that still sets gift_message (an old function, the service role).
  v := pg_temp.run_as('SR', format($q$
    update public.player_shop_purchases set gift_message = 'Rest audit edited note' where id = %L$q$,
    (select purchase_id from _gift)));
  perform pg_temp.ok('G6 a later write to gift_message lands in the private table, the column stays null',
    v = 'ok'
    and (select gift_message is null from public.player_shop_purchases where id = (select purchase_id from _gift))
    and (select message = 'Rest audit edited note' from public.player_shop_gift_messages
          where purchase_id = (select purchase_id from _gift)), v);
end $$;


-- ════ W wagers, X is_godmode_user(uuid) ══════════════════════════════════
do $$
declare v text;
begin
  perform pg_temp.ok('W0 get_my_wagers_with_details / calculate_wager_odds: anon no, authenticated and service_role yes',
    not has_function_privilege('anon', 'public.get_my_wagers_with_details()', 'EXECUTE')
    and not has_function_privilege('anon', 'public.calculate_wager_odds(text,uuid,jsonb)', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.get_my_wagers_with_details()', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.calculate_wager_odds(text,uuid,jsonb)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.get_my_wagers_with_details()', 'EXECUTE')
    and has_function_privilege('service_role', 'public.calculate_wager_odds(text,uuid,jsonb)', 'EXECUTE'));
  v := pg_temp.run_as('anon', format('select * from public.calculate_wager_odds(''tournament_rank'', %L, %L::jsonb)',
                                     pg_temp.i('TPB'), json_build_object('user_id', pg_temp.p('TA'), 'rank', 1)));
  perform pg_temp.ok('W1 signed out: calculate_wager_odds refused', v like 'err:%permission%', v);
  v := pg_temp.run_as('anon', 'select * from public.get_my_wagers_with_details()');
  perform pg_temp.ok('W1 signed out: get_my_wagers_with_details refused', v like 'err:%permission%', v);
  perform pg_temp.ok('W2 signed in: both still work',
    pg_temp.cnt('NM', format('select * from public.calculate_wager_odds(''tournament_rank'', %L, %L::jsonb)',
                             pg_temp.i('TPB'), json_build_object('user_id', pg_temp.p('TA'), 'rank', 1))) = 1
    and pg_temp.cnt('NM', 'select * from public.get_my_wagers_with_details()') = 0, pg_temp.err());

  perform pg_temp.ok('X0 is_godmode_user(uuid): anon no, authenticated and service_role yes',
    not has_function_privilege('anon', 'public.is_godmode_user(uuid)', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.is_godmode_user(uuid)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.is_godmode_user(uuid)', 'EXECUTE'));
  v := pg_temp.run_as('anon', format('select public.is_godmode_user(%L::uuid)', pg_temp.p('GM')));
  perform pg_temp.ok('X1 signed out: refused', v like 'err:%permission%', v);
  perform pg_temp.ok('X2 signed in: answers',
    pg_temp.cnt('NM', format('select 1 where public.is_godmode_user(%L::uuid)', pg_temp.p('GM'))) = 1, pg_temp.err());
  perform pg_temp.ok('X3 no policy evaluated for anon or PUBLIC calls is_godmode_user(uuid)',
    not exists (select 1 from pg_depend d join pg_policy pol on pol.oid = d.objid
                 where d.classid = 'pg_policy'::regclass
                   and d.refobjid = 'public.is_godmode_user(uuid)'::regprocedure
                   and (0::oid = any (pol.polroles) or 'anon'::regrole::oid = any (pol.polroles))));
end $$;


-- ════ S the sweep ════════════════════════════════════════════════════════
do $$
declare
  v_names text;
  v_n     integer;
  v       text;
begin
  select string_agg(p.proname, ',' order by p.proname) into v_names
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proowner = 'postgres'::regrole
     and has_function_privilege('anon', p.oid, 'EXECUTE');
  perform pg_temp.ok('S1 anon executes exactly the signed-out allowlist',
    v_names = '_pl_can_see_doubles_pair,_pl_can_see_event,_pl_can_see_event_slot,_pl_can_see_league,'
              || '_pl_can_see_mlp_team,_pl_can_see_pot_scope,_pl_can_see_tournament,analytics_touch,'
              || 'get_guest_invite_preview,is_scope_admin,og_card_tz,referral_preview', v_names);
  select count(*) into v_n from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proowner = 'postgres'::regrole
     and (p.proacl is null or exists (select 1 from aclexplode(p.proacl) x where x.grantee = 0));
  perform pg_temp.ok('S2 no public function grants EXECUTE to PUBLIC', v_n = 0, v_n::text);
  select count(*), string_agg(pre.sig, ' ; ') into v_n, v_names from _pre_fn pre
    join pg_proc p on p.oid = pre.oid
   where (pre.auth_x and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
          and pre.sig not in ('_pl_new_referral_code()', '_pl_profile_private_on_profile()', '_pl_shop_gift_message_private()'))
      or (pre.svc_x and not has_function_privilege('service_role', p.oid, 'EXECUTE'));
  perform pg_temp.ok('S3 authenticated and service_role keep every function they could run', v_n = 0,
    coalesce(v_names, ''));
  select count(*), string_agg(c.relname, ',') into v_n, v_names from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm')
     and c.relname not in ('analytics_events', 'analytics_sessions')
     and (has_table_privilege('anon', c.oid, 'INSERT') or has_table_privilege('anon', c.oid, 'UPDATE')
          or has_table_privilege('anon', c.oid, 'DELETE') or has_table_privilege('anon', c.oid, 'TRUNCATE')
          or has_any_column_privilege('anon', c.oid, 'INSERT') or has_any_column_privilege('anon', c.oid, 'UPDATE'));
  perform pg_temp.ok('S4 anon writes to no public table but the two analytics ones', v_n = 0, coalesce(v_names, ''));
  perform pg_temp.ok('S4 anon still inserts into analytics_events and analytics_sessions',
    has_table_privilege('anon', 'public.analytics_events', 'INSERT')
    and has_table_privilege('anon', 'public.analytics_sessions', 'INSERT'));
  select count(*), string_agg(pre.rel, ',') into v_n, v_names from _pre_tab pre
   where pre.anon_sel is distinct from has_table_privilege('anon', pre.oid, 'SELECT');
  perform pg_temp.ok('S5 anon SELECT is unchanged on every table', v_n = 0, coalesce(v_names, ''));
  select count(*), string_agg(pre.rel, ',') into v_n, v_names from _pre_tab pre
   where pre.auth_privs <> concat_ws(',', case when has_table_privilege('authenticated', pre.oid, 'SELECT') then 'r' end,
                                          case when has_table_privilege('authenticated', pre.oid, 'INSERT') then 'a' end,
                                          case when has_table_privilege('authenticated', pre.oid, 'UPDATE') then 'w' end,
                                          case when has_table_privilege('authenticated', pre.oid, 'DELETE') then 'd' end)
      or pre.svc_privs <> concat_ws(',', case when has_table_privilege('service_role', pre.oid, 'SELECT') then 'r' end,
                                         case when has_table_privilege('service_role', pre.oid, 'INSERT') then 'a' end,
                                         case when has_table_privilege('service_role', pre.oid, 'UPDATE') then 'w' end,
                                         case when has_table_privilege('service_role', pre.oid, 'DELETE') then 'd' end);
  perform pg_temp.ok('S5 authenticated and service_role table privileges are unchanged', v_n = 0, coalesce(v_names, ''));
  select count(*) into v_n from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind = 'S'
     and (has_sequence_privilege('anon', c.oid, 'USAGE') or has_sequence_privilege('anon', c.oid, 'UPDATE'));
  perform pg_temp.ok('S5 anon uses no public sequence', v_n = 0, v_n::text);

  -- New objects get the new defaults.
  create function public._rest_audit_probe() returns integer language sql as 'select 1';
  create table public._rest_audit_probe (id integer);
  perform pg_temp.ok('S6 a new function: authenticated and service_role yes, anon and PUBLIC no',
    has_function_privilege('authenticated', 'public._rest_audit_probe()', 'EXECUTE')
    and has_function_privilege('service_role', 'public._rest_audit_probe()', 'EXECUTE')
    and not has_function_privilege('anon', 'public._rest_audit_probe()', 'EXECUTE')
    and not exists (select 1 from pg_proc p, aclexplode(p.proacl) x
                     where p.oid = 'public._rest_audit_probe()'::regprocedure and x.grantee = 0));
  perform pg_temp.ok('S6 a new table: anon SELECT only; authenticated keeps its writes',
    has_table_privilege('anon', 'public._rest_audit_probe', 'SELECT')
    and not has_table_privilege('anon', 'public._rest_audit_probe', 'INSERT')
    and not has_table_privilege('anon', 'public._rest_audit_probe', 'UPDATE')
    and not has_table_privilege('anon', 'public._rest_audit_probe', 'DELETE')
    and has_table_privilege('authenticated', 'public._rest_audit_probe', 'INSERT'));
  drop function public._rest_audit_probe();
  drop table public._rest_audit_probe;

  -- The signed-out paths still work.
  v := pg_temp.run_as('anon', $q$
    insert into public.analytics_sessions (id, app, is_guest, platform)
    values ('c7c00000-0000-4000-8000-000000000001', 'pickleague', true, 'web');
    insert into public.analytics_events (app, name, props, session_id)
    values ('pickleague', 'rest.audit', '{}'::jsonb, 'c7c00000-0000-4000-8000-000000000001');
    select public.analytics_touch('c7c00000-0000-4000-8000-000000000001', '/rest-audit')$q$);
  perform pg_temp.ok('S7 signed-out analytics: session row, event row, heartbeat', v = 'ok', v);
  v := pg_temp.run_as('anon', $q$
    select public.referral_preview('no-such-code'), public.og_card_tz('event', gen_random_uuid());
    select * from public.get_guest_invite_preview('NO-SUCH-TOKEN')$q$);
  perform pg_temp.ok('S8 signed out: referral_preview, og_card_tz, get_guest_invite_preview answer', v = 'ok', v);
  v := pg_temp.run_as('anon', $q$select public.analytics_claim('c7c00000-0000-4000-8000-000000000001')$q$);
  perform pg_temp.ok('S8 signed out: analytics_claim refused (it needs a user)', v like 'err:%permission%', v);
  v := pg_temp.run_as('anon', $q$select public.search_venues('park', 37.0, -122.0, null, 5)$q$);
  perform pg_temp.ok('S8 signed out: an ordinary RPC (search_venues) refused', v like 'err:%permission%', v);
  v := pg_temp.run_as('anon', format('update public.profiles set tagline = ''x'' where id = %L', pg_temp.p('NM')));
  perform pg_temp.ok('S8 signed out: no table write (profiles)', v like 'err:%permission%', v);
  v := pg_temp.run_as('anon', format($q$insert into public.event_slot_votes (slot_id, user_id) values (%L, %L)$q$,
                                     pg_temp.i('SPB'), pg_temp.p('NM')));
  perform pg_temp.ok('S8 signed out: no table write (event_slot_votes)', v like 'err:%permission%', v);
  perform pg_temp.ok('S9 default privileges: postgres''s functions give PUBLIC nothing, public ones give anon nothing',
    exists (select 1 from pg_default_acl d
             where d.defaclrole = 'postgres'::regrole and d.defaclnamespace = 0 and d.defaclobjtype = 'f'
               and not exists (select 1 from aclexplode(d.defaclacl) x where x.grantee = 0))
    and not exists (select 1 from pg_default_acl d, aclexplode(d.defaclacl) x
                     where d.defaclrole = 'postgres'::regrole and d.defaclnamespace = 'public'::regnamespace
                       and d.defaclobjtype in ('f', 'S') and x.grantee = 'anon'::regrole::oid));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('S block crashed', false, sqlerrm);
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
