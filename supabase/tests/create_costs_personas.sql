-- ============================================================
-- Create cost persona tests (migration_create_costs.sql).
--
-- NOT runnable on its own: build-create-costs-test.mjs puts, at the marker
-- line below, migration_create_costs.sql twice (it must be re-runnable) and
-- then migration_rls_hardening_2026q3.sql. Everything runs inside the begin /
-- rollback below, so the linked (live) database is left untouched:
--   node supabase/tests/build-create-costs-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary.
--
-- Personas (temporary accounts made inside the transaction):
--   RI  has 10,000 pickles: starts a league and a tournament, then tries a second of each
--   PO  has 100 pickles: can't afford a league
--   AD  already admins an active league (made before the rule): can't start another
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
  ('RI', 'a9a00000-0000-4000-8000-000000000001'), ('PO', 'a9a00000-0000-4000-8000-000000000002'),
  ('AD', 'a9a00000-0000-4000-8000-000000000003');
grant select on _p to authenticated, anon;

create function pg_temp.p(text) returns uuid language sql stable as $$ select id from _p where k = $1 $$;
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

create function pg_temp.pickles(k text) returns integer language sql stable as $$
  select coalesce(pickles, 0) from public.profiles where id = pg_temp.p(k) $$;

-- @@MIGRATION@@


-- ════ Setup ══════════════════════════════════════════════════════════════
do $$
begin
  perform pg_temp.as_admin();
  insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
  select id, 'cost-' || lower(k) || '@pickleague.test', jsonb_build_object('full_name', 'Cost Player ' || k), now()
    from _p;
  update public.profiles set pickles = 10000 where id = pg_temp.p('RI');
  update public.profiles set pickles = 100 where id = pg_temp.p('PO');
  update public.profiles set pickles = 10000 where id = pg_temp.p('AD');
  -- AD's league, made as the server (free, like every existing league).
  insert into public.leagues (id, name, is_open, created_by)
  values ('b9a00000-0000-4000-8000-000000000001', 'Cost Existing League', true, pg_temp.p('AD'));
  insert into public.league_members (league_id, user_id, role)
  values ('b9a00000-0000-4000-8000-000000000001', pg_temp.p('AD'), 'admin');
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('SETUP crashed', false, sqlerrm);
end $$;

create function pg_temp.new_league(k text, p_name text) returns jsonb language sql as $$
  select pg_temp.json_as(k, format(
    'with i as (insert into public.leagues (name, is_open, created_by) values (%L, true, %L) returning id) select to_jsonb(id) from i',
    p_name, pg_temp.p(k))) $$;
create function pg_temp.new_tournament(k text, p_name text) returns jsonb language sql as $$
  select pg_temp.json_as(k, format(
    'with i as (insert into public.tournaments (name, format, created_by) values (%L, ''round_robin'', %L) returning id) select to_jsonb(id) from i',
    p_name, pg_temp.p(k))) $$;


-- ════ K1 installed ═══════════════════════════════════════════════════════
do $$
begin
  perform pg_temp.ok('K1 cost triggers on leagues and tournaments, refund on tournaments',
    (select count(*) from pg_trigger where tgname in ('trg_pl_league_create_cost', 'trg_pl_tournament_create_cost',
                                                      'trg_pl_tournament_create_refund')) = 3);
  perform pg_temp.ok('K1 the helpers are not client-callable',
    not has_function_privilege('authenticated', 'public._pl_create_limit(uuid,text)', 'execute')
    and not has_function_privilege('authenticated', 'public._pl_charge_create()', 'execute'));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('K1 block crashed', false, sqlerrm);
end $$;


-- ════ K2 a league costs 5,000; one active at a time ══════════════════════
do $$
declare
  j jsonb;
begin
  j := pg_temp.new_league('RI', 'Cost League One');
  perform pg_temp.ok('K2 a player with 10,000 starts a league for 5,000',
    jsonb_typeof(j) = 'string' and pg_temp.pickles('RI') = 5000, j::text || ' balance ' || pg_temp.pickles('RI'));
  perform pg_temp.ok('K2 ...named in pickle history',
    exists (select 1 from public.pickle_ledger where profile_id = pg_temp.p('RI') and delta = -5000
             and reason = 'Started a league: Cost League One' and kind = 'spend'));
  j := pg_temp.new_league('RI', 'Cost League Two');
  perform pg_temp.ok('K2 a second active league is refused (limit 1)',
    j ->> 'hint' = 'pl:create.limit' and pg_temp.pickles('RI') = 5000, j::text);
  j := pg_temp.new_league('PO', 'Cost Poor League');
  perform pg_temp.ok('K2 100 pickles can''t start a league',
    j ->> 'hint' = 'pl:create.cost' and pg_temp.pickles('PO') = 100, j::text);
  j := pg_temp.new_league('AD', 'Cost Admin League');
  perform pg_temp.ok('K2 someone already running a league (from before) can''t start another',
    j ->> 'hint' = 'pl:create.limit', j::text);
  perform pg_temp.ok('K2 ...and existing leagues were not charged', pg_temp.pickles('AD') = 10000);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('K2 block crashed', false, sqlerrm);
end $$;


-- ════ K3 a tournament costs 2,500; refunded if cancelled before it starts ═
do $$
declare
  j  jsonb;
  t1 uuid;
begin
  j := pg_temp.new_tournament('RI', 'Cost Cup');
  t1 := (j #>> '{}')::uuid;
  perform pg_temp.ok('K3 a tournament costs 2,500', t1 is not null and pg_temp.pickles('RI') = 2500,
    j::text || ' balance ' || pg_temp.pickles('RI'));
  j := pg_temp.new_tournament('RI', 'Cost Cup Two');
  perform pg_temp.ok('K3 a second active tournament is refused', j ->> 'hint' = 'pl:create.limit', j::text);
  j := pg_temp.json_as('RI', format(
    'with u as (update public.tournaments set status = ''cancelled'' where id = %L returning 1) select to_jsonb(count(*)) from u', t1));
  perform pg_temp.ok('K3 cancelled before it starts: the 2,500 comes back',
    j = '1'::jsonb and pg_temp.pickles('RI') = 5000, j::text || ' balance ' || pg_temp.pickles('RI'));
  j := pg_temp.new_tournament('RI', 'Cost Cup Three');
  perform pg_temp.ok('K3 ...and a new one can start', jsonb_typeof(j) = 'string' and pg_temp.pickles('RI') = 2500, j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('K3 block crashed', false, sqlerrm);
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
