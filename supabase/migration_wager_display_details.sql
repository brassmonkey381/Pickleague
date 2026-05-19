-- get_my_wagers_with_details: returns each of the caller's wagers with the
-- predicate joined back to human-readable context so the MyWagers screen can
-- show "Alice to finish 3rd in Spring Open" instead of just "rank: 3", and
-- once settled "Alice finished 4th" instead of just "lost".
--
-- Enrichment columns are nullable: each subject_type only fills the rows it
-- needs. actual_rank for tournament_rank is derived from
-- tournament_champion_badges (rank 1 only); other rank positions stay null
-- until we add a per-tournament finishing-rank derivation.

create or replace function public.get_my_wagers_with_details()
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
  team_label_b         text
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
    end as team_label_b
  from wagers w
  where w.user_id = uid
  order by w.placed_at desc;
end;
$$;

grant execute on function public.get_my_wagers_with_details() to authenticated;
