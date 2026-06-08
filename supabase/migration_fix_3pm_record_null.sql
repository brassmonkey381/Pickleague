-- ============================================================
-- migration_fix_3pm_record_null.sql
--
-- BUG #5 — the Third Place Match was NEVER generated for top_4 / top_8
-- (the `tournaments.playoff_third_place` toggle was effectively inert).
--
-- Found by running the Unit 10 test (test_advance_non_mlp_playoff_qf.sql,
-- Test E) against the live DB: with playoff_third_place = true on a top_4
-- bracket, completing both Semifinals created the Finals but ZERO
-- third_place_match rounds.
--
-- Root cause — Postgres `record IS NOT NULL` semantics
-- ----------------------------------------------------
-- The 3PM branch of public._advance_non_mlp_playoff_bracket() guards the
-- insert with:
--     if v_l1 is not null and v_l2 is not null and v_l1.id <> v_l2.id then
-- where v_l1 / v_l2 are `record`s holding the two Semifinal match rows.
--
-- For a composite/record value, `rec IS NOT NULL` is TRUE only when EVERY
-- field is non-null — it is NOT the negation of `rec IS NULL`. A
-- tournament_matches row always has at least one NULL column (e.g.
-- team1_player2 / team2_player2 for singles, scheduled_at, etc.), so
-- `v_l1 IS NOT NULL` evaluated to FALSE and the 3PM was never inserted —
-- for singles always, and in practice for doubles too (nullable columns).
-- Instrumented live: the block was entered, both losers were fetched with
-- valid distinct ids, but the `IS NOT NULL` guard short-circuited the insert.
--
-- The fix
-- -------
-- Test the populated-ness via the primary key instead:
--     if v_l1.id is not null and v_l2.id is not null and v_l1.id <> v_l2.id
-- Verified live (rolled back): top_4 singles now creates exactly one
-- 'third_place_match' round pairing the two Semifinal losers.
--
-- This is a faithful copy of the live definition (last set by
-- migration_playoff_byes_and_per_pool_3pm.sql, #69) with ONLY the two
-- `v_lN is not null` guards changed to `v_lN.id is not null`.
--
-- NOTE: stand-alone create-or-replace. The human applies it to prod
-- manually (the agent never calls apply_migration).
-- ============================================================

create or replace function public._advance_non_mlp_playoff_bracket()
returns trigger language plpgsql security definer as $function$
declare
  v_format             text;
  v_match_type         text;
  v_playoff_3pm        boolean;
  v_playoff_format     text;
  v_round_type         text;
  v_round_number       integer;
  v_uncompleted        integer;
  v_next_round_id      uuid;
  v_next_round_num     integer;
  v_next_round_type    text;
  v_next_label         text;
  v_count              integer;
  v_i                  integer;
  v_w1                 record;
  v_w2                 record;
  v_3pm_round_id       uuid;
  v_3pm_exists         boolean;
  v_l1                 record;
  v_l2                 record;
begin
  if new.status <> 'completed' then return new; end if;
  if TG_OP = 'UPDATE' and old.status = 'completed' then return new; end if;

  select format, match_type,
         coalesce(playoff_third_place, false),
         coalesce(playoff_format, 'none')
    into v_format, v_match_type, v_playoff_3pm, v_playoff_format
    from public.tournaments
   where id = new.tournament_id;
  if v_format not in ('round_robin', 'pool_play') then return new; end if;

  select round_type, round_number
    into v_round_type, v_round_number
    from public.tournament_rounds
   where id = new.round_id;
  if v_round_type not in ('quarterfinals', 'semifinals') then return new; end if;

  select count(*) into v_uncompleted
    from public.tournament_matches
   where round_id = new.round_id
     and status <> 'completed';
  if v_uncompleted > 0 then return new; end if;

  if v_round_type = 'quarterfinals' then
    v_next_round_type := 'semifinals';
    v_next_label      := 'Semifinals';
  else
    v_next_round_type := 'finals';
    v_next_label      := 'Finals';
  end if;

  if exists (
    select 1 from public.tournament_rounds
     where tournament_id = new.tournament_id
       and round_type = v_next_round_type
  ) then
    return new;
  end if;

  select count(*) into v_count
    from public.tournament_matches
   where round_id = new.round_id
     and winner_team in ('team1', 'team2');
  if v_count < 2 then return new; end if;

  v_next_round_num := coalesce(v_round_number, 1000) + 100;
  insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
    values (new.tournament_id, v_next_round_num, v_next_label, v_next_round_type)
    returning id into v_next_round_id;

  for v_i in 0..(v_count / 2 - 1) loop
    with ordered as (
      select tm.*,
             row_number() over (order by match_order, id) - 1 as rn
        from public.tournament_matches tm
       where tm.round_id = new.round_id
         and tm.winner_team in ('team1', 'team2')
    )
    select * into v_w1 from ordered where rn = v_i;

    with ordered as (
      select tm.*,
             row_number() over (order by match_order, id) - 1 as rn
        from public.tournament_matches tm
       where tm.round_id = new.round_id
         and tm.winner_team in ('team1', 'team2')
    )
    select * into v_w2 from ordered where rn = v_count - 1 - v_i;

    if v_w1 is null or v_w2 is null then continue; end if;
    if v_w1.id = v_w2.id then continue; end if;

    insert into public.tournament_matches (
      tournament_id, round_id, match_order, match_type,
      team1_player1,
      team1_player2,
      team2_player1,
      team2_player2,
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

  if v_round_type = 'semifinals'
     and v_playoff_3pm
     and v_playoff_format in ('top_4', 'top_8', 'top_1_per_pool', 'top_2_per_pool')
     and v_count = 2
  then
    select exists (
      select 1 from public.tournament_rounds
       where tournament_id = new.tournament_id
         and round_type = 'third_place_match'
    ) into v_3pm_exists;

    if not v_3pm_exists then
      with ordered as (
        select tm.*,
               row_number() over (order by match_order, id) - 1 as rn
          from public.tournament_matches tm
         where tm.round_id = new.round_id
           and tm.winner_team in ('team1', 'team2')
      )
      select * into v_l1 from ordered where rn = 0;

      with ordered as (
        select tm.*,
               row_number() over (order by match_order, id) - 1 as rn
          from public.tournament_matches tm
         where tm.round_id = new.round_id
           and tm.winner_team in ('team1', 'team2')
      )
      select * into v_l2 from ordered where rn = 1;

      -- BUG #5 FIX: use `.id is not null` (record IS NOT NULL is true only
      -- when EVERY column is non-null, which never holds for a match row).
      if v_l1.id is not null and v_l2.id is not null and v_l1.id <> v_l2.id then
        insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
          values (new.tournament_id, v_next_round_num + 50, 'Third Place Match', 'third_place_match')
          returning id into v_3pm_round_id;

        insert into public.tournament_matches (
          tournament_id, round_id, match_order, match_type,
          team1_player1,
          team1_player2,
          team2_player1,
          team2_player2,
          status
        )
        values (
          new.tournament_id,
          v_3pm_round_id,
          0,
          coalesce(v_match_type, 'singles'),
          case when v_l1.winner_team = 'team1' then v_l1.team2_player1 else v_l1.team1_player1 end,
          case when v_l1.winner_team = 'team1' then v_l1.team2_player2 else v_l1.team1_player2 end,
          case when v_l2.winner_team = 'team1' then v_l2.team2_player1 else v_l2.team1_player1 end,
          case when v_l2.winner_team = 'team1' then v_l2.team2_player2 else v_l2.team1_player2 end,
          'pending'
        );
      end if;
    end if;
  end if;

  return new;
end;
$function$;

notify pgrst, 'reload schema';
