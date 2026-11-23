-- migration_tournament_cancelled_and_singles_alerts.sql (PKL-071, PKL-072)
--
-- PKL-071: a cancelled group match blocked the tournament. generate_playoff_bracket counted it as pending ("Cannot
-- advance — 1 group-play matches still pending"), _maybe_auto_close_non_elim_tournament waited for it, and the "round
-- robin done" notice never went out. A cancelled match now counts as settled in all three.
--
-- PKL-072: in singles, the winner of a match could be told "you lost". The score notice tested its side with
-- v_uid in (new.team1_player1, new.team1_player2); in singles team1_player2 is NULL, so for a team-2 player that is NULL,
-- not false, and the won/lost test fell through to "lost". The side test is now NULL-safe.
--
-- Both found by the PKL-060 R5 bots-only run (2026-11-23). Only these lines change; the rest is the live definitions.

CREATE OR REPLACE FUNCTION public.generate_playoff_bracket(p_tournament_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid            uuid := auth.uid();
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
  v_third          boolean;
begin
  -- Admins only (migration_anon_audit_fixes.sql): anyone, signed out
  -- included, could draw any tournament's playoff. The service role (sims,
  -- scripts) passes; nothing in the database calls this.
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_uid is null then
      raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.',
                            hint = 'pl:auth.signed_out';
    end if;
    if not (
      public._is_tournament_admin(p_tournament_id, v_uid)
      or exists (
        select 1 from public.tournament_registrations r
         where r.tournament_id = p_tournament_id
           and r.user_id = v_uid
           and r.status = 'approved'
           and r.role in ('admin', 'co-admin')
      )
      or coalesce(public.is_godmode_user(), false)
    ) then
      raise exception 'Only tournament admins can generate the playoff';
    end if;
  end if;

  select format, match_type, coalesce(playoff_format, 'none'), coalesce(playoff_third_place, false)
    into v_format, v_match_type, v_playoff, v_third
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
     and tm.status not in ('completed', 'cancelled');
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
    pool_ranked as (
      -- PKL-052: wins, fewer losses, point diff, then the admin's tie order.
      select pool_letter, lo, hi,
             row_number() over (partition by pool_letter order by wins desc, losses asc, point_diff desc,
                                coalesce(public._pl_tie_rank(p_tournament_id, lo, hi), 2147483647), seed asc, lo, hi) as pool_rank
        from pre
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
  ranked as (
    -- PKL-052: wins, fewer losses, point diff, then the admin's tie order.
    select lo, hi,
           row_number() over (order by wins desc, losses asc, point_diff desc,
                              coalesce(public._pl_tie_rank(p_tournament_id, lo, hi), 2147483647), seed asc, lo, hi) as rn
      from pre
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

    -- The 3rd-place setting decides (PKL-045, Brian's rule 3). Off: only the
    -- Final; places 3 and below follow the round robin.
    if v_playoff_n = 2 and v_third and array_length(v_seeds, 1) >= 4 then
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

CREATE OR REPLACE FUNCTION public._maybe_auto_close_non_elim_tournament()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_format   text;
  v_status   text;
  v_playoff  text;
  v_pending  integer;
begin
  if new.status <> 'completed' then return new; end if;
  if TG_OP = 'UPDATE' and old.status = 'completed' then return new; end if;

  begin
    -- FOR UPDATE: two scores saved at once (the Final and the 3PM) queue here.
    -- The second one then counts open matches with a fresh snapshot (READ
    -- COMMITTED) and sees the first one's match completed.
    select format, status, coalesce(playoff_format, 'none')
      into v_format, v_status, v_playoff
      from public.tournaments where id = new.tournament_id
       for update;

    if v_format not in ('round_robin', 'pool_play', 'rotating_partners') then
      return new;
    end if;
    if v_status <> 'active' then return new; end if;

    -- A configured playoff must actually run before the tournament can close.
    if v_playoff <> 'none' and not exists (
      select 1 from public.tournament_rounds r
       where r.tournament_id = new.tournament_id
         and r.round_type in ('quarterfinals', 'semifinals', 'finals', 'third_place_match')
    ) then
      return new;
    end if;

    select count(*) into v_pending
      from public.tournament_matches
     where tournament_id = new.tournament_id
       and status not in ('completed', 'cancelled');

    if v_pending = 0 then
      update public.tournaments
         set status = 'completed'
       where id = new.tournament_id
         and status = 'active';
    end if;
  exception when others then
    null; -- never block the score update
  end;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public._pl_tm_score_notices()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_t        record;
  v_actor    uuid := auth.uid();
  v_actor_nm text;
  v_uid      uuid;
  v_won      boolean;
  v_mine     integer;
  v_theirs   integer;
  v_pay      integer;
  v_next     text;
  v_body     text;
  v_place    integer;
  v_open     integer;
begin
  if new.team1_player1 is null or new.team2_player1 is null then return null; end if;
  if new.status <> 'completed' or new.winner_team not in ('team1', 'team2') then return null; end if;
  begin
    select id, name, format, status, coalesce(playoff_format, 'none') as playoff, created_by
      into v_t from public.tournaments where id = new.tournament_id;
    if v_t.id is null then return null; end if;
    select nullif(trim(full_name), '') into v_actor_nm from public.profiles where id = v_actor;

    -- 1. A score went in.
    if old.status is distinct from 'completed' then
      foreach v_uid in array array_remove(array[new.team1_player1, new.team1_player2,
                                                 new.team2_player1, new.team2_player2], null) loop
        begin
          v_won := ((v_uid = new.team1_player1 or v_uid is not distinct from new.team1_player2)) = (new.winner_team = 'team1');
          if (v_uid = new.team1_player1 or v_uid is not distinct from new.team1_player2) then
            v_mine := coalesce(new.team1_score, 0); v_theirs := coalesce(new.team2_score, 0);
          else
            v_mine := coalesce(new.team2_score, 0); v_theirs := coalesce(new.team1_score, 0);
          end if;
          v_pay := null;
          begin
            select g.paid into v_pay from public.tournament_match_bonus_grants g
             where g.match_id = new.id and g.user_id = v_uid;
          exception when undefined_table then v_pay := null;
          end;
          v_next := case when v_t.status = 'active' then public._pl_tm_next_text(v_t.id, v_uid, true) end;

          if v_actor is not null and v_uid = v_actor then
            -- The one who entered it: only what's new to them.
            if v_next is not null or coalesce(v_pay, 0) > 0 then
              perform public._pl_tm_notice(
                v_uid, 'tm_score', new.id, v_t.id,
                case when v_next is not null then '🏓 Up next in ' || v_t.name
                     else '✅ Score saved in ' || v_t.name end,
                concat_ws(' ',
                  case when coalesce(v_pay, 0) > 0 then '+' || v_pay || ' 🥒 for the match.' end,
                  v_next));
            end if;
          else
            v_body := concat_ws(' ',
              public._pl_tm_line(new.id, v_uid) || ', ' || v_mine || '-' || v_theirs || '.',
              case when v_actor_nm is not null then 'Entered by ' || v_actor_nm || '.' end,
              case when coalesce(v_pay, 0) > 0 then '+' || v_pay || ' 🥒 for the match.' end,
              v_next);
            perform public._pl_tm_notice(
              v_uid, 'tm_score', new.id, v_t.id,
              case when v_won then '✅ ' || v_t.name || ': you won ' || v_mine || '-' || v_theirs
                   else '📝 ' || v_t.name || ': you lost ' || v_mine || '-' || v_theirs end,
              v_body);
          end if;
        exception when others then
          raise warning 'score notice for % on % failed: %', v_uid, new.id, sqlerrm;
        end;
      end loop;

      -- 2. Round robin done, playoff still to draw.
      if v_t.status = 'active' and v_t.format in ('round_robin', 'pool_play') and v_t.playoff <> 'none'
         and not exists (select 1 from public.tournament_rounds r
                          where r.tournament_id = v_t.id and r.round_type not in ('winners', 'pool')) then
        select count(*) into v_open
          from public.tournament_matches m
          left join public.tournament_rounds r on r.id = m.round_id
         where m.tournament_id = v_t.id and m.status not in ('completed', 'cancelled')
           and (r.id is null or r.round_type in ('winners', 'pool'));
        if v_open = 0 then
          for v_uid in
            select tr.user_id from public.tournament_registrations tr
             where tr.tournament_id = v_t.id and tr.status = 'approved' and tr.user_id is not null
          loop
            v_place := public._pl_tm_rr_place(v_t.id, v_uid);
            perform public._pl_tm_notice(
              v_uid, 'tm_rr_done', v_t.id, v_t.id,
              '📊 ' || v_t.name || ': round robin done',
              case when v_place is not null
                   then 'You finished ' || public._pl_ordinal(v_place) || ' in the round robin. '
                   else '' end
              || 'The host draws the playoff next; we''ll tell you when it''s set.');
          end loop;
          for v_uid in
            select distinct u from (
              select v_t.created_by as u
              union
              select tr.user_id from public.tournament_registrations tr
               where tr.tournament_id = v_t.id and tr.status = 'approved' and tr.role in ('admin', 'co-admin')
            ) a where u is not null
          loop
            perform public._pl_tm_notice(
              v_uid, 'tm_draw_due', v_t.id, v_t.id,
              '🏆 Draw the playoff: ' || v_t.name,
              'Every round-robin match is scored. Open the tournament and tap Generate the playoff.');
          end loop;
        end if;
      end if;

    -- 3. A completed score was corrected.
    elsif (new.team1_score, new.team2_score, new.winner_team)
          is distinct from (old.team1_score, old.team2_score, old.winner_team) then
      foreach v_uid in array array_remove(array[new.team1_player1, new.team1_player2,
                                                 new.team2_player1, new.team2_player2], null) loop
        if v_actor is not null and v_uid = v_actor then continue; end if;
        if (v_uid = new.team1_player1 or v_uid is not distinct from new.team1_player2) then
          v_mine := coalesce(new.team1_score, 0); v_theirs := coalesce(new.team2_score, 0);
        else
          v_mine := coalesce(new.team2_score, 0); v_theirs := coalesce(new.team1_score, 0);
        end if;
        perform public._pl_tm_notice(
          v_uid, 'tm_fix_' || coalesce(new.team1_score, 0) || '_' || coalesce(new.team2_score, 0), new.id, v_t.id,
          '✏️ Score corrected in ' || v_t.name,
          public._pl_tm_line(new.id, v_uid) || ' is now ' || v_mine || '-' || v_theirs || '.');
      end loop;
    end if;
  exception when others then
    raise warning 'tournament score notices failed for match %: %', new.id, sqlerrm;
  end;
  return null;
end $function$;
