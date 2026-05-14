-- ============================================================
-- Mega-migration: Audit fixes and consolidated bug-fix bundle (2026 Q2)
--
-- Consolidates 13 individual migrations into a single ordered file.
-- Source migrations (in original chronological order):
--
--   1.  migration_audit_match_type_constraints.sql
--         - Enforce partner_id consistency with matches.match_type
--           (singles ↔ both partners null; doubles ↔ both non-null).
--   2.  migration_audit_match_score_constraints.sql
--         - Pickleball score sanity constraints on matches and
--           tournament_matches (winner >= 11, win-by-2, cap 50).
--   3.  migration_single_elim_advancement.sql
--         - Auto-advance single/double-elim brackets and flip
--           tournament status to 'completed' when champion remains.
--   4.  migration_mlp_playoff_round_advance.sql
--         - Auto-generate the next MLP playoff layer (QF → SF → F)
--           when the current layer fully completes.
--   5.  migration_gate_match_triggers_on_completed.sql
--         - Gate every match-driven badge/pickle trigger on
--           status = 'completed' so pending rows don't grant rewards
--           that survive expire_pending_matches deletions.
--   6.  migration_pickles_per_badge_backfill_guard.sql
--         - Add a session-local skip guard so badge backfill migrations
--           can avoid the per-badge +50 🥒 grant + notification.
--   7.  migration_revive_court_ratings.sql
--         - Reinstate maintenance of player_location_ratings via a
--           separate additive trigger (the PLUPR rewrite dropped it).
--   8.  migration_fix_mlp_set_slot_gender.sql
--         - Reject placing a player into an MLP slot whose gender
--           does not match (wildcards still allowed either side).
--   9.  migration_fix_mlp_third_place_tiebreaker.sql
--         - Apply the full finals tiebreaker cascade (wins → pt diff
--           → RR record → seed) to semifinal-loser derivation in
--           preview_mlp_tournament_payout.
--   10. migration_fix_recompute_doubles_classifier.sql
--         - Make recompute_doubles_ratings() honor per-match gender
--           overrides by using _classify_doubles_with_overrides.
--   11. migration_preserve_split_ratings_on_season_reset.sql
--         - lock_season_period + complete_season only reset OVERALL
--           rating; singles/doubles/mixed splits are preserved.
--   12. migration_fix_period_relock_badge_revoke.sql
--         - lock_season_period revokes any prior Period Champion
--           badge for the same season+period before re-awarding.
--   13. migration_fix_period_sweeper_late_joiners.sql
--         - complete_season relaxes Period Sweeper criterion: rank=1
--           in every snapshot the player appeared in (vs every period).
--
-- IMPORTANT MERGE NOTES:
--   * lock_season_period is defined ONCE below, combining the fixes from
--     (11) only-overall-reset AND (12) revoke-prior-champion-before-award.
--   * complete_season is defined ONCE below, combining the fixes from
--     (11) only-overall-reset AND (13) relaxed Period Sweeper criterion.
--
-- Ordering within this file:
--   1. Schema constraints
--   2. Helper functions (referenced by triggers/RPCs below)
--   3. Function definitions in dependency order
--   4. Triggers (drop + create)
--   5. Grants
--   6. Single `notify pgrst, 'reload schema';` at the end
-- ============================================================


-- ============================================================
-- SECTION 1: Schema constraints
-- ============================================================

-- ── 1a. matches.match_type ↔ partner_id consistency ──────────
-- (source: migration_audit_match_type_constraints.sql)
--
-- Defensively repair any rows that would violate the constraint
-- before we attach it. For 'singles' rows, null out any leaked
-- partners. For 'doubles' rows missing partners, we cannot invent
-- player IDs — demote to 'singles'. Both should be no-ops if the
-- client has always behaved.

update public.matches
   set partner1_id = null,
       partner2_id = null
 where match_type = 'singles'
   and (partner1_id is not null or partner2_id is not null);

do $$
declare
  v_broken_doubles integer;
begin
  select count(*) into v_broken_doubles
    from public.matches
   where match_type = 'doubles'
     and (partner1_id is null or partner2_id is null);

  if v_broken_doubles > 0 then
    raise notice 'Demoting % doubles matches with missing partners to singles', v_broken_doubles;
    update public.matches
       set match_type  = 'singles',
           partner1_id = null,
           partner2_id = null
     where match_type = 'doubles'
       and (partner1_id is null or partner2_id is null);
  end if;
end $$;

alter table public.matches
  drop constraint if exists matches_partners_match_type_check;

alter table public.matches
  add constraint matches_partners_match_type_check
  check (
    (match_type = 'singles' and partner1_id is null     and partner2_id is null)
    or
    (match_type = 'doubles' and partner1_id is not null and partner2_id is not null)
  );


-- ── 1b. Pickleball score sanity constraints ──────────────────
-- (source: migration_audit_match_score_constraints.sql)
--
-- Winner >= 11, win-by-2, cap 50 to block typo-grade junk while
-- leaving room for long deuce battles. NULL scores allowed
-- (pending/scheduled rows).

alter table public.matches
  drop constraint if exists matches_score_sanity_check;

alter table public.matches
  add constraint matches_score_sanity_check
  check (
    player1_score is null
    or player2_score is null
    or (
      greatest(player1_score, player2_score) >= 11
      and abs(player1_score - player2_score) >= 2
      and greatest(player1_score, player2_score) <= 50
    )
  )
  not valid;

alter table public.matches
  validate constraint matches_score_sanity_check;

alter table public.tournament_matches
  drop constraint if exists tournament_matches_score_sanity_check;

alter table public.tournament_matches
  add constraint tournament_matches_score_sanity_check
  check (
    team1_score is null
    or team2_score is null
    or (
      greatest(team1_score, team2_score) >= 11
      and abs(team1_score - team2_score) >= 2
      and greatest(team1_score, team2_score) <= 50
    )
  )
  not valid;

alter table public.tournament_matches
  validate constraint tournament_matches_score_sanity_check;


-- ============================================================
-- SECTION 2: Helper functions
-- ============================================================

-- ── 2a. _mlp_round_winner ────────────────────────────────────
-- (source: migration_mlp_playoff_round_advance.sql)
--
-- Resolves which MLP team won a given playoff round, using the same
-- tiebreaker cascade as preview_mlp_tournament_payout:
--   1. More rotation wins
--   2. Better point differential (a_points - b_points)
--   3. Lower seed (better seed)
--   4. Arbitrary fall-through to team_a
create or replace function public._mlp_round_winner(p_round_id uuid)
returns uuid language plpgsql stable as $$
declare
  v_state    record;
  v_a_seed   integer;
  v_b_seed   integer;
  v_a_better boolean;
begin
  select * into v_state from public._mlp_round_series_state(p_round_id);
  if v_state.team_a_id is null or v_state.team_b_id is null then
    return null;
  end if;

  if v_state.a_wins <> v_state.b_wins then
    v_a_better := v_state.a_wins > v_state.b_wins;
  elsif (v_state.a_points - v_state.b_points) <> 0 then
    v_a_better := (v_state.a_points - v_state.b_points) > 0;
  else
    select t.seed into v_a_seed from public.mlp_teams t where t.id = v_state.team_a_id;
    select t.seed into v_b_seed from public.mlp_teams t where t.id = v_state.team_b_id;
    if coalesce(v_a_seed, 999) <> coalesce(v_b_seed, 999) then
      v_a_better := coalesce(v_a_seed, 999) < coalesce(v_b_seed, 999);
    else
      v_a_better := true;
    end if;
  end if;

  if v_a_better then return v_state.team_a_id; else return v_state.team_b_id; end if;
end;
$$;


-- ============================================================
-- SECTION 3: Function definitions
-- ============================================================

-- ── 3a. _advance_single_elim_bracket ─────────────────────────
-- (source: migration_single_elim_advancement.sql)
create or replace function public._advance_single_elim_bracket()
returns trigger language plpgsql security definer as $$
declare
  v_format          text;
  v_match_type      text;
  v_round_number    integer;
  v_round_type      text;
  v_uncompleted     integer;
  v_winner_count    integer;
  v_next_round_id   uuid;
  v_next_round_num  integer;
  v_next_round_type text;
  v_next_label      text;
  v_pair_count      integer;
  v_i               integer;
  v_w1              record;
  v_w2              record;
begin
  if new.status <> 'completed' then return new; end if;
  if TG_OP = 'UPDATE' and old.status = 'completed' then return new; end if;

  begin
    select format, match_type
      into v_format, v_match_type
      from public.tournaments
     where id = new.tournament_id;
    if v_format not in ('single_elimination', 'double_elimination') then
      return new;
    end if;

    select round_number, round_type
      into v_round_number, v_round_type
      from public.tournament_rounds
     where id = new.round_id;
    if v_round_number is null then return new; end if;

    select count(*) into v_uncompleted
      from public.tournament_matches
     where round_id = new.round_id
       and status <> 'completed';
    if v_uncompleted > 0 then return new; end if;

    select count(*) into v_winner_count
      from public.tournament_matches
     where round_id = new.round_id
       and winner_team in ('team1', 'team2');

    if v_winner_count <= 1 then
      update public.tournaments
         set status = 'completed'
       where id = new.tournament_id
         and status <> 'completed';
      return new;
    end if;

    v_next_round_num := v_round_number + 1;
    if exists (
      select 1 from public.tournament_rounds
       where tournament_id = new.tournament_id
         and round_number = v_next_round_num
    ) then
      return new;
    end if;

    v_pair_count := v_winner_count / 2;
    if v_pair_count < 1 then return new; end if;

    if v_pair_count = 1 then
      v_next_round_type := 'finals';
      v_next_label      := 'Finals';
    else
      v_next_round_type := 'winners';
      v_next_label      := format('Round %s', v_next_round_num);
    end if;

    insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
    values (new.tournament_id, v_next_round_num, v_next_label, v_next_round_type)
    returning id into v_next_round_id;

    for v_i in 0..(v_pair_count - 1) loop
      with ordered as (
        select tm.*,
               row_number() over (order by match_order, id) - 1 as rn
          from public.tournament_matches tm
         where tm.round_id = new.round_id
           and tm.winner_team in ('team1','team2')
      )
      select * into v_w1 from ordered where rn = v_i * 2;

      with ordered as (
        select tm.*,
               row_number() over (order by match_order, id) - 1 as rn
          from public.tournament_matches tm
         where tm.round_id = new.round_id
           and tm.winner_team in ('team1','team2')
      )
      select * into v_w2 from ordered where rn = v_i * 2 + 1;

      if v_w1 is null or v_w2 is null then
        continue;
      end if;

      insert into public.tournament_matches (
        tournament_id, round_id, match_order, match_type,
        team1_player1, team1_player2,
        team2_player1, team2_player2,
        status
      )
      values (
        new.tournament_id,
        v_next_round_id,
        v_i,
        coalesce(v_match_type, 'singles'),
        case when v_w1.winner_team = 'team1' then v_w1.team1_player1 else v_w1.team2_player1 end,
        case when v_w1.winner_team = 'team1' then v_w1.team1_player2 else v_w1.team2_player2 end,
        case when v_w2.winner_team = 'team1' then v_w2.team1_player1 else v_w2.team2_player1 end,
        case when v_w2.winner_team = 'team1' then v_w2.team1_player2 else v_w2.team2_player2 end,
        'pending'
      );
    end loop;

  exception when others then
    null;
  end;

  return new;
end;
$$;


-- ── 3b. _advance_mlp_playoff_round ───────────────────────────
-- (source: migration_mlp_playoff_round_advance.sql)
create or replace function public._advance_mlp_playoff_round()
returns trigger language plpgsql security definer as $$
declare
  v_round_type      text;
  v_tournament_id   uuid;
  v_pending         integer;
  v_round_ids       uuid[];
  v_round_id        uuid;
  v_winners         uuid[];
  v_target_type     text;
  v_target_label    text;
  v_target_base_no  integer;
  v_team_a          record;
  v_team_b          record;
  v_new_round_id    uuid;
  v_match_order     integer;
  v_pair_count      integer;
  v_i               integer;
  v_a_idx           integer;
  v_b_idx           integer;
begin
  if new.status <> 'completed' then return new; end if;
  if TG_OP = 'UPDATE' and old.status = 'completed' then return new; end if;

  select tr.round_type, tr.tournament_id
    into v_round_type, v_tournament_id
    from public.tournament_rounds tr
   where tr.id = new.round_id;

  if v_round_type not in ('quarterfinals', 'semifinals') then return new; end if;

  begin
    select count(*) into v_pending
      from public.tournament_matches tm
      join public.tournament_rounds tr on tr.id = tm.round_id
     where tr.tournament_id = v_tournament_id
       and tr.round_type   = v_round_type
       and tm.status      <> 'completed';
    if v_pending > 0 then return new; end if;

    if v_round_type = 'quarterfinals' then
      v_target_type    := 'semifinals';
      v_target_label   := 'Semifinals';
      v_target_base_no := 1100;
    else
      v_target_type    := 'finals';
      v_target_label   := 'Finals';
      v_target_base_no := 1200;
    end if;

    if exists (
      select 1 from public.tournament_rounds
       where tournament_id = v_tournament_id
         and round_type    = v_target_type
    ) then
      return new;
    end if;

    select array_agg(tr.id order by tr.round_number)
      into v_round_ids
      from public.tournament_rounds tr
     where tr.tournament_id = v_tournament_id
       and tr.round_type    = v_round_type;

    v_winners := array[]::uuid[];
    foreach v_round_id in array v_round_ids loop
      v_winners := v_winners || public._mlp_round_winner(v_round_id);
    end loop;

    if array_length(v_winners, 1) is null
       or array_position(v_winners, null) is not null then
      return new;
    end if;

    v_pair_count  := array_length(v_winners, 1) / 2;
    if v_pair_count < 1 then return new; end if;

    v_match_order := coalesce((
      select max(tm.match_order) from public.tournament_matches tm
       where tm.tournament_id = v_tournament_id
    ), 0);

    for v_i in 0..(v_pair_count - 1) loop
      v_a_idx := v_i + 1;
      v_b_idx := array_length(v_winners, 1) - v_i;

      select * into v_team_a from public.mlp_teams where id = v_winners[v_a_idx];
      select * into v_team_b from public.mlp_teams where id = v_winners[v_b_idx];

      if v_team_a.id is null or v_team_b.id is null then continue; end if;

      insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
      values (
        v_tournament_id,
        v_target_base_no + v_i + 1,
        format('%s · %s vs %s', v_target_label, v_team_a.name, v_team_b.name),
        v_target_type
      )
      returning id into v_new_round_id;

      v_match_order := public._insert_mlp_pairing_matches(
        v_tournament_id, v_new_round_id, v_team_a, v_team_b, v_match_order
      );
    end loop;
  exception when others then
    null;
  end;

  return new;
end;
$$;


-- ── 3c. Match-driven badge/pickle triggers (gated on 'completed') ─────
-- (source: migration_gate_match_triggers_on_completed.sql)
--
-- Each function recreates the existing trigger body with an early
-- guard:
--   if coalesce(new.status, 'completed') <> 'completed' then return new; end if;
-- and is wired AFTER INSERT OR UPDATE OF status so a pending row
-- that later flips to 'completed' via confirm_match still fires
-- the rewards exactly once.

-- _award_match_badges (Perfect Game + Century)
create or replace function public._award_match_badges()
returns trigger language plpgsql security definer as $$
declare
  v_pg_id    uuid;
  v_cn_id    uuid;
  v_played   date := coalesce(new.played_at, now())::date;
  v_winners  uuid[];
  v_uid      uuid;
  v_count    integer;
begin
  if coalesce(new.status, 'completed') <> 'completed' then return new; end if;

  select id into v_pg_id from public.badges where name = 'Perfect Game';
  select id into v_cn_id from public.badges where name = 'Century';

  if new.winner_team = 'team1' then
    v_winners := array_remove(array[new.player1_id, new.partner1_id], null);
  elsif new.winner_team = 'team2' then
    v_winners := array_remove(array[new.player2_id, new.partner2_id], null);
  end if;

  if v_pg_id is not null and v_winners is not null then
    if (new.winner_team = 'team1' and new.player1_score = 11 and new.player2_score = 0)
       or (new.winner_team = 'team2' and new.player2_score = 11 and new.player1_score = 0) then
      foreach v_uid in array v_winners loop
        insert into public.player_badges (user_id, badge_id, league_id, context)
        values (v_uid, v_pg_id, null, format('11-0 shutout on %s', v_played));
      end loop;
    end if;
  end if;

  if v_cn_id is not null then
    for v_uid in
      select unnest(array_remove(
        array[new.player1_id, new.partner1_id, new.player2_id, new.partner2_id], null
      ))
    loop
      select count(*) into v_count
        from public.matches m
       where m.player1_id  = v_uid or m.partner1_id = v_uid
          or m.player2_id  = v_uid or m.partner2_id = v_uid;
      if v_count > 0 and v_count % 100 = 0 then
        insert into public.player_badges (user_id, badge_id, league_id, context)
        values (v_uid, v_cn_id, null, format('Hit %s career matches', v_count));
      end if;
    end loop;
  end if;

  return new;
end;
$$;

-- _progress_check_on_match
create or replace function public._progress_check_on_match()
returns trigger language plpgsql security definer as $$
declare v_uid uuid;
begin
  if coalesce(new.status, 'completed') <> 'completed' then return new; end if;

  for v_uid in
    select distinct uid from (values
      (new.player1_id), (new.partner1_id), (new.player2_id), (new.partner2_id)
    ) as t(uid)
    where uid is not null
  loop
    begin
      perform public._award_progress_badges(v_uid);
    exception when others then null;
    end;
  end loop;
  return new;
end;
$$;

-- _grant_first_match_bonus
create or replace function public._grant_first_match_bonus()
returns trigger language plpgsql security definer as $$
declare
  v_uid   uuid;
  v_count integer;
begin
  if coalesce(new.status, 'completed') <> 'completed' then return new; end if;

  for v_uid in
    select distinct uid from (values
      (new.player1_id), (new.partner1_id), (new.player2_id), (new.partner2_id)
    ) as t(uid)
    where uid is not null
  loop
    begin
      if exists (select 1 from public.first_match_bonus_grants where user_id = v_uid) then
        continue;
      end if;

      select count(*) into v_count from public.matches
        where player1_id = v_uid or partner1_id = v_uid
           or player2_id = v_uid or partner2_id = v_uid;

      if v_count = 1 then
        insert into public.first_match_bonus_grants(user_id) values (v_uid)
          on conflict (user_id) do nothing;

        update public.profiles set pickles = coalesce(pickles, 0) + 200 where id = v_uid;

        begin
          perform public._notify_user(
            v_uid,
            '🥒 First match! +200 pickles to spend in the Shop.',
            '🥒 First match! +200 pickles to spend in the Shop.',
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

-- _grant_first_doubles_bonus
create or replace function public._grant_first_doubles_bonus()
returns trigger language plpgsql security definer as $$
declare
  v_uid         uuid;
  v_prior_count int;
begin
  if coalesce(new.status, 'completed') <> 'completed' then return new; end if;
  if new.match_type <> 'doubles' then return new; end if;

  foreach v_uid in array array[new.player1_id, new.partner1_id, new.player2_id, new.partner2_id] loop
    if v_uid is null then continue; end if;

    if exists (select 1 from public.first_doubles_bonus_grants where user_id = v_uid) then
      continue;
    end if;

    select count(*) into v_prior_count
    from public.matches
    where id <> new.id
      and match_type = 'doubles'
      and (player1_id = v_uid or partner1_id = v_uid or player2_id = v_uid or partner2_id = v_uid);

    if v_prior_count > 0 then continue; end if;

    begin
      insert into public.first_doubles_bonus_grants (user_id) values (v_uid)
        on conflict (user_id) do nothing;

      update public.profiles set pickles = coalesce(pickles, 0) + 150 where id = v_uid;

      perform public._notify_user(
        v_uid,
        '🥒 First doubles match! +150 pickles.',
        'You earned 150 🥒 for playing your first doubles match. Tap to see your shop balance.',
        v_uid,
        'shop'
      );
    exception when others then null;
    end;
  end loop;

  return new;
end;
$$;

-- _grant_court_bonus
create or replace function public._grant_court_bonus()
returns trigger language plpgsql security definer as $$
declare
  v_uid uuid;
  v_msg text;
begin
  if coalesce(new.status, 'completed') <> 'completed' then return new; end if;
  if new.location_name is null then return new; end if;

  for v_uid in
    select distinct uid from (values
      (new.player1_id), (new.partner1_id), (new.player2_id), (new.partner2_id)
    ) as t(uid)
    where uid is not null
  loop
    begin
      if exists (
        select 1 from public.court_bonus_grants
        where user_id = v_uid and location_name = new.location_name
      ) then
        continue;
      end if;

      insert into public.court_bonus_grants(user_id, location_name)
        values (v_uid, new.location_name)
        on conflict (user_id, location_name) do nothing;

      update public.profiles set pickles = coalesce(pickles, 0) + 100 where id = v_uid;

      v_msg := '🥒 New court bonus: +100 pickles for playing at ' || new.location_name || '.';
      begin
        perform public._notify_user(v_uid, v_msg, v_msg, v_uid, 'shop');
      exception when others then null;
      end;
    exception when others then null;
    end;
  end loop;
  return new;
end;
$$;

-- _grant_daily_streak_bonus
create or replace function public._grant_daily_streak_bonus()
returns trigger language plpgsql security definer as $$
declare
  v_uid      uuid;
  v_date     date;
  v_prev_len integer;
  v_len      integer;
  v_bonus    integer;
begin
  if coalesce(new.status, 'completed') <> 'completed' then return new; end if;

  v_date := (coalesce(new.played_at, now()))::date;
  for v_uid in
    select distinct uid from (values
      (new.player1_id), (new.partner1_id), (new.player2_id), (new.partner2_id)
    ) as t(uid)
    where uid is not null
  loop
    begin
      if exists (select 1 from public.daily_play_streaks where user_id = v_uid and play_date = v_date) then
        continue;
      end if;

      select streak_length into v_prev_len
        from public.daily_play_streaks
        where user_id = v_uid and play_date = v_date - 1;

      v_len   := coalesce(v_prev_len, 0) + 1;
      v_bonus := least(50 * v_len, 200);

      insert into public.daily_play_streaks(user_id, play_date, streak_length, bonus_granted)
        values (v_uid, v_date, v_len, v_bonus)
        on conflict (user_id, play_date) do nothing;

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
    exception when others then null;
    end;
  end loop;
  return new;
end;
$$;

-- _award_underdog_badge
create or replace function public._award_underdog_badge()
returns trigger language plpgsql security definer as $$
declare
  v_winner_rating integer;
  v_loser_rating  integer;
  v_diff          integer;
  v_played        date := coalesce(new.played_at, now())::date;
  v_winners       uuid[];
  v_uid           uuid;
begin
  if coalesce(new.status, 'completed') <> 'completed' then return new; end if;

  begin
    if new.player1_rating_before is null or new.player2_rating_before is null then
      return new;
    end if;

    if new.winner_team = 'team1' then
      v_winner_rating := new.player1_rating_before;
      v_loser_rating  := new.player2_rating_before;
      v_winners := array_remove(array[new.player1_id, new.partner1_id], null);
    elsif new.winner_team = 'team2' then
      v_winner_rating := new.player2_rating_before;
      v_loser_rating  := new.player1_rating_before;
      v_winners := array_remove(array[new.player2_id, new.partner2_id], null);
    else
      return new;
    end if;

    v_diff := v_loser_rating - v_winner_rating;
    if v_diff < 100 then return new; end if;

    if v_winners is not null then
      foreach v_uid in array v_winners loop
        perform public.award_profile_badge(
          v_uid, 'Underdog',
          format('Beat a +%s opponent on %s', v_diff, v_played)
        );
      end loop;
    end if;
  exception when others then null;
  end;
  return new;
end;
$$;

-- _award_cinderella_badge
create or replace function public._award_cinderella_badge()
returns trigger language plpgsql security definer as $$
declare
  v_winner_rating integer;
  v_loser_rating  integer;
  v_diff          integer;
  v_played        date := coalesce(new.played_at, now())::date;
  v_winners       uuid[];
  v_uid           uuid;
begin
  if coalesce(new.status, 'completed') <> 'completed' then return new; end if;

  begin
    if new.player1_rating_before is null or new.player2_rating_before is null then
      return new;
    end if;

    if new.winner_team = 'team1' then
      v_winner_rating := new.player1_rating_before;
      v_loser_rating  := new.player2_rating_before;
      v_winners := array_remove(array[new.player1_id, new.partner1_id], null);
    elsif new.winner_team = 'team2' then
      v_winner_rating := new.player2_rating_before;
      v_loser_rating  := new.player1_rating_before;
      v_winners := array_remove(array[new.player2_id, new.partner2_id], null);
    else
      return new;
    end if;

    v_diff := v_loser_rating - v_winner_rating;
    if v_diff < 200 then return new; end if;

    if v_winners is not null then
      foreach v_uid in array v_winners loop
        perform public.award_profile_badge(
          v_uid, 'Cinderella',
          format('Beat a +%s favorite on %s', v_diff, v_played)
        );
      end loop;
    end if;
  exception when others then null;
  end;
  return new;
end;
$$;

-- _award_marathon_badge
create or replace function public._award_marathon_badge()
returns trigger language plpgsql security definer as $$
declare
  v_winning int;
  v_losing  int;
  v_played  date := coalesce(new.played_at, now())::date;
  v_winners uuid[];
  v_uid     uuid;
begin
  if coalesce(new.status, 'completed') <> 'completed' then return new; end if;
  if new.winner_team is null then return new; end if;

  if new.winner_team = 'team1' then
    v_winning := new.player1_score;
    v_losing  := new.player2_score;
    v_winners := array_remove(array[new.player1_id, new.partner1_id], null);
  elsif new.winner_team = 'team2' then
    v_winning := new.player2_score;
    v_losing  := new.player1_score;
    v_winners := array_remove(array[new.player2_id, new.partner2_id], null);
  else
    return new;
  end if;

  if v_winning is null or v_winning < 12 then return new; end if;

  begin
    foreach v_uid in array v_winners loop
      perform public.award_profile_badge(
        v_uid, 'Marathon',
        format('%s-%s on %s', v_winning, coalesce(v_losing, 0), v_played)
      );
    end loop;
  exception when others then null;
  end;

  return new;
end;
$$;

-- _award_triple_crown_badge
create or replace function public._award_triple_crown_badge()
returns trigger language plpgsql security definer as $$
declare
  v_tc_id    uuid;
  v_played   date := coalesce(new.played_at, now())::date;
  v_winners  uuid[];
  v_uid      uuid;
  v_ctx      text;
  v_has_s    boolean;
  v_has_g    boolean;
  v_has_m    boolean;
begin
  if coalesce(new.status, 'completed') <> 'completed' then return new; end if;

  select id into v_tc_id from public.badges where name = 'Triple Crown';
  if v_tc_id is null then return new; end if;

  if new.winner_team = 'team1' then
    v_winners := array_remove(array[new.player1_id, new.partner1_id], null);
  elsif new.winner_team = 'team2' then
    v_winners := array_remove(array[new.player2_id, new.partner2_id], null);
  end if;

  if v_winners is null then return new; end if;

  foreach v_uid in array v_winners loop
    begin
      v_ctx := format('Triple Crown on %s', v_played);

      if exists (
        select 1 from public.player_badges
         where user_id = v_uid and badge_id = v_tc_id and context = v_ctx
      ) then continue; end if;

      select
        bool_or(m.match_type = 'singles'),
        bool_or(m.match_type = 'doubles' and m.doubles_category = 'gendered'),
        bool_or(m.match_type = 'doubles' and m.doubles_category = 'mixed')
        into v_has_s, v_has_g, v_has_m
        from public.matches m
       where coalesce(m.played_at, now())::date = v_played
         and (
           (m.winner_team = 'team1' and (m.player1_id  = v_uid or m.partner1_id = v_uid))
           or
           (m.winner_team = 'team2' and (m.player2_id  = v_uid or m.partner2_id = v_uid))
         );

      if coalesce(v_has_s, false) and coalesce(v_has_g, false) and coalesce(v_has_m, false) then
        insert into public.player_badges (user_id, badge_id, league_id, context)
        values (v_uid, v_tc_id, null, v_ctx);
      end if;
    exception when others then null;
    end;
  end loop;

  return new;
end;
$$;

-- _award_globetrotter_ii_badge
create or replace function public._award_globetrotter_ii_badge()
returns trigger language plpgsql security definer as $$
declare
  v_badge_id uuid;
  v_uid      uuid;
  v_count    integer;
begin
  if coalesce(new.status, 'completed') <> 'completed' then return new; end if;

  select id into v_badge_id from public.badges where name = 'Globetrotter II';
  if v_badge_id is null then return new; end if;

  begin
    for v_uid in
      select unnest(array_remove(
        array[new.player1_id, new.partner1_id, new.player2_id, new.partner2_id], null
      ))
    loop
      select count(distinct m.location_name) into v_count
        from public.matches m
       where (m.player1_id = v_uid or m.partner1_id = v_uid
              or m.player2_id = v_uid or m.partner2_id = v_uid)
         and m.location_name is not null;

      if v_count >= 10 and not exists (
        select 1 from public.player_badges
         where user_id = v_uid and badge_id = v_badge_id
      ) then
        insert into public.player_badges (user_id, badge_id, league_id, context)
        values (v_uid, v_badge_id, null, format('Played at %s courts', v_count));
      end if;
    end loop;
  exception when others then null;
  end;

  return new;
end;
$$;


-- ── 3d. _grant_pickles_on_badge (backfill skip guard) ────────
-- (source: migration_pickles_per_badge_backfill_guard.sql)
--
-- Future migrations that backfill player_badges should wrap their bulk
-- insert section in:
--   do $$ begin
--     set local pickleague.skip_badge_pickle_grant = 'on';
--     -- ...bulk insert into player_badges...
--   end $$;
create or replace function public._grant_pickles_on_badge()
returns trigger language plpgsql security definer as $$
declare
  v_badge_name text;
begin
  if current_setting('pickleague.skip_badge_pickle_grant', true) = 'on' then
    return new;
  end if;

  select name into v_badge_name from public.badges where id = new.badge_id;
  if v_badge_name is null then return new; end if;

  update public.profiles set pickles = coalesce(pickles, 0) + 50 where id = new.user_id;

  begin
    perform public._notify_user(
      new.user_id,
      format('🥒 +50 pickles for earning %s!', v_badge_name),
      format('You received 50 🥒 for earning the %s badge. Tap to see your shop balance.', v_badge_name),
      new.user_id,
      'shop'
    );
  exception when others then null;
  end;

  return new;
end;
$$;


-- ── 3e. _update_court_ratings (revived per-court ELO) ────────
-- (source: migration_revive_court_ratings.sql)
create or replace function public._update_court_ratings()
returns trigger language plpgsql security definer as $$
declare
  v_loc        text;
  v_bucket     text;
  v_cat        text;
  r1           integer; r_p1 integer := 1000;
  r2           integer; r_p2 integer := 1000;
  team1_avg    float;
  team2_avg    float;
  expected1    float;
  k_factor     integer := 32;
  delta1       integer;
  delta2       integer;
  won1         boolean;
begin
  begin
    if not (
      (TG_OP = 'UPDATE' and coalesce(old.status, '') = 'pending' and new.status = 'completed')
      or (TG_OP = 'INSERT' and new.status = 'completed')
    ) then
      return new;
    end if;

    v_loc := new.location_name;
    if v_loc is null or length(btrim(v_loc)) = 0 then
      return new;
    end if;

    if new.match_type = 'singles' then
      v_bucket := 'singles';
    elsif new.match_type = 'doubles' then
      v_cat := new.doubles_category;
      if v_cat = 'mixed' then
        v_bucket := 'doubles_mixed';
      elsif v_cat in ('mens', 'womens', 'gendered') then
        v_bucket := 'doubles_gendered';
      else
        return new;
      end if;
    else
      return new;
    end if;

    select rating into r1
      from public.player_location_ratings
     where user_id = new.player1_id and location_name = v_loc and match_type = v_bucket;
    r1 := coalesce(r1, 1000);

    select rating into r2
      from public.player_location_ratings
     where user_id = new.player2_id and location_name = v_loc and match_type = v_bucket;
    r2 := coalesce(r2, 1000);

    if new.match_type = 'doubles' then
      if new.partner1_id is not null then
        select rating into r_p1
          from public.player_location_ratings
         where user_id = new.partner1_id and location_name = v_loc and match_type = v_bucket;
        r_p1 := coalesce(r_p1, 1000);
      end if;
      if new.partner2_id is not null then
        select rating into r_p2
          from public.player_location_ratings
         where user_id = new.partner2_id and location_name = v_loc and match_type = v_bucket;
        r_p2 := coalesce(r_p2, 1000);
      end if;
      team1_avg := (r1 + r_p1)::float / 2.0;
      team2_avg := (r2 + r_p2)::float / 2.0;
    else
      team1_avg := r1::float;
      team2_avg := r2::float;
    end if;

    expected1 := 1.0 / (1.0 + power(10.0, (team2_avg - team1_avg) / 400.0));
    won1      := (new.winner_team = 'team1') or (new.winner_id = new.player1_id);
    delta1    := round(k_factor * (case when won1 then 1.0 else 0.0 end - expected1));
    delta2    := -delta1;

    if new.player1_id is not null then
      insert into public.player_location_ratings
             (user_id, location_name, match_type, rating, wins, losses, updated_at)
      values (new.player1_id, v_loc, v_bucket, 1000 + delta1,
              case when won1 then 1 else 0 end,
              case when won1 then 0 else 1 end,
              now())
      on conflict (user_id, location_name, match_type) do update
         set rating     = public.player_location_ratings.rating + delta1,
             wins       = public.player_location_ratings.wins   + case when won1 then 1 else 0 end,
             losses     = public.player_location_ratings.losses + case when won1 then 0 else 1 end,
             updated_at = now();
    end if;

    if new.player2_id is not null then
      insert into public.player_location_ratings
             (user_id, location_name, match_type, rating, wins, losses, updated_at)
      values (new.player2_id, v_loc, v_bucket, 1000 + delta2,
              case when won1 then 0 else 1 end,
              case when won1 then 1 else 0 end,
              now())
      on conflict (user_id, location_name, match_type) do update
         set rating     = public.player_location_ratings.rating + delta2,
             wins       = public.player_location_ratings.wins   + case when won1 then 0 else 1 end,
             losses     = public.player_location_ratings.losses + case when won1 then 1 else 0 end,
             updated_at = now();
    end if;

    if new.match_type = 'doubles' then
      if new.partner1_id is not null then
        insert into public.player_location_ratings
               (user_id, location_name, match_type, rating, wins, losses, updated_at)
        values (new.partner1_id, v_loc, v_bucket, 1000 + delta1,
                case when won1 then 1 else 0 end,
                case when won1 then 0 else 1 end,
                now())
        on conflict (user_id, location_name, match_type) do update
           set rating     = public.player_location_ratings.rating + delta1,
               wins       = public.player_location_ratings.wins   + case when won1 then 1 else 0 end,
               losses     = public.player_location_ratings.losses + case when won1 then 0 else 1 end,
               updated_at = now();
      end if;
      if new.partner2_id is not null then
        insert into public.player_location_ratings
               (user_id, location_name, match_type, rating, wins, losses, updated_at)
        values (new.partner2_id, v_loc, v_bucket, 1000 + delta2,
                case when won1 then 0 else 1 end,
                case when won1 then 1 else 0 end,
                now())
        on conflict (user_id, location_name, match_type) do update
           set rating     = public.player_location_ratings.rating + delta2,
               wins       = public.player_location_ratings.wins   + case when won1 then 0 else 1 end,
               losses     = public.player_location_ratings.losses + case when won1 then 1 else 0 end,
               updated_at = now();
      end if;
    end if;

    return new;
  exception when others then
    raise warning '_update_court_ratings failed for match %: % / %', new.id, sqlstate, sqlerrm;
    return new;
  end;
end;
$$;


-- ── 3f. mlp_set_slot (gender alignment) ──────────────────────
-- (source: migration_fix_mlp_set_slot_gender.sql)
create or replace function public.mlp_set_slot(
  p_team_id  uuid,
  p_slot     text,
  p_user_id  uuid
) returns void language plpgsql security definer as $$
declare
  v_uid    uuid := auth.uid();
  v_team   record;
  v_gender text;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if p_slot not in ('male_1','male_2','female_1','female_2') then
    raise exception 'Invalid slot %', p_slot;
  end if;

  select * into v_team from public.mlp_teams where id = p_team_id;
  if v_team.id is null then raise exception 'Team not found'; end if;
  if v_uid <> v_team.captain_id and not public._is_tournament_admin(v_team.tournament_id, v_uid) then
    raise exception 'Only the captain or a tournament admin can change slots';
  end if;
  if v_team.status <> 'forming' then raise exception 'Team is locked'; end if;

  if p_user_id is not null then
    select gender into v_gender from public.profiles where id = p_user_id;

    if p_slot in ('female_1', 'female_2') then
      if v_gender = 'male' or v_gender = 'other' then
        raise exception 'Cannot place a % player in slot %', v_gender, p_slot;
      end if;
    else
      if v_gender = 'female' then
        raise exception 'Cannot place a female player in slot %', p_slot;
      end if;
    end if;
  end if;

  execute format('update public.mlp_teams set %I_id = $1 where id = $2', p_slot)
    using p_user_id, p_team_id;
end;
$$;


-- ── 3g. preview_mlp_tournament_payout (full 3rd-place cascade) ─────
-- (source: migration_fix_mlp_third_place_tiebreaker.sql)
create or replace function public.preview_mlp_tournament_payout(p_tournament_id uuid)
returns table (
  place           integer,
  team_id         uuid,
  team_name       text,
  uids            uuid[],
  user_names      text[],
  pool_share      integer,
  share_per_user  integer,
  plupr_bonus     numeric(6,3)
) language plpgsql stable security definer as $$
declare
  v_pool       integer;
  v_structure  integer[];
  v_finals     record;
  v_winner     uuid;
  v_loser      uuid;
  v_winner_name text;
  v_loser_name  text;
  v_third      uuid[];
  v_third_names text[];
  v_a_rr_diff  integer;
  v_b_rr_diff  integer;
  v_a_seed     integer;
  v_b_seed     integer;
  v_a_better   boolean;
begin
  select prize_pool, payout_structure into v_pool, v_structure
    from public.tournaments where id = p_tournament_id;
  if v_pool is null then v_pool := 0; end if;
  if v_structure is null then v_structure := '{60,25,15}'; end if;

  select tr.id as round_id, s.*
    into v_finals
    from public.tournament_rounds tr
    join lateral public._mlp_round_series_state(tr.id) s on true
   where tr.tournament_id = p_tournament_id
     and tr.round_type = 'finals'
   order by tr.round_number desc
   limit 1;
  if v_finals.team_a_id is null then return; end if;

  if v_finals.a_wins <> v_finals.b_wins then
    v_a_better := v_finals.a_wins > v_finals.b_wins;
  elsif (v_finals.a_points - v_finals.b_points) <> 0 then
    v_a_better := (v_finals.a_points - v_finals.b_points) > 0;
  else
    select coalesce(s.sub_matches_won - s.sub_matches_lost, 0) into v_a_rr_diff
      from public.mlp_team_standings(p_tournament_id) s where s.team_id = v_finals.team_a_id;
    select coalesce(s.sub_matches_won - s.sub_matches_lost, 0) into v_b_rr_diff
      from public.mlp_team_standings(p_tournament_id) s where s.team_id = v_finals.team_b_id;
    if coalesce(v_a_rr_diff, 0) <> coalesce(v_b_rr_diff, 0) then
      v_a_better := coalesce(v_a_rr_diff, 0) > coalesce(v_b_rr_diff, 0);
    else
      select t.seed into v_a_seed from public.mlp_teams t where t.id = v_finals.team_a_id;
      select t.seed into v_b_seed from public.mlp_teams t where t.id = v_finals.team_b_id;
      if coalesce(v_a_seed, 999) <> coalesce(v_b_seed, 999) then
        v_a_better := coalesce(v_a_seed, 999) < coalesce(v_b_seed, 999);
      else
        v_a_better := true;
      end if;
    end if;
  end if;

  if v_a_better then
    v_winner := v_finals.team_a_id; v_winner_name := v_finals.team_a_name;
    v_loser  := v_finals.team_b_id; v_loser_name  := v_finals.team_b_name;
  else
    v_winner := v_finals.team_b_id; v_winner_name := v_finals.team_b_name;
    v_loser  := v_finals.team_a_id; v_loser_name  := v_finals.team_a_name;
  end if;

  return query
    select 1, v_winner, v_winner_name,
           (select array_remove(array[male_1_id, male_2_id, female_1_id, female_2_id], null)
              from public.mlp_teams where id = v_winner),
           (select array_agg(p.full_name order by p.full_name)
              from public.mlp_teams t
              join public.profiles p on p.id in (t.male_1_id, t.male_2_id, t.female_1_id, t.female_2_id)
             where t.id = v_winner),
           floor(v_pool * v_structure[1] / 100.0)::int as pool_share,
           floor(floor(v_pool * v_structure[1] / 100.0) /
                  coalesce(nullif((select array_length(array_remove(array[male_1_id, male_2_id, female_1_id, female_2_id], null), 1)
                                   from public.mlp_teams where id = v_winner), 0), 1))::int as share_per_user,
           0.500::numeric(6,3);

  if array_length(v_structure, 1) >= 2 then
    return query
    select 2, v_loser, v_loser_name,
           (select array_remove(array[male_1_id, male_2_id, female_1_id, female_2_id], null)
              from public.mlp_teams where id = v_loser),
           (select array_agg(p.full_name order by p.full_name)
              from public.mlp_teams t
              join public.profiles p on p.id in (t.male_1_id, t.male_2_id, t.female_1_id, t.female_2_id)
             where t.id = v_loser),
           floor(v_pool * v_structure[2] / 100.0)::int,
           floor(floor(v_pool * v_structure[2] / 100.0) /
                  coalesce(nullif((select array_length(array_remove(array[male_1_id, male_2_id, female_1_id, female_2_id], null), 1)
                                   from public.mlp_teams where id = v_loser), 0), 1))::int,
           0.250::numeric(6,3);
  end if;

  if array_length(v_structure, 1) >= 3 then
    with semi_state as (
      select s.* from public.tournament_rounds tr
        join lateral public._mlp_round_series_state(tr.id) s on true
       where tr.tournament_id = p_tournament_id
         and tr.round_type = 'semifinals'
    ),
    semi_with_ctx as (
      select
        ss.*,
        coalesce(sa.sub_matches_won - sa.sub_matches_lost, 0) as a_rr_diff,
        coalesce(sb.sub_matches_won - sb.sub_matches_lost, 0) as b_rr_diff,
        coalesce(ta.seed, 999) as a_seed,
        coalesce(tb.seed, 999) as b_seed
        from semi_state ss
        left join lateral (
          select s.sub_matches_won, s.sub_matches_lost
            from public.mlp_team_standings(p_tournament_id) s
           where s.team_id = ss.team_a_id
        ) sa on true
        left join lateral (
          select s.sub_matches_won, s.sub_matches_lost
            from public.mlp_team_standings(p_tournament_id) s
           where s.team_id = ss.team_b_id
        ) sb on true
        left join public.mlp_teams ta on ta.id = ss.team_a_id
        left join public.mlp_teams tb on tb.id = ss.team_b_id
       where ss.team_a_id is not null and ss.team_b_id is not null
    ),
    losers as (
      select
        case
          when a_wins <> b_wins                       then (case when a_wins > b_wins then team_b_id else team_a_id end)
          when (a_points - b_points) <> 0             then (case when a_points > b_points then team_b_id else team_a_id end)
          when a_rr_diff <> b_rr_diff                 then (case when a_rr_diff > b_rr_diff then team_b_id else team_a_id end)
          when a_seed <> b_seed                       then (case when a_seed < b_seed then team_b_id else team_a_id end)
          else team_b_id
        end as team_id,
        case
          when a_wins <> b_wins                       then (case when a_wins > b_wins then team_b_name else team_a_name end)
          when (a_points - b_points) <> 0             then (case when a_points > b_points then team_b_name else team_a_name end)
          when a_rr_diff <> b_rr_diff                 then (case when a_rr_diff > b_rr_diff then team_b_name else team_a_name end)
          when a_seed <> b_seed                       then (case when a_seed < b_seed then team_b_name else team_a_name end)
          else team_b_name
        end as team_name
        from semi_with_ctx
    )
    select array_agg(l.team_id), array_agg(l.team_name)
      into v_third, v_third_names
      from losers l;

    if v_third is not null and array_length(v_third, 1) > 0 then
      return query
      select 3, l.team_id, l.team_name,
             (select array_remove(array[male_1_id, male_2_id, female_1_id, female_2_id], null)
                from public.mlp_teams where id = l.team_id),
             (select array_agg(p.full_name order by p.full_name)
                from public.mlp_teams t
                join public.profiles p on p.id in (t.male_1_id, t.male_2_id, t.female_1_id, t.female_2_id)
               where t.id = l.team_id),
             floor((v_pool * v_structure[3] / 100.0) / array_length(v_third, 1))::int,
             floor(floor((v_pool * v_structure[3] / 100.0) / array_length(v_third, 1)) /
                    coalesce(nullif((select array_length(array_remove(array[male_1_id, male_2_id, female_1_id, female_2_id], null), 1)
                                     from public.mlp_teams where id = l.team_id), 0), 1))::int,
             0.100::numeric(6,3)
        from (
          select unnest(v_third) as team_id, unnest(v_third_names) as team_name
        ) l;
    end if;
  end if;
end;
$$;


-- ── 3h. recompute_doubles_ratings (override-aware classifier) ─────
-- (source: migration_fix_recompute_doubles_classifier.sql)
create or replace function public.recompute_doubles_ratings()
returns void language plpgsql security definer as $$
declare
  m record;
  r1 integer; r2 integer; r_p1 integer; r_p2 integer;
  team1_avg float; team2_avg float;
  expected1 float; delta1 integer;
  k integer := 32;
  won1 boolean;
  cat text;
begin
  update public.profiles
     set doubles_rating       = 1000,
         mixed_doubles_rating = 1000;

  update public.matches
     set doubles_category = public._classify_doubles_with_overrides(
           player1_id,  player1_gender_override,
           partner1_id, partner1_gender_override,
           player2_id,  player2_gender_override,
           partner2_id, partner2_gender_override
         )
   where match_type = 'doubles';

  for m in
    select * from public.matches
     where match_type = 'doubles'
       and status     = 'completed'
       and doubles_category in ('gendered', 'mixed')
     order by played_at asc, created_at asc
  loop
    if m.doubles_category = 'gendered' then
      select doubles_rating into r1   from public.profiles where id = m.player1_id;
      select doubles_rating into r_p1 from public.profiles where id = m.partner1_id;
      select doubles_rating into r2   from public.profiles where id = m.player2_id;
      select doubles_rating into r_p2 from public.profiles where id = m.partner2_id;
    else
      select mixed_doubles_rating into r1   from public.profiles where id = m.player1_id;
      select mixed_doubles_rating into r_p1 from public.profiles where id = m.partner1_id;
      select mixed_doubles_rating into r2   from public.profiles where id = m.player2_id;
      select mixed_doubles_rating into r_p2 from public.profiles where id = m.partner2_id;
    end if;

    team1_avg := (coalesce(r1, 1000) + coalesce(r_p1, 1000))::float / 2.0;
    team2_avg := (coalesce(r2, 1000) + coalesce(r_p2, 1000))::float / 2.0;
    expected1 := 1.0 / (1.0 + power(10.0, (team2_avg - team1_avg) / 400.0));
    won1      := (m.winner_team = 'team1') or (m.winner_id = m.player1_id);
    delta1    := round(k * (case when won1 then 1.0 else 0.0 end - expected1));

    if m.doubles_category = 'gendered' then
      update public.profiles set doubles_rating = doubles_rating + delta1
        where id in (m.player1_id, m.partner1_id);
      update public.profiles set doubles_rating = doubles_rating - delta1
        where id in (m.player2_id, m.partner2_id);
    else
      update public.profiles set mixed_doubles_rating = mixed_doubles_rating + delta1
        where id in (m.player1_id, m.partner1_id);
      update public.profiles set mixed_doubles_rating = mixed_doubles_rating - delta1
        where id in (m.player2_id, m.partner2_id);
    end if;
  end loop;
end;
$$;


-- ── 3i. lock_season_period (MERGED) ──────────────────────────
-- (sources: migration_preserve_split_ratings_on_season_reset.sql
--         + migration_fix_period_relock_badge_revoke.sql)
--
-- This single definition incorporates BOTH fixes:
--   * Only-overall-reset:    only `rating` is reset on period lock;
--                            singles/doubles/mixed splits are preserved.
--   * Revoke-prior-champion: before awarding Period Champion to the new
--                            rank-1 player, delete any prior badge row
--                            for the same season + period in this league.
create or replace function public.lock_season_period(
  p_season_id     uuid,
  p_period_number integer,
  p_snapshot_date date
)
returns void language plpgsql security definer as $$
declare
  v_league_id    uuid;
  v_season_name  text;
  v_season_start date;
  v_rec          record;
  v_rank         integer := 0;
  v_bonus        integer;
  v_new_elo      integer;
begin
  select league_id, name, start_date
  into   v_league_id, v_season_name, v_season_start
  from   public.league_seasons
  where  id = p_season_id;

  if v_league_id is null then
    raise exception 'Season not found';
  end if;

  if not exists (
    select 1 from public.league_members
    where  league_id = v_league_id
      and  user_id   = auth.uid()
      and  role in ('admin', 'co-admin')
  ) then
    raise exception 'Only admins and co-admins can lock season standings';
  end if;

  delete from public.season_snapshots
  where  season_id     = p_season_id
    and  period_number = p_period_number;

  for v_rec in (
    with player_stats as (
      select
        lm.user_id,
        p.rating,
        coalesce(sum(
          case
            when (m.player1_id  = lm.user_id and m.winner_team = 'team1') or
                 (m.partner1_id = lm.user_id and m.winner_team = 'team1') or
                 (m.player2_id  = lm.user_id and m.winner_team = 'team2') or
                 (m.partner2_id = lm.user_id and m.winner_team = 'team2')
            then 1 else 0 end
        ), 0) as wins,
        coalesce(sum(
          case
            when (m.player1_id  = lm.user_id and m.winner_team = 'team2') or
                 (m.partner1_id = lm.user_id and m.winner_team = 'team2') or
                 (m.player2_id  = lm.user_id and m.winner_team = 'team1') or
                 (m.partner2_id = lm.user_id and m.winner_team = 'team1')
            then 1 else 0 end
        ), 0) as losses
      from public.league_members lm
      join public.profiles p on p.id = lm.user_id
      left join public.matches m
        on  m.league_id  = v_league_id
        and m.played_at::date between v_season_start and p_snapshot_date
        and (
          m.player1_id  = lm.user_id or m.partner1_id = lm.user_id or
          m.player2_id  = lm.user_id or m.partner2_id = lm.user_id
        )
      where lm.league_id = v_league_id
      group by lm.user_id, p.rating
    )
    select user_id, rating, wins, losses
    from   player_stats
    order  by wins desc, rating desc
  ) loop
    v_rank := v_rank + 1;
    insert into public.season_snapshots (
      season_id, league_id, period_number, snapshot_date,
      user_id, elo_at_snapshot, rank_at_snapshot, wins_in_season, losses_in_season
    ) values (
      p_season_id, v_league_id, p_period_number, p_snapshot_date,
      v_rec.user_id, v_rec.rating, v_rank, v_rec.wins, v_rec.losses
    );

    -- Revoke any prior Period Champion badge for this season + period
    -- before awarding to the (possibly new) rank-1 player. Without this,
    -- re-locking with shifted standings leaves the old champion holding
    -- the badge alongside the new one.
    if v_rank = 1 then
      delete from public.player_badges
      where  badge_id  = (select id from public.badges where name = 'Period Champion')
        and  league_id = v_league_id
        and  context   = format('%s — Period %s', v_season_name, p_period_number);

      perform public.award_league_badge(
        v_rec.user_id, v_league_id, 'Period Champion',
        format('%s — Period %s', v_season_name, p_period_number)
      );
    end if;

    -- Period-end soft ELO reset: top 5 keep a head start, rest reset clean.
    -- Only the OVERALL rating is reset; split ratings are preserved so a
    -- player's per-format skill carries over across periods.
    v_bonus := case
      when v_rank = 1 then 80
      when v_rank = 2 then 55
      when v_rank = 3 then 35
      when v_rank = 4 then 20
      when v_rank = 5 then 10
      else 0
    end;
    v_new_elo := 1000 + v_bonus;
    update public.profiles
    set rating = v_new_elo
    where id = v_rec.user_id;
  end loop;

  update public.league_seasons
  set status = 'active'
  where id = p_season_id and status = 'upcoming';
end;
$$;


-- ── 3j. complete_season (MERGED) ─────────────────────────────
-- (sources: migration_preserve_split_ratings_on_season_reset.sql
--         + migration_fix_period_sweeper_late_joiners.sql)
--
-- This single definition incorporates BOTH fixes:
--   * Only-overall-reset:       only `rating` is reset on completion;
--                               singles/doubles/mixed splits preserved.
--   * Relaxed Period Sweeper:   awarded to any player who was rank-1 in
--                               every snapshot they appeared in (mid-
--                               season joiners now qualify).
create or replace function public.complete_season(p_season_id uuid)
returns void language plpgsql security definer as $$
declare
  v_league_id    uuid;
  v_season_name  text;
  v_period_count integer;
  v_player       record;
  v_rank         integer := 0;
  v_bonus        integer;
  v_new_elo      integer;
  v_badge        text;
begin
  select league_id, name into v_league_id, v_season_name
  from   public.league_seasons
  where  id = p_season_id;

  if v_league_id is null then
    raise exception 'Season not found';
  end if;

  if not exists (
    select 1 from public.league_members
    where  league_id = v_league_id
      and  user_id   = auth.uid()
      and  role in ('admin', 'co-admin')
  ) then
    raise exception 'Only admins and co-admins can complete a season';
  end if;

  if (select elo_reset_applied from public.league_seasons where id = p_season_id) then
    raise exception 'ELO reset has already been applied for this season';
  end if;

  if not exists (select 1 from public.season_snapshots where season_id = p_season_id) then
    raise exception 'Lock in at least one period before completing the season';
  end if;

  select count(distinct period_number) into v_period_count
  from   public.season_snapshots
  where  season_id = p_season_id;

  for v_player in (
    with medians as (
      select
        user_id,
        percentile_cont(0.5) within group (order by rank_at_snapshot) as median_rank
      from public.season_snapshots
      where season_id = p_season_id
      group by user_id
    )
    select user_id, median_rank
    from   medians
    order  by median_rank asc
  ) loop
    v_rank  := v_rank + 1;
    v_bonus := case
      when v_rank = 1 then 80
      when v_rank = 2 then 55
      when v_rank = 3 then 35
      when v_rank = 4 then 20
      when v_rank = 5 then 10
      else 0
    end;
    v_new_elo := 1000 + v_bonus;

    insert into public.season_final_standings (
      season_id, league_id, user_id, final_rank, median_rank, elo_bonus, new_elo
    ) values (
      p_season_id, v_league_id, v_player.user_id,
      v_rank, v_player.median_rank, v_bonus, v_new_elo
    ) on conflict (season_id, user_id) do update
      set final_rank  = excluded.final_rank,
          median_rank = excluded.median_rank,
          elo_bonus   = excluded.elo_bonus,
          new_elo     = excluded.new_elo;

    -- Soft ELO reset on OVERALL only. Split ratings
    -- (singles / doubles / mixed_doubles) are preserved so per-format
    -- skill identity carries over across seasons.
    update public.profiles
    set rating = v_new_elo
    where id = v_player.user_id;

    -- Top-3 season badges
    v_badge := case v_rank
      when 1 then 'Season Crown'
      when 2 then 'Season Silver'
      when 3 then 'Season Bronze'
      else null end;
    if v_badge is not null then
      perform public.award_league_badge(
        v_player.user_id, v_league_id, v_badge, v_season_name
      );
    end if;

    -- Period Sweeper: rank-1 in every period the player appeared in
    -- (relaxed from "every locked period" so mid-season joiners qualify).
    if exists (
      select 1
      from   public.season_snapshots
      where  season_id = p_season_id
        and  user_id   = v_player.user_id
      group  by user_id
      having count(*) filter (where rank_at_snapshot = 1) = count(*)
        and  count(*) >= 1
    ) then
      perform public.award_league_badge(
        v_player.user_id, v_league_id, 'Period Sweeper', v_season_name
      );
    end if;
  end loop;

  update public.league_seasons
  set status = 'completed', elo_reset_applied = true
  where id = p_season_id;
end;
$$;


-- ============================================================
-- SECTION 4: Triggers (drop + create)
-- ============================================================

-- Single-elim / double-elim bracket advancement
drop trigger if exists trg_advance_single_elim_bracket on public.tournament_matches;
create trigger trg_advance_single_elim_bracket
  after insert or update of status on public.tournament_matches
  for each row execute procedure public._advance_single_elim_bracket();

-- MLP playoff round advancement
drop trigger if exists trg_advance_mlp_playoff_round on public.tournament_matches;
create trigger trg_advance_mlp_playoff_round
  after insert or update of status on public.tournament_matches
  for each row execute procedure public._advance_mlp_playoff_round();

-- Match-driven badge/pickle triggers (all gated on 'completed')
drop trigger if exists trg_award_match_badges on public.matches;
create trigger trg_award_match_badges
  after insert or update of status on public.matches
  for each row execute procedure public._award_match_badges();

drop trigger if exists trg_progress_check_on_match on public.matches;
create trigger trg_progress_check_on_match
  after insert or update of status on public.matches
  for each row execute procedure public._progress_check_on_match();

drop trigger if exists trg_grant_first_match_bonus on public.matches cascade;
create trigger trg_grant_first_match_bonus
  after insert or update of status on public.matches
  for each row execute procedure public._grant_first_match_bonus();

drop trigger if exists trg_grant_first_doubles_bonus on public.matches cascade;
create trigger trg_grant_first_doubles_bonus
  after insert or update of status on public.matches
  for each row execute procedure public._grant_first_doubles_bonus();

drop trigger if exists trg_grant_court_bonus on public.matches cascade;
create trigger trg_grant_court_bonus
  after insert or update of status on public.matches
  for each row execute procedure public._grant_court_bonus();

drop trigger if exists trg_grant_daily_streak_bonus on public.matches cascade;
create trigger trg_grant_daily_streak_bonus
  after insert or update of status on public.matches
  for each row execute procedure public._grant_daily_streak_bonus();

drop trigger if exists trg_award_underdog_badge on public.matches;
create trigger trg_award_underdog_badge
  after insert or update of status on public.matches
  for each row execute procedure public._award_underdog_badge();

drop trigger if exists trg_award_cinderella_badge on public.matches;
create trigger trg_award_cinderella_badge
  after insert or update of status on public.matches
  for each row execute procedure public._award_cinderella_badge();

drop trigger if exists trg_award_marathon_badge on public.matches;
create trigger trg_award_marathon_badge
  after insert or update of status on public.matches
  for each row execute procedure public._award_marathon_badge();

drop trigger if exists trg_award_triple_crown_badge on public.matches;
create trigger trg_award_triple_crown_badge
  after insert or update of status on public.matches
  for each row execute procedure public._award_triple_crown_badge();

drop trigger if exists trg_award_globetrotter_ii_badge on public.matches;
create trigger trg_award_globetrotter_ii_badge
  after insert or update of status on public.matches
  for each row execute procedure public._award_globetrotter_ii_badge();

-- Per-badge pickle grant (backfill skip guard installed)
drop trigger if exists trg_grant_pickles_on_badge on public.player_badges cascade;
create trigger trg_grant_pickles_on_badge
  after insert on public.player_badges
  for each row execute procedure public._grant_pickles_on_badge();

-- Per-court ELO maintenance (separate additive trigger; does not touch PLUPR)
drop trigger if exists trg_update_court_ratings on public.matches;
create trigger trg_update_court_ratings
  after insert or update of status on public.matches
  for each row execute procedure public._update_court_ratings();


-- ============================================================
-- SECTION 5: Grants
-- ============================================================

grant execute on function public._mlp_round_winner(uuid)              to authenticated;
grant execute on function public._advance_single_elim_bracket()       to authenticated;
grant execute on function public._advance_mlp_playoff_round()         to authenticated;
grant execute on function public._grant_first_match_bonus()           to authenticated;
grant execute on function public._grant_first_doubles_bonus()         to authenticated;
grant execute on function public._grant_court_bonus()                 to authenticated;
grant execute on function public._grant_daily_streak_bonus()          to authenticated;
grant execute on function public._grant_pickles_on_badge()            to authenticated;
grant execute on function public._update_court_ratings()              to authenticated, service_role;
grant execute on function public.mlp_set_slot(uuid, text, uuid)       to authenticated;
grant execute on function public.preview_mlp_tournament_payout(uuid)  to authenticated;
grant execute on function public.recompute_doubles_ratings()          to authenticated;
grant execute on function public.lock_season_period(uuid, integer, date) to authenticated;
grant execute on function public.complete_season(uuid)                to authenticated;


-- ============================================================
-- SECTION 6: Reload PostgREST schema cache (single notify at end)
-- ============================================================

notify pgrst, 'reload schema';
