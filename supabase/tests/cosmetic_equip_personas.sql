-- ============================================================
-- "Equip only what you own" persona tests (migration_cosmetic_equip_owned.sql).
--
-- NOT runnable on its own: build-cosmetic-equip-test.mjs puts
-- migration_cosmetic_equip_owned.sql, twice (it must be re-runnable), at the
-- marker line below. Everything runs inside the begin / rollback below, so
-- the linked (live) database is left untouched:
--   node supabase/tests/build-cosmetic-equip-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary.
--
-- Needs migration_profiles_column_guard.sql live (E1 checks its trigger).
-- Test Shop items (slugs eq-test-*) are made inside the transaction, so the
-- live catalog never matters.
--
-- Personas (temporary accounts created inside the transaction; the signup
-- trigger makes each profile):
--   EA an owner: buys every test item, equips and unequips them
--   EB a player who owns none of them
--   EC a player EA gifts an avatar to
-- ============================================================

begin;

-- The pg_temp helpers below are called by the personas (as anon /
-- authenticated). Since migration_anon_audit_rest.sql, functions postgres
-- creates are no longer EXECUTE-able by PUBLIC by default, so this test
-- transaction (rolled back below) gives the helpers the old default back.
-- (The migration revokes PUBLIC from its own functions explicitly.)
alter default privileges for role postgres grant execute on functions to public;

-- ════ Harness ════════════════════════════════════════════════════════════
create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);
grant select, insert on _results to authenticated, anon;
grant usage on sequence _results_n_seq to authenticated, anon;

create temp table _p (k text primary key, id uuid not null);
insert into _p values
  ('EA', 'a8200000-0000-4000-8000-000000000001'), ('EB', 'a8200000-0000-4000-8000-000000000002'),
  ('EC', 'a8200000-0000-4000-8000-000000000003');
grant select on _p to authenticated, anon;

-- The test Shop items (filled in Setup).
create temp table _it (k text primary key, id uuid not null, name text not null);
grant select on _it to authenticated, anon;

create function pg_temp.p(text) returns uuid language sql stable as $$ select id from _p where k = $1 $$;
create function pg_temp.it(text) returns uuid language sql stable as $$ select id from _it where k = $1 $$;

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

create function pg_temp.as_service() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role": "service_role"}', true);
  perform set_config('role', 'service_role', true);
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

-- As persona k, back to admin after.
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

-- equip_shop_item(<test item k>) / unequip_cosmetic(<category>) as persona.
create function pg_temp.equip(k text, item text) returns jsonb language sql as $$
  select pg_temp.eval_as(k, format('select public.equip_shop_item(%L::uuid)', pg_temp.it(item))) $$;
create function pg_temp.unequip(k text, cat text) returns jsonb language sql as $$
  select pg_temp.eval_as(k, format('select public.unequip_cosmetic(%L)', cat)) $$;

-- A persona's equipped columns, and whole row (read as admin).
create function pg_temp.cos(k text) returns jsonb language sql stable as $$
  select jsonb_build_object('avatar_emoji', avatar_emoji, 'avatar_bg_color', avatar_bg_color, 'name_color', name_color,
                            'list_name_style_id', list_name_style_id, 'profile_name_style_id', profile_name_style_id)
    from public.profiles where id = pg_temp.p(k) $$;
create function pg_temp.row_of(k text) returns jsonb language sql stable as $$
  select to_jsonb(p) from public.profiles p where p.id = pg_temp.p(k) $$;

-- A refusal with this code (P0001, HINT pl:<code>, a message for people).
create function pg_temp.refused(j jsonb, code text) returns boolean language sql immutable as $$
  select j ->> 'state' = 'P0001' and j ->> 'hint' = 'pl:' || code and coalesce(j ->> 'msg', '') <> '' $$;

-- @@MIGRATION@@


-- ════ Setup (after the migration, so every trigger is live) ══════════════
do $$
declare
  v_badge uuid := (select id from public.badges order by name, id limit 1);
begin
  perform pg_temp.as_admin();
  insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
  select id, 'equip-' || lower(k) || '@pickleague.test', jsonb_build_object('full_name', 'Equip Player ' || k), now()
    from _p;
  update public.profiles set pickles = 10000 where id = pg_temp.p('EA');

  with ins as (
    insert into public.shop_items (category, slug, name, description, icon, cost, payload, is_active, sort_order, unlock_badge_id)
    values
      ('avatar',             'eq-test-avatar-1', 'Eq Test Fox',     'test', 'F', 100, '{"emoji": "eqfox", "bgColor": "#101010"}', true, 990, null),
      ('avatar',             'eq-test-avatar-2', 'Eq Test Owl',     'test', 'O', 100, '{"emoji": "eqowl", "bgColor": "#202020"}', true, 991, null),
      ('flair',              'eq-test-flair',    'Eq Test Color',   'test', 'C', 100, '{"kind": "name_color", "value": "#e0e0e1"}', true, 992, null),
      ('list_name_style',    'eq-test-list',     'Eq Test List',    'test', 'L', 100, '{}', true, 993, null),
      ('profile_name_style', 'eq-test-profile',  'Eq Test Profile', 'test', 'P', 100, '{}', true, 994, null),
      ('cosmetic_badge',     'eq-test-badge',    'Eq Test Badge',   'test', 'B', 100, '{}', true, 995, null),
      ('list_name_style',    'eq-test-free',     'Eq Test Free',    'test', 'R', 0,   '{}', true, 996, null),
      ('list_name_style',    'eq-test-free-off', 'Eq Test Retired', 'test', 'X', 0,   '{}', false, 997, null),
      ('profile_name_style', 'eq-test-gated',    'Eq Test Gated',   'test', 'G', 0,   '{}', true, 998, v_badge)
    returning id, slug, name
  )
  insert into _it (k, id, name)
  select case slug
           when 'eq-test-avatar-1' then 'AV1' when 'eq-test-avatar-2' then 'AV2' when 'eq-test-flair' then 'FL'
           when 'eq-test-list' then 'LS' when 'eq-test-profile' then 'PS' when 'eq-test-badge' then 'BD'
           when 'eq-test-free' then 'FREE' when 'eq-test-free-off' then 'FREE_OFF' else 'GATE' end,
         id, name
    from ins;
end $$;


-- ════ E1 installed the way the house rules want ══════════════════════════
do $$
declare
  f    record;
  v_tg text;
begin
  for f in select unnest(array['public.equip_shop_item(uuid)', 'public.unequip_cosmetic(text)']) as sig loop
    perform pg_temp.ok(format('E1 %s is SECURITY DEFINER with search_path pinned to ''''', f.sig),
      (select p.prosecdef and p.proconfig @> array['search_path=""'] from pg_proc p where p.oid = f.sig::regprocedure), null);
    perform pg_temp.ok(format('E1 %s: signed-in players may call it, anon may not', f.sig),
      has_function_privilege('authenticated', f.sig, 'execute') and not has_function_privilege('anon', f.sig, 'execute'), null);
  end loop;

  perform pg_temp.ok('E1 the guard is still SECURITY INVOKER, search_path pinned, not callable by clients',
    (select not p.prosecdef and p.proconfig @> array['search_path=""'] from pg_proc p
      where p.oid = 'public._pl_profiles_column_guard()'::regprocedure)
    and not has_function_privilege('authenticated', 'public._pl_profiles_column_guard()', 'execute')
    and not has_function_privilege('anon', 'public._pl_profiles_column_guard()', 'execute'), null);
  perform pg_temp.ok('E1 the guard body is this file''s (checks equipped cosmetics)',
    (select prosrc like '%pl:shop.not_owned%' and prosrc like '%pl:profile.server_owned%' and prosrc like '%pl:profile.locked%' from pg_proc
      where oid = 'public._pl_profiles_column_guard()'::regprocedure), null);
  select pg_get_triggerdef(t.oid) into v_tg
    from pg_trigger t where t.tgrelid = 'public.profiles'::regclass and t.tgname = 'trg_profiles_column_guard';
  perform pg_temp.ok('E1 trg_profiles_column_guard (migration_profiles_column_guard.sql) runs it, BEFORE INSERT OR UPDATE',
    v_tg like '%BEFORE INSERT OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION %_pl_profiles_column_guard()%', v_tg);
  perform pg_temp.ok('E1 gift_shop_item is this file''s (refuses badge-gated items)',
    (select prosrc like '%can''''t be gifted%' from pg_proc where oid = 'public.gift_shop_item(uuid,uuid,text)'::regprocedure), null);
  perform pg_temp.ok('E1 setup made the nine test items', (select count(*) from _it) = 9, null);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('E1 block crashed', false, sqlerrm);
end $$;


-- ════ E2 a purchase still auto-equips (purchase_shop_item, definer) ══════
do $$
declare
  r   record;
  v_k text;
begin
  for v_k in select unnest(array['AV1', 'FL', 'LS', 'PS', 'BD', 'AV2']) loop
    perform pg_temp.as_user(pg_temp.p('EA'));
    select * into r from public.purchase_shop_item(pg_temp.it(v_k));
    perform pg_temp.as_admin();
    perform pg_temp.ok(format('E2 the owner buys %s', v_k), r.success, r.message);
  end loop;
  perform pg_temp.ok('E2 every purchase equipped itself (the last avatar bought wins)',
    pg_temp.cos('EA') = jsonb_build_object('avatar_emoji', 'eqowl', 'avatar_bg_color', '#202020', 'name_color', '#e0e0e1',
                                           'list_name_style_id', 'eq-test-list', 'profile_name_style_id', 'eq-test-profile'),
    pg_temp.cos('EA')::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('E2 block crashed', false, sqlerrm);
end $$;


-- ════ E3 the owner equips and unequips through the RPCs ══════════════════
do $$
declare j jsonb;
begin
  j := pg_temp.equip('EA', 'AV1');
  perform pg_temp.ok('E3 equip an owned avatar: both columns from its payload, the reply is the five columns',
    j -> 'v' = pg_temp.cos('EA') and pg_temp.cos('EA') ->> 'avatar_emoji' = 'eqfox'
    and pg_temp.cos('EA') ->> 'avatar_bg_color' = '#101010', j::text);

  j := pg_temp.unequip('EA', 'flair');
  perform pg_temp.ok('E3 unequip the name color', j -> 'v' = pg_temp.cos('EA') and pg_temp.cos('EA') ->> 'name_color' is null, j::text);
  j := pg_temp.equip('EA', 'FL');
  perform pg_temp.ok('E3 ...and equip it again', pg_temp.cos('EA') ->> 'name_color' = '#e0e0e1', j::text);

  j := pg_temp.unequip('EA', 'list_name_style');
  perform pg_temp.ok('E3 unequip the list style', pg_temp.cos('EA') ->> 'list_name_style_id' is null, j::text);
  j := pg_temp.equip('EA', 'LS');
  perform pg_temp.ok('E3 ...and equip it again', pg_temp.cos('EA') ->> 'list_name_style_id' = 'eq-test-list', j::text);

  j := pg_temp.unequip('EA', 'profile_name_style');
  perform pg_temp.ok('E3 unequip the profile style', pg_temp.cos('EA') ->> 'profile_name_style_id' is null, j::text);
  j := pg_temp.equip('EA', 'PS');
  perform pg_temp.ok('E3 ...and equip it again', pg_temp.cos('EA') ->> 'profile_name_style_id' = 'eq-test-profile', j::text);

  j := pg_temp.unequip('EA', 'avatar');
  perform pg_temp.ok('E3 unequip the avatar clears both columns',
    pg_temp.cos('EA') ->> 'avatar_emoji' is null and pg_temp.cos('EA') ->> 'avatar_bg_color' is null, j::text);
  j := pg_temp.equip('EA', 'AV2');
  perform pg_temp.ok('E3 ...and equip the other owned avatar', pg_temp.cos('EA') ->> 'avatar_emoji' = 'eqowl', j::text);

  -- An item retired from the Shop stays equippable for those who own it.
  update public.shop_items set is_active = false where id = pg_temp.it('PS');
  perform pg_temp.unequip('EA', 'profile_name_style');
  j := pg_temp.equip('EA', 'PS');
  perform pg_temp.ok('E3 an owned item that left the Shop can still be equipped',
    j ? 'v' and pg_temp.cos('EA') ->> 'profile_name_style_id' = 'eq-test-profile', j::text);
  update public.shop_items set is_active = true where id = pg_temp.it('PS');
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('E3 block crashed', false, sqlerrm);
end $$;


-- ════ E4 a non-owner is refused by the RPC ═══════════════════════════════
do $$
declare
  j      jsonb;
  v_k    text;
  before jsonb := pg_temp.cos('EB');
  v_bad  text;
begin
  for v_k in select unnest(array['AV1', 'FL', 'LS', 'PS']) loop
    j := pg_temp.equip('EB', v_k);
    perform pg_temp.ok(format('E4 a player who doesn''t own %s can''t equip it (pl:shop.not_owned, names the item)', v_k),
      pg_temp.refused(j, 'shop.not_owned') and (j ->> 'detail')::jsonb ->> 'item' = (select i.name from _it i where i.k = v_k)
      and j ->> 'msg' like '%Buy it in the Shop first%', j::text);
  end loop;
  perform pg_temp.ok('E4 ...and nothing changed', pg_temp.cos('EB') = before, pg_temp.cos('EB')::text);

  select b.name into v_bad from public.shop_items i join public.badges b on b.id = i.unlock_badge_id where i.id = pg_temp.it('GATE');
  j := pg_temp.equip('EB', 'GATE');
  if v_bad is null then
    perform pg_temp.ok('E4 a badge-gated item: skipped (no badges on this database)', true, j::text);
  else
    perform pg_temp.ok('E4 a badge-gated item (even at cost 0) needs the badge: the refusal names it',
      pg_temp.refused(j, 'shop.not_owned') and (j ->> 'detail')::jsonb ->> 'badge' = v_bad and j ->> 'msg' like '%' || v_bad || '%'
      and pg_temp.cos('EB') = before, j::text);
  end if;
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('E4 block crashed', false, sqlerrm);
end $$;


-- ════ E5 ...and by the guard on a direct UPDATE ══════════════════════════
do $$
declare
  j      jsonb;
  before jsonb := pg_temp.row_of('EB');
  id_b   uuid := pg_temp.p('EB');
begin
  j := pg_temp.run_as('EB', format('update public.profiles set avatar_emoji = %L, avatar_bg_color = %L where id = %L',
                                   'eqfox', '#101010', id_b));
  perform pg_temp.ok('E5 a direct PATCH to an avatar the player doesn''t own is refused (both columns named)',
    pg_temp.refused(j, 'shop.not_owned') and (j ->> 'detail')::jsonb -> 'columns' = '["avatar_bg_color", "avatar_emoji"]'::jsonb, j::text);
  j := pg_temp.run_as('EB', format('update public.profiles set name_color = %L where id = %L', '#e0e0e1', id_b));
  perform pg_temp.ok('E5 ...a name color', pg_temp.refused(j, 'shop.not_owned')
    and (j ->> 'detail')::jsonb -> 'columns' = '["name_color"]'::jsonb, j::text);
  j := pg_temp.run_as('EB', format('update public.profiles set name_color = %L where id = %L', '#000001', id_b));
  perform pg_temp.ok('E5 ...a name color no item has', pg_temp.refused(j, 'shop.not_owned'), j::text);
  j := pg_temp.run_as('EB', format('update public.profiles set list_name_style_id = %L where id = %L', 'eq-test-list', id_b));
  perform pg_temp.ok('E5 ...a list style', pg_temp.refused(j, 'shop.not_owned')
    and (j ->> 'detail')::jsonb -> 'columns' = '["list_name_style_id"]'::jsonb, j::text);
  j := pg_temp.run_as('EB', format('update public.profiles set profile_name_style_id = %L where id = %L', 'eq-test-profile', id_b));
  perform pg_temp.ok('E5 ...a profile style', pg_temp.refused(j, 'shop.not_owned')
    and (j ->> 'detail')::jsonb -> 'columns' = '["profile_name_style_id"]'::jsonb, j::text);
  j := pg_temp.run_as('EB', format('update public.profiles set profile_name_style_id = %L where id = %L', 'eq-test-list', id_b));
  perform pg_temp.ok('E5 ...a list style''s slug in the profile style slot', pg_temp.refused(j, 'shop.not_owned'), j::text);
  j := pg_temp.run_as('EB', format('update public.profiles set tagline = %L, name_color = %L where id = %L',
                                   'Free stuff', '#e0e0e1', id_b));
  perform pg_temp.ok('E5 bundled with a tagline: refused as a whole, the tagline isn''t saved either',
    pg_temp.refused(j, 'shop.not_owned') and pg_temp.row_of('EB') = before, j::text);
  perform pg_temp.ok('E5 none of those attempts changed anything', pg_temp.row_of('EB') = before, null);

  -- The owner: the avatar pair is checked together.
  j := pg_temp.run_as('EA', format('update public.profiles set avatar_emoji = %L, avatar_bg_color = %L where id = %L',
                                   'eqfox', '#202020', pg_temp.p('EA')));
  perform pg_temp.ok('E5 the owner can''t mix two owned avatars'' emoji and color', pg_temp.refused(j, 'shop.not_owned'), j::text);
  j := pg_temp.run_as('EA', format('update public.profiles set avatar_emoji = null, avatar_bg_color = %L where id = %L',
                                   '#202020', pg_temp.p('EA')));
  perform pg_temp.ok('E5 ...or keep an avatar''s color without its emoji', pg_temp.refused(j, 'shop.not_owned'), j::text);

  -- Server-owned columns still go first (the body of the column guard).
  j := pg_temp.run_as('EB', format('update public.profiles set pickles = 999999, name_color = %L where id = %L', '#e0e0e1', id_b));
  perform pg_temp.ok('E5 pickles in the same PATCH: still pl:profile.server_owned',
    pg_temp.refused(j, 'profile.server_owned') and pg_temp.row_of('EB') = before, j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('E5 block crashed', false, sqlerrm);
end $$;


-- ════ E6 what direct writes may still do (older builds) ══════════════════
do $$
declare
  j    jsonb;
  id_a uuid := pg_temp.p('EA');
  id_b uuid := pg_temp.p('EB');
begin
  j := pg_temp.run_as('EA', format('update public.profiles set avatar_emoji = %L, avatar_bg_color = %L, list_name_style_id = %L where id = %L',
                                   'eqfox', '#101010', 'eq-test-list', id_a));
  perform pg_temp.ok('E6 the owner''s direct write of owned items still saves (1.0.x Equip)',
    j ->> 'rows' = '1' and pg_temp.cos('EA') ->> 'avatar_emoji' = 'eqfox' and pg_temp.cos('EA') ->> 'list_name_style_id' = 'eq-test-list', j::text);

  -- A hidden purchase is still the owner's (and visible to them).
  update public.player_shop_purchases set is_hidden = true where user_id = id_a and shop_item_id = pg_temp.it('FL');
  perform pg_temp.run_as('EA', format('update public.profiles set name_color = null where id = %L', id_a));
  j := pg_temp.run_as('EA', format('update public.profiles set name_color = %L where id = %L', '#e0e0e1', id_a));
  perform pg_temp.ok('E6 ...a hidden purchase included', j ->> 'rows' = '1' and pg_temp.cos('EA') ->> 'name_color' = '#e0e0e1', j::text);

  j := pg_temp.run_as('EA', format($q$update public.profiles set avatar_emoji = null, avatar_bg_color = null, name_color = null,
                                       list_name_style_id = null, profile_name_style_id = null where id = %L$q$, id_a));
  perform pg_temp.ok('E6 resetting every cosmetic to null directly is allowed',
    j ->> 'rows' = '1' and pg_temp.cos('EA') = jsonb_build_object('avatar_emoji', null, 'avatar_bg_color', null, 'name_color', null,
                                                                   'list_name_style_id', null, 'profile_name_style_id', null), j::text);

  -- A value the player doesn't own, already on the row (set before this file,
  -- or by an admin), is sent back unchanged with an edit: it still saves.
  update public.profiles set name_color = '#abcdef', avatar_emoji = 'legacy', avatar_bg_color = '#000000' where id = id_b;
  j := pg_temp.run_as('EB', format($q$update public.profiles set tagline = 'Kept mine', name_color = name_color,
                                       avatar_emoji = avatar_emoji, avatar_bg_color = avatar_bg_color where id = %L$q$, id_b));
  perform pg_temp.ok('E6 cosmetics sent back unchanged with an edit (Edit profile''s old save) don''t block it',
    j ->> 'rows' = '1' and (select tagline from public.profiles where id = id_b) = 'Kept mine'
    and pg_temp.cos('EB') ->> 'name_color' = '#abcdef', j::text);
  j := pg_temp.run_as('EB', format('update public.profiles set name_color = null, avatar_emoji = null, avatar_bg_color = null where id = %L', id_b));
  perform pg_temp.ok('E6 ...and the player can clear them', j ->> 'rows' = '1'
    and pg_temp.cos('EB') ->> 'name_color' is null and pg_temp.cos('EB') ->> 'avatar_emoji' is null, j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('E6 block crashed', false, sqlerrm);
end $$;


-- ════ E7 the rest of the profile is still the player's to edit ═══════════
do $$
declare
  j jsonb;
  r public.profiles;
begin
  j := pg_temp.run_as('EB', format($q$
    update public.profiles
       set full_name = 'Equip Renamed', username = 'equip_renamed', tagline = 'Still mine', gender = 'female',
           selected_tags = array['lefty'], avatar_id = 7, avatar_url = 'https://example.test/e.png', badges_public = false,
           availability = array_fill(true, array[336]), drilling_enabled = true, drill_shot_prefs = array['dinks']
     where id = %L$q$, pg_temp.p('EB')));
  select * into r from public.profiles where id = pg_temp.p('EB');
  perform pg_temp.ok('E7 name, username, tagline, gender, tags, cartoon avatar, photo, badges toggle, availability, drilling all save',
    j ->> 'rows' = '1' and r.full_name = 'Equip Renamed' and r.username = 'equip_renamed' and r.tagline = 'Still mine'
    and r.gender = 'female' and r.selected_tags = array['lefty'] and r.avatar_id = 7 and r.avatar_url = 'https://example.test/e.png'
    and not r.badges_public and r.availability[336] and r.drilling_enabled and r.drill_shot_prefs = array['dinks'], j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('E7 block crashed', false, sqlerrm);
end $$;


-- ════ E8 a gift (gift_shop_item) ═════════════════════════════════════════
do $$
declare
  r      record;
  j      jsonb;
  before jsonb := pg_temp.cos('EC');
begin
  perform pg_temp.as_user(pg_temp.p('EA'));
  select * into r from public.gift_shop_item(pg_temp.it('AV1'), pg_temp.p('EC'), 'Enjoy');
  perform pg_temp.as_admin();
  perform pg_temp.ok('E8 the owner gifts an avatar',
    r.success and exists (select 1 from public.player_shop_purchases where user_id = pg_temp.p('EC') and shop_item_id = pg_temp.it('AV1')),
    r.message);
  perform pg_temp.ok('E8 ...which doesn''t equip it on the recipient', pg_temp.cos('EC') = before, pg_temp.cos('EC')::text);

  j := pg_temp.equip('EC', 'AV1');
  perform pg_temp.ok('E8 the recipient can equip the gift', j ? 'v' and pg_temp.cos('EC') ->> 'avatar_emoji' = 'eqfox', j::text);
  j := pg_temp.equip('EC', 'AV2');
  perform pg_temp.ok('E8 ...but not an avatar nobody gave them', pg_temp.refused(j, 'shop.not_owned')
    and pg_temp.cos('EC') ->> 'avatar_emoji' = 'eqfox', j::text);
  j := pg_temp.run_as('EC', format('update public.profiles set list_name_style_id = %L where id = %L', 'eq-test-list', pg_temp.p('EC')));
  perform pg_temp.ok('E8 ...nor write the giver''s list style directly', pg_temp.refused(j, 'shop.not_owned'), j::text);
  j := pg_temp.unequip('EC', 'avatar');
  perform pg_temp.ok('E8 the recipient can take the gift off again', pg_temp.cos('EC') ->> 'avatar_emoji' is null, j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('E8 block crashed', false, sqlerrm);
end $$;


-- ════ E9 the other refusals ══════════════════════════════════════════════
do $$
declare j jsonb;
begin
  j := pg_temp.equip('EA', 'BD');
  perform pg_temp.ok('E9 an owned decorative badge isn''t equipped (pl:shop.not_equippable, names it)',
    pg_temp.refused(j, 'shop.not_equippable') and (j ->> 'detail')::jsonb ->> 'item' = 'Eq Test Badge', j::text);
  j := pg_temp.eval_as('EA', format('select public.equip_shop_item(%L::uuid)', gen_random_uuid()));
  perform pg_temp.ok('E9 an item that isn''t in the Shop (pl:shop.item_gone)', pg_temp.refused(j, 'shop.item_gone'), j::text);
  j := pg_temp.eval_as('EA', 'select public.equip_shop_item(null)');
  perform pg_temp.ok('E9 no item id (pl:request.bad)', pg_temp.refused(j, 'request.bad'), j::text);
  j := pg_temp.unequip('EA', 'hat');
  perform pg_temp.ok('E9 unequip something that isn''t a cosmetic slot (pl:request.bad)', pg_temp.refused(j, 'request.bad'), j::text);
  j := pg_temp.unequip('EA', null);
  perform pg_temp.ok('E9 ...or nothing (pl:request.bad)', pg_temp.refused(j, 'request.bad'), j::text);

  -- Signed in as a role but no user (an expired session's claims).
  perform set_config('request.jwt.claims', '{"role": "authenticated"}', true);
  perform set_config('role', 'authenticated', true);
  j := pg_temp.eval(format('select public.equip_shop_item(%L::uuid)', pg_temp.it('AV1')));
  perform pg_temp.as_admin();
  perform pg_temp.ok('E9 no user (pl:auth.signed_out)', pg_temp.refused(j, 'auth.signed_out'), j::text);
  perform set_config('request.jwt.claims', '{"role": "authenticated"}', true);
  perform set_config('role', 'authenticated', true);
  j := pg_temp.eval('select public.unequip_cosmetic(''avatar'')');
  perform pg_temp.as_admin();
  perform pg_temp.ok('E9 ...unequip too', pg_temp.refused(j, 'auth.signed_out'), j::text);

  perform pg_temp.as_anon();
  j := pg_temp.eval(format('select public.equip_shop_item(%L::uuid)', pg_temp.it('AV1')));
  perform pg_temp.as_admin();
  perform pg_temp.ok('E9 anon can''t call it at all (permission denied)', j ->> 'state' = '42501', j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('E9 block crashed', false, sqlerrm);
end $$;


-- ════ E10 free items ═════════════════════════════════════════════════════
do $$
declare j jsonb;
begin
  j := pg_temp.equip('EB', 'FREE');
  perform pg_temp.ok('E10 a free Shop item (active, cost 0, no badge) is equippable without a purchase',
    j ? 'v' and pg_temp.cos('EB') ->> 'list_name_style_id' = 'eq-test-free', j::text);
  perform pg_temp.unequip('EB', 'list_name_style');
  j := pg_temp.run_as('EB', format('update public.profiles set list_name_style_id = %L where id = %L', 'eq-test-free', pg_temp.p('EB')));
  perform pg_temp.ok('E10 ...directly too', j ->> 'rows' = '1' and pg_temp.cos('EB') ->> 'list_name_style_id' = 'eq-test-free', j::text);
  j := pg_temp.equip('EB', 'FREE_OFF');
  perform pg_temp.ok('E10 a free item that left the Shop isn''t (nobody owns it)', pg_temp.refused(j, 'shop.not_owned'), j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('E10 block crashed', false, sqlerrm);
end $$;


-- ════ E11 server paths write freely ══════════════════════════════════════
do $$
declare j jsonb;
begin
  perform pg_temp.as_service();
  j := pg_temp.run(format('update public.profiles set avatar_emoji = %L, avatar_bg_color = %L where id = %L',
                          'svc', '#123123', pg_temp.p('EB')));
  perform pg_temp.as_admin();
  perform pg_temp.ok('E11 service_role (godmode-create-user, scripts) sets any avatar',
    j ->> 'rows' = '1' and pg_temp.cos('EB') ->> 'avatar_emoji' = 'svc', j::text);
  j := pg_temp.run(format('update public.profiles set name_color = %L where id = %L', '#321321', pg_temp.p('EB')));
  perform pg_temp.ok('E11 ...and so does the owner (migrations, SQL editor, definer functions)',
    j ->> 'rows' = '1' and pg_temp.cos('EB') ->> 'name_color' = '#321321', j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('E11 block crashed', false, sqlerrm);
end $$;


-- ════ E12 badge-gated Shop items: earned, never gifted ═══════════════════
do $$
declare
  r      record;
  j      jsonb;
  v_gate uuid := (select unlock_badge_id from public.shop_items where id = pg_temp.it('GATE'));
begin
  if v_gate is null then
    perform pg_temp.ok('E12 skipped (no badges on this database)', true, null);
    return;
  end if;

  perform pg_temp.as_user(pg_temp.p('EA'));
  select * into r from public.gift_shop_item(pg_temp.it('GATE'), pg_temp.p('EC'), null);
  perform pg_temp.as_admin();
  perform pg_temp.ok('E12 a badge-gated item can''t be gifted (it costs 0): says why, no purchase row',
    not r.success and r.message like '%can''t be gifted%'
    and not exists (select 1 from public.player_shop_purchases where user_id = pg_temp.p('EC') and shop_item_id = pg_temp.it('GATE')),
    r.message);

  -- A gift of one made before this file: the row alone doesn't unlock it.
  insert into public.player_shop_purchases (user_id, shop_item_id, cost_paid, gifted_by_user_id)
  values (pg_temp.p('EC'), pg_temp.it('GATE'), 0, pg_temp.p('EA'));
  j := pg_temp.equip('EC', 'GATE');
  perform pg_temp.ok('E12 an old gifted row of a gated item doesn''t equip it (RPC)', pg_temp.refused(j, 'shop.not_owned'), j::text);
  j := pg_temp.run_as('EC', format('update public.profiles set profile_name_style_id = %L where id = %L', 'eq-test-gated', pg_temp.p('EC')));
  perform pg_temp.ok('E12 ...nor directly', pg_temp.refused(j, 'shop.not_owned'), j::text);

  -- Earning the badge does (trg_grant_unlock_items_on_badge adds the row too).
  insert into public.player_badges (user_id, badge_id) values (pg_temp.p('EB'), v_gate) on conflict do nothing;
  j := pg_temp.equip('EB', 'GATE');
  perform pg_temp.ok('E12 a player who earned the badge equips it',
    j ? 'v' and pg_temp.cos('EB') ->> 'profile_name_style_id' = 'eq-test-gated', j::text);
  perform pg_temp.unequip('EB', 'profile_name_style');
  j := pg_temp.run_as('EB', format('update public.profiles set profile_name_style_id = %L where id = %L', 'eq-test-gated', pg_temp.p('EB')));
  perform pg_temp.ok('E12 ...directly too', j ->> 'rows' = '1', j::text);

  -- Badge held but no purchase row ("Earned · pending grant" in the Shop).
  insert into public.player_badges (user_id, badge_id) values (pg_temp.p('EC'), v_gate) on conflict do nothing;
  delete from public.player_shop_purchases where user_id = pg_temp.p('EC') and shop_item_id = pg_temp.it('GATE');
  j := pg_temp.equip('EC', 'GATE');
  perform pg_temp.ok('E12 the badge without a purchase row is enough', j ? 'v', j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('E12 block crashed', false, sqlerrm);
end $$;


-- ════ E13 badge cosmetics: unlockable avatars, badge tags, tag slots ═════
do $$
declare
  j     jsonb;
  id_b  uuid := pg_temp.p('EB');
  v_hot uuid := (select id from public.badges where name = 'Hot Streak');
  v_vet uuid := (select id from public.badges where name = 'Veteran');
begin
  if v_hot is null or v_vet is null then
    perform pg_temp.ok('E13 skipped (no Hot Streak / Veteran badge on this database)', true, null);
    return;
  end if;
  delete from public.player_badges pb using public.badges b
   where pb.badge_id = b.id and pb.user_id = id_b and b.name in ('Hot Streak', 'Veteran', 'Top Rated');
  update public.profiles set avatar_id = 1, selected_tags = '{}' where id = id_b;

  j := pg_temp.run_as('EB', format('update public.profiles set avatar_id = 18 where id = %L', id_b));
  perform pg_temp.ok('E13 the Inferno avatar without Hot Streak is refused (pl:profile.locked names the badge)',
    pg_temp.refused(j, 'profile.locked') and (j ->> 'detail')::jsonb -> 'columns' = '["avatar_id"]'::jsonb
    and (j ->> 'detail')::jsonb -> 'badges' = '["Hot Streak"]'::jsonb and j ->> 'msg' like '%Hot Streak%', j::text);
  j := pg_temp.run_as('EB', format($q$update public.profiles set selected_tags = array['dink-master', 'hot-streak-slayer'] where id = %L$q$, id_b));
  perform pg_temp.ok('E13 ...and so is the Hot Streak Slayer tag',
    pg_temp.refused(j, 'profile.locked') and (j ->> 'detail')::jsonb -> 'columns' = '["selected_tags"]'::jsonb, j::text);
  j := pg_temp.run_as('EB', format($q$update public.profiles set selected_tags = array['dink-master', 'poacher', 'the-grinder', 'net-rusher'] where id = %L$q$, id_b));
  perform pg_temp.ok('E13 four tags with three slots: pl:profile.too_many_tags (max 3)',
    pg_temp.refused(j, 'profile.too_many_tags') and ((j ->> 'detail')::jsonb ->> 'max_tags')::int = 3, j::text);
  j := pg_temp.run_as('EB', format($q$update public.profiles set avatar_id = 4, selected_tags = array['dink-master', 'poacher', 'the-grinder'] where id = %L$q$, id_b));
  perform pg_temp.ok('E13 a free avatar and three free tags save', j ->> 'rows' = '1', j::text);

  insert into public.player_badges (user_id, badge_id) values (id_b, v_hot) on conflict do nothing;
  insert into public.player_badges (user_id, badge_id) values (id_b, v_vet) on conflict do nothing;
  j := pg_temp.run_as('EB', format($q$update public.profiles set avatar_id = 18,
      selected_tags = array['dink-master', 'poacher', 'the-grinder', 'hot-streak-slayer'] where id = %L$q$, id_b));
  perform pg_temp.ok('E13 with Hot Streak and Veteran: Inferno, the Slayer tag and a fourth slot all save',
    j ->> 'rows' = '1' and (select avatar_id from public.profiles where id = id_b) = 18, j::text);

  -- A badge taken back later: what's already on the profile stays.
  delete from public.player_badges where user_id = id_b and badge_id in (v_hot, v_vet);
  j := pg_temp.run_as('EB', format($q$update public.profiles set tagline = 'Kept', avatar_id = 18,
      selected_tags = array['dink-master', 'poacher', 'hot-streak-slayer'] where id = %L$q$, id_b));
  perform pg_temp.ok('E13 after losing the badges: keeping Inferno and the tag while removing one saves',
    j ->> 'rows' = '1', j::text);
  j := pg_temp.run_as('EB', format($q$update public.profiles set
      selected_tags = array['dink-master', 'poacher', 'hot-streak-slayer', 'the-grinder'] where id = %L$q$, id_b));
  perform pg_temp.ok('E13 ...but growing back past three slots is refused', pg_temp.refused(j, 'profile.too_many_tags'), j::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('E13 block crashed', false, sqlerrm);
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
