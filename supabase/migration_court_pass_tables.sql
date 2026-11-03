-- ============================================================
-- Court Pass, part 1: the tables (Pickleague's monthly reward track).
--
-- Brian, 2026-11-03: "use the foundation we've built on doggle as a base".
-- Court Pass is Doggle's Park Pass (db/migrations/0497-0500), ported. Build
-- spec: docs/court-pass.md. Plan: expo-foundation docs/reward-track-plan.md
-- (Pickleague section). The XP trigger, the payout and the client RPCs are
-- migration_court_pass_xp.sql; November 2026 is
-- migration_court_pass_cycles_2026_11.sql, December 2026 and January 2027 are
-- migration_court_pass_cycles_2026_12_2027_01.sql.
--
-- Every month a 30-tier track opens. Pickles the server already pays for
-- real, repeatable play also earn track XP ("pickleballs"). Each tier pays a
-- free reward; the premium lane is display only ("Premium track coming
-- soon"): its rows are shown, never granted, and nothing here sells them.
--
-- ── New tables (RLS on all; no client writes; every write is a SECURITY
--    DEFINER function in migration_court_pass_xp.sql) ─────────────────────
--   reward_track_cycles      one row per month: id 'YYYY-MM', Pacific-midnight
--                            bounds, premium_state coming_soon | off, and an
--                            optional daily XP cap: null = no cap (Brian,
--                            2026-11-03: every seeded cycle is null, as Doggle
--                            0501). Two cycles may not overlap, so a
--                            timestamp names at most one cycle.
--   reward_track_tiers       cumulative XP per tier, per cycle.
--   reward_track_rewards     one reward per (cycle, tier, lane): pickles (paid
--                            as a gold bonus row), a Shop item (shop_items.slug)
--                            or a My Place item (home_items.id).
--   reward_track_xp          a player's XP and tier in a cycle.
--   reward_track_xp_events   every earn, once: unique (profile, cycle, source,
--                            source_ref). source 'ledger' = a pickle_ledger id,
--                            'login' = the Pacific date. xp_day (Pacific) feeds
--                            a cycle's daily cap when it has one, and the
--                            screen's "Today" line. pickles = the ledger row's delta.
--   reward_track_grants      a tier reached (granted_at) and paid (paid_at).
--                            The primary key is the guard: a tier is granted
--                            once, ever, and paid once (paid_at claims it).
--   reward_track_xp_sources  which pickle_ledger sources earn XP, at what
--                            ratio (seeded in migration_court_pass_xp.sql). In
--                            place of the plan's pickle_ledger_sources.track_xp
--                            column: adding a column there would take ACCESS
--                            EXCLUSIVE on a table the capture trigger reads on
--                            every pickles change, for this file's transaction.
--   Read: signed-in players read cycles, tiers and rewards; a player reads
--   their own xp and grants. Events and sources: server only (no policy).
--
-- ── Other changes ─────────────────────────────────────────────────────────
--   * home_items.track_only: a My Place item earned on the Court Pass, never
--     sold. Track items are also seeded with an available_until already past
--     (the cycles files: a month before the cycle starts), so app builds from
--     before this hide them from non-owners (decorRows lists an ended item
--     only for its owner).
--   * buy_home_item(text) REPLACED: migration_my_place.sql's body, unchanged
--     except one marked block. A track item is refused before the drop-window
--     checks, so the player reads why and where to earn it instead of "its
--     drop has ended": HINT pl:home.track_only, DETAIL {item, tier, cycle}.
--     check-replaced-functions.mjs lists it.
--   * Track Shop items are seeded is_active = false (the cycles files):
--     purchase_shop_item and gift_shop_item already refuse an inactive item
--     ("Item not available") and the Shop lists active items only, so neither
--     is replaced (each has two candidate live bodies: a drift risk this
--     doesn't need). equip_shop_item already accepts an owned inactive item.
--   * pickle_ledger_sources gains ('_pl_track_settle', +1): the payout's gold
--     row reads "Court Pass reward" (the payout names the tier itself through
--     pl.pickle_reason: "Court Pass tier 7"). Category 'track' is new; the app
--     ignores categories.
--   * Account deletion: _purge_account tombstones the profile (deleted_at set),
--     so the FKs' on delete cascade never fires. trg_profiles_track_purge
--     (AFTER UPDATE on profiles WHEN deleted_at becomes non-null:
--     migration_my_place.sql §10's pattern) deletes the player's xp, events and
--     grants. _purge_account itself is not replaced.
--
-- New internal function (execute revoked from public, anon, authenticated):
--   _pl_track_purge() (trigger).
-- Replaced: buy_home_item(text) (migration_my_place.sql).
--
-- ── Locks ─────────────────────────────────────────────────────────────────
--   New tables, plus: ALTER TABLE home_items ADD COLUMN IF NOT EXISTS (ACCESS
--   EXCLUSIVE on home_items, a low-traffic catalog, even on a re-run), one
--   CREATE OR REPLACE TRIGGER on profiles (SHARE ROW EXCLUSIVE: profile writes
--   wait until the file's transaction ends, reads don't), a row upsert on
--   pickle_ledger_sources. RLS, policies, the no-overlap constraint and the
--   indexes are created only when missing, so a re-run takes no ACCESS
--   EXCLUSIVE (or SHARE) lock on the track tables, which the XP trigger reads
--   and writes on every pickles change.
--
-- Idempotent; no top-level transaction. Apply first of the Court Pass files,
-- with court-pass-apply.ps1 (or by hand):
--   supabase db query --linked -f supabase/migration_court_pass_tables.sql
-- Persona test: supabase/tests/court_pass_personas.sql
--   (node supabase/tests/build-court-pass-test.mjs <out.sql>).
-- ============================================================


-- ════ 1. The catalog: cycles, tiers, rewards ═════════════════════════════
create table if not exists public.reward_track_cycles (
  id            text primary key,                 -- 'YYYY-MM', the month it runs
  title         text not null,                    -- 'December Court Pass'
  starts_at     timestamptz not null,             -- Pacific midnight on the 1st
  ends_at       timestamptz not null,             -- Pacific midnight on the next 1st (exclusive)
  premium_state text not null default 'coming_soon',
  daily_xp_cap  integer,                          -- null = no cap (every seeded cycle); a number caps a Pacific day, login included
  created_at    timestamptz not null default now(),
  constraint reward_track_cycles_id_chk check (id ~ '^[A-Za-z0-9_-]{1,32}$'),
  constraint reward_track_cycles_window_chk check (ends_at > starts_at),
  constraint reward_track_cycles_premium_state_chk check (premium_state in ('coming_soon', 'off')),
  constraint reward_track_cycles_cap_chk check (daily_xp_cap is null or daily_xp_cap > 0)
);
comment on table public.reward_track_cycles is
  'migration_court_pass_tables.sql: one Court Pass per month. Bounds are Pacific midnight (at time zone ''America/Los_Angeles''), never hard-coded UTC. Cycles never overlap. daily_xp_cap null = no daily cap.';

-- At most one cycle at any moment, so _pl_track_current_cycle(ts) can't be
-- ambiguous. Added only when missing: a re-add on every run would take ACCESS
-- EXCLUSIVE on a table the XP trigger reads on every pickles change.
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.reward_track_cycles'::regclass
                    and conname = 'reward_track_cycles_no_overlap') then
    alter table public.reward_track_cycles add constraint reward_track_cycles_no_overlap
      exclude using gist (tstzrange(starts_at, ends_at, '[)') with &&);
  end if;
end $$;

create table if not exists public.reward_track_tiers (
  cycle_id    text    not null references public.reward_track_cycles (id) on delete cascade,
  tier        integer not null,
  xp_required integer not null,                   -- cumulative: tier 1 = 10, tier 30 = 1,360
  primary key (cycle_id, tier),
  constraint reward_track_tiers_tier_chk check (tier between 1 and 100),
  constraint reward_track_tiers_xp_chk check (xp_required > 0)
);
comment on table public.reward_track_tiers is
  'migration_court_pass_tables.sql: the cumulative XP (pickleballs) each Court Pass tier needs.';

create table if not exists public.reward_track_rewards (
  cycle_id       text    not null,
  tier           integer not null,
  lane           text    not null,
  kind           text    not null,
  amount         integer,                         -- pickles, for kind 'pickles'
  shop_item_slug text references public.shop_items (slug),   -- for kind 'shop_item'
  home_item_id   text references public.home_items (id),     -- for kind 'home_item'
  title          text    not null,                -- '40 pickles', 'Snow Day'
  rarity         text,                            -- null: the item's own (home_items.rarity); Shop items have none
  primary key (cycle_id, tier, lane),
  foreign key (cycle_id, tier) references public.reward_track_tiers (cycle_id, tier) on delete cascade,
  constraint reward_track_rewards_lane_chk check (lane in ('free', 'premium')),
  constraint reward_track_rewards_kind_chk check (
    (kind = 'pickles' and amount is not null and amount > 0 and shop_item_slug is null and home_item_id is null)
    or (kind = 'shop_item' and shop_item_slug is not null and home_item_id is null)
    or (kind = 'home_item' and home_item_id is not null and shop_item_slug is null)
  ),
  constraint reward_track_rewards_rarity_chk check (rarity is null or rarity in ('common', 'rare', 'legendary')),
  constraint reward_track_rewards_title_chk check (btrim(title) <> '')
);
comment on table public.reward_track_rewards is
  'migration_court_pass_tables.sql: one reward per Court Pass tier and lane. The free lane is paid by _pl_track_settle; the premium lane is display only (coming soon) and never granted.';


-- ════ 2. Progress (per player) ═══════════════════════════════════════════
create table if not exists public.reward_track_xp (
  profile_id uuid    not null references public.profiles (id) on delete cascade,
  cycle_id   text    not null references public.reward_track_cycles (id) on delete cascade,
  xp         integer not null default 0,
  tier       integer not null default 0,          -- highest tier whose xp_required <= xp
  updated_at timestamptz not null default now(),
  primary key (profile_id, cycle_id),
  constraint reward_track_xp_nonneg_chk check (xp >= 0 and tier >= 0)
);
comment on table public.reward_track_xp is
  'migration_court_pass_tables.sql: a player''s Court Pass XP (pickleballs) and tier per cycle. Never taken back.';

create table if not exists public.reward_track_xp_events (
  id         bigint generated always as identity primary key,
  profile_id uuid    not null references public.profiles (id) on delete cascade,
  cycle_id   text    not null references public.reward_track_cycles (id) on delete cascade,
  source     text    not null,                    -- 'ledger' | 'login'
  source_ref text    not null,                    -- pickle_ledger.id | the Pacific date
  xp_day     date    not null,                    -- the Pacific day of the earn
  pickles    integer,                             -- the ledger row's delta (null for login)
  xp         integer not null,                    -- what it added (0 at the daily cap)
  created_at timestamptz not null default now(),
  constraint reward_track_xp_events_once unique (profile_id, cycle_id, source, source_ref),
  constraint reward_track_xp_events_source_chk check (source in ('ledger', 'login')),
  constraint reward_track_xp_events_xp_chk check (xp >= 0)
);
comment on table public.reward_track_xp_events is
  'migration_court_pass_tables.sql: every Court Pass earn, once. Server only: the screen''s today total (and a cycle''s daily cap, when it has one) reads it.';

create table if not exists public.reward_track_grants (
  profile_id uuid    not null references public.profiles (id) on delete cascade,
  cycle_id   text    not null references public.reward_track_cycles (id) on delete cascade,
  tier       integer not null,
  lane       text    not null default 'free',
  granted_at timestamptz not null default now(),  -- the tier was reached (the XP trigger writes it)
  paid_at    timestamptz,                         -- _pl_track_settle paid it (same transaction as the payment)
  seen_at    timestamptz,                         -- the celebration was shown (mark_track_rewards_seen)
  primary key (profile_id, cycle_id, tier, lane),
  constraint reward_track_grants_lane_chk check (lane in ('free', 'premium'))
);
comment on table public.reward_track_grants is
  'migration_court_pass_tables.sql: a Court Pass tier a player reached (granted_at) and was paid for (paid_at). The primary key means once, ever.';

-- Which pickle_ledger sources earn XP. A positive, non-gold ledger row whose
-- source (the nearest function on the call stack, migration_pickle_ledger.sql
-- rule 2) is listed earns floor(delta * xp_ratio). Seeded in
-- migration_court_pass_xp.sql.
create table if not exists public.reward_track_xp_sources (
  source   text primary key,
  xp_ratio numeric(4, 2) not null default 0.5,
  note     text,
  constraint reward_track_xp_sources_ratio_chk check (xp_ratio > 0 and xp_ratio <= 5)
);
comment on table public.reward_track_xp_sources is
  'migration_court_pass_tables.sql: the pickle_ledger sources that earn Court Pass XP (real, repeatable play only). Server only.';

-- Indexes, only when missing (CREATE INDEX IF NOT EXISTS still takes SHARE on
-- an existing table, which would hold up the XP trigger's writes).
do $$
begin
  if to_regclass('public.reward_track_xp_events_day_idx') is null then
    create index reward_track_xp_events_day_idx on public.reward_track_xp_events (profile_id, cycle_id, xp_day);
  end if;
  if to_regclass('public.reward_track_grants_unpaid_idx') is null then
    create index reward_track_grants_unpaid_idx on public.reward_track_grants (profile_id) where paid_at is null;
  end if;
  if to_regclass('public.reward_track_rewards_home_item_idx') is null then
    create index reward_track_rewards_home_item_idx on public.reward_track_rewards (home_item_id) where home_item_id is not null;
  end if;
  if to_regclass('public.reward_track_rewards_shop_item_idx') is null then
    create index reward_track_rewards_shop_item_idx on public.reward_track_rewards (shop_item_slug) where shop_item_slug is not null;
  end if;
end $$;


-- ════ 3. RLS and grants ══════════════════════════════════════════════════
-- RLS and the read policies only when missing (no ACCESS EXCLUSIVE on a re-run).
do $$
declare
  t text;
begin
  foreach t in array array['reward_track_cycles', 'reward_track_tiers', 'reward_track_rewards', 'reward_track_xp',
                           'reward_track_xp_events', 'reward_track_grants', 'reward_track_xp_sources'] loop
    if not (select c.relrowsecurity from pg_class c where c.oid = ('public.' || t)::regclass) then
      execute format('alter table public.%I enable row level security', t);
    end if;
  end loop;

  -- The catalog, read by every signed-in player.
  foreach t in array array['reward_track_cycles', 'reward_track_tiers', 'reward_track_rewards'] loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t
                      and policyname = t || '_select_signed_in') then
      execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_select_signed_in', t);
    end if;
  end loop;

  -- A player's own progress.
  foreach t in array array['reward_track_xp', 'reward_track_grants'] loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t
                      and policyname = t || '_select_own') then
      execute format('create policy %I on public.%I for select to authenticated using (profile_id = (select auth.uid()))',
                     t || '_select_own', t);
    end if;
  end loop;
  -- reward_track_xp_events, reward_track_xp_sources: no policies (server only).

  -- No client writes, even with a policy added later by mistake.
  foreach t in array array['reward_track_cycles', 'reward_track_tiers', 'reward_track_rewards', 'reward_track_xp',
                           'reward_track_xp_events', 'reward_track_grants', 'reward_track_xp_sources'] loop
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
  foreach t in array array['reward_track_cycles', 'reward_track_tiers', 'reward_track_rewards', 'reward_track_xp',
                           'reward_track_grants'] loop
    execute format('grant select on table public.%I to authenticated', t);
  end loop;
end $$;


-- ════ 4. Track-only My Place items ═══════════════════════════════════════
alter table public.home_items add column if not exists track_only boolean not null default false;
comment on column public.home_items.track_only is
  'Earned on the Court Pass (migration_court_pass_tables.sql), never sold: buy_home_item refuses it with pl:home.track_only. '
  'Seed with an available_until already past (a month before the cycle starts) so older app builds hide it from non-owners.';

-- The payout's ledger wording (migration_pickle_ledger.sql rule 3). Gold, so
-- a tier's pickles never feed the track (and never count as play).
insert into public.pickle_ledger_sources (source, sign, reason, kind, category, is_bonus, why) values
  ('_pl_track_settle', 1, 'Court Pass reward', 'bonus', 'track', true, 'a Court Pass tier paid out: a reward, not play')
on conflict (source, sign) do update
  set reason = excluded.reason, kind = excluded.kind, category = excluded.category,
      is_bonus = excluded.is_bonus, why = excluded.why;


-- ════ 5. buy_home_item (REPLACED) ════════════════════════════════════════
-- The body of migration_my_place.sql §5, unchanged except the block marked
-- "Court Pass". A track item is refused after the already-owned return (an
-- owner's retried buy still succeeds) and before the drop-window checks.
create or replace function public.buy_home_item(p_item_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me      uuid := auth.uid();
  v_item    public.home_items;
  v_balance integer;
  v_tier    integer;
  v_cycle   text;
  v_ended   boolean;
  v_lane    text;
begin
  if v_me is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;
  if p_item_id is null or btrim(p_item_id) = '' then
    raise exception using
      message = 'That didn''t go through because this version of Pickleague sent an incomplete request. Update Pickleague, then try again.',
      hint    = 'pl:request.bad';
  end if;

  select * into v_item from public.home_items where id = p_item_id;
  if v_item.id is null then
    raise exception using
      message = 'That item isn''t sold in My Place any more, so nothing was spent. Pull to refresh and pick another.',
      detail  = jsonb_build_object('item_id', p_item_id)::text,
      hint    = 'pl:home.item_gone';
  end if;

  -- The balance row first: two buys at once queue here, so the owned check
  -- and the price below see each other.
  select coalesce(p.pickles, 0) into v_balance from public.profiles p
   where p.id = v_me and p.deleted_at is null for update;
  if not found then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;

  -- Already yours: nothing to do, nothing charged (a retried buy is safe).
  if exists (select 1 from public.home_owned_items o where o.owner_id = v_me and o.item_id = v_item.id) then
    return jsonb_build_object('item_id', v_item.id, 'cost', 0, 'balance', v_balance, 'already_owned', true);
  end if;

  -- ── Court Pass (migration_court_pass_tables.sql) ──────────────────────
  -- A track item is earned, never sold. Name the tier that pays it (the
  -- newest free-lane reward); a premium-lane item is never granted yet, so
  -- its refusal promises nothing.
  if v_item.track_only then
    select r.tier, c.title, c.ends_at <= now() into v_tier, v_cycle, v_ended
      from public.reward_track_rewards r
      join public.reward_track_cycles c on c.id = r.cycle_id
     where r.home_item_id = v_item.id and r.lane = 'free'
     order by c.starts_at desc
     limit 1;
    if v_tier is not null then
      v_lane := 'free';
    else
      select r.tier, c.title into v_tier, v_cycle
        from public.reward_track_rewards r
        join public.reward_track_cycles c on c.id = r.cycle_id
       where r.home_item_id = v_item.id and r.lane = 'premium'
       order by c.starts_at desc
       limit 1;
      if v_tier is not null then
        v_lane := 'premium';
      end if;
    end if;
    raise exception using
      message = case
        when v_lane = 'free' and not coalesce(v_ended, false)
          then format('%s is a Court Pass reward, so it isn''t sold in My Place and nothing was spent. Reach tier %s on the %s to earn it.',
                      v_item.name, v_tier, v_cycle)
        when v_lane = 'free'
          then format('%s was a tier %s reward on the %s, which has ended, so it isn''t sold in My Place and nothing was spent. Open the Court Pass to see this month''s rewards.',
                      v_item.name, v_tier, v_cycle)
        when v_lane = 'premium'
          then format('%s is on the Court Pass premium track, which is coming soon, so it isn''t sold in My Place and nothing was spent. Open the Court Pass to see the free rewards you can earn.',
                      v_item.name)
        else format('%s is a Court Pass reward, so it isn''t sold in My Place and nothing was spent. Open the Court Pass to see how to earn rewards.',
                    v_item.name)
      end,
      detail  = jsonb_build_object('item', v_item.name, 'tier', v_tier, 'cycle', v_cycle)::text,
      hint    = 'pl:home.track_only';
  end if;
  -- ── end Court Pass ────────────────────────────────────────────────────

  if v_item.available_from is not null and now() < v_item.available_from then
    raise exception using
      message = v_item.name || ' isn''t on sale yet, so nothing was spent. Check back when its drop starts.',
      detail  = jsonb_build_object('item', v_item.name, 'available_from', v_item.available_from)::text,
      hint    = 'pl:home.not_yet';
  end if;
  if v_item.available_until is not null and now() >= v_item.available_until then
    raise exception using
      message = v_item.name || ' is no longer sold: its drop has ended, so nothing was spent. Pick another item.',
      detail  = jsonb_build_object('item', v_item.name, 'available_until', v_item.available_until)::text,
      hint    = 'pl:home.ended';
  end if;
  if v_balance < v_item.cost then
    raise exception using
      message = format('%s costs %s pickles and you have %s, so nothing was spent. Earn %s more by playing, then come back.',
                       v_item.name, to_char(v_item.cost, 'FM999,999,999'), to_char(v_balance, 'FM999,999,999'),
                       to_char(v_item.cost - v_balance, 'FM999,999,999')),
      detail  = jsonb_build_object('item', v_item.name, 'cost', v_item.cost, 'balance', v_balance,
                                   'short', v_item.cost - v_balance)::text,
      hint    = 'pl:home.not_enough';
  end if;

  if v_item.cost > 0 then
    perform set_config('pl.pickle_reason', left('My Place: ' || v_item.name, 200), true);
    perform set_config('pl.pickle_meta', jsonb_build_object('item_id', v_item.id, 'item', v_item.name)::text, true);
    update public.profiles set pickles = coalesce(pickles, 0) - v_item.cost where id = v_me
    returning pickles into v_balance;
    perform set_config('pl.pickle_reason', '', true);
    perform set_config('pl.pickle_meta', '', true);
  end if;

  insert into public.home_owned_items (owner_id, item_id, cost_paid, source)
  values (v_me, v_item.id, v_item.cost, 'buy');

  return jsonb_build_object('item_id', v_item.id, 'cost', v_item.cost, 'balance', v_balance, 'already_owned', false);
end $$;
revoke execute on function public.buy_home_item(text) from public, anon;
grant execute on function public.buy_home_item(text) to authenticated;


-- ════ 6. Account deletion ════════════════════════════════════════════════
create or replace function public._pl_track_purge()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.reward_track_grants    where profile_id = new.id;
  delete from public.reward_track_xp_events where profile_id = new.id;
  delete from public.reward_track_xp        where profile_id = new.id;
  return null;
end $$;
revoke execute on function public._pl_track_purge() from public, anon, authenticated;

create or replace trigger trg_profiles_track_purge
  after update on public.profiles
  for each row
  when (old.deleted_at is null and new.deleted_at is not null)
  execute function public._pl_track_purge();

notify pgrst, 'reload schema';
