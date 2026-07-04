-- ============================================================
-- Prod reconciliation snapshot (2026-07-04).
--
-- The migration files in this repo are hand-applied, and over time prod
-- accumulated FINAL refined versions of many functions that were applied
-- out-of-band (via MCP sessions) and never committed back — including the
-- June 2026 tournament-audit advancement fixes, the PLUPR k-factor bump,
-- godmode confirm bypass, and shop shipping validation. The toolbox
-- Migrations tool surfaced the drift; forensics confirmed prod is the
-- intended state for every function below. This file snapshots prod's
-- definitions verbatim (pg_get_functiondef) so the repo matches reality.
--
-- Notes:
-- * Grants are NOT included — they already exist in prod. On a fresh
--   install, run the RPC-lockdown + grant migrations afterward.
-- * Functions intentionally absent from prod (one-time helpers, superseded
--   ELO-era code): _drill_seed_day, backfill_season_history,
--   set_match_home_court_flags, update_matches_is_home_court,
--   update_elo_ratings. The Migrations tool skips them.
--
-- Reconciled functions (34): _advance_double_elim_bracket, _advance_non_mlp_playoff_bracket, _advance_single_elim_bracket, _award_cinderella_badge, _award_globetrotter_ii_badge, _award_marathon_badge, _award_match_badges, _award_triple_crown_badge, _award_underdog_badge, _lock_season_period_unchecked, _maybe_auto_close_mlp_tournament, _notify_pending_match, _se_round1_slot_winner, _settle_mlp_dreambreaker, _settle_wagers_for_tournament, _wager_score_density, auto_payout_mlp_tournament, cancel_wager, claim_ftue_step, confirm_match, create_mlp_team, generate_mlp_playoff, generate_playoff_bracket, get_my_wagers_with_details, get_wagers_on_player, godmode_force_accept_invitee, godmode_list_active_invites, mlp_team_standings, place_wager, purchase_shop_item, recompute_all_plupr, redeem_real_world_item, update_plupr_for_tournament_match, update_plupr_ratings
-- ============================================================

-- ── _advance_double_elim_bracket() ──
CREATE OR REPLACE FUNCTION public._advance_double_elim_bracket()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_format text; v_match_type text; v_round_number integer; v_round_type text;
  v_uncompleted integer; v_winner_count integer; v_loser_count integer;
  v_next_round_id uuid; v_next_round_num integer; v_next_label text;
  v_pair_count integer; v_i integer; v_w1 record; v_w2 record; v_l1 record; v_l2 record;
  v_lb_target_num integer; v_lb_pending integer; v_wb_final_round integer;
  v_lb_final_round integer; v_wb_round_count integer; v_lb_final_num integer;
  v_gf_round_id uuid;
begin
  if new.status <> 'completed' then return new; end if;
  if TG_OP = 'UPDATE' and old.status = 'completed' then return new; end if;
  begin
    select format, match_type into v_format, v_match_type from public.tournaments where id = new.tournament_id;
    if v_format <> 'double_elimination' then return new; end if;
    v_match_type := coalesce(v_match_type, 'singles');
    select round_number, round_type into v_round_number, v_round_type from public.tournament_rounds where id = new.round_id;
    if v_round_number is null then return new; end if;
    if v_round_type not in ('winners','losers','grand_final') then return new; end if;
    select count(*) into v_uncompleted from public.tournament_matches where round_id = new.round_id and status <> 'completed';
    if v_uncompleted > 0 then return new; end if;

    if v_round_type = 'grand_final' then
      if new.winner_team is null then return new; end if;
      if v_round_number = 1 then
        if new.winner_team = 'team2' then
          v_gf_round_id := public._de_get_or_create_round(new.tournament_id, 2, 'grand_final', 'Grand Final (Reset)');
          if not exists (select 1 from public.tournament_matches where round_id = v_gf_round_id) then
            insert into public.tournament_matches (tournament_id, round_id, match_order, match_type, team1_player1, team1_player2, team2_player1, team2_player2, status)
            values (new.tournament_id, v_gf_round_id, 0, v_match_type, new.team1_player1, new.team1_player2, new.team2_player1, new.team2_player2, 'pending');
          end if;
          return new;
        else
          update public.tournaments set status = 'completed' where id = new.tournament_id and status <> 'completed';
          return new;
        end if;
      else
        update public.tournaments set status = 'completed' where id = new.tournament_id and status <> 'completed';
        return new;
      end if;
    end if;

    select count(*) filter (where winner_team in ('team1','team2')), count(*) filter (where winner_team in ('team1','team2'))
      into v_winner_count, v_loser_count from public.tournament_matches where round_id = new.round_id;

    if v_round_type = 'winners' then
      if v_round_number = 1 then
        v_lb_target_num := 1; v_next_label := 'Losers Round 1';
        v_next_round_id := public._de_get_or_create_round(new.tournament_id, v_lb_target_num, 'losers', v_next_label);
        select count(*) into v_lb_pending from public.tournament_matches where round_id = v_next_round_id;
        if v_lb_pending = 0 then
          v_pair_count := v_loser_count / 2;
          for v_i in 0..(v_pair_count - 1) loop
            with ordered as (select tm.*, row_number() over (order by match_order, id) - 1 as rn from public.tournament_matches tm where tm.round_id = new.round_id and tm.winner_team in ('team1','team2')) select * into v_l1 from ordered where rn = v_i * 2;
            with ordered as (select tm.*, row_number() over (order by match_order, id) - 1 as rn from public.tournament_matches tm where tm.round_id = new.round_id and tm.winner_team in ('team1','team2')) select * into v_l2 from ordered where rn = v_i * 2 + 1;
            if v_l1 is null or v_l2 is null then continue; end if;
            insert into public.tournament_matches (tournament_id, round_id, match_order, match_type, team1_player1, team1_player2, team2_player1, team2_player2, status)
            values (new.tournament_id, v_next_round_id, v_i, v_match_type,
              case when v_l1.winner_team = 'team1' then v_l1.team2_player1 else v_l1.team1_player1 end,
              case when v_l1.winner_team = 'team1' then v_l1.team2_player2 else v_l1.team1_player2 end,
              case when v_l2.winner_team = 'team1' then v_l2.team2_player1 else v_l2.team1_player1 end,
              case when v_l2.winner_team = 'team1' then v_l2.team2_player2 else v_l2.team1_player2 end, 'pending');
          end loop;
        end if;
      else
        v_lb_target_num := (v_round_number - 1) * 2; v_next_label := format('Losers Round %s', v_lb_target_num);
        if exists (select 1 from public.tournament_rounds where tournament_id = new.tournament_id and round_type = 'losers' and round_number = v_lb_target_num - 1)
           and not exists (select 1 from public.tournament_matches tm join public.tournament_rounds tr on tr.id = tm.round_id where tr.tournament_id = new.tournament_id and tr.round_type = 'losers' and tr.round_number = v_lb_target_num - 1 and tm.status <> 'completed') then
          if exists (select 1 from public.tournament_matches tm join public.tournament_rounds tr on tr.id = tm.round_id where tr.tournament_id = new.tournament_id and tr.round_type = 'losers' and tr.round_number = v_lb_target_num) then
            null;
          else
            v_next_round_id := public._de_get_or_create_round(new.tournament_id, v_lb_target_num, 'losers', v_next_label);
            v_pair_count := least(v_loser_count, (select count(*) from public.tournament_matches tm join public.tournament_rounds tr on tr.id = tm.round_id where tr.tournament_id = new.tournament_id and tr.round_type = 'losers' and tr.round_number = v_lb_target_num - 1 and tm.winner_team in ('team1','team2')));
            for v_i in 0..(v_pair_count - 1) loop
              with lb_prev as (select tm.*, row_number() over (order by tm.match_order, tm.id) - 1 as rn from public.tournament_matches tm join public.tournament_rounds tr on tr.id = tm.round_id where tr.tournament_id = new.tournament_id and tr.round_type = 'losers' and tr.round_number = v_lb_target_num - 1 and tm.winner_team in ('team1','team2')) select * into v_w1 from lb_prev where rn = v_i;
              with wb_losers as (select tm.*, row_number() over (order by tm.match_order, tm.id) - 1 as rn from public.tournament_matches tm where tm.round_id = new.round_id and tm.winner_team in ('team1','team2')) select * into v_l1 from wb_losers where rn = v_i;
              if v_w1 is null or v_l1 is null then continue; end if;
              insert into public.tournament_matches (tournament_id, round_id, match_order, match_type, team1_player1, team1_player2, team2_player1, team2_player2, status)
              values (new.tournament_id, v_next_round_id, v_i, v_match_type,
                case when v_w1.winner_team = 'team1' then v_w1.team1_player1 else v_w1.team2_player1 end,
                case when v_w1.winner_team = 'team1' then v_w1.team1_player2 else v_w1.team2_player2 end,
                case when v_l1.winner_team = 'team1' then v_l1.team2_player1 else v_l1.team1_player1 end,
                case when v_l1.winner_team = 'team1' then v_l1.team2_player2 else v_l1.team1_player2 end, 'pending');
            end loop;
          end if;
        end if;
      end if;
      if v_winner_count >= 2 then
        v_next_round_num := v_round_number + 1;
        if not exists (select 1 from public.tournament_rounds where tournament_id = new.tournament_id and round_type = 'winners' and round_number = v_next_round_num) then
          v_pair_count := v_winner_count / 2; v_next_label := format('Winners Round %s', v_next_round_num);
          v_next_round_id := public._de_get_or_create_round(new.tournament_id, v_next_round_num, 'winners', v_next_label);
          for v_i in 0..(v_pair_count - 1) loop
            with ordered as (select tm.*, row_number() over (order by match_order, id) - 1 as rn from public.tournament_matches tm where tm.round_id = new.round_id and tm.winner_team in ('team1','team2')) select * into v_w1 from ordered where rn = v_i * 2;
            with ordered as (select tm.*, row_number() over (order by match_order, id) - 1 as rn from public.tournament_matches tm where tm.round_id = new.round_id and tm.winner_team in ('team1','team2')) select * into v_w2 from ordered where rn = v_i * 2 + 1;
            if v_w1 is null or v_w2 is null then continue; end if;
            insert into public.tournament_matches (tournament_id, round_id, match_order, match_type, team1_player1, team1_player2, team2_player1, team2_player2, status)
            values (new.tournament_id, v_next_round_id, v_i, v_match_type,
              case when v_w1.winner_team = 'team1' then v_w1.team1_player1 else v_w1.team2_player1 end,
              case when v_w1.winner_team = 'team1' then v_w1.team1_player2 else v_w1.team2_player2 end,
              case when v_w2.winner_team = 'team1' then v_w2.team1_player1 else v_w2.team2_player1 end,
              case when v_w2.winner_team = 'team1' then v_w2.team1_player2 else v_w2.team2_player2 end, 'pending');
          end loop;
        end if;
      end if;
      if v_winner_count = 1 then
        select tr.round_number into v_lb_final_round from public.tournament_rounds tr where tr.tournament_id = new.tournament_id and tr.round_type = 'losers'
          and exists (select 1 from public.tournament_matches tm where tm.round_id = tr.id and tm.status = 'completed' and tm.winner_team in ('team1','team2'))
          and not exists (select 1 from public.tournament_rounds tr2 where tr2.tournament_id = new.tournament_id and tr2.round_type = 'losers' and tr2.round_number > tr.round_number)
          and (select count(*) from public.tournament_matches tm where tm.round_id = tr.id and tm.winner_team in ('team1','team2')) = 1 limit 1;
        if v_lb_final_round is not null then perform public._de_create_grand_final(new.tournament_id, v_match_type); end if;
      end if;
      return new;
    end if;

    if v_round_type = 'losers' then
      select max(round_number) into v_wb_round_count from public.tournament_rounds where tournament_id = new.tournament_id and round_type = 'winners';
      v_lb_final_num := (2 * coalesce(v_wb_round_count, 1)) - 2;
      if v_winner_count = 0 then return new; end if;
      if v_winner_count = 1 and v_round_number >= v_lb_final_num then
        select tr.round_number into v_wb_final_round from public.tournament_rounds tr where tr.tournament_id = new.tournament_id and tr.round_type = 'winners'
          and (select count(*) from public.tournament_matches tm where tm.round_id = tr.id and tm.winner_team in ('team1','team2')) = 1 order by tr.round_number desc limit 1;
        if v_wb_final_round is not null then perform public._de_create_grand_final(new.tournament_id, v_match_type); end if;
        return new;
      end if;
      if (v_round_number % 2) = 1 then
        declare v_wb_src_round integer := ((v_round_number + 1) / 2) + 1; v_target_lb_num integer := v_round_number + 1; v_wb_src_id uuid; v_wb_loser_count integer;
        begin
          select id into v_wb_src_id from public.tournament_rounds where tournament_id = new.tournament_id and round_type = 'winners' and round_number = v_wb_src_round;
          if v_wb_src_id is null then return new; end if;
          select count(*) into v_wb_loser_count from public.tournament_matches where round_id = v_wb_src_id and status = 'completed' and winner_team in ('team1','team2');
          select count(*) into v_uncompleted from public.tournament_matches where round_id = v_wb_src_id and status <> 'completed';
          if v_uncompleted > 0 or v_wb_loser_count = 0 then return new; end if;
          if exists (select 1 from public.tournament_matches tm join public.tournament_rounds tr on tr.id = tm.round_id where tr.tournament_id = new.tournament_id and tr.round_type = 'losers' and tr.round_number = v_target_lb_num) then return new; end if;
          v_next_round_id := public._de_get_or_create_round(new.tournament_id, v_target_lb_num, 'losers', format('Losers Round %s', v_target_lb_num));
          v_pair_count := least(v_winner_count, v_wb_loser_count);
          for v_i in 0..(v_pair_count - 1) loop
            with lb_prev as (select tm.*, row_number() over (order by tm.match_order, tm.id) - 1 as rn from public.tournament_matches tm where tm.round_id = new.round_id and tm.winner_team in ('team1','team2')) select * into v_w1 from lb_prev where rn = v_i;
            with wb_losers as (select tm.*, row_number() over (order by tm.match_order, tm.id) - 1 as rn from public.tournament_matches tm where tm.round_id = v_wb_src_id and tm.winner_team in ('team1','team2')) select * into v_l1 from wb_losers where rn = v_i;
            if v_w1 is null or v_l1 is null then continue; end if;
            insert into public.tournament_matches (tournament_id, round_id, match_order, match_type, team1_player1, team1_player2, team2_player1, team2_player2, status)
            values (new.tournament_id, v_next_round_id, v_i, v_match_type,
              case when v_w1.winner_team = 'team1' then v_w1.team1_player1 else v_w1.team2_player1 end,
              case when v_w1.winner_team = 'team1' then v_w1.team1_player2 else v_w1.team2_player2 end,
              case when v_l1.winner_team = 'team1' then v_l1.team2_player1 else v_l1.team1_player1 end,
              case when v_l1.winner_team = 'team1' then v_l1.team2_player2 else v_l1.team1_player2 end, 'pending');
          end loop;
        end;
      else
        v_next_round_num := v_round_number + 1;
        if exists (select 1 from public.tournament_rounds where tournament_id = new.tournament_id and round_type = 'losers' and round_number = v_next_round_num) then return new; end if;
        v_pair_count := v_winner_count / 2;
        if v_pair_count = 0 then return new; end if;
        v_next_round_id := public._de_get_or_create_round(new.tournament_id, v_next_round_num, 'losers', format('Losers Round %s', v_next_round_num));
        for v_i in 0..(v_pair_count - 1) loop
          with ordered as (select tm.*, row_number() over (order by match_order, id) - 1 as rn from public.tournament_matches tm where tm.round_id = new.round_id and tm.winner_team in ('team1','team2')) select * into v_w1 from ordered where rn = v_i * 2;
          with ordered as (select tm.*, row_number() over (order by match_order, id) - 1 as rn from public.tournament_matches tm where tm.round_id = new.round_id and tm.winner_team in ('team1','team2')) select * into v_w2 from ordered where rn = v_i * 2 + 1;
          if v_w1 is null or v_w2 is null then continue; end if;
          insert into public.tournament_matches (tournament_id, round_id, match_order, match_type, team1_player1, team1_player2, team2_player1, team2_player2, status)
          values (new.tournament_id, v_next_round_id, v_i, v_match_type,
            case when v_w1.winner_team = 'team1' then v_w1.team1_player1 else v_w1.team2_player1 end,
            case when v_w1.winner_team = 'team1' then v_w1.team1_player2 else v_w1.team2_player2 end,
            case when v_w2.winner_team = 'team1' then v_w2.team1_player1 else v_w2.team2_player1 end,
            case when v_w2.winner_team = 'team1' then v_w2.team1_player2 else v_w2.team2_player2 end, 'pending');
        end loop;
      end if;
      return new;
    end if;
  exception when others then null;
  end;
  return new;
end;
$function$;

-- ── _advance_non_mlp_playoff_bracket() ──
CREATE OR REPLACE FUNCTION public._advance_non_mlp_playoff_bracket()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_format text; v_match_type text; v_playoff_3pm boolean; v_playoff_format text;
  v_round_type text; v_round_number integer; v_uncompleted integer;
  v_next_round_id uuid; v_next_round_num integer; v_next_round_type text; v_next_label text;
  v_count integer; v_i integer; v_w1 record; v_w2 record;
  v_3pm_round_id uuid; v_3pm_exists boolean; v_l1 record; v_l2 record;
begin
  if new.status <> 'completed' then return new; end if;
  if TG_OP = 'UPDATE' and old.status = 'completed' then return new; end if;
  select format, match_type, coalesce(playoff_third_place,false), coalesce(playoff_format,'none')
    into v_format, v_match_type, v_playoff_3pm, v_playoff_format
    from public.tournaments where id = new.tournament_id;
  if v_format not in ('round_robin','pool_play') then return new; end if;
  select round_type, round_number into v_round_type, v_round_number from public.tournament_rounds where id = new.round_id;
  if v_round_type not in ('quarterfinals','semifinals') then return new; end if;
  select count(*) into v_uncompleted from public.tournament_matches where round_id = new.round_id and status <> 'completed';
  if v_uncompleted > 0 then return new; end if;
  if v_round_type = 'quarterfinals' then v_next_round_type:='semifinals'; v_next_label:='Semifinals';
  else v_next_round_type:='finals'; v_next_label:='Finals'; end if;
  if exists (select 1 from public.tournament_rounds where tournament_id = new.tournament_id and round_type = v_next_round_type) then return new; end if;
  select count(*) into v_count from public.tournament_matches where round_id = new.round_id and winner_team in ('team1','team2');
  if v_count < 2 then return new; end if;
  v_next_round_num := coalesce(v_round_number,1000) + 100;
  insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
    values (new.tournament_id, v_next_round_num, v_next_label, v_next_round_type) returning id into v_next_round_id;
  for v_i in 0..(v_count/2 - 1) loop
    with ordered as (select tm.*, row_number() over (order by match_order, id)-1 as rn from public.tournament_matches tm where tm.round_id=new.round_id and tm.winner_team in ('team1','team2')) select * into v_w1 from ordered where rn=v_i;
    with ordered as (select tm.*, row_number() over (order by match_order, id)-1 as rn from public.tournament_matches tm where tm.round_id=new.round_id and tm.winner_team in ('team1','team2')) select * into v_w2 from ordered where rn=v_count-1-v_i;
    if v_w1 is null or v_w2 is null then continue; end if;
    if v_w1.id = v_w2.id then continue; end if;
    insert into public.tournament_matches (tournament_id, round_id, match_order, match_type, team1_player1, team1_player2, team2_player1, team2_player2, status)
    values (new.tournament_id, v_next_round_id, v_i, coalesce(v_match_type,'singles'),
      case when v_w1.winner_team='team1' then v_w1.team1_player1 else v_w1.team2_player1 end,
      case when v_w1.winner_team='team1' then v_w1.team1_player2 else v_w1.team2_player2 end,
      case when v_w2.winner_team='team1' then v_w2.team1_player1 else v_w2.team2_player1 end,
      case when v_w2.winner_team='team1' then v_w2.team1_player2 else v_w2.team2_player2 end, 'pending');
  end loop;
  if v_round_type = 'semifinals' and v_playoff_3pm
     and v_playoff_format in ('top_4','top_8','top_1_per_pool','top_2_per_pool') and v_count = 2 then
    select exists (select 1 from public.tournament_rounds where tournament_id = new.tournament_id and round_type='third_place_match') into v_3pm_exists;
    if not v_3pm_exists then
      with ordered as (select tm.*, row_number() over (order by match_order, id)-1 as rn from public.tournament_matches tm where tm.round_id=new.round_id and tm.winner_team in ('team1','team2')) select * into v_l1 from ordered where rn=0;
      with ordered as (select tm.*, row_number() over (order by match_order, id)-1 as rn from public.tournament_matches tm where tm.round_id=new.round_id and tm.winner_team in ('team1','team2')) select * into v_l2 from ordered where rn=1;
      if v_l1.id is not null and v_l2.id is not null and v_l1.id <> v_l2.id then
        insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
          values (new.tournament_id, v_next_round_num + 50, 'Third Place Match', 'third_place_match') returning id into v_3pm_round_id;
        insert into public.tournament_matches (tournament_id, round_id, match_order, match_type, team1_player1, team1_player2, team2_player1, team2_player2, status)
        values (new.tournament_id, v_3pm_round_id, 0, coalesce(v_match_type,'singles'),
          case when v_l1.winner_team='team1' then v_l1.team2_player1 else v_l1.team1_player1 end,
          case when v_l1.winner_team='team1' then v_l1.team2_player2 else v_l1.team1_player2 end,
          case when v_l2.winner_team='team1' then v_l2.team2_player1 else v_l2.team1_player1 end,
          case when v_l2.winner_team='team1' then v_l2.team2_player2 else v_l2.team1_player2 end, 'pending');
      end if;
    end if;
  end if;
  return new;
end;
$function$;

-- ── _advance_single_elim_bracket() ──
CREATE OR REPLACE FUNCTION public._advance_single_elim_bracket()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_format text; v_match_type text; v_round_number integer; v_round_type text;
  v_min_round_num integer; v_is_first_round boolean; v_uncompleted integer;
  v_winner_count integer; v_next_round_id uuid; v_next_round_num integer;
  v_next_round_type text; v_next_label text; v_pair_count integer; v_i integer;
  v_w1 record; v_w2 record; v_entrant_count integer; v_pow2 integer;
  v_slot_matches integer; v_round2_pairs integer; v_seeds uuid[]; v_seeds2 uuid[];
  v_top_seed integer; v_bot_seed integer; v_a1 uuid; v_a2 uuid; v_b1 uuid; v_b2 uuid;
begin
  if new.status <> 'completed' then return new; end if;
  if TG_OP = 'UPDATE' and old.status = 'completed' then return new; end if;
  begin
    select format, match_type into v_format, v_match_type from public.tournaments where id = new.tournament_id;
    -- single_elimination ONLY (double_elimination has its own dedicated trigger).
    if v_format <> 'single_elimination' then return new; end if;

    select round_number, round_type into v_round_number, v_round_type from public.tournament_rounds where id = new.round_id;
    if v_round_number is null then return new; end if;
    select count(*) into v_uncompleted from public.tournament_matches where round_id = new.round_id and status <> 'completed';
    if v_uncompleted > 0 then return new; end if;
    v_next_round_num := v_round_number + 1;
    if exists (select 1 from public.tournament_rounds where tournament_id = new.tournament_id and round_number = v_next_round_num) then return new; end if;
    select min(round_number) into v_min_round_num from public.tournament_rounds where tournament_id = new.tournament_id and round_type in ('winners','finals','quarterfinals','semifinals');
    v_is_first_round := (v_round_number = coalesce(v_min_round_num, v_round_number));
    select count(*) into v_winner_count from public.tournament_matches where round_id = new.round_id and winner_team in ('team1','team2');

    if v_is_first_round and v_format = 'single_elimination' and coalesce(v_match_type,'singles') = 'singles' then
      select array_agg(user_id order by ord) into v_seeds from (
        select r.user_id, row_number() over (order by r.seed asc nulls last, r.registered_at asc, r.user_id) as ord
          from public.tournament_registrations r where r.tournament_id = new.tournament_id and r.status = 'approved') s;
      v_seeds2 := v_seeds;
      v_entrant_count := coalesce(array_length(v_seeds, 1), 0);
      if v_entrant_count >= 3 and v_entrant_count > v_winner_count * 2 then
        v_pow2 := 1; while v_pow2 < v_entrant_count loop v_pow2 := v_pow2 * 2; end loop;
        v_slot_matches := v_pow2 / 2; v_round2_pairs := v_slot_matches / 2;
        if v_round2_pairs >= 1 then
          if v_round2_pairs = 1 then v_next_round_type := 'finals'; v_next_label := 'Finals';
          else v_next_round_type := 'winners'; v_next_label := format('Round %s', v_next_round_num); end if;
          insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
          values (new.tournament_id, v_next_round_num, v_next_label, v_next_round_type) returning id into v_next_round_id;
          for v_i in 0 .. (v_round2_pairs - 1) loop
            select sw.p1, sw.p2 into v_a1, v_a2 from public._se_round1_slot_winner(new.round_id, v_seeds, v_seeds2, v_pow2, v_entrant_count, v_i) sw;
            select sw.p1, sw.p2 into v_b1, v_b2 from public._se_round1_slot_winner(new.round_id, v_seeds, v_seeds2, v_pow2, v_entrant_count, v_slot_matches - 1 - v_i) sw;
            if v_a1 is null or v_b1 is null then continue; end if;
            insert into public.tournament_matches (tournament_id, round_id, match_order, match_type, team1_player1, team1_player2, team2_player1, team2_player2, status)
            values (new.tournament_id, v_next_round_id, v_i, 'singles', v_a1, null, v_b1, null, 'pending');
          end loop;
          return new;
        end if;
      end if;
    end if;

    if v_winner_count <= 1 then
      update public.tournaments set status = 'completed' where id = new.tournament_id and status <> 'completed';
      return new;
    end if;
    v_pair_count := v_winner_count / 2;
    if v_pair_count < 1 then return new; end if;
    if v_pair_count = 1 then v_next_round_type := 'finals'; v_next_label := 'Finals';
    else v_next_round_type := 'winners'; v_next_label := format('Round %s', v_next_round_num); end if;
    insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
    values (new.tournament_id, v_next_round_num, v_next_label, v_next_round_type) returning id into v_next_round_id;
    for v_i in 0..(v_pair_count - 1) loop
      with ordered as (select tm.*, row_number() over (order by match_order, id) - 1 as rn from public.tournament_matches tm where tm.round_id = new.round_id and tm.winner_team in ('team1','team2')) select * into v_w1 from ordered where rn = v_i * 2;
      with ordered as (select tm.*, row_number() over (order by match_order, id) - 1 as rn from public.tournament_matches tm where tm.round_id = new.round_id and tm.winner_team in ('team1','team2')) select * into v_w2 from ordered where rn = v_i * 2 + 1;
      if v_w1 is null or v_w2 is null then continue; end if;
      insert into public.tournament_matches (tournament_id, round_id, match_order, match_type, team1_player1, team1_player2, team2_player1, team2_player2, status)
      values (new.tournament_id, v_next_round_id, v_i, coalesce(v_match_type,'singles'),
        case when v_w1.winner_team='team1' then v_w1.team1_player1 else v_w1.team2_player1 end,
        case when v_w1.winner_team='team1' then v_w1.team1_player2 else v_w1.team2_player2 end,
        case when v_w2.winner_team='team1' then v_w2.team1_player1 else v_w2.team2_player1 end,
        case when v_w2.winner_team='team1' then v_w2.team1_player2 else v_w2.team2_player2 end, 'pending');
    end loop;
  exception when others then
    raise warning '_advance_single_elim_bracket failed for tournament % round %: % / %', new.tournament_id, new.round_id, sqlstate, sqlerrm;
  end;
  return new;
end;
$function$;

-- ── _award_cinderella_badge() ──
CREATE OR REPLACE FUNCTION public._award_cinderella_badge()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
$function$;

-- ── _award_globetrotter_ii_badge() ──
CREATE OR REPLACE FUNCTION public._award_globetrotter_ii_badge()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
$function$;

-- ── _award_marathon_badge() ──
CREATE OR REPLACE FUNCTION public._award_marathon_badge()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
$function$;

-- ── _award_match_badges() ──
CREATE OR REPLACE FUNCTION public._award_match_badges()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
$function$;

-- ── _award_triple_crown_badge() ──
CREATE OR REPLACE FUNCTION public._award_triple_crown_badge()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
$function$;

-- ── _award_underdog_badge() ──
CREATE OR REPLACE FUNCTION public._award_underdog_badge()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
$function$;

-- ── _lock_season_period_unchecked(uuid,integer,date) ──
CREATE OR REPLACE FUNCTION public._lock_season_period_unchecked(p_season_id uuid, p_period_number integer, p_snapshot_date date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_league_id    uuid;
  v_season_name  text;
  v_season_start date;
  v_baseline     numeric(4,2);
  v_rec          record;
  v_rank         integer := 0;
  v_bonus        numeric(4,2);
  v_new_rating   numeric(5,2);
begin
  select league_id, name, start_date, baseline_plupr
    into v_league_id, v_season_name, v_season_start, v_baseline
    from public.league_seasons
   where id = p_season_id;
  if v_league_id is null then raise exception 'Season not found'; end if;

  delete from public.season_snapshots
   where season_id = p_season_id and period_number = p_period_number;

  for v_rec in (
    with player_stats as (
      select
        lm.user_id,
        coalesce(lpr.rating, v_baseline) as rating,
        -- Count individual games for best-of-N matches via game_scores jsonb.
        -- Falls back to 1 W or 1 L from winner_team for single-game matches.
        coalesce(sum(case
          when m.id is null then 0
          when m.game_scores is not null and jsonb_typeof(m.game_scores) = 'array' and jsonb_array_length(m.game_scores) > 0 then (
            select count(*)::int from jsonb_array_elements(m.game_scores) g
             where (
               ((m.player1_id  = lm.user_id or m.partner1_id = lm.user_id) and (g->>'t1')::int > (g->>'t2')::int)
            or ((m.player2_id  = lm.user_id or m.partner2_id = lm.user_id) and (g->>'t2')::int > (g->>'t1')::int)
             ))
          when (m.player1_id  = lm.user_id or m.partner1_id = lm.user_id) and m.winner_team='team1' then 1
          when (m.player2_id  = lm.user_id or m.partner2_id = lm.user_id) and m.winner_team='team2' then 1
          else 0
        end), 0) as wins,
        coalesce(sum(case
          when m.id is null then 0
          when m.game_scores is not null and jsonb_typeof(m.game_scores) = 'array' and jsonb_array_length(m.game_scores) > 0 then (
            select count(*)::int from jsonb_array_elements(m.game_scores) g
             where (
               ((m.player1_id  = lm.user_id or m.partner1_id = lm.user_id) and (g->>'t2')::int > (g->>'t1')::int)
            or ((m.player2_id  = lm.user_id or m.partner2_id = lm.user_id) and (g->>'t1')::int > (g->>'t2')::int)
             ))
          when (m.player1_id  = lm.user_id or m.partner1_id = lm.user_id) and m.winner_team='team2' then 1
          when (m.player2_id  = lm.user_id or m.partner2_id = lm.user_id) and m.winner_team='team1' then 1
          else 0
        end), 0) as losses
      from public.league_members lm
      left join public.league_player_ratings lpr
        on  lpr.league_id = v_league_id
        and lpr.user_id   = lm.user_id
      left join public.matches m
        on  m.league_id   = v_league_id
        and coalesce(m.status, 'completed') = 'completed'
        and m.played_at::date between v_season_start and p_snapshot_date
        and (
          m.player1_id  = lm.user_id or m.partner1_id = lm.user_id or
          m.player2_id  = lm.user_id or m.partner2_id = lm.user_id
        )
      where lm.league_id = v_league_id
      group by lm.user_id, lpr.rating
    )
    select user_id, rating, wins, losses
      from player_stats
     order by rating desc nulls last,
              (wins - losses) desc,
              wins desc
  ) loop
    v_rank := v_rank + 1;
    insert into public.season_snapshots (
      season_id, league_id, period_number, snapshot_date,
      user_id, elo_at_snapshot, rank_at_snapshot, wins_in_season, losses_in_season
    ) values (
      p_season_id, v_league_id, p_period_number, p_snapshot_date,
      v_rec.user_id, v_rec.rating, v_rank, v_rec.wins, v_rec.losses
    );

    if v_rank = 1 then
      perform public.award_league_badge(
        v_rec.user_id, v_league_id, 'Period Champion',
        format('%s — Period %s', v_season_name, p_period_number)
      );
    end if;

    v_bonus := case
      when v_rank = 1 then 0.20
      when v_rank = 2 then 0.15
      when v_rank = 3 then 0.10
      when v_rank = 4 then 0.05
      when v_rank = 5 then 0.02
      else 0.00
    end;
    v_new_rating := v_baseline + v_bonus;
    update public.league_player_ratings
       set rating               = v_new_rating,
           singles_rating       = v_new_rating,
           doubles_rating       = v_new_rating,
           mixed_doubles_rating = v_new_rating,
           updated_at           = now()
     where league_id = v_league_id and user_id = v_rec.user_id;
  end loop;

  update public.league_seasons
     set status = 'active'
   where id = p_season_id and status = 'upcoming';

  perform public._settle_wagers_for_period_lock(p_season_id, p_period_number);
end;
$function$;

-- ── _maybe_auto_close_mlp_tournament() ──
CREATE OR REPLACE FUNCTION public._maybe_auto_close_mlp_tournament()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_round_type  text;
  v_undecided   integer;
begin
  if new.status <> 'completed' then return new; end if;
  if TG_OP = 'UPDATE' and old.status = 'completed' then return new; end if;

  select round_type into v_round_type
    from public.tournament_rounds where id = new.round_id;
  if v_round_type not in ('finals', 'third_place_match') then return new; end if;

  begin
    -- A playoff round is "decided" when one team has > half rotation wins
    -- OR every rotation has been completed (the latter handles 2-2 ties).
    select count(*) into v_undecided
      from public.tournament_rounds tr
      join lateral public._mlp_round_series_state(tr.id) s on true
     where tr.tournament_id = new.tournament_id
       and tr.round_type in ('finals', 'third_place_match')
       and not (
         s.a_wins > s.total_matches / 2
         or s.b_wins > s.total_matches / 2
         or s.total_completed >= s.total_matches
       );

    if v_undecided = 0 then
      update public.tournaments
         set status = 'completed'
       where id = new.tournament_id
         and status <> 'completed';
    end if;
  exception when others then
    null; -- never block the score update
  end;

  return new;
end;
$function$;

-- ── _notify_pending_match() ──
CREATE OR REPLACE FUNCTION public._notify_pending_match()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_recipient uuid;
  v_entering  text;
  v_league    text;
  v_others    uuid[];
begin
  if new.status <> 'pending' then return new; end if;

  select full_name into v_entering from public.profiles
    where id = coalesce(new.team1_confirmed_by, new.team2_confirmed_by, new.player1_id);
  select name into v_league from public.leagues where id = new.league_id;

  v_others := array_remove(array[new.player1_id, new.partner1_id, new.player2_id, new.partner2_id],
                           coalesce(new.team1_confirmed_by, new.team2_confirmed_by));
  v_others := array_remove(v_others, null);

  foreach v_recipient in array v_others loop
    if v_recipient is null then continue; end if;
    if v_recipient = new.team1_confirmed_by or v_recipient = new.team2_confirmed_by then continue; end if;
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, is_read)
    values (
      v_recipient,
      '🥒 Match needs your team to confirm',
      format('%s entered a match in %s. Open match history to confirm within an hour.',
             coalesce(v_entering, 'A player'), coalesce(v_league, 'a league')),
      'match', new.id, 'match', false
    );
  end loop;

  return new;
exception when others then
  return new;
end;
$function$;

-- ── _se_round1_slot_winner(uuid,uuid[],uuid[],integer,integer,integer) ──
CREATE OR REPLACE FUNCTION public._se_round1_slot_winner(p_round_id uuid, p_seeds uuid[], p_seeds2 uuid[], p_pow2 integer, p_entrant_count integer, p_slot integer)
 RETURNS TABLE(p1 uuid, p2 uuid)
 LANGUAGE plpgsql
 STABLE
AS $function$
declare
  v_top_seed integer := p_slot + 1; v_bot_seed integer := p_pow2 - p_slot;
  v_top1 uuid; v_top2 uuid; v_bot1 uuid; v_bot2 uuid; v_m record;
begin
  v_top1 := p_seeds[v_top_seed]; v_top2 := p_seeds2[v_top_seed];
  if v_bot_seed > p_entrant_count then p1 := v_top1; p2 := v_top2; return next; return; end if;
  v_bot1 := p_seeds[v_bot_seed]; v_bot2 := p_seeds2[v_bot_seed];
  select * into v_m from public.tournament_matches tm where tm.round_id = p_round_id and tm.winner_team in ('team1','team2')
    and ((tm.team1_player1 = v_top1 and tm.team2_player1 = v_bot1) or (tm.team1_player1 = v_bot1 and tm.team2_player1 = v_top1)) limit 1;
  if v_m.id is null then p1 := v_top1; p2 := v_top2; return next; return; end if;
  if v_m.winner_team = 'team1' then p1 := v_m.team1_player1; p2 := v_m.team1_player2;
  else p1 := v_m.team2_player1; p2 := v_m.team2_player2; end if;
  return next;
end;
$function$;

-- ── _settle_mlp_dreambreaker() ──
CREATE OR REPLACE FUNCTION public._settle_mlp_dreambreaker()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_a_wins      integer;
  v_b_wins      integer;
  v_db_match_id uuid;
  v_db_status   text;
begin
  if new.status <> 'completed' then return new; end if;
  if new.is_dreambreaker then return new; end if;
  if TG_OP = 'UPDATE' and old.status = 'completed' then return new; end if;

  begin
    select id, status into v_db_match_id, v_db_status
      from public.tournament_matches
     where round_id = new.round_id
       and is_dreambreaker = true
     limit 1;
    if v_db_match_id is null then return new; end if;
    if v_db_status <> 'pending' then return new; end if;

    select
      count(*) filter (where status = 'completed' and winner_team = 'team1')::int,
      count(*) filter (where status = 'completed' and winner_team = 'team2')::int
      into v_a_wins, v_b_wins
      from public.tournament_matches
     where round_id = new.round_id
       and is_dreambreaker = false;

    if v_a_wins >= 3 or v_b_wins >= 3 then
      update public.tournament_matches
         set status = 'cancelled'
       where id = v_db_match_id
         and status = 'pending';
    end if;
  exception when others then
    null;
  end;

  return new;
end;
$function$;

-- ── _settle_wagers_for_tournament(uuid) ──
CREATE OR REPLACE FUNCTION public._settle_wagers_for_tournament(p_tournament_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_w        record;
  v_won      boolean;
  v_title    text;
  v_body     text;
  v_pred_uid uuid;
  v_pred_rank int;
  v_actual_rank int;
begin
  perform public.compute_tournament_final_ranks(p_tournament_id);

  for v_w in (
    select * from public.wagers
     where subject_id = p_tournament_id
       and subject_type = 'tournament_rank'
       and status = 'open'
       for update
  ) loop
    v_pred_uid  := (v_w.predicate->>'user_id')::uuid;
    v_pred_rank := coalesce((v_w.predicate->>'rank')::int, 1);

    select final_rank into v_actual_rank
      from public.tournament_final_ranks
     where tournament_id = p_tournament_id and user_id = v_pred_uid
     limit 1;

    v_won := (v_actual_rank is not null and v_actual_rank = v_pred_rank);

    if v_won then
      update public.profiles set pickles = pickles + v_w.potential_payout where id = v_w.user_id;
      update public.wagers set status = 'won', settled_at = now() where id = v_w.id;
      v_title := '🎲 Wager won!';
      v_body  := format('You won %s 🥒 — they finished %s.', v_w.potential_payout, v_actual_rank);
    else
      update public.wagers set status = 'lost', settled_at = now() where id = v_w.id;
      v_title := '🎲 Wager settled';
      v_body  := case
        when v_actual_rank is null then format('Your %s 🥒 tournament rank wager didn''t settle.', v_w.stake)
        else format('Your %s 🥒 wager missed — they finished %s.', v_w.stake, v_actual_rank)
      end;
    end if;
    perform public._wager_notify(v_w.user_id, v_title, v_body, v_w.id);
  end loop;
end;
$function$;

-- ── _wager_score_density(integer,integer) ──
CREATE OR REPLACE FUNCTION public._wager_score_density(p_s1 integer, p_s2 integer)
 RETURNS numeric
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
declare
  v_hi int := greatest(p_s1, p_s2);
  v_lo int := least(p_s1, p_s2);
begin
  if v_hi >= 12 then return 0.01; end if;
  if v_hi = 11 then
    return case v_lo
      when 9  then 0.18
      when 8  then 0.16
      when 7  then 0.16
      when 10 then 0.14
      when 6  then 0.12
      when 5  then 0.10
      when 4  then 0.08
      when 3  then 0.06
      when 2  then 0.04
      when 1  then 0.03
      when 0  then 0.02
      else 0.05
    end;
  end if;
  return 0.05;
end;
$function$;

-- ── auto_payout_mlp_tournament(uuid) ──
CREATE OR REPLACE FUNCTION public.auto_payout_mlp_tournament(p_tournament_id uuid)
 RETURNS TABLE(success boolean, total_distributed integer, recipients integer, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_uid             uuid := auth.uid();
  v_already         timestamptz;
  v_status          text;
  v_tournament_name text;
  v_total           integer := 0;
  v_recipients      integer := 0;
  v_row             record;
  v_uid_inner       uuid;
  v_place_label     text;
  v_emoji           text;
  v_summary_body    text;
  v_context         text;
  v_podium_badge    text;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if not public.is_scope_admin('tournament', p_tournament_id) then
    raise exception 'Only admins may pay out prizes';
  end if;

  select status, champion_payout_applied_at, name
    into v_status, v_already, v_tournament_name
    from public.tournaments where id = p_tournament_id;
  if v_status <> 'completed' then
    return query select false, 0, 0, 'Tournament not yet completed.'::text; return;
  end if;
  if v_already is not null then
    return query select false, 0, 0, 'Payout already applied for this tournament.'::text; return;
  end if;

  for v_row in select * from public.preview_mlp_tournament_payout(p_tournament_id) loop
    if v_row.uids is null or array_length(v_row.uids, 1) = 0 then continue; end if;

    v_emoji := case v_row.place when 1 then '🥇' when 2 then '🥈' when 3 then '🥉' else '🏅' end;
    v_place_label := case v_row.place
                       when 1 then '1st'
                       when 2 then '2nd'
                       when 3 then '3rd'
                       else v_row.place::text || 'th'
                     end;
    v_context := format('finishing %s with %s in %s', v_place_label, v_row.team_name, v_tournament_name);

    v_podium_badge := case v_row.place
                        when 1 then 'Tournament Champion'
                        when 2 then 'Tournament Silver'
                        when 3 then 'Tournament Bronze'
                        else null end;

    foreach v_uid_inner in array v_row.uids loop
      -- Pickle payout
      if v_row.share_per_user > 0 then
        update public.profiles set pickles = pickles + v_row.share_per_user where id = v_uid_inner;
        insert into public.pickle_pot_payouts
          (scope_type, scope_id, user_id, amount, reason, granted_by, is_automatic)
        values ('tournament', p_tournament_id, v_uid_inner, v_row.share_per_user,
                format('Tournament #%s · %s', v_row.place, v_row.team_name), v_uid, true);
        v_total := v_total + v_row.share_per_user;
      end if;

      -- Legacy champion-badge ledger (unchanged)
      insert into public.tournament_champion_badges
        (tournament_id, user_id, team_id, team_name, place)
      values (p_tournament_id, v_uid_inner, v_row.team_id, v_row.team_name, v_row.place)
      on conflict (tournament_id, user_id) do nothing;

      -- New: stackable player_badges row for the podium finish.
      if v_podium_badge is not null then
        perform public.award_profile_badge(
          v_uid_inner,
          v_podium_badge,
          format('%s — %s', v_tournament_name, v_row.team_name)
        );
      end if;

      -- PLUPR bonus
      if v_row.plupr_bonus > 0 then
        insert into public.tournament_plupr_bonuses
          (tournament_id, user_id, bonus_value, place)
        values (p_tournament_id, v_uid_inner, v_row.plupr_bonus, v_row.place)
        on conflict (tournament_id, user_id) do nothing;

        update public.profiles
           set rating = coalesce(rating, 0) + v_row.plupr_bonus
         where id = v_uid_inner;
      end if;

      -- Notifications (unchanged from migration_payout_notifications_split.sql)
      v_summary_body := format('You finished %s with %s in %s.',
                               v_place_label, v_row.team_name, v_tournament_name);
      if v_row.share_per_user > 0 then
        v_summary_body := v_summary_body || format(E'\n• 🥒 %s pickles', v_row.share_per_user);
      end if;
      v_summary_body := v_summary_body || E'\n• 🏅 Champion badge added to your profile';
      if v_row.plupr_bonus > 0 then
        v_summary_body := v_summary_body || format(E'\n• +%s PLUPR rating bonus', v_row.plupr_bonus);
      end if;

      perform public._notify_user(
        v_uid_inner,
        format('%s Prize: %s place!', v_emoji, v_place_label),
        v_summary_body,
        p_tournament_id,
        'tournament'
      );

      if v_row.share_per_user > 0 then
        perform public._notify_user(
          v_uid_inner,
          format('🥒 +%s pickles!', v_row.share_per_user),
          format('You received %s 🥒 for %s. Tap to see your shop balance.',
                 v_row.share_per_user, v_context),
          p_tournament_id,
          'shop'
        );
      end if;

      perform public._notify_user(
        v_uid_inner,
        format('🏅 %s Place Badge', v_place_label),
        format('A %s champion badge was added to your profile for %s. Tap to view it.',
               v_place_label, v_context),
        v_uid_inner,
        'profile'
      );

      if v_row.plupr_bonus > 0 then
        perform public._notify_user(
          v_uid_inner,
          format('📈 +%s PLUPR bonus', v_row.plupr_bonus),
          format('A one-time PLUPR boost of +%s was applied for %s. Tap to see your PLUPR history.',
                 v_row.plupr_bonus, v_context),
          v_uid_inner,
          'plupr_history'
        );
      end if;

      v_recipients := v_recipients + 1;
    end loop;
  end loop;

  update public.tournaments
     set prize_pool = greatest(prize_pool - v_total, 0),
         champion_payout_applied_at = now()
   where id = p_tournament_id;

  return query select true, v_total, v_recipients,
    format('Paid out %s 🥒 to %s players, awarded badges + PLUPR bonus, sent notifications.',
           v_total, v_recipients);
end;
$function$;

-- ── cancel_wager(uuid) ──
CREATE OR REPLACE FUNCTION public.cancel_wager(p_wager_id uuid)
 RETURNS TABLE(success boolean, refunded integer, balance integer, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid     uuid := auth.uid();
  v_w       public.wagers%rowtype;
  v_status  text;
  v_new_bal int;
begin
  if v_uid is null then
    return query select false, 0, null::int, 'Not signed in.';
    return;
  end if;

  select * into v_w from public.wagers where id = p_wager_id for update;
  if v_w.id is null then
    return query select false, 0, null::int, 'Wager not found.';
    return;
  end if;
  if v_w.user_id <> v_uid then
    return query select false, 0, null::int, 'Not your wager.';
    return;
  end if;
  if v_w.status <> 'open' then
    return query select false, 0, null::int, 'Wager is no longer open.';
    return;
  end if;

  if v_w.subject_type in ('match','match_score') then
    select status into v_status from public.matches where id = v_w.subject_id;
    if v_status = 'completed' then
      return query select false, 0, null::int, 'Match already completed.';
      return;
    end if;
  elsif v_w.subject_type in ('tournament_match','tournament_match_score') then
    select status into v_status from public.tournament_matches where id = v_w.subject_id;
    if v_status = 'completed' then
      return query select false, 0, null::int, 'Tournament match already completed.';
      return;
    end if;
  elsif v_w.subject_type = 'tournament_rank' then
    select status into v_status from public.tournaments where id = v_w.subject_id;
    if v_status in ('completed','cancelled') then
      return query select false, 0, null::int, 'Tournament already resolved.';
      return;
    end if;
  elsif v_w.subject_type = 'period_rank' then
    if exists (
      select 1 from public.season_snapshots
       where season_id = v_w.subject_id
         and period_number = (v_w.predicate->>'period_number')::int
    ) then
      return query select false, 0, null::int, 'Period already locked.';
      return;
    end if;
  elsif v_w.subject_type = 'season_rank' then
    select status into v_status from public.league_seasons where id = v_w.subject_id;
    if v_status = 'completed' then
      return query select false, 0, null::int, 'Season already completed.';
      return;
    end if;
  end if;

  update public.profiles set pickles = pickles + v_w.stake
    where id = v_uid
    returning pickles into v_new_bal;

  update public.wagers
     set status = 'cancelled', settled_at = now()
   where id = p_wager_id;

  return query select true, v_w.stake, v_new_bal, 'Wager cancelled. Stake refunded.'::text;
end;
$function$;

-- ── claim_ftue_step(text) ──
CREATE OR REPLACE FUNCTION public.claim_ftue_step(p_step text)
 RETURNS TABLE(success boolean, granted integer, new_balance integer, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_uid       uuid := auth.uid();
  v_balance   integer;
  v_complete  boolean := false;
  v_amount    integer := 0;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  v_amount := case p_step
    when 'join_league'   then 500
    when 'setup_profile' then 500
    when 'first_match'   then 1000
    else null
  end;

  select pickles into v_balance from public.profiles where id = v_uid;

  if v_amount is null then
    return query select false, 0, v_balance, 'Unknown step'::text; return;
  end if;

  if p_step = 'join_league' then
    v_complete := exists (select 1 from public.league_members where user_id = v_uid);
  elsif p_step = 'setup_profile' then
    select (avatar_emoji is not null
            or tagline is not null
            or coalesce(array_length(selected_tags, 1), 0) > 0)
      into v_complete
      from public.profiles where id = v_uid;
  elsif p_step = 'first_match' then
    select coalesce(total_matches_played, 0) > 0
      into v_complete
      from public.profiles where id = v_uid;
  end if;

  if not coalesce(v_complete, false) then
    return query select false, 0, v_balance, 'Step not complete yet'::text; return;
  end if;

  if exists (select 1 from public.ftue_grants where user_id = v_uid and step = p_step) then
    return query select false, 0, v_balance, 'Already claimed'::text; return;
  end if;

  insert into public.ftue_grants (user_id, step) values (v_uid, p_step);
  update public.profiles set pickles = pickles + v_amount
   where id = v_uid
   returning pickles into v_balance;

  return query select true, v_amount, v_balance, 'Claimed'::text;
end;
$function$;

-- ── confirm_match(uuid) ──
CREATE OR REPLACE FUNCTION public.confirm_match(p_match_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_uid    uuid := auth.uid();
  v_match  record;
  v_team   text;
  v_both   boolean := false;
  v_god    boolean;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  select * into v_match from public.matches where id = p_match_id;
  if v_match.id is null then raise exception 'Match not found'; end if;
  if v_match.status <> 'pending' then
    raise exception 'Match is no longer pending';
  end if;
  if v_match.confirm_deadline is not null and v_match.confirm_deadline < now() then
    raise exception 'Confirmation window has expired';
  end if;

  v_god := public.is_godmode_user();

  -- Godmode: fill both team slots in one shot, status flips to completed.
  if v_god then
    update public.matches
       set team1_confirmed_by = coalesce(team1_confirmed_by, v_uid),
           team2_confirmed_by = coalesce(team2_confirmed_by, v_uid),
           status             = 'completed'
     where id = p_match_id;
    return 'completed';
  end if;

  -- Non-godmode: must be on the match
  if    v_uid in (v_match.player1_id, v_match.partner1_id) then v_team := 'team1';
  elsif v_uid in (v_match.player2_id, v_match.partner2_id) then v_team := 'team2';
  else  raise exception 'Only players on this match can confirm it';
  end if;

  if v_team = 'team1' then
    update public.matches set team1_confirmed_by = v_uid where id = p_match_id;
  else
    update public.matches set team2_confirmed_by = v_uid where id = p_match_id;
  end if;

  select (team1_confirmed_by is not null and team2_confirmed_by is not null)
    into v_both from public.matches where id = p_match_id;
  if v_both then
    update public.matches set status = 'completed' where id = p_match_id;
    return 'completed';
  end if;
  return 'one_team_confirmed';
end;
$function$;

-- ── create_mlp_team(uuid,text) ──
CREATE OR REPLACE FUNCTION public.create_mlp_team(p_tournament_id uuid, p_name text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_uid       uuid := auth.uid();
  v_format    text;
  v_team_id   uuid;
  v_existing  uuid;
  v_gender    text;
  v_male1     uuid := null;
  v_male2     uuid := null;
  v_female1   uuid := null;
  v_female2   uuid := null;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if length(coalesce(trim(p_name), '')) = 0 then raise exception 'Team name required'; end if;

  select format into v_format from public.tournaments where id = p_tournament_id;
  if v_format is null then raise exception 'Tournament not found'; end if;
  if v_format <> 'mlp' then raise exception 'Only MLP Fixed Teams tournaments accept self-formed teams'; end if;

  if not exists (
    select 1 from public.tournament_registrations
     where tournament_id = p_tournament_id and user_id = v_uid and status = 'approved'
  ) then
    raise exception 'You must be approved into this tournament before creating a team';
  end if;

  select id into v_existing from public.mlp_teams
   where tournament_id = p_tournament_id
     and v_uid in (captain_id, male_1_id, male_2_id, female_1_id, female_2_id)
   limit 1;
  if v_existing is not null then
    raise exception 'You''re already on a team in this tournament';
  end if;

  -- Captain auto-slots based on their gender (male/other -> male_1, female -> female_1).
  select gender into v_gender from public.profiles where id = v_uid;
  if v_gender is null or v_gender = 'prefer-not-to-say' then
    raise exception 'Set your gender (male/female/other) on your profile before creating a team';
  end if;

  if v_gender = 'female' then v_female1 := v_uid;
  else                        v_male1   := v_uid;
  end if;

  insert into public.mlp_teams (
    tournament_id, name, captain_id, male_1_id, male_2_id, female_1_id, female_2_id
  ) values (
    p_tournament_id, trim(p_name), v_uid, v_male1, v_male2, v_female1, v_female2
  ) returning id into v_team_id;

  return v_team_id;
end;
$function$;

-- ── generate_mlp_playoff(uuid) ──
CREATE OR REPLACE FUNCTION public.generate_mlp_playoff(p_tournament_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if not public._is_tournament_admin(p_tournament_id, v_uid) then
    raise exception 'Only tournament admins can advance to playoffs';
  end if;
  return public._generate_mlp_playoff_unchecked(p_tournament_id);
end;
$function$;

-- ── generate_playoff_bracket(uuid) ──
CREATE OR REPLACE FUNCTION public.generate_playoff_bracket(p_tournament_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_format         text;
  v_match_type     text;
  v_playoff        text;
  v_playoff_n      integer;
  v_uncompleted    integer;
  v_round_id       uuid;
  v_round_type     text;
  v_round_label    text;
  v_match_order    integer := 0;
  v_matches        integer := 0;
  v_i              integer;
  v_seeds          uuid[][];
  v_pool_count     integer;
  v_bracket_size   integer;
  v_per_pool_n     integer;
  v_pairings       integer[][];
  v_padded_size    integer;
begin
  select format, match_type, coalesce(playoff_format, 'none')
    into v_format, v_match_type, v_playoff
    from public.tournaments where id = p_tournament_id;

  if v_format is null then raise exception 'Tournament % not found', p_tournament_id; end if;
  if v_playoff = 'none' then raise exception 'Tournament has no playoff configured (playoff_format=none)'; end if;
  if v_format not in ('round_robin', 'pool_play') then
    raise exception 'Playoff generation supported for round_robin / pool_play only, not %', v_format;
  end if;

  if v_playoff in ('top_1_per_pool', 'top_2_per_pool') and v_format <> 'pool_play' then
    raise exception 'Playoff format % requires format=pool_play, not %', v_playoff, v_format;
  end if;

  v_per_pool_n := case v_playoff
    when 'top_1_per_pool' then 1
    when 'top_2_per_pool' then 2
    else null
  end;

  if exists (
    select 1 from public.tournament_rounds
     where tournament_id = p_tournament_id
       and round_type in ('quarterfinals','semifinals','finals','third_place_match')
  ) then
    raise exception 'Playoff already generated.';
  end if;

  select count(*) into v_uncompleted
    from public.tournament_matches tm
    join public.tournament_rounds tr on tr.id = tm.round_id
   where tm.tournament_id = p_tournament_id
     and tr.round_type not in ('quarterfinals','semifinals','finals','third_place_match','consolation','losers')
     and tm.status <> 'completed';
  if v_uncompleted > 0 then
    raise exception 'Cannot advance — % group-play matches still pending', v_uncompleted;
  end if;

  if v_per_pool_n is not null then
    select count(distinct upper(substring(tr.label from 'Pool ([A-Z])')))::int
      into v_pool_count
      from public.tournament_rounds tr
     where tr.tournament_id = p_tournament_id and tr.label ~ '^Pool [A-Z]';
    if v_pool_count is null or v_pool_count < 2 then
      raise exception 'top_N_per_pool requires at least 2 labelled pool rounds (found %)', coalesce(v_pool_count, 0);
    end if;

    v_bracket_size := v_pool_count * v_per_pool_n;
    if v_bracket_size not in (2, 4, 6, 8) then
      raise exception
        'top_%_per_pool with % pools yields % entrants — supported sizes are 2/4/6/8. Pick top_2/top_4/top_8 instead.',
        v_per_pool_n, v_pool_count, v_bracket_size;
    end if;

    with pool_matches as (
      select tm.*, upper(substring(tr.label from 'Pool ([A-Z])')) as pool_letter
        from public.tournament_matches tm
        join public.tournament_rounds tr on tr.id = tm.round_id
       where tm.tournament_id = p_tournament_id
         and tm.status = 'completed'
         and tr.label ~ '^Pool [A-Z]'
    ),
    raw as (
      select pool_letter,
             least(team1_player1, coalesce(team1_player2, team1_player1))    as lo,
             greatest(team1_player1, coalesce(team1_player2, team1_player1)) as hi,
             coalesce(team1_score, 0) as pf,
             coalesce(team2_score, 0) as pa,
             case when winner_team = 'team1' then 1 else 0 end as wins,
             case when winner_team = 'team2' then 1 else 0 end as losses
        from pool_matches
      union all
      select pool_letter,
             least(team2_player1, coalesce(team2_player2, team2_player1)),
             greatest(team2_player1, coalesce(team2_player2, team2_player1)),
             coalesce(team2_score, 0), coalesce(team1_score, 0),
             case when winner_team = 'team2' then 1 else 0 end,
             case when winner_team = 'team1' then 1 else 0 end
        from pool_matches
    ),
    agg as (
      select pool_letter, lo, hi,
             sum(wins)::int as wins, sum(losses)::int as losses,
             sum(pf)::int - sum(pa)::int as point_diff
        from raw group by pool_letter, lo, hi
    ),
    with_seed as (
      select a.pool_letter, a.lo, a.hi, a.wins, a.losses, a.point_diff,
             coalesce((
               select min(tr.seed) from public.tournament_registrations tr
                where tr.tournament_id = p_tournament_id and tr.user_id in (a.lo, a.hi)
             ), 999) as seed
        from agg a
    ),
    pre as (
      select pool_letter, lo, hi, wins, losses, point_diff, seed,
             row_number() over (partition by pool_letter order by wins desc, point_diff desc, seed asc) as rn
        from with_seed
    ),
    wins_pairs as (
      select pool_letter, wins from with_seed group by pool_letter, wins having count(*) = 2
    ),
    pool_ranked_pairs as (
      select p.*, row_number() over (partition by p.pool_letter, p.wins order by p.rn) as rn_within
        from pre p
    ),
    ties_2 as (
      select w.pool_letter, w.wins, e1.lo as lo1, e1.hi as hi1, e2.lo as lo2, e2.hi as hi2
        from wins_pairs w
        join pool_ranked_pairs e1 on e1.pool_letter = w.pool_letter and e1.wins = w.wins and e1.rn_within = 1
        join pool_ranked_pairs e2 on e2.pool_letter = w.pool_letter and e2.wins = w.wins and e2.rn_within = 2
    ),
    h2h as (
      select t.pool_letter, t.wins, t.lo1, t.hi1, t.lo2, t.hi2,
             coalesce(sum(case
               when (
                 (least(pm.team1_player1, coalesce(pm.team1_player2, pm.team1_player1)) = t.lo1
                  and greatest(pm.team1_player1, coalesce(pm.team1_player2, pm.team1_player1)) = t.hi1
                  and least(pm.team2_player1, coalesce(pm.team2_player2, pm.team2_player1)) = t.lo2
                  and greatest(pm.team2_player1, coalesce(pm.team2_player2, pm.team2_player1)) = t.hi2
                  and pm.winner_team = 'team1')
                 or
                 (least(pm.team2_player1, coalesce(pm.team2_player2, pm.team2_player1)) = t.lo1
                  and greatest(pm.team2_player1, coalesce(pm.team2_player2, pm.team2_player1)) = t.hi1
                  and least(pm.team1_player1, coalesce(pm.team1_player2, pm.team1_player1)) = t.lo2
                  and greatest(pm.team1_player1, coalesce(pm.team1_player2, pm.team1_player1)) = t.hi2
                  and pm.winner_team = 'team2')
               ) then 1 else 0 end)::int, 0) as h2h_wins_1,
             coalesce(sum(case
               when (
                 (least(pm.team1_player1, coalesce(pm.team1_player2, pm.team1_player1)) = t.lo2
                  and greatest(pm.team1_player1, coalesce(pm.team1_player2, pm.team1_player1)) = t.hi2
                  and least(pm.team2_player1, coalesce(pm.team2_player2, pm.team2_player1)) = t.lo1
                  and greatest(pm.team2_player1, coalesce(pm.team2_player2, pm.team2_player1)) = t.hi1
                  and pm.winner_team = 'team1')
                 or
                 (least(pm.team2_player1, coalesce(pm.team2_player2, pm.team2_player1)) = t.lo2
                  and greatest(pm.team2_player1, coalesce(pm.team2_player2, pm.team2_player1)) = t.hi2
                  and least(pm.team1_player1, coalesce(pm.team1_player2, pm.team1_player1)) = t.lo1
                  and greatest(pm.team1_player1, coalesce(pm.team1_player2, pm.team1_player1)) = t.hi1
                  and pm.winner_team = 'team2')
               ) then 1 else 0 end)::int, 0) as h2h_wins_2
        from ties_2 t left join pool_matches pm on pm.pool_letter = t.pool_letter
       group by t.pool_letter, t.wins, t.lo1, t.hi1, t.lo2, t.hi2
    ),
    h2h_per_entrant as (
      select p.pool_letter, p.lo, p.hi, p.wins, p.point_diff, p.seed,
             coalesce(case
               when h.h2h_wins_1 = h.h2h_wins_2 then 0
               when (p.lo = h.lo1 and p.hi = h.hi1) then
                 case when h.h2h_wins_1 > h.h2h_wins_2 then 1 else -1 end
               when (p.lo = h.lo2 and p.hi = h.hi2) then
                 case when h.h2h_wins_2 > h.h2h_wins_1 then 1 else -1 end
               else 0 end, 0) as h2h_score
        from pre p
        left join h2h h on h.pool_letter = p.pool_letter and h.wins = p.wins
                       and ((p.lo = h.lo1 and p.hi = h.hi1) or (p.lo = h.lo2 and p.hi = h.hi2))
    ),
    pool_ranked as (
      select pool_letter, lo, hi,
             row_number() over (partition by pool_letter order by wins desc, h2h_score desc, point_diff desc, seed asc) as pool_rank
        from h2h_per_entrant
    )
    select array_agg(array[lo, coalesce(hi, lo)] order by pool_rank, ascii(pool_letter))
      into v_seeds from pool_ranked where pool_rank <= v_per_pool_n;

    if v_seeds is null or array_length(v_seeds, 1) < v_bracket_size then
      raise exception
        'Not enough entrants in pool standings to seed top % per pool across % pools (need %, got %)',
        v_per_pool_n, v_pool_count, v_bracket_size, coalesce(array_length(v_seeds, 1), 0);
    end if;

    if v_bracket_size = 2 then
      v_pairings := array[ array[1, 2] ]; v_padded_size := 2;
    elsif v_bracket_size = 4 and v_pool_count = 2 then
      v_pairings := array[ array[1, 4], array[2, 3] ]; v_padded_size := 4;
    elsif v_bracket_size = 4 and v_pool_count = 4 then
      v_pairings := array[ array[1, 4], array[2, 3] ]; v_padded_size := 4;
    elsif v_bracket_size = 6 and v_pool_count = 3 then
      -- P=3, N=2: snake [A1, B1, C1, A2, B2, C2]. Apply doc §3 slot-5/slot-6
      -- swap to avoid C1 vs C2 round 1: pairs are 3v5 (C1 vs B2) and 4v6
      -- (A2 vs C2). Match orders: 0=A1-BYE, 1=B1-BYE, 2=C1 vs B2, 3=A2 vs C2.
      v_pairings := array[ array[1, 0], array[2, 0], array[3, 5], array[4, 6] ]; v_padded_size := 8;
    elsif v_bracket_size = 6 and v_pool_count = 6 then
      -- P=6, N=1: snake [A1..F1]. No same-pool conflicts.
      v_pairings := array[ array[1, 0], array[2, 0], array[3, 6], array[4, 5] ]; v_padded_size := 8;
    elsif v_bracket_size = 8 and v_pool_count = 4 then
      v_pairings := array[ array[1, 8], array[4, 6], array[2, 7], array[3, 5] ]; v_padded_size := 8;
    elsif v_bracket_size = 8 and v_pool_count = 2 then
      v_pairings := array[ array[1, 8], array[4, 5], array[2, 7], array[3, 6] ]; v_padded_size := 8;
    else
      raise exception 'Unsupported top_N_per_pool bracket shape (pools=%, N=%)', v_pool_count, v_per_pool_n;
    end if;

    v_round_label := case v_padded_size when 8 then 'Quarterfinals' when 4 then 'Semifinals' when 2 then 'Finals' end;
    v_round_type  := case v_padded_size when 8 then 'quarterfinals' when 4 then 'semifinals' when 2 then 'finals' end;

    insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
      values (p_tournament_id, 1000, v_round_label, v_round_type)
      returning id into v_round_id;

    -- Two-pass insert to keep the trigger from prematurely advancing. See
    -- comments in the migration source.
    declare
      v_a1 uuid; v_a2 uuid; v_b1 uuid; v_b2 uuid;
      v_pass integer;
      v_is_bye boolean;
    begin
      for v_pass in 1..2 loop
        for v_i in 1..array_length(v_pairings, 1) loop
          v_is_bye := v_pairings[v_i][2] = 0;
          continue when (v_pass = 1 and v_is_bye) or (v_pass = 2 and not v_is_bye);

          v_a1 := v_seeds[v_pairings[v_i][1]][1];
          v_a2 := v_seeds[v_pairings[v_i][1]][2];

          if v_is_bye then
            insert into public.tournament_matches (
              tournament_id, round_id, match_order, match_type,
              team1_player1, team1_player2, team2_player1, team2_player2,
              status, winner_team
            )
            values (
              p_tournament_id, v_round_id, v_i - 1,
              'bye',
              v_a1,
              case when v_match_type = 'doubles' and v_a1 <> v_a2 then v_a2 else null end,
              null, null,
              'completed', 'team1'
            );
          else
            v_b1 := v_seeds[v_pairings[v_i][2]][1];
            v_b2 := v_seeds[v_pairings[v_i][2]][2];
            insert into public.tournament_matches (
              tournament_id, round_id, match_order, match_type,
              team1_player1, team1_player2, team2_player1, team2_player2,
              status
            )
            values (
              p_tournament_id, v_round_id, v_i - 1,
              case when v_match_type = 'doubles' then 'doubles' else 'singles' end,
              v_a1,
              case when v_match_type = 'doubles' and v_a1 <> v_a2 then v_a2 else null end,
              v_b1,
              case when v_match_type = 'doubles' and v_b1 <> v_b2 then v_b2 else null end,
              'pending'
            );
          end if;
          v_matches := v_matches + 1;
        end loop;
      end loop;
    end;

    return v_matches;
  end if;

  v_playoff_n := case v_playoff when 'top_2' then 2 when 'top_4' then 4 when 'top_8' then 8 else null end;
  if v_playoff_n is null then raise exception 'Unknown playoff_format %', v_playoff; end if;

  with raw as (
    select
      least(team1_player1, coalesce(team1_player2, team1_player1))             as lo,
      greatest(team1_player1, coalesce(team1_player2, team1_player1))          as hi,
      coalesce(team1_score, 0) as pf, coalesce(team2_score, 0) as pa,
      case when winner_team = 'team1' then 1 else 0 end as wins,
      case when winner_team = 'team2' then 1 else 0 end as losses
    from public.tournament_matches
    where tournament_id = p_tournament_id and status = 'completed'
    union all
    select
      least(team2_player1, coalesce(team2_player2, team2_player1)),
      greatest(team2_player1, coalesce(team2_player2, team2_player1)),
      coalesce(team2_score, 0), coalesce(team1_score, 0),
      case when winner_team = 'team2' then 1 else 0 end,
      case when winner_team = 'team1' then 1 else 0 end
    from public.tournament_matches
    where tournament_id = p_tournament_id and status = 'completed'
  ),
  agg as (
    select lo, hi, sum(wins)::int as wins, sum(losses)::int as losses,
           sum(pf)::int - sum(pa)::int as point_diff
      from raw group by lo, hi
  ),
  with_seed as (
    select a.lo, a.hi, a.wins, a.losses, a.point_diff,
           coalesce((select min(tr.seed) from public.tournament_registrations tr
                      where tr.tournament_id = p_tournament_id and tr.user_id in (a.lo, a.hi)), 999) as seed
      from agg a
  ),
  pre as (
    select lo, hi, wins, losses, point_diff, seed,
           row_number() over (order by wins desc, point_diff desc, seed asc) as rn
      from with_seed
  ),
  wins_pairs as (select wins from with_seed group by wins having count(*) = 2),
  ranked_pairs as (
    select p.*, row_number() over (partition by p.wins order by p.rn) as rn_within from pre p
  ),
  ties_2 as (
    select w.wins, e1.lo as lo1, e1.hi as hi1, e2.lo as lo2, e2.hi as hi2
      from wins_pairs w
      join ranked_pairs e1 on e1.wins = w.wins and e1.rn_within = 1
      join ranked_pairs e2 on e2.wins = w.wins and e2.rn_within = 2
  ),
  h2h as (
    select t.wins, t.lo1, t.hi1, t.lo2, t.hi2,
           coalesce(sum(case
             when (
               (least(m.team1_player1, coalesce(m.team1_player2, m.team1_player1)) = t.lo1
                and greatest(m.team1_player1, coalesce(m.team1_player2, m.team1_player1)) = t.hi1
                and least(m.team2_player1, coalesce(m.team2_player2, m.team2_player1)) = t.lo2
                and greatest(m.team2_player1, coalesce(m.team2_player2, m.team2_player1)) = t.hi2
                and m.winner_team = 'team1')
               or
               (least(m.team2_player1, coalesce(m.team2_player2, m.team2_player1)) = t.lo1
                and greatest(m.team2_player1, coalesce(m.team2_player2, m.team2_player1)) = t.hi1
                and least(m.team1_player1, coalesce(m.team1_player2, m.team1_player1)) = t.lo2
                and greatest(m.team1_player1, coalesce(m.team1_player2, m.team1_player1)) = t.hi2
                and m.winner_team = 'team2')
             ) then 1 else 0 end)::int, 0) as h2h_wins_1,
           coalesce(sum(case
             when (
               (least(m.team1_player1, coalesce(m.team1_player2, m.team1_player1)) = t.lo2
                and greatest(m.team1_player1, coalesce(m.team1_player2, m.team1_player1)) = t.hi2
                and least(m.team2_player1, coalesce(m.team2_player2, m.team2_player1)) = t.lo1
                and greatest(m.team2_player1, coalesce(m.team2_player2, m.team2_player1)) = t.hi1
                and m.winner_team = 'team1')
               or
               (least(m.team2_player1, coalesce(m.team2_player2, m.team2_player1)) = t.lo2
                and greatest(m.team2_player1, coalesce(m.team2_player2, m.team2_player1)) = t.hi2
                and least(m.team1_player1, coalesce(m.team1_player2, m.team1_player1)) = t.lo1
                and greatest(m.team1_player1, coalesce(m.team1_player2, m.team1_player1)) = t.hi1
                and m.winner_team = 'team2')
             ) then 1 else 0 end)::int, 0) as h2h_wins_2
      from ties_2 t left join public.tournament_matches m
        on m.tournament_id = p_tournament_id and m.status = 'completed'
     group by t.wins, t.lo1, t.hi1, t.lo2, t.hi2
  ),
  h2h_per_entrant as (
    select p.lo, p.hi, p.wins, p.point_diff, p.seed,
           coalesce(case
             when h.h2h_wins_1 = h.h2h_wins_2 then 0
             when (p.lo = h.lo1 and p.hi = h.hi1) then
               case when h.h2h_wins_1 > h.h2h_wins_2 then 1 else -1 end
             when (p.lo = h.lo2 and p.hi = h.hi2) then
               case when h.h2h_wins_2 > h.h2h_wins_1 then 1 else -1 end
             else 0 end, 0) as h2h_score
      from pre p
      left join h2h h on h.wins = p.wins
                     and ((p.lo = h.lo1 and p.hi = h.hi1) or (p.lo = h.lo2 and p.hi = h.hi2))
  ),
  ranked as (
    select lo, hi,
           row_number() over (order by wins desc, h2h_score desc, point_diff desc, seed asc) as rn
      from h2h_per_entrant
  )
  select array_agg(array[lo, coalesce(hi, lo)] order by rn)
    into v_seeds from ranked where rn <= greatest(v_playoff_n, 4);

  if v_seeds is null or array_length(v_seeds, 1) < v_playoff_n then
    raise exception 'Not enough entrants in standings to seed Top % (got %)',
      v_playoff_n, coalesce(array_length(v_seeds, 1), 0);
  end if;

  v_round_label := case v_playoff_n
    when 8 then 'Quarterfinals' when 4 then 'Semifinals' when 2 then 'Finals'
    else format('Playoff Round of %s', v_playoff_n) end;
  v_round_type := case v_playoff_n
    when 8 then 'quarterfinals' when 4 then 'semifinals' when 2 then 'finals'
    else 'winners' end;

  insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
    values (p_tournament_id, 1000, v_round_label, v_round_type)
    returning id into v_round_id;

  declare
    v_a1 uuid; v_a2 uuid; v_b1 uuid; v_b2 uuid;
  begin
    for v_i in 0..(v_playoff_n / 2 - 1) loop
      v_a1 := v_seeds[v_i + 1][1];
      v_a2 := v_seeds[v_i + 1][2];
      v_b1 := v_seeds[v_playoff_n - v_i][1];
      v_b2 := v_seeds[v_playoff_n - v_i][2];

      insert into public.tournament_matches (
        tournament_id, round_id, match_order, match_type,
        team1_player1, team1_player2, team2_player1, team2_player2, status
      )
      values (
        p_tournament_id, v_round_id, v_match_order,
        case when v_match_type = 'doubles' then 'doubles' else 'singles' end,
        v_a1,
        case when v_match_type = 'doubles' and v_a1 <> v_a2 then v_a2 else null end,
        v_b1,
        case when v_match_type = 'doubles' and v_b1 <> v_b2 then v_b2 else null end,
        'pending'
      );
      v_match_order := v_match_order + 1;
      v_matches := v_matches + 1;
    end loop;

    if v_playoff_n = 2 and array_length(v_seeds, 1) >= 4 then
      insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
        values (p_tournament_id, 1100, 'Third Place Match', 'third_place_match')
        returning id into v_round_id;

      v_a1 := v_seeds[3][1]; v_a2 := v_seeds[3][2];
      v_b1 := v_seeds[4][1]; v_b2 := v_seeds[4][2];
      insert into public.tournament_matches (
        tournament_id, round_id, match_order, match_type,
        team1_player1, team1_player2, team2_player1, team2_player2, status
      )
      values (
        p_tournament_id, v_round_id, 0,
        case when v_match_type = 'doubles' then 'doubles' else 'singles' end,
        v_a1,
        case when v_match_type = 'doubles' and v_a1 <> v_a2 then v_a2 else null end,
        v_b1,
        case when v_match_type = 'doubles' and v_b1 <> v_b2 then v_b2 else null end,
        'pending'
      );
      v_matches := v_matches + 1;
    end if;
  end;

  return v_matches;
end;
$function$;

-- ── get_my_wagers_with_details() ──
CREATE OR REPLACE FUNCTION public.get_my_wagers_with_details()
 RETURNS TABLE(id uuid, user_id uuid, subject_type text, subject_id uuid, predicate jsonb, stake integer, odds numeric, potential_payout integer, status text, placed_at timestamp with time zone, settled_at timestamp with time zone, predicted_user_name text, predicted_rank integer, scope_name text, actual_rank integer, actual_winner_team text, actual_team1_score integer, actual_team2_score integer, team_label_a text, team_label_b text, expected_end_at timestamp with time zone, league_name text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Not authenticated'; end if;

  return query
  select
    w.id, w.user_id, w.subject_type, w.subject_id, w.predicate,
    w.stake, w.odds, w.potential_payout, w.status, w.placed_at, w.settled_at,
    case when w.predicate ? 'user_id'
         then (select coalesce(p.full_name, p.username, w.predicate->>'user_id')
                 from profiles p where p.id = (w.predicate->>'user_id')::uuid)
    end as predicted_user_name,
    case when w.predicate ? 'rank'
         then (w.predicate->>'rank')::int end as predicted_rank,
    case w.subject_type
      when 'tournament_rank' then (select t.name from tournaments t where t.id = w.subject_id)
      when 'tournament_match' then (select t.name from tournaments t
        join tournament_matches tm on tm.tournament_id = t.id where tm.id = w.subject_id)
      when 'tournament_match_score' then (select t.name from tournaments t
        join tournament_matches tm on tm.tournament_id = t.id where tm.id = w.subject_id)
      when 'period_rank' then (select coalesce(ls.name, l.name || ' season')
        from league_seasons ls join leagues l on l.id = ls.league_id where ls.id = w.subject_id)
      when 'season_rank' then (select coalesce(ls.name, l.name || ' season')
        from league_seasons ls join leagues l on l.id = ls.league_id where ls.id = w.subject_id)
      when 'match' then (select l.name from leagues l
        join matches m on m.league_id = l.id where m.id = w.subject_id)
      when 'match_score' then (select l.name from leagues l
        join matches m on m.league_id = l.id where m.id = w.subject_id)
    end as scope_name,
    case
      when w.status = 'open' or w.status = 'cancelled' then null
      when w.subject_type = 'period_rank' then (
        select ss.rank_at_snapshot from season_snapshots ss
         where ss.season_id     = w.subject_id
           and ss.user_id       = (w.predicate->>'user_id')::uuid
           and ss.period_number = (w.predicate->>'period_number')::int
         limit 1)
      when w.subject_type = 'season_rank' then (
        select sfs.final_rank from season_final_standings sfs
         where sfs.season_id = w.subject_id
           and sfs.user_id   = (w.predicate->>'user_id')::uuid
         limit 1)
      when w.subject_type = 'tournament_rank' then (
        case when exists (
          select 1 from tournament_champion_badges tcb
           where tcb.tournament_id = w.subject_id
             and tcb.user_id       = (w.predicate->>'user_id')::uuid)
        then 1 else null end)
    end as actual_rank,
    case w.subject_type
      when 'match' then (select m.winner_team from matches m where m.id = w.subject_id)
      when 'match_score' then (select m.winner_team from matches m where m.id = w.subject_id)
      when 'tournament_match' then (select tm.winner_team from tournament_matches tm where tm.id = w.subject_id)
      when 'tournament_match_score' then (select tm.winner_team from tournament_matches tm where tm.id = w.subject_id)
    end as actual_winner_team,
    case w.subject_type
      when 'match' then (select m.player1_score from matches m where m.id = w.subject_id)
      when 'match_score' then (select m.player1_score from matches m where m.id = w.subject_id)
      when 'tournament_match' then (select tm.team1_score from tournament_matches tm where tm.id = w.subject_id)
      when 'tournament_match_score' then (select tm.team1_score from tournament_matches tm where tm.id = w.subject_id)
    end as actual_team1_score,
    case w.subject_type
      when 'match' then (select m.player2_score from matches m where m.id = w.subject_id)
      when 'match_score' then (select m.player2_score from matches m where m.id = w.subject_id)
      when 'tournament_match' then (select tm.team2_score from tournament_matches tm where tm.id = w.subject_id)
      when 'tournament_match_score' then (select tm.team2_score from tournament_matches tm where tm.id = w.subject_id)
    end as actual_team2_score,
    case w.subject_type
      when 'match' then (select coalesce(p1.full_name, p1.username, '?') ||
                          case when m.partner1_id is not null
                            then ' & ' || coalesce(p1b.full_name, p1b.username, '?') else '' end
        from matches m
        left join profiles p1  on p1.id  = m.player1_id
        left join profiles p1b on p1b.id = m.partner1_id
        where m.id = w.subject_id)
      when 'match_score' then (select coalesce(p1.full_name, p1.username, '?') ||
                          case when m.partner1_id is not null
                            then ' & ' || coalesce(p1b.full_name, p1b.username, '?') else '' end
        from matches m
        left join profiles p1  on p1.id  = m.player1_id
        left join profiles p1b on p1b.id = m.partner1_id
        where m.id = w.subject_id)
      when 'tournament_match' then (select coalesce(tp1.full_name, tp1.username, '?') ||
                          case when tm.team1_player2 is not null
                            then ' & ' || coalesce(tp1b.full_name, tp1b.username, '?') else '' end
        from tournament_matches tm
        left join profiles tp1  on tp1.id  = tm.team1_player1
        left join profiles tp1b on tp1b.id = tm.team1_player2
        where tm.id = w.subject_id)
      when 'tournament_match_score' then (select coalesce(tp1.full_name, tp1.username, '?') ||
                          case when tm.team1_player2 is not null
                            then ' & ' || coalesce(tp1b.full_name, tp1b.username, '?') else '' end
        from tournament_matches tm
        left join profiles tp1  on tp1.id  = tm.team1_player1
        left join profiles tp1b on tp1b.id = tm.team1_player2
        where tm.id = w.subject_id)
    end as team_label_a,
    case w.subject_type
      when 'match' then (select coalesce(p2.full_name, p2.username, '?') ||
                          case when m.partner2_id is not null
                            then ' & ' || coalesce(p2b.full_name, p2b.username, '?') else '' end
        from matches m
        left join profiles p2  on p2.id  = m.player2_id
        left join profiles p2b on p2b.id = m.partner2_id
        where m.id = w.subject_id)
      when 'match_score' then (select coalesce(p2.full_name, p2.username, '?') ||
                          case when m.partner2_id is not null
                            then ' & ' || coalesce(p2b.full_name, p2b.username, '?') else '' end
        from matches m
        left join profiles p2  on p2.id  = m.player2_id
        left join profiles p2b on p2b.id = m.partner2_id
        where m.id = w.subject_id)
      when 'tournament_match' then (select coalesce(tp2.full_name, tp2.username, '?') ||
                          case when tm.team2_player2 is not null
                            then ' & ' || coalesce(tp2b.full_name, tp2b.username, '?') else '' end
        from tournament_matches tm
        left join profiles tp2  on tp2.id  = tm.team2_player1
        left join profiles tp2b on tp2b.id = tm.team2_player2
        where tm.id = w.subject_id)
      when 'tournament_match_score' then (select coalesce(tp2.full_name, tp2.username, '?') ||
                          case when tm.team2_player2 is not null
                            then ' & ' || coalesce(tp2b.full_name, tp2b.username, '?') else '' end
        from tournament_matches tm
        left join profiles tp2  on tp2.id  = tm.team2_player1
        left join profiles tp2b on tp2b.id = tm.team2_player2
        where tm.id = w.subject_id)
    end as team_label_b,
    -- expected_end_at: when the wagered-on thing resolves / ends.
    case w.subject_type
      when 'tournament_rank' then (select case when t.start_time is null then null
                                          else t.start_time + (coalesce(t.expected_length_hours, 0) * interval '1 hour') end
        from tournaments t where t.id = w.subject_id)
      when 'season_rank' then (select ls.end_date::timestamptz
        from league_seasons ls where ls.id = w.subject_id)
      when 'period_rank' then (select (ls.start_date
          + (coalesce((w.predicate->>'period_number')::int, 0) * ls.lock_frequency_weeks) * interval '1 week')::timestamptz
        from league_seasons ls where ls.id = w.subject_id)
      when 'match' then (select m.scheduled_at from matches m where m.id = w.subject_id)
      when 'match_score' then (select m.scheduled_at from matches m where m.id = w.subject_id)
      when 'tournament_match' then (select tm.scheduled_at from tournament_matches tm where tm.id = w.subject_id)
      when 'tournament_match_score' then (select tm.scheduled_at from tournament_matches tm where tm.id = w.subject_id)
    end as expected_end_at,
    -- league_name: the league the wager rolls up to (null for standalone tournaments).
    case w.subject_type
      when 'tournament_rank' then (select l.name from tournaments t
        left join leagues l on l.id = t.league_id where t.id = w.subject_id)
      when 'tournament_match' then (select l.name from tournament_matches tm
        join tournaments t on t.id = tm.tournament_id
        left join leagues l on l.id = t.league_id where tm.id = w.subject_id)
      when 'tournament_match_score' then (select l.name from tournament_matches tm
        join tournaments t on t.id = tm.tournament_id
        left join leagues l on l.id = t.league_id where tm.id = w.subject_id)
      when 'period_rank' then (select l.name from league_seasons ls
        join leagues l on l.id = ls.league_id where ls.id = w.subject_id)
      when 'season_rank' then (select l.name from league_seasons ls
        join leagues l on l.id = ls.league_id where ls.id = w.subject_id)
      when 'match' then (select l.name from matches m
        join leagues l on l.id = m.league_id where m.id = w.subject_id)
      when 'match_score' then (select l.name from matches m
        join leagues l on l.id = m.league_id where m.id = w.subject_id)
    end as league_name
  from wagers w
  where w.user_id = uid
  order by w.placed_at desc;
end;
$function$;

-- ── get_wagers_on_player(uuid,text,uuid) ──
CREATE OR REPLACE FUNCTION public.get_wagers_on_player(p_user_id uuid, p_scope_type text DEFAULT NULL::text, p_scope_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(wager_id uuid, bettor_id uuid, bettor_name text, stake integer, potential_payout integer, odds numeric, status text, rank integer, subject_type text, scope_name text, placed_at timestamp with time zone, expected_end_at timestamp with time zone, league_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    w.id,
    w.user_id,
    coalesce(p.full_name, 'Someone'),
    w.stake,
    w.potential_payout,
    w.odds,
    w.status,
    coalesce((w.predicate->>'rank')::int, 1),
    w.subject_type,
    case w.subject_type
      when 'tournament_rank' then (select t.name from public.tournaments t where t.id = w.subject_id)
      else (select coalesce(ls.name, l.name || ' season')
              from public.league_seasons ls
              join public.leagues l on l.id = ls.league_id
             where ls.id = w.subject_id)
    end,
    w.placed_at,
    case w.subject_type
      when 'tournament_rank' then (select case when t.start_time is null then null
                                          else t.start_time + (coalesce(t.expected_length_hours, 0) * interval '1 hour') end
        from public.tournaments t where t.id = w.subject_id)
      when 'season_rank' then (select ls.end_date::timestamptz
        from public.league_seasons ls where ls.id = w.subject_id)
      when 'period_rank' then (select (ls.start_date
          + (coalesce((w.predicate->>'period_number')::int, 0) * ls.lock_frequency_weeks) * interval '1 week')::timestamptz
        from public.league_seasons ls where ls.id = w.subject_id)
    end as expected_end_at,
    case w.subject_type
      when 'tournament_rank' then (select l.name from public.tournaments t
        left join public.leagues l on l.id = t.league_id where t.id = w.subject_id)
      else (select l.name from public.league_seasons ls
        join public.leagues l on l.id = ls.league_id where ls.id = w.subject_id)
    end as league_name
  from public.wagers w
  left join public.profiles p on p.id = w.user_id
  where w.subject_type in ('tournament_rank','period_rank','season_rank')
    and w.predicate->>'user_id' = p_user_id::text
    and w.status <> 'cancelled'
    and (
      p_scope_type is null
      or (p_scope_type = 'tournament'
          and w.subject_type = 'tournament_rank'
          and w.subject_id = p_scope_id)
      or (p_scope_type = 'season'
          and w.subject_type in ('period_rank','season_rank')
          and w.subject_id = p_scope_id)
      or (p_scope_type = 'league'
          and w.subject_type in ('period_rank','season_rank')
          and exists (select 1 from public.league_seasons ls
                       where ls.id = w.subject_id and ls.league_id = p_scope_id))
    )
  order by w.placed_at desc;
$function$;

-- ── godmode_force_accept_invitee(uuid,uuid) ──
CREATE OR REPLACE FUNCTION public.godmode_force_accept_invitee(p_code_id uuid, p_user_id uuid)
 RETURNS TABLE(success boolean, message text, scope_type text, scope_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid       uuid := auth.uid();
  v_code    invite_codes%rowtype;
begin
  if uid is null then raise exception 'Not authenticated'; end if;
  if uid not in ('252a36e1-5d89-4ad2-8a3e-b786579f019a') then
    raise exception 'Forbidden — godmode only';
  end if;

  select * into v_code from invite_codes where id = p_code_id for update;
  if v_code.id is null then
    return query select false, 'Code not found'::text, ''::text, null::uuid; return;
  end if;
  if not v_code.is_active then
    return query select false, 'Code revoked'::text, v_code.scope_type, v_code.scope_id; return;
  end if;
  if v_code.expires_at <= now() then
    return query select false, 'Code expired'::text, v_code.scope_type, v_code.scope_id; return;
  end if;

  if v_code.scope_type = 'league' then
    if exists (select 1 from league_members where league_id = v_code.scope_id and user_id = p_user_id) then
      return query select true, 'Already a member'::text, v_code.scope_type, v_code.scope_id; return;
    end if;
    insert into league_members (league_id, user_id, role, joined_at)
      values (v_code.scope_id, p_user_id, 'member', now());
    update invite_codes set used_count = used_count + 1 where id = v_code.id;
    return query select true, 'Joined league'::text, v_code.scope_type, v_code.scope_id; return;

  elsif v_code.scope_type = 'tournament' then
    insert into tournament_registrations (tournament_id, user_id, status, invited_by, redeemed_invite_code_id, registered_at)
      values (v_code.scope_id, p_user_id, 'approved', uid, v_code.id, now())
    on conflict (tournament_id, user_id) do update
      set status                  = 'approved',
          invited_by              = excluded.invited_by,
          redeemed_invite_code_id = excluded.redeemed_invite_code_id;
    update invite_codes set used_count = used_count + 1 where id = v_code.id;
    return query select true, 'Approved into tournament'::text, v_code.scope_type, v_code.scope_id; return;
  end if;

  return query select false, 'Unknown scope type'::text, v_code.scope_type, v_code.scope_id;
end;
$function$;

-- ── godmode_list_active_invites() ──
CREATE OR REPLACE FUNCTION public.godmode_list_active_invites()
 RETURNS TABLE(code_id uuid, scope_type text, scope_id uuid, scope_name text, token text, expires_at timestamp with time zone, used_count integer, max_uses integer, already_member boolean, pending_invitees jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Not authenticated'; end if;
  if uid not in ('252a36e1-5d89-4ad2-8a3e-b786579f019a') then
    raise exception 'Forbidden — godmode only';
  end if;

  return query
  -- League invites + invitee recipients (parsed from notifications, since
  -- league broadcasts only create notifications — no per-user pending row).
  select
    ic.id                                     as code_id,
    'league'                                  as scope_type,
    ic.scope_id                               as scope_id,
    l.name                                    as scope_name,
    ic.token                                  as token,
    ic.expires_at                             as expires_at,
    ic.used_count                             as used_count,
    ic.max_uses                               as max_uses,
    exists (select 1 from league_members lm where lm.league_id = ic.scope_id and lm.user_id = uid) as already_member,
    coalesce((
      select jsonb_agg(
        jsonb_build_object('user_id', s.user_id, 'user_name', s.user_name)
        order by s.user_name
      )
      from (
        select distinct n.user_id, coalesce(p.full_name, p.username, n.user_id::text) as user_name
        from notifications n
        join profiles p on p.id = n.user_id
        where n.entity_type = 'league'
          and n.entity_id   = ic.scope_id
          and position(ic.token in n.body) > 0
          and not exists (
            select 1 from league_members lm
             where lm.league_id = ic.scope_id and lm.user_id = n.user_id
          )
      ) s
    ), '[]'::jsonb) as pending_invitees
  from invite_codes ic
  join leagues l on l.id = ic.scope_id
  where ic.scope_type = 'league'
    and ic.is_active   = true
    and ic.expires_at  > now()
    and l.is_active    = true

  union all

  -- Tournament invites + invitee recipients (pending_registrations linked to
  -- this code id, plus any pre-existing pending row that hasn't been approved).
  select
    ic.id                                     as code_id,
    'tournament'                              as scope_type,
    ic.scope_id                               as scope_id,
    t.name                                    as scope_name,
    ic.token                                  as token,
    ic.expires_at                             as expires_at,
    ic.used_count                             as used_count,
    ic.max_uses                               as max_uses,
    exists (
      select 1 from tournament_registrations
       where tournament_id = ic.scope_id and user_id = uid and status = 'approved'
    ) as already_member,
    coalesce((
      select jsonb_agg(
        jsonb_build_object('user_id', s.user_id, 'user_name', s.user_name)
        order by s.user_name
      )
      from (
        select tr.user_id, coalesce(p.full_name, p.username, tr.user_id::text) as user_name
        from tournament_registrations tr
        join profiles p on p.id = tr.user_id
        where tr.tournament_id = ic.scope_id
          and tr.status = 'pending'
          and (tr.redeemed_invite_code_id = ic.id or tr.redeemed_invite_code_id is null)
      ) s
    ), '[]'::jsonb) as pending_invitees
  from invite_codes ic
  join tournaments t on t.id = ic.scope_id
  where ic.scope_type   = 'tournament'
    and ic.is_active    = true
    and ic.expires_at   > now()
    and t.status not in ('completed','cancelled')

  order by expires_at asc;
end;
$function$;

-- ── mlp_team_standings(uuid) ──
CREATE OR REPLACE FUNCTION public.mlp_team_standings(p_tournament_id uuid)
 RETURNS TABLE(team_id uuid, team_name text, seed integer, pool_letter text, sub_matches_won integer, sub_matches_lost integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_format     text;
  v_pool_count integer;
begin
  select coalesce(mlp_play_format, 'round_robin'),
         coalesce(mlp_pool_count, 2)
    into v_format, v_pool_count
    from public.tournaments where id = p_tournament_id;

  return query
  with team_pools as (
    select
      t.id,
      t.name,
      t.seed,
      case when v_format in ('pool_play', 'pool_play_playoff') then
        chr(65 + ((case
          when ((t.seed - 1) % (v_pool_count * 2)) < v_pool_count
            then ((t.seed - 1) % (v_pool_count * 2))
          else  (v_pool_count * 2 - 1) - ((t.seed - 1) % (v_pool_count * 2))
        end)))
      else null end as pool_letter,
      t.male_1_id, t.male_2_id, t.female_1_id, t.female_2_id
    from public.mlp_teams t
    where t.tournament_id = p_tournament_id and t.status = 'locked'
  ),
  match_wins as (
    select tp.id as team_id,
           sum(case when
             ((m.winner_team = 'team1' and (m.team1_player1 in (tp.male_1_id, tp.male_2_id, tp.female_1_id, tp.female_2_id)
                                            or m.team1_player2 in (tp.male_1_id, tp.male_2_id, tp.female_1_id, tp.female_2_id))) or
              (m.winner_team = 'team2' and (m.team2_player1 in (tp.male_1_id, tp.male_2_id, tp.female_1_id, tp.female_2_id)
                                            or m.team2_player2 in (tp.male_1_id, tp.male_2_id, tp.female_1_id, tp.female_2_id))))
             then 1 else 0 end)::int as wins,
           sum(case when
             ((m.winner_team = 'team2' and (m.team1_player1 in (tp.male_1_id, tp.male_2_id, tp.female_1_id, tp.female_2_id)
                                            or m.team1_player2 in (tp.male_1_id, tp.male_2_id, tp.female_1_id, tp.female_2_id))) or
              (m.winner_team = 'team1' and (m.team2_player1 in (tp.male_1_id, tp.male_2_id, tp.female_1_id, tp.female_2_id)
                                            or m.team2_player2 in (tp.male_1_id, tp.male_2_id, tp.female_1_id, tp.female_2_id))))
             then 1 else 0 end)::int as losses
      from team_pools tp
      left join public.tournament_matches m
        on m.tournament_id = p_tournament_id
       and m.status = 'completed'
       and (
         m.team1_player1 in (tp.male_1_id, tp.male_2_id, tp.female_1_id, tp.female_2_id) or
         m.team1_player2 in (tp.male_1_id, tp.male_2_id, tp.female_1_id, tp.female_2_id) or
         m.team2_player1 in (tp.male_1_id, tp.male_2_id, tp.female_1_id, tp.female_2_id) or
         m.team2_player2 in (tp.male_1_id, tp.male_2_id, tp.female_1_id, tp.female_2_id)
       )
     group by tp.id
  )
  select tp.id, tp.name, tp.seed, tp.pool_letter,
         coalesce(mw.wins, 0)   as sub_matches_won,
         coalesce(mw.losses, 0) as sub_matches_lost
    from team_pools tp
    left join match_wins mw on mw.team_id = tp.id
   order by coalesce(tp.pool_letter, ''),
            coalesce(mw.wins, 0) desc,
            coalesce(mw.losses, 0) asc,
            tp.seed;
end;
$function$;

-- ── place_wager(text,uuid,jsonb,integer) ──
CREATE OR REPLACE FUNCTION public.place_wager(p_subject_type text, p_subject_id uuid, p_predicate jsonb, p_stake integer)
 RETURNS TABLE(success boolean, wager_id uuid, odds numeric, potential_payout integer, balance integer, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid       uuid := auth.uid();
  v_balance   int;
  v_prob      numeric;
  v_odds      numeric;
  v_payout    int;
  v_new_id    uuid;
  v_new_bal   int;
  v_exists    boolean := false;
begin
  if v_uid is null then
    return query select false, null::uuid, null::numeric, null::int, null::int, 'Not signed in.';
    return;
  end if;

  if p_stake is null or p_stake <= 0 then
    return query select false, null::uuid, null::numeric, null::int, null::int, 'Stake must be a positive integer.';
    return;
  end if;

  if p_subject_type in ('match','match_score') then
    select exists(select 1 from public.matches where id = p_subject_id) into v_exists;
  elsif p_subject_type in ('tournament_match','tournament_match_score') then
    select exists(select 1 from public.tournament_matches where id = p_subject_id) into v_exists;
  elsif p_subject_type = 'tournament_rank' then
    select exists(select 1 from public.tournaments where id = p_subject_id) into v_exists;
  elsif p_subject_type in ('period_rank','season_rank') then
    select exists(select 1 from public.league_seasons where id = p_subject_id) into v_exists;
  else
    return query select false, null::uuid, null::numeric, null::int, null::int, 'Unknown subject type.';
    return;
  end if;

  if not v_exists then
    return query select false, null::uuid, null::numeric, null::int, null::int, 'Wager subject not found.';
    return;
  end if;

  if p_subject_type in ('match','tournament_match') then
    if (p_predicate->>'winner_team') not in ('team1','team2') then
      return query select false, null::uuid, null::numeric, null::int, null::int, 'Predicate must include winner_team (team1|team2).';
      return;
    end if;
  elsif p_subject_type in ('match_score','tournament_match_score') then
    if (p_predicate->>'team1_score') is null or (p_predicate->>'team2_score') is null then
      return query select false, null::uuid, null::numeric, null::int, null::int, 'Predicate must include team1_score and team2_score.';
      return;
    end if;
  elsif p_subject_type = 'tournament_rank' then
    if (p_predicate->>'user_id') is null then
      return query select false, null::uuid, null::numeric, null::int, null::int, 'Predicate must include user_id.';
      return;
    end if;
  elsif p_subject_type = 'period_rank' then
    if (p_predicate->>'user_id') is null or (p_predicate->>'period_number') is null then
      return query select false, null::uuid, null::numeric, null::int, null::int, 'Predicate must include user_id and period_number.';
      return;
    end if;
  elsif p_subject_type = 'season_rank' then
    if (p_predicate->>'user_id') is null then
      return query select false, null::uuid, null::numeric, null::int, null::int, 'Predicate must include user_id.';
      return;
    end if;
  end if;

  select pickles into v_balance from public.profiles where id = v_uid for update;
  if v_balance is null then
    return query select false, null::uuid, null::numeric, null::int, null::int, 'Profile not found.';
    return;
  end if;
  if v_balance < p_stake then
    return query select false, null::uuid, null::numeric, null::int, v_balance, format('Not enough pickles. Balance is %s.', v_balance);
    return;
  end if;

  -- Alias the function call so its `odds` column doesn't shadow the OUT param.
  select co.probability, co.odds into v_prob, v_odds
    from public.calculate_wager_odds(p_subject_type, p_subject_id, p_predicate) as co;

  if v_odds is null or v_odds < 1 then
    v_odds := 1.0;
  end if;
  v_payout := floor(p_stake * v_odds)::int;
  if v_payout < p_stake then v_payout := p_stake; end if;

  update public.profiles set pickles = pickles - p_stake
    where id = v_uid
    returning pickles into v_new_bal;

  insert into public.wagers (user_id, subject_type, subject_id, predicate, stake, odds, potential_payout)
    values (v_uid, p_subject_type, p_subject_id, p_predicate, p_stake, v_odds, v_payout)
    returning id into v_new_id;

  return query select true, v_new_id, v_odds, v_payout, v_new_bal, 'Wager placed.'::text;
end;
$function$;

-- ── purchase_shop_item(uuid) ──
CREATE OR REPLACE FUNCTION public.purchase_shop_item(p_item_id uuid)
 RETURNS TABLE(success boolean, new_balance integer, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_uid          uuid := auth.uid();
  v_cost         integer;
  v_category     text;
  v_payload      jsonb;
  v_slug         text;
  v_unlock_badge uuid;
  v_balance      integer;
begin
  if v_uid is null then
    return query select false, 0, 'Not authenticated';
    return;
  end if;

  select cost, category, payload, slug, unlock_badge_id
    into v_cost, v_category, v_payload, v_slug, v_unlock_badge
    from public.shop_items where id = p_item_id and is_active = true;

  if v_cost is null then
    return query select false, 0, 'Item not found';
    return;
  end if;

  if v_unlock_badge is not null then
    return query select false, 0, 'This item unlocks via badge progression, not purchase';
    return;
  end if;

  if v_category <> 'real_world' and exists (
    select 1 from public.player_shop_purchases
     where user_id = v_uid and shop_item_id = p_item_id
  ) then
    return query select false, 0, 'Already owned';
    return;
  end if;

  select pickles into v_balance from public.profiles where id = v_uid for update;
  if v_balance is null then v_balance := 0; end if;
  if v_balance < v_cost then
    return query select false, v_balance, 'Insufficient pickles';
    return;
  end if;

  update public.profiles set pickles = v_balance - v_cost where id = v_uid;
  insert into public.player_shop_purchases (user_id, shop_item_id, cost_paid)
    values (v_uid, p_item_id, v_cost);

  if v_category = 'avatar' then
    update public.profiles
       set avatar_emoji    = v_payload->>'emoji',
           avatar_bg_color = v_payload->>'bgColor'
     where id = v_uid;
  elsif v_category = 'flair' and v_payload->>'kind' = 'name_color' then
    update public.profiles set name_color = v_payload->>'value' where id = v_uid;
  elsif v_category = 'list_name_style' then
    update public.profiles set list_name_style_id = v_slug where id = v_uid;
  elsif v_category = 'profile_name_style' then
    update public.profiles set profile_name_style_id = v_slug where id = v_uid;
  end if;

  return query select true, v_balance - v_cost, 'Purchased';
end;
$function$;

-- ── recompute_all_plupr() ──
CREATE OR REPLACE FUNCTION public.recompute_all_plupr()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  PLUPR_BASE  constant decimal := 3.250;
  GLOBAL_WT   constant decimal := 0.5;
  rec         record;
  r1 decimal; r_p1 decimal; r2 decimal; r_p2 decimal;
  team1_avg   decimal; team2_avg decimal;
  expected_diff decimal;
  actual_diff   decimal;
  surprise      decimal;
  k_factor    decimal;
  s1          integer; s2 integer;
  delta1      decimal; delta2 decimal;
  won1        boolean;
  cat         text;
  match_idx   integer := 0;
  p1_played   integer;
begin
  update public.profiles
     set rating = PLUPR_BASE, singles_rating = PLUPR_BASE,
         doubles_rating = PLUPR_BASE, mixed_doubles_rating = PLUPR_BASE,
         total_matches_played = 0;
  update public.league_player_ratings
     set rating = PLUPR_BASE, singles_rating = PLUPR_BASE,
         doubles_rating = PLUPR_BASE, mixed_doubles_rating = PLUPR_BASE,
         wins = 0, losses = 0;

  for rec in (
    with combined as (
      select
        'league_match'::text  as src,
        m.played_at           as ts,
        m.created_at          as ord,
        m.league_id           as league_id,
        m.match_type, m.doubles_category,
        m.player1_id  as t1p1, m.partner1_id as t1p2,
        m.player2_id  as t2p1, m.partner2_id as t2p2,
        m.winner_team, m.player1_score as score1, m.player2_score as score2,
        m.winner_id
      from public.matches m
      where coalesce(m.status, 'completed') = 'completed'
      union all
      select
        'tourn_match'::text                            as src,
        coalesce(tm.scheduled_at, tm.created_at)       as ts,
        tm.created_at                                  as ord,
        t.league_id                                    as league_id,
        tm.match_type,
        public.classify_doubles_match(tm.team1_player1, tm.team1_player2, tm.team2_player1, tm.team2_player2),
        tm.team1_player1, tm.team1_player2, tm.team2_player1, tm.team2_player2,
        tm.winner_team, tm.team1_score, tm.team2_score,
        null::uuid
      from public.tournament_matches tm
      join public.tournaments t on t.id = tm.tournament_id
      where tm.status = 'completed' and tm.winner_team is not null
    )
    select * from combined
    order by ts asc nulls last, ord asc
  ) loop
    match_idx := match_idx + 1;

    if rec.match_type = 'doubles' and rec.doubles_category = 'unspecified' then
      continue;
    end if;

    select rating into r1 from public.profiles where id = rec.t1p1;
    select rating into r2 from public.profiles where id = rec.t2p1;
    r_p1 := 3.250; r_p2 := 3.250;
    if rec.match_type = 'doubles' then
      if rec.t1p2 is not null then select rating into r_p1 from public.profiles where id = rec.t1p2; end if;
      if rec.t2p2 is not null then select rating into r_p2 from public.profiles where id = rec.t2p2; end if;
      team1_avg := (r1 + r_p1) / 2.0;
      team2_avg := (r2 + r_p2) / 2.0;
      cat := rec.doubles_category;
    else
      team1_avg := r1; team2_avg := r2; cat := null;
    end if;

    select coalesce(total_matches_played, 0) into p1_played from public.profiles where id = rec.t1p1;
    if    p1_played <  5 then k_factor := 0.35;
    elsif p1_played < 15 then k_factor := 0.22;
    else                      k_factor := 0.15;
    end if;

    won1 := (rec.winner_team = 'team1') or (rec.winner_id = rec.t1p1);
    if won1 then
      s1 := coalesce(rec.score1, 11);
      s2 := coalesce(rec.score2, 7);
    else
      s1 := coalesce(rec.score1, 7);
      s2 := coalesce(rec.score2, 11);
    end if;

    expected_diff := public._plupr_expected_diff(team1_avg, team2_avg);
    actual_diff   := (s1 - s2)::decimal;
    surprise      := (actual_diff - expected_diff) / 10.0;
    delta1 := round((k_factor * surprise)::numeric, 3);
    delta2 := -delta1;

    if rec.src = 'league_match' then
      perform public._apply_plupr_delta_to_league(rec.league_id, rec.t1p1, delta1, case when rec.match_type='singles' then 'singles' else cat end);
      perform public._apply_plupr_delta_to_league(rec.league_id, rec.t2p1, delta2, case when rec.match_type='singles' then 'singles' else cat end);
      if rec.match_type='doubles' then
        if rec.t1p2 is not null then perform public._apply_plupr_delta_to_league(rec.league_id, rec.t1p2, delta1, cat); end if;
        if rec.t2p2 is not null then perform public._apply_plupr_delta_to_league(rec.league_id, rec.t2p2, delta2, cat); end if;
      end if;
      perform public._apply_plupr_delta_to_global(rec.t1p1, delta1 * GLOBAL_WT, case when rec.match_type='singles' then 'singles' else cat end);
      perform public._apply_plupr_delta_to_global(rec.t2p1, delta2 * GLOBAL_WT, case when rec.match_type='singles' then 'singles' else cat end);
      if rec.match_type='doubles' then
        if rec.t1p2 is not null then perform public._apply_plupr_delta_to_global(rec.t1p2, delta1 * GLOBAL_WT, cat); end if;
        if rec.t2p2 is not null then perform public._apply_plupr_delta_to_global(rec.t2p2, delta2 * GLOBAL_WT, cat); end if;
      end if;
    else
      if rec.league_id is not null then
        perform public._apply_plupr_delta_to_league(rec.league_id, rec.t1p1, delta1, case when rec.match_type='singles' then 'singles' else cat end);
        perform public._apply_plupr_delta_to_league(rec.league_id, rec.t2p1, delta2, case when rec.match_type='singles' then 'singles' else cat end);
        if rec.match_type='doubles' then
          if rec.t1p2 is not null then perform public._apply_plupr_delta_to_league(rec.league_id, rec.t1p2, delta1, cat); end if;
          if rec.t2p2 is not null then perform public._apply_plupr_delta_to_league(rec.league_id, rec.t2p2, delta2, cat); end if;
        end if;
      else
        perform public._apply_plupr_delta_to_global(rec.t1p1, delta1, case when rec.match_type='singles' then 'singles' else cat end);
        perform public._apply_plupr_delta_to_global(rec.t2p1, delta2, case when rec.match_type='singles' then 'singles' else cat end);
        if rec.match_type='doubles' then
          if rec.t1p2 is not null then perform public._apply_plupr_delta_to_global(rec.t1p2, delta1, cat); end if;
          if rec.t2p2 is not null then perform public._apply_plupr_delta_to_global(rec.t2p2, delta2, cat); end if;
        end if;
      end if;
    end if;

    update public.profiles set total_matches_played = coalesce(total_matches_played, 0) + 1
     where id in (rec.t1p1, rec.t2p1);
    if rec.match_type='doubles' then
      update public.profiles set total_matches_played = coalesce(total_matches_played, 0) + 1
       where id in (rec.t1p2, rec.t2p2) and id is not null;
    end if;
  end loop;

  raise notice 'recompute_all_plupr: processed % matches', match_idx;
end;
$function$;

-- ── redeem_real_world_item(uuid,jsonb) ──
CREATE OR REPLACE FUNCTION public.redeem_real_world_item(p_item_id uuid, p_shipping_address jsonb)
 RETURNS TABLE(success boolean, new_balance integer, pickles_paid integer, discount_pct integer, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_uid       uuid := auth.uid();
  v_cost      integer;
  v_active    boolean;
  v_category  text;
  v_slug      text;
  v_name      text;
  v_balance   integer;
  v_discount  integer := 0;
  v_effective integer;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  if not public._redemption_address_valid(p_shipping_address) then
    return query select false, null::integer, 0, 0,
      'Shipping address is required (name, line1, city, postal_code, country)'::text; return;
  end if;

  select cost, is_active, category, slug, name
    into v_cost, v_active, v_category, v_slug, v_name
    from public.shop_items
   where id = p_item_id;

  if v_cost is null then
    return query select false, null::integer, 0, 0, 'Item not found'::text; return;
  end if;
  if not v_active then
    return query select false, null::integer, 0, 0, 'Item not available'::text; return;
  end if;
  if v_category <> 'real_world' then
    return query select false, null::integer, 0, 0,
      'Use purchase_shop_item for non-redemption items'::text; return;
  end if;

  select d.discount_pct into v_discount
    from public.current_real_world_discounts() d
   where d.slug = v_slug;
  if v_discount is null then v_discount := 0; end if;

  v_effective := floor(v_cost * (100 - v_discount) / 100.0)::integer;

  select pickles into v_balance from public.profiles where id = v_uid;
  if v_balance < v_effective then
    return query select false, v_balance, v_effective, v_discount, 'Not enough pickles'::text; return;
  end if;

  update public.profiles set pickles = pickles - v_effective
    where id = v_uid
    returning pickles into v_balance;

  insert into public.redemption_orders
    (user_id, shop_item_id, pickles_paid, base_pickles, discount_pct, shipping_address)
  values (v_uid, p_item_id, v_effective, v_cost, v_discount, p_shipping_address);

  begin
    perform public._notify_user(
      v_uid,
      format('🎁 Redemption queued: %s', v_name),
      format('Your redemption for %s is pending. We''ll ship to the address you provided.', v_name),
      v_uid,
      'shop'
    );
  exception when others then null;
  end;

  return query select true, v_balance, v_effective, v_discount, 'Redeemed!'::text;
end;
$function$;

-- ── update_plupr_for_tournament_match() ──
CREATE OR REPLACE FUNCTION public.update_plupr_for_tournament_match()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  PLUPR_FLOOR     constant decimal := 2.000;
  v_league_id     uuid;
  r1 decimal; r_p1 decimal := 3.250;
  r2 decimal; r_p2 decimal := 3.250;
  team1_avg       decimal; team2_avg decimal;
  expected_diff   decimal;
  actual_diff     decimal;
  surprise        decimal;
  k_factor        decimal := 0.15;
  s1              integer; s2 integer;
  delta1          decimal; delta2 decimal;
  won1            boolean;
  cat             text;
  p1_count        integer;
begin
  if not (
    (TG_OP = 'UPDATE' and old.status <> 'completed' and new.status = 'completed')
    or (TG_OP = 'INSERT' and new.status = 'completed')
  ) then return new; end if;
  if new.winner_team is null or new.team1_player1 is null or new.team2_player1 is null then return new; end if;

  select league_id into v_league_id from public.tournaments where id = new.tournament_id;

  select rating into r1 from public.profiles where id = new.team1_player1;
  select rating into r2 from public.profiles where id = new.team2_player1;
  if new.match_type = 'doubles' then
    if new.team1_player2 is not null then select rating into r_p1 from public.profiles where id = new.team1_player2; end if;
    if new.team2_player2 is not null then select rating into r_p2 from public.profiles where id = new.team2_player2; end if;
    team1_avg := (r1 + r_p1) / 2.0;
    team2_avg := (r2 + r_p2) / 2.0;
    cat := public._classify_doubles_with_overrides(
      new.team1_player1, new.team1_player1_gender_override,
      new.team1_player2, new.team1_player2_gender_override,
      new.team2_player1, new.team2_player1_gender_override,
      new.team2_player2, new.team2_player2_gender_override
    );
  else
    team1_avg := r1; team2_avg := r2; cat := null;
  end if;

  if new.match_type = 'doubles' and cat = 'unspecified' then return new; end if;

  select coalesce(total_matches_played, 0) into p1_count from public.profiles where id = new.team1_player1;
  if    p1_count <  5 then k_factor := 0.35;
  elsif p1_count < 15 then k_factor := 0.22;
  else                     k_factor := 0.15;
  end if;

  won1 := new.winner_team = 'team1';
  if won1 then
    s1 := coalesce(new.team1_score, 11);
    s2 := coalesce(new.team2_score, 7);
  else
    s1 := coalesce(new.team1_score, 7);
    s2 := coalesce(new.team2_score, 11);
  end if;

  expected_diff := public._plupr_expected_diff(team1_avg, team2_avg);
  actual_diff   := (s1 - s2)::decimal;
  surprise      := (actual_diff - expected_diff) / 10.0;
  delta1 := round((k_factor * surprise)::numeric, 3);
  delta2 := -delta1;

  if v_league_id is not null then
    perform public._apply_plupr_delta_to_league(v_league_id, new.team1_player1, delta1, case when new.match_type='singles' then 'singles' else cat end);
    perform public._apply_plupr_delta_to_league(v_league_id, new.team2_player1, delta2, case when new.match_type='singles' then 'singles' else cat end);
    if new.match_type = 'doubles' then
      if new.team1_player2 is not null then perform public._apply_plupr_delta_to_league(v_league_id, new.team1_player2, delta1, cat); end if;
      if new.team2_player2 is not null then perform public._apply_plupr_delta_to_league(v_league_id, new.team2_player2, delta2, cat); end if;
    end if;
  else
    perform public._apply_plupr_delta_to_global(new.team1_player1, delta1, case when new.match_type='singles' then 'singles' else cat end);
    perform public._apply_plupr_delta_to_global(new.team2_player1, delta2, case when new.match_type='singles' then 'singles' else cat end);
    if new.match_type = 'doubles' then
      if new.team1_player2 is not null then perform public._apply_plupr_delta_to_global(new.team1_player2, delta1, cat); end if;
      if new.team2_player2 is not null then perform public._apply_plupr_delta_to_global(new.team2_player2, delta2, cat); end if;
    end if;
  end if;

  return new;
end;
$function$;

-- ── update_plupr_ratings() ──
CREATE OR REPLACE FUNCTION public.update_plupr_ratings()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  PLUPR_FLOOR     constant decimal := 2.000;
  GLOBAL_WEIGHT   constant decimal := 0.5;
  r1              decimal; r_p1 decimal := 3.250;
  r2              decimal; r_p2 decimal := 3.250;
  team1_avg       decimal; team2_avg decimal;
  expected_diff   decimal;
  actual_diff     decimal;
  surprise        decimal;
  k_factor        decimal;
  s1              integer; s2 integer;
  delta1          decimal; delta2 decimal;
  won1            boolean;
  cat             text;
  p1_count        integer;
begin
  if TG_OP = 'INSERT' then
    select rating into r1 from public.profiles where id = new.player1_id;
    select rating into r2 from public.profiles where id = new.player2_id;

    if new.match_type = 'doubles' then
      if new.partner1_id is not null then select rating into r_p1 from public.profiles where id = new.partner1_id; end if;
      if new.partner2_id is not null then select rating into r_p2 from public.profiles where id = new.partner2_id; end if;
      team1_avg := (r1 + r_p1) / 2.0;
      team2_avg := (r2 + r_p2) / 2.0;
      cat := public._classify_doubles_with_overrides(
        new.player1_id,  new.player1_gender_override,
        new.partner1_id, new.partner1_gender_override,
        new.player2_id,  new.player2_gender_override,
        new.partner2_id, new.partner2_gender_override
      );
      new.doubles_category := cat;
    else
      team1_avg := r1; team2_avg := r2;
      new.doubles_category := null; cat := null;
    end if;

    new.player1_rating_before := r1;
    new.player2_rating_before := r2;

    if new.match_type = 'doubles' and cat = 'unspecified' then
      new.player1_rating_after := r1;
      new.player2_rating_after := r2;
      new.pending_delta1 := 0;
      new.pending_delta2 := 0;
      return new;
    end if;

    select coalesce(total_matches_played, 0) into p1_count from public.profiles where id = new.player1_id;
    if    p1_count <  5 then k_factor := 0.35;
    elsif p1_count < 15 then k_factor := 0.22;
    else                     k_factor := 0.15;
    end if;

    won1 := (new.winner_team = 'team1') or (new.winner_id = new.player1_id);
    if won1 then
      s1 := coalesce(new.player1_score, 11);
      s2 := coalesce(new.player2_score, 7);
    else
      s1 := coalesce(new.player1_score, 7);
      s2 := coalesce(new.player2_score, 11);
    end if;

    expected_diff := public._plupr_expected_diff(team1_avg, team2_avg);
    actual_diff   := (s1 - s2)::decimal;
    surprise      := (actual_diff - expected_diff) / 10.0;
    delta1 := round((k_factor * surprise)::numeric, 3);
    delta2 := -delta1;

    new.player1_rating_after := greatest(PLUPR_FLOOR, r1 + delta1 * GLOBAL_WEIGHT);
    new.player2_rating_after := greatest(PLUPR_FLOOR, r2 + delta2 * GLOBAL_WEIGHT);
    new.pending_delta1 := delta1;
    new.pending_delta2 := delta2;

    if new.status = 'completed' then
      perform public._apply_match_deltas_to_players(
        new.league_id,
        new.player1_id, new.partner1_id, new.player2_id, new.partner2_id,
        new.match_type, cat, delta1, delta2
      );
    end if;

    return new;
  end if;

  if TG_OP = 'UPDATE' and old.status = 'pending' and new.status = 'completed' then
    if new.pending_delta1 is null or new.pending_delta1 = 0 then
      return new;
    end if;
    perform public._apply_match_deltas_to_players(
      new.league_id,
      new.player1_id, new.partner1_id, new.player2_id, new.partner2_id,
      new.match_type, new.doubles_category, new.pending_delta1, new.pending_delta2
    );
  end if;

  return new;
end;
$function$;
