-- ============================================================
-- Shop reprice persona tests (migration_shop_reprice.sql).
--
-- NOT runnable on its own: build-shop-reprice-test.mjs puts, at the marker
-- line below, migration_shop_reprice.sql twice (a re-run must not multiply
-- again). Everything runs inside the begin / rollback below, so the linked
-- (live) database is left untouched:
--   node supabase/tests/build-shop-reprice-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary.
--
-- Test items (made before the migration runs): 500, 700, 750, 1,000, 1,100,
-- and a free one. Persona BU has 899 pickles, then 900.
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
insert into _p values ('BU', 'a9b00000-0000-4000-8000-000000000001');
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

create function pg_temp.cost(p_slug text) returns integer language sql stable as $$
  select cost from public.shop_items where slug = p_slug $$;

-- Test items, in place before the migration runs.
insert into public.shop_items (slug, category, name, description, icon, cost, sort_order) values
  ('test-reprice-500',  'cosmetic_badge', 'Reprice 500',  'test', 'T', 500,  999),
  ('test-reprice-700',  'cosmetic_badge', 'Reprice 700',  'test', 'T', 700,  999),
  ('test-reprice-750',  'cosmetic_badge', 'Reprice 750',  'test', 'T', 750,  999),
  ('test-reprice-1000', 'cosmetic_badge', 'Reprice 1000', 'test', 'T', 1000, 999),
  ('test-reprice-1100', 'cosmetic_badge', 'Reprice 1100', 'test', 'T', 1100, 999),
  ('test-reprice-free', 'cosmetic_badge', 'Reprice free', 'test', 'T', 0,    999);

-- @@MIGRATION@@


-- ════ R1 the new prices (after two runs) ═════════════════════════════════
do $$
begin
  perform pg_temp.ok('R1 500 -> 900 (the floor), 700 -> 1,050, 750 -> 1,150, 1,000 -> 1,500',
    pg_temp.cost('test-reprice-500') = 900 and pg_temp.cost('test-reprice-700') = 1050
    and pg_temp.cost('test-reprice-750') = 1150 and pg_temp.cost('test-reprice-1000') = 1500,
    format('%s %s %s %s', pg_temp.cost('test-reprice-500'), pg_temp.cost('test-reprice-700'),
           pg_temp.cost('test-reprice-750'), pg_temp.cost('test-reprice-1000')));
  perform pg_temp.ok('R1 over 1,000 and free items are unchanged',
    pg_temp.cost('test-reprice-1100') = 1100 and pg_temp.cost('test-reprice-free') = 0);
  perform pg_temp.ok('R1 a second run did not multiply again (one history row each)',
    (select count(*) from public.shop_price_changes where slug like 'test-reprice-%') = 4);
  perform pg_temp.ok('R1 nothing for sale costs under 900 any more',
    not exists (select 1 from public.shop_items where cost between 1 and 899 and category <> 'real_world'),
    (select string_agg(slug || '=' || cost, ', ') from public.shop_items where cost between 1 and 899 and category <> 'real_world'));
  perform pg_temp.ok('R1 price history is server-only',
    not has_table_privilege('authenticated', 'public.shop_price_changes', 'select')
    and not has_table_privilege('anon', 'public.shop_price_changes', 'select'));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('R1 block crashed', false, sqlerrm);
end $$;


-- ════ R2 buying pays the new price ═══════════════════════════════════════
do $$
declare
  j jsonb;
  v_item uuid := (select id from public.shop_items where slug = 'test-reprice-500');
begin
  -- Badge pickles off, so a purchase badge can't change the balance checked here.
  perform set_config('pickleague.skip_badge_pickle_grant', 'on', true);
  insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
  values (pg_temp.p('BU'), 'reprice-bu@pickleague.test', jsonb_build_object('full_name', 'Reprice Buyer'), now());
  update public.profiles set pickles = 899 where id = pg_temp.p('BU');
  j := pg_temp.json_as('BU', format('select to_jsonb(x) from public.purchase_shop_item(%L) x', v_item));
  perform pg_temp.ok('R2 899 pickles can''t buy the old 500 item',
    coalesce((j ->> 'success')::boolean, false) = false and (select pickles from public.profiles where id = pg_temp.p('BU')) = 899, j::text);
  update public.profiles set pickles = 900 where id = pg_temp.p('BU');
  j := pg_temp.json_as('BU', format('select to_jsonb(x) from public.purchase_shop_item(%L) x', v_item));
  perform pg_temp.ok('R2 900 pickles buys it and leaves 0',
    (j ->> 'success')::boolean and (select pickles from public.profiles where id = pg_temp.p('BU')) = 0, j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('R2 block crashed', false, sqlerrm);
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
