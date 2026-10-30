-- ============================================================
-- Group session persona tests (migration_group_sessions.sql).
--
-- NOT runnable on its own: build-group-sessions-test.mjs puts, at the marker
-- line below, migration_group_sessions.sql twice (it must be re-runnable) and
-- then migration_rls_hardening_2026q3.sql (a re-run must keep the group RPCs
-- callable). Everything runs inside the begin / rollback below, so the linked
-- (live) database is left untouched:
--   node supabase/tests/build-group-sessions-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary.
--
-- Personas (temporary accounts made inside the transaction):
--   AD  league admin; created the event and the tournament
--   MB  league member; voted for the event's time; approved in the tournament
--   M2  league member; voted for the event's time
--   BL  league member who has blocked MB; voted for the event's time
--   PD  league member with a pending tournament request
--   OUT not in the league or the tournament
--   C01..C66  members of a second league (the 60-a-call cap)
-- ============================================================

begin;

alter default privileges for role postgres grant execute on functions to public;

-- ════ Harness ════════════════════════════════════════════════════════════
create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);
grant select, insert on _results to authenticated, anon;
grant usage on sequence _results_n_seq to authenticated, anon;

create temp table _p (k text primary key, id uuid not null);
insert into _p values
  ('AD',  'a9f00000-0000-4000-8000-000000000001'), ('MB', 'a9f00000-0000-4000-8000-000000000002'),
  ('M2',  'a9f00000-0000-4000-8000-000000000003'), ('BL', 'a9f00000-0000-4000-8000-000000000004'),
  ('PD',  'a9f00000-0000-4000-8000-000000000005'), ('OUT', 'a9f00000-0000-4000-8000-000000000006');
insert into _p
select 'C' || lpad(g::text, 2, '0'), ('a9f20000-0000-4000-8000-0000000000' || lpad(g::text, 2, '0'))::uuid
  from generate_series(1, 66) g;
grant select on _p to authenticated, anon;

create temp table _ids (k text primary key, id uuid not null);
insert into _ids values
  ('L',  'a9f10000-0000-4000-8000-000000000001'),
  ('E',  'a9f10000-0000-4000-8000-000000000002'),
  ('S',  'a9f10000-0000-4000-8000-000000000003'),
  ('L2', 'a9f10000-0000-4000-8000-000000000004'),
  ('E2', 'a9f10000-0000-4000-8000-000000000005');
grant select, insert on _ids to authenticated, anon;

create function pg_temp.p(text) returns uuid language sql stable as $$ select id from _p where k = $1 $$;
create function pg_temp.i(text) returns uuid language sql stable as $$ select id from _ids where k = $1 $$;
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

-- One JSON value p_sql returns as persona k; {"error": ...} when it failed.
create function pg_temp.json_as(k text, p_sql text) returns jsonb language plpgsql as $$
declare
  j jsonb;
begin
  perform pg_temp.as_user(pg_temp.p(k));
  begin
    execute p_sql into j;
  exception when others then
    perform pg_temp.as_admin();
    return jsonb_build_object('error', sqlerrm);
  end;
  perform pg_temp.as_admin();
  return j;
end $$;

-- Start a session as k; returns the stored row ({kind, source_id}).
create function pg_temp.start(k text, p_id uuid, p_kind text, p_source uuid) returns jsonb language sql as $$
  select pg_temp.json_as(k, format(
    'select jsonb_build_object(''kind'', s.kind, ''source_id'', s.source_id)
       from public.start_play_session(p_id => %L, p_kind => %L, p_source => %L) s',
    p_id, p_kind, p_source)) $$;

create function pg_temp.list(k text, p_kind text, p_id uuid) returns jsonb language sql as $$
  select pg_temp.json_as(k, format('select public.list_group_session(%L, %L)', p_kind, p_id)) $$;

create function pg_temp.notify(k text, p_session uuid) returns jsonb language sql as $$
  select pg_temp.json_as(k, format('select to_jsonb(public.notify_group_session(%L))', p_session)) $$;

create function pg_temp.has(j jsonb, k text) returns boolean language sql as $$
  select exists (select 1 from jsonb_array_elements(j -> 'players') x where (x ->> 'user_id')::uuid = pg_temp.p(k)) $$;

create function pg_temp.told(p_source uuid, k text) returns boolean language sql as $$
  select exists (select 1 from public.notifications n
                  where n.entity_id = p_source and n.category = 'notifyGroupSessions' and n.user_id = pg_temp.p(k)) $$;

-- @@MIGRATION@@


-- ════ Setup ══════════════════════════════════════════════════════════════
do $$
declare
  v_id uuid;
begin
  perform pg_temp.as_admin();
  insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
  select id, 'grp-' || lower(k) || '@pickleague.test', jsonb_build_object('full_name', 'GRP Player ' || k), now()
    from _p;
  insert into public.leagues (id, name, is_open, created_by) values
    (pg_temp.i('L'), 'Group Test League', true, pg_temp.p('AD')),
    (pg_temp.i('L2'), 'Group Test League 2', true, pg_temp.p('AD'));
  insert into public.league_members (league_id, user_id, role, expires_at) values
    (pg_temp.i('L'), pg_temp.p('AD'), 'admin', null), (pg_temp.i('L'), pg_temp.p('MB'), 'member', null),
    (pg_temp.i('L'), pg_temp.p('M2'), 'member', null), (pg_temp.i('L'), pg_temp.p('BL'), 'member', null),
    (pg_temp.i('L'), pg_temp.p('PD'), 'member', null)
  on conflict (league_id, user_id) do update set role = excluded.role, expires_at = excluded.expires_at;
  insert into public.league_members (league_id, user_id, role, expires_at)
  select pg_temp.i('L2'), id, 'member', null from _p where k like 'C%'
  on conflict (league_id, user_id) do update set role = excluded.role, expires_at = excluded.expires_at;

  -- E: a time picked today; MB, M2 and BL voted for it.
  insert into public.league_events (id, league_id, title, created_by, status, vote_ends_at)
  values (pg_temp.i('E'), pg_temp.i('L'), 'Group Test Event', pg_temp.p('AD'), 'voting', now() + interval '1 day');
  insert into public.event_slots (id, event_id, starts_at, ends_at)
  values (pg_temp.i('S'), pg_temp.i('E'), now() - interval '30 minutes', now() + interval '2 hours');
  insert into public.event_slot_votes (slot_id, user_id) values
    (pg_temp.i('S'), pg_temp.p('MB')), (pg_temp.i('S'), pg_temp.p('M2')), (pg_temp.i('S'), pg_temp.p('BL'));
  update public.league_events set confirmed_slot_id = pg_temp.i('S'), status = 'scheduled' where id = pg_temp.i('E');
  -- E2: no time picked, so the whole league hears.
  insert into public.league_events (id, league_id, title, created_by, status, vote_ends_at)
  values (pg_temp.i('E2'), pg_temp.i('L2'), 'Group Test Event 2', pg_temp.p('C01'), 'voting', now() + interval '1 day');

  insert into public.tournaments (name, league_id, format, match_type, status, registration_mode, created_by)
  values ('Group Test Tournament', null, 'round_robin', 'singles', 'active', 'request', pg_temp.p('AD'))
  returning id into v_id;
  insert into _ids values ('T', v_id);
  insert into public.tournament_registrations (tournament_id, user_id, status, role) values
    (v_id, pg_temp.p('MB'), 'approved', 'member'), (v_id, pg_temp.p('PD'), 'pending', 'member')
  on conflict (tournament_id, user_id) do update set status = excluded.status;

  insert into public.user_blocks (blocker_id, blocked_id) values (pg_temp.p('BL'), pg_temp.p('MB'));
  -- C02 turned the Group sessions push off.
  insert into public.user_preferences (user_id, prefs) values (pg_temp.p('C02'), '{"notifyGroupSessions": false}')
  on conflict (user_id) do update set prefs = excluded.prefs;
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('SETUP crashed', false, sqlerrm);
end $$;


-- ════ G1 installed ═══════════════════════════════════════════════════════
do $$
begin
  perform pg_temp.ok('G1 list_group_session and notify_group_session: signed in yes, signed out no',
    has_function_privilege('authenticated', 'public.list_group_session(text,uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.notify_group_session(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.list_group_session(text,uuid)', 'execute')
    and not has_function_privilege('anon', 'public.notify_group_session(uuid)', 'execute'));
  perform pg_temp.ok('G1 the helpers are internal',
    not has_function_privilege('authenticated', 'public._pl_group_member(uuid,text,uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._pl_group_joinable(uuid,text,uuid)', 'execute'));
  perform pg_temp.ok('G1 start_play_session is still callable signed in',
    has_function_privilege('authenticated',
      'public.start_play_session(uuid,text,uuid,text,timestamptz,double precision,double precision,double precision,timestamptz,double precision)',
      'execute'));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('G1 block crashed', false, sqlerrm);
end $$;


-- ════ G2 starting ════════════════════════════════════════════════════════
do $$
declare
  j jsonb;
begin
  j := pg_temp.start('MB', 'a9f30000-0000-4000-8000-000000000001', 'event', pg_temp.i('E'));
  perform pg_temp.ok('G2 a member starts the event''s group session',
    j ->> 'kind' = 'event' and (j ->> 'source_id')::uuid = pg_temp.i('E'), j::text);
  j := pg_temp.start('OUT', 'a9f30000-0000-4000-8000-000000000002', 'event', pg_temp.i('E'));
  perform pg_temp.ok('G2 an outsider''s Start is kept as plain open play',
    j ->> 'kind' = 'open_play' and j ->> 'source_id' is null, j::text);
  j := pg_temp.start('PD', 'a9f30000-0000-4000-8000-000000000003', 'tournament', pg_temp.i('T'));
  perform pg_temp.ok('G2 a pending player''s tournament Start is plain open play',
    j ->> 'kind' = 'open_play' and j ->> 'source_id' is null, j::text);
  j := pg_temp.start('AD', 'a9f30000-0000-4000-8000-000000000004', 'tournament', pg_temp.i('T'));
  perform pg_temp.ok('G2 the tournament''s creator starts its group session',
    j ->> 'kind' = 'tournament' and (j ->> 'source_id')::uuid = pg_temp.i('T'), j::text);
  j := pg_temp.start('MB', 'a9f30000-0000-4000-8000-000000000001', 'event', pg_temp.i('E'));
  perform pg_temp.ok('G2 a replayed Start returns the same session', j ->> 'kind' = 'event', j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('G2 block crashed', false, sqlerrm);
end $$;


-- ════ G3 who sees the group ══════════════════════════════════════════════
do $$
declare
  j jsonb;
  me jsonb;
begin
  j := pg_temp.list('M2', 'event', pg_temp.i('E'));
  perform pg_temp.ok('G3 a member sees MB playing now',
    (j ->> 'can_view')::boolean and (j ->> 'can_join')::boolean and pg_temp.has(j, 'MB')
    and exists (select 1 from jsonb_array_elements(j -> 'players') x
                 where (x ->> 'user_id')::uuid = pg_temp.p('MB') and x -> 'ended_at' = 'null'::jsonb), j::text);
  j := pg_temp.list('MB', 'event', pg_temp.i('E'));
  select x into me from jsonb_array_elements(j -> 'players') x where (x ->> 'is_me')::boolean;
  perform pg_temp.ok('G3 MB sees themself, marked is_me', me is not null, j::text);
  j := pg_temp.list('OUT', 'event', pg_temp.i('E'));
  perform pg_temp.ok('G3 an outsider sees nothing',
    not (j ->> 'can_view')::boolean and jsonb_array_length(j -> 'players') = 0, j::text);
  perform pg_temp.ok('G3 the outsider''s open play isn''t in the group', not pg_temp.has(pg_temp.list('AD', 'event', pg_temp.i('E')), 'OUT'));
  j := pg_temp.list('BL', 'event', pg_temp.i('E'));
  perform pg_temp.ok('G3 blocks hide MB from BL', (j ->> 'can_view')::boolean and not pg_temp.has(j, 'MB'), j::text);
  j := pg_temp.list('MB', 'tournament', pg_temp.i('T'));
  perform pg_temp.ok('G3 an approved player sees the tournament group', pg_temp.has(j, 'AD'), j::text);
  j := pg_temp.list('PD', 'tournament', pg_temp.i('T'));
  perform pg_temp.ok('G3 a pending player sees nothing', not (j ->> 'can_view')::boolean, j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('G3 block crashed', false, sqlerrm);
end $$;


-- ════ G4 "Let everyone know" ═════════════════════════════════════════════
do $$
declare
  j jsonb;
begin
  j := pg_temp.notify('OUT', 'a9f30000-0000-4000-8000-000000000001');
  perform pg_temp.ok('G4 only the session''s owner can notify', j = '0'::jsonb, j::text);
  j := pg_temp.notify('OUT', 'a9f30000-0000-4000-8000-000000000002');
  perform pg_temp.ok('G4 plain open play notifies nobody', j = '0'::jsonb, j::text);

  j := pg_temp.notify('MB', 'a9f30000-0000-4000-8000-000000000001');
  perform pg_temp.ok('G4 MB tells the people going: M2 and the organizer', j = '2'::jsonb, j::text);
  perform pg_temp.ok('G4 M2 and AD got it; MB (self), BL (blocked), PD (didn''t vote), OUT didn''t',
    pg_temp.told(pg_temp.i('E'), 'M2') and pg_temp.told(pg_temp.i('E'), 'AD')
    and not pg_temp.told(pg_temp.i('E'), 'MB') and not pg_temp.told(pg_temp.i('E'), 'BL')
    and not pg_temp.told(pg_temp.i('E'), 'PD') and not pg_temp.told(pg_temp.i('E'), 'OUT'));
  perform pg_temp.ok('G4 the notice opens the event',
    exists (select 1 from public.notifications n
             where n.entity_id = pg_temp.i('E') and n.category = 'notifyGroupSessions'
               and n.entity_type = 'event' and n.push_data ->> 'kind' = 'group_session'));

  j := pg_temp.notify('MB', 'a9f30000-0000-4000-8000-000000000001');
  perform pg_temp.ok('G4 asking again within 2 hours tells nobody', j = '0'::jsonb, j::text);

  -- M2 joins and notifies: AD was told just now, MB is playing; BL only blocked MB.
  perform pg_temp.start('M2', 'a9f30000-0000-4000-8000-000000000005', 'event', pg_temp.i('E'));
  j := pg_temp.notify('M2', 'a9f30000-0000-4000-8000-000000000005');
  perform pg_temp.ok('G4 M2 tells only BL (AD told already, MB playing)',
    j = '1'::jsonb and pg_temp.told(pg_temp.i('E'), 'BL'), j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('G4 block crashed', false, sqlerrm);
end $$;


-- ════ G5 the cap and the push switch ═════════════════════════════════════
do $$
declare
  j jsonb;
  n integer;
begin
  perform pg_temp.start('C01', 'a9f30000-0000-4000-8000-000000000006', 'event', pg_temp.i('E2'));
  j := pg_temp.notify('C01', 'a9f30000-0000-4000-8000-000000000006');
  select count(*) into n from public.notifications
   where entity_id = pg_temp.i('E2') and category = 'notifyGroupSessions';
  perform pg_temp.ok('G5 at most 60 people a call', j = '60'::jsonb and n = 60, j::text || ' / ' || n);
  perform pg_temp.ok('G5 C02 (Group sessions push off) wasn''t told', not pg_temp.told(pg_temp.i('E2'), 'C02'));
  perform pg_temp.ok('G5 C03 was', pg_temp.told(pg_temp.i('E2'), 'C03'));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('G5 block crashed', false, sqlerrm);
end $$;


-- ════ G6 a cancelled event ═══════════════════════════════════════════════
do $$
declare
  j jsonb;
begin
  update public.league_events set status = 'cancelled' where id = pg_temp.i('E');
  j := pg_temp.list('M2', 'event', pg_temp.i('E'));
  perform pg_temp.ok('G6 a cancelled event can''t be joined',
    (j ->> 'can_view')::boolean and not (j ->> 'can_join')::boolean, j::text);
  j := pg_temp.start('BL', 'a9f30000-0000-4000-8000-000000000007', 'event', pg_temp.i('E'));
  perform pg_temp.ok('G6 a Start for it is plain open play', j ->> 'kind' = 'open_play', j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('G6 block crashed', false, sqlerrm);
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
