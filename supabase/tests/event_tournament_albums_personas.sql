-- ============================================================
-- Event and tournament photo album persona tests
-- (migration_event_tournament_albums.sql).
--
-- NOT runnable on its own: build-event-tournament-albums-test.mjs puts, at the
-- marker line below, migration_event_tournament_albums.sql twice (it must be
-- re-runnable) and then migration_rls_hardening_2026q3.sql (a re-run must keep
-- the album helpers callable). Everything runs inside the begin / rollback
-- below, so the linked (live) database is left untouched:
--   node supabase/tests/build-event-tournament-albums-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary.
--
-- Personas (temporary accounts made inside the transaction):
--   AD  league admin; created the event and the tournament
--   MB  league member; approved in the tournament
--   M2  another league member, approved in the tournament
--   BL  league member who has blocked MB
--   EX  a league member whose membership expired
--   PD  league member with a pending tournament request
--   OUT not in the league or the tournament
-- ============================================================

begin;

alter default privileges for role postgres grant execute on functions to public;

-- ════ Harness ════════════════════════════════════════════════════════════
create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);
grant select, insert on _results to authenticated, anon;
grant usage on sequence _results_n_seq to authenticated, anon;

create temp table _p (k text primary key, id uuid not null);
insert into _p values
  ('AD',  'a9e00000-0000-4000-8000-000000000001'), ('MB', 'a9e00000-0000-4000-8000-000000000002'),
  ('M2',  'a9e00000-0000-4000-8000-000000000003'), ('BL', 'a9e00000-0000-4000-8000-000000000004'),
  ('EX',  'a9e00000-0000-4000-8000-000000000005'), ('PD', 'a9e00000-0000-4000-8000-000000000006'),
  ('OUT', 'a9e00000-0000-4000-8000-000000000007');
grant select on _p to authenticated, anon;

create temp table _ids (k text primary key, id uuid not null);
insert into _ids values
  ('L', 'a9e10000-0000-4000-8000-000000000001'),
  ('E', 'a9e10000-0000-4000-8000-000000000002');
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

-- Add a photo row as k; the path is <kind>/<album>/<folder>/<n>.jpg.
create function pg_temp.add(k text, p_kind text, p_album uuid, p_folder uuid default null) returns jsonb language sql as $$
  select pg_temp.json_as(k, format($q$
    with x as (insert into public.album_photos (%s, uploader_id, path)
               values (%L, %L, %L) returning id)
    select to_jsonb(id) from x$q$,
    case when p_kind = 'event' then 'event_id' else 'tournament_id' end,
    p_album, pg_temp.p(k),
    p_kind || '/' || p_album || '/' || coalesce(p_folder, pg_temp.p(k)) || '/' || gen_random_uuid() || '.jpg')) $$;

create function pg_temp.seen(k text, p_kind text, p_album uuid) returns int language sql as $$
  select (pg_temp.json_as(k, format(
    'select to_jsonb(count(*)) from public.album_photos where %s = %L',
    case when p_kind = 'event' then 'event_id' else 'tournament_id' end, p_album)) #>> '{}')::int $$;

create function pg_temp.del(k text, p_id uuid) returns jsonb language sql as $$
  select pg_temp.json_as(k, format(
    'with x as (delete from public.album_photos where id = %L returning id) select to_jsonb(count(*)) from x', p_id)) $$;

-- @@MIGRATION@@


-- ════ Setup ══════════════════════════════════════════════════════════════
do $$
declare
  v_id uuid;
begin
  perform pg_temp.as_admin();
  insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
  select id, 'alb-' || lower(k) || '@pickleague.test', jsonb_build_object('full_name', 'ALB Player ' || k), now()
    from _p;
  insert into public.leagues (id, name, is_open, created_by)
  values (pg_temp.i('L'), 'Album Test League', true, pg_temp.p('AD'));
  insert into public.league_members (league_id, user_id, role, expires_at) values
    (pg_temp.i('L'), pg_temp.p('AD'), 'admin', null), (pg_temp.i('L'), pg_temp.p('MB'), 'member', null),
    (pg_temp.i('L'), pg_temp.p('M2'), 'member', null), (pg_temp.i('L'), pg_temp.p('BL'), 'member', null),
    (pg_temp.i('L'), pg_temp.p('EX'), 'member', now() - interval '1 day'),
    (pg_temp.i('L'), pg_temp.p('PD'), 'member', null)
  on conflict (league_id, user_id) do update set role = excluded.role, expires_at = excluded.expires_at;
  insert into public.league_events (id, league_id, title, created_by, status, vote_ends_at)
  values (pg_temp.i('E'), pg_temp.i('L'), 'Album Test Event', pg_temp.p('AD'), 'voting', now() + interval '2 days');
  -- Leagueless, so only the registrations (and the creator) decide.
  insert into public.tournaments (name, league_id, format, match_type, status, registration_mode, created_by)
  values ('Album Test Tournament', null, 'round_robin', 'singles', 'registration', 'request', pg_temp.p('AD'))
  returning id into v_id;
  insert into _ids values ('T', v_id);
  insert into public.tournament_registrations (tournament_id, user_id, status, role) values
    (v_id, pg_temp.p('MB'), 'approved', 'member'), (v_id, pg_temp.p('M2'), 'approved', 'member'),
    (v_id, pg_temp.p('PD'), 'pending', 'member')
  on conflict (tournament_id, user_id) do update set status = excluded.status;
  insert into public.user_blocks (blocker_id, blocked_id) values (pg_temp.p('BL'), pg_temp.p('MB'));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('SETUP crashed', false, sqlerrm);
end $$;


-- ════ A1 installed ═══════════════════════════════════════════════════════
do $$
begin
  perform pg_temp.ok('A1 album_access is callable when signed in, not signed out',
    has_function_privilege('authenticated', 'public.album_access(text,uuid)', 'execute')
    and not has_function_privilege('anon', 'public.album_access(text,uuid)', 'execute'));
  perform pg_temp.ok('A1 the policy helpers stay callable when signed in (policies run as the user)',
    has_function_privilege('authenticated', 'public._pl_album_member(text,text)', 'execute')
    and has_function_privilege('authenticated', 'public._pl_album_manager(text,text)', 'execute')
    and not has_function_privilege('anon', 'public._pl_album_member(text,text)', 'execute'));
  perform pg_temp.ok('A1 the count and cap functions are internal',
    not has_function_privilege('authenticated', 'public._pl_album_photo_count(uuid,uuid,uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._pl_album_photos_cap()', 'execute'));
  perform pg_temp.ok('A1 the album-photos bucket is private',
    exists (select 1 from storage.buckets where id = 'album-photos' and not public));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('A1 block crashed', false, sqlerrm);
end $$;


-- ════ A2 adding ══════════════════════════════════════════════════════════
do $$
declare
  j jsonb;
begin
  j := pg_temp.add('MB', 'event', pg_temp.i('E'));
  perform pg_temp.ok('A2 a league member adds to the event album', j ? 'error' = false, j::text);
  insert into _ids values ('PMB', (j #>> '{}')::uuid);
  j := pg_temp.add('AD', 'event', pg_temp.i('E'));
  perform pg_temp.ok('A2 the event creator adds', j ? 'error' = false, j::text);
  insert into _ids values ('PAD', (j #>> '{}')::uuid);
  j := pg_temp.add('M2', 'event', pg_temp.i('E'));
  perform pg_temp.ok('A2 another member adds', j ? 'error' = false, j::text);
  insert into _ids values ('PM2', (j #>> '{}')::uuid);

  j := pg_temp.add('OUT', 'event', pg_temp.i('E'));
  perform pg_temp.ok('A2 someone outside the league can''t add', j ? 'error', j::text);
  j := pg_temp.add('EX', 'event', pg_temp.i('E'));
  perform pg_temp.ok('A2 an expired member can''t add', j ? 'error', j::text);
  j := pg_temp.add('MB', 'event', pg_temp.i('E'), pg_temp.p('M2'));
  perform pg_temp.ok('A2 nobody adds into someone else''s folder', j ? 'error', j::text);
  j := pg_temp.json_as('MB', format($q$
    with x as (insert into public.album_photos (event_id, uploader_id, path)
               values (%L, %L, %L) returning id) select to_jsonb(id) from x$q$,
    pg_temp.i('E'), pg_temp.p('M2'), 'event/' || pg_temp.i('E') || '/' || pg_temp.p('M2') || '/x.jpg'));
  perform pg_temp.ok('A2 nobody adds as someone else', j ? 'error', j::text);

  j := pg_temp.add('MB', 'tournament', pg_temp.i('T'));
  perform pg_temp.ok('A2 an approved player adds to the tournament album', j ? 'error' = false, j::text);
  insert into _ids values ('TMB', (j #>> '{}')::uuid);
  j := pg_temp.add('AD', 'tournament', pg_temp.i('T'));
  perform pg_temp.ok('A2 the tournament creator adds', j ? 'error' = false, j::text);
  j := pg_temp.add('PD', 'tournament', pg_temp.i('T'));
  perform pg_temp.ok('A2 a pending player can''t add', j ? 'error', j::text);
  j := pg_temp.add('OUT', 'tournament', pg_temp.i('T'));
  perform pg_temp.ok('A2 an outsider can''t add to the tournament', j ? 'error', j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('A2 block crashed', false, sqlerrm);
end $$;


-- ════ A3 seeing ══════════════════════════════════════════════════════════
do $$
begin
  perform pg_temp.ok('A3 members see the whole event album',
    pg_temp.seen('MB', 'event', pg_temp.i('E')) = 3 and pg_temp.seen('AD', 'event', pg_temp.i('E')) = 3);
  perform pg_temp.ok('A3 an outsider sees none', pg_temp.seen('OUT', 'event', pg_temp.i('E')) = 0);
  perform pg_temp.ok('A3 an expired member sees none', pg_temp.seen('EX', 'event', pg_temp.i('E')) = 0);
  perform pg_temp.ok('A3 a blocker doesn''t see the blocked player''s photo',
    pg_temp.seen('BL', 'event', pg_temp.i('E')) = 2, pg_temp.seen('BL', 'event', pg_temp.i('E'))::text);
  perform pg_temp.ok('A3 a block hides only that player''s photos: M2 still sees all 3',
    pg_temp.seen('M2', 'event', pg_temp.i('E')) = 3);
  perform pg_temp.ok('A3 tournament: players see it, the pending player and outsiders don''t',
    pg_temp.seen('M2', 'tournament', pg_temp.i('T')) = 2
    and pg_temp.seen('PD', 'tournament', pg_temp.i('T')) = 0
    and pg_temp.seen('OUT', 'tournament', pg_temp.i('T')) = 0);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('A3 block crashed', false, sqlerrm);
end $$;


-- ════ A4 album_access ════════════════════════════════════════════════════
do $$
declare
  j jsonb;
begin
  j := pg_temp.json_as('MB', format('select public.album_access(%L, %L)', 'event', pg_temp.i('E')));
  perform pg_temp.ok('A4 a member: can view and add, not manage, 1 of 20 added',
    (j ->> 'can_view')::boolean and (j ->> 'can_add')::boolean and not (j ->> 'can_manage')::boolean
    and (j ->> 'mine')::int = 1 and (j ->> 'cap')::int = 20, j::text);
  j := pg_temp.json_as('AD', format('select public.album_access(%L, %L)', 'event', pg_temp.i('E')));
  perform pg_temp.ok('A4 the organizer manages', (j ->> 'can_manage')::boolean, j::text);
  j := pg_temp.json_as('OUT', format('select public.album_access(%L, %L)', 'tournament', pg_temp.i('T')));
  perform pg_temp.ok('A4 an outsider: nothing', not (j ->> 'can_view')::boolean and not (j ->> 'can_add')::boolean, j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('A4 block crashed', false, sqlerrm);
end $$;


-- ════ A5 removing ════════════════════════════════════════════════════════
do $$
declare
  j jsonb;
begin
  j := pg_temp.del('M2', pg_temp.i('PMB'));
  perform pg_temp.ok('A5 another member can''t remove my photo', j = '0'::jsonb, j::text);
  j := pg_temp.del('OUT', pg_temp.i('PMB'));
  perform pg_temp.ok('A5 an outsider can''t remove it', j = '0'::jsonb, j::text);
  j := pg_temp.del('MB', pg_temp.i('PMB'));
  perform pg_temp.ok('A5 I remove my own', j = '1'::jsonb, j::text);
  j := pg_temp.del('AD', pg_temp.i('PM2'));
  perform pg_temp.ok('A5 the organizer removes anyone''s', j = '1'::jsonb, j::text);
  j := pg_temp.json_as('MB', format('update public.album_photos set path = path where id = %L returning to_jsonb(id)', pg_temp.i('PAD')));
  perform pg_temp.ok('A5 nobody edits a photo row', j is null or j ? 'error', coalesce(j::text, 'null'));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('A5 block crashed', false, sqlerrm);
end $$;


-- ════ A6 the caps ════════════════════════════════════════════════════════
do $$
declare
  j jsonb;
  n int := 0;
begin
  -- MB has 1 tournament photo; 19 more fill the 20.
  for i in 1..19 loop
    j := pg_temp.add('MB', 'tournament', pg_temp.i('T'));
    if not (j ? 'error') then n := n + 1; end if;
  end loop;
  perform pg_temp.ok('A6 up to 20 photos each', n = 19, n::text);
  j := pg_temp.add('MB', 'tournament', pg_temp.i('T'));
  perform pg_temp.ok('A6 the 21st: album.full', j ->> 'hint' = 'pl:album.full', j::text);
  j := pg_temp.add('M2', 'tournament', pg_temp.i('T'));
  perform pg_temp.ok('A6 someone else still adds', j ? 'error' = false, j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('A6 block crashed', false, sqlerrm);
end $$;


-- ════ A7 the files ═══════════════════════════════════════════════════════
do $$
declare
  v_path text;
  j jsonb;
begin
  select path into v_path from public.album_photos where id = pg_temp.i('PAD');
  j := pg_temp.json_as('AD', format(
    'with x as (insert into storage.objects (bucket_id, name, owner) values (%L, %L, %L) returning id) select to_jsonb(count(*)) from x',
    'album-photos', v_path, pg_temp.p('AD')));
  perform pg_temp.ok('A7 the uploader uploads the file for their photo row', j = '1'::jsonb, j::text);
  j := pg_temp.json_as('AD', format(
    'with x as (insert into storage.objects (bucket_id, name, owner) values (%L, %L, %L) returning id) select to_jsonb(count(*)) from x',
    'album-photos', 'event/' || pg_temp.i('E') || '/' || pg_temp.p('AD') || '/no-row.jpg', pg_temp.p('AD')));
  perform pg_temp.ok('A7 no file without a photo row', j ? 'error', j::text);

  j := pg_temp.json_as('M2', format('select to_jsonb(count(*)) from storage.objects where bucket_id = %L and name = %L', 'album-photos', v_path));
  perform pg_temp.ok('A7 a member reads the file', j = '1'::jsonb, j::text);
  j := pg_temp.json_as('OUT', format('select to_jsonb(count(*)) from storage.objects where bucket_id = %L and name = %L', 'album-photos', v_path));
  perform pg_temp.ok('A7 an outsider can''t', j = '0'::jsonb, j::text);
  j := pg_temp.json_as('EX', format('select to_jsonb(count(*)) from storage.objects where bucket_id = %L and name = %L', 'album-photos', v_path));
  perform pg_temp.ok('A7 an expired member can''t', j = '0'::jsonb, j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('A7 block crashed', false, sqlerrm);
end $$;


-- ════ A8 reporting a photo ═══════════════════════════════════════════════
do $$
declare
  j jsonb;
begin
  j := pg_temp.json_as('MB', format($q$
    with x as (insert into public.content_reports (reporter_id, subject_user_id, subject_type, subject_id, reason, snapshot)
               values (%L, %L, 'photo', %L, 'other', '{"path":"x"}') returning id) select to_jsonb(count(*)) from x$q$,
    pg_temp.p('MB'), pg_temp.p('AD'), pg_temp.i('PAD')));
  perform pg_temp.ok('A8 a member reports a photo', j = '1'::jsonb, j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('A8 block crashed', false, sqlerrm);
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
