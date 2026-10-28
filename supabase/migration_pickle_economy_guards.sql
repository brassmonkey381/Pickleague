-- ============================================================
-- Pickle economy guards: pickles are minted only for play another real player
-- took part in, once per thing, and at most 500 a day from play.
--
-- The user, 2026-10-28: "period end bonuses are easily exploited, since we can
-- create infinite leagues and reward ourselves with pickles out of thin air
-- for winning periods. We can even be in a league with just ourselves", then
-- "go ahead and implement those" (remove the pot bonus, a 500/day play cap,
-- fix forward with no take-backs) and "focus on ... farming, check-in or fake
-- matches ... the league season period rewards could be farmed". Betting is
-- left alone on purpose (it may never ship). Check-ins pay no pickles and feed
-- no streak or badge, so they need nothing here.
-- Audit: state/pickle-economy-inventory.md (2026-10-28).
--
-- ── What changes ──────────────────────────────────────────────────────────
--   1. A 500/day cap on pickles from play, in the player's own day
--      (_pickleague_tz_for). Play = match games, the play streak, new courts,
--      badges, tournaments played, drill reviews (PLAY_SOURCES below; the
--      ledger's source names). Bonuses stay uncapped: welcome, getting
--      started, first match / first doubles, daily login, referrals, prizes
--      (prizes move pickles players put in; they are not minted).
--        * _pl_play_cap_left(uid) = 500 - today's play rows in pickle_ledger.
--        * The four grants below ask it first, pay what is left and word the
--          push with the real amount (no push at 0).
--        * trg_profiles_play_cap (BEFORE UPDATE OF pickles) clamps any other
--          play source to what is left (court bonus, drill review). Those
--          two may still say "+100" in their push on a capped day.
--   2. Badges (_grant_pickles_on_badge): 150 pickles per badge, but only
--        * competition badges (Period Champion, Period Sweeper, Season Crown /
--          Silver / Bronze, Tournament Champion / Silver / Bronze): once per
--          (badge, league, context), and only when there was real play:
--          a league needs 4+ players who each played 2+ completed matches in
--          it against 2+ different opponents in the last 120 days
--          (_pl_league_real_play); a tournament needs 4+ approved registrants
--          who each played a completed tournament match (_pl_tournament_real_play).
--          The badge is still awarded in a small league; it pays nothing.
--          Re-locking a period or re-completing a season pays nothing again.
--        * every other badge: the first time a player earns it. Repeats
--          (Perfect Game, Marathon, Underdog, a league badge in a new league)
--          add to the xN count with no pickles.
--      pickle_badge_payouts records each payout; every existing badge row is
--      backfilled as paid, so nothing earned so far pays twice.
--   3. Match games (_grant_match_game_bonus): 25 per game for at most 5 games
--      (game_scores length was unlimited), and nothing for a 4th+ match with
--      the same players within 24 hours.
--   4. Play streak (_grant_daily_streak_bonus): only for a match played
--      yesterday, today or tomorrow in the player's zone, so a streak can't be
--      back-filled with old played_at dates. bonus_granted records what was
--      really paid (the delete reversal takes back that much).
--   5. Tournament played (_grant_tournament_participation_bonus): +50 only for
--      a tournament with real play (as in 2), within the cap.
--   6. Pots (contribute_pickles_to_pool): no house bonus. The pot grows by
--      exactly what the admin puts in (it minted 25% before).
--   7. Server-owned columns (trg_pl_pot_columns_guard on leagues,
--      league_seasons, tournaments): a client can no longer set prize_pool,
--      elo_reset_applied or champion_payout_applied_at (the tournament edit
--      sheet had a "Prize pool override" field: any amount, minted). A client
--      insert must leave them at their defaults. Server code (SECURITY
--      DEFINER, owner postgres) is untouched, as with trg_profiles_column_guard.
--   8. Matches: the policy "League members can update scheduled matches"
--      (migration_add_scheduling.sql) goes. No app code updates matches; with
--      it any league member could mark a match completed without the
--      opponent's confirmation and collect every match grant.
--   9. Drill requests (trg_pl_drill_request_guard): only the invited player
--      accepts or declines; nobody moves a request back to pending; the two
--      players can't be changed. The sender used to accept their own request
--      with a past slot, review the "session" for up to 75, and repeat.
--
-- Refusal codes (HINT 'pl:<code>', mobile/src/lib/refusals.ts):
--   pot.server_owned, drill.not_yours
--
-- New internal functions (execute revoked from public, anon, authenticated):
--   _pl_play_cap_left(uuid), _pl_play_source(), _pl_profiles_play_cap(),
--   _pl_league_real_play(uuid), _pl_tournament_real_play(uuid),
--   _pl_pot_columns_guard(), _pl_drill_request_guard()
-- Replaced (bodies from their last repo file; check-replaced-functions.mjs
-- refuses to go on if live differs):
--   _grant_pickles_on_badge()               migration_bump_base_pickle_grants.sql
--   _grant_match_game_bonus()               migration_daily_login_and_match_game_bonuses.sql
--   _grant_daily_streak_bonus()             migration_local_day_boundaries.sql
--   _grant_tournament_participation_bonus() migration_shop_rewards_and_progress_badges.sql
--   contribute_pickles_to_pool(text,uuid,integer) migration_add_pickle_pots.sql
--
-- Idempotent; no top-level transaction. Persona test:
--   supabase/tests/pickle_economy_personas.sql
-- Apply with state/pickle-economy-apply.ps1, then re-run
-- migration_rls_hardening_2026q3.sql.
-- ============================================================


-- ════ 1. The daily play cap ══════════════════════════════════════════════

-- Pickles still payable from play today (0..500), in the player's own day.
create or replace function public._pl_play_cap_left(p_uid uuid)
returns integer
language plpgsql
volatile    -- sees the rows earlier grants of the same transaction wrote
security definer
set search_path = ''
as $$
declare
  v_tz    text := public._pickleague_tz_for(p_uid);
  v_start timestamptz := ((now() at time zone v_tz)::date)::timestamp at time zone v_tz;
  v_paid  integer;
begin
  select coalesce(sum(l.delta), 0)::integer into v_paid
    from public.pickle_ledger l
   where l.profile_id = p_uid
     and l.created_at >= v_start
     and l.delta > 0
     and l.source = any (array[
       '_grant_match_game_bonus', '_grant_daily_streak_bonus', '_grant_court_bonus',
       '_grant_pickles_on_badge', '_grant_tournament_participation_bonus', 'submit_drill_review']);
  return greatest(500 - v_paid, 0);
end $$;
revoke execute on function public._pl_play_cap_left(uuid) from public, anon, authenticated;

-- The function that is changing pickles right now: the nearest PL/pgSQL or
-- SQL frame below the trigger (the ledger's rule 2, migration_pickle_ledger.sql).
create or replace function public._pl_play_source()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ctx    text;
  v_frames text[];
begin
  get diagnostics v_ctx = pg_context;
  select array_agg(coalesce(m[2], m[3]) order by o)
    into v_frames
    from regexp_matches(v_ctx,
           'PL/pgSQL function (?:"?([A-Za-z0-9_]+)"?\.)?"?([A-Za-z0-9_]+)"?\(|SQL function "([A-Za-z0-9_]+)"',
           'g') with ordinality as r (m, o);
  v_frames := array_remove(array_remove(v_frames, '_pl_play_source'), '_pl_profiles_play_cap');
  return v_frames[1];
end $$;
revoke execute on function public._pl_play_source() from public, anon, authenticated;

-- The backstop: a raise from a play source never goes past the cap. Fails
-- open (keeps the change) on an unexpected error, like the ledger.
create or replace function public._pl_profiles_play_cap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_src  text;
  v_left integer;
begin
  if coalesce(new.pickles, 0) <= coalesce(old.pickles, 0) then
    return new;
  end if;
  begin
    v_src := public._pl_play_source();
    if v_src = any (array[
         '_grant_match_game_bonus', '_grant_daily_streak_bonus', '_grant_court_bonus',
         '_grant_pickles_on_badge', '_grant_tournament_participation_bonus', 'submit_drill_review']) then
      v_left := public._pl_play_cap_left(new.id);
      if new.pickles - coalesce(old.pickles, 0) > v_left then
        new.pickles := coalesce(old.pickles, 0) + v_left;
      end if;
    end if;
  exception when others then
    raise warning 'play cap: left a % pickles raise on profile % unchecked (%: %)',
      new.pickles - coalesce(old.pickles, 0), new.id, sqlstate, sqlerrm;
  end;
  return new;
end $$;
revoke execute on function public._pl_profiles_play_cap() from public, anon, authenticated;

-- CREATE OR REPLACE TRIGGER, never DROP + CREATE (no ACCESS EXCLUSIVE on a re-run).
create or replace trigger trg_profiles_play_cap
  before update of pickles on public.profiles
  for each row
  when (new.pickles > old.pickles)
  execute function public._pl_profiles_play_cap();


-- ════ 2. Real play: what a competition badge needs ═══════════════════════

-- 4+ players who each played 2+ completed matches in the league against 2+
-- different opponents in the last 120 days.
create or replace function public._pl_league_real_play(p_league uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with m as (
    select x.id, x.player1_id, x.partner1_id, x.player2_id, x.partner2_id
      from public.matches x
     where x.league_id = p_league
       and coalesce(x.status, 'completed') = 'completed'
       and coalesce(x.played_at, x.created_at) > now() - interval '120 days'
  ), faced as (
    select m.id, v.me, v.opp
      from m
      cross join lateral (values
        (m.player1_id, m.player2_id), (m.player1_id, m.partner2_id),
        (m.partner1_id, m.player2_id), (m.partner1_id, m.partner2_id),
        (m.player2_id, m.player1_id), (m.player2_id, m.partner1_id),
        (m.partner2_id, m.player1_id), (m.partner2_id, m.partner1_id)) as v (me, opp)
     where v.me is not null and v.opp is not null and v.me <> v.opp
  ), per as (
    select f.me, count(distinct f.id) as games, count(distinct f.opp) as opponents
      from faced f
     group by f.me
  )
  select count(*) >= 4 from per where per.games >= 2 and per.opponents >= 2;
$$;
revoke execute on function public._pl_league_real_play(uuid) from public, anon, authenticated;

-- 4+ approved registrants who each played a completed match in the tournament.
create or replace function public._pl_tournament_real_play(p_tournament uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select count(distinct r.user_id) >= 4
    from public.tournament_registrations r
   where r.tournament_id = p_tournament
     and r.status = 'approved'
     and r.user_id is not null
     and exists (
       select 1 from public.tournament_matches tm
        where tm.tournament_id = p_tournament
          and tm.status = 'completed'
          and r.user_id in (tm.team1_player1, tm.team1_player2, tm.team2_player1, tm.team2_player2));
$$;
revoke execute on function public._pl_tournament_real_play(uuid) from public, anon, authenticated;


-- ════ 3. Badges pay once, competitions only with real play ═══════════════

create table if not exists public.pickle_badge_payouts (
  user_id   uuid not null references public.profiles(id) on delete cascade,
  badge_id  uuid not null references public.badges(id) on delete cascade,
  scope_key text not null,      -- '' = once ever; competitions: league id | context
  paid      integer not null,
  paid_at   timestamptz not null default now(),
  primary key (user_id, badge_id, scope_key)
);
comment on table public.pickle_badge_payouts is
  'migration_pickle_economy_guards.sql: which badge awards have paid their pickles (written only by _grant_pickles_on_badge).';
do $$
begin
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.pickle_badge_payouts'::regclass) then
    alter table public.pickle_badge_payouts enable row level security;
  end if;
end $$;
revoke all on table public.pickle_badge_payouts from public, anon, authenticated;
grant all on table public.pickle_badge_payouts to service_role;

-- Every badge earned so far was paid when it was earned (150, or 50 before
-- 2026-05-25; the amount is only a note).
insert into public.pickle_badge_payouts (user_id, badge_id, scope_key, paid, paid_at)
select pb.user_id, pb.badge_id,
       case when b.name in ('Period Champion', 'Period Sweeper', 'Season Crown', 'Season Silver',
                            'Season Bronze', 'Tournament Champion', 'Tournament Silver', 'Tournament Bronze')
            then coalesce(pb.league_id::text, '') || '|' || coalesce(pb.context, '')
            else '' end,
       150, min(coalesce(pb.earned_at, now()))
  from public.player_badges pb
  join public.badges b on b.id = pb.badge_id
 group by 1, 2, 3
on conflict do nothing;

create or replace function public._grant_pickles_on_badge()
returns trigger language plpgsql security definer as $$
declare
  v_badge_name text;
  v_comp       boolean;
  v_key        text;
  v_real       boolean;
  v_tid        uuid;
  v_pay        integer;
  v_rows       integer;
begin
  if current_setting('pickleague.skip_badge_pickle_grant', true) = 'on' then
    return new;
  end if;

  select name into v_badge_name from public.badges where id = new.badge_id;
  if v_badge_name is null then return new; end if;

  -- Competitions pay only with real play, everything once (migration_pickle_economy_guards.sql §2).
  v_comp := v_badge_name in ('Period Champion', 'Period Sweeper', 'Season Crown', 'Season Silver',
                             'Season Bronze', 'Tournament Champion', 'Tournament Silver', 'Tournament Bronze');
  if v_comp then
    v_key := coalesce(new.league_id::text, '') || '|' || coalesce(new.context, '');
    if new.league_id is not null then
      v_real := public._pl_league_real_play(new.league_id);
    else
      -- A podium badge: the payout wrote this player's champion row just before.
      select tcb.tournament_id into v_tid
        from public.tournament_champion_badges tcb
       where tcb.user_id = new.user_id
       order by tcb.awarded_at desc nulls last
       limit 1;
      v_real := v_tid is not null and public._pl_tournament_real_play(v_tid);
    end if;
    if not coalesce(v_real, false) then return new; end if;
  else
    v_key := '';
  end if;

  v_pay := least(150, public._pl_play_cap_left(new.user_id));
  insert into public.pickle_badge_payouts (user_id, badge_id, scope_key, paid)
  values (new.user_id, new.badge_id, v_key, v_pay)
  on conflict do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 or v_pay <= 0 then return new; end if;

  update public.profiles set pickles = coalesce(pickles, 0) + v_pay where id = new.user_id;

  begin
    perform public._notify_user(
      new.user_id,
      format('🥒 +%s pickles for earning %s!', v_pay, v_badge_name),
      format('You received %s 🥒 for earning the %s badge. Tap to see your shop balance.', v_pay, v_badge_name),
      new.user_id,
      'shop'
    );
  exception when others then null;
  end;

  return new;
end;
$$;


-- ════ 4. Match games: at most 5, not the same players a 4th time a day ═══

create or replace function public._grant_match_game_bonus()
returns trigger language plpgsql security definer as $$
declare
  v_uid   uuid;
  v_games integer;
  v_bonus integer;
  v_rowcount integer;
  v_players uuid[];
  v_repeats integer;
begin
  if coalesce(new.status, 'completed') <> 'completed' then return new; end if;

  -- At most 5 games pay (migration_pickle_economy_guards.sql §3).
  v_games := least(greatest(coalesce(jsonb_array_length(new.game_scores), 1), 1), 5);

  -- The same players a 4th time within 24 hours: no game pickles.
  select array_agg(u order by u) into v_players
    from unnest(array[new.player1_id, new.partner1_id, new.player2_id, new.partner2_id]) as u
   where u is not null;
  select count(*) into v_repeats
    from public.matches x
   where x.id <> new.id
     and coalesce(x.status, 'completed') = 'completed'
     and coalesce(x.played_at, x.created_at)
         between coalesce(new.played_at, now()) - interval '24 hours' and coalesce(new.played_at, now()) + interval '24 hours'
     and x.player1_id = any (v_players)
     and (select array_agg(u order by u)
            from unnest(array[x.player1_id, x.partner1_id, x.player2_id, x.partner2_id]) as u
           where u is not null) = v_players;
  if v_repeats >= 3 then return new; end if;

  for v_uid in
    select distinct uid from (values
      (new.player1_id), (new.partner1_id), (new.player2_id), (new.partner2_id)
    ) as t(uid)
    where uid is not null
  loop
    begin
      v_bonus := least(v_games * 25, public._pl_play_cap_left(v_uid));
      insert into public.match_game_bonus_grants(match_id, user_id, games)
        values (new.id, v_uid, v_games)
        on conflict (match_id, user_id) do nothing;
      get diagnostics v_rowcount = row_count;
      if v_rowcount > 0 and v_bonus > 0 then
        update public.profiles set pickles = coalesce(pickles, 0) + v_bonus where id = v_uid;
        begin
          perform public._notify_user(
            v_uid,
            format('🥒 +%s pickles for your match!', v_bonus),
            format('You earned %s 🥒 for playing %s game%s. Tap to see your shop balance.',
                   v_bonus, v_games, case when v_games = 1 then '' else 's' end),
            v_uid,
            'shop'
          );
        exception when others then null;
        end;
      end if;
    exception when others then null;
    end;
  end loop;
  return new;
end;
$$;


-- ════ 5. Play streak: no back-filled days ═════════════════════════════════

CREATE OR REPLACE FUNCTION public._grant_daily_streak_bonus()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_uid      uuid;
  v_date     date;
  v_today    date;
  v_prev_len integer;
  v_len      integer;
  v_bonus    integer;
begin
  if coalesce(new.status, 'completed') <> 'completed' then return new; end if;

  for v_uid in
    select distinct uid from (values
      (new.player1_id), (new.partner1_id), (new.player2_id), (new.partner2_id)
    ) as t(uid)
    where uid is not null
  loop
    begin
      v_date := (coalesce(new.played_at, now()) at time zone public._pickleague_tz_for(v_uid))::date;
      -- Only yesterday, today or tomorrow count (migration_pickle_economy_guards.sql §5).
      v_today := (now() at time zone public._pickleague_tz_for(v_uid))::date;
      if v_date not between v_today - 1 and v_today + 1 then
        continue;
      end if;
      if exists (select 1 from public.daily_play_streaks where user_id = v_uid and play_date = v_date) then
        continue;
      end if;

      select streak_length into v_prev_len
        from public.daily_play_streaks
        where user_id = v_uid and play_date = v_date - 1;

      v_len   := coalesce(v_prev_len, 0) + 1;
      v_bonus := least(50 * v_len, 200, public._pl_play_cap_left(v_uid));

      insert into public.daily_play_streaks(user_id, play_date, streak_length, bonus_granted)
        values (v_uid, v_date, v_len, v_bonus)
        on conflict (user_id, play_date) do nothing;

      if v_bonus > 0 then
        update public.profiles set pickles = coalesce(pickles, 0) + v_bonus where id = v_uid;

        begin
          perform public._notify_user(
            v_uid,
            '🔥 Day ' || v_len || ' streak: +' || v_bonus || '🥒!',
            '🔥 Day ' || v_len || ' streak: +' || v_bonus || '🥒!',
            v_uid,
            'shop'
          );
        exception when others then null;
        end;
      end if;
    exception when others then null;
    end;
  end loop;
  return new;
end;
$function$;
revoke execute on function public._grant_daily_streak_bonus() from public, anon, authenticated;


-- ════ 6. Tournament played: only with real play ═══════════════════════════

create or replace function public._grant_tournament_participation_bonus()
returns trigger language plpgsql security definer as $$
declare
  v_uid  uuid;
  v_name text;
  v_pay  integer;
begin
  if new.status <> 'completed' then return new; end if;
  if TG_OP = 'UPDATE' and old.status = 'completed' then return new; end if;
  -- 4+ registrants who played (migration_pickle_economy_guards.sql §6).
  if not public._pl_tournament_real_play(new.id) then return new; end if;

  select name into v_name from public.tournaments where id = new.id;

  for v_uid in
    select user_id from public.tournament_registrations
     where tournament_id = new.id and status = 'approved' and user_id is not null
  loop
    begin
      if exists (
        select 1 from public.tournament_participation_grants
         where user_id = v_uid and tournament_id = new.id
      ) then
        continue;
      end if;

      insert into public.tournament_participation_grants(user_id, tournament_id)
        values (v_uid, new.id)
        on conflict (user_id, tournament_id) do nothing;

      v_pay := least(50, public._pl_play_cap_left(v_uid));
      if v_pay <= 0 then
        continue;
      end if;
      update public.profiles set pickles = coalesce(pickles, 0) + v_pay where id = v_uid;

      begin
        perform public._notify_user(
          v_uid,
          format('🥒 Tournament played: +%s pickles', v_pay),
          format('🥒 Tournament played: +%s pickles for completing %s.', v_pay, coalesce(v_name, 'tournament')),
          new.id,
          'shop'
        );
      exception when others then null;
      end;
    exception when others then null;
    end;
  end loop;

  return new;
end;
$$;
revoke execute on function public._grant_tournament_participation_bonus() from public, anon, authenticated;


-- ════ 7. Pots: no house bonus ═════════════════════════════════════════════

create or replace function public.contribute_pickles_to_pool(
  p_scope_type text,
  p_scope_id   uuid,
  p_amount     integer
) returns table (success boolean, new_pool integer, contributor_balance integer, message text)
language plpgsql security definer as $$
declare
  v_uid     uuid := auth.uid();
  v_balance integer;
  v_bonus   integer;
  v_added   integer;
  v_new_pool integer;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if p_amount is null or p_amount <= 0 then
    return query select false, null::integer, null::integer, 'Amount must be positive'::text; return;
  end if;
  if not public.is_scope_admin(p_scope_type, p_scope_id) then
    return query select false, null::integer, null::integer, 'Only admins/co-admins may contribute'::text; return;
  end if;

  select pickles into v_balance from public.profiles where id = v_uid;
  if v_balance < p_amount then
    return query select false, null::integer, v_balance, 'Not enough pickles'::text; return;
  end if;

  -- No house bonus (migration_pickle_economy_guards.sql §7): it minted 25%.
  v_bonus := 0;
  v_added := p_amount;

  update public.profiles set pickles = pickles - p_amount where id = v_uid returning pickles into v_balance;
  v_new_pool := public._update_pool(p_scope_type, p_scope_id, v_added);

  insert into public.pickle_pot_contributions
    (scope_type, scope_id, user_id, amount_paid, bonus_amount, pool_added)
  values (p_scope_type, p_scope_id, v_uid, p_amount, v_bonus, v_added);

  return query select true, v_new_pool, v_balance, format('Added %s 🥒 to the pot', p_amount);
end;
$$;


-- ════ 8. Server-owned pot columns ═════════════════════════════════════════
-- SECURITY INVOKER on purpose: it has to see the caller's role.
create or replace function public._pl_pot_columns_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_new jsonb := to_jsonb(new);
  v_old jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else null end;
  v_col text;
  v_bad text[] := '{}';
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;
  foreach v_col in array array['prize_pool', 'elo_reset_applied', 'champion_payout_applied_at'] loop
    if not (v_new ? v_col) then
      continue;
    end if;
    if tg_op = 'UPDATE' then
      if (v_new -> v_col) is distinct from (v_old -> v_col) then
        v_bad := v_bad || v_col;
      end if;
    elsif v_new -> v_col not in ('null'::jsonb, '0'::jsonb, 'false'::jsonb) then
      v_bad := v_bad || v_col;
    end if;
  end loop;
  if cardinality(v_bad) > 0 then
    raise exception 'The prize pot is set by the server.'
      using hint = 'pl:pot.server_owned',
            detail = jsonb_build_object('columns', to_jsonb(v_bad))::text;
  end if;
  return new;
end $$;
revoke execute on function public._pl_pot_columns_guard() from public, anon, authenticated;

create or replace trigger trg_pl_pot_columns_guard
  before insert or update on public.leagues
  for each row execute function public._pl_pot_columns_guard();
create or replace trigger trg_pl_pot_columns_guard
  before insert or update on public.league_seasons
  for each row execute function public._pl_pot_columns_guard();
create or replace trigger trg_pl_pot_columns_guard
  before insert or update on public.tournaments
  for each row execute function public._pl_pot_columns_guard();


-- ════ 10. Drill requests: only the invited player answers ════════════════
create or replace function public._pl_drill_request_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;
  if new.from_user_id is distinct from old.from_user_id
     or new.to_user_id is distinct from old.to_user_id
     or (new.status = 'pending' and old.status is distinct from 'pending')
     or (new.status in ('accepted', 'declined') and new.status is distinct from old.status
         and (old.status is distinct from 'pending' or auth.uid() is distinct from new.to_user_id)) then
    raise exception 'Only the invited player can answer this drill request.'
      using hint = 'pl:drill.not_yours';
  end if;
  return new;
end $$;
revoke execute on function public._pl_drill_request_guard() from public, anon, authenticated;

create or replace trigger trg_pl_drill_request_guard
  before update on public.drill_requests
  for each row execute function public._pl_drill_request_guard();


-- ════ 9. Matches: no client UPDATE ════════════════════════════════════════
-- Last on purpose: DROP POLICY takes ACCESS EXCLUSIVE on matches (reads wait)
-- until the file's transaction ends, so it holds it only for the commit.
drop policy if exists "League members can update scheduled matches" on public.matches;
