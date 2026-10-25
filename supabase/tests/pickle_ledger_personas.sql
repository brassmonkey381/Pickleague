-- ============================================================
-- Pickle history: persona tests for migration_pickle_ledger.sql.
--
-- NOT runnable on its own: build-pickle-ledger-test.mjs puts
-- migration_pickle_ledger.sql (twice: it must be re-runnable) and then
-- migration_rls_hardening_2026q3.sql (a re-run must keep the new RPCs online)
-- at the marker line below. Everything runs inside the begin / rollback
-- below, so the linked (live) database is left untouched:
--   node supabase/tests/build-pickle-ledger-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary.
--
-- now() is fixed for the whole transaction, so every row written here has
-- the same created_at (the id breaks the tie, as in one real transaction that
-- writes several rows); the calendar tests backdate one row.
--
-- Personas (temporary accounts, @pickleague.test emails, created BEFORE the
-- migration so the starting balances are the backfill's):
--   PA  Avery: starts with 3000, zone Pacific/Kiritimati, a 1-day play streak
--       yesterday; buys in the Shop, gifts Dana an item, plays PB, claims the
--       daily login and a getting-started step; the feed / calendar persona
--   PB  Blake: PA's opponent (starts at 0: no starting row)
--   PW  Wren: starts with 1000; bets on PA's match (one won, one cancelled)
--   PR  Riley: a referrer (90 days old)    PN  Noor: claims Riley's code
--   PG  Gale: gets a God mode gift          PD  Dana: starts with 1000, claims
--       the welcome pickles, then deletes the account
--   PX  Xavi: starts with 500; real-world redemptions (one item switched on,
--       rolled back), direct changes, caller labels, a broken ledger
--   PI  Ivy: a profile inserted with 300 pickles (no auth user; the insert trigger)
--   AD  the real God mode account (is_godmode_user): sends Gale the gift.
--       Only its rows from this run are checked; its balance is topped up
--       (rolled back) if it is under 300.
-- ============================================================

begin;
-- Don't queue behind a long transaction on profiles (and block others behind us).
set local lock_timeout = '15s';

-- ════ Harness ════════════════════════════════════════════════════════════
create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);
grant select, insert on _results to authenticated, anon;
grant usage on sequence _results_n_seq to authenticated, anon;

create temp table _p (k text primary key, id uuid not null, name text);
insert into _p values
  ('PA', 'a9500000-0000-4000-8000-000000000001', 'Avery Ledger'),
  ('PB', 'a9500000-0000-4000-8000-000000000002', 'Blake Ledger'),
  ('PW', 'a9500000-0000-4000-8000-000000000003', 'Wren Ledger'),
  ('PR', 'a9500000-0000-4000-8000-000000000004', 'Riley Ledger'),
  ('PN', 'a9500000-0000-4000-8000-000000000005', 'Noor Ledger'),
  ('PG', 'a9500000-0000-4000-8000-000000000006', 'Gale Ledger'),
  ('PD', 'a9500000-0000-4000-8000-000000000007', 'Dana Ledger'),
  ('PX', 'a9500000-0000-4000-8000-000000000008', 'Xavi Ledger'),
  ('PI', 'a9500000-0000-4000-8000-000000000009', 'Ivy Ledger'),
  ('AD', '252a36e1-5d89-4ad2-8a3e-b786579f019a', null);
grant select on _p to authenticated, anon;

-- Ids the sections hand on (items, the match).
create temp table _ids (k text primary key, id uuid);
grant select, insert, update on _ids to authenticated, anon;

create function pg_temp.p(text) returns uuid language sql stable as $$ select id from _p where k = $1 $$;
create function pg_temp.i(text) returns uuid language sql stable as $$ select id from _ids where k = $1 $$;
create function pg_temp.keep(p_k text, p_id uuid) returns void language sql as $$
  insert into _ids values (p_k, p_id) on conflict (k) do update set id = excluded.id
$$;
create function pg_temp.pickles(k text) returns integer language sql stable as $$
  select pickles from public.profiles where id = pg_temp.p(k) $$;

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

-- Runs p_sql as the current role; null if it went through, else the error's
-- message, hint, detail, state.
create function pg_temp.err(p_sql text) returns jsonb language plpgsql as $$
declare
  v_msg    text;
  v_hint   text;
  v_detail text;
  v_state  text;
begin
  execute p_sql;
  return null;
exception when others then
  get stacked diagnostics v_msg = message_text, v_hint = pg_exception_hint, v_detail = pg_exception_detail,
                          v_state = returned_sqlstate;
  return jsonb_build_object('msg', v_msg, 'hint', v_hint, 'detail', v_detail, 'state', v_state);
end $$;
grant execute on function pg_temp.err(text) to authenticated, anon;

-- The error from p_sql as persona k / signed out / anon. Leaves the role as admin.
create function pg_temp.err_as(k text, p_sql text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.as_user(pg_temp.p(k));
  v := pg_temp.err(p_sql);
  perform pg_temp.as_admin();
  return v;
end $$;
create function pg_temp.err_out(p_sql text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.as_signed_out();
  v := pg_temp.err(p_sql);
  perform pg_temp.as_admin();
  return v;
end $$;
create function pg_temp.err_anon(p_sql text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.as_anon();
  v := pg_temp.err(p_sql);
  perform pg_temp.as_admin();
  return v;
end $$;

-- The rows of p_sql run as persona k, as a jsonb array. An unexpected error
-- is a failed row (not an aborted run) and null. Leaves the role as admin.
create function pg_temp.q(k text, p_sql text) returns jsonb language plpgsql as $$
declare
  v      jsonb;
  v_msg  text;
  v_hint text;
begin
  begin
    perform pg_temp.as_user(pg_temp.p(k));
    execute format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) from (%s) x', p_sql) into v;
    perform pg_temp.as_admin();
  exception when others then
    get stacked diagnostics v_msg = message_text, v_hint = pg_exception_hint;
    perform pg_temp.as_admin();
    perform pg_temp.ok('UNEXPECTED ERROR as ' || k || ': ' || p_sql, false, v_msg || ' [' || coalesce(v_hint, '') || ']');
    return null;
  end;
  return v;
end $$;

-- The ids of a jsonb array of rows, in order.
create function pg_temp.ids(j jsonb) returns bigint[] language sql immutable as $$
  select coalesce(array_agg((e ->> 'id')::bigint order by o), '{}')
    from jsonb_array_elements(coalesce(j, '[]'::jsonb)) with ordinality as t (e, o)
$$;


-- ════ Setup (before the migration: the starting balances are the backfill's) ═
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
select id, 'pl-ledger-' || lower(k) || '@pickleague.test', jsonb_build_object('full_name', name), now()
  from _p where k not in ('AD', 'PI');
update public.profiles p set full_name = x.name from _p x where p.id = x.id and x.k not in ('AD', 'PI');
update public.profiles set created_at = now() - interval '90 days' where id = pg_temp.p('PR');
update public.profiles set created_at = now() - interval '30 days' where id in (pg_temp.p('PA'), pg_temp.p('PB'));
update public.profiles set gender = 'male' where id in (pg_temp.p('PA'), pg_temp.p('PB'));
update public.profiles set pickles = 3000 where id = pg_temp.p('PA');
update public.profiles set pickles = 1000 where id in (pg_temp.p('PW'), pg_temp.p('PD'));
update public.profiles set pickles = 500 where id = pg_temp.p('PX');

insert into public.pickleague_time_zones (profile_id, tz) values (pg_temp.p('PA'), 'Pacific/Kiritimati')
on conflict (profile_id) do update set tz = excluded.tz;
-- PA played yesterday (in their zone): today's match is day 2 of the streak.
insert into public.daily_play_streaks (user_id, play_date, streak_length, bonus_granted)
values (pg_temp.p('PA'), (now() at time zone 'Pacific/Kiritimati')::date - 1, 1, 50);

insert into public.leagues (id, name, is_open, created_by)
values ('b9500000-0000-4000-8000-000000000001', 'Ledger Test League', true, pg_temp.p('PA'));
insert into public.league_members (league_id, user_id, role) values
  ('b9500000-0000-4000-8000-000000000001', pg_temp.p('PA'), 'admin'),
  ('b9500000-0000-4000-8000-000000000001', pg_temp.p('PB'), 'member')
on conflict do nothing;

-- @@MIGRATION@@


-- ════ Helpers that read pickle_ledger (after it exists) ══════════════════
create function pg_temp.n_of(k text) returns bigint language sql stable as $$
  select count(*) from public.pickle_ledger where profile_id = pg_temp.p(k) $$;
create function pg_temp.last_of(k text) returns public.pickle_ledger language sql stable as $$
  select * from public.pickle_ledger where profile_id = pg_temp.p(k) order by id desc limit 1 $$;
create function pg_temp.mark() returns bigint language sql stable as $$
  select coalesce(max(id), 0) from public.pickle_ledger $$;
-- Persona k's rows from p_source written after p_mark, oldest first.
create function pg_temp.since(k text, p_mark bigint, p_source text) returns setof public.pickle_ledger
language sql stable as $$
  select * from public.pickle_ledger
   where profile_id = pg_temp.p(k) and id > p_mark and source is not distinct from p_source
   order by id
$$;
create function pg_temp.row_text(l public.pickle_ledger) returns text language sql immutable as $$
  select format('%s %s -> %s "%s" %s/%s bonus=%s src=%s cp=%s meta=%s', l.id, l.delta, l.balance_after, l.reason,
                l.kind, l.category, l.is_bonus, l.source, l.counterpart_id, l.meta)
$$;
-- Persona k's rows whose balance_after doesn't follow from the row before
-- (the first row must start from 0: a starting row does), and whether the
-- last one is the balance on profiles.
create function pg_temp.chain_breaks(k text) returns integer[] language sql stable as $$
  with r as (
    select l.id, l.delta, l.balance_after,
           coalesce(lag(l.balance_after) over (order by l.id), 0) as prev
      from public.pickle_ledger l where l.profile_id = pg_temp.p(k)
  )
  select coalesce(array_agg(r.balance_after - r.delta - r.prev order by r.id) filter (where r.prev + r.delta <> r.balance_after), '{}')
    from r
$$;
create function pg_temp.chain_ends_at_balance(k text) returns boolean language sql stable as $$
  select coalesce((select l.balance_after from public.pickle_ledger l where l.profile_id = pg_temp.p(k)
                    order by l.id desc limit 1), 0) = pg_temp.pickles(k)
$$;
create function pg_temp.first_name(p uuid, p_default text) returns text language sql stable as $$
  select coalesce((select nullif(split_part(btrim(full_name), ' ', 1), '') from public.profiles where id = p), p_default)
$$;


-- ════ L1 installed the way the house rules want ═════════════════════════
do $$
declare
  f         text;
  v_bad     text[] := '{}';
  v_missing text[];
  v_stale   text[];
begin
  perform pg_temp.ok('L1 pickle_ledger: RLS on, one policy: authenticated may select their own rows',
    (select relrowsecurity from pg_class where oid = 'public.pickle_ledger'::regclass)
    and (select count(*) from pg_policies where schemaname = 'public' and tablename = 'pickle_ledger') = 1
    and exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'pickle_ledger'
                   and cmd = 'SELECT' and roles = '{authenticated}' and qual like '%auth.uid()%'),
    (select string_agg(policyname || ' ' || cmd || ' ' || roles::text || ' ' || coalesce(qual, ''), '; ')
       from pg_policies where schemaname = 'public' and tablename = 'pickle_ledger'));
  perform pg_temp.ok('L1 clients may only read the ledger (no insert / update / delete; anon nothing)',
    has_table_privilege('authenticated', 'public.pickle_ledger', 'select')
    and not has_table_privilege('authenticated', 'public.pickle_ledger', 'insert')
    and not has_table_privilege('authenticated', 'public.pickle_ledger', 'update')
    and not has_table_privilege('authenticated', 'public.pickle_ledger', 'delete')
    and not has_table_privilege('anon', 'public.pickle_ledger', 'select'),
    null);
  perform pg_temp.ok('L1 the source map is server-only (RLS on, no client grants)',
    (select relrowsecurity from pg_class where oid = 'public.pickle_ledger_sources'::regclass)
    and not has_table_privilege('authenticated', 'public.pickle_ledger_sources', 'select')
    and not has_table_privilege('anon', 'public.pickle_ledger_sources', 'select'),
    null);

  foreach f in array array['public._pl_pickle_ledger_capture()', 'public._pl_pickle_ledger_item()',
                           'public._pl_pickle_ledger_purge()', 'public.list_pickle_ledger(integer,timestamptz,bigint)',
                           'public.list_pickle_ledger_range(timestamptz,timestamptz)', 'public.my_pickle_today()'] loop
    if not exists (select 1 from pg_proc p where p.oid = to_regprocedure(f) and p.prosecdef
                      and array_to_string(p.proconfig, ',') = 'search_path=""') then
      v_bad := v_bad || f;
    end if;
  end loop;
  perform pg_temp.ok('L1 every new function is security definer with search_path ''''', cardinality(v_bad) = 0,
    array_to_string(v_bad, ', '));

  perform pg_temp.ok('L1 the triggers: capture on update and insert, purge on deletion, the two item triggers; all enabled',
    (select count(*) from pg_trigger t where t.tgrelid = 'public.profiles'::regclass
        and t.tgfoid = 'public._pl_pickle_ledger_capture()'::regprocedure and t.tgenabled = 'O') = 2
    and (select count(*) from pg_trigger t where t.tgrelid = 'public.profiles'::regclass
        and t.tgfoid = 'public._pl_pickle_ledger_purge()'::regprocedure and t.tgenabled = 'O') = 1
    and (select count(*) from pg_trigger t where t.tgrelid = 'public.player_shop_purchases'::regclass
        and t.tgfoid = 'public._pl_pickle_ledger_item()'::regprocedure and t.tgenabled = 'O') = 1
    and (select count(*) from pg_trigger t where t.tgrelid = 'public.redemption_orders'::regclass
        and t.tgfoid = 'public._pl_pickle_ledger_item()'::regprocedure and t.tgenabled = 'O') = 1
    and pg_get_triggerdef((select t.oid from pg_trigger t where t.tgname = 'trg_profiles_pickle_ledger'
                             and t.tgrelid = 'public.profiles'::regclass)) like '%AFTER UPDATE ON public.profiles%WHEN ((old.pickles IS DISTINCT FROM new.pickles))%',
    (select string_agg(pg_get_triggerdef(t.oid), ' | ') from pg_trigger t
      where t.tgfoid in ('public._pl_pickle_ledger_capture()'::regprocedure, 'public._pl_pickle_ledger_purge()'::regprocedure,
                         'public._pl_pickle_ledger_item()'::regprocedure)));

  perform pg_temp.ok('L1 the ledger index serves the feed: (profile_id, created_at desc, id desc)',
    exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'pickle_ledger'
               and indexdef like '%(profile_id, created_at DESC, id DESC)%'),
    null);

  -- Every live function whose body assigns profiles.pickles has a label
  -- (_purge_account tombstones: never recorded).
  select array_agg(distinct p.proname order by p.proname) into v_missing
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prosrc ~* '(\mset|,)\s*pickles\s*='
     and p.proname <> '_purge_account'
     and not exists (select 1 from public.pickle_ledger_sources s where s.source = p.proname);
  perform pg_temp.ok('L1 every live function that assigns profiles.pickles is in pickle_ledger_sources',
    v_missing is null, coalesce('unmapped: ' || array_to_string(v_missing, ', '), 'all mapped'));
  select array_agg(distinct s.source order by s.source) into v_stale
    from public.pickle_ledger_sources s
   where not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                      where n.nspname = 'public' and p.proname = s.source);
  perform pg_temp.ok('INFO map rows naming no live function', true, coalesce(array_to_string(v_stale, ', '), 'none'));
  perform pg_temp.ok('L1 gold rows in the map are all gains of kind bonus',
    not exists (select 1 from public.pickle_ledger_sources s where s.is_bonus and (s.sign <> 1 or s.kind <> 'bonus'))
    and not exists (select 1 from public.pickle_ledger_sources s where s.kind = 'bonus' and not s.is_bonus),
    null);
exception when others then
  perform pg_temp.ok('L1 block crashed', false, sqlerrm);
end $$;


-- ════ L2 the starting balances (the backfill, after two runs) ════════════
do $$
declare
  l    public.pickle_ledger;
  v_n  bigint;
begin
  select count(*) into v_n
    from public.profiles p
   where p.pickles <> 0 and p.deleted_at is null
     and (select count(*) from public.pickle_ledger l2 where l2.profile_id = p.id and l2.kind = 'start') <> 1;
  perform pg_temp.ok('L2 every live profile with pickles has exactly one starting row (the re-run added none)',
    v_n = 0, v_n || ' profiles without exactly one');
  perform pg_temp.ok('L2 ...each for the balance then, and nothing else was written',
    not exists (select 1 from public.pickle_ledger l2 join public.profiles p on p.id = l2.profile_id
                 where l2.kind <> 'start' or l2.delta <> p.pickles or l2.balance_after <> p.pickles),
    null);
  perform pg_temp.ok('L2 a profile at 0 gets no starting row', pg_temp.n_of('PB') = 0, pg_temp.n_of('PB')::text);

  l := pg_temp.last_of('PA');
  perform pg_temp.ok('L2 Avery''s starting row: +3000, neutral (kind start, not gold, no source), flagged in meta',
    pg_temp.n_of('PA') = 1 and l.delta = 3000 and l.balance_after = 3000 and l.reason = 'Starting balance'
    and l.kind = 'start' and l.category = 'start' and not l.is_bonus and l.source is null
    and (l.meta ->> 'starting_balance')::boolean,
    pg_temp.row_text(l));
exception when others then
  perform pg_temp.ok('L2 block crashed', false, sqlerrm);
end $$;


-- ════ L3 the Shop: a purchase and a gifted item ══════════════════════════
do $$
declare
  it1 record;
  it2 record;
  r   record;
  l   public.pickle_ledger;
  n   bigint;
begin
  select id, cost, name into it1
    from public.shop_items
   where is_active and unlock_badge_id is null and category <> 'real_world' and cost > 0 and cost <= 1000
   order by cost, id limit 1;
  select id, cost, name into it2
    from public.shop_items
   where is_active and unlock_badge_id is null and category <> 'real_world' and cost > 0 and cost <= 1000
     and id <> it1.id
   order by cost, id limit 1;
  perform pg_temp.keep('item1', it1.id);
  perform pg_temp.keep('item2', it2.id);

  perform pg_temp.as_user(pg_temp.p('PA'));
  select * into r from public.purchase_shop_item(it1.id);
  perform pg_temp.as_admin();
  l := pg_temp.last_of('PA');
  perform pg_temp.ok('L3 a Shop purchase is a spend row named for the item ("Shop: <item>")',
    r.success and l.delta = -it1.cost and l.reason = 'Shop: ' || it1.name and l.kind = 'spend'
    and l.category = 'shop' and not l.is_bonus and l.source = 'purchase_shop_item'
    and l.balance_after = pg_temp.pickles('PA') and l.meta ->> 'item_id' = it1.id::text and l.meta ->> 'item' = it1.name,
    format('%s (%s): %s / %s; %s', it1.name, it1.cost, r.success, r.message, pg_temp.row_text(l)));

  n := pg_temp.n_of('PD');
  perform pg_temp.as_user(pg_temp.p('PA'));
  select * into r from public.gift_shop_item(it2.id, pg_temp.p('PD'), 'Enjoy!');
  perform pg_temp.as_admin();
  l := pg_temp.last_of('PA');
  perform pg_temp.ok('L3 a gifted item is a spend row naming the item and the friend ("Gift: <item> for Dana")',
    r.success and l.delta = -it2.cost and l.reason = format('Gift: %s for Dana', it2.name) and l.kind = 'spend'
    and l.category = 'gift' and l.source = 'gift_shop_item' and l.counterpart_id = pg_temp.p('PD')
    and l.meta ->> 'item_id' = it2.id::text,
    format('%s (%s): %s / %s; %s', it2.name, it2.cost, r.success, r.message, pg_temp.row_text(l)));
  perform pg_temp.ok('L3 ...and Dana''s history is unchanged (no pickles moved to her)', pg_temp.n_of('PD') = n,
    pg_temp.n_of('PD')::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('L3 block crashed', false, sqlerrm);
end $$;


-- ════ L3b real-world redemptions (redemption_orders names the row) ═══════
-- Retired (migration_retire_real_world_redemptions.sql: items inactive,
-- execute revoked from players), but the functions still change pickles, so
-- they are mapped. Here one item is switched on and the functions run as the
-- owner with Xavi's claims (all rolled back with the rest).
do $$
declare
  it    record;
  r     record;
  l     public.pickle_ledger;
  v_adr jsonb := '{"name": "Xavi Ledger", "line1": "1 Test St", "city": "Testville", "postal_code": "00000", "country": "US"}';
begin
  select id, cost, name, slug into it
    from public.shop_items where category = 'real_world' and cost > 0 order by cost, id limit 1;
  if it.id is null then
    perform pg_temp.ok('INFO no real-world item on live: redemptions not exercised', true, null);
    return;
  end if;
  update public.shop_items set is_active = true where id = it.id;
  update public.profiles set pickles = pickles + 2 * it.cost where id = pg_temp.p('PX');

  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.p('PX'), 'role', 'authenticated')::text, true);
  select * into r from public.redeem_real_world_item(it.id, v_adr);
  perform pg_temp.as_admin();
  l := pg_temp.last_of('PX');
  perform pg_temp.ok('L3b a real-world redemption is a spend row named for the item ("Redeemed: <item>")',
    r.success and l.delta = -r.pickles_paid and l.reason = 'Redeemed: ' || it.name and l.kind = 'spend'
    and l.category = 'shop' and l.source = 'redeem_real_world_item' and l.meta ->> 'item_id' = it.id::text,
    format('%s (%s): %s / %s; %s', it.name, it.cost, r.success, r.message, pg_temp.row_text(l)));

  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.p('PX'), 'role', 'authenticated')::text, true);
  select * into r from public.gift_real_world_item(it.id, pg_temp.p('PG'), 'For you', v_adr);
  perform pg_temp.as_admin();
  l := pg_temp.last_of('PX');
  perform pg_temp.ok('L3b ...and a gifted one names the item and the friend ("Gift: <item> for Gale")',
    r.success and l.delta = -r.pickles_paid and l.reason = format('Gift: %s for Gale', it.name)
    and l.category = 'gift' and l.source = 'gift_real_world_item' and l.counterpart_id = pg_temp.p('PG'),
    format('%s / %s; %s', r.success, r.message, pg_temp.row_text(l)));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('L3b block crashed', false, sqlerrm);
end $$;


-- ════ L4 wagers on a match, and L5 what the match pays ═══════════════════
do $$
declare
  v_m   uuid;
  r     record;
  w1    uuid;
  w2    uuid;
  l     public.pickle_ledger;
  l2    public.pickle_ledger;
  mark  bigint;
  v_pay integer;
  v_n   bigint;
begin
  perform pg_temp.as_user(pg_temp.p('PA'));
  insert into public.matches (league_id, player1_id, player2_id, player1_score, player2_score, match_type,
                              winner_id, winner_team, status, location_name)
  values ('b9500000-0000-4000-8000-000000000001', pg_temp.p('PA'), pg_temp.p('PB'), 11, 5, 'singles',
          pg_temp.p('PA'), 'team1', 'pending', 'PL Ledger Test Court')
  returning id into v_m;
  perform pg_temp.as_admin();
  perform pg_temp.keep('match', v_m);

  perform pg_temp.as_user(pg_temp.p('PW'));
  select * into r from public.place_wager('match', v_m, '{"winner_team": "team1"}'::jsonb, 100);
  w1 := r.wager_id;
  perform pg_temp.as_admin();
  l := pg_temp.last_of('PW');
  perform pg_temp.ok('L4 placing a wager is a spend row ("Wager placed")',
    r.success and l.delta = -100 and l.reason = 'Wager placed' and l.kind = 'spend' and l.category = 'wager'
    and l.source = 'place_wager' and l.balance_after = pg_temp.pickles('PW'),
    format('%s / %s; %s', r.success, r.message, pg_temp.row_text(l)));

  perform pg_temp.as_user(pg_temp.p('PW'));
  select * into r from public.place_wager('match', v_m, '{"winner_team": "team2"}'::jsonb, 50);
  w2 := r.wager_id;
  select * into r from public.cancel_wager(w2);
  perform pg_temp.as_admin();
  l := pg_temp.last_of('PW');
  perform pg_temp.ok('L4 cancelling a wager gives the stake back as a refund row',
    r.success and l.delta = 50 and l.reason = 'Wager cancelled: stake back' and l.kind = 'refund'
    and not l.is_bonus and l.source = 'cancel_wager',
    format('%s / %s; %s', r.success, r.message, pg_temp.row_text(l)));

  -- Blake confirms: the match completes, the wager settles, the grants pay.
  mark := pg_temp.mark();
  perform pg_temp.as_user(pg_temp.p('PB'));
  perform public.confirm_match(v_m);
  perform pg_temp.as_admin();
  perform pg_temp.ok('L4 the match completes', (select status from public.matches where id = v_m) = 'completed', null);

  select potential_payout into v_pay from public.wagers where id = w1;
  select * into l from pg_temp.since('PW', mark, '_settle_wagers_for_match');
  perform pg_temp.ok('L4 a won wager is a regular earned row ("Wager won"), traced to confirm_match',
    l.id is not null and l.delta = v_pay and l.reason = 'Wager won' and l.kind = 'earn' and not l.is_bonus
    and l.category = 'wager' and l.meta ->> 'via' = 'confirm_match'
    and (select status from public.wagers where id = w1) = 'won',
    format('payout %s; %s', v_pay, pg_temp.row_text(l)));

  -- L5: the play streak (the capped kind), the first-match bonus (gold),
  -- the games played, the new court, any badges.
  select * into l from pg_temp.since('PA', mark, '_grant_daily_streak_bonus');
  perform pg_temp.ok('L5 the play streak, day 2 in Avery''s zone: +100, regular (not gold), "Play streak: day 2"',
    l.id is not null and l.delta = 100 and l.reason = 'Play streak: day 2' and l.kind = 'earn'
    and l.category = 'streak' and not l.is_bonus and (l.meta ->> 'streak')::int = 2
    and (l.meta ->> 'play_date')::date = (now() at time zone 'Pacific/Kiritimati')::date
    and l.meta ->> 'via' = 'confirm_match',
    pg_temp.row_text(l));
  select * into l2 from pg_temp.since('PB', mark, '_grant_daily_streak_bonus');
  perform pg_temp.ok('L5 ...and Blake''s first day: +50, "Play streak: day 1"',
    l2.id is not null and l2.delta = 50 and l2.reason = 'Play streak: day 1' and not l2.is_bonus,
    pg_temp.row_text(l2));

  select count(*) into v_n from public.pickle_ledger
   where profile_id in (pg_temp.p('PA'), pg_temp.p('PB')) and id > mark and source = '_grant_first_match_bonus'
     and reason = 'First match bonus' and is_bonus and kind = 'bonus' and category = 'match' and delta > 0;
  perform pg_temp.ok('L5 the first-match bonus is gold, one for each player', v_n = 2, v_n::text);
  select count(*) into v_n from public.pickle_ledger
   where profile_id in (pg_temp.p('PA'), pg_temp.p('PB')) and id > mark and source = '_grant_match_game_bonus'
     and reason = 'Match played' and kind = 'earn' and not is_bonus and delta > 0;
  perform pg_temp.ok('L5 each player gets a regular "Match played" row', v_n = 2, v_n::text);
  select * into l from pg_temp.since('PA', mark, '_grant_court_bonus');
  perform pg_temp.ok('L5 a new court is named: "New court: PL Ledger Test Court"',
    l.id is not null and l.reason = 'New court: PL Ledger Test Court' and l.kind = 'earn' and l.category = 'court'
    and l.meta ->> 'court' = 'PL Ledger Test Court',
    pg_temp.row_text(l));
  select count(*) into v_n from public.pickle_ledger
   where profile_id in (pg_temp.p('PA'), pg_temp.p('PB')) and id > mark and source = '_grant_pickles_on_badge';
  perform pg_temp.ok('L5 every badge the match brought is named ("Badge: <name>")',
    not exists (select 1 from public.pickle_ledger
                 where profile_id in (pg_temp.p('PA'), pg_temp.p('PB')) and id > mark
                   and source = '_grant_pickles_on_badge'
                   and (reason not like 'Badge: %' or meta ->> 'badge' is null or kind <> 'earn')),
    v_n || ' badge rows: ' || coalesce((select string_agg(reason, ', ') from public.pickle_ledger
      where profile_id in (pg_temp.p('PA'), pg_temp.p('PB')) and id > mark and source = '_grant_pickles_on_badge'), 'none'));
  perform pg_temp.ok('L5 nothing the match paid fell through to "Pickles adjusted"',
    not exists (select 1 from public.pickle_ledger
                 where profile_id in (pg_temp.p('PA'), pg_temp.p('PB'), pg_temp.p('PW')) and id > mark
                   and kind = 'adjust'),
    (select string_agg(coalesce(source, 'null') || ':' || reason, ', ') from public.pickle_ledger
      where profile_id in (pg_temp.p('PA'), pg_temp.p('PB'), pg_temp.p('PW')) and id > mark and kind = 'adjust'));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('L4 / L5 block crashed', false, sqlerrm);
end $$;


-- ════ L6 the daily login and a getting-started step (gold) ═══════════════
do $$
declare
  s record;
  f record;
  l public.pickle_ledger;
begin
  perform pg_temp.as_user(pg_temp.p('PA'));
  select * into s from public.claim_daily_login_streak();
  perform pg_temp.as_admin();
  l := pg_temp.last_of('PA');
  perform pg_temp.ok('L6 the daily login is gold, named for the streak day ("Daily login: day 1")',
    s.claimed_today and l.delta = s.daily_pickles + s.milestone_pickles
    and l.reason = format('Daily login: day %s', s.streak_after) and l.is_bonus and l.kind = 'bonus'
    and l.category = 'login' and l.source = 'claim_daily_login_streak',
    pg_temp.row_text(l));

  perform pg_temp.as_user(pg_temp.p('PA'));
  select * into f from public.claim_ftue_step('first_match');
  perform pg_temp.as_admin();
  l := pg_temp.last_of('PA');
  perform pg_temp.ok('L6 a getting-started step is gold and says which ("Getting started: played a first match")',
    f.success and l.delta = f.granted and l.reason = 'Getting started: played a first match' and l.is_bonus
    and l.kind = 'bonus' and l.category = 'welcome' and l.meta ->> 'step' = 'first_match'
    and l.source = 'claim_ftue_step',
    format('%s / %s; %s', f.success, f.message, pg_temp.row_text(l)));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('L6 block crashed', false, sqlerrm);
end $$;


-- ════ L7 a referral (claim_referral -> _pl_pay_referral_reward) ══════════
do $$
declare
  r     jsonb;
  mark  bigint := pg_temp.mark();
  lr    public.pickle_ledger;
  ln    public.pickle_ledger;
  lb    public.pickle_ledger;
begin
  perform pg_temp.as_user(pg_temp.p('PN'));
  r := public.claim_referral((select referral_code from public.profiles where id = pg_temp.p('PR')));
  perform pg_temp.as_admin();
  select * into lr from pg_temp.since('PR', mark, '_pl_pay_referral_reward');
  select * into ln from pg_temp.since('PN', mark, '_pl_pay_referral_reward');
  perform pg_temp.ok('L7 a referral pays both sides in gold, each naming the other',
    (r ->> 'rewarded')::boolean
    and lr.reason = 'Referral: Noor joined' and lr.is_bonus and lr.kind = 'bonus' and lr.category = 'referral'
    and lr.counterpart_id = pg_temp.p('PN') and lr.delta >= 2500
    and ln.reason = 'Joined with Riley''s invite' and ln.is_bonus and ln.kind = 'bonus'
    and ln.counterpart_id = pg_temp.p('PR') and ln.delta = 2500
    and lr.meta ->> 'referral_id' = ln.meta ->> 'referral_id' and lr.meta ->> 'via' = 'claim_referral',
    format('%s; %s; %s', r, pg_temp.row_text(lr), pg_temp.row_text(ln)));

  if exists (select 1 from public.player_badges pb join public.badges b on b.id = pb.badge_id
              where pb.user_id = pg_temp.p('PR') and b.name = 'Recruiter') then
    select * into lb from pg_temp.since('PR', mark, '_grant_pickles_on_badge') limit 1;
    perform pg_temp.ok('L7 ...the Recruiter badge''s pickles are their own regular row, traced to claim_referral',
      lb.reason = 'Badge: Recruiter' and lb.kind = 'earn' and not lb.is_bonus and lb.meta ->> 'via' = 'claim_referral',
      pg_temp.row_text(lb));
  else
    perform pg_temp.ok('INFO no Recruiter badge was awarded (none on live?)', true, null);
  end if;
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('L7 block crashed', false, sqlerrm);
end $$;


-- ════ L8 a God mode gift, L9 the welcome pickles ═════════════════════════
do $$
declare
  g     record;
  w     record;
  mark  bigint;
  lg    public.pickle_ledger;
  la    public.pickle_ledger;
  l     public.pickle_ledger;
begin
  if pg_temp.pickles('AD') < 300 then
    update public.profiles set pickles = pickles + 1000 where id = pg_temp.p('AD');
  end if;
  mark := pg_temp.mark();
  perform pg_temp.as_user(pg_temp.p('AD'));
  select * into g from public.godmode_gift_pickles(pg_temp.p('PG'), 300, 'ledger test');
  perform pg_temp.as_admin();
  select * into lg from pg_temp.since('PG', mark, 'godmode_gift_pickles');
  select * into la from pg_temp.since('AD', mark, 'godmode_gift_pickles');
  perform pg_temp.ok('L8 a God mode gift is gold for the recipient: "Gift from <sender>"',
    g.success and lg.delta = 300 and lg.reason = 'Gift from ' || pg_temp.first_name(pg_temp.p('AD'), 'God mode')
    and lg.is_bonus and lg.kind = 'bonus' and lg.category = 'gift' and lg.counterpart_id = pg_temp.p('AD'),
    format('%s / %s; %s', g.success, g.message, pg_temp.row_text(lg)));
  perform pg_temp.ok('L8 ...and a spend for the sender: "Gift to Gale"',
    la.delta = -300 and la.reason = 'Gift to Gale' and la.kind = 'spend' and not la.is_bonus
    and la.counterpart_id = pg_temp.p('PG') and la.balance_after = pg_temp.pickles('AD'),
    pg_temp.row_text(la));

  perform pg_temp.as_user(pg_temp.p('PD'));
  select * into w from public.claim_welcome_pickles();
  perform pg_temp.as_admin();
  l := pg_temp.last_of('PD');
  perform pg_temp.ok('L9 the welcome pickles are gold ("Welcome pickles")',
    w.granted and l.delta = 1000 and l.reason = 'Welcome pickles' and l.is_bonus and l.kind = 'bonus'
    and l.category = 'welcome' and l.source = 'claim_welcome_pickles',
    pg_temp.row_text(l));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('L8 / L9 block crashed', false, sqlerrm);
end $$;


-- ════ L10 changes from outside, caller labels, a broken ledger ═══════════
do $$
declare
  l  public.pickle_ledger;
  b  integer;
  n  bigint;
begin
  update public.profiles set pickles = pickles + 5 where id = pg_temp.p('PX');
  l := pg_temp.last_of('PX');
  perform pg_temp.ok('L10 a change from no function (a script, the SQL editor) is "Pickles adjusted"',
    l.delta = 5 and l.reason = 'Pickles adjusted' and l.kind = 'adjust' and l.category = 'other'
    and l.source is null and not l.is_bonus and not (l.meta ? 'via') and l.balance_after = pg_temp.pickles('PX'),
    pg_temp.row_text(l));

  perform set_config('pl.pickle_reason', 'Season bonus (test)', true);
  perform set_config('pl.pickle_bonus', 'true', true);
  perform set_config('pl.pickle_meta', '{"note": "test"}', true);
  update public.profiles set pickles = pickles + 7 where id = pg_temp.p('PX');
  perform set_config('pl.pickle_reason', '', true);
  perform set_config('pl.pickle_bonus', '', true);
  perform set_config('pl.pickle_meta', '', true);
  l := pg_temp.last_of('PX');
  perform pg_temp.ok('L10 a caller can word its own change (pl.pickle_reason / _bonus / _meta)',
    l.delta = 7 and l.reason = 'Season bonus (test)' and l.is_bonus and l.kind = 'bonus' and l.meta ->> 'note' = 'test',
    pg_temp.row_text(l));
  update public.profiles set pickles = pickles + 3 where id = pg_temp.p('PX');
  l := pg_temp.last_of('PX');
  perform pg_temp.ok('L10 ...and once cleared ('''') the next change is plain again',
    l.delta = 3 and l.reason = 'Pickles adjusted' and not l.is_bonus and not (l.meta ? 'note'),
    pg_temp.row_text(l));

  perform set_config('pl.pickle_bonus', 'maybe', true);
  update public.profiles set pickles = pickles + 2 where id = pg_temp.p('PX');
  perform set_config('pl.pickle_bonus', '', true);
  l := pg_temp.last_of('PX');
  perform pg_temp.ok('L10 a malformed setting still writes the row, plain, with meta.detail_error',
    l.delta = 2 and l.reason = 'Pickles adjusted' and not l.is_bonus and l.meta ->> 'detail_error' = '22P02',
    pg_temp.row_text(l));

  -- The ledger refusing the row (a check it can't pass) must not refuse the change.
  alter table public.pickle_ledger add constraint pickle_ledger_test_fail check (delta <> 7777);
  b := pg_temp.pickles('PX');
  n := pg_temp.n_of('PX');
  update public.profiles set pickles = pickles + 7777 where id = pg_temp.p('PX');
  perform pg_temp.ok('L10 a ledger failure never blocks the pickles change: the balance moves, no row',
    pg_temp.pickles('PX') = b + 7777 and pg_temp.n_of('PX') = n,
    format('pickles %s -> %s, rows %s -> %s', b, pg_temp.pickles('PX'), n, pg_temp.n_of('PX')));
  alter table public.pickle_ledger drop constraint pickle_ledger_test_fail;
  update public.profiles set pickles = pickles + 1 where id = pg_temp.p('PX');
  l := pg_temp.last_of('PX');
  perform pg_temp.ok('L10 ...the next change is recorded again',
    l.delta = 1 and l.balance_after = pg_temp.pickles('PX') and pg_temp.chain_ends_at_balance('PX'),
    pg_temp.row_text(l));
  perform pg_temp.ok('L10 ...and the lost row shows as one break of 7777 in the balance_after chain',
    pg_temp.chain_breaks('PX') = array[7777], pg_temp.chain_breaks('PX')::text);

  n := pg_temp.n_of('PA');
  update public.profiles set tagline = 'Ledger test' where id = pg_temp.p('PA');
  perform pg_temp.ok('L10 updating another column writes no row', pg_temp.n_of('PA') = n, null);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('L10 block crashed', false, sqlerrm);
end $$;


-- ════ L11 a profile made with pickles (the insert trigger) ═══════════════
do $$
declare
  l public.pickle_ledger;
begin
  insert into public.profiles (id, username, full_name, gender, pickles)
  values (pg_temp.p('PI'), 'pl_ledger_pi_test', 'Ivy Ledger', 'female', 300);
  l := pg_temp.last_of('PI');
  perform pg_temp.ok('L11 a profile made with 300 pickles starts its history with a starting row',
    pg_temp.n_of('PI') = 1 and l.delta = 300 and l.balance_after = 300 and l.reason = 'Starting balance'
    and l.kind = 'start' and not l.is_bonus and (l.meta ->> 'starting_balance')::boolean,
    pg_temp.row_text(l));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('L11 block crashed', false, sqlerrm);
end $$;


-- ════ L12 who may read and write the table ═══════════════════════════════
do $$
declare
  j jsonb;
  e jsonb;
  n bigint;
begin
  j := pg_temp.q('PB', format('select count(*) as n from public.pickle_ledger where profile_id = %L', pg_temp.p('PA')));
  perform pg_temp.ok('L12 a player can''t read another player''s rows', (j -> 0 ->> 'n')::int = 0, j::text);
  j := pg_temp.q('PB', 'select count(*) as n from public.pickle_ledger');
  perform pg_temp.ok('L12 ...and sees exactly their own', (j -> 0 ->> 'n')::bigint = pg_temp.n_of('PB'),
    format('%s, own %s', j, pg_temp.n_of('PB')));

  e := pg_temp.err_as('PA', format('insert into public.pickle_ledger (profile_id, delta, balance_after, reason) values (%L, 1000, 1000, %L)',
                                    pg_temp.p('PA'), 'Free pickles'));
  perform pg_temp.ok('L12 a player can''t write a row (insert refused)', e ->> 'state' = '42501', coalesce(e::text, 'no error'));
  e := pg_temp.err_as('PA', 'update public.pickle_ledger set delta = 100000');
  perform pg_temp.ok('L12 ...or change one', e ->> 'state' = '42501', coalesce(e::text, 'no error'));
  e := pg_temp.err_as('PA', 'delete from public.pickle_ledger');
  perform pg_temp.ok('L12 ...or delete one', e ->> 'state' = '42501', coalesce(e::text, 'no error'));
  e := pg_temp.err_anon('select count(*) from public.pickle_ledger');
  perform pg_temp.ok('L12 anon can''t read it', e ->> 'state' = '42501', coalesce(e::text, 'no error'));
  e := pg_temp.err_as('PA', 'select count(*) from public.pickle_ledger_sources');
  perform pg_temp.ok('L12 nor can a player read the source map', e ->> 'state' = '42501', coalesce(e::text, 'no error'));

  n := pg_temp.n_of('PA');
  e := pg_temp.err_as('PA', format('update public.profiles set pickles = 999999 where id = %L', pg_temp.p('PA')));
  perform pg_temp.ok('L12 a player can''t fake a change through profiles either (pl:profile.server_owned, no row)',
    e ->> 'hint' = 'pl:profile.server_owned' and pg_temp.n_of('PA') = n, coalesce(e::text, 'no error'));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('L12 block crashed', false, sqlerrm);
end $$;


-- ════ L13 the feed: list_pickle_ledger ═══════════════════════════════════
do $$
declare
  v_all  bigint[];
  v_seen bigint[] := '{}';
  j      jsonb;
  e      jsonb;
  v_last jsonb;
  i      integer := 0;
  v_tot  integer;
begin
  -- One row a month back, for "older than" and the calendar.
  update public.pickle_ledger set created_at = now() - interval '40 days'
   where profile_id = pg_temp.p('PA') and kind = 'start';
  select array_agg(id order by created_at desc, id desc) into v_all
    from public.pickle_ledger where profile_id = pg_temp.p('PA');
  v_tot := cardinality(v_all);

  j := pg_temp.q('PA', 'select * from public.list_pickle_ledger(3)');
  perform pg_temp.ok('L13 the feed is newest first (created_at, then id), 3 to a page',
    jsonb_array_length(j) = 3 and pg_temp.ids(j) = v_all[1:3],
    format('%s vs %s', pg_temp.ids(j), v_all[1:3]));
  perform pg_temp.ok('L13 a row is {id, delta, balance_after, reason, kind, category, is_bonus, created_at, local_day, meta}',
    (select array_agg(k order by k) from jsonb_object_keys(j -> 0) k)
      = array['balance_after', 'category', 'created_at', 'delta', 'id', 'is_bonus', 'kind', 'local_day', 'meta', 'reason'],
    (select string_agg(k, ',') from jsonb_object_keys(j -> 0) k));

  -- Walk every page with (created_at, id).
  loop
    v_seen := v_seen || pg_temp.ids(j);
    v_last := j -> (jsonb_array_length(j) - 1);
    i := i + 1;
    exit when i > 60;
    j := pg_temp.q('PA', format('select * from public.list_pickle_ledger(3, %L::timestamptz, %s)',
                                 v_last ->> 'created_at', v_last ->> 'id'));
    exit when j is null or jsonb_array_length(j) = 0;
  end loop;
  perform pg_temp.ok('L13 paging with p_before + p_before_id walks every row once, in order (rows share a created_at)',
    v_seen = v_all and v_tot >= 7,
    format('%s rows, %s pages: %s', v_tot, i, v_seen));

  j := pg_temp.q('PA', format('select * from public.list_pickle_ledger(20, %L::timestamptz)', now() - interval '1 day'));
  perform pg_temp.ok('L13 p_before alone means strictly older: the month-old starting row',
    jsonb_array_length(j) = 1 and j -> 0 ->> 'kind' = 'start' and (j -> 0 -> 'meta' ->> 'starting_balance')::boolean,
    j::text);

  j := pg_temp.q('PA', 'select * from public.list_pickle_ledger(0)');
  perform pg_temp.ok('L13 p_limit 0 is 1', jsonb_array_length(j) = 1, jsonb_array_length(j)::text);
  j := pg_temp.q('PA', 'select * from public.list_pickle_ledger(null)');
  perform pg_temp.ok('L13 p_limit null is 20', jsonb_array_length(j) = least(20, v_tot), jsonb_array_length(j)::text);
  j := pg_temp.q('PA', 'select * from public.list_pickle_ledger(1000)');
  perform pg_temp.ok('L13 p_limit is at most 100', jsonb_array_length(j) = least(100, v_tot), jsonb_array_length(j)::text);
  perform pg_temp.ok('L13 local_day is the day in the player''s zone (Pacific/Kiritimati)',
    not exists (select 1 from jsonb_array_elements(j) x
                 where (x ->> 'local_day')::date <> ((x ->> 'created_at')::timestamptz at time zone 'Pacific/Kiritimati')::date),
    (select string_agg(distinct x ->> 'local_day', ',') from jsonb_array_elements(j) x));

  j := pg_temp.q('PB', 'select * from public.list_pickle_ledger(100)');
  perform pg_temp.ok('L13 another player''s feed holds only their own rows',
    jsonb_array_length(j) = pg_temp.n_of('PB')
    and not (pg_temp.ids(j) && v_all),
    pg_temp.ids(j)::text);

  e := pg_temp.err_out('select * from public.list_pickle_ledger()');
  perform pg_temp.ok('L13 signed out: pl:auth.signed_out', e ->> 'hint' = 'pl:auth.signed_out', coalesce(e::text, 'no error'));
  e := pg_temp.err_anon('select * from public.list_pickle_ledger()');
  perform pg_temp.ok('L13 anon can''t call it', e ->> 'state' = '42501', coalesce(e::text, 'no error'));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('L13 block crashed', false, sqlerrm);
end $$;


-- ════ L14 the calendar: list_pickle_ledger_range ═════════════════════════
do $$
declare
  v_all bigint[];
  j     jsonb;
  e     jsonb;
begin
  select array_agg(id order by created_at desc, id desc) into v_all
    from public.pickle_ledger where profile_id = pg_temp.p('PA') and kind <> 'start';

  j := pg_temp.q('PA', format('select * from public.list_pickle_ledger_range(%L, %L)',
                               now() - interval '45 days', now() - interval '35 days'));
  perform pg_temp.ok('L14 a range holds the rows in it: the month-old starting row',
    jsonb_array_length(j) = 1 and j -> 0 ->> 'kind' = 'start', j::text);
  j := pg_temp.q('PA', format('select * from public.list_pickle_ledger_range(%L, %L)',
                               now() - interval '1 day', now() + interval '1 minute'));
  perform pg_temp.ok('L14 ...and today''s range every other row, newest first',
    pg_temp.ids(j) = v_all, format('%s vs %s', pg_temp.ids(j), v_all));
  j := pg_temp.q('PA', format('select * from public.list_pickle_ledger_range(%L, %L)', now(), now() + interval '1 minute'));
  perform pg_temp.ok('L14 the range is half-open: p_from is in', jsonb_array_length(j) = cardinality(v_all),
    jsonb_array_length(j)::text);
  j := pg_temp.q('PA', format('select * from public.list_pickle_ledger_range(%L, %L)', now() - interval '1 day', now()));
  perform pg_temp.ok('L14 ...p_to is out', jsonb_array_length(j) = 0, jsonb_array_length(j)::text);
  j := pg_temp.q('PA', format('select * from public.list_pickle_ledger_range(%L, %L)',
                               now() - interval '61 days', now() + interval '1 day'));
  perform pg_temp.ok('L14 62 days at once is allowed', jsonb_array_length(j) = cardinality(v_all) + 1,
    jsonb_array_length(j)::text);

  e := pg_temp.err_as('PA', format('select * from public.list_pickle_ledger_range(%L, %L)',
                                    now() - interval '62 days', now() + interval '1 second'));
  perform pg_temp.ok('L14 more than 62 days: pl:request.bad, saying so',
    e ->> 'hint' = 'pl:request.bad' and e ->> 'msg' like '%62 days%', coalesce(e::text, 'no error'));
  e := pg_temp.err_as('PA', format('select * from public.list_pickle_ledger_range(%L, %L)', now(), now()));
  perform pg_temp.ok('L14 an empty or inverted range: pl:request.bad', e ->> 'hint' = 'pl:request.bad', coalesce(e::text, 'no error'));
  e := pg_temp.err_as('PA', 'select * from public.list_pickle_ledger_range(null, now())');
  perform pg_temp.ok('L14 a missing end: pl:request.bad', e ->> 'hint' = 'pl:request.bad', coalesce(e::text, 'no error'));
  e := pg_temp.err_out(format('select * from public.list_pickle_ledger_range(%L, %L)', now() - interval '1 day', now()));
  perform pg_temp.ok('L14 signed out: pl:auth.signed_out', e ->> 'hint' = 'pl:auth.signed_out', coalesce(e::text, 'no error'));
  e := pg_temp.err_anon(format('select * from public.list_pickle_ledger_range(%L, %L)', now() - interval '1 day', now()));
  perform pg_temp.ok('L14 anon can''t call it', e ->> 'state' = '42501', coalesce(e::text, 'no error'));
  j := pg_temp.q('PB', format('select * from public.list_pickle_ledger_range(%L, %L)',
                               now() - interval '61 days', now() + interval '1 day'));
  perform pg_temp.ok('L14 another player''s range holds only their own rows',
    jsonb_array_length(j) = pg_temp.n_of('PB') and not (pg_temp.ids(j) && v_all), pg_temp.ids(j)::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('L14 block crashed', false, sqlerrm);
end $$;


-- ════ L15 today: my_pickle_today ═════════════════════════════════════════
do $$
declare
  t      jsonb;
  v_tz   text := 'Pacific/Kiritimati';
  v_day  date := (now() at time zone 'Pacific/Kiritimati')::date;
  v_from timestamptz;
  v_to   timestamptz;
  x      record;
  e      jsonb;
begin
  v_from := v_day::timestamp at time zone v_tz;
  v_to   := (v_day + 1)::timestamp at time zone v_tz;
  select coalesce(sum(delta) filter (where kind = 'earn'), 0) as earn,
         coalesce(sum(delta) filter (where kind = 'bonus'), 0) as bonus,
         coalesce(-sum(delta) filter (where kind = 'spend'), 0) as spent,
         coalesce(sum(delta) filter (where kind <> 'start'), 0) as net
    into x
    from public.pickle_ledger
   where profile_id = pg_temp.p('PA') and created_at >= v_from and created_at < v_to;

  t := pg_temp.q('PA', 'select public.my_pickle_today() as t') -> 0 -> 't';
  perform pg_temp.ok('L15 my_pickle_today: Avery''s zone and day, the play streak (day 2: +100 today, 150 next, cap 200)',
    t ->> 'tz' = v_tz and (t ->> 'day')::date = v_day and (t ->> 'cap')::int = 200
    and (t ->> 'played_today')::boolean and (t ->> 'streak_days')::int = 2 and (t ->> 'streak_today')::int = 100
    and (t ->> 'next_streak')::int = 150,
    coalesce(t::text, 'null'));
  perform pg_temp.ok('L15 ...and today''s totals by kind (spent positive, the starting row out)',
    (t ->> 'earned_today')::int = x.earn and (t ->> 'bonus_today')::int = x.bonus
    and (t ->> 'spent_today')::int = x.spent and (t ->> 'net_today')::int = x.net
    and x.earn > 0 and x.bonus > 0 and x.spent > 0,
    format('%s vs earn %s bonus %s spent %s net %s', t, x.earn, x.bonus, x.spent, x.net));

  t := pg_temp.q('PB', 'select public.my_pickle_today() as t') -> 0 -> 't';
  perform pg_temp.ok('L15 Blake (default zone): day 1 today, 100 next',
    t ->> 'tz' = public._pickleague_default_tz() and (t ->> 'played_today')::boolean
    and (t ->> 'streak_days')::int = 1 and (t ->> 'streak_today')::int = 50 and (t ->> 'next_streak')::int = 100,
    coalesce(t::text, 'null'));
  t := pg_temp.q('PW', 'select public.my_pickle_today() as t') -> 0 -> 't';
  perform pg_temp.ok('L15 Wren (no play): no streak, 50 next; spent 150, the refund not counted as earned',
    not (t ->> 'played_today')::boolean and (t ->> 'streak_days')::int = 0 and (t ->> 'streak_today')::int = 0
    and (t ->> 'next_streak')::int = 50 and (t ->> 'spent_today')::int = 150
    and (t ->> 'earned_today')::int = (select potential_payout from public.wagers
                                        where user_id = pg_temp.p('PW') and status = 'won'),
    coalesce(t::text, 'null'));

  e := pg_temp.err_out('select public.my_pickle_today()');
  perform pg_temp.ok('L15 signed out: pl:auth.signed_out', e ->> 'hint' = 'pl:auth.signed_out', coalesce(e::text, 'no error'));
  e := pg_temp.err_anon('select public.my_pickle_today()');
  perform pg_temp.ok('L15 anon can''t call it', e ->> 'state' = '42501', coalesce(e::text, 'no error'));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('L15 block crashed', false, sqlerrm);
end $$;


-- ════ L16 every persona's history adds up ════════════════════════════════
do $$
declare
  k text;
  v_bad text[] := '{}';
begin
  foreach k in array array['PA', 'PB', 'PW', 'PR', 'PN', 'PG', 'PD', 'PI', 'AD'] loop
    if pg_temp.chain_breaks(k) <> '{}' or not pg_temp.chain_ends_at_balance(k) then
      v_bad := v_bad || (k || ' breaks ' || pg_temp.chain_breaks(k)::text || ' ends at balance '
                         || pg_temp.chain_ends_at_balance(k)::text);
    end if;
  end loop;
  perform pg_temp.ok('L16 for every persona each balance_after = the one before + delta, ending at the balance on profiles',
    cardinality(v_bad) = 0, coalesce(nullif(array_to_string(v_bad, '; '), ''), 'all consistent'));
exception when others then
  perform pg_temp.ok('L16 block crashed', false, sqlerrm);
end $$;


-- ════ L17 deleting an account ════════════════════════════════════════════
do $$
declare
  v_gift bigint;
  v_item text;
begin
  select id into v_gift from public.pickle_ledger where profile_id = pg_temp.p('PA') and source = 'gift_shop_item';
  select name into v_item from public.shop_items where id = pg_temp.i('item2');
  perform pg_temp.ok('L17 (before) Dana has history, and Avery''s gift row names her',
    pg_temp.n_of('PD') = 2 and (select counterpart_id from public.pickle_ledger where id = v_gift) = pg_temp.p('PD'),
    pg_temp.n_of('PD')::text);

  perform public._purge_account(pg_temp.p('PD'));
  perform pg_temp.ok('L17 deleting an account deletes its pickle history', pg_temp.n_of('PD') = 0,
    pg_temp.n_of('PD')::text);
  perform pg_temp.ok('L17 ...and Avery''s row that named Dana keeps the item, not the person',
    (select reason from public.pickle_ledger where id = v_gift) = 'Gift: ' || v_item
    and (select counterpart_id from public.pickle_ledger where id = v_gift) is null,
    (select pg_temp.row_text(l) from public.pickle_ledger l where l.id = v_gift));
  update public.profiles set pickles = pickles + 5 where id = pg_temp.p('PD');
  perform pg_temp.ok('L17 a tombstoned account gets no new rows', pg_temp.n_of('PD') = 0, pg_temp.n_of('PD')::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('L17 block crashed', false, sqlerrm);
end $$;


-- ════ L18 grants after the hardening re-run ══════════════════════════════
do $$
declare
  f     text;
  v_bad text[] := '{}';
begin
  foreach f in array array['public.list_pickle_ledger(integer,timestamptz,bigint)',
                           'public.list_pickle_ledger_range(timestamptz,timestamptz)', 'public.my_pickle_today()'] loop
    if not has_function_privilege('authenticated', f, 'execute') or has_function_privilege('anon', f, 'execute') then
      v_bad := v_bad || f;
    end if;
  end loop;
  perform pg_temp.ok('L18 after the hardening re-run the three RPCs are callable by players, not anon',
    cardinality(v_bad) = 0, array_to_string(v_bad, ', '));
  v_bad := '{}';
  foreach f in array array['public._pl_pickle_ledger_capture()', 'public._pl_pickle_ledger_item()',
                           'public._pl_pickle_ledger_purge()'] loop
    if has_function_privilege('authenticated', f, 'execute') or has_function_privilege('anon', f, 'execute') then
      v_bad := v_bad || f;
    end if;
  end loop;
  perform pg_temp.ok('L18 the trigger functions are not callable by clients', cardinality(v_bad) = 0,
    array_to_string(v_bad, ', '));
exception when others then
  perform pg_temp.ok('L18 block crashed', false, sqlerrm);
end $$;


-- ════ L19 what a change costs (INFO) ═════════════════════════════════════
do $$
declare
  t0 timestamptz;
  t1 timestamptz;
  t2 timestamptz;
  n0 bigint := pg_temp.n_of('PX');
  i  integer;
begin
  t0 := clock_timestamp();
  for i in 1 .. 200 loop
    update public.profiles set pickles = pickles + 1 where id = pg_temp.p('PX');
  end loop;
  t1 := clock_timestamp();
  for i in 1 .. 200 loop
    update public.profiles set tagline = 'Ledger cost ' || i where id = pg_temp.p('PX');
  end loop;
  t2 := clock_timestamp();
  perform pg_temp.ok('L19 200 pickles changes write 200 rows', pg_temp.n_of('PX') = n0 + 200,
    (pg_temp.n_of('PX') - n0)::text);
  perform pg_temp.ok('INFO cost of a pickles change with its ledger row vs another column''s update', true,
    format('%s ms vs %s ms per update (%s ms for the ledger)',
           round((extract(epoch from t1 - t0) * 1000 / 200)::numeric, 3),
           round((extract(epoch from t2 - t1) * 1000 / 200)::numeric, 3),
           round((extract(epoch from (t1 - t0) - (t2 - t1)) * 1000 / 200)::numeric, 3)));
exception when others then
  perform pg_temp.ok('L19 block crashed', false, sqlerrm);
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
