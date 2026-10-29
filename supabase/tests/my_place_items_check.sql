-- ============================================================
-- My Place catalog check (migration_my_place_items.sql).
--
-- NOT runnable on its own: build-my-place-items-test.mjs puts
-- migration_my_place_items.sql at the @@ITEMS@@ line below and again (it must
-- be re-runnable) at @@ITEMS_RERUN@@, and the catalog's expected items at
-- @@EXPECT@@. Everything runs inside the begin / rollback below, so the linked
-- (live) database is left untouched:
--   node supabase/tests/build-my-place-items-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary.
--
-- Needs migration_my_place.sql live. One temporary account (IA) is created
-- inside the transaction to claim the starter set.
-- ============================================================

begin;

create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);
create temp table _expect (id text primary key, slot_group text not null, is_starter boolean not null);
create temp table _before as
  select (select layout from public.room_layout where id = 'default') as layout,
         (select count(*) from public.home_items where id like 'ph\_%') as ph_count;

create function pg_temp.ok(p_test text, p_ok boolean, p_detail text default null) returns void
language sql as $$ insert into _results (test, ok, detail) values (p_test, coalesce(p_ok, false), p_detail) $$;

-- @@EXPECT@@

-- @@ITEMS@@

-- ════ I1 to I8: the catalog after one apply ══════════════════════════════
do $$
declare
  v_txt text;
  v_n   integer;
begin
  select string_agg(e.id, ', ' order by e.id) into v_txt
    from _expect e left join public.home_items i on i.id = e.id
   where i.id is null or i.slot_group <> e.slot_group;
  perform pg_temp.ok('I1 every real item is in home_items with its slot group', v_txt is null,
    coalesce('missing or wrong group: ' || v_txt, (select count(*) from _expect) || ' items'));

  select string_agg(e.id, ', ' order by e.id) into v_txt
    from _expect e left join public.home_item_art a on a.item_id = e.id
   where a.item_id is null or btrim(a.art_svg) = '';
  perform pg_temp.ok('I2 every real item has art', v_txt is null, coalesce('no art: ' || v_txt, 'all have art'));

  -- The avatar slot has no items by design (the app draws the player).
  select string_agg(s.id, ', ' order by s.sort) into v_txt
    from public.home_slots s
   where s.kind <> 'avatar'
     and not exists (select 1 from public.home_items i
                      where i.slot_group = s.fits
                        and (i.available_from is null or i.available_from <= now())
                        and (i.available_until is null or i.available_until > now()));
  perform pg_temp.ok('I3 every slot but the avatar has at least one item on sale', v_txt is null,
    coalesce('nothing on sale for: ' || v_txt, (select count(*) from public.home_slots where kind <> 'avatar') || ' slots covered'));

  select string_agg(coalesce(e.id, i.id), ', ' order by coalesce(e.id, i.id)) into v_txt
    from (select id from _expect where is_starter) e
    full join (select id from public.home_items where is_starter) i on i.id = e.id
   where e.id is null or i.id is null;
  perform pg_temp.ok('I4 the starters are exactly the catalog''s', v_txt is null,
    coalesce('differs: ' || v_txt, (select string_agg(id, ', ' order by id) from public.home_items where is_starter)));

  select count(*) into v_n from public.home_items
   where id like 'ph\_%' and (is_starter or available_until is null or available_until > now());
  perform pg_temp.ok('I5 the ph_ placeholders are retired, none deleted',
    v_n = 0 and (select count(*) from public.home_items where id like 'ph\_%') = (select ph_count from _before),
    v_n || ' still on sale; ' || (select count(*) from public.home_items where id like 'ph\_%') || ' of ' || (select ph_count from _before) || ' kept');

  select string_agg(a.item_id, ', ' order by a.item_id) into v_txt
    from public.home_item_art a join _expect e on e.id = a.item_id
   where a.art_svg !~ '^<svg\M'
      or a.art_svg !~ '</svg>$'
      or a.art_svg ~* '<script'
      or a.art_svg ~* '\son[a-z]+\s*='
      or a.art_svg ~* '(href|src)\s*=\s*"(https?:|data:|javascript:)'
      or a.art_svg ~* '<(image|foreignObject)\M'
      or a.art_svg !~ 'viewBox="0 0 100 [0-9.]+"'
      or length(a.art_svg) > 100000;
  perform pg_temp.ok('I6 every art string is a plain <svg> (no script, handlers, links, images; viewBox 100 wide; under 100 KB)',
    v_txt is null, coalesce('bad: ' || v_txt, 'all pass'));

  select string_agg(i.id || ' ' || i.art_aspect, ', ' order by i.id) into v_txt
    from public.home_items i join _expect e on e.id = i.id join public.home_item_art a on a.item_id = i.id
   where i.art_aspect is null
      or abs(i.art_aspect - 100 / (substring(a.art_svg from 'viewBox="0 0 100 ([0-9.]+)"'))::numeric) > 0.01;
  perform pg_temp.ok('I7 art_aspect matches each SVG''s viewBox', v_txt is null, coalesce('off: ' || v_txt, 'all match'));

  perform pg_temp.ok('I8 the default layout passes the server''s shape check',
    public._pl_room_layout_problem((select layout from public.room_layout where id = 'default')) is null,
    public._pl_room_layout_problem((select layout from public.room_layout where id = 'default'))::text);

  if coalesce((select layout -> 'placements' from _before), '{}'::jsonb) = '{}'::jsonb then
    perform pg_temp.ok('I8 ...an empty layout got the catalog''s placements (every boxed slot)',
      (select count(*) from public.home_slots s where s.kind <> 'backdrop'
          and (select layout from public.room_layout where id = 'default') -> 'placements' ? s.id)
      = (select count(*) from public.home_slots where kind <> 'backdrop'),
      (select layout from public.room_layout where id = 'default')::text);
  else
    perform pg_temp.ok('I8 ...a saved layout was kept as it was',
      (select layout from public.room_layout where id = 'default') = (select layout from _before),
      'the live layout already had placements');
  end if;
exception when others then
  perform pg_temp.ok('I1-I8 block crashed', false, sqlerrm);
end $$;

-- ════ I9: a new player's starter claim ═══════════════════════════════════
do $$
declare
  v_me uuid := 'a8310000-0000-4000-8000-000000000001';
  j    jsonb;
  v_txt text;
begin
  insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
  values (v_me, 'myplace-items-ia@pickleague.test', jsonb_build_object('full_name', 'Items IA Player'), now());

  perform set_config('request.jwt.claims', json_build_object('sub', v_me, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  j := public.claim_my_place_starter();
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);

  select string_agg(e.id, ', ' order by e.id) into v_txt
    from _expect e
   where e.is_starter
     and not exists (select 1 from public.home_equipped q
                       join public.home_slots s on s.id = q.slot_id
                      where q.owner_id = v_me and q.item_id = e.id and s.fits = e.slot_group);
  perform pg_temp.ok('I9 a new player''s claim equips every starter in its slot, no placeholders',
    (j ->> 'claimed')::boolean and v_txt is null
      and not exists (select 1 from public.home_owned_items o where o.owner_id = v_me and o.item_id like 'ph\_%'),
    coalesce('not equipped: ' || v_txt || '; ', '') || (j -> 'equipped')::text);
exception when others then
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  perform pg_temp.ok('I9 block crashed', false, sqlerrm);
end $$;

-- ════ Admin edits the re-run must keep ═══════════════════════════════════
-- (now() is fixed inside one transaction, so the edits use past times the
-- re-run would visibly overwrite.)
update public.room_layout
   set layout = jsonb_set(layout, '{placements,couch,cx}', '0.47'::jsonb), updated_at = now()
 where id = 'default';
update public.home_items set available_until = now() - interval '1 day'
 where id = (select id from _expect where not is_starter order by id limit 1);
update public.home_items set available_until = now() - interval '1 day', is_starter = false
 where id = (select id from _expect where is_starter order by id limit 1);
update public.home_items set available_until = now() - interval '2 days' where id like 'ph\_%';
update public.home_item_art set updated_at = '2000-01-01T00:00:00Z' where item_id in (select id from _expect);

-- @@ITEMS_RERUN@@

do $$
declare
  v_retired text := (select id from _expect where not is_starter order by id limit 1);
  v_starter text := (select id from _expect where is_starter order by id limit 1);
begin
  perform pg_temp.ok('I10 a re-run keeps an admin-saved layout',
    ((select layout from public.room_layout where id = 'default') #>> '{placements,couch,cx}')::numeric = 0.47,
    (select layout from public.room_layout where id = 'default') #>> '{placements,couch}');
  perform pg_temp.ok('I10 ...keeps a real item the admin retired retired (' || v_retired || ')',
    (select available_until from public.home_items where id = v_retired) = now() - interval '1 day', null);
  perform pg_temp.ok('I10 ...never turns a retired starter back into a starter (' || v_starter || ')',
    (select not is_starter and available_until = now() - interval '1 day' from public.home_items where id = v_starter), null);
  perform pg_temp.ok('I10 ...keeps the placeholders'' first retire time',
    not exists (select 1 from public.home_items where id like 'ph\_%'
                 and (available_until is distinct from now() - interval '2 days' or is_starter)), null);
  perform pg_temp.ok('I10 ...rewrites no unchanged art',
    not exists (select 1 from public.home_item_art where item_id in (select id from _expect)
                 and updated_at <> '2000-01-01T00:00:00Z'), null);
exception when others then
  perform pg_temp.ok('I10 block crashed', false, sqlerrm);
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
