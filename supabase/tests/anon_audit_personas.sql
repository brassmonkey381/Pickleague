-- ============================================================
-- Signed-out audit fixes persona tests (migration_anon_audit_fixes.sql).
--
-- NOT runnable on its own: build-anon-audit-test.mjs puts, at the marker line
-- below, migration_anon_audit_fixes.sql twice (it must be re-runnable) and
-- then migration_rls_hardening_2026q3.sql (a re-run must leave every RPC as
-- this file grants it). Everything runs inside the begin / rollback below, so
-- the linked (live) database is left untouched:
--   node supabase/tests/build-anon-audit-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary. No row ever
-- carries a phone number: phones are compared inside SQL (md5 for the real
-- ones), and details hold counts and booleans only.
--
-- Personas (temporary accounts made inside the transaction):
--   OW  an account with a phone (the owner)     NM  a signed-in stranger
--   GU  a guest (anonymous sign-in) who redeems a guest invite, then upgrades
--   TA  creates tournament T (its admin)         CA  T's co-admin registrant
--   X1..X3  T's other entrants (X1 a plain member)
--   AD  admin of closed league CL                MB  a CL member
--   GM  godmode (the real godmode account)       SR  the service role
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
  ('OW', 'a7a00000-0000-4000-8000-000000000001'), ('NM', 'a7a00000-0000-4000-8000-000000000002'),
  ('GU', 'a7a00000-0000-4000-8000-000000000003'), ('TA', 'a7a00000-0000-4000-8000-000000000004'),
  ('CA', 'a7a00000-0000-4000-8000-000000000005'), ('X1', 'a7a00000-0000-4000-8000-000000000006'),
  ('X2', 'a7a00000-0000-4000-8000-000000000007'), ('X3', 'a7a00000-0000-4000-8000-000000000008'),
  ('AD', 'a7a00000-0000-4000-8000-000000000009'), ('MB', 'a7a00000-0000-4000-8000-00000000000a'),
  ('GM', '252a36e1-5d89-4ad2-8a3e-b786579f019a');
grant select on _p to authenticated, anon, service_role;

create temp table _ids (k text primary key, id uuid);
grant select on _ids to authenticated, anon, service_role;

create function pg_temp.p(text) returns uuid language sql stable as $$ select id from _p where k = $1 $$;
create function pg_temp.i(text) returns uuid language sql stable as $$ select id from _ids where k = $1 $$;

create function pg_temp.ok(p_test text, p_ok boolean, p_detail text default null) returns void
language sql as $$ insert into _results (test, ok, detail) values (p_test, coalesce(p_ok, false), p_detail) $$;

create function pg_temp.as_user(p uuid, p_anonymous boolean default false) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p, 'role', 'authenticated', 'is_anonymous', p_anonymous)::text, true);
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

-- Become persona k ('anon' = signed out, 'SR' = service role, 'GU' = the guest).
create function pg_temp.become(k text) returns void language plpgsql as $$
begin
  if k = 'anon' then perform pg_temp.as_anon();
  elsif k = 'SR' then perform pg_temp.as_service();
  elsif k = 'GU' then perform pg_temp.as_user(pg_temp.p(k), true);
  else perform pg_temp.as_user(pg_temp.p(k));
  end if;
end $$;

-- The number of rows p_sql returns as persona k; -1 (and the error in
-- _last_err) when it failed.
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

-- Run p_sql (a statement) as persona k: 'ok' or 'err: <message>'.
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

-- generate_playoff_bracket(T) as persona k, undone afterwards (so the next
-- persona finds no playoff yet): 'ok:<matches made>' or 'err: <message>'.
create function pg_temp.try_playoff(k text) returns text language plpgsql as $$
declare
  v_n   integer;
  v_res text;
begin
  begin
    perform pg_temp.become(k);
    v_n := public.generate_playoff_bracket(pg_temp.i('T'));
    v_res := 'ok:' || v_n;
    raise exception 'pl_test_undo';
  exception when others then
    if sqlerrm <> 'pl_test_undo' then v_res := 'err: ' || sqlerrm; end if;
  end;
  perform pg_temp.as_admin();
  return v_res;
end $$;

-- The phones on profiles before the migration (ids and md5s only; the
-- column is gone on a run after the apply, and then this stays empty).
create temp table _pre_phone (id uuid primary key, h text not null);
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'profiles' and column_name = 'phone') then
    execute 'insert into _pre_phone select id, md5(btrim(phone)) from public.profiles where nullif(btrim(phone), '''') is not null';
  end if;
end $$;

-- @@MIGRATION@@


-- ════ Setup (after the migrations, so every trigger is live) ═════════════
do $$
declare
  v_id uuid;
begin
  perform pg_temp.as_admin();
  insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at, is_anonymous)
  select id,
         case when k = 'GU' then null else 'audit-' || lower(k) || '@pickleague.test' end,
         jsonb_build_object('full_name', 'Audit Player ' || k),
         case when k = 'GU' then null else now() end,
         k = 'GU'
    from _p where k <> 'GM';

  -- OW's phone (a reserved fake number).
  -- An upsert: since migration_anon_audit_rest.sql every profile gets its
  -- private row (with a referral code) at sign-up.
  insert into public.profile_private (id, phone) values (pg_temp.p('OW'), '+15550100009')
  on conflict (id) do update set phone = excluded.phone;

  -- Closed league CL (AD admin, MB member) and open league PB (TA admin).
  insert into public.leagues (id, name, is_open, created_by)
  values ('b7a00000-0000-4000-8000-000000000001', 'Audit Closed League', false, pg_temp.p('AD')),
         ('b7a00000-0000-4000-8000-000000000002', 'Audit Public League', true, pg_temp.p('TA'));
  insert into _ids values ('CL', 'b7a00000-0000-4000-8000-000000000001'), ('PB', 'b7a00000-0000-4000-8000-000000000002');
  insert into public.league_members (league_id, user_id, role) values
    (pg_temp.i('CL'), pg_temp.p('AD'), 'admin'), (pg_temp.i('CL'), pg_temp.p('MB'), 'member'),
    (pg_temp.i('PB'), pg_temp.p('TA'), 'admin')
  on conflict (league_id, user_id) do nothing;

  insert into public.league_seasons (league_id, name, start_date, end_date, total_weeks, lock_frequency_weeks,
                                     status, elo_reset_applied, created_by)
  values (pg_temp.i('CL'), 'Audit Closed Season', current_date - 14, current_date + 60, 10, 1, 'active', true, pg_temp.p('AD'))
  returning id into v_id;
  insert into _ids values ('CLS', v_id);
  insert into public.league_seasons (league_id, name, start_date, end_date, total_weeks, lock_frequency_weeks,
                                     status, elo_reset_applied, created_by)
  values (pg_temp.i('PB'), 'Audit Public Season', current_date - 14, current_date + 60, 10, 1, 'active', true, pg_temp.p('TA'))
  returning id into v_id;
  insert into _ids values ('PBS', v_id);

  -- Tournament T (no league): round robin, top 2, TA's; CA co-admin; four
  -- entrants with every group match played.
  insert into public.tournaments (name, format, match_type, playoff_format, status, created_by)
  values ('Audit Tournament', 'round_robin', 'singles', 'top_2', 'registration', pg_temp.p('TA'))
  returning id into v_id;
  insert into _ids values ('T', v_id);
  insert into public.tournament_registrations (tournament_id, user_id, status, seed, role)
  values (v_id, pg_temp.p('TA'), 'approved', 1, 'admin'), (v_id, pg_temp.p('X1'), 'approved', 2, 'member'),
         (v_id, pg_temp.p('X2'), 'approved', 3, 'member'), (v_id, pg_temp.p('X3'), 'approved', 4, 'member'),
         (v_id, pg_temp.p('CA'), 'approved', 5, 'co-admin')
  on conflict do nothing;
  update public.tournament_registrations set role = 'co-admin' where tournament_id = v_id and user_id = pg_temp.p('CA');
  update public.tournaments set status = 'active' where id = v_id;
  insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
  values (v_id, 1, 'Round Robin', 'winners') returning id into v_id;
  insert into public.tournament_matches (tournament_id, round_id, match_order, match_type,
                                         team1_player1, team2_player1, team1_score, team2_score, winner_team, status)
  values (pg_temp.i('T'), v_id, 0, 'singles', pg_temp.p('TA'), pg_temp.p('X1'), 11, 5, 'team1', 'completed'),
         (pg_temp.i('T'), v_id, 1, 'singles', pg_temp.p('TA'), pg_temp.p('X2'), 11, 5, 'team1', 'completed'),
         (pg_temp.i('T'), v_id, 2, 'singles', pg_temp.p('TA'), pg_temp.p('X3'), 11, 5, 'team1', 'completed'),
         (pg_temp.i('T'), v_id, 3, 'singles', pg_temp.p('X1'), pg_temp.p('X2'), 11, 5, 'team1', 'completed'),
         (pg_temp.i('T'), v_id, 4, 'singles', pg_temp.p('X1'), pg_temp.p('X3'), 11, 5, 'team1', 'completed'),
         (pg_temp.i('T'), v_id, 5, 'singles', pg_temp.p('X2'), pg_temp.p('X3'), 11, 5, 'team1', 'completed');

  -- Tournament T2 (registration open) with an invite code; PB's code too.
  insert into public.tournaments (name, format, match_type, status, created_by)
  values ('Audit Open Tournament', 'round_robin', 'singles', 'registration', pg_temp.p('TA'))
  returning id into v_id;
  insert into _ids values ('T2', v_id);
  insert into public.tournament_registrations (tournament_id, user_id, status, role)
  values (v_id, pg_temp.p('TA'), 'approved', 'admin'), (v_id, pg_temp.p('CA'), 'approved', 'co-admin'),
         (v_id, pg_temp.p('X1'), 'approved', 'member')
  on conflict do nothing;
  update public.tournament_registrations set role = 'co-admin' where tournament_id = v_id and user_id = pg_temp.p('CA');
  insert into public.invite_codes (scope_type, scope_id, created_by, token, expires_at, max_uses, used_count, is_active)
  values ('tournament', v_id, pg_temp.p('TA'), 'AUDITTOUR01', now() + interval '7 days', 10, 0, true),
         ('league', pg_temp.i('PB'), pg_temp.p('TA'), 'AUDITLEAG01', now() + interval '7 days', 10, 0, true);

  -- Wagers on AD: W1 MB in CL's season, W2 MB in PB's season, W3 NM in CL's
  -- season (NM's own), W4 MB in league-less T.
  insert into public.wagers (user_id, subject_type, subject_id, predicate, stake, odds, potential_payout, notes)
  values
    (pg_temp.p('MB'), 'season_rank', pg_temp.i('CLS'), jsonb_build_object('user_id', pg_temp.p('AD'), 'rank', 1), 10, 2, 20, 'W1'),
    (pg_temp.p('MB'), 'season_rank', pg_temp.i('PBS'), jsonb_build_object('user_id', pg_temp.p('AD'), 'rank', 1), 10, 2, 20, 'W2'),
    (pg_temp.p('NM'), 'season_rank', pg_temp.i('CLS'), jsonb_build_object('user_id', pg_temp.p('AD'), 'rank', 1), 10, 2, 20, 'W3'),
    (pg_temp.p('MB'), 'tournament_rank', pg_temp.i('T'), jsonb_build_object('user_id', pg_temp.p('AD'), 'rank', 1), 10, 2, 20, 'W4');

  -- A guest invite to a PB event, naming the guest with a (fake) phone.
  insert into public.league_events (league_id, title, created_by, status, vote_ends_at)
  values (pg_temp.i('PB'), 'Audit Event', pg_temp.p('TA'), 'voting', now() + interval '2 days')
  returning id into v_id;
  insert into public.guest_invites (token, league_id, event_id, created_by, invited_names, invited_phones)
  values ('AUDITGUEST01', pg_temp.i('PB'), v_id, pg_temp.p('TA'), array['Audit Guest'], array['+15550100001']);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('SETUP crashed', false, sqlerrm);
end $$;


-- ════ P1 profile_private installed the way the house rules want ══════════
do $$
begin
  perform pg_temp.ok('P1 profiles has no phone column',
    not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'profiles' and column_name = 'phone'));
  perform pg_temp.ok('P1 profile_private has RLS on',
    (select c.relrowsecurity from pg_class c where c.oid = 'public.profile_private'::regclass));
  perform pg_temp.ok('P1 anon holds no privilege on profile_private',
    not has_table_privilege('anon', 'public.profile_private', 'SELECT')
    and not has_table_privilege('anon', 'public.profile_private', 'INSERT')
    and not has_table_privilege('anon', 'public.profile_private', 'UPDATE')
    and not has_table_privilege('anon', 'public.profile_private', 'DELETE')
    and not has_column_privilege('anon', 'public.profile_private', 'phone', 'SELECT'));
  perform pg_temp.ok('P1 authenticated: select, update(phone) only',
    has_table_privilege('authenticated', 'public.profile_private', 'SELECT')
    and has_column_privilege('authenticated', 'public.profile_private', 'phone', 'UPDATE')
    and not has_column_privilege('authenticated', 'public.profile_private', 'updated_at', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.profile_private', 'INSERT')
    and not has_table_privilege('authenticated', 'public.profile_private', 'DELETE'));
  perform pg_temp.ok('P1 two owner-only policies',
    (select count(*) from pg_policies where schemaname = 'public' and tablename = 'profile_private') = 2
    and (select bool_and(qual like '%auth.uid()%') from pg_policies
          where schemaname = 'public' and tablename = 'profile_private'));
  perform pg_temp.ok('P1 no function updates profiles.phone any more',
    not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.prosrc ~* 'update\s+public\.profiles\s[^;]*\mphone\M'
    ));
end $$;


-- ════ P2 the phones moved (counts only) ══════════════════════════════════
do $$
declare
  v_pre     integer := (select count(*) from _pre_phone);
  v_missing integer;
  v_diff    integer;
begin
  select count(*) into v_missing
    from _pre_phone pre left join public.profile_private pp on pp.id = pre.id
   where pp.id is null;
  select count(*) into v_diff
    from _pre_phone pre join public.profile_private pp on pp.id = pre.id
   where md5(btrim(pp.phone)) <> pre.h;
  perform pg_temp.ok('P2 every phone on profiles is in profile_private, unchanged',
    v_missing = 0 and v_diff = 0,
    format('%s phones before (0 = the column was already gone), %s missing, %s different', v_pre, v_missing, v_diff));
end $$;


-- ════ P3 signed out ══════════════════════════════════════════════════════
do $$
declare
  n integer;
  e text;
begin
  -- cnt first, then err: the order of calls inside one expression is not fixed.
  n := pg_temp.cnt('anon', 'select phone from public.profiles');
  e := pg_temp.err();
  perform pg_temp.ok('P3 anon: selecting profiles.phone fails (no such column)', n = -1 and e like '%phone%', e);
  n := pg_temp.cnt('NM', 'select phone from public.profiles');
  e := pg_temp.err();
  perform pg_temp.ok('P3 signed in: the same', n = -1 and e like '%phone%', e);
  perform pg_temp.ok('P3 anon: profile_private is refused',
    pg_temp.cnt('anon', 'select 1 from public.profile_private') = -1, pg_temp.err());
  perform pg_temp.ok('P3 anon: select * on profiles still works',
    pg_temp.cnt('anon', format('select * from public.profiles where id = %L', pg_temp.p('OW'))) = 1, pg_temp.err());
  perform pg_temp.ok('P3 a signed-in select * on profiles still works',
    pg_temp.cnt('NM', format('select * from public.profiles where id = %L', pg_temp.p('OW'))) = 1, pg_temp.err());
end $$;


-- ════ P4 the stranger ════════════════════════════════════════════════════
do $$
declare v text;
begin
  perform pg_temp.ok('P4 the stranger reads nobody else''s profile_private row',
    pg_temp.cnt('NM', format('select 1 from public.profile_private where id <> %L', pg_temp.p('NM'))) = 0, pg_temp.err());
  v := pg_temp.run_as('NM', format('update public.profile_private set phone = ''+15550100666'' where id = %L', pg_temp.p('OW')));
  perform pg_temp.ok('P4 the stranger can''t change the owner''s phone',
    (select phone from public.profile_private where id = pg_temp.p('OW')) = '+15550100009', v);
  v := pg_temp.run_as('NM', format('insert into public.profile_private (id, phone) values (%L, ''+15550100666'')', pg_temp.p('NM')));
  perform pg_temp.ok('P4 nobody inserts a row from the app', v like 'err:%', v);
end $$;


-- ════ P5 the owner ═══════════════════════════════════════════════════════
do $$
declare v text;
begin
  perform pg_temp.ok('P5 the owner reads their own row',
    pg_temp.cnt('OW', 'select 1 from public.profile_private where phone is not null') = 1, pg_temp.err());
  v := pg_temp.run_as('OW', format('update public.profile_private set phone = ''+15550100010'' where id = %L', pg_temp.p('OW')));
  perform pg_temp.ok('P5 the owner changes their phone',
    v = 'ok' and (select phone from public.profile_private where id = pg_temp.p('OW')) = '+15550100010', v);
  v := pg_temp.run_as('OW', format('update public.profile_private set updated_at = now() - interval ''1 year'' where id = %L', pg_temp.p('OW')));
  perform pg_temp.ok('P5 ...and nothing else', v like 'err:%', v);
  v := pg_temp.run_as('OW', 'delete from public.profile_private');
  perform pg_temp.ok('P5 the owner can''t delete the row from the app',
    v like 'err:%' and exists (select 1 from public.profile_private where id = pg_temp.p('OW')), v);
end $$;


-- ════ P6 guest invite -> real account ════════════════════════════════════
do $$
declare v text;
begin
  v := pg_temp.run_as('GU', 'select * from public.redeem_guest_invite(''AUDITGUEST01'', ''Audit Guest'')');
  perform pg_temp.ok('P6 the guest redeems the invite; their phone lands in profile_private',
    v = 'ok'
    and (select phone from public.profile_private where id = pg_temp.p('GU')) = '+15550100001'
    and (select is_guest from public.profiles where id = pg_temp.p('GU')), v);
  perform pg_temp.ok('P6 the guest reads their own phone, the stranger doesn''t',
    pg_temp.cnt('GU', 'select 1 from public.profile_private') = 1
    and pg_temp.cnt('NM', format('select 1 from public.profile_private where id = %L', pg_temp.p('GU'))) = 0, pg_temp.err());
  v := pg_temp.run_as('GU', 'select public.complete_guest_upgrade(''Audit Guest Upgraded'', ''other'', null)');
  perform pg_temp.ok('P6 upgrading with no phone keeps the invite''s phone and clears the guest flags',
    v = 'ok'
    and (select phone from public.profile_private where id = pg_temp.p('GU')) = '+15550100001'
    and not (select is_guest from public.profiles where id = pg_temp.p('GU')), v);
  -- complete_guest_upgrade only acts on a guest: flag them again to check the phone write.
  update public.profiles set is_guest = true where id = pg_temp.p('GU');
  v := pg_temp.run_as('GU', 'select public.complete_guest_upgrade(''Audit Guest Upgraded'', ''other'', '' +15550100002 '')');
  perform pg_temp.ok('P6 upgrading with a phone writes it (trimmed) to profile_private',
    v = 'ok' and (select phone from public.profile_private where id = pg_temp.p('GU')) = '+15550100002', v);
  v := pg_temp.run_as('anon', 'select public.complete_guest_upgrade(''x'', ''other'', ''+15550100003'')');
  perform pg_temp.ok('P6 signed out: complete_guest_upgrade refused', v like 'err:%', v);
  v := pg_temp.run_as('anon', 'select * from public.redeem_guest_invite(''AUDITGUEST01'', ''Audit Guest'')');
  perform pg_temp.ok('P6 signed out: redeem_guest_invite refused', v like 'err:%', v);
  perform pg_temp.ok('P6 a non-guest upgrade writes nothing',
    pg_temp.run_as('NM', 'select public.complete_guest_upgrade(''x'', ''other'', ''+15550100004'')') = 'ok'
    and not exists (select 1 from public.profile_private where id = pg_temp.p('NM') and phone is not null));
end $$;


-- ════ P7 account deletion ════════════════════════════════════════════════
do $$
declare v text;
begin
  v := pg_temp.run_as('OW', 'select public.delete_my_account()');
  perform pg_temp.ok('P7 delete_my_account removes the private row and keeps the tombstone',
    v = 'ok'
    and not exists (select 1 from public.profile_private where id = pg_temp.p('OW'))
    and (select full_name from public.profiles where id = pg_temp.p('OW')) = '[deleted account]', v);
  perform pg_temp.ok('P7 _purge_account is still internal',
    not has_function_privilege('anon', 'public._purge_account(uuid)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public._purge_account(uuid)', 'EXECUTE'));
end $$;


-- ════ G generate_playoff_bracket ═════════════════════════════════════════
do $$
declare v text;
begin
  perform pg_temp.ok('G0 definer, empty search_path, anon has no EXECUTE, authenticated and service_role do',
    (select p.prosecdef and array_to_string(p.proconfig, ',') = 'search_path=""'
       from pg_proc p where p.oid = 'public.generate_playoff_bracket(uuid)'::regprocedure)
    and not has_function_privilege('anon', 'public.generate_playoff_bracket(uuid)', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.generate_playoff_bracket(uuid)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.generate_playoff_bracket(uuid)', 'EXECUTE'));
  v := pg_temp.try_playoff('anon');
  perform pg_temp.ok('G1 signed out: refused', v like 'err:%', v);
  v := pg_temp.try_playoff('NM');
  perform pg_temp.ok('G2 the stranger: refused', v like 'err:%Only tournament admins%', v);
  v := pg_temp.try_playoff('X1');
  perform pg_temp.ok('G3 a plain entrant: refused', v like 'err:%Only tournament admins%', v);
  v := pg_temp.try_playoff('TA');
  perform pg_temp.ok('G4 the tournament''s admin draws it (Finals + third place)', v = 'ok:2', v);
  v := pg_temp.try_playoff('CA');
  perform pg_temp.ok('G5 its co-admin registrant draws it', v = 'ok:2', v);
  v := pg_temp.try_playoff('GM');
  perform pg_temp.ok('G6 godmode draws it', v = 'ok:2', v);
  v := pg_temp.try_playoff('SR');
  perform pg_temp.ok('G7 the service role draws it', v = 'ok:2', v);
  perform pg_temp.ok('G8 every attempt above was undone (no playoff round left)',
    not exists (select 1 from public.tournament_rounds where tournament_id = pg_temp.i('T')
                 and round_type in ('finals', 'third_place_match')));
end $$;


-- ════ I invite codes ═════════════════════════════════════════════════════
do $$
declare v text;
begin
  perform pg_temp.ok('I0 no open SELECT policy on invite_codes',
    not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'invite_codes'
                 and policyname in ('Invite codes lookup', 'Closed league privacy: tournament codes')));
  -- 0 rows or refused outright: either way, none.
  perform pg_temp.ok('I1 signed out: no code is listable',
    pg_temp.cnt('anon', 'select 1 from public.invite_codes where token like ''AUDIT%''') <= 0, pg_temp.err());
  perform pg_temp.ok('I1 signed out: no tournament code at all',
    pg_temp.cnt('anon', 'select 1 from public.invite_codes where scope_type = ''tournament''') <= 0, pg_temp.err());
  perform pg_temp.ok('I2 the stranger: none',
    pg_temp.cnt('NM', 'select 1 from public.invite_codes where token like ''AUDIT%''') = 0, pg_temp.err());
  perform pg_temp.ok('I3 a plain entrant: none',
    pg_temp.cnt('X1', 'select 1 from public.invite_codes where token = ''AUDITTOUR01''') = 0, pg_temp.err());
  perform pg_temp.ok('I4 the tournament''s creator reads its code',
    pg_temp.cnt('TA', 'select 1 from public.invite_codes where token = ''AUDITTOUR01''') = 1, pg_temp.err());
  perform pg_temp.ok('I5 its co-admin registrant reads it (InviteCodeManager)',
    pg_temp.cnt('CA', 'select 1 from public.invite_codes where token = ''AUDITTOUR01''') = 1, pg_temp.err());
  perform pg_temp.ok('I5 ...but not the league code',
    pg_temp.cnt('CA', 'select 1 from public.invite_codes where token = ''AUDITLEAG01''') = 0, pg_temp.err());
  perform pg_temp.ok('I6 the league admin reads the league code',
    pg_temp.cnt('TA', 'select 1 from public.invite_codes where token = ''AUDITLEAG01''') = 1, pg_temp.err());
  v := pg_temp.run_as('NM', 'select * from public.redeem_invite_code(''AUDITTOUR01'')');
  perform pg_temp.ok('I7 the stranger still redeems the tournament code',
    v = 'ok' and exists (select 1 from public.tournament_registrations
                          where tournament_id = pg_temp.i('T2') and user_id = pg_temp.p('NM')), v);
end $$;


-- ════ W wagers ═══════════════════════════════════════════════════════════
do $$
declare q text := format('select * from public.get_wagers_on_player(%L)', pg_temp.p('AD'));
begin
  perform pg_temp.ok('W0 anon executes none of the four wager reads',
    not has_function_privilege('anon', 'public.get_wagers_on_player(uuid,text,uuid)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.get_league_wager_totals(uuid)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.get_season_wager_totals(uuid)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.get_tournament_wager_totals(uuid)', 'EXECUTE'));
  perform pg_temp.ok('W0 authenticated executes all four',
    has_function_privilege('authenticated', 'public.get_wagers_on_player(uuid,text,uuid)', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.get_league_wager_totals(uuid)', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.get_season_wager_totals(uuid)', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.get_tournament_wager_totals(uuid)', 'EXECUTE'));
  perform pg_temp.ok('W1 signed out: refused', pg_temp.cnt('anon', q) = -1, pg_temp.err());
  perform pg_temp.ok('W2 the stranger: the open league, the league-less tournament and their own wager (3)',
    pg_temp.cnt('NM', q) = 3, pg_temp.cnt('NM', q)::text || ' ' || pg_temp.err());
  perform pg_temp.ok('W2 ...and no bettor in the closed league but themselves',
    pg_temp.cnt('NM', q || format(' where bettor_id = %L', pg_temp.p('MB')) || ' and league_name = ''Audit Closed League''') = 0,
    pg_temp.err());
  perform pg_temp.ok('W3 a closed league member sees all four',
    pg_temp.cnt('MB', q) = 4, pg_temp.cnt('MB', q)::text || ' ' || pg_temp.err());
  perform pg_temp.ok('W4 godmode sees all four', pg_temp.cnt('GM', q) = 4, pg_temp.err());
  perform pg_temp.ok('W5 scoped to the closed league: the stranger sees only their own',
    pg_temp.cnt('NM', format('select * from public.get_wagers_on_player(%L, ''league'', %L)', pg_temp.p('AD'), pg_temp.i('CL'))) = 1,
    pg_temp.err());
  perform pg_temp.ok('W6 totals still work signed in',
    pg_temp.cnt('NM', format('select * from public.get_season_wager_totals(%L)', pg_temp.i('PBS'))) = 1
    and pg_temp.cnt('NM', format('select * from public.get_tournament_wager_totals(%L)', pg_temp.i('T'))) = 1
    and pg_temp.cnt('NM', format('select * from public.get_league_wager_totals(%L)', pg_temp.i('PB'))) = 1, pg_temp.err());
  perform pg_temp.ok('W6 ...and are refused signed out',
    pg_temp.cnt('anon', format('select * from public.get_league_wager_totals(%L)', pg_temp.i('PB'))) = -1, pg_temp.err());
end $$;


-- ════ C guest RPC grants, definer rules ══════════════════════════════════
do $$
begin
  perform pg_temp.ok('C1 every replaced function is SECURITY DEFINER with an empty search_path',
    (select bool_and(coalesce((select p.prosecdef and array_to_string(p.proconfig, ',') = 'search_path=""'
                                 from pg_proc p where p.oid = to_regprocedure(x.sig)), false))
       from (values ('public.redeem_guest_invite(text,text)'), ('public.complete_guest_upgrade(text,text,text)'),
                    ('public._purge_account(uuid)'), ('public.generate_playoff_bracket(uuid)'),
                    ('public.get_wagers_on_player(uuid,text,uuid)')) x(sig)));
  perform pg_temp.ok('C2 the guest RPCs: authenticated yes, anon no',
    has_function_privilege('authenticated', 'public.redeem_guest_invite(text,text)', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.complete_guest_upgrade(text,text,text)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.redeem_guest_invite(text,text)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.complete_guest_upgrade(text,text,text)', 'EXECUTE'));
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
