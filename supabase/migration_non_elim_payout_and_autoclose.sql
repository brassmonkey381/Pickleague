-- ============================================================
-- Non-elimination payout derivation + auto-close
--
-- Adds preview_tournament_payout branches for the three non-bracket
-- formats: round_robin, pool_play, rotating_partners. Each format
-- computes standings directly from tournament_matches (no playoff
-- round to inspect).
--
--   round_robin (singles)   — wins per registered user
--   round_robin (doubles)   — wins per doubles_pairs.id
--   pool_play   (both)      — wins across all pools (overall standings)
--   rotating_partners       — INDIVIDUAL wins across rotating matches,
--                             regardless of who their partner was
--
-- Tiebreak cascade: wins desc → point-diff desc → ELO desc.
-- Tied players spanning the payout cutoff: the structure slot is
-- awarded to the first tied player by tiebreak order; the surplus
-- slots receive nothing. No splitting.
--
-- Also installs an auto-close trigger that flips tournaments.status
-- to 'completed' once every tournament_match for the tournament has
-- status='completed', for these three formats only.  MLP / single_elim
-- / double_elim keep their own close triggers.
--
-- The auto_payout_tournament dispatcher (from
-- migration_universal_tournament_payout.sql) already loops over
-- preview_tournament_payout rows — so wiring new format branches into
-- the preview function is enough to make payouts work end-to-end.
-- ============================================================


-- 1. preview_tournament_payout — dispatcher with non-elim branches ----------
create or replace function public.preview_tournament_payout(p_tournament_id uuid)
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
  v_format     text;
  v_match_type text;
  v_pool       integer;
  v_structure  integer[];
  v_slots      integer;
begin
  select t.format, t.match_type, coalesce(t.prize_pool, 0), coalesce(t.payout_structure, '{60,25,15}')
    into v_format, v_match_type, v_pool, v_structure
    from public.tournaments t where t.id = p_tournament_id;
  if v_format is null then return; end if;

  v_slots := coalesce(array_length(v_structure, 1), 0);
  if v_slots = 0 then return; end if;

  -- MLP variants — delegate to the existing MLP preview verbatim.
  if v_format in ('mlp', 'mlp_random') then
    return query
      select p.place, p.team_id, p.team_name, p.uids, p.user_names,
             p.pool_share, p.share_per_user, p.plupr_bonus
        from public.preview_mlp_tournament_payout(p_tournament_id) p;
    return;
  end if;

  -- Single / double elimination — a separate migration owns these
  -- branches. If neither has been installed yet, we fall through and
  -- return no rows rather than guessing. The MLP delegate above is
  -- the only branch this file's author owns beyond the three non-elim
  -- formats below.
  if v_format in ('single_elimination', 'double_elimination') then
    return;
  end if;

  -- Non-elim standings — sorted by wins desc, point-diff desc, ELO desc.
  -- Rows beyond v_slots are dropped (no splitting on ties).

  if v_format in ('round_robin', 'pool_play') and v_match_type = 'singles' then
    return query
      with stats as (
        select
          r.user_id as uid,
          count(*) filter (
            where m.status = 'completed'
              and ((m.team1_player1 = r.user_id and m.winner_team = 'team1')
                or (m.team2_player1 = r.user_id and m.winner_team = 'team2'))
          )::int as wins,
          coalesce(sum(
            case
              when m.status <> 'completed' then 0
              when m.team1_player1 = r.user_id then coalesce(m.team1_score, 0) - coalesce(m.team2_score, 0)
              when m.team2_player1 = r.user_id then coalesce(m.team2_score, 0) - coalesce(m.team1_score, 0)
              else 0
            end
          ), 0)::int as point_diff
        from public.tournament_registrations r
        left join public.tournament_matches m
          on m.tournament_id = r.tournament_id
         and (m.team1_player1 = r.user_id or m.team2_player1 = r.user_id)
        where r.tournament_id = p_tournament_id
          and r.status = 'approved'
        group by r.user_id
      ),
      ranked as (
        select s.uid, p.full_name,
               row_number() over (order by s.wins desc, s.point_diff desc, coalesce(p.rating, 0) desc, p.id) as rn
          from stats s
          join public.profiles p on p.id = s.uid
      )
      select r.rn::int as place,
             null::uuid as team_id,
             r.full_name as team_name,
             array[r.uid]::uuid[] as uids,
             array[r.full_name]::text[] as user_names,
             floor(v_pool * v_structure[r.rn] / 100.0)::int as pool_share,
             floor(v_pool * v_structure[r.rn] / 100.0)::int as share_per_user,
             case r.rn when 1 then 0.500 when 2 then 0.250 when 3 then 0.100 else 0 end::numeric(6,3) as plupr_bonus
        from ranked r
       where r.rn <= v_slots
       order by r.rn;
    return;
  end if;

  if v_format in ('round_robin', 'pool_play') and v_match_type = 'doubles' then
    -- One row per doubles_pairs.id. Wins counted when the pair's two
    -- members occupy team1 or team2 (player order doesn't matter).
    return query
      with pair_uids as (
        select dp.id as pair_id, dp.name, dp.captain_id,
               dp.partner_1_id, dp.partner_2_id,
               array_remove(array[dp.partner_1_id, dp.partner_2_id], null) as uids
          from public.doubles_pairs dp
         where dp.tournament_id = p_tournament_id
           and dp.partner_1_id is not null
           and dp.partner_2_id is not null
      ),
      stats as (
        select
          pu.pair_id, pu.name, pu.uids, pu.captain_id,
          count(*) filter (
            where m.status = 'completed' and (
              (m.winner_team = 'team1'
                and ((m.team1_player1 = pu.partner_1_id and m.team1_player2 = pu.partner_2_id)
                  or (m.team1_player1 = pu.partner_2_id and m.team1_player2 = pu.partner_1_id)))
              or
              (m.winner_team = 'team2'
                and ((m.team2_player1 = pu.partner_1_id and m.team2_player2 = pu.partner_2_id)
                  or (m.team2_player1 = pu.partner_2_id and m.team2_player2 = pu.partner_1_id)))
            )
          )::int as wins,
          coalesce(sum(
            case
              when m.status <> 'completed' then 0
              when (m.team1_player1 = pu.partner_1_id and m.team1_player2 = pu.partner_2_id)
                or (m.team1_player1 = pu.partner_2_id and m.team1_player2 = pu.partner_1_id)
                then coalesce(m.team1_score, 0) - coalesce(m.team2_score, 0)
              when (m.team2_player1 = pu.partner_1_id and m.team2_player2 = pu.partner_2_id)
                or (m.team2_player1 = pu.partner_2_id and m.team2_player2 = pu.partner_1_id)
                then coalesce(m.team2_score, 0) - coalesce(m.team1_score, 0)
              else 0
            end
          ), 0)::int as point_diff
        from pair_uids pu
        left join public.tournament_matches m
          on m.tournament_id = p_tournament_id
        group by pu.pair_id, pu.name, pu.uids, pu.captain_id, pu.partner_1_id, pu.partner_2_id
      ),
      ranked as (
        select s.pair_id, s.name, s.uids,
               row_number() over (order by s.wins desc, s.point_diff desc, coalesce(cp.rating, 0) desc, s.pair_id) as rn
          from stats s
          left join public.profiles cp on cp.id = s.captain_id
      )
      select r.rn::int as place,
             r.pair_id as team_id,
             r.name as team_name,
             r.uids as uids,
             (select array_agg(p.full_name order by p.full_name)
                from public.profiles p where p.id = any(r.uids)) as user_names,
             floor(v_pool * v_structure[r.rn] / 100.0)::int as pool_share,
             floor(floor(v_pool * v_structure[r.rn] / 100.0) / array_length(r.uids, 1))::int as share_per_user,
             case r.rn when 1 then 0.500 when 2 then 0.250 when 3 then 0.100 else 0 end::numeric(6,3) as plupr_bonus
        from ranked r
       where r.rn <= v_slots
       order by r.rn;
    return;
  end if;

  if v_format = 'rotating_partners' then
    -- Wins per INDIVIDUAL player (regardless of partner).
    return query
      with stats as (
        select
          r.user_id as uid,
          count(*) filter (
            where m.status = 'completed' and (
              (m.winner_team = 'team1' and (m.team1_player1 = r.user_id or m.team1_player2 = r.user_id))
              or
              (m.winner_team = 'team2' and (m.team2_player1 = r.user_id or m.team2_player2 = r.user_id))
            )
          )::int as wins,
          coalesce(sum(
            case
              when m.status <> 'completed' then 0
              when m.team1_player1 = r.user_id or m.team1_player2 = r.user_id
                then coalesce(m.team1_score, 0) - coalesce(m.team2_score, 0)
              when m.team2_player1 = r.user_id or m.team2_player2 = r.user_id
                then coalesce(m.team2_score, 0) - coalesce(m.team1_score, 0)
              else 0
            end
          ), 0)::int as point_diff
        from public.tournament_registrations r
        left join public.tournament_matches m
          on m.tournament_id = r.tournament_id
         and (m.team1_player1 = r.user_id or m.team1_player2 = r.user_id
           or m.team2_player1 = r.user_id or m.team2_player2 = r.user_id)
        where r.tournament_id = p_tournament_id
          and r.status = 'approved'
        group by r.user_id
      ),
      ranked as (
        select s.uid, p.full_name,
               row_number() over (order by s.wins desc, s.point_diff desc, coalesce(p.rating, 0) desc, p.id) as rn
          from stats s
          join public.profiles p on p.id = s.uid
      )
      select r.rn::int as place,
             null::uuid as team_id,
             r.full_name as team_name,
             array[r.uid]::uuid[] as uids,
             array[r.full_name]::text[] as user_names,
             floor(v_pool * v_structure[r.rn] / 100.0)::int as pool_share,
             floor(v_pool * v_structure[r.rn] / 100.0)::int as share_per_user,
             case r.rn when 1 then 0.500 when 2 then 0.250 when 3 then 0.100 else 0 end::numeric(6,3) as plupr_bonus
        from ranked r
       where r.rn <= v_slots
       order by r.rn;
    return;
  end if;
end;
$$;


-- 2. Auto-close trigger for non-elim formats --------------------------------
--    When every tournament_match for the tournament reaches status='completed'
--    AND the format is round_robin / pool_play / rotating_partners AND the
--    tournament is currently 'active', flip status to 'completed'.
--    Body wrapped in EXCEPTION WHEN OTHERS so a quirky state can never block
--    the underlying score update.
create or replace function public._maybe_auto_close_non_elim_tournament()
returns trigger language plpgsql security definer as $$
declare
  v_format   text;
  v_status   text;
  v_pending  integer;
begin
  if new.status <> 'completed' then return new; end if;
  if TG_OP = 'UPDATE' and old.status = 'completed' then return new; end if;

  begin
    select format, status into v_format, v_status
      from public.tournaments where id = new.tournament_id;

    if v_format not in ('round_robin', 'pool_play', 'rotating_partners') then
      return new;
    end if;
    if v_status <> 'active' then return new; end if;

    select count(*) into v_pending
      from public.tournament_matches
     where tournament_id = new.tournament_id
       and status <> 'completed';

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
$$;


-- Single trigger covering all three non-elim formats; the function
-- does the format gating internally. Stale per-format trigger rows
-- from earlier installs (one per format) get dropped if present.
drop trigger if exists trg_auto_close_round_robin_tournament       on public.tournament_matches;
drop trigger if exists trg_auto_close_pool_play_tournament         on public.tournament_matches;
drop trigger if exists trg_auto_close_rotating_partners_tournament on public.tournament_matches;
drop trigger if exists trg_auto_close_non_elim_tournament          on public.tournament_matches;
create trigger trg_auto_close_non_elim_tournament
  after insert or update of status on public.tournament_matches
  for each row execute procedure public._maybe_auto_close_non_elim_tournament();


-- 3. Grants ----------------------------------------------------------------
grant execute on function public.preview_tournament_payout(uuid)                to authenticated;
grant execute on function public._maybe_auto_close_non_elim_tournament()        to authenticated;

notify pgrst, 'reload schema';
