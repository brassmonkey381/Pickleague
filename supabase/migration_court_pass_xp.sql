-- ============================================================
-- Court Pass, part 2: XP, grants, the payout and the client RPCs (needs
-- migration_court_pass_tables.sql; the passes themselves are
-- migration_court_pass_cycles_2026_11.sql and
-- migration_court_pass_cycles_2026_12_2027_01.sql).
--
-- Brian, 2026-11-03: "use the foundation we've built on doggle as a base",
-- and the same day: only real, repeatable play earns track XP. Nothing that
-- can be saved up or spammed (reviews, comments, posts), nothing one-time
-- (welcome, getting started, referrals), no bonus, gift, prize, shop or
-- admin rows. Port of Doggle 0498 (+ 0500's trim). Spec: docs/court-pass.md.
--
-- ── What earns (pickleballs) ──────────────────────────────────────────────
--   1. An AFTER INSERT trigger on pickle_ledger (positive rows). A non-gold
--      row whose source is in reward_track_xp_sources earns
--      floor(delta * xp_ratio): half the pickles actually paid (after the
--      500/day play cap, which the profiles trigger applies first):
--        _grant_match_game_bonus                 40 .. 5 a match  -> 20 .. 2
--        _grant_new_opponent_bonus               50               -> 25
--        _grant_checkin_match_bonus              25               -> 12
--        _grant_tournament_participation_bonus   50               -> 25
--      Left out on purpose (pickles, no pickleballs): the play streak, new
--      courts, badges, drill reviews (a logged drill pays through its
--      review), getting started, welcome, first match / doubles,
--      referrals, anniversaries, wagers, prizes, God mode, the Shop, refunds,
--      reversals, the season organiser (gold), and the track's own payout
--      (_pl_track_settle, gold).
--   2. Login: any positive row with source claim_daily_login_streak earns +5
--      once per Pacific date of created_at (source_ref = that date). Its
--      streak-badge row has the same key, so it adds nothing.
--   3. The cycle and the XP day come from the row's created_at, never now().
--   4. No daily cap (Brian, 2026-11-03, as Doggle 0501): every seeded cycle's
--      reward_track_cycles.daily_xp_cap is null and every earn counts in full.
--      (The pickles behind the play earns are still bounded by the 500/day
--      play cap.) A number in daily_xp_cap would still cap that cycle per
--      Pacific day, login included, and the capped earn would be recorded
--      with xp 0; nothing seeds one.
--   5. Guests (profiles.is_guest, expired guests too) and test accounts
--      (profiles.is_test_account) earn 0: no XP row, no events.
--   6. XP is never taken back: a negative row earns nothing and removes
--      nothing. A match deleted after it paid keeps its XP (fix forward).
--   7. The trigger body runs in EXCEPTION WHEN OTHERS: an XP bug logs a
--      warning and the pickles change itself still lands.
--
-- ── Grants and the payout ─────────────────────────────────────────────────
--   The trigger only records XP and grant rows (paid_at null). It never moves
--   pickles or items: ledger rows are written by a trigger on profiles, inside
--   the earn's own UPDATE, and some functions write absolute balances, so a
--   payout there could be lost or double-counted. _pl_track_settle pays them:
--   it runs at the start of get_reward_track (Home and the Court Pass screen
--   call it). For each unpaid free grant of the player, any cycle (a tier
--   reached on Dec 31 pays in January): claim it (UPDATE ... SET paid_at WHERE
--   paid_at IS NULL RETURNING) and pay only when a row came back:
--     pickles    a gold ledger row 'Court Pass tier N' (source _pl_track_settle,
--                0 XP, outside the play cap)
--     shop_item  player_shop_purchases at cost 0 (equip_shop_item takes it)
--     home_item  home_owned_items, source 'grant', cost 0
--   It first re-sweeps every cycle the player has XP in, so a grant row that
--   never landed is written and paid on the next open. The premium lane is
--   never granted. Granted rewards are never taken back.
--
-- ── Locks ─────────────────────────────────────────────────────────────────
--   Lock order everywhere: the player's profiles row, then their
--   reward_track_xp row (FOR UPDATE). An earn already holds the profiles row
--   when the ledger trigger runs (the change came from an UPDATE of profiles);
--   settle takes it first. So a match and a screen open queue, never deadlock.
--   Applying this file: CREATE OR REPLACE TRIGGER on pickle_ledger (SHARE ROW
--   EXCLUSIVE: pickles changes wait until the file's transaction ends, reads
--   don't), row upserts on reward_track_xp_sources. No ACCESS EXCLUSIVE.
--
-- ── Client RPCs (signed-in only; added to migration_rls_hardening_2026q3.sql's
--    allowlist; granted here too) ───────────────────────────────────────────
--   get_reward_track(p_cycle text default null) -> jsonb
--     Settles first (its own block: a failed payout logs a warning, shows the
--     screen anyway and retries on the next open), then the cycle p_cycle or
--     the one running now:
--     {cycle: {id, title, starts_at, ends_at, premium_state} | null,
--      next_starts_at, tiers: [{tier, xp_required}],
--      rewards: [{tier, lane, kind, amount, item_key, title, rarity, item}],
--      me: {xp, tier, today_xp, daily_cap (null: no cap), can_earn, not_earning},
--      grants: [{tier, lane, granted_at, seen_at}]   (free lane, paid only),
--      paid: {pickles, grants: [{cycle_id, tier, kind, title}]}}
--     item_key = shop_item_slug or home_item_id; item = {id (shop_items.id),
--     category, slug, icon, payload} for a Shop item, {id, slot_group,
--     art_aspect, icon} for a My Place item, null for pickles. rarity = the
--     reward's, else the home item's. not_earning = 'test_account' | 'guest' |
--     null (a test account that is also a guest reads test_account: finishing
--     sign-up wouldn't make it earn).
--   mark_track_rewards_seen(p_cycle text) -> void: the caller's paid, unseen
--     grants in p_cycle get seen_at.
--   Refusals (P0001, HINT pl:<code>): auth.signed_out (no session),
--   request.bad (mark_track_rewards_seen with no cycle).
--
-- New internal functions (execute revoked from public, anon, authenticated):
--   _pl_track_pacific_month_start(date), _pl_track_current_cycle(timestamptz),
--   _pl_track_tier_for(text, integer), _pl_track_grant_reached(uuid, text),
--   _pl_track_add_xp(uuid, timestamptz, text, text, integer, integer),
--   _pl_track_xp_from_ledger(public.pickle_ledger), _pl_track_on_pickle_ledger()
--   (trigger), _pl_track_settle(uuid).
-- Replaced: none.
--
-- Idempotent; no top-level transaction. Apply after
-- migration_court_pass_tables.sql, in ONE transaction with the cycles files
-- (migration_court_pass_cycles_2026_11.sql,
-- migration_court_pass_cycles_2026_12_2027_01.sql) and the catch-up
-- (supabase/court_pass_catchup_2026_11.sql: November started Nov 1 07:00Z,
-- before this went live): court-pass-apply.ps1. Then re-run
-- migration_rls_hardening_2026q3.sql.
-- Persona test: supabase/tests/court_pass_personas.sql
--   (node supabase/tests/build-court-pass-test.mjs <out.sql>).
-- ============================================================

do $$
begin
  if to_regclass('public.reward_track_xp_events') is null
     or to_regclass('public.reward_track_xp_sources') is null
     or to_regprocedure('public._pl_track_purge()') is null then
    raise exception 'migration_court_pass_xp.sql needs migration_court_pass_tables.sql applied first';
  end if;
end $$;


-- ════ 1. The XP allowlist ════════════════════════════════════════════════
-- Exactly these four (the persona test checks it; the app's How-to-earn copy
-- test pins this insert). Each is a trigger on matches or tournaments that
-- pays inside the 500/day play cap.
insert into public.reward_track_xp_sources (source, xp_ratio, note) values
  ('_grant_match_game_bonus',               0.5, 'a match: 40 x3, then 35 .. 5 a day, 3 per group in 12 h (migration_fair_rewards.sql §2)'),
  ('_grant_new_opponent_bonus',             0.5, 'a new opponent: 50, 3 in 7 days (migration_fair_rewards.sql §3)'),
  ('_grant_checkin_match_bonus',            0.5, 'a match within 4 h of a court check-in: 25 once a day (migration_fair_rewards.sql §3)'),
  ('_grant_tournament_participation_bonus', 0.5, 'a completed tournament with real play: 50 (migration_pickle_economy_guards.sql §5)')
on conflict (source) do update set xp_ratio = excluded.xp_ratio, note = excluded.note;


-- ════ 2. Helpers (internal) ══════════════════════════════════════════════
-- Pacific midnight starting p_day's month: Dec 1 2026 = 08:00Z (PST), Nov 1
-- 2026 = 07:00Z (PDT). Use this (or at time zone), never a hard-coded hour.
create or replace function public._pl_track_pacific_month_start(p_day date)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select (p_day - (extract(day from p_day)::integer - 1))::timestamp at time zone 'America/Los_Angeles'
$$;
revoke execute on function public._pl_track_pacific_month_start(date) from public, anon, authenticated;

-- The cycle running at p_at (cycles never overlap), or null.
create or replace function public._pl_track_current_cycle(p_at timestamptz)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select c.id from public.reward_track_cycles c
   where c.starts_at <= p_at and p_at < c.ends_at
   limit 1
$$;
revoke execute on function public._pl_track_current_cycle(timestamptz) from public, anon, authenticated;

-- The highest tier of p_cycle whose cumulative xp_required is <= p_xp (0 = none yet).
create or replace function public._pl_track_tier_for(p_cycle text, p_xp integer)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(max(t.tier), 0) from public.reward_track_tiers t
   where t.cycle_id = p_cycle and t.xp_required <= p_xp
$$;
revoke execute on function public._pl_track_tier_for(text, integer) from public, anon, authenticated;

-- Write a free-lane grant row (paid_at null) for every tier of p_cycle the
-- player has reached and has no grant for. Pays nothing (_pl_track_settle
-- does). Returns how many rows it wrote. The tier is re-read from the XP, so
-- lowering a cycle's tiers (SQL only) grants the newly reached tiers on the
-- next earn or open.
create or replace function public._pl_track_grant_reached(p_profile uuid, p_cycle text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_xp   integer;
  v_old  integer;
  v_tier integer;
  v_n    integer;
begin
  -- Profiles first, then the XP row (header: Locks).
  perform 1 from public.profiles p where p.id = p_profile for update;
  select x.xp, x.tier into v_xp, v_old from public.reward_track_xp x
   where x.profile_id = p_profile and x.cycle_id = p_cycle
   for update;
  if not found then
    return 0;
  end if;

  v_tier := public._pl_track_tier_for(p_cycle, v_xp);
  if v_tier is distinct from v_old then
    update public.reward_track_xp set tier = v_tier, updated_at = now()
     where profile_id = p_profile and cycle_id = p_cycle;
  end if;

  insert into public.reward_track_grants (profile_id, cycle_id, tier, lane)
  select p_profile, p_cycle, rw.tier, 'free'
    from public.reward_track_rewards rw
   where rw.cycle_id = p_cycle and rw.lane = 'free' and rw.tier <= v_tier
  on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke execute on function public._pl_track_grant_reached(uuid, text) from public, anon, authenticated;

-- Add p_xp XP for one earn at p_at. Returns the XP added: 0 for no cycle at
-- p_at, a guest or test account, or an earn already counted. No cap: a cycle
-- with daily_xp_cap null (every seeded one) counts every earn in full; a
-- number would cap its Pacific day (the capped earn recorded at 0 XP). Then
-- writes any grant rows reached (never a payout).
create or replace function public._pl_track_add_xp(
  p_profile    uuid,
  p_at         timestamptz,
  p_source     text,
  p_source_ref text,
  p_xp         integer,
  p_pickles    integer default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cycle text;
  v_cap   integer;
  v_day   date := (p_at at time zone 'America/Los_Angeles')::date;
  v_test  boolean;
  v_guest boolean;
  v_today integer;
  v_add   integer;
  v_id    bigint;
begin
  if p_profile is null or p_at is null or p_source is null or p_source_ref is null or coalesce(p_xp, 0) <= 0 then
    return 0;
  end if;
  v_cycle := public._pl_track_current_cycle(p_at);
  if v_cycle is null then
    return 0;
  end if;

  -- Profiles first, then the XP row (header: Locks).
  select coalesce(p.is_test_account, false), coalesce(p.is_guest, false) into v_test, v_guest
    from public.profiles p
   where p.id = p_profile and p.deleted_at is null
   for update;
  if not found or v_test or v_guest then
    return 0;
  end if;
  select c.daily_xp_cap into v_cap from public.reward_track_cycles c where c.id = v_cycle;

  insert into public.reward_track_xp (profile_id, cycle_id) values (p_profile, v_cycle)
  on conflict do nothing;
  perform 1 from public.reward_track_xp x
   where x.profile_id = p_profile and x.cycle_id = v_cycle
   for update;

  -- No cap (null, every seeded cycle): every earn counts in full. A cycle
  -- with a cap is summed under the lock, so two earns at once can't both fit.
  if v_cap is null then
    v_add := p_xp;
  else
    select coalesce(sum(e.xp), 0) into v_today from public.reward_track_xp_events e
     where e.profile_id = p_profile and e.cycle_id = v_cycle and e.xp_day = v_day;
    v_add := greatest(0, least(p_xp, v_cap - v_today));
  end if;

  insert into public.reward_track_xp_events (profile_id, cycle_id, source, source_ref, xp_day, pickles, xp)
  values (p_profile, v_cycle, p_source, p_source_ref, v_day, p_pickles, v_add)
  on conflict do nothing
  returning id into v_id;
  if v_id is null then
    return 0;  -- this earn already counted
  end if;

  if v_add > 0 then
    update public.reward_track_xp set xp = xp + v_add, updated_at = now()
     where profile_id = p_profile and cycle_id = v_cycle;
  end if;
  perform public._pl_track_grant_reached(p_profile, v_cycle);
  return v_add;
end $$;
revoke execute on function public._pl_track_add_xp(uuid, timestamptz, text, text, integer, integer) from public, anon, authenticated;


-- ════ 3. The pickle_ledger trigger ═══════════════════════════════════════
-- One ledger row's XP, shared by the trigger and the catch-up
-- (supabase/court_pass_catchup_2026_11.sql).
create or replace function public._pl_track_xp_from_ledger(p_row public.pickle_ledger)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_login_xp constant int := 5;
  v_ratio  numeric;
begin
  begin
    if p_row.delta is null or p_row.delta <= 0 then
      return;
    end if;

    -- The daily login reward (gold): +5 once per Pacific day of the row,
    -- whatever day the player's own zone says.
    if p_row.source = 'claim_daily_login_streak' then
      perform public._pl_track_add_xp(p_row.profile_id, p_row.created_at, 'login',
        ((p_row.created_at at time zone 'America/Los_Angeles')::date)::text, c_login_xp, null);
      return;
    end if;

    -- Every other gold row earns nothing (an allowlisted source labelled gold
    -- through pl.pickle_bonus too).
    if p_row.is_bonus then
      return;
    end if;

    select s.xp_ratio into v_ratio from public.reward_track_xp_sources s where s.source = p_row.source;
    if v_ratio is null then
      return;
    end if;
    perform public._pl_track_add_xp(p_row.profile_id, p_row.created_at, 'ledger', p_row.id::text,
      floor(p_row.delta * v_ratio)::integer, p_row.delta);
  exception when others then
    -- Never block the pickles change: it lands, the XP is skipped (fix forward).
    raise warning 'court pass: no XP for pickle_ledger row % (%: %)', p_row.id, sqlstate, sqlerrm;
  end;
end $$;
revoke execute on function public._pl_track_xp_from_ledger(public.pickle_ledger) from public, anon, authenticated;

create or replace function public._pl_track_on_pickle_ledger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public._pl_track_xp_from_ledger(new);
  return null;
end $$;
revoke execute on function public._pl_track_on_pickle_ledger() from public, anon, authenticated;

-- CREATE OR REPLACE TRIGGER, never DROP + CREATE: dropping takes ACCESS
-- EXCLUSIVE on pickle_ledger, which would hold up every pickles change and
-- the history reads until the file's transaction ends.
create or replace trigger trg_pickle_ledger_track_xp
  after insert on public.pickle_ledger
  for each row
  when (new.delta > 0)
  execute function public._pl_track_on_pickle_ledger();


-- ════ 4. The payout ══════════════════════════════════════════════════════
-- Pays every reached, unpaid free-lane grant of the player, in any cycle.
-- Returns {pickles: <sum paid>, grants: [{cycle_id, tier, kind, title}]}.
create or replace function public._pl_track_settle(p_profile uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cycle   text;
  v_got     integer;
  v_pickles integer := 0;
  v_grants  jsonb := '[]'::jsonb;
  r         record;
begin
  -- Profiles first, then the XP rows (header: Locks).
  perform 1 from public.profiles p where p.id = p_profile and p.deleted_at is null for update;
  if not found then
    return jsonb_build_object('pickles', 0, 'grants', '[]'::jsonb);
  end if;

  -- A grant row that never landed (or tiers lowered by SQL) is written now.
  for v_cycle in
    select x.cycle_id from public.reward_track_xp x
     where x.profile_id = p_profile and x.xp > 0
     order by x.cycle_id
  loop
    perform public._pl_track_grant_reached(p_profile, v_cycle);
  end loop;

  for r in
    select g.cycle_id, g.tier, rw.kind, rw.amount, rw.shop_item_slug, rw.home_item_id, rw.title
      from public.reward_track_grants g
      join public.reward_track_rewards rw on rw.cycle_id = g.cycle_id and rw.tier = g.tier and rw.lane = g.lane
      join public.reward_track_cycles c on c.id = g.cycle_id
     where g.profile_id = p_profile and g.lane = 'free' and g.paid_at is null
     order by c.starts_at, g.tier
  loop
    -- Claim it first: pay only when this call set paid_at.
    v_got := null;
    update public.reward_track_grants g set paid_at = now()
     where g.profile_id = p_profile and g.cycle_id = r.cycle_id and g.tier = r.tier and g.lane = 'free'
       and g.paid_at is null
    returning g.tier into v_got;
    continue when v_got is null;

    if r.kind = 'pickles' then
      -- One gold ledger row per tier (migration_pickle_ledger.sql rule 5).
      perform set_config('pl.pickle_reason', 'Court Pass tier ' || r.tier, true);
      perform set_config('pl.pickle_bonus', 'true', true);
      perform set_config('pl.pickle_meta', jsonb_build_object('cycle_id', r.cycle_id, 'tier', r.tier)::text, true);
      update public.profiles set pickles = coalesce(pickles, 0) + r.amount where id = p_profile;
      perform set_config('pl.pickle_reason', '', true);
      perform set_config('pl.pickle_bonus', '', true);
      perform set_config('pl.pickle_meta', '', true);
      v_pickles := v_pickles + r.amount;
    elsif r.kind = 'shop_item' then
      insert into public.player_shop_purchases (user_id, shop_item_id, cost_paid)
      select p_profile, s.id, 0 from public.shop_items s where s.slug = r.shop_item_slug
      on conflict (user_id, shop_item_id) do nothing;
    elsif r.kind = 'home_item' then
      insert into public.home_owned_items (owner_id, item_id, cost_paid, source)
      values (p_profile, r.home_item_id, 0, 'grant')
      on conflict do nothing;
    end if;

    v_grants := v_grants || jsonb_build_array(jsonb_build_object(
      'cycle_id', r.cycle_id, 'tier', r.tier, 'kind', r.kind, 'title', r.title));
  end loop;

  return jsonb_build_object('pickles', v_pickles, 'grants', v_grants);
end $$;
revoke execute on function public._pl_track_settle(uuid) from public, anon, authenticated;


-- ════ 5. Client RPCs ═════════════════════════════════════════════════════
-- The track for p_cycle (null: the one running now), after paying every tier
-- the caller reached and wasn't paid for. No cycle: cycle null, empty lists,
-- and next_starts_at for "Next Court Pass starts December 1". me.daily_cap is
-- the cycle's daily_xp_cap: null = no cap (the app then shows "Today: N
-- pickleballs.").
create or replace function public.get_reward_track(p_cycle text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me    uuid := auth.uid();
  v_c     public.reward_track_cycles;
  v_next  timestamptz;
  v_day   date := (now() at time zone 'America/Los_Angeles')::date;
  v_paid  jsonb := jsonb_build_object('pickles', 0, 'grants', '[]'::jsonb);
  v_not   text;
  v_xp    integer := 0;
  v_tier  integer := 0;
  v_today integer := 0;
begin
  if v_me is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;

  -- A failed payout must not hide the screen; it retries on the next open.
  begin
    v_paid := public._pl_track_settle(v_me);
  exception when others then
    raise warning 'get_reward_track: the Court Pass payout failed for % (%: %)', v_me, sqlstate, sqlerrm;
    v_paid := jsonb_build_object('pickles', 0, 'grants', '[]'::jsonb);
  end;

  select case when coalesce(p.is_test_account, false) then 'test_account'
              when coalesce(p.is_guest, false) then 'guest' end
    into v_not
    from public.profiles p where p.id = v_me;

  if p_cycle is null then
    select * into v_c from public.reward_track_cycles c
     where c.starts_at <= now() and now() < c.ends_at
     limit 1;
  else
    select * into v_c from public.reward_track_cycles c where c.id = p_cycle;
  end if;
  select min(c.starts_at) into v_next from public.reward_track_cycles c where c.starts_at > now();

  if v_c.id is null then
    return jsonb_build_object(
      'cycle', null, 'next_starts_at', v_next,
      'tiers', '[]'::jsonb, 'rewards', '[]'::jsonb,
      'me', jsonb_build_object('xp', 0, 'tier', 0, 'today_xp', 0, 'daily_cap', null,
                               'can_earn', v_not is null, 'not_earning', v_not),
      'grants', '[]'::jsonb,
      'paid', v_paid);
  end if;

  select x.xp, x.tier into v_xp, v_tier from public.reward_track_xp x
   where x.profile_id = v_me and x.cycle_id = v_c.id;
  select coalesce(sum(e.xp), 0) into v_today from public.reward_track_xp_events e
   where e.profile_id = v_me and e.cycle_id = v_c.id and e.xp_day = v_day;

  return jsonb_build_object(
    'cycle', jsonb_build_object(
      'id', v_c.id, 'title', v_c.title, 'starts_at', v_c.starts_at, 'ends_at', v_c.ends_at,
      'premium_state', v_c.premium_state),
    'next_starts_at', v_next,
    'tiers', coalesce((
      select jsonb_agg(jsonb_build_object('tier', t.tier, 'xp_required', t.xp_required) order by t.tier)
        from public.reward_track_tiers t where t.cycle_id = v_c.id), '[]'::jsonb),
    'rewards', coalesce((
      select jsonb_agg(jsonb_build_object(
               'tier', r.tier, 'lane', r.lane, 'kind', r.kind, 'amount', r.amount,
               'item_key', coalesce(r.shop_item_slug, r.home_item_id), 'title', r.title,
               'rarity', coalesce(r.rarity, hi.rarity),
               'item', case
                 when s.id is not null then jsonb_build_object(
                   'id', s.id, 'category', s.category, 'slug', s.slug, 'icon', s.icon, 'payload', s.payload)
                 when hi.id is not null then jsonb_build_object(
                   'id', hi.id, 'slot_group', hi.slot_group, 'art_aspect', hi.art_aspect, 'icon', hi.icon)
               end)
             order by r.tier, r.lane)
        from public.reward_track_rewards r
        left join public.shop_items s on s.slug = r.shop_item_slug
        left join public.home_items hi on hi.id = r.home_item_id
       where r.cycle_id = v_c.id), '[]'::jsonb),
    'me', jsonb_build_object(
      'xp', coalesce(v_xp, 0), 'tier', coalesce(v_tier, 0), 'today_xp', v_today,
      'daily_cap', v_c.daily_xp_cap, 'can_earn', v_not is null, 'not_earning', v_not),
    'grants', coalesce((
      select jsonb_agg(jsonb_build_object(
               'tier', g.tier, 'lane', g.lane, 'granted_at', g.granted_at, 'seen_at', g.seen_at)
             order by g.tier)
        from public.reward_track_grants g
       where g.profile_id = v_me and g.cycle_id = v_c.id and g.lane = 'free'
         and g.paid_at is not null), '[]'::jsonb),
    'paid', v_paid);
end $$;
revoke all on function public.get_reward_track(text) from public, anon;
grant execute on function public.get_reward_track(text) to authenticated;

-- The caller has seen the celebration for every reward paid so far in p_cycle.
create or replace function public.mark_track_rewards_seen(p_cycle text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;
  if p_cycle is null or btrim(p_cycle) = '' then
    raise exception using
      message = 'That didn''t go through because this version of Pickleague sent an incomplete request. Update Pickleague, then try again.',
      hint    = 'pl:request.bad';
  end if;
  update public.reward_track_grants g set seen_at = now()
   where g.profile_id = v_me and g.cycle_id = p_cycle and g.paid_at is not null and g.seen_at is null;
end $$;
revoke all on function public.mark_track_rewards_seen(text) from public, anon;
grant execute on function public.mark_track_rewards_seen(text) to authenticated;

notify pgrst, 'reload schema';
