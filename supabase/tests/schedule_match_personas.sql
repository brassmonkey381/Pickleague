-- ============================================================
-- schedule_league_match persona tests (migration_schedule_match_rpc.sql).
--
-- Standalone and rolled back: nothing it writes survives. Apply
-- migration_schedule_match_rpc.sql and migration_match_count_fix.sql (and re-run
-- migration_rls_hardening_2026q3.sql) first, then run from the linked
-- checkout:
--   supabase db query --linked -f supabase/tests/schedule_match_personas.sql -o csv
-- Every row should read ok = true; the first row is the summary.
--
-- Personas are temporary accounts created inside the transaction (auth.users
-- insert; the signup trigger makes the profile), in a temporary league:
--   SA a member who schedules (not a player) · S1 / S2 members who play ·
--   SO a member of another league only · SX a member whose guest membership
--   ended
-- now() is fixed for the whole transaction, so times compare exactly.
-- ============================================================

begin;

-- The pg_temp helpers below are called by the personas (as anon /
-- authenticated). Since migration_anon_audit_rest.sql, functions postgres
-- creates are no longer EXECUTE-able by PUBLIC by default, so this test
-- transaction (rolled back below) gives the helpers the old default back.
alter default privileges for role postgres grant execute on functions to public;

-- ════ Harness ════════════════════════════════════════════════════════════
create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);
grant select, insert on _results to authenticated, anon;
grant usage on sequence _results_n_seq to authenticated, anon;

create temp table _p (k text primary key, id uuid not null);
insert into _p values
  ('SA', 'a5c00000-0000-4000-8000-000000000001'), ('S1', 'a5c00000-0000-4000-8000-000000000002'),
  ('S2', 'a5c00000-0000-4000-8000-000000000003'), ('SO', 'a5c00000-0000-4000-8000-000000000004'),
  ('SX', 'a5c00000-0000-4000-8000-000000000005');
grant select on _p to authenticated, anon;

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

-- Runs p_sql as the current role; null when it went through, else
-- {state, msg, hint}.
create function pg_temp.err(p_sql text) returns jsonb language plpgsql as $$
declare
  v_state text;
  v_msg   text;
  v_hint  text;
begin
  execute p_sql;
  return null;
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
  return jsonb_build_object('state', v_state, 'msg', v_msg, 'hint', v_hint);
end $$;

-- schedule_league_match as persona k in the test league (S-league), at now() + p_in.
create function pg_temp.sched_sql(p1 text, p2 text, p_in interval,
                                  p_league uuid default 'b5c00000-0000-4000-8000-000000000001')
returns text language sql stable as $$
  select format('select public.schedule_league_match(%L::uuid, %L::uuid, %L::uuid, %L::timestamptz)',
                p_league, pg_temp.p(p1), pg_temp.p(p2), now() + p_in)
$$;

create function pg_temp.refused(p_test text, k text, p_sql text, p_hint text) returns void language plpgsql as $$
declare j jsonb;
begin
  perform pg_temp.as_user(pg_temp.p(k));
  j := pg_temp.err(p_sql);
  perform pg_temp.as_admin();
  perform pg_temp.ok(p_test, j ->> 'state' = 'P0001' and j ->> 'hint' = p_hint and coalesce(j ->> 'msg', '') <> '',
                     coalesce(j::text, 'went through'));
end $$;


-- ════ Setup ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data)
select id, 'sched-' || lower(k) || '@pickleague.test', jsonb_build_object('full_name', 'Sched Player ' || k)
  from _p;

insert into public.leagues (id, name, is_open, created_by) values
  ('b5c00000-0000-4000-8000-000000000001', 'Sched Test League', true, pg_temp.p('SA')),
  ('b5c00000-0000-4000-8000-000000000002', 'Sched Other League', true, pg_temp.p('SO'));
insert into public.league_members (league_id, user_id, role) values
  ('b5c00000-0000-4000-8000-000000000001', pg_temp.p('SA'), 'admin'),
  ('b5c00000-0000-4000-8000-000000000001', pg_temp.p('S1'), 'member'),
  ('b5c00000-0000-4000-8000-000000000001', pg_temp.p('S2'), 'member'),
  ('b5c00000-0000-4000-8000-000000000001', pg_temp.p('SX'), 'member'),
  ('b5c00000-0000-4000-8000-000000000002', pg_temp.p('SO'), 'admin')
on conflict do nothing;
update public.league_members set expires_at = now() - interval '1 hour'
 where league_id = 'b5c00000-0000-4000-8000-000000000001' and user_id = pg_temp.p('SX');

-- What a played match would change, before anything is scheduled.
create temp table _before as
select p.id, p.rating, p.singles_rating, p.doubles_rating, p.total_matches_played, p.last_match_at, p.pickles,
       (select count(*) from public.notifications n where n.user_id = p.id) as n_notifications
  from public.profiles p where p.id in (select id from _p);
create temp table _ids (k text primary key, id uuid);
grant select, insert on _ids to authenticated, anon;


-- ════ T1 the function: definer, pinned path, who may call it ══════════════
do $$
declare
  v_def  boolean;
  v_conf text[];
begin
  select p.prosecdef, p.proconfig into v_def, v_conf
    from pg_proc p where p.oid = 'public.schedule_league_match(uuid,uuid,uuid,timestamptz)'::regprocedure;
  perform pg_temp.ok('T1 schedule_league_match exists, SECURITY DEFINER, search_path pinned to ''''',
    v_def and v_conf @> array['search_path=""'], coalesce(v_conf::text, 'no config'));
  perform pg_temp.ok('T1 authenticated may call it, anon and public may not',
    has_function_privilege('authenticated', 'public.schedule_league_match(uuid,uuid,uuid,timestamptz)', 'execute')
    and not has_function_privilege('anon', 'public.schedule_league_match(uuid,uuid,uuid,timestamptz)', 'execute'), null);
exception when others then
  perform pg_temp.ok('T1 block crashed (is migration_schedule_match_rpc.sql applied?)', false, sqlerrm);
end $$;


-- ════ T2 a member schedules a match between two other members ═════════════
do $$
declare
  v_id  uuid;
  v_id2 uuid;
  m     public.matches;
  v_n   integer;
begin
  perform pg_temp.as_user(pg_temp.p('SA'));
  v_id := public.schedule_league_match('b5c00000-0000-4000-8000-000000000001', pg_temp.p('S1'), pg_temp.p('S2'),
                                       now() + interval '1 day');
  insert into _ids values ('T2', v_id);
  perform pg_temp.as_admin();
  select * into m from public.matches where id = v_id;
  perform pg_temp.ok('T2 the member''s booking is stored as a scheduled singles match at that time',
    m.status = 'scheduled' and m.match_type = 'singles' and m.scheduled_at = now() + interval '1 day'
    and m.player1_id = pg_temp.p('S1') and m.player2_id = pg_temp.p('S2') and m.created_at = now(),
    row_to_json(m)::text);
  perform pg_temp.ok('T2 ...with no score, no winner and nothing to confirm',
    m.player1_score is null and m.player2_score is null and m.winner_id is null and m.winner_team is null
    and m.confirm_deadline is null and m.team1_confirmed_by is null and m.team2_confirmed_by is null,
    row_to_json(m)::text);
  perform pg_temp.ok('T2 ...and no made-up rating snapshot (no score, so no rating change)',
    m.player1_rating_before is null and m.player2_rating_before is null
    and m.player1_rating_after is null and m.player2_rating_after is null
    and m.pending_delta1 is null and m.pending_delta2 is null, row_to_json(m)::text);

  -- Replay (a retried request that already landed): the same match back.
  perform pg_temp.as_user(pg_temp.p('SA'));
  v_id2 := public.schedule_league_match('b5c00000-0000-4000-8000-000000000001', pg_temp.p('S2'), pg_temp.p('S1'),
                                        now() + interval '1 day');
  perform pg_temp.as_admin();
  select count(*) into v_n from public.matches
   where league_id = 'b5c00000-0000-4000-8000-000000000001' and status = 'scheduled';
  perform pg_temp.ok('T2 a replay of the same booking (players either way round) returns the first one, no double booking',
    v_id2 = v_id and v_n = 1, format('first %s, replay %s, %s scheduled', v_id, v_id2, v_n));

  -- Only a scheduled match may go without a score.
  begin
    insert into public.matches (league_id, match_type, player1_id, player2_id, status)
    values ('b5c00000-0000-4000-8000-000000000001', 'singles', pg_temp.p('S1'), pg_temp.p('S2'), 'pending');
    perform pg_temp.ok('T2 a pending match with no score is refused', false, 'went through');
  exception when check_violation then
    perform pg_temp.ok('T2 a pending match with no score is refused', sqlerrm like '%matches_scores_unless_scheduled%', sqlerrm);
  end;

  -- A time within the 5-minute clock slack still books.
  perform pg_temp.as_user(pg_temp.p('S1'));
  v_id2 := public.schedule_league_match('b5c00000-0000-4000-8000-000000000001', pg_temp.p('S1'), pg_temp.p('S2'),
                                        now() - interval '2 minutes');
  perform pg_temp.as_admin();
  perform pg_temp.ok('T2 a player can book their own match, and a time 2 minutes ago (phone clock slack) is taken',
    v_id2 is not null and v_id2 <> v_id, coalesce(v_id2::text, 'null'));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T2 block crashed', false, sqlerrm);
end $$;


-- ════ T3 no side effects of a played match ════════════════════════════════
do $$
declare v_bad text;
begin
  select string_agg(b.id::text, ', ') into v_bad
    from _before b join public.profiles p on p.id = b.id
   where p.rating is distinct from b.rating
      or p.singles_rating is distinct from b.singles_rating
      or p.doubles_rating is distinct from b.doubles_rating
      or p.total_matches_played is distinct from b.total_matches_played
      or p.last_match_at is distinct from b.last_match_at
      or p.pickles is distinct from b.pickles;
  perform pg_temp.ok('T3 scheduling changes no rating, match count, last-played time or pickles', v_bad is null, v_bad);

  select string_agg(b.id::text, ', ') into v_bad
    from _before b
   where (select count(*) from public.notifications n where n.user_id = b.id) <> b.n_notifications;
  perform pg_temp.ok('T3 ...and sends no notification (nothing to confirm)', v_bad is null, v_bad);

  select string_agg(m.id::text, ', ') into v_bad
    from public.matches m
   where m.league_id = 'b5c00000-0000-4000-8000-000000000001' and m.status <> 'scheduled';
  perform pg_temp.ok('T3 ...and nothing turned it into a pending or completed match', v_bad is null, v_bad);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T3 block crashed', false, sqlerrm);
end $$;


-- ════ T4 refusals ═════════════════════════════════════════════════════════
do $$
declare j jsonb;
begin
  perform pg_temp.refused('T4 a non-member can''t schedule in the league', 'SO',
    pg_temp.sched_sql('S1', 'S2', interval '1 day'), 'pl:schedule.not_member');
  perform pg_temp.refused('T4 a member whose guest pass ended can''t schedule', 'SX',
    pg_temp.sched_sql('S1', 'S2', interval '1 day'), 'pl:schedule.not_member');
  perform pg_temp.refused('T4 the same player on both sides is refused', 'SA',
    pg_temp.sched_sql('S1', 'S1', interval '1 day'), 'pl:schedule.same_player');
  perform pg_temp.refused('T4 a player from outside the league is refused', 'SA',
    pg_temp.sched_sql('S1', 'SO', interval '1 day'), 'pl:schedule.player_not_member');
  perform pg_temp.refused('T4 a player whose guest membership ended is refused', 'SA',
    pg_temp.sched_sql('S1', 'SX', interval '1 day'), 'pl:schedule.player_not_member');
  perform pg_temp.refused('T4 a time in the past is refused', 'SA',
    pg_temp.sched_sql('S1', 'S2', - interval '1 hour'), 'pl:schedule.in_past');
  perform pg_temp.refused('T4 a time more than a year away is refused', 'SA',
    pg_temp.sched_sql('S1', 'S2', interval '400 days'), 'pl:schedule.too_far');
  perform pg_temp.refused('T4 a missing argument is refused as an incomplete request', 'SA',
    format('select public.schedule_league_match(%L::uuid, %L::uuid, null, %L::timestamptz)',
           'b5c00000-0000-4000-8000-000000000001', pg_temp.p('S1'), now() + interval '1 day'),
    'pl:request.bad');

  perform pg_temp.as_signed_out();
  j := pg_temp.err(pg_temp.sched_sql('S1', 'S2', interval '1 day'));
  perform pg_temp.as_admin();
  perform pg_temp.ok('T4 signed out (no user in the token) is refused', j ->> 'hint' = 'pl:auth.signed_out',
    coalesce(j::text, 'went through'));

  perform pg_temp.as_anon();
  j := pg_temp.err(pg_temp.sched_sql('S1', 'S2', interval '1 day'));
  perform pg_temp.as_admin();
  perform pg_temp.ok('T4 anon can''t call it at all (permission denied)', j ->> 'state' = '42501',
    coalesce(j::text, 'went through'));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T4 block crashed', false, sqlerrm);
end $$;


-- ════ T5 a direct client insert can't write a scheduled match ═════════════
do $$
declare
  j   jsonb;
  v_n integer;
begin
  perform pg_temp.as_user(pg_temp.p('SA'));
  j := pg_temp.err(format(
    'insert into public.matches (league_id, player1_id, player2_id, player1_score, player2_score, winner_id, winner_team, status, scheduled_at)
     values (%L, %L, %L, 11, 3, %L, %L, %L, %L)',
    'b5c00000-0000-4000-8000-000000000001', pg_temp.p('S1'), pg_temp.p('S2'), pg_temp.p('S1'), 'team1',
    'scheduled', now() + interval '2 days'));
  perform pg_temp.as_admin();
  select count(*) into v_n from public.matches
   where league_id = 'b5c00000-0000-4000-8000-000000000001' and scheduled_at = now() + interval '2 days';
  perform pg_temp.ok('T5 a direct REST insert with status scheduled is refused and stores nothing',
    j ->> 'hint' = 'pl:schedule.use_rpc' and v_n = 0, coalesce(j::text, 'went through') || format(' (%s rows)', v_n));

  -- The setting is the RPC's alone: once it returns, it's off again.
  perform pg_temp.ok('T5 the RPC''s insert permit is off after it returns',
    coalesce(current_setting('pl.schedule_match_rpc', true), '') <> 'on', current_setting('pl.schedule_match_rpc', true));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T5 block crashed', false, sqlerrm);
end $$;


-- ════ T6 match counts: recompute_all_plupr's rule, kept live (migration_match_count_fix.sql) ═
-- S1 and S2 already have scheduled matches (T2) and no played one.

-- Stored count = _pl_played_match_counts() (recompute_all_plupr's counting)
-- for each listed persona; null when they all agree, else what differs.
create function pg_temp.count_drift(ks text[]) returns text language sql as $$
  select string_agg(format('%s stored %s counted %s', k, coalesce(p.total_matches_played, 0), coalesce(c.n, 0)), '; ')
    from unnest(ks) as k
    join public.profiles p on p.id = pg_temp.p(k)
    left join public._pl_played_match_counts() c on c.user_id = p.id
   where coalesce(p.total_matches_played, 0) <> coalesce(c.n, 0)
$$;

create function pg_temp.tmp(k text) returns integer language sql as $$
  select coalesce(total_matches_played, 0) from public.profiles where id = pg_temp.p(k)
$$;

do $$
declare
  v_m   uuid;
  v_g   uuid;
  v_u   uuid;
  v_t   uuid := 'b5c00000-0000-4000-8000-0000000000a1';
  v_tm  uuid := 'b5c00000-0000-4000-8000-0000000000a2';
  b1    integer;
  b2    integer;
  v_pk  integer;
  v_n   integer;
  v_amt integer;
  v_d   text;
begin
  -- The repair: everyone's stored count becomes recompute_all_plupr's count,
  -- and a second run finds nothing left to change.
  perform public._pl_repair_match_counts();
  v_n := public._pl_repair_match_counts();
  select count(*) into b1
    from public.profiles p
    left join public._pl_played_match_counts() c on c.user_id = p.id
   where coalesce(p.total_matches_played, 0) <> coalesce(c.n, 0);
  perform pg_temp.ok('T6 after the repair every stored count equals recompute_all_plupr''s count, and a second run changes nothing',
    v_n = 0 and b1 = 0, format('second run changed %s, %s profiles differ', v_n, b1));

  b1 := pg_temp.tmp('S1');
  b2 := pg_temp.tmp('S2');
  select pickles into v_pk from public.profiles where id = pg_temp.p('S1');

  -- S1 records a played match against S2, as MatchEntry does: stored pending.
  perform pg_temp.as_user(pg_temp.p('S1'));
  insert into public.matches (league_id, player1_id, player2_id, player1_score, player2_score, match_type,
                              winner_id, winner_team, status)
  values ('b5c00000-0000-4000-8000-000000000001', pg_temp.p('S1'), pg_temp.p('S2'), 11, 5, 'singles',
          pg_temp.p('S1'), 'team1', 'pending')
  returning id into v_m;
  perform pg_temp.as_admin();
  perform pg_temp.ok('T6 a pending match doesn''t count yet',
    pg_temp.tmp('S1') = b1 and pg_temp.tmp('S2') = b2 and pg_temp.count_drift(array['S1', 'S2']) is null,
    format('S1 %s -> %s, S2 %s -> %s; %s', b1, pg_temp.tmp('S1'), b2, pg_temp.tmp('S2'),
           pg_temp.count_drift(array['S1', 'S2'])));

  -- S2 confirms it: counted exactly once for each player.
  perform pg_temp.as_user(pg_temp.p('S2'));
  perform public.confirm_match(v_m);
  perform pg_temp.as_admin();
  perform pg_temp.ok('T6 confirming adds exactly 1 for each player',
    (select status from public.matches where id = v_m) = 'completed'
    and pg_temp.tmp('S1') = b1 + 1 and pg_temp.tmp('S2') = b2 + 1 and pg_temp.count_drift(array['S1', 'S2']) is null,
    format('S1 %s -> %s, S2 %s -> %s; %s', b1, pg_temp.tmp('S1'), b2, pg_temp.tmp('S2'),
           pg_temp.count_drift(array['S1', 'S2'])));

  -- Their scheduled matches (T2) didn't make this their second match; the
  -- grant records what it gave.
  select amount into v_amt from public.first_match_bonus_grants where user_id = pg_temp.p('S1');
  perform pg_temp.ok('T6 a scheduled match doesn''t cost the first-match bonus, and the grant records 500',
    v_amt = 500
    and exists (select 1 from public.first_match_bonus_grants where user_id = pg_temp.p('S2'))
    and (select pickles from public.profiles where id = pg_temp.p('S1')) >= coalesce(v_pk, 0) + 500,
    format('amount %s, pickles %s -> %s', v_amt, v_pk, (select pickles from public.profiles where id = pg_temp.p('S1'))));

  -- A server-side (seed / godmode-style) insert stored completed: once.
  insert into public.matches (league_id, player1_id, player2_id, player1_score, player2_score, match_type,
                              winner_id, winner_team, status)
  values ('b5c00000-0000-4000-8000-000000000001', pg_temp.p('S2'), pg_temp.p('S1'), 11, 7, 'singles',
          pg_temp.p('S2'), 'team1', 'completed')
  returning id into v_g;
  perform pg_temp.ok('T6 a match inserted already completed adds exactly 1 for each player',
    pg_temp.tmp('S1') = b1 + 2 and pg_temp.tmp('S2') = b2 + 2 and pg_temp.count_drift(array['S1', 'S2']) is null,
    format('S1 %s -> %s, S2 %s -> %s', b1, pg_temp.tmp('S1'), b2, pg_temp.tmp('S2')));

  -- Deleting a completed match takes it back off.
  delete from public.matches where id = v_g;
  perform pg_temp.ok('T6 deleting a completed match takes 1 back off',
    pg_temp.tmp('S1') = b1 + 1 and pg_temp.tmp('S2') = b2 + 1 and pg_temp.count_drift(array['S1', 'S2']) is null,
    format('S1 %s -> %s, S2 %s -> %s', b1, pg_temp.tmp('S1'), b2, pg_temp.tmp('S2')));

  -- Doubles with a player who prefers not to say (gender is NOT NULL live):
  -- 'unspecified', which recompute_all_plupr never counts.
  update public.profiles set gender = 'prefer-not-to-say' where id in (pg_temp.p('SA'), pg_temp.p('SO'));
  insert into public.matches (league_id, match_type, player1_id, partner1_id, player2_id, partner2_id,
                              player1_score, player2_score, winner_team, status)
  values ('b5c00000-0000-4000-8000-000000000001', 'doubles', pg_temp.p('S1'), pg_temp.p('SA'),
          pg_temp.p('S2'), pg_temp.p('SO'), 11, 9, 'team1', 'completed')
  returning id into v_u;
  v_d := pg_temp.count_drift(array['S1', 'S2', 'SA', 'SO']);
  perform pg_temp.ok('T6 an unspecified-category doubles match counts for nobody, as in recompute_all_plupr',
    (select doubles_category from public.matches where id = v_u) = 'unspecified'
    and pg_temp.tmp('S1') = b1 + 1 and v_d is null,
    format('category %s, S1 %s -> %s; %s', (select doubles_category from public.matches where id = v_u),
           b1, pg_temp.tmp('S1'), v_d));
  delete from public.matches where id = v_u;

  -- A tournament match counts when it completes with a winner.
  insert into public.tournaments (id, name, format, match_type, status, created_by)
  values (v_t, '[TEST] Sched count cup', 'round_robin', 'singles', 'active', pg_temp.p('SA'));
  insert into public.tournament_matches (id, tournament_id, match_order, match_type, team1_player1, team2_player1, status)
  values (v_tm, v_t, 0, 'singles', pg_temp.p('S1'), pg_temp.p('S2'), 'pending');
  perform pg_temp.ok('T6 a pending tournament match doesn''t count',
    pg_temp.tmp('S1') = b1 + 1 and pg_temp.count_drift(array['S1', 'S2']) is null,
    format('S1 %s -> %s', b1, pg_temp.tmp('S1')));
  update public.tournament_matches
     set team1_score = 11, team2_score = 4, winner_team = 'team1', status = 'completed'
   where id = v_tm;
  perform pg_temp.ok('T6 a tournament match completed with a winner adds exactly 1 for each player',
    pg_temp.tmp('S1') = b1 + 2 and pg_temp.tmp('S2') = b2 + 2 and pg_temp.count_drift(array['S1', 'S2']) is null,
    format('S1 %s -> %s, S2 %s -> %s; %s', b1, pg_temp.tmp('S1'), b2, pg_temp.tmp('S2'),
           pg_temp.count_drift(array['S1', 'S2'])));

  -- Deleting S1's only completed league match refunds the first-match bonus:
  -- the 500 it granted, not 200.
  select pickles into v_pk from public.profiles where id = pg_temp.p('S1');
  delete from public.matches where id = v_m;
  perform pg_temp.ok('T6 deleting the only played match refunds what the first-match bonus granted (500)',
    not exists (select 1 from public.first_match_bonus_grants where user_id = pg_temp.p('S1'))
    and (select pickles from public.profiles where id = pg_temp.p('S1')) <= greatest(0, v_pk - 500),
    format('pickles %s -> %s', v_pk, (select pickles from public.profiles where id = pg_temp.p('S1'))));
  perform pg_temp.ok('T6 ...and the count drops back by 1', pg_temp.tmp('S1') = b1 + 1
    and pg_temp.count_drift(array['S1', 'S2']) is null, format('S1 %s -> %s', b1, pg_temp.tmp('S1')));

  perform pg_temp.ok('T6 the old count-on-insert trigger is gone',
    not exists (select 1 from pg_trigger where tgname = 'on_match_player_stats'
                 and tgrelid = 'public.matches'::regclass), null);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T6 block crashed (is migration_match_count_fix.sql applied?)', false, sqlerrm);
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
