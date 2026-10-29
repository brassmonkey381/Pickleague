-- ============================================================
-- Seen prompts persona tests (migration_seen_prompts.sql).
--
-- NOT runnable on its own: build-seen-prompts-test.mjs puts, at the marker
-- line below, migration_seen_prompts.sql twice (it must be re-runnable).
-- Everything runs inside the begin / rollback below, so the linked (live)
-- database is left untouched:
--   node supabase/tests/build-seen-prompts-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary.
--
-- Personas (temporary accounts made inside the transaction):
--   SA  marks the guide seen, reads it, clears it
--   SB  another player: can't see, add or clear SA's rows
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
  ('SA', 'a9c00000-0000-4000-8000-000000000001'), ('SB', 'a9c00000-0000-4000-8000-000000000002');
grant select on _p to authenticated, anon;

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
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  perform set_config('role', 'anon', true);
end $$;

create function pg_temp.as_admin() returns void language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

-- One JSON value p_sql returns as persona k ('anon' for signed out); {"error": ...} when it failed.
create function pg_temp.json_as(k text, p_sql text) returns jsonb language plpgsql as $$
declare
  j jsonb;
begin
  if k = 'anon' then perform pg_temp.as_anon(); else perform pg_temp.as_user(pg_temp.p(k)); end if;
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


-- ════ Setup ══════════════════════════════════════════════════════════════
do $$
begin
  perform pg_temp.as_admin();
  insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
  select id, 'seen-' || lower(k) || '@pickleague.test', jsonb_build_object('full_name', 'Seen Player ' || k), now()
    from _p;
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('SETUP crashed', false, sqlerrm);
end $$;


-- ════ S1 own rows ════════════════════════════════════════════════════════
do $$
declare
  j jsonb;
begin
  j := pg_temp.json_as('SA', format(
    'with i as (insert into public.user_seen_prompts (user_id, key) values (%L, ''share_link_sticker_guide'') returning 1) select to_jsonb(count(*)) from i',
    pg_temp.p('SA')));
  perform pg_temp.ok('S1 a player marks a guide seen', j = '1'::jsonb, j::text);
  j := pg_temp.json_as('SA', 'select to_jsonb(count(*)) from public.user_seen_prompts');
  perform pg_temp.ok('S1 ...and reads it back', j = '1'::jsonb, j::text);
  j := pg_temp.json_as('SA', format(
    'with i as (insert into public.user_seen_prompts (user_id, key) values (%L, ''share_link_sticker_guide'') on conflict do nothing returning 1) select to_jsonb(count(*)) from i',
    pg_temp.p('SA')));
  perform pg_temp.ok('S1 marking it again is a no-op', j = '0'::jsonb, j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('S1 block crashed', false, sqlerrm);
end $$;


-- ════ S2 other players and signed out ════════════════════════════════════
do $$
declare
  j jsonb;
begin
  j := pg_temp.json_as('SB', 'select to_jsonb(count(*)) from public.user_seen_prompts');
  perform pg_temp.ok('S2 another player sees none of SA''s rows', j = '0'::jsonb, j::text);
  j := pg_temp.json_as('SB', format(
    'with i as (insert into public.user_seen_prompts (user_id, key) values (%L, ''planted'') returning 1) select to_jsonb(count(*)) from i',
    pg_temp.p('SA')));
  perform pg_temp.ok('S2 another player can''t add a row for SA', j ? 'error', j::text);
  j := pg_temp.json_as('SB', 'with d as (delete from public.user_seen_prompts returning 1) select to_jsonb(count(*)) from d');
  perform pg_temp.ok('S2 another player can''t clear SA''s rows',
    j = '0'::jsonb and (select count(*) from public.user_seen_prompts where user_id = pg_temp.p('SA')) = 1, j::text);
  j := pg_temp.json_as('anon', 'select to_jsonb(count(*)) from public.user_seen_prompts');
  perform pg_temp.ok('S2 signed out reads nothing', j ? 'error' or j = '0'::jsonb, j::text);
  perform pg_temp.ok('S2 signed out has no table privileges',
    not has_table_privilege('anon', 'public.user_seen_prompts', 'select')
    and not has_table_privilege('anon', 'public.user_seen_prompts', 'insert'));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('S2 block crashed', false, sqlerrm);
end $$;


-- ════ S3 clearing your own ═══════════════════════════════════════════════
do $$
declare
  j jsonb;
begin
  j := pg_temp.json_as('SA', 'with d as (delete from public.user_seen_prompts returning 1) select to_jsonb(count(*)) from d');
  perform pg_temp.ok('S3 a player clears their own rows', j = '1'::jsonb, j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('S3 block crashed', false, sqlerrm);
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
