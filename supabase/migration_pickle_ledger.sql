-- ============================================================
-- Pickle history: a ledger of every change to a player's pickles, so the app
-- can show Doggle's points viewer (a feed of what was earned, spent and
-- given, gold "bonus" rows, a calendar of daily totals).
--
-- The user, 2026-10-24: "I really like our Doggle points display, with a feed
-- of activity of point spend, gain, and caps per day, and special 'gold' bonus
-- points for things like referral bonuses and other bonuses. ... apply it to
-- pickleague" and "the calendar view of points too, and a link to the shop in
-- the points viewer from home as well." This file is the server half; the
-- viewer and the calendar come with the kit components.
--
-- ── How changes are captured ───────────────────────────────────────────────
--   1. Pickleague has no ledger: ~40 live functions change profiles.pickles
--      directly. Rewriting them would risk reverting drift on live, so none is
--      replaced. Instead an AFTER UPDATE trigger on profiles (WHEN the pickles
--      value changed, whatever the SET list says) records new - old, and an
--      AFTER INSERT trigger records a profile made with pickles <> 0.
--   2. Which function made the change comes from the trigger's own call stack
--      (GET DIAGNOSTICS ... = PG_CONTEXT): the nearest PL/pgSQL (or SQL)
--      function frame below the trigger is the "source"; the outermost one is
--      kept as meta.via when it differs (claim_referral above the Recruiter
--      badge's +150, say). No frame (a script, the SQL editor, service_role
--      through the API) means source null: "Pickles adjusted".
--   3. public.pickle_ledger_sources maps (source, sign of the change) to the
--      label, kind, category and gold flag. A row the map doesn't know is
--      "Pickles adjusted" / adjust / other. Adding a pickle-changing function
--      later: add its rows there (the persona test fails until every live
--      function that assigns pickles is mapped).
--   4. The trigger adds what it can see cheaply: rows the source wrote before
--      the change in the same transaction (created/granted at the same now()),
--      by primary-key or user index: the referral's friend, the play-streak
--      day, the login-streak day, the new court, the badge, the tournament,
--      the anniversary year, the getting-started step, a God mode gift's
--      sender. The Shop rows are written after the change, so small AFTER
--      INSERT triggers on player_shop_purchases and redemption_orders name the
--      item ("Shop: Neon paddle", "Gift: Neon paddle for Sam") on the ledger
--      row of the same transaction. Likewise triggers on pickle_pot_contributions
--      tell a tournament invite code's subsidy (taken from, and refunded to,
--      the code's creator) from the registrant's own ante: "Invite subsidy:
--      <tournament>", not "Tournament entry". Names are first names, as the
--      referral pushes word them.
--   5. Future callers can label a change themselves, transaction-locally,
--      right before it (and should clear it right after, '' = unset):
--        select set_config('pl.pickle_reason', 'Season bonus', true);
--        select set_config('pl.pickle_bonus', 'true', true);      -- gold
--        select set_config('pl.pickle_meta', '{"season_id": "..."}', true);
--   6. The trigger never blocks a pickles change: everything after the cheap
--      early exits runs in an exception block that raises a WARNING and keeps
--      the change. The balance on profiles is the truth; the ledger is the
--      story of it. A lost row shows as a break in the balance_after chain
--      (prev.balance_after + delta <> balance_after), never as a refused
--      payout. The detail lookups have their own inner block, so a failing
--      lookup still writes the plain label (meta.detail_error = the SQLSTATE).
--      Cost per change: one map lookup, one or two indexed reads for detail,
--      one insert (and one subtransaction, as the grant loops already take).
--      A bulk UPDATE of N balances takes N subtransactions; fine for the
--      one-off scripts that do that.
--   7. History starts when this file is applied: one "Starting balance" row
--      per live profile with pickles <> 0 (kind 'start', meta.starting_balance
--      true: the app shows it neutrally and leaves it out of earned / spent
--      totals). The trigger is created first, so no change can slip between
--      the two (it holds writes to profiles until the file's transaction
--      ends: run it as one file). A re-run adds a starting row only for a
--      profile with no rows at all.
--   8. Account deletion (_purge_account tombstones the profile: deleted_at
--      set, pickles 0): a trigger on that moment deletes the account's rows,
--      and other players' rows that name it (counterpart_id) go back to the
--      plain label. The capture skips a tombstoned profile. Not exception
--      wrapped: the purge is all or nothing. There is no data export path
--      today; one should include list_pickle_ledger's rows.
--
-- ── Gold (is_bonus) ───────────────────────────────────────────────────────
--   Gold = given, not earned by playing: sign-up and onboarding (welcome,
--   getting started, first match, first doubles match), referrals, the daily
--   login reward (Doggle's login bonus is is_bonus too, its 0271), anniversaries,
--   God mode gifts and top-ups. Earned (kind 'earn') = pay for playing:
--   matches, the play streak (the capped kind: 50 x streak day, at most 200 a
--   day), new courts, badges, tournaments, drill reviews, prizes, wagers won.
--   Pickleague has no cap on a day's total (Doggle's 200/day across sources);
--   its only daily cap is the play streak's 200, which my_pickle_today shows.
--
-- ── Table ──────────────────────────────────────────────────────────────────
--   pickle_ledger (id bigint identity, profile_id, delta <> 0, balance_after,
--     reason, source, is_bonus, kind, category, counterpart_id, created_at, meta)
--     kind:     earn | bonus | spend | refund | reversal | start | adjust
--     category: match streak login badge court tournament league wager shop
--               gift referral welcome anniversary drill prize admin start other
--   RLS: a player reads their own rows (select only); no client writes.
--   Index (profile_id, created_at desc, id desc): the feed, the calendar
--   range and the same-transaction lookups.
--
-- ── New client RPCs (granted to authenticated, in the hardening allowlist) ─
--   list_pickle_ledger(p_limit integer default 20, p_before timestamptz default null,
--                      p_before_id bigint default null)
--     -> setof {id, delta, balance_after, reason, kind, category, is_bonus,
--               created_at, local_day, meta}
--     Newest first (created_at desc, id desc). p_limit clamped to 1..100. The
--     next page: p_before = the last row's created_at, p_before_id = its id
--     (one transaction writes several rows at the same created_at, so the id
--     breaks the tie; p_before alone = strictly older). local_day = the day
--     in the player's stored zone (pickleague_time_zones).
--   list_pickle_ledger_range(p_from timestamptz, p_to timestamptz)
--     -> the same rows with p_from <= created_at < p_to, newest first, at most
--     5000. The range may span at most 62 days (a month grid is 42).
--   my_pickle_today()
--     -> {tz, day, cap: 200, played_today, streak_days, streak_today,
--         next_streak, earned_today, bonus_today, spent_today, net_today}
--     The play streak (daily_play_streaks, the player's zone): today's grant,
--     the streak length (today's, else yesterday's if it is still alive), what
--     the next play day brings (mirrors _grant_daily_streak_bonus:
--     least(50 x day, 200)), and today's ledger totals by kind (spent is
--     positive; net leaves the starting row out).
--   Refusals: pl:auth.signed_out (no session), pl:request.bad (a missing or
--   inverted range, or one longer than 62 days). Guests read their own
--   history like anyone; there is nobody else's to block.
-- New internal functions (execute revoked from public, anon, authenticated):
--   _pl_pickle_ledger_capture(), _pl_pickle_ledger_item(),
--   _pl_pickle_ledger_subsidy(), _pl_pickle_ledger_purge() (all trigger functions).
-- Replaced: none.
--
-- ── Locks (what applying this file holds until its transaction ends) ──────
--   The first apply: SHARE ROW EXCLUSIVE on profiles (the foreign key and the
--   triggers), player_shop_purchases, redemption_orders and
--   pickle_pot_contributions (their triggers): writes to them wait, reads
--   don't. A re-run: the same, plus writes to pickle_ledger itself (create
--   index if not exists takes SHARE). Nothing here takes ACCESS
--   EXCLUSIVE on a live table (which would hold up reads too): the triggers
--   are CREATE OR REPLACE (PG 14+; live is 17), never dropped, and RLS and
--   the policy are only created when missing. The persona test checks it.
--
-- Idempotent: re-runnable as a whole (create if not exists, create or
-- replace trigger, the map upserted, the starting rows only where missing).
-- Persona test: supabase/tests/pickle_ledger_personas.sql
--   (node supabase/tests/build-pickle-ledger-test.mjs <out.sql>).
-- ============================================================


-- ════ 1. Tables ══════════════════════════════════════════════════════════
create table if not exists public.pickle_ledger (
  id             bigint generated always as identity primary key,
  profile_id     uuid        not null references public.profiles (id) on delete cascade,
  delta          integer     not null,
  balance_after  integer     not null,
  reason         text        not null,
  source         text,
  is_bonus       boolean     not null default false,
  kind           text        not null default 'adjust',
  category       text        not null default 'other',
  counterpart_id uuid,
  created_at     timestamptz not null default now(),
  meta           jsonb       not null default '{}'::jsonb,
  constraint pickle_ledger_delta_chk check (delta <> 0),
  constraint pickle_ledger_bonus_chk check (not is_bonus or delta > 0),
  constraint pickle_ledger_kind_chk check (kind in ('earn', 'bonus', 'spend', 'refund', 'reversal', 'start', 'adjust'))
);
comment on table public.pickle_ledger is
  'Every change to profiles.pickles since migration_pickle_ledger.sql, written by triggers on profiles. Display history: profiles.pickles is the balance of record.';

create index if not exists pickle_ledger_profile_created_idx
  on public.pickle_ledger (profile_id, created_at desc, id desc);
create index if not exists pickle_ledger_counterpart_idx
  on public.pickle_ledger (counterpart_id) where counterpart_id is not null;

-- Enable RLS and create the policy only when missing: ALTER TABLE ... ENABLE
-- ROW LEVEL SECURITY and DROP / CREATE POLICY take ACCESS EXCLUSIVE, which on
-- a re-run would hold up the capture trigger's inserts (and so every pickles
-- change) until the file's transaction ends (see "Locks" at the top).
do $$
begin
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.pickle_ledger'::regclass) then
    alter table public.pickle_ledger enable row level security;
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'pickle_ledger'
                    and policyname = 'pickle_ledger_select_own') then
    create policy pickle_ledger_select_own on public.pickle_ledger
      for select to authenticated
      using (profile_id = (select auth.uid()));
  end if;
end $$;
revoke all on table public.pickle_ledger from public, anon, authenticated;
grant select on table public.pickle_ledger to authenticated;
grant all on table public.pickle_ledger to service_role;

-- Which function made a change, and how to word it. One row per (source,
-- sign of the change); `why` is the one-line rationale for the gold flag.
create table if not exists public.pickle_ledger_sources (
  source   text     not null,
  sign     smallint not null,
  reason   text     not null,
  kind     text     not null,
  category text     not null,
  is_bonus boolean  not null default false,
  why      text,
  primary key (source, sign),
  constraint pickle_ledger_sources_sign_chk check (sign in (-1, 1)),
  constraint pickle_ledger_sources_kind_chk check (kind in ('earn', 'bonus', 'spend', 'refund', 'reversal', 'start', 'adjust')),
  constraint pickle_ledger_sources_bonus_chk check (not is_bonus or (sign = 1 and kind = 'bonus'))
);
comment on table public.pickle_ledger_sources is
  'migration_pickle_ledger.sql: the label, kind, category and gold flag for a pickles change by each function (source = the nearest function on the call stack).';
do $$
begin
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.pickle_ledger_sources'::regclass) then
    alter table public.pickle_ledger_sources enable row level security;
  end if;
end $$;
revoke all on table public.pickle_ledger_sources from public, anon, authenticated;
grant all on table public.pickle_ledger_sources to service_role;

-- The inventory: every live function whose body assigns profiles.pickles
-- (pg_proc.prosrc ~* 'pickles\s*=', 2026-10-24), from its latest definition.
-- _purge_account is left out on purpose: it tombstones the account (rule 8).
insert into public.pickle_ledger_sources (source, sign, reason, kind, category, is_bonus, why) values
  -- Matches (triggers on matches; latest bodies: migration_local_day_boundaries.sql,
  -- migration_match_count_fix.sql, migration_bump_base_pickle_grants.sql).
  ('_grant_match_game_bonus',               1, 'Match played',               'earn',     'match',       false, 'pay per game played'),
  ('_grant_daily_streak_bonus',             1, 'Play streak',                'earn',     'streak',      false, 'the capped kind: 50 x streak day, at most 200 a day'),
  ('_grant_court_bonus',                    1, 'New court bonus',            'earn',     'court',       false, 'grows with play: each new court'),
  ('_grant_first_match_bonus',              1, 'First match bonus',          'bonus',    'match',       true,  'one-time milestone, not pay per match'),
  ('_grant_first_doubles_bonus',            1, 'First doubles match bonus',  'bonus',    'match',       true,  'one-time milestone, not pay per match'),
  ('_reverse_match_side_effects',          -1, 'Match removed: pickles taken back', 'reversal', 'match', false, 'undoes a deleted match''s grants'),
  -- Badges and tournaments played (triggers).
  ('_grant_pickles_on_badge',               1, 'Badge earned',               'earn',     'badge',       false, 'earned by playing'),
  ('_grant_tournament_participation_bonus', 1, 'Tournament played',          'earn',     'tournament',  false, 'pay for playing a tournament'),
  -- Claims the app makes.
  ('claim_daily_login_streak',              1, 'Daily login',                'bonus',    'login',       true,  'a login reward, not play (Doggle 0271: login bonuses are is_bonus)'),
  ('claim_welcome_pickles',                 1, 'Welcome pickles',            'bonus',    'welcome',     true,  'sign-up gift'),
  ('claim_ftue_step',                       1, 'Getting started',            'bonus',    'welcome',     true,  'one-time onboarding reward'),
  ('claim_anniversary_pickles',             1, 'Anniversary',                'bonus',    'anniversary', true,  'a yearly gift, not play'),
  ('_pl_pay_referral_reward',               1, 'Referral reward',            'bonus',    'referral',    true,  'referral rewards are the original gold (Doggle 0242)'),
  ('submit_drill_review',                   1, 'Drill review',               'earn',     'drill',       false, 'pay for reviewing a drill'),
  -- God mode.
  ('godmode_gift_pickles',                  1, 'Gift from God mode',         'bonus',    'gift',        true,  'a gift, not earned'),
  ('godmode_gift_pickles',                 -1, 'Pickles gifted',             'spend',    'gift',        false, null),
  ('claim_godmode_pickles',                 1, 'God mode top-up',            'bonus',    'admin',       true,  'an admin grant, not earned'),
  -- Wagers.
  ('place_wager',                          -1, 'Wager placed',               'spend',    'wager',       false, null),
  ('cancel_wager',                          1, 'Wager cancelled: stake back', 'refund',  'wager',       false, null),
  ('_settle_wagers_for_match',              1, 'Wager won',                  'earn',     'wager',       false, 'winnings from a call'),
  ('_settle_wagers_for_tournament_match',   1, 'Wager won',                  'earn',     'wager',       false, 'winnings from a call'),
  ('_settle_wagers_for_tournament',         1, 'Wager won',                  'earn',     'wager',       false, 'winnings from a call'),
  ('_settle_wagers_for_period_lock',        1, 'Wager won',                  'earn',     'wager',       false, 'winnings from a call'),
  ('cancel_tournament',                     1, 'Wager refunded: tournament cancelled', 'refund', 'wager', false, null),
  ('godmode_delete_tournament',             1, 'Wager refunded: tournament deleted',   'refund', 'wager', false, null),
  ('godmode_delete_league',                 1, 'Refund: league deleted',     'refund',   'league',      false, null),
  -- Tournament antes and prize pots. An invite code creator's subsidy runs
  -- in the same two functions and is renamed by §3b ("Invite subsidy: ...").
  ('_charge_tournament_ante',             -1, 'Tournament entry',           'spend',    'tournament',  false, null),
  ('_refund_registration_ante',             1, 'Tournament entry refunded',  'refund',   'tournament',  false, null),
  ('_refund_tournament_pot',                1, 'Prize pot refunded',         'refund',   'tournament',  false, null),
  ('contribute_pickles_to_pool',           -1, 'Added to a prize pot',       'spend',    'prize',       false, null),
  ('award_pickles_from_pool',               1, 'Prize pot award',            'earn',     'prize',       false, 'prize money, won by playing'),
  ('distribute_season_pool',                1, 'Season prize',               'earn',     'prize',       false, 'prize money, won by playing'),
  ('distribute_tournament_pool',            1, 'Tournament prize',           'earn',     'prize',       false, 'prize money, won by playing'),
  ('auto_payout_tournament',                1, 'Tournament prize',           'earn',     'prize',       false, 'prize money, won by playing'),
  ('auto_payout_mlp_tournament',            1, 'Tournament prize',           'earn',     'prize',       false, 'prize money, won by playing'),
  -- The Shop (the item triggers below name the item). The two real-world
  -- functions are retired (migration_retire_real_world_redemptions.sql) but
  -- still defined, so they are mapped too.
  ('purchase_shop_item',                   -1, 'Shop purchase',              'spend',    'shop',        false, null),
  ('redeem_real_world_item',               -1, 'Shop redemption',            'spend',    'shop',        false, null),
  ('gift_shop_item',                       -1, 'Gift sent',                  'spend',    'gift',        false, null),
  ('gift_real_world_item',                 -1, 'Gift sent',                  'spend',    'gift',        false, null)
on conflict (source, sign) do update
  set reason = excluded.reason, kind = excluded.kind, category = excluded.category,
      is_bonus = excluded.is_bonus, why = excluded.why;


-- ════ 2. The capture trigger on profiles ═════════════════════════════════
create or replace function public._pl_pickle_ledger_capture()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old      integer := 0;
  v_delta    integer;
  v_ctx      text;
  v_frames   text[];
  v_source   text;
  v_via      text;
  v_sign     smallint;
  v_reason   text;
  v_kind     text;
  v_cat      text;
  v_bonus    boolean;
  v_meta     jsonb := '{}'::jsonb;
  v_other    uuid;
  v_me       uuid;
  v_txt      text;
  v_int      integer;
  v_id       uuid;
  v_flag     boolean;
  v_set      text;
begin
  if tg_op = 'UPDATE' then
    v_old := coalesce(old.pickles, 0);
  end if;
  v_delta := coalesce(new.pickles, 0) - v_old;
  -- A tombstoned account keeps no history (rule 8).
  if v_delta = 0 or new.deleted_at is not null then
    return null;
  end if;

  begin
    -- Rule 2: who made the change. Frames read "PL/pgSQL function
    -- [schema.]name(args) line N at ..." (schema shown when the function was
    -- compiled with it off the search_path) or 'SQL function "name" ...'.
    get diagnostics v_ctx = pg_context;
    select array_agg(case when coalesce(m[1], 'public') = 'public' then coalesce(m[2], m[3])
                          else m[1] || '.' || coalesce(m[2], m[3]) end
                     order by o)
      into v_frames
      from regexp_matches(v_ctx,
             'PL/pgSQL function (?:"?([A-Za-z0-9_]+)"?\.)?"?([A-Za-z0-9_]+)"?\(|SQL function "([A-Za-z0-9_]+)"',
             'g') with ordinality as r (m, o);
    v_frames := array_remove(v_frames, '_pl_pickle_ledger_capture');
    v_source := v_frames[1];
    v_via    := v_frames[cardinality(v_frames)];
    if v_via is not distinct from v_source then
      v_via := null;
    end if;

    -- Rule 3: the label.
    v_sign := case when v_delta > 0 then 1 else -1 end;
    select s.reason, s.kind, s.category, s.is_bonus
      into v_reason, v_kind, v_cat, v_bonus
      from public.pickle_ledger_sources s
     where s.source = v_source and s.sign = v_sign;
    if v_reason is null then
      if tg_op = 'INSERT' then
        v_reason := 'Starting balance'; v_kind := 'start'; v_cat := 'start';
        v_meta := jsonb_build_object('starting_balance', true);
      else
        v_reason := 'Pickles adjusted'; v_kind := 'adjust'; v_cat := 'other';
      end if;
      v_bonus := false;
    end if;

    -- Rule 4: detail from rows the source wrote earlier in this transaction.
    -- A failure here keeps the plain label.
    begin
      v_me := auth.uid();
      if v_source = '_pl_pay_referral_reward' then
        select case when r.referrer_id = new.id then r.invitee_id else r.referrer_id end,
               r.referrer_id = new.id, r.id
          into v_other, v_flag, v_id
          from public.referrals r
         where r.rewarded_at = now()
           and (r.referrer_id = new.id or r.invitee_id = new.id)
           and not exists (select 1 from public.pickle_ledger l
                            where l.profile_id = new.id and l.created_at = now()
                              and l.meta ->> 'referral_id' = r.id::text)
         order by r.id
         limit 1;
        if v_id is not null then
          select coalesce(nullif(split_part(btrim(p.full_name), ' ', 1), ''), 'a friend') into v_txt
            from public.profiles p where p.id = v_other;
          v_reason := case when v_flag then format('Referral: %s joined', coalesce(v_txt, 'a friend'))
                           else format('Joined with %s''s invite', coalesce(v_txt, 'a friend')) end;
          v_meta := v_meta || jsonb_build_object('referral_id', v_id);
        end if;

      elsif v_source = 'godmode_gift_pickles' then
        if v_delta > 0 and v_me is not null and v_me <> new.id then
          -- The recipient's row names the sender, and names the recipient on
          -- the sender's row (written a statement earlier).
          v_other := v_me;
          select coalesce(nullif(split_part(btrim(p.full_name), ' ', 1), ''), 'God mode') into v_txt
            from public.profiles p where p.id = v_me;
          v_reason := format('Gift from %s', coalesce(v_txt, 'God mode'));
          select coalesce(nullif(split_part(btrim(p.full_name), ' ', 1), ''), 'a player') into v_txt
            from public.profiles p where p.id = new.id;
          update public.pickle_ledger l
             set reason = format('Gift to %s', coalesce(v_txt, 'a player')), counterpart_id = new.id
           where l.id = (select l2.id from public.pickle_ledger l2
                          where l2.profile_id = v_me and l2.created_at = now()
                            and l2.source = 'godmode_gift_pickles' and l2.delta = -v_delta
                            and l2.counterpart_id is null
                          order by l2.id desc
                          limit 1);
        end if;

      elsif v_source = 'claim_daily_login_streak' then
        select s.current_streak into v_int from public.user_login_streaks s where s.user_id = new.id;
        if v_int > 0 then
          v_reason := format('Daily login: day %s', v_int);
          v_meta := v_meta || jsonb_build_object('streak', v_int);
        end if;

      elsif v_source = '_grant_daily_streak_bonus' then
        -- daily_play_streaks has no timestamp: the latest day with this amount.
        -- A match entered days late, while a later day with the same amount
        -- exists, can name that later day's streak (the amount is right).
        select s.streak_length, s.play_date into v_int, v_txt
          from public.daily_play_streaks s
         where s.user_id = new.id and s.bonus_granted = v_delta
         order by s.play_date desc
         limit 1;
        if v_int > 0 then
          v_reason := format('Play streak: day %s', v_int);
          v_meta := v_meta || jsonb_build_object('streak', v_int, 'play_date', v_txt);
        end if;

      elsif v_source = '_grant_court_bonus' then
        select g.location_name into v_txt
          from public.court_bonus_grants g
         where g.user_id = new.id and g.granted_at = now()
           and not exists (select 1 from public.pickle_ledger l
                            where l.profile_id = new.id and l.created_at = now()
                              and l.source = '_grant_court_bonus' and l.meta ->> 'court' = g.location_name)
         order by g.location_name
         limit 1;
        if v_txt is not null then
          v_reason := 'New court: ' || v_txt;
          v_meta := v_meta || jsonb_build_object('court', v_txt);
        end if;

      elsif v_source = '_grant_pickles_on_badge' then
        -- One +150 per badge row; with two badges in one transaction the names
        -- may pair up in either order, the amounts are the same.
        select pb.id, b.name into v_id, v_txt
          from public.player_badges pb
          join public.badges b on b.id = pb.badge_id
         where pb.user_id = new.id and pb.earned_at = now()
           and not exists (select 1 from public.pickle_ledger l
                            where l.profile_id = new.id and l.created_at = now()
                              and l.meta ->> 'badge_award_id' = pb.id::text)
         order by pb.id
         limit 1;
        if v_id is not null then
          v_reason := 'Badge: ' || v_txt;
          v_meta := v_meta || jsonb_build_object('badge_award_id', v_id, 'badge', v_txt);
        end if;

      elsif v_source = '_grant_tournament_participation_bonus' then
        select g.tournament_id, t.name into v_id, v_txt
          from public.tournament_participation_grants g
          left join public.tournaments t on t.id = g.tournament_id
         where g.user_id = new.id and g.granted_at = now()
           and not exists (select 1 from public.pickle_ledger l
                            where l.profile_id = new.id and l.created_at = now()
                              and l.meta ->> 'tournament_id' = g.tournament_id::text)
         order by g.tournament_id
         limit 1;
        if v_id is not null then
          if v_txt is not null then
            v_reason := 'Tournament played: ' || v_txt;
          end if;
          v_meta := v_meta || jsonb_build_object('tournament_id', v_id);
        end if;

      elsif v_source = 'claim_anniversary_pickles' then
        select g.year into v_int
          from public.anniversary_grants g
         where g.user_id = new.id and g.granted_at = now()
           and not exists (select 1 from public.pickle_ledger l
                            where l.profile_id = new.id and l.created_at = now()
                              and l.meta ->> 'year' = g.year::text)
         order by g.year
         limit 1;
        if v_int is not null then
          v_reason := format('Anniversary: year %s', v_int);
          v_meta := v_meta || jsonb_build_object('year', v_int);
        end if;

      elsif v_source = 'claim_ftue_step' then
        select g.step into v_txt
          from public.ftue_grants g
         where g.user_id = new.id and g.granted_at = now()
           and not exists (select 1 from public.pickle_ledger l
                            where l.profile_id = new.id and l.created_at = now()
                              and l.meta ->> 'step' = g.step)
         order by g.step
         limit 1;
        if v_txt is not null then
          v_reason := 'Getting started: ' || case v_txt
            when 'join_league'   then 'joined a league'
            when 'setup_profile' then 'set up your profile'
            when 'first_match'   then 'played a first match'
            else replace(v_txt, '_', ' ') end;
          v_meta := v_meta || jsonb_build_object('step', v_txt);
        end if;
      end if;

      -- Rule 5: a caller's own words win.
      v_set := nullif(current_setting('pl.pickle_reason', true), '');
      if v_set is not null then
        v_reason := left(v_set, 200);
      end if;
      v_set := nullif(current_setting('pl.pickle_bonus', true), '');
      if v_set is not null then
        v_bonus := v_set::boolean and v_delta > 0;
        if v_bonus then
          v_kind := 'bonus';
        elsif v_kind = 'bonus' then
          v_kind := 'earn';
        end if;
      end if;
      v_set := nullif(current_setting('pl.pickle_meta', true), '');
      if v_set is not null then
        v_meta := v_meta || v_set::jsonb;
      end if;
    exception when others then
      v_meta := v_meta || jsonb_build_object('detail_error', sqlstate);
    end;

    if v_via is not null then
      v_meta := v_meta || jsonb_build_object('via', v_via);
    end if;

    insert into public.pickle_ledger
      (profile_id, delta, balance_after, reason, source, is_bonus, kind, category, counterpart_id, meta)
    values
      (new.id, v_delta, coalesce(new.pickles, 0), coalesce(v_reason, 'Pickles adjusted'), v_source,
       coalesce(v_bonus, false) and v_delta > 0, coalesce(v_kind, 'adjust'), coalesce(v_cat, 'other'),
       v_other, v_meta);
  exception when others then
    -- Rule 6: keep the change, lose the row.
    raise warning 'pickle_ledger: no history row for a % pickles change on profile % (%: %)',
      v_delta, new.id, sqlstate, sqlerrm;
  end;
  return null;
end $$;
revoke execute on function public._pl_pickle_ledger_capture() from public, anon, authenticated;

-- The trigger first, then the starting rows (rule 7). CREATE OR REPLACE
-- TRIGGER, never DROP + CREATE: dropping an existing trigger takes ACCESS
-- EXCLUSIVE on the table, so a re-run would hold up every read of profiles
-- until the file's transaction ends ("Locks" at the top).
create or replace trigger trg_profiles_pickle_ledger
  after update on public.profiles
  for each row
  when (old.pickles is distinct from new.pickles)
  execute function public._pl_pickle_ledger_capture();

create or replace trigger trg_profiles_pickle_ledger_insert
  after insert on public.profiles
  for each row
  when (new.pickles <> 0)
  execute function public._pl_pickle_ledger_capture();


-- ════ 3. Shop items name their ledger row ════════════════════════════════
-- purchase_shop_item / gift_shop_item insert player_shop_purchases, and
-- redeem_real_world_item / gift_real_world_item insert redemption_orders,
-- right AFTER they take the pickles. The row of the same transaction (same
-- buyer, source, amount, not named yet) gets the item's name.
create or replace function public._pl_pickle_ledger_item()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cost   integer;
  v_source text;
  v_buyer  uuid;
  v_item   text;
  v_to     text;
  v_shop   boolean := tg_table_name = 'player_shop_purchases';
begin
  begin
    if v_shop then
      v_cost   := new.cost_paid;
      v_source := case when new.gifted_by_user_id is null then 'purchase_shop_item' else 'gift_shop_item' end;
    else
      v_cost   := new.pickles_paid;
      v_source := case when new.gifted_by_user_id is null then 'redeem_real_world_item' else 'gift_real_world_item' end;
    end if;
    if coalesce(v_cost, 0) <= 0 then
      return null;
    end if;
    v_buyer := coalesce(new.gifted_by_user_id, new.user_id);
    select coalesce(s.name, 'an item') into v_item from public.shop_items s where s.id = new.shop_item_id;
    v_item := coalesce(v_item, 'an item');
    if new.gifted_by_user_id is not null then
      select coalesce(nullif(split_part(btrim(p.full_name), ' ', 1), ''), 'a friend') into v_to
        from public.profiles p where p.id = new.user_id;
    end if;
    update public.pickle_ledger l
       set reason = case when new.gifted_by_user_id is not null then format('Gift: %s for %s', v_item, coalesce(v_to, 'a friend'))
                         when v_shop then 'Shop: ' || v_item
                         else 'Redeemed: ' || v_item end,
           counterpart_id = case when new.gifted_by_user_id is not null then new.user_id end,
           meta = l.meta || jsonb_build_object('item_id', new.shop_item_id, 'item', v_item)
     where l.id = (select l2.id from public.pickle_ledger l2
                    where l2.profile_id = v_buyer and l2.created_at = now()
                      and l2.source = v_source and l2.delta = -v_cost
                      and not (l2.meta ? 'item_id')
                    order by l2.id desc
                    limit 1);
  exception when others then
    raise warning 'pickle_ledger: could not name the item on a % row (%: %)', tg_table_name, sqlstate, sqlerrm;
  end;
  return null;
end $$;
revoke execute on function public._pl_pickle_ledger_item() from public, anon, authenticated;

create or replace trigger trg_player_shop_purchases_pickle_ledger
  after insert on public.player_shop_purchases
  for each row execute function public._pl_pickle_ledger_item();

create or replace trigger trg_redemption_orders_pickle_ledger
  after insert on public.redemption_orders
  for each row execute function public._pl_pickle_ledger_item();


-- ════ 3b. An invite code's subsidy is the creator's own row ══════════════
-- _charge_tournament_ante takes a tournament invite code's pickle_subsidy
-- from the code's creator, and _refund_registration_ante gives it back,
-- in the same function frame as the registrant's own ante, so the map alone
-- would call the creator's row "Tournament entry" for a tournament they never
-- entered. pickle_pot_contributions tells them apart: the subsidy's row is
-- kind 'ante_subsidy', inserted right AFTER the creator's pickles are taken,
-- and stamped refunded_at right AFTER they are given back (latest bodies:
-- migration_tournament_ante_refunds_and_cancel.sql, same as live). This names
-- the ledger row of the same transaction (same creator, source, amount, not
-- named yet): "Invite subsidy: Ledger Cup" / "Invite subsidy refunded: ...".
-- A whole-pot refund (_refund_tournament_pot: cancel / delete) sums a player's
-- rows into one "Prize pot refunded" row and is left as it is.
create or replace function public._pl_pickle_ledger_subsidy()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refund boolean := tg_op = 'UPDATE';
  v_name   text;
begin
  begin
    if new.kind is distinct from 'ante_subsidy' or new.scope_type is distinct from 'tournament'
       or (v_refund and (old.refunded_at is not null or new.refunded_at is null)) then
      return null;
    end if;
    select t.name into v_name from public.tournaments t where t.id = new.scope_id;
    update public.pickle_ledger l
       set reason = case when v_refund then 'Invite subsidy refunded' else 'Invite subsidy' end
                    || coalesce(': ' || v_name, ''),
           meta = l.meta || jsonb_build_object('invite_subsidy', true, 'tournament_id', new.scope_id)
     where l.id = (select l2.id from public.pickle_ledger l2
                    where l2.profile_id = new.user_id and l2.created_at = now()
                      and l2.source = case when v_refund then '_refund_registration_ante' else '_charge_tournament_ante' end
                      and l2.delta = case when v_refund then new.amount_paid else -new.amount_paid end
                      and not (l2.meta ? 'invite_subsidy')
                    order by l2.id desc
                    limit 1);
  exception when others then
    raise warning 'pickle_ledger: could not name an invite subsidy row (%: %)', sqlstate, sqlerrm;
  end;
  return null;
end $$;
revoke execute on function public._pl_pickle_ledger_subsidy() from public, anon, authenticated;

create or replace trigger trg_pickle_pot_contributions_ledger_subsidy
  after insert on public.pickle_pot_contributions
  for each row
  when (new.kind = 'ante_subsidy')
  execute function public._pl_pickle_ledger_subsidy();

create or replace trigger trg_pickle_pot_contributions_ledger_subsidy_refund
  after update of refunded_at on public.pickle_pot_contributions
  for each row
  when (new.kind = 'ante_subsidy' and old.refunded_at is null and new.refunded_at is not null)
  execute function public._pl_pickle_ledger_subsidy();


-- ════ 4. Account deletion ════════════════════════════════════════════════
-- _purge_account (latest body: migration_court_routines.sql) tombstones the
-- profile; this runs on that update, so _purge_account itself is not replaced.
create or replace function public._pl_pickle_ledger_purge()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.pickle_ledger where profile_id = new.id;
  -- Other players' rows that name the deleted account: the plain label (an
  -- item gift keeps the item, not the person).
  update public.pickle_ledger l
     set reason = case when l.meta ? 'item' then 'Gift: ' || (l.meta ->> 'item')
                       else coalesce((select s.reason from public.pickle_ledger_sources s
                                       where s.source = l.source
                                         and s.sign = case when l.delta > 0 then 1 else -1 end),
                                     'Pickles adjusted') end,
         counterpart_id = null
   where l.counterpart_id = new.id;
  return null;
end $$;
revoke execute on function public._pl_pickle_ledger_purge() from public, anon, authenticated;

create or replace trigger trg_profiles_pickle_ledger_purge
  after update on public.profiles
  for each row
  when (old.deleted_at is null and new.deleted_at is not null)
  execute function public._pl_pickle_ledger_purge();


-- ════ 5. Starting balances (rule 7) ══════════════════════════════════════
insert into public.pickle_ledger (profile_id, delta, balance_after, reason, source, is_bonus, kind, category, meta)
select p.id, p.pickles, p.pickles, 'Starting balance', null, false, 'start', 'start',
       jsonb_build_object('starting_balance', true)
  from public.profiles p
 where p.pickles <> 0
   and p.deleted_at is null
   and not exists (select 1 from public.pickle_ledger l where l.profile_id = p.id);


-- ════ 6. Client RPCs ═════════════════════════════════════════════════════
-- The feed (the points viewer): newest first, keyset paging.
create or replace function public.list_pickle_ledger(
  p_limit     integer     default 20,
  p_before    timestamptz default null,
  p_before_id bigint      default null
)
returns table (
  id            bigint,
  delta         integer,
  balance_after integer,
  reason        text,
  kind          text,
  category      text,
  is_bonus      boolean,
  created_at    timestamptz,
  local_day     date,
  meta          jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me    uuid := auth.uid();
  v_tz    text;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
begin
  if v_me is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;
  v_tz := public._pickleague_tz_for(v_me);
  return query
    select l.id, l.delta, l.balance_after, l.reason, l.kind, l.category, l.is_bonus, l.created_at,
           (l.created_at at time zone v_tz)::date, l.meta
      from public.pickle_ledger l
     where l.profile_id = v_me
       and (p_before is null
            or l.created_at < p_before
            or (p_before_id is not null and l.created_at = p_before and l.id < p_before_id))
     order by l.created_at desc, l.id desc
     limit v_limit;
end $$;
revoke all on function public.list_pickle_ledger(integer, timestamptz, bigint) from public, anon;
grant execute on function public.list_pickle_ledger(integer, timestamptz, bigint) to authenticated;

-- The calendar: one visible month (with its leading / trailing weeks).
create or replace function public.list_pickle_ledger_range(p_from timestamptz, p_to timestamptz)
returns table (
  id            bigint,
  delta         integer,
  balance_after integer,
  reason        text,
  kind          text,
  category      text,
  is_bonus      boolean,
  created_at    timestamptz,
  local_day     date,
  meta          jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
  v_tz text;
begin
  if v_me is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '62 days' then
    raise exception using
      message = 'Couldn''t load your pickle history because the app asked for a date range it can''t show (up to 62 days at a time). Update Pickleague, then try again.',
      hint = 'pl:request.bad';
  end if;
  v_tz := public._pickleague_tz_for(v_me);
  return query
    select l.id, l.delta, l.balance_after, l.reason, l.kind, l.category, l.is_bonus, l.created_at,
           (l.created_at at time zone v_tz)::date, l.meta
      from public.pickle_ledger l
     where l.profile_id = v_me
       and l.created_at >= p_from
       and l.created_at < p_to
     order by l.created_at desc, l.id desc
     limit 5000;
end $$;
revoke all on function public.list_pickle_ledger_range(timestamptz, timestamptz) from public, anon;
grant execute on function public.list_pickle_ledger_range(timestamptz, timestamptz) to authenticated;

-- Today in the player's zone: the play streak (the one daily cap) and the
-- day's totals.
create or replace function public.my_pickle_today()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me     uuid := auth.uid();
  v_tz     text;
  v_day    date;
  v_from   timestamptz;
  v_to     timestamptz;
  v_len    integer;
  v_amt    integer;
  v_played boolean := false;
  v_streak integer := 0;
  v_today  integer := 0;
  v_earn   integer;
  v_bonus  integer;
  v_spent  integer;
  v_net    integer;
begin
  if v_me is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;
  v_tz   := public._pickleague_tz_for(v_me);
  v_day  := (now() at time zone v_tz)::date;
  v_from := v_day::timestamp at time zone v_tz;
  v_to   := (v_day + 1)::timestamp at time zone v_tz;

  select s.streak_length, s.bonus_granted into v_len, v_amt
    from public.daily_play_streaks s where s.user_id = v_me and s.play_date = v_day;
  if found then
    v_played := true;
    v_streak := coalesce(v_len, 0);
    v_today  := coalesce(v_amt, 0);
  else
    select s.streak_length into v_len
      from public.daily_play_streaks s where s.user_id = v_me and s.play_date = v_day - 1;
    v_streak := coalesce(v_len, 0);
  end if;

  select coalesce(sum(l.delta) filter (where l.kind = 'earn'), 0),
         coalesce(sum(l.delta) filter (where l.kind = 'bonus'), 0),
         coalesce(-sum(l.delta) filter (where l.kind = 'spend'), 0),
         coalesce(sum(l.delta) filter (where l.kind <> 'start'), 0)
    into v_earn, v_bonus, v_spent, v_net
    from public.pickle_ledger l
   where l.profile_id = v_me and l.created_at >= v_from and l.created_at < v_to;

  return jsonb_build_object(
    'tz', v_tz,
    'day', v_day,
    'cap', 200,
    'played_today', v_played,
    'streak_days', v_streak,
    'streak_today', v_today,
    -- _grant_daily_streak_bonus: least(50 x streak day, 200).
    'next_streak', least(50 * (v_streak + 1), 200),
    'earned_today', v_earn,
    'bonus_today', v_bonus,
    'spent_today', v_spent,
    'net_today', v_net
  );
end $$;
revoke all on function public.my_pickle_today() from public, anon;
grant execute on function public.my_pickle_today() to authenticated;
