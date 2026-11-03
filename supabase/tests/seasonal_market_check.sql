-- ============================================================
-- My Place seasonal market check (migration_seasonal_market_2026_11_12.sql).
--
-- NOT runnable on its own: build-seasonal-market-test.mjs puts the market
-- migration at the @@MARKET@@ line below and again (it must be re-runnable)
-- at @@MARKET_RERUN@@, and the catalogs' expected items at @@EXPECT@@.
-- Everything runs inside the begin / rollback below, so the linked (live)
-- database is left untouched:
--   node supabase/tests/build-seasonal-market-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary.
--
-- Needs migration_my_place.sql and migration_court_pass_tables.sql live. Two
-- temporary accounts are created inside the transaction: SA (20,000 pickles)
-- buys, SP (100 pickles) can't afford anything.
--
-- The "now" checks assume it is still the Harvest Market (November 3 to
-- December 1, 2026, Pacific): the Harvest items are on sale and the Winter
-- items are not yet. Run after December 1 and S5 / S8 say so.
-- ============================================================

begin;
set local lock_timeout = '10s';

create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);
create temp table _expect (
  id text primary key, drop_title text not null, slot_group text not null, cost integer not null,
  rarity text not null, season text not null, available_from timestamptz, available_until timestamptz not null);
create temp table _ids (k text primary key, id uuid not null);
insert into _ids values ('SA', 'a8320000-0000-4000-8000-000000000001'), ('SP', 'a8320000-0000-4000-8000-000000000002');

create function pg_temp.ok(p_test text, p_ok boolean, p_detail text default null) returns void
language sql as $$ insert into _results (test, ok, detail) values (p_test, coalesce(p_ok, false), p_detail) $$;

-- The Court Pass items before (they must come out exactly the same).
create temp table _cp_before as
  select coalesce(md5(string_agg(row(h.*)::text, '|' order by h.id)), '') as sig, count(*) as n
    from public.home_items h where h.track_only;

-- @@EXPECT@@

-- @@MARKET@@

-- ════ S1 to S4: the catalog after one apply ══════════════════════════════
do $$
declare
  v_txt text;
begin
  select string_agg(e.id, ', ' order by e.id) into v_txt
    from _expect e left join public.home_items i on i.id = e.id
   where i.id is null or i.slot_group <> e.slot_group or i.cost <> e.cost or i.rarity <> e.rarity
      or i.season is distinct from e.season;
  perform pg_temp.ok('S1 every market item is in home_items with its slot group, price, rarity and season', v_txt is null,
    coalesce('missing or different: ' || v_txt, (select count(*) from _expect) || ' items'));

  select string_agg(e.id, ', ' order by e.id) into v_txt
    from _expect e join public.home_items i on i.id = e.id
   where i.available_from is distinct from e.available_from or i.available_until is distinct from e.available_until
      or (i.available_until at time zone 'America/Los_Angeles')::time <> '00:00'
      or (i.available_from is not null and (i.available_from at time zone 'America/Los_Angeles')::time <> '00:00');
  perform pg_temp.ok('S2 each drop''s window is the catalog''s, on Pacific midnights', v_txt is null,
    coalesce('off: ' || v_txt, (select string_agg(distinct e.drop_title || ' ' || coalesce(to_char(e.available_from at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || 'Z', 'now')
                                  || ' to ' || to_char(e.available_until at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || 'Z', '; ') from _expect e)));

  select string_agg(i.id, ', ' order by i.id) into v_txt
    from public.home_items i join _expect e on e.id = i.id
   where i.track_only or i.is_starter or i.cost <= 0;
  perform pg_temp.ok('S3 every market item is sold: not track_only, not a starter, a price above 0', v_txt is null,
    coalesce('wrong: ' || v_txt, 'all sold for pickles'));

  select string_agg(e.id, ', ' order by e.id) into v_txt
    from _expect e left join public.home_item_art a on a.item_id = e.id
   where a.item_id is null or btrim(a.art_svg) = ''
      or a.art_svg !~ '^<svg\M' or a.art_svg !~ '</svg>$'
      or a.art_svg ~* '<script' or a.art_svg ~* '\son[a-z]+\s*='
      or a.art_svg ~* '(href|src)\s*=\s*"(https?:|data:|javascript:)'
      or a.art_svg ~* '<(image|foreignObject)\M'
      or a.art_svg !~ 'viewBox="0 0 100 [0-9.]+"'
      or length(a.art_svg) > 100000;
  perform pg_temp.ok('S4 every market item has plain <svg> art (no script, handlers, links, images; viewBox 100 wide)', v_txt is null,
    coalesce('bad or missing: ' || v_txt, 'all have art'));

  select string_agg(i.id || ' ' || i.art_aspect, ', ' order by i.id) into v_txt
    from public.home_items i join _expect e on e.id = i.id join public.home_item_art a on a.item_id = i.id
   where i.art_aspect is null
      or abs(i.art_aspect - 100 / (substring(a.art_svg from 'viewBox="0 0 100 ([0-9.]+)"'))::numeric) > 0.01;
  perform pg_temp.ok('S4 ...and art_aspect matches each SVG''s viewBox', v_txt is null, coalesce('off: ' || v_txt, 'all match'));

  perform pg_temp.ok('S4 ...and the Court Pass items are untouched',
    (select sig from _cp_before) = (select coalesce(md5(string_agg(row(h.*)::text, '|' order by h.id)), '') from public.home_items h where h.track_only),
    (select n from _cp_before) || ' track_only items before');
exception when others then
  perform pg_temp.ok('S1-S4 block crashed', false, sqlerrm);
end $$;

-- ════ S5: what is on sale today ══════════════════════════════════════════
do $$
declare
  v_on   integer;
  v_soon integer;
begin
  select count(*) into v_on from public.home_items i join _expect e on e.id = i.id
   where e.season = '2026-11' and (i.available_from is null or i.available_from <= now()) and i.available_until > now();
  select count(*) into v_soon from public.home_items i join _expect e on e.id = i.id
   where e.season = '2026-12' and i.available_from > now();
  perform pg_temp.ok('S5 the 6 Harvest Market items are on sale now; the 6 Winter Market items are not yet',
    v_on = 6 and v_soon = 6,
    v_on || ' Harvest on sale, ' || v_soon || ' Winter not yet (now ' || to_char(now() at time zone 'America/Los_Angeles', 'YYYY-MM-DD HH24:MI') || ' Pacific)');
exception when others then
  perform pg_temp.ok('S5 block crashed', false, sqlerrm);
end $$;

-- ════ S6 to S10: buying, as players ══════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
select id, 'market-' || lower(k) || '@pickleague.test', jsonb_build_object('full_name', 'Market ' || k || ' Player'), now() from _ids;
update public.profiles set pickles = 20000 where id = (select id from _ids where k = 'SA');
update public.profiles set pickles = 100 where id = (select id from _ids where k = 'SP');

do $$
declare
  v_me     uuid := (select id from _ids where k = 'SA');
  v_poor   uuid := (select id from _ids where k = 'SP');
  v_sofa   text := 'sm2611_couch_quilt';
  v_nov    text[] := (select array_agg(id order by id) from _expect where season = '2026-11' and id <> 'sm2611_couch_quilt');
  v_dec    text := (select id from _expect where season = '2026-12' order by cost desc, id limit 1);
  v_id     text;
  j        jsonb;
  v_bought integer := 0;
  v_fail   text;
  v_bal0   integer;
  v_bal1   integer;
  v_msg    text;
  v_hint   text;
  v_det    text;
  v_pmsg   text;
  v_phint  text;
  v_eq     jsonb;
  v_eqerr  text;
begin
  select pickles into v_bal0 from public.profiles where id = v_me;

  -- SA buys the showpiece, then the rest of the Harvest Market.
  perform set_config('request.jwt.claims', json_build_object('sub', v_me, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  j := public.buy_home_item(v_sofa);
  foreach v_id in array v_nov loop
    begin
      perform public.buy_home_item(v_id);
      v_bought := v_bought + 1;
    exception when others then
      v_fail := coalesce(v_fail || '; ', '') || v_id || ': ' || sqlerrm;
    end;
  end loop;
  -- ...tries a Winter Market item early...
  begin
    perform public.buy_home_item(v_dec);
  exception when others then
    get stacked diagnostics v_msg = message_text, v_hint = pg_exception_hint, v_det = pg_exception_detail;
  end;
  -- ...and puts the sofa in the couch slot.
  begin
    v_eq := public.equip_home_item('couch', v_sofa);
  exception when others then
    v_eqerr := sqlerrm;
  end;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);

  -- SP can't afford the sofa.
  perform set_config('request.jwt.claims', json_build_object('sub', v_poor, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  begin
    perform public.buy_home_item(v_sofa);
  exception when others then
    get stacked diagnostics v_pmsg = message_text, v_phint = pg_exception_hint;
  end;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);

  select pickles into v_bal1 from public.profiles where id = v_me;

  perform pg_temp.ok('S6 a Harvest Market item can be bought now (the 3,500-pickle sofa)',
    j ->> 'item_id' = v_sofa and (j ->> 'cost')::integer = 3500 and not (j ->> 'already_owned')::boolean
      and exists (select 1 from public.home_owned_items o where o.owner_id = v_me and o.item_id = v_sofa and o.source = 'buy' and o.cost_paid = 3500),
    j::text);
  perform pg_temp.ok('S7 ...and so can the other 5 Harvest Market items',
    v_bought = 5, coalesce(v_fail, v_bought || ' bought'));
  perform pg_temp.ok('S7 ...each charged its price, once',
    v_bal0 - v_bal1 = (select sum(cost) from _expect where season = '2026-11'),
    v_bal0 || ' -> ' || v_bal1 || ' (expected -' || (select sum(cost) from _expect where season = '2026-11') || ')');
  if to_regclass('public.pickle_ledger') is not null then
    perform pg_temp.ok('S7 ...and the pickle history reads "My Place: <item>"',
      exists (select 1 from public.pickle_ledger l where l.profile_id = v_me and l.delta = -3500 and l.reason = 'My Place: Harvest Quilt Sofa'),
      (select string_agg(l.reason || ' ' || l.delta, '; ') from public.pickle_ledger l where l.profile_id = v_me and l.delta < 0));
  end if;
  perform pg_temp.ok('S8 a Winter Market item is refused before Dec 1 (pl:home.not_yet), saying why and what to do',
    v_hint = 'pl:home.not_yet' and v_msg like '%isn''t on sale yet%' and v_msg like '%nothing was spent%' and v_msg like '%Check back%'
      and not exists (select 1 from public.home_owned_items o where o.owner_id = v_me and o.item_id = v_dec)
      and (v_det::jsonb ->> 'available_from')::timestamptz = (select available_from from _expect where id = v_dec),
    coalesce(v_hint, 'no refusal') || ': ' || coalesce(v_msg, '') || ' ' || coalesce(v_det, ''));
  perform pg_temp.ok('S9 the bought sofa goes in the couch slot',
    v_eqerr is null and exists (select 1 from public.home_equipped q where q.owner_id = v_me and q.slot_id = 'couch' and q.item_id = v_sofa),
    coalesce(v_eqerr, v_eq::text));
  perform pg_temp.ok('S10 a player short of pickles is refused (pl:home.not_enough) with how many more they need',
    v_phint = 'pl:home.not_enough' and v_pmsg like '%3,500 pickles%' and v_pmsg like '%Earn 3,400 more%'
      and not exists (select 1 from public.home_owned_items o where o.owner_id = v_poor),
    coalesce(v_phint, 'no refusal') || ': ' || coalesce(v_pmsg, ''));
exception when others then
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  perform pg_temp.ok('S6-S10 block crashed', false, sqlerrm);
end $$;

-- ════ Admin edits the re-run must keep ═══════════════════════════════════
-- (now() is fixed inside one transaction, so the edits use a past time the
-- re-run would visibly overwrite.)
update public.home_items set available_until = now() - interval '1 day' where id = 'sm2611_wall_falling_leaves';
update public.home_items set track_only = true, is_starter = true where id = 'sm2611_art_market_board';
update public.home_item_art set updated_at = '2000-01-01T00:00:00Z' where item_id in (select id from _expect);

-- @@MARKET_RERUN@@

do $$
begin
  perform pg_temp.ok('S11 a re-run keeps a drop the admin ended early ended',
    (select available_until from public.home_items where id = 'sm2611_wall_falling_leaves') = now() - interval '1 day', null);
  perform pg_temp.ok('S11 ...puts a market item back to sold (not track_only, not a starter)',
    (select not track_only and not is_starter from public.home_items where id = 'sm2611_art_market_board'), null);
  perform pg_temp.ok('S11 ...rewrites no unchanged art',
    not exists (select 1 from public.home_item_art where item_id in (select id from _expect) and updated_at <> '2000-01-01T00:00:00Z'), null);
  perform pg_temp.ok('S11 ...leaves what players bought alone',
    (select count(*) from public.home_owned_items o join _expect e on e.id = o.item_id
      where o.owner_id = (select id from _ids where k = 'SA')) = 6, null);
exception when others then
  perform pg_temp.ok('S11 block crashed', false, sqlerrm);
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
