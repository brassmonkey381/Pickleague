-- Wager display: expected-end + league context
-- ---------------------------------------------------------------------------
-- Adds two columns to the wager-listing RPCs so every wager row can show when
-- the thing wagered on is expected to end, and (when it isn't obvious from the
-- subject) which league it falls under:
--
--   expected_end_at  when the wagered-on thing resolves/ends
--     tournament_rank        tournament start_time + expected_length_hours
--     season_rank            season end_date
--     period_rank            season start_date + period_number * lock weeks
--     match / match_score    the match's scheduled_at
--     tournament_match(_sc)  the tournament match's scheduled_at
--   league_name      the league the wager rolls up to (null for standalone
--                    tournaments with no league).
--
-- Both are nullable; each subject_type fills what it can.

-- ── get_my_wagers_with_details ─────────────────────────────────────────────
drop function if exists public.get_my_wagers_with_details();
create function public.get_my_wagers_with_details()
returns table (
  id                   uuid,
  user_id              uuid,
  subject_type         text,
  subject_id           uuid,
  predicate            jsonb,
  stake                int,
  odds                 numeric,
  potential_payout     int,
  status               text,
  placed_at            timestamptz,
  settled_at           timestamptz,
  predicted_user_name  text,
  predicted_rank       int,
  scope_name           text,
  actual_rank          int,
  actual_winner_team   text,
  actual_team1_score   int,
  actual_team2_score   int,
  team_label_a         text,
  team_label_b         text,
  expected_end_at      timestamptz,
  league_name          text
)
language plpgsql
security definer
set search_path = public
as $$
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
$$;

grant execute on function public.get_my_wagers_with_details() to authenticated;

-- ── get_wagers_on_player ───────────────────────────────────────────────────
-- Rank wagers placed on a given player (optionally scoped). Adds expected_end_at
-- and league_name alongside the existing scope_name.
drop function if exists public.get_wagers_on_player(uuid, text, uuid);
create function public.get_wagers_on_player(
  p_user_id    uuid,
  p_scope_type text default null,   -- 'tournament' | 'league' | 'season' | null
  p_scope_id   uuid default null
)
returns table(
  wager_id         uuid,
  bettor_id        uuid,
  bettor_name      text,
  stake            int,
  potential_payout int,
  odds             numeric,
  status           text,
  rank             int,
  subject_type     text,
  scope_name       text,
  placed_at        timestamptz,
  expected_end_at  timestamptz,
  league_name      text
)
language sql
stable
security definer
set search_path = public
as $$
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
$$;
grant execute on function public.get_wagers_on_player(uuid, text, uuid) to authenticated;
