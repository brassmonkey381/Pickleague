-- ============================================================
-- My Place persona tests (migration_my_place.sql).
--
-- NOT runnable on its own: build-my-place-test.mjs puts
-- migration_my_place.sql, twice (it must be re-runnable), at the marker line
-- below. Everything runs inside the begin / rollback below, so the linked
-- (live) database is left untouched:
--   node supabase/tests/build-my-place-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary.
--
-- Needs migration_pickle_ledger.sql live (M3 reads the ledger row). Test
-- catalog items (ids mpt_*) are made inside the transaction, so the live
-- catalog only matters for the starter set, which M2 reads as it is.
--
-- Personas (temporary accounts created inside the transaction; the signup
-- trigger makes each profile):
--   MA the owner: 10,000 pickles; claims the starter set, buys, equips, clears
--   MB MA's friend: visits
--   MC a stranger: signed in, not a friend
--   MD MA's friend whom MA blocked
--   ME MA's friend who blocked MA
--   MP 100 pickles: can't afford things
--   MG a guest pass
--   MX MB's friend who deletes their account
--   GM the real God mode account (is_godmode_user): saves the layout
-- ============================================================

begin;

-- pg_temp helpers are called as authenticated / anon; since
-- migration_anon_audit_rest.sql postgres-created functions aren't
-- PUBLIC-executable by default (rolled back below).
alter default privileges for role postgres grant execute on functions to public;

-- ════ Harness ════════════════════════════════════════════════════════════
create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);
grant select, insert on _results to authenticated, anon, service_role;
grant usage on sequence _results_n_seq to authenticated, anon, service_role;

create temp table _p (k text primary key, id uuid not null);
insert into _p values
  ('MA', 'a8300000-0000-4000-8000-000000000001'), ('MB', 'a8300000-0000-4000-8000-000000000002'),
  ('MC', 'a8300000-0000-4000-8000-000000000003'), ('MD', 'a8300000-0000-4000-8000-000000000004'),
  ('ME', 'a8300000-0000-4000-8000-000000000005'), ('MP', 'a8300000-0000-4000-8000-000000000006'),
  ('MG', 'a8300000-0000-4000-8000-000000000007'), ('MX', 'a8300000-0000-4000-8000-000000000008'),
  ('GM', '252a36e1-5d89-4ad2-8a3e-b786579f019a');
grant select on _p to authenticated, anon, service_role;

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

-- Signed in as a role but no user (an expired session's claims).
create function pg_temp.as_nouser() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role": "authenticated"}', true);
  perform set_config('role', 'authenticated', true);
end $$;

create function pg_temp.as_admin() returns void language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

-- Runs p_sql (a statement) as the current role; {rows} when it went through,
-- else {state, msg, hint, detail}.
create function pg_temp.run(p_sql text) returns jsonb language plpgsql as $$
declare
  v_n      bigint;
  v_state  text;
  v_msg    text;
  v_hint   text;
  v_detail text;
begin
  execute p_sql;
  get diagnostics v_n = row_count;
  return jsonb_build_object('rows', v_n);
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint,
                          v_detail = pg_exception_detail;
  return jsonb_build_object('state', v_state, 'msg', v_msg, 'hint', v_hint, 'detail', v_detail);
end $$;

-- Runs p_sql (a select of one jsonb value) as the current role; {v} when it
-- went through, else {state, msg, hint, detail}.
create function pg_temp.eval(p_sql text) returns jsonb language plpgsql as $$
declare
  v        jsonb;
  v_state  text;
  v_msg    text;
  v_hint   text;
  v_detail text;
begin
  execute p_sql into v;
  return jsonb_build_object('v', v);
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint,
                          v_detail = pg_exception_detail;
  return jsonb_build_object('state', v_state, 'msg', v_msg, 'hint', v_hint, 'detail', v_detail);
end $$;

create function pg_temp.run_as(k text, p_sql text) returns jsonb language plpgsql as $$
declare j jsonb;
begin
  perform pg_temp.as_user(pg_temp.p(k));
  j := pg_temp.run(p_sql);
  perform pg_temp.as_admin();
  return j;
end $$;
create function pg_temp.eval_as(k text, p_sql text) returns jsonb language plpgsql as $$
declare j jsonb;
begin
  perform pg_temp.as_user(pg_temp.p(k));
  j := pg_temp.eval(p_sql);
  perform pg_temp.as_admin();
  return j;
end $$;
create function pg_temp.eval_anon(p_sql text) returns jsonb language plpgsql as $$
declare j jsonb;
begin
  perform pg_temp.as_anon();
  j := pg_temp.eval(p_sql);
  perform pg_temp.as_admin();
  return j;
end $$;
create function pg_temp.eval_nouser(p_sql text) returns jsonb language plpgsql as $$
declare j jsonb;
begin
  perform pg_temp.as_nouser();
  j := pg_temp.eval(p_sql);
  perform pg_temp.as_admin();
  return j;
end $$;

-- The RPCs as persona k.
create function pg_temp.buy(k text, item text) returns jsonb language sql as $$
  select pg_temp.eval_as(k, format('select public.buy_home_item(%L)', item)) $$;
create function pg_temp.equip(k text, slot text, item text) returns jsonb language sql as $$
  select pg_temp.eval_as(k, format('select public.equip_home_item(%L, %L)', slot, item)) $$;
create function pg_temp.clear(k text, slot text) returns jsonb language sql as $$
  select pg_temp.eval_as(k, format('select public.clear_home_slot(%L)', slot)) $$;
create function pg_temp.home(k text, owner text) returns jsonb language sql as $$
  select pg_temp.eval_as(k, format('select public.get_home(%L::uuid)', pg_temp.p(owner))) $$;
create function pg_temp.vis(k text, v text) returns jsonb language sql as $$
  select pg_temp.eval_as(k, format('select public.set_my_place_visibility(%L)', v)) $$;
create function pg_temp.save(k text, layout jsonb) returns jsonb language sql as $$
  select pg_temp.eval_as(k, format('select public.save_room_layout(%L::jsonb)', layout)) $$;

-- A refusal with this code (P0001, HINT pl:<code>, a message for people).
create function pg_temp.refused(j jsonb, code text) returns boolean language sql immutable as $$
  select j ->> 'state' = 'P0001' and j ->> 'hint' = 'pl:' || code and coalesce(j ->> 'msg', '') <> '' $$;

create function pg_temp.pickles(k text) returns integer language sql stable as $$
  select coalesce(pickles, 0) from public.profiles where id = pg_temp.p(k) $$;

-- @@MIGRATION@@


-- Read as admin (after the migration: SQL functions check their tables when created).
create function pg_temp.eq(k text) returns jsonb language sql stable as $$
  select coalesce(jsonb_object_agg(slot_id, item_id), '{}'::jsonb) from public.home_equipped where owner_id = pg_temp.p(k) $$;
create function pg_temp.owns(k text, item text) returns boolean language sql stable as $$
  select exists (select 1 from public.home_owned_items where owner_id = pg_temp.p(k) and item_id = item) $$;
create function pg_temp.layout() returns jsonb language sql stable as $$
  select layout from public.room_layout where id = 'default' $$;


-- ════ Setup (after the migration, so every trigger is live) ══════════════
do $$
begin
  perform pg_temp.as_admin();
  insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
  select id, 'myplace-' || lower(k) || '@pickleague.test', jsonb_build_object('full_name', 'Place ' || k || ' Player'), now()
    from _p where k <> 'GM';
  update public.profiles set pickles = 10000 where id = pg_temp.p('MA');
  update public.profiles set pickles = 100 where id = pg_temp.p('MP');
  update public.profiles set is_guest = true where id = pg_temp.p('MG');

  insert into public.friendships (requester_id, addressee_id, status, responded_at) values
    (pg_temp.p('MA'), pg_temp.p('MB'), 'accepted', now()),
    (pg_temp.p('MA'), pg_temp.p('MD'), 'accepted', now()),
    (pg_temp.p('ME'), pg_temp.p('MA'), 'accepted', now()),
    (pg_temp.p('MX'), pg_temp.p('MB'), 'accepted', now());
  -- A block (a teardown trigger may end the friendship; the block alone must hide the room).
  insert into public.user_blocks (blocker_id, blocked_id) values
    (pg_temp.p('MA'), pg_temp.p('MD')), (pg_temp.p('ME'), pg_temp.p('MA'));

  insert into public.home_items (id, name, slot_group, cost, rarity, season, available_from, available_until, sort) values
    ('mpt_floor',   'Mpt Floor',   'floor',      500,   'common', null,      null,                       null,                      9001),
    ('mpt_shelf',   'Mpt Shelf',   'shelf',      300,   'common', null,      null,                       null,                      9002),
    ('mpt_trophy',  'Mpt Trophy',  'shelf_item', 200,   'rare',   null,      null,                       null,                      9003),
    ('mpt_plant',   'Mpt Plant',   'accent',     0,     'common', null,      null,                       null,                      9004),
    ('mpt_soon',    'Mpt Soon',    'couch',      100,   'common', '2099-01', now() + interval '1 day',   null,                      9005),
    ('mpt_ended',   'Mpt Ended',   'couch',      100,   'common', '2020-01', now() - interval '10 days', now() - interval '1 day',  9006),
    ('mpt_window',  'Mpt Window',  'window',     1000,  'legendary', '2026-10', now() - interval '1 day', now() + interval '1 day', 9007),
    ('mpt_rug',     'Mpt Rug',     'rug',        50000, 'common', null,      null,                       null,                      9008);
  insert into public.home_item_art (item_id, art_svg) values ('mpt_window', '<svg viewBox="0 0 100 100"></svg>');
end $$;


-- ════ M1 installed the way the house rules want ══════════════════════════
do $$
declare
  f   text;
  t   text;
begin
  foreach f in array array['public.get_home(uuid)', 'public.buy_home_item(text)', 'public.equip_home_item(text,text)',
                           'public.clear_home_slot(text)', 'public.set_my_place_visibility(text)',
                           'public.claim_my_place_starter()', 'public.save_room_layout(jsonb)'] loop
    perform pg_temp.ok(format('M1 %s is SECURITY DEFINER with search_path pinned to ''''', f),
      (select p.prosecdef and p.proconfig @> array['search_path=""'] from pg_proc p where p.oid = f::regprocedure), null);
    perform pg_temp.ok(format('M1 %s: signed-in players may call it, anon may not', f),
      has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute'), null);
  end loop;
  foreach f in array array['public._pl_room_layout_problem(jsonb)', 'public._pl_home_equipped(uuid)',
                           'public._pl_my_place_purge()'] loop
    perform pg_temp.ok(format('M1 internal %s: no client may call it', f),
      not has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute'), null);
  end loop;

  foreach t in array array['room_layout', 'home_slots', 'home_items', 'home_item_art', 'home_owned_items',
                           'home_equipped', 'home_settings', 'home_starter_claims'] loop
    perform pg_temp.ok(format('M1 %s: RLS on', t),
      (select c.relrowsecurity from pg_class c where c.oid = ('public.' || t)::regclass), null);
    perform pg_temp.ok(format('M1 %s: clients may only read (no insert, update, delete), anon not even that', t),
      has_table_privilege('authenticated', 'public.' || t, 'select')
      and not has_table_privilege('authenticated', 'public.' || t, 'insert')
      and not has_table_privilege('authenticated', 'public.' || t, 'update')
      and not has_table_privilege('authenticated', 'public.' || t, 'delete')
      and not has_table_privilege('anon', 'public.' || t, 'select')
      and not has_table_privilege('anon', 'public.' || t, 'insert'), null);
    perform pg_temp.ok(format('M1 %s: every policy is a SELECT policy', t),
      not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and cmd <> 'SELECT')
      and exists (select 1 from pg_policies where schemaname = 'public' and tablename = t), null);
  end loop;

  perform pg_temp.ok('M1 the layout row exists and is a version 1 layout',
    (pg_temp.layout() ->> 'version')::numeric = 1 and jsonb_typeof(pg_temp.layout() -> 'placements') = 'object',
    pg_temp.layout()::text);
  perform pg_temp.ok('M1 the slot structure is seeded (14 slots, wallpaper and floor are backdrops, props name their parents)',
    (select count(*) from public.home_slots) >= 14
    and (select kind from public.home_slots where id = 'wallpaper') = 'backdrop'
    and (select kind from public.home_slots where id = 'floor') = 'backdrop'
    and (select parent_id from public.home_slots where id = 'shelf_item') = 'shelf'
    and (select fits from public.home_slots where id = 'accent2') = 'accent', null);
  perform pg_temp.ok('M1 the placeholder catalog is seeded, art left to the kit''s placeholder',
    (select count(*) from public.home_items where id like 'ph\_%') >= 10
    and not exists (select 1 from public.home_item_art where item_id like 'ph\_%'), null);
  perform pg_temp.ok('M1 the ledger knows buy_home_item',
    exists (select 1 from public.pickle_ledger_sources where source = 'buy_home_item' and sign = -1 and kind = 'spend'), null);
  perform pg_temp.ok('M1 the purge trigger is on profiles',
    exists (select 1 from pg_trigger where tgrelid = 'public.profiles'::regclass and tgname = 'trg_profiles_my_place_purge'), null);
  perform pg_temp.ok('M1 setup made the eight test items', (select count(*) from public.home_items where id like 'mpt\_%') = 8, null);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('M1 block crashed', false, sqlerrm);
end $$;


-- ════ M2 the starter set, once per account ═══════════════════════════════
do $$
declare
  j       jsonb;
  j2      jsonb;
  v_items text[] := array(select id from public.home_items where is_starter order by sort, id);
  v_owned bigint;
begin
  j := pg_temp.eval_as('MA', 'select public.claim_my_place_starter()');
  perform pg_temp.ok('M2 the first claim gives every starter item',
    (j -> 'v' ->> 'claimed')::boolean and j -> 'v' -> 'items' = to_jsonb(v_items)
    and (select bool_and(pg_temp.owns('MA', x)) from unnest(v_items) x) is not false, j::text);
  perform pg_temp.ok('M2 ...free, marked as starter, no pickles taken',
    pg_temp.pickles('MA') = 10000
    and not exists (select 1 from public.home_owned_items where owner_id = pg_temp.p('MA') and (source <> 'starter' or cost_paid <> 0)), null);
  perform pg_temp.ok('M2 ...and puts each in a slot it fits',
    j -> 'v' -> 'equipped' = pg_temp.eq('MA')
    and not exists (select 1 from public.home_equipped e join public.home_items i on i.id = e.item_id
                      join public.home_slots s on s.id = e.slot_id
                     where e.owner_id = pg_temp.p('MA') and s.fits <> i.slot_group)
    and (select count(*) from public.home_equipped where owner_id = pg_temp.p('MA'))
        = (select count(distinct i.id) from public.home_items i where i.is_starter
             and exists (select 1 from public.home_slots s where s.fits = i.slot_group and s.parent_id is null)), pg_temp.eq('MA')::text);

  select count(*) into v_owned from public.home_owned_items where owner_id = pg_temp.p('MA');
  perform pg_temp.clear('MA', 'wallpaper');
  j2 := pg_temp.eval_as('MA', 'select public.claim_my_place_starter()');
  perform pg_temp.ok('M2 a second claim gives nothing (claimed false, not an error) and puts nothing back',
    j2 ? 'v' and not (j2 -> 'v' ->> 'claimed')::boolean and j2 -> 'v' -> 'items' = '[]'::jsonb
    and (j2 -> 'v' ->> 'claimed_at') = (j -> 'v' ->> 'claimed_at')
    and (select count(*) from public.home_owned_items where owner_id = pg_temp.p('MA')) = v_owned
    and not (pg_temp.eq('MA') ? 'wallpaper'), j2::text);

  j := pg_temp.eval_nouser('select public.claim_my_place_starter()');
  perform pg_temp.ok('M2 no user: pl:auth.signed_out', pg_temp.refused(j, 'auth.signed_out'), j::text);
  j := pg_temp.eval_anon('select public.claim_my_place_starter()');
  perform pg_temp.ok('M2 anon can''t call it at all (permission denied)', j ->> 'state' = '42501', j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('M2 block crashed', false, sqlerrm);
end $$;


-- ════ M3 buying ══════════════════════════════════════════════════════════
do $$
declare
  j      jsonb;
  v_l    public.pickle_ledger;
  v_rows bigint;
begin
  j := pg_temp.buy('MA', 'mpt_floor');
  perform pg_temp.ok('M3 buy an item: the price is taken, the item is owned, the reply has the new balance',
    j -> 'v' ->> 'item_id' = 'mpt_floor' and (j -> 'v' ->> 'cost')::int = 500 and (j -> 'v' ->> 'balance')::int = 9500
    and not (j -> 'v' ->> 'already_owned')::boolean and pg_temp.pickles('MA') = 9500 and pg_temp.owns('MA', 'mpt_floor')
    and (select cost_paid = 500 and source = 'buy' from public.home_owned_items
          where owner_id = pg_temp.p('MA') and item_id = 'mpt_floor'), j::text);
  perform pg_temp.ok('M3 ...it is not equipped by the buy', not (pg_temp.eq('MA') -> 'floor' is not null
    and pg_temp.eq('MA') ->> 'floor' = 'mpt_floor'), pg_temp.eq('MA')::text);

  select * into v_l from public.pickle_ledger
   where profile_id = pg_temp.p('MA') and source = 'buy_home_item' order by id desc limit 1;
  perform pg_temp.ok('M3 ...and the ledger row names it (My Place: <item>, spend, -500)',
    v_l.delta = -500 and v_l.balance_after = 9500 and v_l.reason = 'My Place: Mpt Floor' and v_l.kind = 'spend'
    and not v_l.is_bonus and v_l.meta ->> 'item_id' = 'mpt_floor', to_jsonb(v_l)::text);
  perform pg_temp.ok('M3 ...and the reason setting is cleared after it', coalesce(current_setting('pl.pickle_reason', true), '') = '', null);

  select count(*) into v_rows from public.pickle_ledger where profile_id = pg_temp.p('MA');
  j := pg_temp.buy('MA', 'mpt_floor');
  perform pg_temp.ok('M3 buying it again is a no-op success: nothing charged, no ledger row',
    (j -> 'v' ->> 'already_owned')::boolean and (j -> 'v' ->> 'cost')::int = 0 and pg_temp.pickles('MA') = 9500
    and (select count(*) from public.pickle_ledger where profile_id = pg_temp.p('MA')) = v_rows, j::text);

  j := pg_temp.buy('MA', 'mpt_plant');
  perform pg_temp.ok('M3 a free item: owned, no pickles, no ledger row',
    (j -> 'v' ->> 'cost')::int = 0 and pg_temp.owns('MA', 'mpt_plant') and pg_temp.pickles('MA') = 9500
    and (select count(*) from public.pickle_ledger where profile_id = pg_temp.p('MA')) = v_rows, j::text);

  j := pg_temp.buy('MA', 'mpt_window');
  perform pg_temp.ok('M3 a limited item inside its window sells', (j -> 'v' ->> 'cost')::int = 1000 and pg_temp.pickles('MA') = 8500, j::text);

  j := pg_temp.buy('MP', 'mpt_floor');
  perform pg_temp.ok('M3 not enough pickles: pl:home.not_enough with cost, balance and how many short; nothing spent',
    pg_temp.refused(j, 'home.not_enough') and ((j ->> 'detail')::jsonb ->> 'short')::int = 400
    and ((j ->> 'detail')::jsonb ->> 'balance')::int = 100 and j ->> 'msg' like '%400 more%'
    and pg_temp.pickles('MP') = 100 and not pg_temp.owns('MP', 'mpt_floor'), j::text);
  j := pg_temp.buy('MA', 'mpt_rug');
  perform pg_temp.ok('M3 ...the owner too, for a 50,000 item', pg_temp.refused(j, 'home.not_enough')
    and j ->> 'msg' like '%50,000 pickles%' and pg_temp.pickles('MA') = 8500, j::text);

  j := pg_temp.buy('MA', 'mpt_soon');
  perform pg_temp.ok('M3 not on sale yet: pl:home.not_yet', pg_temp.refused(j, 'home.not_yet')
    and not pg_temp.owns('MA', 'mpt_soon') and pg_temp.pickles('MA') = 8500, j::text);
  j := pg_temp.buy('MA', 'mpt_ended');
  perform pg_temp.ok('M3 its drop has ended: pl:home.ended', pg_temp.refused(j, 'home.ended')
    and not pg_temp.owns('MA', 'mpt_ended') and pg_temp.pickles('MA') = 8500, j::text);
  j := pg_temp.buy('MA', 'mpt_no_such');
  perform pg_temp.ok('M3 no such item: pl:home.item_gone', pg_temp.refused(j, 'home.item_gone'), j::text);
  j := pg_temp.eval_as('MA', 'select public.buy_home_item(null)');
  perform pg_temp.ok('M3 no item id: pl:request.bad', pg_temp.refused(j, 'request.bad'), j::text);
  j := pg_temp.eval_nouser('select public.buy_home_item(''mpt_floor'')');
  perform pg_temp.ok('M3 no user: pl:auth.signed_out', pg_temp.refused(j, 'auth.signed_out'), j::text);
  j := pg_temp.eval_anon('select public.buy_home_item(''mpt_floor'')');
  perform pg_temp.ok('M3 anon can''t call it at all (permission denied)', j ->> 'state' = '42501', j::text);

  -- Owned before its drop ended (bought then): still the owner's.
  insert into public.home_owned_items (owner_id, item_id, cost_paid) values (pg_temp.p('MA'), 'mpt_ended', 100);
  j := pg_temp.buy('MA', 'mpt_ended');
  perform pg_temp.ok('M3 an item owned before its drop ended: buying again is the no-op, not a refusal',
    (j -> 'v' ->> 'already_owned')::boolean and pg_temp.pickles('MA') = 8500, j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('M3 block crashed', false, sqlerrm);
end $$;


-- ════ M4 equipping ═══════════════════════════════════════════════════════
do $$
declare j jsonb;
begin
  j := pg_temp.equip('MA', 'floor', 'mpt_floor');
  perform pg_temp.ok('M4 put an owned floor in the floor slot (a backdrop): the reply is the equipped map',
    pg_temp.eq('MA') ->> 'floor' = 'mpt_floor' and j -> 'v' -> 'equipped' = pg_temp.eq('MA')
    and j -> 'v' ->> 'moved_from' is null, j::text);
  j := pg_temp.equip('MA', 'floor', 'mpt_floor');
  perform pg_temp.ok('M4 ...again: same result (a retry is safe)', j ? 'v' and pg_temp.eq('MA') ->> 'floor' = 'mpt_floor', j::text);
  j := pg_temp.equip('MA', 'couch', 'mpt_ended');
  perform pg_temp.ok('M4 an owned item whose drop ended still goes in', j ? 'v' and pg_temp.eq('MA') ->> 'couch' = 'mpt_ended', j::text);

  j := pg_temp.equip('MA', 'rug', 'mpt_floor');
  perform pg_temp.ok('M4 wrong slot: pl:home.wrong_slot names the item and the slot',
    pg_temp.refused(j, 'home.wrong_slot') and (j ->> 'detail')::jsonb ->> 'fits' = 'floor'
    and (j ->> 'detail')::jsonb ->> 'slot_fits' = 'rug' and j ->> 'msg' like '%doesn''t fit Rug%', j::text);
  j := pg_temp.equip('MA', 'avatar', 'mpt_floor');
  perform pg_temp.ok('M4 the avatar spot takes no decor: pl:home.wrong_slot', pg_temp.refused(j, 'home.wrong_slot'), j::text);
  j := pg_temp.equip('MA', 'rug', 'mpt_rug');
  perform pg_temp.ok('M4 not owned: pl:home.not_owned', pg_temp.refused(j, 'home.not_owned')
    and (j ->> 'detail')::jsonb ->> 'item' = 'Mpt Rug' and not (pg_temp.eq('MA') ? 'rug'), j::text);
  j := pg_temp.equip('MB', 'floor', 'mpt_floor');
  perform pg_temp.ok('M4 ...someone else''s item: pl:home.not_owned', pg_temp.refused(j, 'home.not_owned')
    and pg_temp.eq('MB') = '{}'::jsonb, j::text);
  j := pg_temp.equip('MA', 'hot_tub', 'mpt_floor');
  perform pg_temp.ok('M4 a slot the server doesn''t know: pl:home.slot_unknown', pg_temp.refused(j, 'home.slot_unknown'), j::text);
  j := pg_temp.equip('MA', 'floor', 'mpt_no_such');
  perform pg_temp.ok('M4 no such item: pl:home.item_gone', pg_temp.refused(j, 'home.item_gone'), j::text);
  j := pg_temp.equip('MA', null, 'mpt_floor');
  perform pg_temp.ok('M4 no slot id: pl:request.bad', pg_temp.refused(j, 'request.bad'), j::text);
  j := pg_temp.eval_nouser('select public.equip_home_item(''floor'', ''mpt_floor'')');
  perform pg_temp.ok('M4 no user: pl:auth.signed_out', pg_temp.refused(j, 'auth.signed_out'), j::text);
  j := pg_temp.eval_anon('select public.equip_home_item(''floor'', ''mpt_floor'')');
  perform pg_temp.ok('M4 anon can''t call it at all (permission denied)', j ->> 'state' = '42501', j::text);

  -- The parent rule: a shelf-top item needs a shelf.
  perform pg_temp.clear('MA', 'shelf');
  perform pg_temp.buy('MA', 'mpt_trophy');
  j := pg_temp.equip('MA', 'shelf_item', 'mpt_trophy');
  perform pg_temp.ok('M4 a prop on an empty spot: pl:home.parent_empty names the spot to fill first',
    pg_temp.refused(j, 'home.parent_empty') and (j ->> 'detail')::jsonb ->> 'parent' = 'Shelf'
    and j ->> 'msg' like '%Put something in Shelf first%' and not (pg_temp.eq('MA') ? 'shelf_item'), j::text);
  perform pg_temp.buy('MA', 'mpt_shelf');
  j := pg_temp.equip('MA', 'shelf', 'mpt_shelf');
  perform pg_temp.ok('M4 ...fill the shelf', pg_temp.eq('MA') ->> 'shelf' = 'mpt_shelf', j::text);
  j := pg_temp.equip('MA', 'shelf_item', 'mpt_trophy');
  perform pg_temp.ok('M4 ...then the trophy goes on it', pg_temp.eq('MA') ->> 'shelf_item' = 'mpt_trophy', j::text);

  -- Two slots share the accent group; an item is in one at a time.
  j := pg_temp.equip('MA', 'accent2', 'mpt_plant');
  perform pg_temp.ok('M4 a shared group: the plant goes in the second corner', pg_temp.eq('MA') ->> 'accent2' = 'mpt_plant', j::text);
  j := pg_temp.equip('MA', 'accent', 'mpt_plant');
  perform pg_temp.ok('M4 ...equipped in the first corner it moves (moved_from accent2), never in two slots',
    pg_temp.eq('MA') ->> 'accent' = 'mpt_plant' and not (pg_temp.eq('MA') ? 'accent2')
    and j -> 'v' ->> 'moved_from' = 'accent2', j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('M4 block crashed', false, sqlerrm);
end $$;


-- ════ M5 clearing, and no writes past the RPCs ═══════════════════════════
do $$
declare j jsonb;
begin
  j := pg_temp.clear('MA', 'shelf');
  perform pg_temp.ok('M5 clear a slot: emptied, the reply is the map',
    (j -> 'v' ->> 'cleared')::boolean and not (pg_temp.eq('MA') ? 'shelf') and j -> 'v' -> 'equipped' = pg_temp.eq('MA'), j::text);
  perform pg_temp.ok('M5 ...what sat on it stays equipped (the kit hides it until the shelf is back)',
    pg_temp.eq('MA') ->> 'shelf_item' = 'mpt_trophy', null);
  j := pg_temp.clear('MA', 'shelf');
  perform pg_temp.ok('M5 clearing an empty slot is fine (cleared false)', j ? 'v' and not (j -> 'v' ->> 'cleared')::boolean, j::text);
  j := pg_temp.clear('MA', 'hot_tub');
  perform pg_temp.ok('M5 ...so is a slot the server doesn''t know', j ? 'v' and not (j -> 'v' ->> 'cleared')::boolean, j::text);
  j := pg_temp.clear('MA', null);
  perform pg_temp.ok('M5 no slot id: pl:request.bad', pg_temp.refused(j, 'request.bad'), j::text);
  j := pg_temp.eval_nouser('select public.clear_home_slot(''floor'')');
  perform pg_temp.ok('M5 no user: pl:auth.signed_out', pg_temp.refused(j, 'auth.signed_out'), j::text);
  perform pg_temp.ok('M5 the items the player owns are all still owned after clearing', pg_temp.owns('MA', 'mpt_shelf'), null);

  j := pg_temp.run_as('MA', format($q$insert into public.home_owned_items (owner_id, item_id) values (%L, 'mpt_rug')$q$, pg_temp.p('MA')));
  perform pg_temp.ok('M5 a direct insert of an owned item is refused (no free items)', j ->> 'state' = '42501' and not pg_temp.owns('MA', 'mpt_rug'), j::text);
  j := pg_temp.run_as('MA', format($q$insert into public.home_equipped (owner_id, slot_id, item_id) values (%L, 'rug', 'mpt_rug')$q$, pg_temp.p('MA')));
  perform pg_temp.ok('M5 ...and of an equipped row', j ->> 'state' = '42501', j::text);
  j := pg_temp.run_as('MA', format($q$delete from public.home_equipped where owner_id = %L$q$, pg_temp.p('MA')));
  perform pg_temp.ok('M5 ...and a direct delete', j ->> 'state' = '42501', j::text);
  j := pg_temp.run_as('MA', $q$update public.home_items set cost = 0 where id = 'mpt_rug'$q$);
  perform pg_temp.ok('M5 ...and a price change', j ->> 'state' = '42501' and (select cost from public.home_items where id = 'mpt_rug') = 50000, j::text);
  j := pg_temp.run_as('MA', $q$update public.room_layout set layout = '{}'::jsonb$q$);
  perform pg_temp.ok('M5 ...and a direct layout write', j ->> 'state' = '42501', j::text);
  j := pg_temp.run_as('MA', format($q$insert into public.home_settings (owner_id, visibility) values (%L, 'only_me')$q$, pg_temp.p('MA')));
  perform pg_temp.ok('M5 ...and a direct settings write', j ->> 'state' = '42501', j::text);

  -- Reads: the catalog, art, slots and layout for every signed-in player; owned rows only for their owner.
  j := pg_temp.eval_as('MB', $q$select jsonb_build_object(
      'items', (select count(*) from public.home_items where id like 'mpt\_%'),
      'art',   (select count(*) from public.home_item_art where item_id = 'mpt_window'),
      'slots', (select count(*) from public.home_slots),
      'layout', (select count(*) from public.room_layout),
      'owned_of_ma', (select count(*) from public.home_owned_items where owner_id <> auth.uid()),
      'equipped_of_ma', (select count(*) from public.home_equipped where owner_id <> auth.uid()))$q$);
  perform pg_temp.ok('M5 a signed-in player reads the catalog, art, slots and layout, but not another player''s rows',
    (j -> 'v' ->> 'items')::int = 8 and (j -> 'v' ->> 'art')::int = 1 and (j -> 'v' ->> 'slots')::int >= 14
    and (j -> 'v' ->> 'layout')::int = 1 and (j -> 'v' ->> 'owned_of_ma')::int = 0
    and (j -> 'v' ->> 'equipped_of_ma')::int = 0, j::text);
  j := pg_temp.eval_as('MA', $q$select to_jsonb(count(*)) from public.home_owned_items$q$);
  perform pg_temp.ok('M5 ...and their own owned rows',
    (j ->> 'v')::int = (select count(*) from public.home_owned_items where owner_id = pg_temp.p('MA')), j::text);
  j := pg_temp.eval_anon('select to_jsonb(count(*)) from public.home_items');
  perform pg_temp.ok('M5 anon can''t read the catalog', j ->> 'state' = '42501', j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('M5 block crashed', false, sqlerrm);
end $$;


-- ════ M6 who can visit: visibility, friends, blocks, guests ══════════════
do $$
declare j jsonb;
begin
  j := pg_temp.eval_as('MA', 'select public.get_home()');
  perform pg_temp.ok('M6 the owner reads their own place: map, owned, balance, friends by default',
    (j -> 'v' ->> 'is_me')::boolean and j -> 'v' -> 'equipped' = pg_temp.eq('MA')
    and j -> 'v' ->> 'visibility' = 'friends' and (j -> 'v' ->> 'balance')::int = pg_temp.pickles('MA')
    and j -> 'v' -> 'owned' @> '["mpt_floor", "mpt_shelf", "mpt_trophy"]'::jsonb
    and (j -> 'v' ->> 'starter_claimed')::boolean
    and j -> 'v' -> 'item_ids' @> '["mpt_floor", "mpt_trophy"]'::jsonb, j::text);
  j := pg_temp.home('MA', 'MA');
  perform pg_temp.ok('M6 ...by their own id too', (j -> 'v' ->> 'is_me')::boolean, j::text);

  j := pg_temp.home('MB', 'MA');
  perform pg_temp.ok('M6 a friend visits: the map and its item ids, not what the owner owns or their balance',
    not (j -> 'v' ->> 'is_me')::boolean and j -> 'v' -> 'equipped' = pg_temp.eq('MA')
    and jsonb_array_length(j -> 'v' -> 'item_ids') = (select count(*) from public.home_equipped where owner_id = pg_temp.p('MA'))
    and not (j -> 'v' ? 'owned') and not (j -> 'v' ? 'balance'), j::text);

  j := pg_temp.home('MC', 'MA');
  perform pg_temp.ok('M6 a stranger: pl:home.friends_only, names the owner and says to send a friend request',
    pg_temp.refused(j, 'home.friends_only') and (j ->> 'detail')::jsonb ->> 'name' = 'Place'
    and j ->> 'msg' like '%friend request%' and not (j ? 'v'), j::text);
  j := pg_temp.home('MD', 'MA');
  perform pg_temp.ok('M6 blocked by the owner: pl:home.unavailable', pg_temp.refused(j, 'home.unavailable'), j::text);
  j := pg_temp.home('MA', 'ME');
  perform pg_temp.ok('M6 the owner blocked by ME can''t visit ME''s place', pg_temp.refused(j, 'home.unavailable'), j::text);
  j := pg_temp.home('ME', 'MA');
  perform pg_temp.ok('M6 ...and ME, who blocked the owner, can''t visit theirs (blocked either way)',
    pg_temp.refused(j, 'home.unavailable'), j::text);

  -- The block holds even with an accepted friendship on file.
  begin
    insert into public.friendships (requester_id, addressee_id, status, responded_at)
    values (pg_temp.p('MD'), pg_temp.p('MA'), 'accepted', now()) on conflict do nothing;
  exception when others then null;
  end;
  j := pg_temp.home('MD', 'MA');
  perform pg_temp.ok('M6 a block beats a friendship', pg_temp.refused(j, 'home.unavailable'), j::text);

  j := pg_temp.home('MG', 'MA');
  perform pg_temp.ok('M6 a guest pass visiting: pl:home.guest', pg_temp.refused(j, 'home.guest'), j::text);
  j := pg_temp.eval_as('MG', 'select public.get_home()');
  perform pg_temp.ok('M6 ...a guest still has their own place', j ? 'v' and (j -> 'v' ->> 'is_me')::boolean, j::text);

  j := pg_temp.vis('MA', 'only_me');
  perform pg_temp.ok('M6 the owner sets Only me', j -> 'v' ->> 'visibility' = 'only_me', j::text);
  j := pg_temp.home('MB', 'MA');
  perform pg_temp.ok('M6 ...then a friend gets pl:home.private', pg_temp.refused(j, 'home.private')
    and (j ->> 'detail')::jsonb ->> 'name' = 'Place', j::text);
  j := pg_temp.eval_as('MA', 'select public.get_home()');
  perform pg_temp.ok('M6 ...the owner still sees it, visibility only_me', j -> 'v' ->> 'visibility' = 'only_me', j::text);
  j := pg_temp.vis('MA', 'friends');
  j := pg_temp.home('MB', 'MA');
  perform pg_temp.ok('M6 back to Friends: the friend visits again', j ? 'v', j::text);
  j := pg_temp.vis('MA', 'everyone');
  perform pg_temp.ok('M6 a setting that isn''t friends / only_me: pl:request.bad', pg_temp.refused(j, 'request.bad')
    and (select visibility from public.home_settings where owner_id = pg_temp.p('MA')) = 'friends', j::text);
  j := pg_temp.vis('MA', null);
  perform pg_temp.ok('M6 ...or none: pl:request.bad', pg_temp.refused(j, 'request.bad'), j::text);

  j := pg_temp.eval_as('MB', format('select public.get_home(%L::uuid)', gen_random_uuid()));
  perform pg_temp.ok('M6 nobody with that id: pl:player.gone', pg_temp.refused(j, 'player.gone'), j::text);
  j := pg_temp.eval_nouser('select public.get_home()');
  perform pg_temp.ok('M6 no user: pl:auth.signed_out', pg_temp.refused(j, 'auth.signed_out'), j::text);
  j := pg_temp.eval_anon(format('select public.get_home(%L::uuid)', pg_temp.p('MA')));
  perform pg_temp.ok('M6 anon can''t call it at all (permission denied)', j ->> 'state' = '42501', j::text);
  j := pg_temp.eval_nouser('select public.set_my_place_visibility(''friends'')');
  perform pg_temp.ok('M6 settings with no user: pl:auth.signed_out', pg_temp.refused(j, 'auth.signed_out'), j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('M6 block crashed', false, sqlerrm);
end $$;


-- ════ M7 the admin layout ════════════════════════════════════════════════
do $$
declare
  j      jsonb;
  v_good jsonb := $j${"version": 1, "extra": "kept",
    "placements": {
      "shelf":      {"kind": "furniture", "cx": 0.3, "bottom": 0.8, "w": 0.25, "z": 4, "flip": true},
      "shelf_item": {"kind": "prop", "u": 0.5, "surface": 0.1, "scale": 0.4, "z": null},
      "rug":        {"kind": "wide", "cx": 0.5, "top": 0.75, "w": 0.6, "ar": 3.2},
      "window":     {"kind": "free", "cx": -1, "top": 2, "w": 4},
      "accent":     {"kind": "floor", "u": 0.1, "baseY": 0.95, "scale": 0.15, "flip": false},
      "avatar":     {"kind": "avatar", "cx": 0.6, "bottom": 0.9, "w": 0.2},
      "future_slot": {"kind": "free", "cx": 0.5, "top": 0.1, "w": 0.1, "newField": 1}
    }}$j$;
  v_before jsonb;
  v_bad    record;
begin
  v_before := pg_temp.layout();
  j := pg_temp.save('MA', v_good);
  perform pg_temp.ok('M7 a player can''t save the layout: pl:admin.only, nothing changed',
    pg_temp.refused(j, 'admin.only') and pg_temp.layout() = v_before, j::text);
  j := pg_temp.eval_nouser(format('select public.save_room_layout(%L::jsonb)', v_good));
  perform pg_temp.ok('M7 no user: pl:auth.signed_out', pg_temp.refused(j, 'auth.signed_out'), j::text);
  j := pg_temp.eval_anon(format('select public.save_room_layout(%L::jsonb)', v_good));
  perform pg_temp.ok('M7 anon can''t call it at all (permission denied)', j ->> 'state' = '42501', j::text);

  j := pg_temp.save('GM', v_good);
  perform pg_temp.ok('M7 God mode saves a good layout: stored whole (a newer build''s slot, unknown keys kept)',
    j -> 'v' ->> 'id' = 'default' and pg_temp.layout() = v_good
    and (select updated_by from public.room_layout where id = 'default') = pg_temp.p('GM'), j::text);
  j := pg_temp.eval_as('MB', $q$select layout from public.room_layout where id = 'default'$q$);
  perform pg_temp.ok('M7 ...every signed-in player reads it', j -> 'v' = v_good, j::text);

  for v_bad in select * from (values
      ('null',                     'null'::jsonb),
      ('an array',                 '[]'::jsonb),
      ('no version',               '{"placements": {}}'::jsonb),
      ('version as a string',      '{"version": "1", "placements": {}}'::jsonb),
      ('version 1.5',              '{"version": 1.5, "placements": {}}'::jsonb),
      ('version 0',                '{"version": 0, "placements": {}}'::jsonb),
      ('no placements',            '{"version": 1}'::jsonb),
      ('placements as an array',   '{"version": 1, "placements": []}'::jsonb),
      ('a placement that isn''t an object', '{"version": 1, "placements": {"shelf": 3}}'::jsonb),
      ('an unknown kind',          '{"version": 1, "placements": {"shelf": {"kind": "sofa", "cx": 0.5, "bottom": 0.8, "w": 0.2}}}'::jsonb),
      ('no kind',                  '{"version": 1, "placements": {"shelf": {"cx": 0.5, "bottom": 0.8, "w": 0.2}}}'::jsonb),
      ('the wrong kind for a known slot', '{"version": 1, "placements": {"shelf": {"kind": "free", "cx": 0.5, "top": 0.8, "w": 0.2}}}'::jsonb),
      ('a placement on a backdrop slot', '{"version": 1, "placements": {"wallpaper": {"kind": "free", "cx": 0.5, "top": 0.1, "w": 0.2}}}'::jsonb),
      ('a missing field',          '{"version": 1, "placements": {"shelf": {"kind": "furniture", "cx": 0.5, "bottom": 0.8}}}'::jsonb),
      ('a number as a string',     '{"version": 1, "placements": {"shelf": {"kind": "furniture", "cx": "0.5", "bottom": 0.8, "w": 0.2}}}'::jsonb),
      ('size 0',                   '{"version": 1, "placements": {"shelf": {"kind": "furniture", "cx": 0.5, "bottom": 0.8, "w": 0}}}'::jsonb),
      ('size above 4',             '{"version": 1, "placements": {"shelf": {"kind": "furniture", "cx": 0.5, "bottom": 0.8, "w": 4.5}}}'::jsonb),
      ('a position above 2',       '{"version": 1, "placements": {"shelf": {"kind": "furniture", "cx": 2.5, "bottom": 0.8, "w": 0.2}}}'::jsonb),
      ('a position below -1',      '{"version": 1, "placements": {"shelf": {"kind": "furniture", "cx": -1.5, "bottom": 0.8, "w": 0.2}}}'::jsonb),
      ('a wide ar of 0',           '{"version": 1, "placements": {"rug": {"kind": "wide", "cx": 0.5, "top": 0.8, "w": 0.2, "ar": 0}}}'::jsonb),
      ('a z that isn''t a number', '{"version": 1, "placements": {"shelf": {"kind": "furniture", "cx": 0.5, "bottom": 0.8, "w": 0.2, "z": "top"}}}'::jsonb),
      ('a flip that isn''t true / false', '{"version": 1, "placements": {"shelf": {"kind": "furniture", "cx": 0.5, "bottom": 0.8, "w": 0.2, "flip": "yes"}}}'::jsonb),
      ('a bad slot id',            '{"version": 1, "placements": {"bad id!": {"kind": "free", "cx": 0.5, "top": 0.1, "w": 0.2}}}'::jsonb),
      ('an unknown slot with a bad placement', '{"version": 1, "placements": {"future_slot": {"kind": "free", "cx": 0.5, "top": 0.1}}}'::jsonb),
      ('more than 200 slots',      jsonb_build_object('version', 1, 'placements',
                                     (select jsonb_object_agg('s' || g, '{"kind": "free", "cx": 0.5, "top": 0.1, "w": 0.1}'::jsonb)
                                        from generate_series(1, 201) g))),
      ('larger than 64 KB',        jsonb_build_object('version', 1, 'placements', '{}'::jsonb, 'pad', repeat('x', 70000)))
    ) as b (label, layout)
  loop
    j := pg_temp.save('GM', v_bad.layout);
    perform pg_temp.ok(format('M7 refused, nothing saved: %s (pl:home.layout_bad, says what to fix)', v_bad.label),
      pg_temp.refused(j, 'home.layout_bad') and j ->> 'msg' like '%Fix that spot%' and pg_temp.layout() = v_good, j::text);
  end loop;

  j := pg_temp.save('GM', '{"version": 2, "placements": {}}'::jsonb);
  perform pg_temp.ok('M7 a newer layout version: pl:home.layout_newer, nothing saved',
    pg_temp.refused(j, 'home.layout_newer') and ((j ->> 'detail')::jsonb ->> 'version')::numeric = 2
    and pg_temp.layout() = v_good, j::text);

  j := pg_temp.save('GM', '{"version": 1, "placements": {}}'::jsonb);
  perform pg_temp.ok('M7 the empty layout (every slot at its default) saves',
    j ? 'v' and pg_temp.layout() = '{"version": 1, "placements": {}}'::jsonb, j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('M7 block crashed', false, sqlerrm);
end $$;


-- ════ M8 a deleted owner ═════════════════════════════════════════════════
do $$
declare j jsonb;
begin
  perform pg_temp.eval_as('MX', 'select public.claim_my_place_starter()');
  perform pg_temp.vis('MX', 'friends');
  j := pg_temp.home('MB', 'MX');
  perform pg_temp.ok('M8 before: MX''s friend visits', j ? 'v', j::text);

  -- What _purge_account does to the profile row (the tombstone).
  update public.profiles set deleted_at = now(), full_name = '[deleted account]' where id = pg_temp.p('MX');
  perform pg_temp.ok('M8 the tombstone removes the place: owned items, equipped map, settings, starter claim',
    not exists (select 1 from public.home_owned_items where owner_id = pg_temp.p('MX'))
    and not exists (select 1 from public.home_equipped where owner_id = pg_temp.p('MX'))
    and not exists (select 1 from public.home_settings where owner_id = pg_temp.p('MX'))
    and not exists (select 1 from public.home_starter_claims where owner_id = pg_temp.p('MX')), null);
  j := pg_temp.home('MB', 'MX');
  perform pg_temp.ok('M8 ...and a visit gets pl:player.gone, saying to pick someone else',
    pg_temp.refused(j, 'player.gone') and j ->> 'msg' like '%pick someone else%', j::text);
  perform pg_temp.ok('M8 other players'' places are untouched', exists (select 1 from public.home_equipped where owner_id = pg_temp.p('MA')), null);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('M8 block crashed', false, sqlerrm);
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
