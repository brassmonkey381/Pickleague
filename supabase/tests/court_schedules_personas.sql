-- ============================================================
-- Court schedules (persona tests for migration_court_schedules.sql).
--
-- NOT runnable on its own: build-court-schedules-test.mjs puts, at the marker
-- line below, migration_court_schedules.sql twice (it must be re-runnable) and
-- then migration_rls_hardening_2026q3.sql (a re-run must keep the RPCs online).
-- Everything runs inside the begin / rollback below, so the linked (live)
-- database is left untouched:
--   node supabase/tests/build-court-schedules-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary.
--
-- Personas (temporary accounts, emails @court-schedules.example):
--   SA home location in Alameda
--   SB home location in Sacramento (~110 km from the courts)
--   SC no home location
-- GM: the godmode account (is_godmode_user); everything it writes rolls back.
-- ============================================================

begin;

alter default privileges for role postgres grant execute on functions to public;

-- ════ Harness ════════════════════════════════════════════════════════════
create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);
grant select, insert on _results to authenticated;
grant usage on sequence _results_n_seq to authenticated;

create temp table _p (k text primary key, id uuid not null);
insert into _p values
  ('SA', 'ac000000-0000-4000-8000-000000000001'), ('SB', 'ac000000-0000-4000-8000-000000000002'),
  ('SC', 'ac000000-0000-4000-8000-000000000003');
grant select on _p to authenticated;

create function pg_temp.p(text) returns uuid language sql stable as $$
  select case when $1 = 'GM' then '252a36e1-5d89-4ad2-8a3e-b786579f019a'::uuid else (select id from _p where k = $1) end
$$;

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

-- ════ Setup ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data)
select id, 'cs-' || lower(k) || '@court-schedules.example', jsonb_build_object('full_name', 'Schedule' || k || ' Test')
  from _p;

-- @@MIGRATION@@

-- ════ Checks ═════════════════════════════════════════════════════════════
do $$
declare
  r      jsonb;
  e      jsonb;
  v_id   uuid;
  v_src  uuid;
  v_n    integer;
  v_ocean constant text := 'curated:ocean-view-park-albany';
begin
  perform pg_temp.as_admin();
  perform pg_temp.as_user(pg_temp.p('SA'));
  perform public.set_my_home_location(37.7700, -122.2500, '2250 Shoreline Dr, Alameda, CA 94501, USA');
  perform pg_temp.as_user(pg_temp.p('SB'));
  perform public.set_my_home_location(38.5816, -121.4944, '915 I St, Sacramento, CA 95814, USA');
  perform pg_temp.as_admin();

  -- S1 the seed
  perform pg_temp.ok('S1 six seeded sessions, once each after two runs',
    (select count(*) from public.court_sessions where source_name in ('City of Albany','BORP','City of San Ramon','LARPD')) = 6);
  perform pg_temp.ok('S1 every fetched source is seeded with terms looked at',
    (select count(*) from public.court_schedule_sources where method = 'fetch' and terms_checked_at is not null) = 4);
  perform pg_temp.ok('S1 no Facebook or Meetup source',
    not exists (select 1 from public.court_schedule_sources where url ~* 'facebook|meetup'));
  perform pg_temp.ok('S1 the imported series left the events feed',
    not exists (select 1 from public.outside_events e
                 where e.hidden_at is null and e.created_at < '2026-11-08'
                   and public._pl_outside_url_key(e.source_url) in
                       (select url_key from public.court_schedule_sources where method = 'fetch')));
  perform pg_temp.ok('S1 Bushrod has no unconfirmed session',
    not exists (select 1 from public.court_sessions where venue_id = 'g:ChIJ5VvX8Nh9hYARkIMJqZ1C0DU'));

  -- S2 reading
  perform pg_temp.as_user(pg_temp.p('SA'));
  r := public.list_court_sessions(v_ocean);
  perform pg_temp.ok('S2 a player reads a court''s sessions', jsonb_array_length(r) = 3, r::text);
  perform pg_temp.ok('S2 the row has the kit''s fields',
    r -> 0 ?& array['id','place_id','title','days','start_time','end_time','tz','level','cost','note','organizer_name',
                    'source_name','source_url','valid_from','valid_to','skip_dates','last_verified_at'], (r -> 0)::text);
  perform pg_temp.ok('S2 times are HH:MM', (r -> 0 ->> 'start_time') ~ '^\d{2}:\d{2}$', (r -> 0)::text);
  perform pg_temp.as_admin();

  -- S3 what stops listing
  update public.court_sessions set valid_to = current_date - 2 where venue_id = v_ocean and days = 2;
  update public.court_sessions set last_verified_at = now() - interval '181 days' where venue_id = v_ocean and days = 8;
  update public.court_sessions set hidden_at = now() where venue_id = v_ocean and days = 32;
  perform pg_temp.as_user(pg_temp.p('SA'));
  perform pg_temp.ok('S3 past its end, unconfirmed 180 days or hidden: not listed',
    jsonb_array_length(public.list_court_sessions(v_ocean)) = 0);
  perform pg_temp.as_admin();
  update public.court_sessions set valid_to = null, last_verified_at = now(), hidden_at = null where venue_id = v_ocean;

  -- S4 near me
  perform pg_temp.as_user(pg_temp.p('SA'));
  r := public.nearby_court_schedules();
  perform pg_temp.ok('S4 Alameda: Albany is near', r -> 'courts' @> jsonb_build_array(jsonb_build_object('venue_id', v_ocean)), r::text);
  perform pg_temp.as_user(pg_temp.p('SB'));
  r := public.nearby_court_schedules();
  perform pg_temp.ok('S4 Sacramento: nothing within 40 km', (r ->> 'court_count')::int = 0, r::text);
  perform pg_temp.as_user(pg_temp.p('SC'));
  r := public.nearby_court_schedules();
  perform pg_temp.ok('S4 no home location: every court', (r ->> 'court_count')::int >= 3, r::text);

  -- S5 suggestions
  e := pg_temp.err(format('select public.suggest_court_schedule(%L, %L)', v_ocean, 'hi'));
  perform pg_temp.ok('S5 too short says what to do', e ->> 'hint' = 'pl:schedules.note', e::text);
  e := pg_temp.err(format('select public.suggest_court_schedule(%L, %L)', 'nope', 'Tuesdays at 4'));
  perform pg_temp.ok('S5 unknown court refused', e ->> 'hint' = 'pl:schedules.gone', e::text);
  v_id := public.suggest_court_schedule(v_ocean, 'Tuesdays at 4');
  perform public.suggest_court_schedule(v_ocean, 'Thursdays at 5');
  perform public.suggest_court_schedule(v_ocean, 'Saturdays at 1');
  e := pg_temp.err(format('select public.suggest_court_schedule(%L, %L)', v_ocean, 'Sundays at 2'));
  perform pg_temp.ok('S5 three a day', e ->> 'hint' = 'pl:schedules.limit', e::text);
  perform pg_temp.ok('S5 a suggestion publishes nothing', jsonb_array_length(public.list_court_sessions(v_ocean)) = 3);
  perform pg_temp.as_admin();
  perform pg_temp.ok('S5 only the admins are told',
    not exists (select 1 from public.push_outbox o where o.push_data ->> 'kind' like 'court_schedule%'
                   and not public.is_godmode_user(o.recipient_id)));

  -- S6 who can do what
  perform pg_temp.as_user(pg_temp.p('SA'));
  e := pg_temp.err('select public.admin_schedule_review()');
  perform pg_temp.ok('S6 a player can''t open the review', e ->> 'hint' = 'pl:schedules.admin_only', e::text);
  e := pg_temp.err(format('select public.admin_save_court_session(null, %L, %L, 1, %L::time)', v_ocean, 'Mine', '10:00'));
  perform pg_temp.ok('S6 a player can''t add a session', e ->> 'hint' = 'pl:schedules.admin_only', e::text);
  e := pg_temp.err('select count(*) from public.court_sessions');
  perform pg_temp.ok('S6 no table access', e is not null);
  e := pg_temp.err(format('select public.schedule_source_checked(%L, %L, %L)', gen_random_uuid(), 'ok', 'x'));
  perform pg_temp.ok('S6 a player can''t call the check', e is not null);
  perform pg_temp.as_admin();

  -- S7 admin
  perform pg_temp.as_user(pg_temp.p('GM'));
  r := public.admin_schedule_review();
  perform pg_temp.ok('S7 the review shows the suggestions and sources',
    jsonb_array_length(r -> 'proposals') >= 3 and jsonb_array_length(r -> 'sources') = 7, left(r::text, 300));
  e := pg_temp.err(format('select public.admin_save_court_session(null, %L, %L, 0, %L::time)', v_ocean, 'No days', '10:00'));
  perform pg_temp.ok('S7 no days refused', e ->> 'hint' = 'pl:schedules.days', e::text);
  e := pg_temp.err(format('select public.admin_save_court_session(null, %L, %L, 1, %L::time, %L::time)', v_ocean, 'Backwards', '10:00', '09:00'));
  perform pg_temp.ok('S7 end before start refused', e ->> 'hint' = 'pl:schedules.time', e::text);
  v_id := public.admin_save_court_session(null, v_ocean, 'Test session', 1, '10:00', '11:00', 'All levels', '$2', null, null,
    'BORP', 'https://www.borp.org/pickleball-for-all/');
  perform pg_temp.ok('S7 a saved session lists', jsonb_array_length(public.list_court_sessions(v_ocean)) = 4);
  perform public.admin_set_court_session_hidden(v_id, true);
  perform pg_temp.ok('S7 hide takes it off', jsonb_array_length(public.list_court_sessions(v_ocean)) = 3);
  perform pg_temp.as_admin();
  perform pg_temp.ok('S7 it joined its source', (select source_id from public.court_sessions where id = v_id) is not null);

  -- S8 the weekly check
  select id into v_src from public.court_schedule_sources where name = 'BORP';
  update public.court_schedule_sources set content_hash = null where id = v_src;
  perform pg_temp.ok('S8 first read keeps the hash, no review', public.schedule_source_checked(v_src, 'ok', 'aaa') = 'first'
    and not exists (select 1 from public.court_schedule_proposals where source_id = v_src));
  update public.court_sessions set last_verified_at = now() - interval '30 days' where source_id = v_src;
  perform pg_temp.ok('S8 same page', public.schedule_source_checked(v_src, 'ok', 'aaa') = 'same');
  perform pg_temp.ok('S8 same page keeps its sessions confirmed',
    not exists (select 1 from public.court_sessions where source_id = v_src and last_verified_at < now() - interval '1 day'));
  update public.court_sessions set last_verified_at = now() - interval '30 days' where source_id = v_src;
  perform pg_temp.ok('S8 unreadable page changes nothing', public.schedule_source_checked(v_src, 'http 500', null) = 'skipped'
    and (select content_hash from public.court_schedule_sources where id = v_src) = 'aaa'
    and not exists (select 1 from public.court_sessions where source_id = v_src and last_verified_at > now() - interval '1 day'));
  perform pg_temp.ok('S8 changed page', public.schedule_source_checked(v_src, 'ok', 'bbb') = 'changed');
  perform public.schedule_source_checked(v_src, 'ok', 'ccc');
  perform pg_temp.ok('S8 one review row however many changes',
    (select count(*) from public.court_schedule_proposals where source_id = v_src and status = 'pending') = 1);
  perform pg_temp.ok('S8 a changed page doesn''t confirm its sessions',
    not exists (select 1 from public.court_sessions where source_id = v_src and last_verified_at > now() - interval '1 day'));
  perform pg_temp.ok('S8 no page text is kept',
    not exists (select 1 from information_schema.columns where table_schema = 'public'
                 and table_name = 'court_schedule_sources' and column_name ~ 'text|body|html|excerpt'));

  select id into v_id from public.court_schedule_proposals where source_id = v_src and status = 'pending';
  perform pg_temp.as_user(pg_temp.p('GM'));
  perform public.admin_resolve_schedule_proposal(v_id, 'applied');
  e := pg_temp.err(format('select public.admin_resolve_schedule_proposal(%L, %L)', v_id, 'applied'));
  perform pg_temp.ok('S8 reviewed once', e ->> 'hint' = 'pl:schedules.gone', e::text);
  perform pg_temp.as_admin();
  perform pg_temp.ok('S8 reviewed: its sessions count as confirmed',
    not exists (select 1 from public.court_sessions where source_id = v_src and last_verified_at < now() - interval '1 day'));

  -- S9 the weekly push
  select count(*) into v_n from public.push_outbox where push_data ->> 'kind' = 'court_schedule_review';
  perform public.schedule_check_notify(0);
  perform pg_temp.ok('S9 nothing changed: no push',
    (select count(*) from public.push_outbox where push_data ->> 'kind' = 'court_schedule_review') = v_n);
  perform public.schedule_check_notify(2);
  perform pg_temp.ok('S9 changed pages: a push to the admins only',
    (select count(*) from public.push_outbox where push_data ->> 'kind' = 'court_schedule_review') > v_n
    and not exists (select 1 from public.push_outbox o where o.push_data ->> 'kind' = 'court_schedule_review'
                       and not public.is_godmode_user(o.recipient_id)));

  -- S10 the hardening re-run
  perform pg_temp.ok('S10 the client RPCs stay online',
    has_function_privilege('authenticated', 'public.list_court_sessions(text)', 'execute')
    and has_function_privilege('authenticated', 'public.nearby_court_schedules()', 'execute')
    and has_function_privilege('authenticated', 'public.suggest_court_schedule(text, text)', 'execute')
    and has_function_privilege('authenticated', 'public.admin_schedule_review()', 'execute'));
  perform pg_temp.ok('S10 the check stays service role only',
    not has_function_privilege('authenticated', 'public.schedule_source_checked(uuid, text, text)', 'execute')
    and not has_function_privilege('anon', 'public.schedule_check_notify(integer)', 'execute')
    and has_function_privilege('service_role', 'public.schedule_source_checked(uuid, text, text)', 'execute'));
  perform pg_temp.ok('S10 the job is scheduled', exists (select 1 from cron.job where jobname = 'pickleague-schedule-check'));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('ABORTED', false, sqlerrm);
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
