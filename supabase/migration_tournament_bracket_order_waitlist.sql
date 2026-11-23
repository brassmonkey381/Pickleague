-- migration_tournament_bracket_order_waitlist.sql (PKL-068, PKL-069)
--
-- PKL-068: elimination brackets keep the top seeds apart. The app now writes round 1 in standard bracket order
-- (lib/tournament.ts bracketSlotOrder: 1v8, 4v5, 2v7, 3v6), which the neighbour-pairing advance turns into the right
-- path. The singles-with-byes path rebuilt round 2 as slot i v slot N-1-i, right for 8 but wrong from 16 up; it now
-- uses the same bracket order. Seen in the PKL-060 R4 rehearsal: team seeds 1 and 2 met in a doubles semifinal.
--
-- PKL-069: joining a full join-by-request tournament failed. register() inserts 'pending'; the BEFORE trigger
-- _waitlist_if_full turns it into 'waitlisted'; the insert policy only allowed 'pending', so RLS refused the row.
-- The policy now allows either. Everything else in it is unchanged.

create or replace function public._se_bracket_order(p_slots integer)
returns integer[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_order integer[] := array[0];
  v_next  integer[];
  v_n     integer;
  v_x     integer;
begin
  while coalesce(array_length(v_order, 1), 0) < p_slots loop
    v_n := array_length(v_order, 1) * 2;
    v_next := '{}';
    foreach v_x in array v_order loop
      v_next := v_next || v_x || (v_n - 1 - v_x);
    end loop;
    v_order := v_next;
  end loop;
  return v_order;
end $$;
revoke all on function public._se_bracket_order(integer) from public, anon, authenticated;

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
  v_order integer[];
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
          -- PKL-068: round 2 in standard bracket order (neighbouring slots meet), so the later rounds, which pair
          -- neighbouring winners, keep the top seeds apart to the end (16+ entrants paired 1 with 2 in the semis).
          v_order := public._se_bracket_order(v_slot_matches);
          for v_i in 0 .. (v_round2_pairs - 1) loop
            select sw.p1, sw.p2 into v_a1, v_a2 from public._se_round1_slot_winner(new.round_id, v_seeds, v_seeds2, v_pow2, v_entrant_count, v_order[2 * v_i + 1]) sw;
            select sw.p1, sw.p2 into v_b1, v_b2 from public._se_round1_slot_winner(new.round_id, v_seeds, v_seeds2, v_pow2, v_entrant_count, v_order[2 * v_i + 2]) sw;
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

drop policy if exists "Users can register themselves" on public.tournament_registrations;
create policy "Users can register themselves" on public.tournament_registrations
  for insert to public
  with check (
    (auth.uid() = user_id) and (invited_by is null) and (
      (exists (select 1 from public.tournaments t
                where t.id = tournament_registrations.tournament_id and t.status = 'registration' and t.created_by = auth.uid()))
      or ((status in ('pending', 'waitlisted')) and (role = 'member') and (exists (
            select 1 from public.tournaments t
             where t.id = tournament_registrations.tournament_id and t.status = 'registration'
               and t.registration_mode = 'request'
               and (t.registration_closes_at is null or now() < t.registration_closes_at))))
    )
  );
