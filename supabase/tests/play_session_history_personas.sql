-- ============================================================
-- Play session history persona tests (migration_play_session_history.sql).
--
-- NOT runnable on its own: build-play-session-history-test.mjs puts, at the
-- marker line below, migration_play_session_history.sql twice (it must be
-- re-runnable) and then migration_rls_hardening_2026q3.sql (a re-run must
-- keep the new RPCs callable). Everything runs inside the begin / rollback
-- below, so the linked (live) database is left untouched:
--   node supabase/tests/build-play-session-history-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary.
-- Needs live already: play sessions with the validity rules.
--
-- Personas (temporary accounts made inside the transaction):
--   HO  has three ended sessions and an open one; discards one
--   HS  a stranger who tries to discard HO's session
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
  ('HO', 'a9d00000-0000-4000-8000-000000000001'), ('HS', 'a9d00000-0000-4000-8000-000000000002');
grant select on _p to authenticated, anon;

-- The sessions, by name: S1 oldest .. S3 newest ended, SO open.
create temp table _s (k text primary key, id uuid not null);
insert into _s values
  ('S1', 'a9d10000-0000-4000-8000-000000000001'), ('S2', 'a9d10000-0000-4000-8000-000000000002'),
  ('S3', 'a9d10000-0000-4000-8000-000000000003'), ('SO', 'a9d10000-0000-4000-8000-000000000004');
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

-- One JSON value p_sql returns as persona k; {"error": ..., "hint": ...} when it failed.
create function pg_temp.json_as(k text, p_sql text) returns jsonb language plpgsql as $$
declare
  j jsonb;
  v_hint text;
begin
  perform pg_temp.as_user(pg_temp.p(k));
  begin
    execute p_sql into j;
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    perform pg_temp.as_admin();
    return jsonb_build_object('error', sqlerrm, 'hint', v_hint);
  end;
  perform pg_temp.as_admin();
  return j;
end $$;

create function pg_temp.discard(k text, p_id uuid) returns jsonb language sql as $$
  select pg_temp.json_as(k, format('select to_jsonb(public.discard_play_session(%L))', p_id)) $$;
create function pg_temp.history(k text) returns jsonb language sql as $$
  select pg_temp.json_as(k, 'select coalesce(jsonb_agg(to_jsonb(h)), ''[]''::jsonb) from public.list_my_play_sessions() h') $$;

-- @@MIGRATION@@


-- ════ Setup ══════════════════════════════════════════════════════════════
do $$
begin
  perform pg_temp.as_admin();
  insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
  select id, 'psh-' || lower(k) || '@pickleague.test', jsonb_build_object('full_name', 'PSH Player ' || k), now()
    from _p;
  insert into public.venues (id, sport, name, kind, lat, lng, source, geofence_radius_m) values
    ('test:psh-c1', array['pickleball'], 'PSH Test C1', 'court', 41.92, -103.2, 'google', 100);
  -- Oldest first (sessions never overlap: a later start is moved past an earlier end).
  insert into public.play_sessions (id, user_id, kind, venue_id, started_at, ended_at) values
    (pg_temp.s('S1'), pg_temp.p('HO'), 'open_play', 'test:psh-c1', now() - interval '30 hours', now() - interval '28 hours');
  insert into public.play_sessions (id, user_id, kind, venue_id, started_at, ended_at) values
    (pg_temp.s('S2'), pg_temp.p('HO'), 'open_play', null, now() - interval '6 hours', now() - interval '5 hours');
  insert into public.play_sessions (id, user_id, kind, venue_id, started_at, ended_at) values
    (pg_temp.s('S3'), pg_temp.p('HO'), 'drill', 'test:psh-c1', now() - interval '3 hours', now() - interval '2 hours');
  insert into public.play_sessions (id, user_id, kind, venue_id, started_at) values
    (pg_temp.s('SO'), pg_temp.p('HO'), 'open_play', 'test:psh-c1', now() - interval '20 minutes');
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('SETUP crashed', false, sqlerrm);
end $$;


-- ════ H1 installed ═══════════════════════════════════════════════════════
do $$
begin
  perform pg_temp.ok('H1 discard_play_session is callable when signed in, not signed out',
    has_function_privilege('authenticated', 'public.discard_play_session(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.discard_play_session(uuid)', 'execute'));
  perform pg_temp.ok('H1 list_my_play_sessions is callable when signed in, not signed out',
    has_function_privilege('authenticated', 'public.list_my_play_sessions(timestamptz,integer)', 'execute')
    and not has_function_privilege('anon', 'public.list_my_play_sessions(timestamptz,integer)', 'execute'));
  perform pg_temp.ok('H1 the session helpers stay internal',
    not has_function_privilege('authenticated', 'public._pl_refresh_session_validity(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._pl_match_session(uuid,uuid,timestamptz)', 'execute')
    and not has_function_privilege('authenticated', 'public._pl_drill_session(uuid,uuid,timestamptz,timestamptz,integer)', 'execute'));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('H1 block crashed', false, sqlerrm);
end $$;


-- ════ H2 the history ═════════════════════════════════════════════════════
do $$
declare
  j jsonb;
begin
  j := pg_temp.history('HO');
  perform pg_temp.ok('H2 my ended sessions, newest first, the open one left out',
    jsonb_array_length(j) = 3
    and (j -> 0 ->> 'session_id')::uuid = pg_temp.s('S3')
    and (j -> 1 ->> 'session_id')::uuid = pg_temp.s('S2')
    and (j -> 2 ->> 'session_id')::uuid = pg_temp.s('S1'), j::text);
  perform pg_temp.ok('H2 a court session carries its court''s name, one without a court none',
    j -> 0 ->> 'venue_name' = 'PSH Test C1' and j -> 0 ->> 'kind' = 'drill'
    and j -> 1 -> 'venue_name' = 'null'::jsonb, j::text);
  perform pg_temp.ok('H2 no matches recorded: 0 each', (j -> 0 ->> 'match_count')::int = 0, j::text);

  j := pg_temp.json_as('HO', format(
    'select coalesce(jsonb_agg(h.session_id), ''[]''::jsonb) from public.list_my_play_sessions(%L, 1) h',
    now() - interval '4 hours'));
  perform pg_temp.ok('H2 a page: one session started before the cursor',
    jsonb_array_length(j) = 1 and (j ->> 0)::uuid = pg_temp.s('S2'), j::text);

  j := pg_temp.history('HS');
  perform pg_temp.ok('H2 someone else sees none of mine', jsonb_array_length(j) = 0, j::text);

  perform pg_temp.as_admin();
  begin
    perform public.list_my_play_sessions();
    perform pg_temp.ok('H2 signed out is refused', false, 'no error');
  exception when others then
    perform pg_temp.ok('H2 signed out is refused', true);
  end;
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('H2 block crashed', false, sqlerrm);
end $$;


-- ════ H3 discard: who and when ═══════════════════════════════════════════
do $$
declare
  j jsonb;
begin
  j := pg_temp.discard('HS', pg_temp.s('S2'));
  perform pg_temp.ok('H3 a stranger can''t discard it (session.not_yours)', j ->> 'hint' = 'pl:session.not_yours', j::text);
  j := pg_temp.discard('HO', pg_temp.s('SO'));
  perform pg_temp.ok('H3 an open session: End it first (session.open)', j ->> 'hint' = 'pl:session.open', j::text);
  j := pg_temp.discard('HO', 'a9d1ffff-0000-4000-8000-000000000000');
  perform pg_temp.ok('H3 an unknown session (session.gone)', j ->> 'hint' = 'pl:session.gone', j::text);
  perform pg_temp.ok('H3 none of those changed anything',
    not exists (select 1 from public.play_sessions where user_id = pg_temp.p('HO') and discarded_at is not null));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('H3 block crashed', false, sqlerrm);
end $$;


-- ════ H4 discard: what it does ═══════════════════════════════════════════
do $$
declare
  j jsonb;
  v public.play_sessions;
begin
  j := pg_temp.discard('HO', pg_temp.s('S2'));
  perform pg_temp.ok('H4 the owner discards an ended session: 1', j = '1'::jsonb, j::text);
  j := pg_temp.discard('HO', pg_temp.s('S2'));
  perform pg_temp.ok('H4 again (a retry): 0', j = '0'::jsonb, j::text);

  select * into v from public.play_sessions where id = pg_temp.s('S2');
  perform pg_temp.ok('H4 stored discarded, not valid',
    v.discarded_at is not null and not v.valid and v.valid_reason = 'discarded' and not v.rewards_pending_confirmation,
    row_to_json(v)::text);

  j := pg_temp.history('HO');
  perform pg_temp.ok('H4 it leaves the history; the others stay',
    jsonb_array_length(j) = 2
    and not j @> jsonb_build_array(jsonb_build_object('session_id', pg_temp.s('S2'))), j::text);

  -- Re-judged later (a match recorded, my_session_validity): still discarded.
  perform public._pl_refresh_session_validity(pg_temp.s('S2'));
  select * into v from public.play_sessions where id = pg_temp.s('S2');
  perform pg_temp.ok('H4 a later re-judge keeps it discarded', not v.valid and v.valid_reason = 'discarded');
  j := pg_temp.json_as('HO', format('select public.my_session_validity(%L)', pg_temp.s('S2')));
  perform pg_temp.ok('H4 my_session_validity says discarded, not valid',
    j ->> 'reason' = 'discarded' and (j ->> 'valid')::boolean = false, j::text);

  perform pg_temp.ok('H4 it never takes a match, even one linked to it',
    public._pl_match_session(pg_temp.p('HO'), pg_temp.s('S2'), now() - interval '5 hours 30 minutes') is null);
  perform pg_temp.ok('H4 a match linked to a kept session still counts there',
    public._pl_match_session(pg_temp.p('HO'), pg_temp.s('S3'), now() - interval '2 hours 30 minutes') = pg_temp.s('S3'));
  perform pg_temp.ok('H4 it never takes a drill',
    public._pl_drill_session(pg_temp.p('HO'), gen_random_uuid(), now() - interval '5 hours 30 minutes',
                             now() - interval '6 hours', 60) is null);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('H4 block crashed', false, sqlerrm);
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
