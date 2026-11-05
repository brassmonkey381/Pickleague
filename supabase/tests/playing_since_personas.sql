-- ============================================================
-- Playing since (persona tests for migration_profile_playing_since.sql).
--
-- NOT runnable on its own: build-playing-since-test.mjs puts, at the marker
-- line below, migration_profile_playing_since.sql twice (it must be
-- re-runnable) and then migration_rls_hardening_2026q3.sql (a re-run must
-- keep set_playing_since online). Everything runs inside the begin /
-- rollback below, so the linked (live) database is left untouched:
--   node supabase/tests/build-playing-since-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary.
--
-- Personas (temporary accounts created inside the transaction):
--   PA sets, moves and clears their month
--   PB another player, whose month PA can't touch
-- ============================================================

begin;

alter default privileges for role postgres grant execute on functions to public;

-- ════ Harness ════════════════════════════════════════════════════════════
create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);
grant select, insert on _results to authenticated;
grant usage on sequence _results_n_seq to authenticated;

create temp table _p (k text primary key, id uuid not null);
insert into _p values
  ('PA', 'a6000000-0000-4000-8000-000000000001'), ('PB', 'a6000000-0000-4000-8000-000000000002');
grant select on _p to authenticated;

create function pg_temp.p(text) returns uuid language sql stable as $$ select id from _p where k = $1 $$;

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

-- plpgsql, not sql: a sql body is checked when it's created, and the column
-- only exists once the migration below has run.
create function pg_temp.since(k text) returns date language plpgsql stable as $$
begin
  return (select playing_since from public.profiles where id = pg_temp.p(k));
end $$;

-- ════ Setup ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data)
select id, 'ps-' || lower(k) || '@pickleague.test', jsonb_build_object('full_name', 'Playing Since ' || k)
  from _p;

-- @@MIGRATION@@

-- ════ Checks ═════════════════════════════════════════════════════════════
do $$
declare
  e jsonb;
begin
  -- P1 a player sets their month; any day keeps its month
  perform pg_temp.as_user(pg_temp.p('PA'));
  perform pg_temp.ok('P1 set returns the month', public.set_playing_since(date '2021-03-17') = date '2021-03-01');
  perform pg_temp.as_admin();
  perform pg_temp.ok('P1 ... stored as the first of the month', pg_temp.since('PA') = date '2021-03-01', pg_temp.since('PA')::text);

  -- P2 out of range: before 1965, after this month
  perform pg_temp.as_user(pg_temp.p('PA'));
  e := pg_temp.err($q$ select public.set_playing_since(date '1960-05-01') $q$);
  perform pg_temp.ok('P2 before 1965 refused', e ->> 'hint' = 'pl:profile.playing_since_range', e::text);
  e := pg_temp.err(format('select public.set_playing_since(%L::date)', (date_trunc('month', current_date) + interval '1 month')::date));
  perform pg_temp.ok('P2 next month refused', e ->> 'hint' = 'pl:profile.playing_since_range', e::text);
  perform pg_temp.ok('P2 this month allowed', public.set_playing_since(current_date) = date_trunc('month', current_date)::date);

  -- P3 null clears
  perform pg_temp.ok('P3 null clears', public.set_playing_since(null) is null);
  perform pg_temp.as_admin();
  perform pg_temp.ok('P3 ... stored null', pg_temp.since('PA') is null);

  -- P4 only your own row; a direct update is still refused by the column guard
  perform pg_temp.as_user(pg_temp.p('PB'));
  perform public.set_playing_since(date '2019-06-01');
  perform pg_temp.as_admin();
  perform pg_temp.ok('P4 PB set only PB', pg_temp.since('PB') = date '2019-06-01' and pg_temp.since('PA') is null);
  perform pg_temp.as_user(pg_temp.p('PA'));
  e := pg_temp.err(format('update public.profiles set playing_since = %L where id = %L', '2010-01-01', pg_temp.p('PA')));
  perform pg_temp.ok('P4 direct update refused by the guard', e ->> 'hint' = 'pl:profile.server_owned', e::text);

  -- P5 signed out: no execute
  perform pg_temp.as_anon();
  e := pg_temp.err($q$ select public.set_playing_since(date '2020-01-01') $q$);
  perform pg_temp.ok('P5 anon refused', e is not null, e::text);
  perform pg_temp.as_admin();

  -- P6 grants survive the hardening re-run
  perform pg_temp.ok('P6 authenticated can execute',
    has_function_privilege('authenticated', 'public.set_playing_since(date)', 'execute'));
  perform pg_temp.ok('P6 anon cannot',
    not has_function_privilege('anon', 'public.set_playing_since(date)', 'execute'));
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
