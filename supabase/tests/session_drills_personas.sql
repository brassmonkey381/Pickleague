-- ============================================================
-- Session drills persona tests (migration_session_drills.sql): log a drill
-- for a play session, and a match linked to a past session.
--
-- NOT runnable on its own: build-session-drills-test.mjs puts, at the marker
-- line below, migration_session_drills.sql twice (it must be re-runnable) and
-- then migration_rls_hardening_2026q3.sql (a re-run must keep
-- log_session_drill callable). Everything runs inside the begin / rollback
-- below, so the linked (live) database is left untouched:
--   node supabase/tests/build-session-drills-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary.
-- Needs live already: play sessions with the validity rules and history,
-- drill reviews with facets, the pickle ledger.
--
-- Personas (temporary accounts made inside the transaction):
--   DO  owns the sessions and logs drills
--   DM  DO's drill partner and opponent
--   DX  a stranger who tries to log a drill for DO's session
-- Sessions of DO (none overlap):
--   SI ended 8 days ago · SA ended 9 days ago (10 days: too old) · SG 4 days
--   ago (a reviewed drill with DM counts for it) · SB 3 days ago · SC 2 days
--   ago, 3 minutes · SD a day ago, discarded · SE ended 4 hours ago · SF
--   ended an hour ago · SO open
-- ============================================================

begin;

-- pg_temp helpers are called as authenticated; since migration_anon_audit_rest.sql
-- postgres-created functions aren't PUBLIC-executable by default (rolled back below).
alter default privileges for role postgres grant execute on functions to public;

-- ════ Harness ════════════════════════════════════════════════════════════
create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);
grant select, insert on _results to authenticated, anon;
grant usage on sequence _results_n_seq to authenticated, anon;

create temp table _p (k text primary key, id uuid not null);
insert into _p values
  ('DO', 'a9e00000-0000-4000-8000-000000000001'), ('DM', 'a9e00000-0000-4000-8000-000000000002'),
  ('DX', 'a9e00000-0000-4000-8000-000000000003');
grant select on _p to authenticated, anon;

create temp table _s (k text primary key, id uuid not null);
insert into _s values
  ('SA', 'a9e10000-0000-4000-8000-00000000000a'), ('SB', 'a9e10000-0000-4000-8000-00000000000b'),
  ('SC', 'a9e10000-0000-4000-8000-00000000000c'), ('SD', 'a9e10000-0000-4000-8000-00000000000d'),
  ('SE', 'a9e10000-0000-4000-8000-00000000000e'), ('SF', 'a9e10000-0000-4000-8000-00000000000f'),
  ('SG', 'a9e10000-0000-4000-8000-000000000010'), ('SI', 'a9e10000-0000-4000-8000-000000000011'),
  ('SO', 'a9e10000-0000-4000-8000-000000000012');
grant select on _s to authenticated, anon;

create function pg_temp.p(text) returns uuid language sql stable as $$ select id from _p where k = $1 $$;
create function pg_temp.s(text) returns uuid language sql stable as $$ select id from _s where k = $1 $$;
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

-- log_session_drill as persona k (consistency 4, effort 5, 20 characters of
-- notes unless p_none: then nothing rated). Returns its row as JSON, or
-- {"error": ...} when it raised.
create function pg_temp.log(k text, p_session uuid, p_none boolean default false) returns jsonb language plpgsql as $$
declare
  j jsonb;
begin
  perform pg_temp.as_user(pg_temp.p(k));
  begin
    select to_jsonb(r) into j
      from public.log_session_drill(p_session,
             case when p_none then null else 4 end, case when p_none then null else 5 end,
             null, null, null, case when p_none then null else 'twenty chars exactly' end) r;
  exception when others then
    j := jsonb_build_object('error', sqlerrm);
  end;
  perform pg_temp.as_admin();
  return j;
end $$;

-- A singles match DO vs DM (DO won 11-5) recorded by DO under RLS, as
-- MatchEntry inserts it, linked to p_session. Returns the stored link.
create function pg_temp.match_for(p_session uuid) returns uuid language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.as_user(pg_temp.p('DO'));
  insert into public.matches (league_id, player1_id, player2_id, player1_score, player2_score, match_type,
                              winner_id, winner_team, status, confirm_deadline,
                              team1_confirmed_by, team2_confirmed_by, play_session_id)
  values ('b9e00000-0000-4000-8000-000000000001', pg_temp.p('DO'), pg_temp.p('DM'), 11, 5, 'singles',
          pg_temp.p('DO'), 'team1', 'pending', now() + interval '1 hour',
          pg_temp.p('DO'), null, p_session)
  returning play_session_id into v;
  perform pg_temp.as_admin();
  return v;
end $$;

-- @@MIGRATION@@

-- After the migration: a sql function's body is checked when it is created,
-- and drill_sessions.play_session_id is new.
create function pg_temp.drills_for(p_session uuid) returns bigint language sql stable as $$
  select count(*) from public.drill_sessions d where d.play_session_id = p_session $$;



-- ════ Setup ══════════════════════════════════════════════════════════════
do $$
declare
  v_drill uuid;
begin
  perform pg_temp.as_admin();
  insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
  select id, 'psd-' || lower(k) || '@pickleague.test', jsonb_build_object('full_name', 'PSD Player ' || k), now()
    from _p;
  insert into public.leagues (id, name, is_open, created_by)
  values ('b9e00000-0000-4000-8000-000000000001', 'PSD Drill League', true, pg_temp.p('DO'));
  insert into public.league_members (league_id, user_id, role) values
    ('b9e00000-0000-4000-8000-000000000001', pg_temp.p('DO'), 'admin'),
    ('b9e00000-0000-4000-8000-000000000001', pg_temp.p('DM'), 'member')
  on conflict do nothing;

  -- Oldest first (sessions never overlap: a later start is moved past an earlier end).
  insert into public.play_sessions (id, user_id, kind, started_at, ended_at) values
    (pg_temp.s('SA'), pg_temp.p('DO'), 'open_play', now() - interval '10 days', now() - interval '9 days 23 hours');
  insert into public.play_sessions (id, user_id, kind, started_at, ended_at) values
    (pg_temp.s('SI'), pg_temp.p('DO'), 'open_play', now() - interval '8 days 1 hour', now() - interval '8 days');
  insert into public.play_sessions (id, user_id, kind, started_at, ended_at) values
    (pg_temp.s('SG'), pg_temp.p('DO'), 'open_play', now() - interval '4 days 1 hour', now() - interval '4 days');
  insert into public.play_sessions (id, user_id, kind, started_at, ended_at) values
    (pg_temp.s('SB'), pg_temp.p('DO'), 'open_play', now() - interval '3 days 1 hour', now() - interval '3 days');
  insert into public.play_sessions (id, user_id, kind, started_at, ended_at) values
    (pg_temp.s('SC'), pg_temp.p('DO'), 'open_play', now() - interval '2 days 3 minutes', now() - interval '2 days');
  insert into public.play_sessions (id, user_id, kind, started_at, ended_at, discarded_at) values
    (pg_temp.s('SD'), pg_temp.p('DO'), 'open_play', now() - interval '25 hours', now() - interval '24 hours', now());
  insert into public.play_sessions (id, user_id, kind, started_at, ended_at) values
    (pg_temp.s('SE'), pg_temp.p('DO'), 'open_play', now() - interval '5 hours', now() - interval '4 hours');
  insert into public.play_sessions (id, user_id, kind, started_at, ended_at) values
    (pg_temp.s('SF'), pg_temp.p('DO'), 'open_play', now() - interval '90 minutes', now() - interval '60 minutes');
  insert into public.play_sessions (id, user_id, kind, started_at) values
    (pg_temp.s('SO'), pg_temp.p('DO'), 'open_play', now() - interval '20 minutes');

  -- SG: a scheduled drill with DM, held during it and reviewed at its end.
  insert into public.drill_sessions (player1_id, player2_id, session_date, session_slot, starts_at, length_minutes)
  values (pg_temp.p('DO'), pg_temp.p('DM'), (now() - interval '4 days 1 hour')::date, 0,
          now() - interval '4 days 1 hour', 60)
  returning id into v_drill;
  insert into public.drill_session_reviews (session_id, user_id, rating, consistency, pickles_granted, created_at)
  values (v_drill, pg_temp.p('DO'), 4, 4, 0, now() - interval '4 days');
  perform public._pl_refresh_session_validity(pg_temp.s('SG'));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('SETUP crashed', false, sqlerrm);
end $$;


-- ════ D1 installed ═══════════════════════════════════════════════════════
do $$
begin
  perform pg_temp.ok('D1 log_session_drill is callable when signed in, not signed out',
    has_function_privilege('authenticated', 'public.log_session_drill(uuid,integer,integer,integer,integer,integer,text)', 'execute')
    and not has_function_privilege('anon', 'public.log_session_drill(uuid,integer,integer,integer,integer,integer,text)', 'execute'));
  perform pg_temp.ok('D1 the link trigger stays internal',
    not has_function_privilege('authenticated', 'public._pl_matches_link_session()', 'execute'));
  perform pg_temp.ok('D1 SG counts through its reviewed drill before anything is logged',
    (select valid and valid_reason = 'drill_in_window' from public.play_sessions where id = pg_temp.s('SG')));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('D1 block crashed', false, sqlerrm);
end $$;


-- ════ D2 a drill logged right after the session ══════════════════════════
do $$
declare
  j jsonb;
  d public.drill_sessions;
  ps public.play_sessions;
begin
  j := pg_temp.log('DO', pg_temp.s('SF'));
  select * into d from public.drill_sessions where play_session_id = pg_temp.s('SF');
  select * into ps from public.play_sessions where id = pg_temp.s('SF');
  perform pg_temp.ok('D2 logged, paid as a review: 2 facets (10) + 20 characters (2)',
    (j ->> 'success')::boolean and (j ->> 'pickles_granted')::int = 12
    and (j ->> 'drill_session_id')::uuid = d.id, j::text);
  perform pg_temp.ok('D2 the drill is mine alone, at the session''s start, as long as it',
    d.player1_id = pg_temp.p('DO') and d.player2_id = pg_temp.p('DO')
    and d.starts_at = ps.started_at and d.length_minutes = 30, to_jsonb(d)::text);
  perform pg_temp.ok('D2 open play became that drill''s session',
    ps.kind = 'drill' and ps.source_id = d.id, to_jsonb(ps)::text);
  perform pg_temp.ok('D2 the session counts through the drill',
    ps.valid and ps.valid_reason = 'drill_in_window', ps.valid_reason);
  perform pg_temp.ok('D2 my review is stored once, with the pay',
    (select count(*) = 1 and min(pickles_granted) = 12 from public.drill_session_reviews
      where session_id = d.id and user_id = pg_temp.p('DO')));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('D2 block crashed', false, sqlerrm);
end $$;


-- ════ D3 one drill per session ═══════════════════════════════════════════
do $$
declare
  j jsonb;
begin
  j := pg_temp.log('DO', pg_temp.s('SF'));
  perform pg_temp.ok('D3 a second log for the same session is refused, nothing paid',
    not (j ->> 'success')::boolean and j ->> 'message' = 'You already logged a drill for this session.'
    and (j ->> 'pickles_granted')::int = 0 and pg_temp.drills_for(pg_temp.s('SF')) = 1, j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('D3 block crashed', false, sqlerrm);
end $$;


-- ════ D4 a drill added from Play history, 3 days later ═══════════════════
do $$
declare
  j jsonb;
  ps public.play_sessions;
begin
  j := pg_temp.log('DO', pg_temp.s('SB'));
  select * into ps from public.play_sessions where id = pg_temp.s('SB');
  perform pg_temp.ok('D4 logged 3 days after the session', (j ->> 'success')::boolean, j::text);
  perform pg_temp.ok('D4 the session counts through it',
    ps.valid and ps.valid_reason = 'drill_in_window' and ps.kind = 'drill', to_jsonb(ps)::text);
  perform pg_temp.ok('D4 the review is dated to the session''s end',
    (select r.created_at = ps.ended_at from public.drill_session_reviews r
      where r.session_id = (j ->> 'drill_session_id')::uuid and r.user_id = pg_temp.p('DO')));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('D4 block crashed', false, sqlerrm);
end $$;


-- ════ D5 sessions a drill can't be added to ══════════════════════════════
do $$
declare
  j jsonb;
begin
  j := pg_temp.log('DO', pg_temp.s('SA'));
  perform pg_temp.ok('D5 over 7 days ago: refused',
    not (j ->> 'success')::boolean and j ->> 'message' like '%more than 7 days ago%'
    and pg_temp.drills_for(pg_temp.s('SA')) = 0, j::text);
  j := pg_temp.log('DO', pg_temp.s('SC'));
  perform pg_temp.ok('D5 under 5 minutes: refused',
    not (j ->> 'success')::boolean and j ->> 'message' like '%under 5 minutes%'
    and pg_temp.drills_for(pg_temp.s('SC')) = 0, j::text);
  j := pg_temp.log('DO', pg_temp.s('SD'));
  perform pg_temp.ok('D5 discarded: refused',
    not (j ->> 'success')::boolean and j ->> 'message' like '%discarded%'
    and pg_temp.drills_for(pg_temp.s('SD')) = 0, j::text);
  j := pg_temp.log('DO', pg_temp.s('SO'));
  perform pg_temp.ok('D5 still open: refused',
    not (j ->> 'success')::boolean and j ->> 'message' like 'End your play session first%'
    and pg_temp.drills_for(pg_temp.s('SO')) = 0, j::text);
  j := pg_temp.log('DO', pg_temp.s('SG'));
  perform pg_temp.ok('D5 a reviewed drill already counts for it: refused',
    not (j ->> 'success')::boolean and j ->> 'message' = 'A drill you reviewed already counts for this session.'
    and pg_temp.drills_for(pg_temp.s('SG')) = 0, j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('D5 block crashed', false, sqlerrm);
end $$;


-- ════ D6 someone else's session, nothing rated ═══════════════════════════
do $$
declare
  j jsonb;
begin
  j := pg_temp.log('DX', pg_temp.s('SE'));
  perform pg_temp.ok('D6 another player''s session: refused',
    not (j ->> 'success')::boolean and j ->> 'message' = 'That play session isn''t in your history.'
    and pg_temp.drills_for(pg_temp.s('SE')) = 0, j::text);
  j := pg_temp.log('DO', pg_temp.s('SE'), true);
  perform pg_temp.ok('D6 nothing rated: refused, no drill left behind',
    not (j ->> 'success')::boolean and j ->> 'message' = 'Rate at least one thing to send your review.'
    and pg_temp.drills_for(pg_temp.s('SE')) = 0, j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('D6 block crashed', false, sqlerrm);
end $$;


-- ════ D7 the pay is in pickle history as a drill review ══════════════════
do $$
begin
  perform pg_temp.ok('D7 two drill reviews in pickle history, 12 each',
    (select count(*) = 2 and sum(l.delta) = 24 from public.pickle_ledger l
      where l.profile_id = pg_temp.p('DO') and l.source = 'submit_drill_review'),
    (select string_agg(coalesce(l.source, 'null') || ':' || l.delta, ', ') from public.pickle_ledger l
      where l.profile_id = pg_temp.p('DO')));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('D7 block crashed', false, sqlerrm);
end $$;


-- ════ D8 a match added to a past session ═════════════════════════════════
do $$
declare
  v uuid;
  ps public.play_sessions;
begin
  v := pg_temp.match_for(pg_temp.s('SE'));
  select * into ps from public.play_sessions where id = pg_temp.s('SE');
  perform pg_temp.ok('D8 linked 4 hours after the session ended: kept',
    v = pg_temp.s('SE'), coalesce(v::text, 'dropped'));
  perform pg_temp.ok('D8 that session counts through it',
    ps.valid and ps.valid_reason = 'linked_match', ps.valid_reason);
  v := pg_temp.match_for(pg_temp.s('SI'));
  perform pg_temp.ok('D8 linked 8 days after the session ended: dropped',
    v is null, coalesce(v::text, 'dropped'));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('D8 block crashed', false, sqlerrm);
end $$;


-- ════ D9 a scheduled drill at a time I already logged doesn't pay twice ══
do $$
declare
  v_drill uuid;
  j jsonb;
begin
  -- SB has a logged drill (D4). A scheduled drill with DM at the same time.
  perform pg_temp.as_admin();
  insert into public.drill_sessions (player1_id, player2_id, session_date, session_slot, starts_at, length_minutes)
  select pg_temp.p('DO'), pg_temp.p('DM'), ps.started_at::date, 0, ps.started_at, 60
    from public.play_sessions ps where ps.id = pg_temp.s('SB')
  returning id into v_drill;

  perform pg_temp.as_user(pg_temp.p('DO'));
  begin
    select to_jsonb(r) into j from public.submit_drill_review(v_drill, 4, 4, null, null, null, null) r;
  exception when others then
    j := jsonb_build_object('error', sqlerrm);
  end;
  perform pg_temp.as_admin();
  perform pg_temp.ok('D9 reviewing it is refused for me, nothing stored or paid',
    j ->> 'error' like 'You already logged a drill%'
    and not exists (select 1 from public.drill_session_reviews r
                     where r.session_id = v_drill and r.user_id = pg_temp.p('DO')), j::text);

  perform pg_temp.as_user(pg_temp.p('DM'));
  begin
    select to_jsonb(r) into j from public.submit_drill_review(v_drill, 4, 4, null, null, null, null) r;
  exception when others then
    j := jsonb_build_object('error', sqlerrm);
  end;
  perform pg_temp.as_admin();
  perform pg_temp.ok('D9 my partner, who logged nothing, still reviews it and is paid',
    (j ->> 'success')::boolean and (j ->> 'pickles_granted')::int = 10, j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('D9 block crashed', false, sqlerrm);
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
