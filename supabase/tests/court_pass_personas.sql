-- ============================================================
-- Court Pass (monthly reward track) persona tests:
-- migration_court_pass_tables.sql, migration_court_pass_xp.sql,
-- migration_court_pass_cycles_2026_11.sql,
-- migration_court_pass_cycles_2026_12_2027_01.sql, court_pass_catchup_2026_11.sql
-- (and the generated migration_court_pass_art_2026_11.sql /
-- migration_court_pass_art_2026_12.sql when they exist). Spec: docs/court-pass.md.
--
-- NOT runnable on its own: build-court-pass-test.mjs wraps it as
--   begin; set local check_function_bodies = off;
--   <this file up to -- @@MIGRATIONS@@>   harness, helpers, Q's November ledger rows
--   <the Court Pass files>                (none with --applied)
--   <this file up to -- @@RERUN@@>        seed and catch-up checks, test cycles, personas, every earn
--   <the Court Pass files> again, then migration_rls_hardening_2026q3.sql
--   <the rest of this file>               assertions, then the results
--   rollback;
-- Run (from the linked checkout):
--   node supabase/tests/build-court-pass-test.mjs [--applied] <out.sql>
--   supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the SUMMARY.
--
-- Real dates matter only for T0 (the seed) and T12 (the launch: Q's ledger
-- rows are dated in November 2026, so they count in the real '2026-11' pass,
-- through the catch-up when this transaction applies the files and through
-- the live trigger with --applied). Then the test moves every real cycle 500
-- years ahead (inside the transaction) and makes its own:
--   zq-old   now() - 40 days .. now() - 12 days, 10 pickles a tier (ended)
--   zq-now   now() - 10 days .. now() + 10 days, the 30-tier curve (tier 30 =
--            1,360), 10 pickles a free tier except tier 5 = Zq Track Lamp (a
--            My Place item), tier 6 = Zq Track Avatar (a Shop item) and tier
--            15 = Zq Track Rare (My Place, rare); premium rows at 5 (Zq Track
--            Crown, My Place) and 10 (Zq Premium Avatar, Shop): display only
--   zq-next  now() + 20 days .. now() + 50 days (next_starts_at, boundaries)
-- now() is fixed inside the transaction. Earns at other times are
-- pickle_ledger rows inserted by hand with a created_at (the trigger is
-- what's under test); the end-to-end earns are real matches and real
-- claim_daily_login_streak calls.
-- Personas: temporary accounts "Court <k> Player", emails @court-pass.example
-- (not @pickleague.test: _pl_mark_new_test_account marks those as test
-- accounts, and test accounts earn 0):
--   W   allowlisted earns; the RPC contract (T9)
--   M1, M2  a real singles match (T1)
--   X   excluded sources, gold and negative rows (T2)
--   T   a test account; U a guest (T2, T9)
--   L   logins, across a stored-zone flip (T3)
--   C   no daily cap: 320 pickleballs in one Pacific day (T4)
--   G   grinder: crosses tiers 1-6, replays, owns the lamp and the avatar (T5, T6)
--   S   XP with no grant rows: swept on the next open (T5)
--   O   an unpaid tier of an ended pass, paid during the next one (T5)
--   R   never earns: the refusals and RLS (T6, T10)
--   E   cycle edges (T7)
--   D   deletes the account (T11); K1, K2 a match while XP is broken (T11;
--       skipped when reward_track_xp_events is live: --applied, which sets
--       pickleague.cp_test_applied, or a re-run after the tables file
--       committed; its ALTER TABLE would lock the live table until the rollback)
--   Q   the launch (T12): ledger rows written before the Court Pass files,
--       dated around the Nov 1 07:00Z start: counted by the catch-up, 325
--       pickleballs in one Pacific day, a November item paid on an open
-- ============================================================

-- pg_temp helpers are called as authenticated / anon; since
-- migration_anon_audit_rest.sql postgres-created functions aren't
-- PUBLIC-executable by default (rolled back below). Every Court Pass function
-- revokes its own grants explicitly, so this doesn't hide a missing revoke.
alter default privileges for role postgres grant execute on functions to public;

-- ════ Harness ════════════════════════════════════════════════════════════
create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);
grant select, insert on _results to authenticated, anon;
grant usage on sequence _results_n_seq to authenticated, anon;

create temp table _p (k text primary key, id uuid not null);
insert into _p values
  ('W',  'c0a55000-0000-4000-8000-000000000001'), ('M1', 'c0a55000-0000-4000-8000-000000000002'),
  ('M2', 'c0a55000-0000-4000-8000-000000000003'), ('X',  'c0a55000-0000-4000-8000-000000000004'),
  ('T',  'c0a55000-0000-4000-8000-000000000005'), ('U',  'c0a55000-0000-4000-8000-000000000006'),
  ('L',  'c0a55000-0000-4000-8000-000000000007'), ('C',  'c0a55000-0000-4000-8000-000000000008'),
  ('G',  'c0a55000-0000-4000-8000-000000000009'), ('S',  'c0a55000-0000-4000-8000-00000000000a'),
  ('O',  'c0a55000-0000-4000-8000-00000000000b'), ('R',  'c0a55000-0000-4000-8000-00000000000c'),
  ('E',  'c0a55000-0000-4000-8000-00000000000d'), ('D',  'c0a55000-0000-4000-8000-00000000000e'),
  ('K1', 'c0a55000-0000-4000-8000-00000000000f'), ('K2', 'c0a55000-0000-4000-8000-000000000010'),
  ('Q',  'c0a55000-0000-4000-8000-000000000011');
grant select on _p to authenticated, anon;

-- State before the re-run, compared after it.
create temp table _snap (k text primary key, xp int, tier int, grants int, payouts int, events int);

create function pg_temp.p(text) returns uuid language sql stable as $$ select id from _p where k = $1 $$;
create function pg_temp.lg() returns uuid language sql immutable as $$ select 'c0a55000-0000-4000-8000-0000000001a1'::uuid $$;

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

-- The error p_sql raises as persona k ("message [hint]"), or null when it
-- went through. k 'anon' = signed out with the anon key; 'nouser' = the
-- authenticated role with no user (an expired session's claims).
create function pg_temp.err_of(k text, p_sql text) returns text language plpgsql as $$
declare v_hint text;
begin
  if k = 'anon' then
    perform set_config('request.jwt.claims', '{"role": "anon"}', true);
    perform set_config('role', 'anon', true);
  elsif k = 'nouser' then
    perform set_config('request.jwt.claims', '{"role": "authenticated"}', true);
    perform set_config('role', 'authenticated', true);
  else
    perform pg_temp.as_user(pg_temp.p(k));
  end if;
  execute p_sql;
  perform pg_temp.as_admin();
  return null;
exception when others then
  get stacked diagnostics v_hint = pg_exception_hint;
  perform pg_temp.as_admin();
  return sqlerrm || coalesce(' [' || nullif(v_hint, '') || ']', '');
end $$;

-- p_sql (a select of one jsonb value) as persona k: {v} when it went
-- through, else {state, msg, hint, detail}.
create function pg_temp.eval_as(k text, p_sql text) returns jsonb language plpgsql as $$
declare
  v        jsonb;
  v_state  text;
  v_msg    text;
  v_hint   text;
  v_detail text;
begin
  perform pg_temp.as_user(pg_temp.p(k));
  execute p_sql into v;
  perform pg_temp.as_admin();
  return jsonb_build_object('v', v);
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint,
                          v_detail = pg_exception_detail;
  perform pg_temp.as_admin();
  return jsonb_build_object('state', v_state, 'msg', v_msg, 'hint', v_hint, 'detail', v_detail);
end $$;

-- get_reward_track(c) as persona k; {error, hint} when it failed.
create function pg_temp.track(k text, c text default null) returns jsonb language plpgsql as $$
declare
  j      jsonb;
  v_hint text;
begin
  perform pg_temp.as_user(pg_temp.p(k));
  j := public.get_reward_track(c);
  perform pg_temp.as_admin();
  return j;
exception when others then
  get stacked diagnostics v_hint = pg_exception_hint;
  perform pg_temp.as_admin();
  return jsonb_build_object('error', sqlerrm, 'hint', v_hint);
end $$;

-- Pacific midnight starting the Pacific day d days from today.
create function pg_temp.pday(d int) returns timestamptz language sql stable as $$
  select (((now() at time zone 'America/Los_Angeles')::date + d)::timestamp) at time zone 'America/Los_Angeles'
$$;

-- A pickle_ledger row for persona k at p_at, inserted by hand, as the
-- profiles capture trigger would write it for p_source. Returns its id.
create function pg_temp.led(k text, p_delta int, p_source text, p_at timestamptz, p_bonus boolean default false)
returns bigint language plpgsql as $$
declare v bigint;
begin
  insert into public.pickle_ledger (profile_id, delta, balance_after, reason, source, is_bonus, kind, category, created_at)
  values (pg_temp.p(k), p_delta, 0, 'Court Pass test row', p_source, p_bonus,
          case when p_bonus then 'bonus' when p_delta > 0 then 'earn' else 'spend' end, 'other', p_at)
  returning id into v;
  return v;
end $$;

-- Persona k's XP / tier in a cycle (null: no row), grants, unpaid grants (any
-- cycle), Court Pass payouts (ledger rows), events, balance.
create function pg_temp.xp(k text, c text default 'zq-now') returns int language sql stable as $$
  select x.xp from public.reward_track_xp x where x.profile_id = pg_temp.p(k) and x.cycle_id = c
$$;
create function pg_temp.tier(k text, c text default 'zq-now') returns int language sql stable as $$
  select x.tier from public.reward_track_xp x where x.profile_id = pg_temp.p(k) and x.cycle_id = c
$$;
create function pg_temp.grants(k text, c text default 'zq-now') returns int language sql stable as $$
  select count(*)::int from public.reward_track_grants g where g.profile_id = pg_temp.p(k) and g.cycle_id = c
$$;
create function pg_temp.unpaid(k text) returns int language sql stable as $$
  select count(*)::int from public.reward_track_grants g where g.profile_id = pg_temp.p(k) and g.paid_at is null
$$;
create function pg_temp.payouts(k text) returns int language sql stable as $$
  select count(*)::int from public.pickle_ledger l where l.profile_id = pg_temp.p(k) and l.source = '_pl_track_settle'
$$;
create function pg_temp.events(k text, c text default 'zq-now') returns int language sql stable as $$
  select count(*)::int from public.reward_track_xp_events e where e.profile_id = pg_temp.p(k) and e.cycle_id = c
$$;
create function pg_temp.all_events(k text) returns int language sql stable as $$
  select count(*)::int from public.reward_track_xp_events e where e.profile_id = pg_temp.p(k)
$$;
create function pg_temp.pickles(k text) returns int language sql stable as $$
  select coalesce(pickles, 0) from public.profiles where id = pg_temp.p(k)
$$;
create function pg_temp.avatar_id() returns uuid language sql stable as $$
  select id from public.shop_items where slug = 'zq-cp-avatar'
$$;

-- ════ The launch persona, before the Court Pass files ═══════════════════
-- What was live before this run (--applied, or a re-run of the apply script
-- after a partial apply):
--   tables_live  the tables file is applied: reward_track_xp_events is the
--                live table, so T11 must not ALTER it (the lock would hold
--                every live earn and Court Pass open until the rollback)
--   live         the XP trigger is live: it, not the catch-up, counted the
--                ledger rows since Nov 1, so T12's live-ledger checks are
--                skipped. With the tables applied but no trigger (step 5
--                committed, step 6 did not), the catch-up still replays the
--                ledger here and T12 checks it.
create temp table _pre as
select to_regclass('public.reward_track_xp_events') is not null as tables_live,
       exists (select 1 from pg_trigger where tgname = 'trg_pickle_ledger_track_xp') as live;

-- Q's rows are written now, before the files: in an unapplied run there is no
-- trigger yet, so only the catch-up can count them (as for every real earn
-- since Nov 1); with --applied the live trigger counts them, the same way.
do $$
declare
  v_nov2 timestamptz := '2026-11-02T16:00:00Z';   -- 08:00 Pacific (PST) on Nov 2
  i      int;
begin
  insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
  values (pg_temp.p('Q'), 'cp-q@court-pass.example', jsonb_build_object('full_name', 'Court Q Player'), now());
  -- Nov 1 Pacific midnight is 07:00Z (still PDT then): a microsecond before is no pass.
  perform pg_temp.led('Q', 40, '_grant_match_game_bonus', '2026-11-01T06:59:59.999999Z');
  perform pg_temp.led('Q', 40, '_grant_match_game_bonus', '2026-11-01T07:00:00Z');
  perform pg_temp.led('Q', 15, 'claim_daily_login_streak', '2026-11-01T07:30:00Z', true);
  -- Nov 2 (Pacific): 8 earns of 40 pickleballs and two login rows: 325 in one day.
  for i in 0..7 loop
    perform pg_temp.led('Q', 80, '_grant_match_game_bonus', v_nov2 + make_interval(hours => i));
  end loop;
  perform pg_temp.led('Q', 15, 'claim_daily_login_streak', v_nov2 + interval '1 hour 30 minutes', true);
  perform pg_temp.led('Q', 15, 'claim_daily_login_streak', v_nov2 + interval '5 hours 30 minutes', true);
  -- Earn nothing: a play streak and a gold match row.
  perform pg_temp.led('Q', 50, '_grant_daily_streak_bonus', v_nov2 + interval '2 hours');
  perform pg_temp.led('Q', 40, '_grant_match_game_bonus', v_nov2 + interval '3 hours', true);
end $$;


-- ════ The Court Pass files ═══════════════════════════════════════════════
-- @@MIGRATIONS@@


-- ════ T0 the seed (read before the test moves it) ════════════════════════
-- Skipped (ok, with a note) when the cycles files aren't there.
do $$
declare
  v_has boolean := (select count(*) = 3 from public.reward_track_cycles where id in ('2026-11', '2026-12', '2027-01'));
begin
  perform pg_temp.ok('T0 Pacific month starts: Dec 1 2026 and Jan 1, Feb 1 2027 are 08:00Z, Nov 1 2026 is 07:00Z',
    public._pl_track_pacific_month_start('2026-12-01') = '2026-12-01T08:00:00Z'::timestamptz
    and public._pl_track_pacific_month_start('2026-12-17') = '2026-12-01T08:00:00Z'::timestamptz
    and public._pl_track_pacific_month_start('2027-01-01') = '2027-01-01T08:00:00Z'::timestamptz
    and public._pl_track_pacific_month_start('2027-02-14') = '2027-02-01T08:00:00Z'::timestamptz
    and public._pl_track_pacific_month_start('2026-11-01') = '2026-11-01T07:00:00Z'::timestamptz);
  if not v_has then
    perform pg_temp.ok('T0 seed checks', true, 'skipped: no 2026-11 / 2026-12 / 2027-01 cycles (the cycles files are not applied)');
    return;
  end if;
  perform pg_temp.ok('T0 2026-11 runs Nov 1 07:00Z to Dec 1 08:00Z; 2026-12 to Jan 1 08:00Z; 2027-01 to Feb 1 08:00Z',
    (select starts_at = '2026-11-01T07:00:00Z' and ends_at = '2026-12-01T08:00:00Z' and title = 'November Court Pass'
       from public.reward_track_cycles where id = '2026-11')
    and (select starts_at = '2026-12-01T08:00:00Z' and ends_at = '2027-01-01T08:00:00Z' and title = 'December Court Pass'
           from public.reward_track_cycles where id = '2026-12')
    and (select starts_at = '2027-01-01T08:00:00Z' and ends_at = '2027-02-01T08:00:00Z' and title = 'January Court Pass'
           from public.reward_track_cycles where id = '2027-01'),
    (select string_agg(id || ' ' || starts_at || '..' || ends_at, '; ' order by id)
       from public.reward_track_cycles where id in ('2026-11', '2026-12', '2027-01')));
  perform pg_temp.ok('T0 the Nov 1 boundary: 06:59:59.999999Z is no pass, 07:00Z is November; Dec 1 08:00Z starts December, Jan 1 08:00Z January',
    public._pl_track_current_cycle('2026-11-01T06:59:59.999999Z') is null
    and public._pl_track_current_cycle('2026-11-01T07:00:00Z') = '2026-11'
    and public._pl_track_current_cycle('2026-12-01T07:59:59.999999Z') = '2026-11'
    and public._pl_track_current_cycle('2026-12-01T08:00:00Z') = '2026-12'
    and public._pl_track_current_cycle('2027-01-01T07:59:59.999999Z') = '2026-12'
    and public._pl_track_current_cycle('2027-01-01T08:00:00Z') = '2027-01'
    and public._pl_track_current_cycle('2027-02-01T08:00:00Z') is distinct from '2027-01');
  perform pg_temp.ok('T0 all three passes: 30 tiers, tier 5 = 110, tier 15 = 610, tier 30 = 1,360, no daily cap (daily_xp_cap null)',
    (select bool_and((select count(*) from public.reward_track_tiers t where t.cycle_id = c.id) = 30
                     and (select xp_required from public.reward_track_tiers t where t.cycle_id = c.id and t.tier = 5) = 110
                     and (select xp_required from public.reward_track_tiers t where t.cycle_id = c.id and t.tier = 15) = 610
                     and (select xp_required from public.reward_track_tiers t where t.cycle_id = c.id and t.tier = 30) = 1360
                     and c.daily_xp_cap is null)
       from public.reward_track_cycles c where c.id in ('2026-11', '2026-12', '2027-01')),
    (select string_agg(id || ' cap=' || coalesce(daily_xp_cap::text, 'null'), ', ' order by id)
       from public.reward_track_cycles where id in ('2026-11', '2026-12', '2027-01')));
  perform pg_temp.ok('T0 every tier of all three passes has a free reward',
    not exists (select 1 from public.reward_track_tiers t
                 where t.cycle_id in ('2026-11', '2026-12', '2027-01')
                   and not exists (select 1 from public.reward_track_rewards r
                                    where r.cycle_id = t.cycle_id and r.tier = t.tier and r.lane = 'free')));
  perform pg_temp.ok('T0 November and December: premium coming soon, 6 premium rows each (rare at 5-25, legendary at 30); January: premium off, none',
    (select premium_state from public.reward_track_cycles where id = '2026-11') = 'coming_soon'
    and (select premium_state from public.reward_track_cycles where id = '2026-12') = 'coming_soon'
    and (select premium_state from public.reward_track_cycles where id = '2027-01') = 'off'
    and (select string_agg(r.tier || ':' || r.rarity, ',' order by r.tier) from public.reward_track_rewards r
          where r.cycle_id = '2026-11' and r.lane = 'premium') = '5:rare,10:rare,15:rare,20:rare,25:rare,30:legendary'
    and (select string_agg(r.tier || ':' || r.rarity, ',' order by r.tier) from public.reward_track_rewards r
          where r.cycle_id = '2026-12' and r.lane = 'premium') = '5:rare,10:rare,15:rare,20:rare,25:rare,30:legendary'
    and not exists (select 1 from public.reward_track_rewards r where r.cycle_id = '2027-01' and r.lane = 'premium'));
  perform pg_temp.ok('T0 free lane: November and December 1,680 pickles plus 6 items each (rare at 15 and 30); January 2,680 pickles, no items',
    (select sum(amount) from public.reward_track_rewards where cycle_id = '2026-11' and lane = 'free' and kind = 'pickles') = 1680
    and (select sum(amount) from public.reward_track_rewards where cycle_id = '2026-12' and lane = 'free' and kind = 'pickles') = 1680
    and (select string_agg(r.tier || ':' || r.rarity, ',' order by r.tier) from public.reward_track_rewards r
          where r.cycle_id = '2026-11' and r.lane = 'free' and r.kind <> 'pickles') = '5:common,10:common,15:rare,20:common,25:common,30:rare'
    and (select string_agg(r.tier || ':' || r.rarity, ',' order by r.tier) from public.reward_track_rewards r
          where r.cycle_id = '2026-12' and r.lane = 'free' and r.kind <> 'pickles') = '5:common,10:common,15:rare,20:common,25:common,30:rare'
    and (select sum(amount) from public.reward_track_rewards where cycle_id = '2027-01' and lane = 'free' and kind = 'pickles') = 2680
    and (select count(*) from public.reward_track_rewards where cycle_id = '2027-01' and kind <> 'pickles') = 0
    -- the same amount on every plain tier of November and December
    and not exists (select 1 from public.reward_track_rewards n
                      join public.reward_track_rewards d on d.cycle_id = '2026-12' and d.tier = n.tier and d.lane = 'free'
                     where n.cycle_id = '2026-11' and n.lane = 'free' and (n.kind, n.amount) is distinct from (d.kind, d.amount))
    and not exists (select 1 from public.reward_track_rewards
                     where cycle_id in ('2026-11', '2026-12', '2027-01') and kind = 'pickles'
                       and (rarity is not null or title <> amount || ' pickles')),
    (select string_agg(cycle_id || '=' || s, ' ') from (
       select cycle_id, sum(amount)::text as s from public.reward_track_rewards
        where cycle_id in ('2026-11', '2026-12', '2027-01') and lane = 'free' and kind = 'pickles' group by cycle_id) x));
  perform pg_temp.ok('T0 November''s items are the harvest set (cp2611), December''s the winter set (cp2612), in the catalogs'' tiers',
    (select string_agg(r.tier || r.lane || '=' || coalesce(r.shop_item_slug, r.home_item_id), ',' order by r.lane, r.tier)
       from public.reward_track_rewards r where r.cycle_id = '2026-11' and r.kind <> 'pickles')
      = '5free=cp2611-avatar-turkey,10free=cp2611_cornucopia,15free=cp2611_pumpkin_stack,20free=cp2611_window_autumn,'
        '25free=cp2611-list-harvest,30free=cp2611-profile-golden-harvest,5premium=cp2611_poster_gratitude,'
        '10premium=cp2611-avatar-pie,15premium=cp2611_leaf_garland,20premium=cp2611_pillow_plaid,'
        '25premium=cp2611_rug_harvest,30premium=cp2611_rack_harvest_hall'
    and (select string_agg(r.tier || r.lane || '=' || coalesce(r.shop_item_slug, r.home_item_id), ',' order by r.lane, r.tier)
           from public.reward_track_rewards r where r.cycle_id = '2026-12' and r.kind <> 'pickles')
      = '5free=cp2612-avatar-snowman,10free=cp2612_snow_globe,15free=cp2612_ornament_tree,20free=cp2612_window_snow,'
        '25free=cp2612-list-frost,30free=cp2612-profile-snowfall,5premium=cp2612_poster_first_frost,'
        '10premium=cp2612-avatar-reindeer,15premium=cp2612_icicle_lights,20premium=cp2612_pillow_knit,'
        '25premium=cp2612_rug_snowflake,30premium=cp2612_rack_ice_palace'
    and (select payload from public.shop_items where slug = 'cp2611-profile-golden-harvest')
        = '{"kind":"animated","effect":"sparkle","base":"#c2571a"}'::jsonb
    and (select payload from public.shop_items where slug = 'cp2611-list-harvest')
        = '{"kind":"gradient","stops":["#b5451b","#e8a33d"],"direction":"horizontal"}'::jsonb
    and (select payload from public.shop_items where slug = 'cp2612-profile-snowfall')
        = '{"kind":"animated","effect":"snowfall","base":"#2f7fc1"}'::jsonb
    and not exists (select 1 from public.home_items h
                     where (h.id like 'cp2611\_%' and h.season is distinct from '2026-11')
                        or (h.id like 'cp2612\_%' and h.season is distinct from '2026-12')));
  perform pg_temp.ok('T0 the 8 track Shop items (4 a month) are inactive (never listed), cost 0 and not badge-gated',
    (select count(*) from public.reward_track_rewards r join public.shop_items s on s.slug = r.shop_item_slug
      where r.cycle_id = '2026-11') = 4
    and (select count(*) from public.reward_track_rewards r join public.shop_items s on s.slug = r.shop_item_slug
          where r.cycle_id = '2026-12') = 4
    and not exists (select 1 from public.reward_track_rewards r join public.shop_items s on s.slug = r.shop_item_slug
                     where r.cycle_id in ('2026-11', '2026-12') and (s.is_active or s.cost <> 0 or s.unlock_badge_id is not null)));
  -- Already past now: the cycle's start (November's is past too, but
  -- December's is not) would list every item, premium too, as a live
  -- 0-pickle drop in older app builds.
  perform pg_temp.ok('T0 the 16 track My Place items (8 a month) are track_only, cost 0, not starters, and already off sale',
    (select count(*) from public.reward_track_rewards r join public.home_items h on h.id = r.home_item_id
      where r.cycle_id = '2026-11') = 8
    and (select count(*) from public.reward_track_rewards r join public.home_items h on h.id = r.home_item_id
          where r.cycle_id = '2026-12') = 8
    and not exists (select 1 from public.reward_track_rewards r
                      join public.reward_track_cycles c on c.id = r.cycle_id
                      join public.home_items h on h.id = r.home_item_id
                     where r.cycle_id in ('2026-11', '2026-12')
                       and (not h.track_only or h.cost <> 0 or h.is_starter or h.available_until is null
                            or h.available_until > now() or h.available_until >= c.starts_at)),
    (select string_agg(h.id || ' ' || coalesce(h.available_until::text, 'null'), ', ') from public.reward_track_rewards r
       join public.reward_track_cycles c on c.id = r.cycle_id
       join public.home_items h on h.id = r.home_item_id
      where r.cycle_id in ('2026-11', '2026-12')
        and (not h.track_only or h.cost <> 0 or h.is_starter or h.available_until is null
             or h.available_until > now() or h.available_until >= c.starts_at)));
  perform pg_temp.ok('T0 nobody holds a premium grant',
    not exists (select 1 from public.reward_track_grants where lane = 'premium'));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T0 block crashed', false, sqlerrm);
end $$;


-- ════ T12 the launch: back-dated to Nov 1, the catch-up, no cap ══════════
-- Before the real cycles move: Q's rows (written before the files) are in the
-- real '2026-11' pass. In an unapplied run the catch-up counted them, and
-- every real earn since Nov 1 (checked against the live ledger below).
do $$
declare
  v_start timestamptz := (select starts_at from public.reward_track_cycles where id = '2026-11');
  v_live  boolean := (select live from _pre);
  v_j     jsonb;
  v_bal   int;
begin
  if v_start is null then
    perform pg_temp.ok('T12 launch checks', false, 'no 2026-11 cycle: migration_court_pass_cycles_2026_11.sql is not applied');
    return;
  end if;
  perform pg_temp.ok('T12 Q: nothing before Nov 1 07:00Z; 20 at 07:00Z; logins 5 once per Pacific day (Nov 1, Nov 2); 320 more on Nov 2 with no cap: 350, tier 9',
    pg_temp.xp('Q', '2026-11') = 350 and pg_temp.tier('Q', '2026-11') = 9 and pg_temp.events('Q', '2026-11') = 11
    and pg_temp.all_events('Q') = 11
    and (select count(*) from public.reward_track_xp_events e
          where e.profile_id = pg_temp.p('Q') and e.source = 'login' and e.xp = 5) = 2,
    'xp=' || coalesce(pg_temp.xp('Q', '2026-11')::text, 'none') || ' tier=' || coalesce(pg_temp.tier('Q', '2026-11')::text, 'none')
    || ' events=' || pg_temp.all_events('Q'));
  perform pg_temp.ok('T12 no daily cap: 325 pickleballs in Q''s one Pacific day (Nov 2), every earn in full (no 0-XP event)',
    (select sum(e.xp) from public.reward_track_xp_events e
      where e.profile_id = pg_temp.p('Q') and e.xp_day = '2026-11-02') = 325
    and not exists (select 1 from public.reward_track_xp_events e where e.profile_id = pg_temp.p('Q') and e.xp = 0),
    (select string_agg(e.xp_day || ':' || e.xp, ',' order by e.id) from public.reward_track_xp_events e
      where e.profile_id = pg_temp.p('Q')));
  perform pg_temp.ok('T12 the catch-up (or the trigger) only writes grant rows: 9 tiers reached, none paid, no pickles moved',
    pg_temp.grants('Q', '2026-11') = 9 and pg_temp.unpaid('Q') = 9 and pg_temp.payouts('Q') = 0);

  v_bal := pg_temp.pickles('Q');
  v_j := pg_temp.track('Q', '2026-11');
  perform pg_temp.ok('T12 opening the November Court Pass pays tiers 1-9: 400 pickles and the Gobble Gobble avatar (a cost-0 purchase of an inactive item)',
    v_j -> 'cycle' ->> 'id' = '2026-11' and v_j -> 'cycle' ->> 'title' = 'November Court Pass'
    and (v_j -> 'paid' ->> 'pickles')::int = 400 and jsonb_array_length(v_j -> 'paid' -> 'grants') = 9
    and pg_temp.pickles('Q') = v_bal + 400 and pg_temp.unpaid('Q') = 0 and pg_temp.payouts('Q') = 8
    and exists (select 1 from public.player_shop_purchases ps join public.shop_items s on s.id = ps.shop_item_id
                 where ps.user_id = pg_temp.p('Q') and s.slug = 'cp2611-avatar-turkey' and ps.cost_paid = 0 and not s.is_active)
    and pg_temp.xp('Q', '2026-11') = 350,
    coalesce(v_j ->> 'paid', v_j::text));
  perform pg_temp.ok('T12 ...and the screen reads no cap: me.daily_cap null, 30 tiers, 36 rewards (6 premium), the harvest items with their rows',
    v_j -> 'me' -> 'daily_cap' = 'null'::jsonb and (v_j -> 'me' ->> 'xp')::int = 350 and (v_j -> 'me' ->> 'tier')::int = 9
    and jsonb_array_length(v_j -> 'tiers') = 30 and jsonb_array_length(v_j -> 'rewards') = 36
    and (select count(*) from jsonb_array_elements(v_j -> 'rewards') r where r ->> 'lane' = 'premium') = 6
    and (select r -> 'item' ->> 'slot_group' from jsonb_array_elements(v_j -> 'rewards') r
          where r ->> 'item_key' = 'cp2611_pumpkin_stack') = 'accent'
    and (select r -> 'item' -> 'payload' ->> 'effect' from jsonb_array_elements(v_j -> 'rewards') r
          where r ->> 'item_key' = 'cp2611-profile-golden-harvest') = 'sparkle',
    coalesce(v_j ->> 'me', v_j::text));
  v_bal := pg_temp.pickles('Q');
  v_j := pg_temp.eval_as('Q', $q$select public.buy_home_item('cp2611_cornucopia')$q$);
  -- (After Nov 30 the message says the November pass has ended instead.)
  perform pg_temp.ok('T12 a November track item can''t be bought: pl:home.track_only names tier 10 of the November Court Pass, nothing spent',
    v_j ->> 'hint' = 'pl:home.track_only'
    and v_j ->> 'msg' like 'Pickleball Cornucopia %' and v_j ->> 'msg' like '%tier 10 %'
    and v_j ->> 'msg' like '%November Court Pass%' and v_j ->> 'msg' like '%nothing was spent%'
    and pg_temp.pickles('Q') = v_bal
    and not exists (select 1 from public.home_owned_items where owner_id = pg_temp.p('Q') and item_id = 'cp2611_cornucopia'),
    v_j::text);

  -- Every real earn since Nov 1, replayed by the catch-up in this
  -- transaction. Skipped when the Court Pass was already live before the run.
  if v_live then
    perform pg_temp.ok('T12 the catch-up replayed the live ledger since Nov 1', true,
      'skipped: the XP trigger was already live before this run (--applied, or step 6 applied), so the trigger counted those rows and the catch-up skipped itself');
    return;
  end if;
  perform pg_temp.ok('T12 the catch-up counted every allowlisted, non-gold earn since Nov 1 once, at half its pickles',
    not exists (
      select 1 from public.pickle_ledger l
        join public.reward_track_xp_sources s on s.source = l.source
        join public.profiles p on p.id = l.profile_id
       where l.created_at >= v_start and l.delta > 0 and not l.is_bonus
         and floor(l.delta * s.xp_ratio) > 0
         and public._pl_track_current_cycle(l.created_at) is not null
         and p.deleted_at is null and not coalesce(p.is_test_account, false) and not coalesce(p.is_guest, false)
         and not exists (select 1 from public.reward_track_xp_events e
                          where e.profile_id = l.profile_id and e.source = 'ledger' and e.source_ref = l.id::text
                            and e.xp = floor(l.delta * s.xp_ratio)::int and e.pickles = l.delta)),
    (select count(*) || ' ledger events, ' || coalesce(sum(xp), 0) || ' pickleballs'
       from public.reward_track_xp_events where source = 'ledger'));
  perform pg_temp.ok('T12 ...and nothing else: no ledger event without such a row (gold, other sources, guests, test accounts)',
    not exists (
      select 1 from public.reward_track_xp_events e
       where e.source = 'ledger'
         and not exists (select 1 from public.pickle_ledger l
                           join public.reward_track_xp_sources s on s.source = l.source
                           join public.profiles p on p.id = l.profile_id
                          where l.id::text = e.source_ref and l.profile_id = e.profile_id and not l.is_bonus
                            and l.created_at >= v_start
                            and not coalesce(p.is_test_account, false) and not coalesce(p.is_guest, false))));
  perform pg_temp.ok('T12 logins since Nov 1: one +5 event per player and Pacific day with a daily login reward',
    (select count(*) from public.reward_track_xp_events e where e.source = 'login' and e.xp = 5)
    = (select count(*) from (
         select distinct l.profile_id, (l.created_at at time zone 'America/Los_Angeles')::date
           from public.pickle_ledger l join public.profiles p on p.id = l.profile_id
          where l.source = 'claim_daily_login_streak' and l.delta > 0 and l.created_at >= v_start
            and public._pl_track_current_cycle(l.created_at) is not null
            and p.deleted_at is null and not coalesce(p.is_test_account, false) and not coalesce(p.is_guest, false)) x)
    and not exists (select 1 from public.reward_track_xp_events e where e.source = 'login' and e.xp <> 5),
    (select count(*) || ' login events' from public.reward_track_xp_events where source = 'login'));
  perform pg_temp.ok('T12 every player''s XP is the sum of their events, at the tier it reaches, with a grant row per tier',
    not exists (select 1 from public.reward_track_xp x
                 where x.xp <> (select coalesce(sum(e.xp), 0) from public.reward_track_xp_events e
                                 where e.profile_id = x.profile_id and e.cycle_id = x.cycle_id)
                    or x.tier <> public._pl_track_tier_for(x.cycle_id, x.xp)
                    or x.tier <> (select count(*) from public.reward_track_grants g
                                   where g.profile_id = x.profile_id and g.cycle_id = x.cycle_id)),
    (select count(*) filter (where xp > 0) || ' people, ' || coalesce(sum(xp), 0) || ' pickleballs, '
            || (select count(*) from public.reward_track_grants) || ' tiers reached'
       from public.reward_track_xp));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T12 block crashed', false, sqlerrm);
end $$;


-- ════ Test cycles and items ══════════════════════════════════════════════
-- Move the real cycles out of the way, then make the test's own.
update public.reward_track_cycles
   set starts_at = starts_at + interval '500 years', ends_at = ends_at + interval '500 years'
 where id not like 'zq-%';

insert into public.reward_track_cycles (id, title, starts_at, ends_at, premium_state) values
  ('zq-old',  'Zq Old Pass',   now() - interval '40 days', now() - interval '12 days', 'off'),
  ('zq-now',  'Zq Court Pass', now() - interval '10 days', now() + interval '10 days', 'coming_soon'),
  ('zq-next', 'Zq Next Pass',  now() + interval '20 days', now() + interval '50 days', 'coming_soon');

insert into public.reward_track_tiers (cycle_id, tier, xp_required)
select c, t, case when t = 1 then 10 when t <= 5 then 10 + 25 * (t - 1) else 110 + 50 * (t - 5) end
  from unnest(array['zq-old', 'zq-now', 'zq-next']) c, generate_series(1, 30) t;

insert into public.shop_items (category, slug, name, description, icon, cost, payload, is_active, sort_order) values
  ('avatar', 'zq-cp-avatar', 'Zq Track Avatar',   'persona test (rolled back)', '🧪', 0, '{"emoji":"🧪","bgColor":"#eeeeee"}'::jsonb, false, 99990),
  ('avatar', 'zq-cp-prem',   'Zq Premium Avatar', 'persona test (rolled back)', '👑', 0, '{"emoji":"👑","bgColor":"#eeeeee"}'::jsonb, false, 99991);

insert into public.home_items (id, name, slot_group, cost, rarity, available_until, icon, sort, is_starter, track_only) values
  ('zq_cp_lamp', 'Zq Track Lamp',  'accent', 0, 'common',    now() - interval '10 days', '🪔', 99990, false, true),
  ('zq_cp_rare', 'Zq Track Rare',  'accent', 0, 'rare',      now() - interval '10 days', '🏆', 99991, false, true),
  ('zq_cp_prem', 'Zq Track Crown', 'accent', 0, 'legendary', now() - interval '10 days', '👑', 99992, false, true);

-- zq-now: pickles, the lamp at 5, the avatar at 6, the rare at 15 (rarity
-- from home_items), premium at 5 and 10. zq-old and zq-next: pickles only.
insert into public.reward_track_rewards (cycle_id, tier, lane, kind, amount, shop_item_slug, home_item_id, title, rarity)
select c, t, 'free',
       case when c = 'zq-now' and t in (5, 15) then 'home_item' when c = 'zq-now' and t = 6 then 'shop_item' else 'pickles' end,
       case when c = 'zq-now' and t in (5, 6, 15) then null else 10 end,
       case when c = 'zq-now' and t = 6 then 'zq-cp-avatar' end,
       case when c = 'zq-now' then case t when 5 then 'zq_cp_lamp' when 15 then 'zq_cp_rare' end end,
       case when c = 'zq-now' and t = 5 then 'Zq Track Lamp' when c = 'zq-now' and t = 6 then 'Zq Track Avatar'
            when c = 'zq-now' and t = 15 then 'Zq Track Rare' else '10 pickles' end,
       case when c = 'zq-now' and t = 6 then 'common' end
  from unnest(array['zq-old', 'zq-now', 'zq-next']) c, generate_series(1, 30) t;
insert into public.reward_track_rewards (cycle_id, tier, lane, kind, shop_item_slug, home_item_id, title, rarity) values
  ('zq-now', 5,  'premium', 'home_item', null,         'zq_cp_prem', 'Zq Track Crown',    null),
  ('zq-now', 10, 'premium', 'shop_item', 'zq-cp-prem', null,         'Zq Premium Avatar', 'rare');


-- ════ Personas ═══════════════════════════════════════════════════════════
do $$
begin
  insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
  select id, 'cp-' || lower(k) || '@court-pass.example', jsonb_build_object('full_name', 'Court ' || k || ' Player'), now()
    from _p where k <> 'Q';   -- Q was made before the Court Pass files
  update public.profiles set is_test_account = true where id = pg_temp.p('T');
  update public.profiles set is_guest = true where id = pg_temp.p('U');
  insert into public.leagues (id, name, description, is_open, created_by)
  values (pg_temp.lg(), 'Court Pass League', null, true, pg_temp.p('M1'));
  insert into public.league_members (league_id, user_id, role)
  select pg_temp.lg(), pg_temp.p(k), case when k = 'M1' then 'admin' else 'member' end
    from unnest(array['M1', 'M2', 'K1', 'K2']) k
  on conflict (league_id, user_id) do nothing;
  perform pg_temp.ok('SETUP 17 personas, none of them a test account but T, U a guest',
    (select count(*) from public.profiles where id in (select id from _p)) = 17
    and (select count(*) from public.profiles where id in (select id from _p) and is_test_account) = 1
    and (select is_guest from public.profiles where id = pg_temp.p('U')));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('SETUP crashed', false, sqlerrm);
end $$;


-- ════ T1 allowlisted sources earn half the pickles paid ══════════════════
do $$
begin
  perform pg_temp.led('W', 40, '_grant_match_game_bonus', now());
  perform pg_temp.ok('T1 a match row: 40 pickles = 20 pickleballs', pg_temp.xp('W') = 20,
    'xp=' || coalesce(pg_temp.xp('W')::text, 'none'));
  perform pg_temp.led('W', 50, '_grant_new_opponent_bonus', now());
  perform pg_temp.led('W', 25, '_grant_checkin_match_bonus', now());
  perform pg_temp.led('W', 50, '_grant_tournament_participation_bonus', now());
  perform pg_temp.ok('T1 new opponent 50 = 25, check-in 25 = 12, tournament 50 = 25: 82 in all',
    pg_temp.xp('W') = 82, 'xp=' || coalesce(pg_temp.xp('W')::text, 'none'));
  perform pg_temp.led('W', 35, '_grant_match_game_bonus', now());
  perform pg_temp.ok('T1 a 35-pickle match (down the day''s curve) = 17: 99 in all',
    pg_temp.xp('W') = 99, 'xp=' || coalesce(pg_temp.xp('W')::text, 'none'));
  perform pg_temp.ok('T1 every event keeps the pickles paid and floor(pickles / 2)',
    pg_temp.events('W') = 5
    and not exists (select 1 from public.reward_track_xp_events e
                     where e.profile_id = pg_temp.p('W') and (e.source <> 'ledger' or e.pickles is null or e.xp <> e.pickles / 2)));
  perform pg_temp.ok('T1 tier 4 reached: 4 grant rows, none paid, no payout (the trigger never pays)',
    pg_temp.tier('W') = 4 and pg_temp.grants('W') = 4 and pg_temp.unpaid('W') = 4 and pg_temp.payouts('W') = 0,
    'tier=' || coalesce(pg_temp.tier('W')::text, 'none') || ' grants=' || pg_temp.grants('W') || ' unpaid=' || pg_temp.unpaid('W'));

  -- End to end: a real completed singles match (badge pickles off, so only
  -- the pay under test moves).
  perform set_config('pickleague.skip_badge_pickle_grant', 'on', true);
  insert into public.matches (league_id, player1_id, player2_id, player1_score, player2_score, match_type, status, played_at)
  values (pg_temp.lg(), pg_temp.p('M1'), pg_temp.p('M2'), 11, 6, 'singles', 'completed', now());
  perform set_config('pickleague.skip_badge_pickle_grant', '', true);
  perform pg_temp.ok('T1 end to end: a real match pays M1 and M2 40 pickles (_grant_match_game_bonus) and 20 pickleballs each for it',
    (select count(*) from public.pickle_ledger l
       join public.reward_track_xp_events e on e.source = 'ledger' and e.source_ref = l.id::text
      where l.profile_id in (pg_temp.p('M1'), pg_temp.p('M2')) and l.source = '_grant_match_game_bonus'
        and l.delta = 40 and e.xp = 20 and e.pickles = 40) = 2,
    (select string_agg(l.source || ' ' || l.delta, ', ' order by l.id) from public.pickle_ledger l
      where l.profile_id = pg_temp.p('M1')));
  perform pg_temp.ok('T1 ...and each one''s XP is half of every allowlisted, non-gold row (new opponent too); the rest add nothing',
    (select bool_and(coalesce(pg_temp.xp(k), 0) = (
              select coalesce(sum(floor(l.delta * s.xp_ratio)), 0)::int
                from public.pickle_ledger l join public.reward_track_xp_sources s on s.source = l.source
               where l.profile_id = pg_temp.p(k) and l.delta > 0 and not l.is_bonus))
       from unnest(array['M1', 'M2']) k)
    and pg_temp.xp('M1') >= 20,
    'M1 xp=' || coalesce(pg_temp.xp('M1')::text, 'none') || ' M2 xp=' || coalesce(pg_temp.xp('M2')::text, 'none'));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T1 block crashed', false, sqlerrm);
end $$;


-- ════ T2 excluded sources, gold, negative rows, guests, test accounts ════
do $$
declare
  s text;
begin
  foreach s in array array[
    '_grant_daily_streak_bonus', '_grant_court_bonus', '_grant_pickles_on_badge', 'submit_drill_review',
    'log_session_drill', 'claim_ftue_step', 'claim_welcome_pickles', '_grant_first_match_bonus',
    '_grant_first_doubles_bonus', '_pl_pay_referral_reward', 'claim_anniversary_pickles', 'godmode_gift_pickles',
    'claim_godmode_pickles', 'award_pickles_from_pool', 'distribute_season_pool', 'auto_payout_tournament',
    '_settle_wagers_for_match', 'cancel_wager', '_refund_registration_ante', '_grant_season_organiser_bonus',
    '_pl_track_settle'] loop
    perform pg_temp.led('X', 50, s, now());
  end loop;
  perform pg_temp.led('X', 50, null, now());
  perform pg_temp.led('X', 40, '_grant_match_game_bonus', now(), true);   -- an allowlisted source, but gold
  perform pg_temp.led('X', -40, '_grant_match_game_bonus', now());       -- a negative row
  perform pg_temp.ok('T2 streak, courts, badges, drill reviews, getting started, welcome, referrals, gifts, prizes, wagers, God mode, the payout, a null source, a gold row and a negative row earn 0',
    pg_temp.xp('X') is null and pg_temp.all_events('X') = 0,
    'xp=' || coalesce(pg_temp.xp('X')::text, 'none') || ' events=' || pg_temp.all_events('X'));

  perform pg_temp.led('T', 40, '_grant_match_game_bonus', now());
  perform pg_temp.led('T', 15, 'claim_daily_login_streak', now(), true);
  perform pg_temp.led('U', 40, '_grant_match_game_bonus', now());
  perform pg_temp.led('U', 15, 'claim_daily_login_streak', now(), true);
  perform pg_temp.ok('T2 a test account and a guest earn nothing (no XP row, no events), logins included',
    pg_temp.xp('T') is null and pg_temp.all_events('T') = 0 and pg_temp.xp('U') is null and pg_temp.all_events('U') = 0);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T2 block crashed', false, sqlerrm);
end $$;


-- ════ T3 login: +5 once per Pacific day ══════════════════════════════════
do $$
declare
  v_today date := (now() at time zone 'America/Los_Angeles')::date;
  v_a jsonb;
  v_b jsonb;
begin
  perform pg_temp.as_user(pg_temp.p('L'));
  v_a := (select to_jsonb(x) from public.claim_daily_login_streak() x);
  perform pg_temp.as_admin();
  perform pg_temp.ok('T3 a real daily login pays pickles and 5 pickleballs: one login event, keyed by the Pacific date',
    (v_a ->> 'daily_pickles')::int > 0 and pg_temp.xp('L') = 5
    and (select count(*) from public.reward_track_xp_events e where e.profile_id = pg_temp.p('L') and e.source = 'login') = 1
    and (select e.source_ref from public.reward_track_xp_events e where e.profile_id = pg_temp.p('L') and e.source = 'login') = v_today::text,
    'claim=' || coalesce(v_a::text, 'null') || ' xp=' || coalesce(pg_temp.xp('L')::text, 'none'));

  -- L moves to UTC+14 (already "tomorrow" there): another claim, and another
  -- login row the same Pacific day, add nothing.
  insert into public.pickleague_time_zones (profile_id, tz) values (pg_temp.p('L'), 'Pacific/Kiritimati')
  on conflict (profile_id) do update set tz = excluded.tz;
  perform pg_temp.as_user(pg_temp.p('L'));
  v_b := (select to_jsonb(x) from public.claim_daily_login_streak() x);
  perform pg_temp.as_admin();
  perform pg_temp.led('L', 24, 'claim_daily_login_streak', now(), true);
  perform pg_temp.ok('T3 after a flip to UTC+14, a second claim and another login row the same Pacific day add nothing',
    pg_temp.xp('L') = 5
    and (select count(*) from public.reward_track_xp_events e where e.profile_id = pg_temp.p('L') and e.source = 'login') = 1,
    'second claim=' || coalesce(v_b::text, 'null') || ' xp=' || coalesce(pg_temp.xp('L')::text, 'none'));
  perform pg_temp.led('L', 24, 'claim_daily_login_streak', pg_temp.pday(1) + interval '9 hours', true);
  perform pg_temp.ok('T3 a login on the next Pacific day earns 5 more', pg_temp.xp('L') = 10,
    'xp=' || coalesce(pg_temp.xp('L')::text, 'none'));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T3 block crashed', false, sqlerrm);
end $$;


-- ════ T4 no daily cap (Brian, 2026-11-03) ════════════════════════════════
-- zq-now has daily_xp_cap null, as every seeded pass. The numeric branch is
-- kept (SQL could set a cap on a future pass), so it is checked too, then
-- zq-now goes back to no cap.
do $$
declare
  v_d timestamptz := pg_temp.pday(-2);
  i   int;
begin
  for i in 0..7 loop
    perform pg_temp.led('C', 80, '_grant_match_game_bonus', v_d + make_interval(hours => 8 + i));
  end loop;
  perform pg_temp.ok('T4 no cap: 8 earns of 40 in one Pacific day all count, 320 pickleballs, no 0-XP event',
    pg_temp.xp('C') = 320 and pg_temp.events('C') = 8
    and not exists (select 1 from public.reward_track_xp_events e where e.profile_id = pg_temp.p('C') and e.xp = 0)
    and (select daily_xp_cap from public.reward_track_cycles where id = 'zq-now') is null,
    'xp=' || coalesce(pg_temp.xp('C')::text, 'none'));

  update public.reward_track_cycles set daily_xp_cap = 330 where id = 'zq-now';
  perform pg_temp.led('C', 24, '_grant_match_game_bonus', v_d + interval '16 hours');
  perform pg_temp.led('C', 24, '_grant_match_game_bonus', v_d + interval '17 hours');
  perform pg_temp.ok('T4 a pass given a number (SQL only) still caps its Pacific day: 330, the earn past it recorded at 0',
    pg_temp.xp('C') = 330
    and (select count(*) from public.reward_track_xp_events e where e.profile_id = pg_temp.p('C') and e.xp = 0) = 1,
    'xp=' || coalesce(pg_temp.xp('C')::text, 'none'));
  update public.reward_track_cycles set daily_xp_cap = null where id = 'zq-now';
  perform pg_temp.led('C', 24, '_grant_match_game_bonus', v_d + interval '18 hours');
  perform pg_temp.ok('T4 back to no cap: the same day earns in full again (342)', pg_temp.xp('C') = 342,
    'xp=' || coalesce(pg_temp.xp('C')::text, 'none'));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T4 block crashed', false, sqlerrm);
  -- a crash must not leave zq-now capped for the later blocks
  update public.reward_track_cycles set daily_xp_cap = null where id = 'zq-now';
end $$;


-- ════ T5 grants written by the trigger, paid once by get_reward_track ══
do $$
declare
  v_bal  int;
  v_row  bigint;
  v_ret  int;
  v_j    jsonb;
begin
  v_bal := pg_temp.pickles('G');
  perform pg_temp.led('G', 120, '_grant_match_game_bonus', pg_temp.pday(-3) + interval '8 hours');
  perform pg_temp.led('G', 80, '_grant_match_game_bonus', pg_temp.pday(-3) + interval '9 hours');
  perform pg_temp.ok('T5 100 pickleballs = tier 4: 4 grant rows with paid_at null, and no pickles moved',
    pg_temp.xp('G') = 100 and pg_temp.tier('G') = 4 and pg_temp.grants('G') = 4 and pg_temp.unpaid('G') = 4
    and pg_temp.payouts('G') = 0 and pg_temp.pickles('G') = v_bal,
    'tier=' || coalesce(pg_temp.tier('G')::text, 'none') || ' unpaid=' || pg_temp.unpaid('G') || ' payouts=' || pg_temp.payouts('G'));

  v_j := pg_temp.track('G');
  perform pg_temp.ok('T5 opening the Court Pass pays tiers 1-4 once each: +40 pickles, 4 gold rows ''Court Pass tier N'', 0 pickleballs',
    pg_temp.payouts('G') = 4 and pg_temp.unpaid('G') = 0 and pg_temp.pickles('G') = v_bal + 40
    and pg_temp.xp('G') = 100
    and (v_j -> 'paid' ->> 'pickles')::int = 40 and jsonb_array_length(v_j -> 'paid' -> 'grants') = 4
    and (select bool_and(l.is_bonus and l.kind = 'bonus' and l.category = 'track' and l.delta = 10
                         and l.reason = 'Court Pass tier ' || (l.meta ->> 'tier') and l.meta ->> 'cycle_id' = 'zq-now')
           from public.pickle_ledger l where l.profile_id = pg_temp.p('G') and l.source = '_pl_track_settle'),
    coalesce(v_j ->> 'paid', v_j::text));

  v_row := pg_temp.led('G', 120, '_grant_match_game_bonus', pg_temp.pday(-2) + interval '8 hours');
  perform pg_temp.led('G', 10, '_grant_match_game_bonus', pg_temp.pday(-2) + interval '9 hours');
  perform pg_temp.ok('T5 165 pickleballs = tier 6: tiers 5 and 6 granted, not paid, nothing owned yet',
    pg_temp.xp('G') = 165 and pg_temp.tier('G') = 6 and pg_temp.grants('G') = 6 and pg_temp.unpaid('G') = 2
    and not exists (select 1 from public.home_owned_items where owner_id = pg_temp.p('G') and item_id = 'zq_cp_lamp'),
    'xp=' || coalesce(pg_temp.xp('G')::text, 'none') || ' unpaid=' || pg_temp.unpaid('G'));
  v_j := pg_temp.track('G');
  perform pg_temp.ok('T5 the next open pays tier 5 (the lamp: My Place, source grant, cost 0) and tier 6 (the avatar: a cost-0 purchase), no pickles',
    exists (select 1 from public.home_owned_items
             where owner_id = pg_temp.p('G') and item_id = 'zq_cp_lamp' and source = 'grant' and cost_paid = 0)
    and exists (select 1 from public.player_shop_purchases
                 where user_id = pg_temp.p('G') and shop_item_id = pg_temp.avatar_id() and cost_paid = 0)
    and not exists (select 1 from public.home_owned_items where owner_id = pg_temp.p('G') and item_id = 'zq_cp_rare')
    and pg_temp.payouts('G') = 4 and pg_temp.unpaid('G') = 0
    and (v_j -> 'paid' ->> 'pickles')::int = 0
    and (select string_agg(g ->> 'kind', ',' order by (g ->> 'tier')::int) from jsonb_array_elements(v_j -> 'paid' -> 'grants') g)
        = 'home_item,shop_item',
    coalesce(v_j ->> 'paid', v_j::text));

  -- Replays: the same ledger row again, the sweep again, the screen twice.
  v_ret := public._pl_track_add_xp(pg_temp.p('G'), pg_temp.pday(-2) + interval '8 hours', 'ledger', v_row::text, 60, 120);
  v_ret := v_ret + public._pl_track_grant_reached(pg_temp.p('G'), 'zq-now');
  v_j := pg_temp.track('G');
  v_j := pg_temp.track('G', 'zq-now');
  perform pg_temp.ok('T5 a replayed earn, a second sweep and two more opens change nothing',
    v_ret = 0 and pg_temp.xp('G') = 165 and pg_temp.grants('G') = 6 and pg_temp.payouts('G') = 4
    and (v_j -> 'paid' ->> 'pickles')::int = 0 and jsonb_array_length(v_j -> 'paid' -> 'grants') = 0
    and jsonb_array_length(v_j -> 'grants') = 6
    and (select count(*) from public.player_shop_purchases where user_id = pg_temp.p('G')) = 1,
    'ret=' || v_ret || ' xp=' || pg_temp.xp('G') || ' payouts=' || pg_temp.payouts('G'));

  -- S: XP recorded but the grant rows never landed.
  insert into public.reward_track_xp (profile_id, cycle_id, xp, tier) values (pg_temp.p('S'), 'zq-now', 40, 0);
  v_j := pg_temp.track('S');
  perform pg_temp.ok('T5 a missing grant is swept on the next open and paid: tiers 1-2, +20 pickles',
    pg_temp.grants('S') = 2 and pg_temp.payouts('S') = 2 and pg_temp.tier('S') = 2 and pg_temp.unpaid('S') = 0
    and (v_j -> 'me' ->> 'tier')::int = 2 and jsonb_array_length(v_j -> 'grants') = 2
    and (v_j -> 'paid' ->> 'pickles')::int = 20,
    'grants=' || pg_temp.grants('S') || ' payouts=' || pg_temp.payouts('S'));
  v_j := pg_temp.track('S');
  perform pg_temp.ok('T5 ...and only once', pg_temp.payouts('S') = 2 and (v_j -> 'paid' ->> 'pickles')::int = 0);

  -- O: tier 1 reached in zq-old (ended), never opened then.
  perform pg_temp.led('O', 20, '_grant_match_game_bonus', now() - interval '30 days');
  perform pg_temp.ok('T5 an earn in the ended pass: tier 1 granted there, unpaid',
    pg_temp.xp('O', 'zq-old') = 10 and pg_temp.grants('O', 'zq-old') = 1 and pg_temp.unpaid('O') = 1 and pg_temp.payouts('O') = 0);
  v_j := pg_temp.track('O');
  perform pg_temp.ok('T5 ...pays on an open during the next pass, and shows in paid',
    pg_temp.unpaid('O') = 0 and pg_temp.payouts('O') = 1 and v_j -> 'cycle' ->> 'id' = 'zq-now'
    and (v_j -> 'paid' ->> 'pickles')::int = 10
    and v_j -> 'paid' -> 'grants' -> 0 ->> 'cycle_id' = 'zq-old' and (v_j -> 'paid' -> 'grants' -> 0 ->> 'tier')::int = 1,
    coalesce(v_j ->> 'paid', v_j::text));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T5 block crashed', false, sqlerrm);
end $$;


-- ════ T6 track items: unbuyable, ungiftable, equippable by owners ═══════
do $$
declare
  v_bal  int;
  v_gbal int;
  v_e    jsonb;
begin
  v_bal := pg_temp.pickles('R');
  v_e := pg_temp.eval_as('R', $q$select public.buy_home_item('zq_cp_lamp')$q$);
  perform pg_temp.ok('T6 buying a track decor item is refused: pl:home.track_only, the tier and pass named',
    v_e ->> 'state' = 'P0001' and v_e ->> 'hint' = 'pl:home.track_only'
    and v_e ->> 'msg' = 'Zq Track Lamp is a Court Pass reward, so it isn''t sold in My Place and nothing was spent. Reach tier 5 on the Zq Court Pass to earn it.'
    and ((v_e ->> 'detail')::jsonb ->> 'tier')::int = 5 and (v_e ->> 'detail')::jsonb ->> 'cycle' = 'Zq Court Pass',
    v_e::text);
  perform pg_temp.ok('T6 ...no owned row, no pickles taken, no ledger row',
    not exists (select 1 from public.home_owned_items where owner_id = pg_temp.p('R'))
    and pg_temp.pickles('R') = v_bal
    and not exists (select 1 from public.pickle_ledger where profile_id = pg_temp.p('R') and source = 'buy_home_item'));
  v_e := pg_temp.eval_as('R', $q$select public.buy_home_item('zq_cp_prem')$q$);
  perform pg_temp.ok('T6 a premium-only item''s refusal promises nothing: coming soon, see the free rewards',
    v_e ->> 'hint' = 'pl:home.track_only'
    and v_e ->> 'msg' like '%premium track, which is coming soon, so it isn''t sold in My Place and nothing was spent. Open the Court Pass to see the free rewards you can earn.'
    and v_e ->> 'msg' not like '%Reach tier%' and v_e ->> 'msg' not like '%to earn it%'
    and v_e ->> 'msg' not ilike '%unlock%',
    v_e::text);

  v_gbal := pg_temp.pickles('G');
  v_e := pg_temp.eval_as('G', $q$select public.buy_home_item('zq_cp_lamp')$q$);
  perform pg_temp.ok('T6 the owner buying it again: already_owned true, nothing charged',
    (v_e -> 'v' ->> 'already_owned')::boolean and (v_e -> 'v' ->> 'cost')::int = 0 and pg_temp.pickles('G') = v_gbal,
    v_e::text);
  v_e := pg_temp.eval_as('G', $q$select public.equip_home_item('accent', 'zq_cp_lamp')$q$);
  perform pg_temp.ok('T6 the owner puts the lamp in My Place (equip_home_item)',
    v_e ? 'v' and exists (select 1 from public.home_equipped
                           where owner_id = pg_temp.p('G') and slot_id = 'accent' and item_id = 'zq_cp_lamp'),
    v_e::text);
  v_e := pg_temp.eval_as('G', format('select public.equip_shop_item(%L::uuid)', pg_temp.avatar_id()));
  perform pg_temp.ok('T6 the owner wears the track avatar (equip_shop_item)',
    v_e ? 'v' and (select avatar_emoji from public.profiles where id = pg_temp.p('G')) = '🧪', v_e::text);

  v_e := pg_temp.eval_as('R', $q$select public.equip_home_item('accent', 'zq_cp_lamp')$q$);
  perform pg_temp.ok('T6 a non-owner can''t put it in: home.not_owned', v_e ->> 'hint' = 'pl:home.not_owned', v_e::text);
  v_e := pg_temp.eval_as('R', format('select public.equip_shop_item(%L::uuid)', pg_temp.avatar_id()));
  perform pg_temp.ok('T6 a non-owner can''t wear it: shop.not_owned', v_e ->> 'hint' = 'pl:shop.not_owned', v_e::text);

  -- Two live bodies of each are possible: "Item not available" (inactive) or
  -- "Item not found" (the body that reads active items only).
  v_e := pg_temp.eval_as('R', format('select to_jsonb(x) from public.purchase_shop_item(%L::uuid) x', pg_temp.avatar_id()));
  perform pg_temp.ok('T6 purchase_shop_item refuses a track Shop item and charges nothing',
    not (v_e -> 'v' ->> 'success')::boolean and v_e -> 'v' ->> 'message' in ('Item not available', 'Item not found')
    and pg_temp.pickles('R') = v_bal
    and not exists (select 1 from public.player_shop_purchases where user_id = pg_temp.p('R')),
    v_e::text);
  v_e := pg_temp.eval_as('G', format('select to_jsonb(x) from public.gift_shop_item(%L::uuid, %L::uuid, null) x',
                                     pg_temp.avatar_id(), pg_temp.p('R')));
  perform pg_temp.ok('T6 gift_shop_item refuses it too and charges nothing',
    not (v_e -> 'v' ->> 'success')::boolean and v_e -> 'v' ->> 'message' in ('Item not available', 'Item not found')
    and pg_temp.pickles('G') = v_gbal
    and not exists (select 1 from public.player_shop_purchases where user_id = pg_temp.p('R')),
    v_e::text);
  v_e := pg_temp.eval_as('R', $q$select to_jsonb(count(*)) from public.shop_items
                                 where is_active = true and (slug like 'zq-cp-%' or slug like 'cp26__-%')$q$);
  perform pg_temp.ok('T6 the Shop''s list (is_active = true) has no track item', (v_e ->> 'v')::int = 0, v_e::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T6 block crashed', false, sqlerrm);
end $$;


-- ════ T7 cycle edges ═════════════════════════════════════════════════════
do $$
declare
  v_end   timestamptz := (select ends_at from public.reward_track_cycles where id = 'zq-now');
  v_start timestamptz := (select starts_at from public.reward_track_cycles where id = 'zq-now');
  v_next  timestamptz := (select starts_at from public.reward_track_cycles where id = 'zq-next');
begin
  perform pg_temp.led('E', 24, '_grant_match_game_bonus', v_end);
  perform pg_temp.led('E', 24, '_grant_match_game_bonus', v_start - interval '1 microsecond');
  perform pg_temp.ok('T7 an earn at ends_at, or just before starts_at (no pass then), earns nothing',
    pg_temp.xp('E') is null and pg_temp.all_events('E') = 0);
  perform pg_temp.led('E', 24, '_grant_match_game_bonus', v_end - interval '1 microsecond');
  perform pg_temp.ok('T7 the last instant before ends_at still counts', pg_temp.xp('E') = 12,
    'xp=' || coalesce(pg_temp.xp('E')::text, 'none'));
  perform pg_temp.led('E', 16, '_grant_match_game_bonus', v_next);
  perform pg_temp.ok('T7 an earn at the next pass''s start instant counts there, from 0',
    pg_temp.xp('E', 'zq-next') = 8 and pg_temp.xp('E') = 12);
  begin
    insert into public.reward_track_cycles (id, title, starts_at, ends_at)
    values ('zq-overlap', 'Zq Overlap', now(), now() + interval '1 day');
    perform pg_temp.ok('T7 an overlapping pass is refused', false, 'inserted');
  exception when exclusion_violation then
    perform pg_temp.ok('T7 an overlapping pass is refused', true);
  end;
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T7 block crashed', false, sqlerrm);
end $$;


-- ════ Before the re-run ══════════════════════════════════════════════════
insert into _snap
select k, pg_temp.xp(k), pg_temp.tier(k), pg_temp.grants(k), pg_temp.payouts(k), pg_temp.all_events(k) from _p;
-- The real seed (moved 500 years ahead by now): the re-run of the cycles file
-- must not move its items' available_until with it, or reactivate anything.
-- The catch-up re-runs too: it must skip itself (events exist), so the
-- whole events table, Q's November XP included, stays as it is.
create temp table _seed_snap as
select (select count(*) from public.reward_track_tiers where cycle_id in ('2026-11', '2026-12', '2027-01')) as tiers,
       (select count(*) from public.reward_track_rewards where cycle_id in ('2026-11', '2026-12', '2027-01')) as rewards,
       (select string_agg(s.slug || ':' || s.is_active || ':' || s.cost || ':' || s.payload::text, ',' order by s.slug)
          from public.shop_items s where s.slug like 'cp26__-%') as shop,
       (select string_agg(h.id || ':' || h.track_only || ':' || h.cost || ':' || h.is_starter || ':'
                          || coalesce(h.available_until::text, 'null'), ',' order by h.id)
          from public.home_items h where h.id like 'cp26__\_%') as home,
       (select count(*) || ':' || coalesce(sum(xp), 0) from public.reward_track_xp_events) as events,
       (select count(*) || ':' || coalesce(sum(xp), 0) from public.reward_track_xp) as xp,
       (select count(*) from public.reward_track_grants) as grants;

-- @@RERUN@@


-- ════ T8 the re-run changes nothing ══════════════════════════════════════
do $$
begin
  perform pg_temp.ok('T8 the catch-up re-run skipped itself: every event, XP row and grant (live players and Q''s November) is as it was',
    (select (s.events, s.xp, s.grants) is not distinct from (
              (select count(*) || ':' || coalesce(sum(xp), 0) from public.reward_track_xp_events),
              (select count(*) || ':' || coalesce(sum(xp), 0) from public.reward_track_xp),
              (select count(*) from public.reward_track_grants))
       from _seed_snap s)
    and pg_temp.xp('Q', '2026-11') = 350 and pg_temp.all_events('Q') = 11,
    (select 'before ' || s.events || ' / ' || s.xp || ' / ' || s.grants from _seed_snap s));
  perform pg_temp.ok('T8 after the re-run every persona''s XP, tier, grants, payouts and events are unchanged',
    not exists (select 1 from _snap s
                 where (s.xp, s.tier, s.grants, s.payouts, s.events) is distinct from
                       (pg_temp.xp(s.k), pg_temp.tier(s.k), pg_temp.grants(s.k), pg_temp.payouts(s.k), pg_temp.all_events(s.k))),
    (select string_agg(s.k, ',') from _snap s
      where (s.xp, s.tier, s.grants, s.payouts, s.events) is distinct from
            (pg_temp.xp(s.k), pg_temp.tier(s.k), pg_temp.grants(s.k), pg_temp.payouts(s.k), pg_temp.all_events(s.k))));
  perform pg_temp.ok('T8 exactly one XP trigger on pickle_ledger',
    (select count(*) from pg_trigger t join pg_proc f on f.oid = t.tgfoid
      where t.tgrelid = 'public.pickle_ledger'::regclass and not t.tgisinternal
        and f.proname = '_pl_track_on_pickle_ledger') = 1
    and exists (select 1 from pg_trigger where tgrelid = 'public.pickle_ledger'::regclass and tgname = 'trg_pickle_ledger_track_xp'));
  perform pg_temp.ok('T8 the allowlist holds exactly the 4 play sources, each at 0.5',
    (select count(*) from public.reward_track_xp_sources) = 4
    and (select count(*) from public.reward_track_xp_sources
          where xp_ratio = 0.5
            and source in ('_grant_match_game_bonus', '_grant_new_opponent_bonus', '_grant_checkin_match_bonus',
                           '_grant_tournament_participation_bonus')) = 4,
    (select string_agg(source || '=' || xp_ratio, ', ' order by source) from public.reward_track_xp_sources));
  perform pg_temp.ok('T8 the seed''s tiers, rewards and items are as they were (still inactive, track_only, off sale)',
    (select (s.tiers, s.rewards, s.shop, s.home) is not distinct from (
              (select count(*) from public.reward_track_tiers where cycle_id in ('2026-11', '2026-12', '2027-01')),
              (select count(*) from public.reward_track_rewards where cycle_id in ('2026-11', '2026-12', '2027-01')),
              (select string_agg(s2.slug || ':' || s2.is_active || ':' || s2.cost || ':' || s2.payload::text, ',' order by s2.slug)
                 from public.shop_items s2 where s2.slug like 'cp26__-%'),
              (select string_agg(h.id || ':' || h.track_only || ':' || h.cost || ':' || h.is_starter || ':'
                                 || coalesce(h.available_until::text, 'null'), ',' order by h.id)
                 from public.home_items h where h.id like 'cp26__\_%'))
       from _seed_snap s)
    and (select count(*) from public.shop_items where slug like 'cp26__-%') = 8
    and (select count(*) from public.home_items where id like 'cp26__\_%') = 16
    and not exists (select 1 from public.shop_items where slug like 'cp26__-%' and (is_active or cost <> 0))
    and not exists (select 1 from public.home_items
                     where id like 'cp26__\_%' and (not track_only or cost <> 0 or is_starter or available_until > now())));
  perform pg_temp.ok('T8 the test passes are where the test put them (the re-run moved no cycle)',
    (select count(*) from public.reward_track_cycles where id like 'zq-%') = 3
    and not exists (select 1 from public.reward_track_cycles where id not like 'zq-%' and starts_at < now() + interval '100 years'));
  -- An earn after the re-run still counts, once.
  perform pg_temp.led('W', 16, '_grant_match_game_bonus', now());
  perform pg_temp.ok('T8 an earn after the re-run adds its XP once', pg_temp.xp('W') = 107,
    'xp=' || coalesce(pg_temp.xp('W')::text, 'none'));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T8 block crashed', false, sqlerrm);
end $$;


-- ════ T9 the RPC contract ════════════════════════════════════════════════
do $$
declare
  v_j jsonb;
  v_n jsonb;
  v_r jsonb;
begin
  v_j := pg_temp.track('W');
  perform pg_temp.ok('T9 cycle: id, title, bounds, premium coming soon',
    v_j -> 'cycle' ->> 'id' = 'zq-now' and v_j -> 'cycle' ->> 'title' = 'Zq Court Pass'
    and (v_j -> 'cycle' ->> 'starts_at')::timestamptz = now() - interval '10 days'
    and (v_j -> 'cycle' ->> 'ends_at')::timestamptz = now() + interval '10 days'
    and v_j -> 'cycle' ->> 'premium_state' = 'coming_soon', coalesce(v_j ->> 'cycle', v_j::text));
  perform pg_temp.ok('T9 30 cumulative tiers, tier 30 = 1,360; next_starts_at = the next pass',
    jsonb_array_length(v_j -> 'tiers') = 30
    and (v_j -> 'tiers' -> 29 ->> 'xp_required')::int = 1360 and (v_j -> 'tiers' -> 0 ->> 'tier')::int = 1
    and (v_j ->> 'next_starts_at')::timestamptz = now() + interval '20 days');
  perform pg_temp.ok('T9 rewards: 30 free + 2 premium, each with tier, lane, kind, amount, item_key, title, rarity, item',
    jsonb_array_length(v_j -> 'rewards') = 32
    and (select count(*) from jsonb_array_elements(v_j -> 'rewards') r where r ->> 'lane' = 'premium') = 2
    and (select bool_and(r ?& array['tier', 'lane', 'kind', 'amount', 'item_key', 'title', 'rarity', 'item'])
           from jsonb_array_elements(v_j -> 'rewards') r));
  select r into v_r from jsonb_array_elements(v_j -> 'rewards') r where (r ->> 'tier')::int = 1 and r ->> 'lane' = 'free';
  perform pg_temp.ok('T9 a pickles reward: amount, title, no item_key, rarity or item',
    v_r ->> 'kind' = 'pickles' and (v_r ->> 'amount')::int = 10 and v_r ->> 'title' = '10 pickles'
    and v_r -> 'item_key' = 'null'::jsonb and v_r -> 'rarity' = 'null'::jsonb and v_r -> 'item' = 'null'::jsonb, v_r::text);
  select r into v_r from jsonb_array_elements(v_j -> 'rewards') r where (r ->> 'tier')::int = 5 and r ->> 'lane' = 'free';
  perform pg_temp.ok('T9 a My Place reward: item_key = the id, rarity from home_items, item {id, slot_group, art_aspect, icon}',
    v_r ->> 'kind' = 'home_item' and v_r ->> 'item_key' = 'zq_cp_lamp' and v_r ->> 'rarity' = 'common'
    and v_r -> 'item' ->> 'id' = 'zq_cp_lamp' and v_r -> 'item' ->> 'slot_group' = 'accent'
    and v_r -> 'item' ? 'art_aspect' and v_r -> 'item' ->> 'icon' = '🪔', v_r::text);
  select r into v_r from jsonb_array_elements(v_j -> 'rewards') r where (r ->> 'tier')::int = 6 and r ->> 'lane' = 'free';
  perform pg_temp.ok('T9 a Shop reward: item_key = the slug, item {id (uuid), category, slug, icon, payload}',
    v_r ->> 'kind' = 'shop_item' and v_r ->> 'item_key' = 'zq-cp-avatar' and v_r ->> 'rarity' = 'common'
    and (v_r -> 'item' ->> 'id')::uuid = pg_temp.avatar_id() and v_r -> 'item' ->> 'category' = 'avatar'
    and v_r -> 'item' ->> 'slug' = 'zq-cp-avatar' and v_r -> 'item' -> 'payload' ->> 'emoji' = '🧪', v_r::text);
  perform pg_temp.ok('T9 rarity falls back to the home item''s (tier 15 = rare)',
    (select r ->> 'rarity' from jsonb_array_elements(v_j -> 'rewards') r
      where (r ->> 'tier')::int = 15 and r ->> 'lane' = 'free') = 'rare');
  perform pg_temp.ok('T9 me: xp, tier, today_xp (today''s Pacific earns), daily_cap null (no cap), can_earn, not_earning null',
    (v_j -> 'me' ->> 'xp')::int = 107 and (v_j -> 'me' ->> 'tier')::int = 4
    and (v_j -> 'me' ->> 'today_xp')::int = 107 and v_j -> 'me' -> 'daily_cap' = 'null'::jsonb
    and (v_j -> 'me' ->> 'can_earn')::boolean and v_j -> 'me' -> 'not_earning' = 'null'::jsonb, v_j ->> 'me');
  perform pg_temp.ok('T9 the first open paid tiers 1-4: paid {pickles 40, 4 grants}; grants lists them (free, paid, unseen)',
    (v_j -> 'paid' ->> 'pickles')::int = 40 and jsonb_array_length(v_j -> 'paid' -> 'grants') = 4
    and (select bool_and(g ->> 'cycle_id' = 'zq-now' and g ->> 'kind' = 'pickles' and g ->> 'title' = '10 pickles')
           from jsonb_array_elements(v_j -> 'paid' -> 'grants') g)
    and jsonb_array_length(v_j -> 'grants') = 4
    and (select bool_and(g ->> 'lane' = 'free' and g ? 'granted_at' and g -> 'seen_at' = 'null'::jsonb)
           from jsonb_array_elements(v_j -> 'grants') g),
    v_j ->> 'paid');

  v_n := pg_temp.track('W', 'zq-no-such-pass');
  perform pg_temp.ok('T9 no pass: cycle null, empty lists, me zeros with daily_cap null, paid given, next_starts_at given',
    v_n -> 'cycle' = 'null'::jsonb and jsonb_array_length(v_n -> 'tiers') = 0
    and jsonb_array_length(v_n -> 'rewards') = 0 and jsonb_array_length(v_n -> 'grants') = 0
    and (v_n -> 'me' ->> 'xp')::int = 0 and v_n -> 'me' ? 'daily_cap' and v_n -> 'me' -> 'daily_cap' = 'null'::jsonb
    and (v_n -> 'paid' ->> 'pickles')::int = 0 and v_n ->> 'next_starts_at' is not null, v_n::text);

  v_n := pg_temp.track('U');
  perform pg_temp.ok('T9 a guest: can_earn false, not_earning guest',
    not (v_n -> 'me' ->> 'can_earn')::boolean and v_n -> 'me' ->> 'not_earning' = 'guest'
    and (v_n -> 'me' ->> 'xp')::int = 0, coalesce(v_n ->> 'me', v_n::text));
  v_n := pg_temp.track('T');
  perform pg_temp.ok('T9 a test account: can_earn false, not_earning test_account',
    not (v_n -> 'me' ->> 'can_earn')::boolean and v_n -> 'me' ->> 'not_earning' = 'test_account'
    and pg_temp.grants('T') = 0, coalesce(v_n ->> 'me', v_n::text));

  perform pg_temp.ok('T9 signed out (no user): both RPCs say pl:auth.signed_out',
    pg_temp.err_of('nouser', 'select public.get_reward_track(null)') like '%[pl:auth.signed_out]'
    and pg_temp.err_of('nouser', $q$select public.mark_track_rewards_seen('zq-now')$q$) like '%[pl:auth.signed_out]');
  perform pg_temp.ok('T9 mark_track_rewards_seen with no pass: pl:request.bad, with a reason and what to do',
    pg_temp.err_of('W', 'select public.mark_track_rewards_seen(null)') like '%Update Pickleague, then try again. [pl:request.bad]'
    and pg_temp.err_of('W', $q$select public.mark_track_rewards_seen('  ')$q$) like '%[pl:request.bad]');

  perform pg_temp.as_user(pg_temp.p('W'));
  perform public.mark_track_rewards_seen('zq-now');
  perform pg_temp.as_admin();
  v_j := pg_temp.track('W', 'zq-now');
  perform pg_temp.ok('T9 mark_track_rewards_seen marks only the caller''s paid grants',
    (select bool_and(g -> 'seen_at' <> 'null'::jsonb) from jsonb_array_elements(v_j -> 'grants') g)
    and not exists (select 1 from public.reward_track_grants where profile_id = pg_temp.p('W') and seen_at is null)
    and exists (select 1 from public.reward_track_grants where profile_id = pg_temp.p('G') and seen_at is null));
  perform pg_temp.ok('T9 nobody holds a premium grant',
    not exists (select 1 from public.reward_track_grants where lane = 'premium'));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T9 block crashed', false, sqlerrm);
end $$;


-- ════ T10 grants and RLS (after the hardening re-run) ════════════════════
do $$
declare
  v_n int;
begin
  perform pg_temp.ok('T10 the RPCs are callable by signed-in players only (the hardening re-run kept them)',
    has_function_privilege('authenticated', 'public.get_reward_track(text)', 'execute')
    and has_function_privilege('authenticated', 'public.mark_track_rewards_seen(text)', 'execute')
    and not has_function_privilege('anon', 'public.get_reward_track(text)', 'execute')
    and not has_function_privilege('anon', 'public.mark_track_rewards_seen(text)', 'execute')
    and has_function_privilege('authenticated', 'public.buy_home_item(text)', 'execute'));
  perform pg_temp.ok('T10 the helpers are internal (no client execute)',
    not exists (
      select 1 from unnest(array[
        'public._pl_track_pacific_month_start(date)', 'public._pl_track_current_cycle(timestamptz)',
        'public._pl_track_tier_for(text,integer)', 'public._pl_track_grant_reached(uuid,text)',
        'public._pl_track_add_xp(uuid,timestamptz,text,text,integer,integer)',
        'public._pl_track_xp_from_ledger(public.pickle_ledger)', 'public._pl_track_on_pickle_ledger()',
        'public._pl_track_settle(uuid)', 'public._pl_track_purge()']) f
       where has_function_privilege('authenticated', f, 'execute') or has_function_privilege('anon', f, 'execute')));
  perform pg_temp.ok('T10 anon can''t open the track',
    pg_temp.err_of('anon', 'select public.get_reward_track(null)') is not null);

  perform pg_temp.as_user(pg_temp.p('W'));
  select count(*) into v_n from public.reward_track_grants where profile_id <> auth.uid();
  perform pg_temp.as_admin();
  perform pg_temp.ok('T10 a player reads only their own grants', v_n = 0, 'others visible=' || v_n);
  perform pg_temp.as_user(pg_temp.p('W'));
  select count(*) into v_n from public.reward_track_xp where profile_id <> auth.uid();
  perform pg_temp.as_admin();
  perform pg_temp.ok('T10 ...and only their own XP', v_n = 0, 'others visible=' || v_n);
  perform pg_temp.as_user(pg_temp.p('R'));
  select count(*) into v_n from public.reward_track_tiers where cycle_id = 'zq-now';
  perform pg_temp.as_admin();
  perform pg_temp.ok('T10 the catalog (tiers) is readable by signed-in players', v_n = 30, 'tiers visible=' || v_n);

  perform pg_temp.ok('T10 a client can''t write XP, events, grants, cycles, rewards or sources, or read events or sources',
    pg_temp.err_of('R', $q$insert into public.reward_track_xp (profile_id, cycle_id, xp) values (auth.uid(), 'zq-now', 9999)$q$) is not null
    and pg_temp.err_of('R', $q$insert into public.reward_track_grants (profile_id, cycle_id, tier) values (auth.uid(), 'zq-now', 30)$q$) is not null
    and pg_temp.err_of('R', $q$update public.reward_track_cycles set daily_xp_cap = 100000$q$) is not null
    and pg_temp.err_of('R', $q$delete from public.reward_track_rewards$q$) is not null
    and pg_temp.err_of('R', $q$insert into public.reward_track_xp_sources (source) values ('submit_drill_review')$q$) is not null
    and pg_temp.err_of('R', $q$select count(*) from public.reward_track_xp_events$q$) is not null
    and pg_temp.err_of('R', $q$select count(*) from public.reward_track_xp_sources$q$) is not null
    and pg_temp.err_of('R', $q$select public._pl_track_add_xp(auth.uid(), now(), 'ledger', 'forged', 100, 200)$q$) is not null
    and pg_temp.err_of('R', $q$select public._pl_track_settle(auth.uid())$q$) is not null);
  perform pg_temp.ok('T10 R still has no XP and no grants after the attempts',
    pg_temp.xp('R') is null and pg_temp.grants('R') = 0
    and (select count(*) from public.reward_track_xp_sources) = 4);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T10 block crashed', false, sqlerrm);
end $$;


-- ════ T11 account deletion; an XP error never blocks a pickles change ═══
do $$
declare
  v_before int;
begin
  perform pg_temp.led('D', 40, '_grant_match_game_bonus', now());
  perform pg_temp.track('D');
  perform pg_temp.ok('T11 D has XP, an event and a paid grant before deleting the account',
    pg_temp.xp('D') = 20 and pg_temp.all_events('D') = 1 and pg_temp.grants('D') = 1 and pg_temp.unpaid('D') = 0);
  update public.profiles set deleted_at = now(), full_name = '[deleted account]' where id = pg_temp.p('D');
  perform pg_temp.ok('T11 deleting the account (the tombstone) removes their XP, events and grants',
    not exists (select 1 from public.reward_track_xp where profile_id = pg_temp.p('D'))
    and pg_temp.all_events('D') = 0
    and not exists (select 1 from public.reward_track_grants where profile_id = pg_temp.p('D')));

  -- Break the XP write on purpose: every event insert fails. Not when the
  -- events table is live (--applied, or a re-run after the tables file
  -- committed): the ALTER would hold ACCESS EXCLUSIVE on it (every earn and
  -- every Court Pass open) until the rollback. A run that makes the tables
  -- inside this transaction covers it.
  if current_setting('pickleague.cp_test_applied', true) = 'on' or (select tables_live from _pre) then
    perform pg_temp.ok('T11 with XP broken, a real match still pays K1 (ledger row, balance up) and adds no XP',
      true, 'skipped: reward_track_xp_events is live; the ALTER would lock it until the rollback');
    return;
  end if;
  alter table public.reward_track_xp_events add constraint cp_t11_fail check (xp < 0) not valid;
  v_before := pg_temp.pickles('K1');
  perform set_config('pickleague.skip_badge_pickle_grant', 'on', true);
  insert into public.matches (league_id, player1_id, player2_id, player1_score, player2_score, match_type, status, played_at)
  values (pg_temp.lg(), pg_temp.p('K1'), pg_temp.p('K2'), 11, 3, 'singles', 'completed', now());
  perform set_config('pickleague.skip_badge_pickle_grant', '', true);
  perform pg_temp.ok('T11 with XP broken, a real match still pays K1 (ledger row, balance up) and adds no XP',
    exists (select 1 from public.pickle_ledger
             where profile_id = pg_temp.p('K1') and source = '_grant_match_game_bonus' and delta = 40)
    and pg_temp.pickles('K1') - v_before >= 40
    and pg_temp.xp('K1') is null and pg_temp.all_events('K1') = 0,
    'paid=' || (pg_temp.pickles('K1') - v_before) || ' xp=' || coalesce(pg_temp.xp('K1')::text, 'none'));
  alter table public.reward_track_xp_events drop constraint cp_t11_fail;
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T11 block crashed', false, sqlerrm);
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
