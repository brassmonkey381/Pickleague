-- ============================================================
-- Auto-advance MLP playoff. When the last pool/RR match in a
-- playoff-variant tournament flips to 'completed', the playoff
-- rounds are generated automatically — no admin button needed.
--
-- Internals:
--   * _generate_mlp_playoff_unchecked: same body as generate_mlp_playoff
--     but skips the auth.uid() admin check. Trigger-safe.
--   * generate_mlp_playoff: keeps the public auth-gated entry point so
--     admins can still re-trigger manually if something went wrong.
--   * _maybe_auto_advance_mlp_playoff: AFTER UPDATE trigger on
--     tournament_matches. Catches the pool/RR → completed transition,
--     checks if all sibling pool/RR matches are done, and then calls
--     _generate_mlp_playoff_unchecked. Wrapped in EXCEPTION so a
--     failure here never blocks the score update.
-- ============================================================


-- 1. Unchecked version of generate_mlp_playoff -------------------------
create or replace function public._generate_mlp_playoff_unchecked(p_tournament_id uuid)
returns integer language plpgsql security definer as $$
declare
  v_format        text;
  v_pool_count    integer;
  v_playoff_n     integer;
  v_uncompleted   integer;
  v_advanced      uuid[];
  v_team_a        record;
  v_team_b        record;
  v_round_id      uuid;
  v_match_order   integer := 0;
  v_matches       integer := 0;
  v_label         text;
  v_team_count    integer;
  v_top_per_pool  integer;
  v_i             integer;
begin
  select coalesce(mlp_play_format, 'round_robin'),
         coalesce(mlp_pool_count, 2),
         coalesce(mlp_playoff_teams, 4)
    into v_format, v_pool_count, v_playoff_n
    from public.tournaments where id = p_tournament_id;

  if v_format not in ('round_robin_playoff', 'pool_play_playoff') then
    raise exception 'Tournament format % does not include a playoff stage', v_format;
  end if;

  select count(*) into v_uncompleted
    from public.tournament_matches tm
    join public.tournament_rounds tr on tr.id = tm.round_id
   where tm.tournament_id = p_tournament_id
     and tr.round_type in ('pool', 'winners')
     and tm.status <> 'completed';
  if v_uncompleted > 0 then
    raise exception 'Cannot advance — % pool/round-robin matches still pending', v_uncompleted;
  end if;

  if exists (
    select 1 from public.tournament_rounds
     where tournament_id = p_tournament_id
       and round_type in ('quarterfinals', 'semifinals', 'finals')
  ) then
    raise exception 'Playoff already generated.';
  end if;

  if v_format = 'round_robin_playoff' then
    select array_agg(team_id order by sub_matches_won desc, sub_matches_lost asc, seed)
      into v_advanced
      from (select * from public.mlp_team_standings(p_tournament_id) limit v_playoff_n) s;
  else
    v_top_per_pool := greatest(1, v_playoff_n / v_pool_count);
    with ranked as (
      select team_id, pool_letter, sub_matches_won, sub_matches_lost, seed,
             row_number() over (partition by pool_letter
                                order by sub_matches_won desc, sub_matches_lost asc, seed) as pool_rank
        from public.mlp_team_standings(p_tournament_id)
    )
    select array_agg(team_id order by pool_rank, pool_letter)
      into v_advanced
      from ranked where pool_rank <= v_top_per_pool;
    if array_length(v_advanced, 1) > v_playoff_n then
      v_advanced := v_advanced[1:v_playoff_n];
    end if;
  end if;

  v_team_count := coalesce(array_length(v_advanced, 1), 0);
  if v_team_count < 2 then
    raise exception 'Not enough teams to seed a playoff (got %)', v_team_count;
  end if;

  v_label := case v_team_count
    when 8 then 'Quarterfinals'
    when 4 then 'Semifinals'
    when 2 then 'Finals'
    else format('Playoff Round of %s', v_team_count)
  end;

  for v_i in 0..(v_team_count / 2 - 1) loop
    select * into v_team_a from public.mlp_teams where id = v_advanced[v_i + 1];
    select * into v_team_b from public.mlp_teams where id = v_advanced[v_team_count - v_i];

    insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
    values (
      p_tournament_id,
      1000 + v_i + 1,
      format('%s · %s vs %s', v_label, v_team_a.name, v_team_b.name),
      case v_team_count
        when 8 then 'quarterfinals'
        when 4 then 'semifinals'
        when 2 then 'finals'
        else 'winners'
      end
    )
    returning id into v_round_id;

    v_match_order := public._insert_mlp_pairing_matches(p_tournament_id, v_round_id, v_team_a, v_team_b, v_match_order);
    v_matches := v_matches + 4;
  end loop;

  return v_matches;
end;
$$;


-- 2. Auth-gated entry point delegates to the unchecked version ---------
create or replace function public.generate_mlp_playoff(p_tournament_id uuid)
returns integer language plpgsql security definer as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if not public._is_tournament_admin(p_tournament_id, v_uid) then
    raise exception 'Only tournament admins can advance to playoffs';
  end if;
  return public._generate_mlp_playoff_unchecked(p_tournament_id);
end;
$$;

grant execute on function public.generate_mlp_playoff(uuid) to authenticated;


-- 3. Trigger: after a pool/RR match completes, maybe auto-advance ------
create or replace function public._maybe_auto_advance_mlp_playoff()
returns trigger language plpgsql security definer as $$
declare
  v_format       text;
  v_uncompleted  integer;
  v_has_playoff  boolean;
  v_round_type   text;
begin
  -- Only act on transition to 'completed'.
  if new.status <> 'completed' then return new; end if;
  if TG_OP = 'UPDATE' and old.status = 'completed' then return new; end if;

  -- Cheap early bail: tournament must be in a playoff variant.
  select coalesce(mlp_play_format, 'round_robin') into v_format
    from public.tournaments where id = new.tournament_id;
  if v_format not in ('round_robin_playoff', 'pool_play_playoff') then return new; end if;

  -- This match must be a pool/RR match (not playoff itself).
  select round_type into v_round_type
    from public.tournament_rounds where id = new.round_id;
  if v_round_type not in ('pool', 'winners') then return new; end if;

  -- Any pool/RR matches still pending?
  select count(*) into v_uncompleted
    from public.tournament_matches tm
    join public.tournament_rounds tr on tr.id = tm.round_id
   where tm.tournament_id = new.tournament_id
     and tr.round_type in ('pool', 'winners')
     and tm.status <> 'completed';
  if v_uncompleted > 0 then return new; end if;

  -- Playoff already generated?
  select exists (
    select 1 from public.tournament_rounds
     where tournament_id = new.tournament_id
       and round_type in ('quarterfinals', 'semifinals', 'finals')
  ) into v_has_playoff;
  if v_has_playoff then return new; end if;

  -- All conditions met. Generate. Don't fail the parent UPDATE if this errors.
  begin
    perform public._generate_mlp_playoff_unchecked(new.tournament_id);
  exception when others then
    -- eslint-disable-next-line — non-fatal
    null;
  end;

  return new;
end;
$$;

drop trigger if exists on_pool_match_completed_advance on public.tournament_matches;
create trigger on_pool_match_completed_advance
  after insert or update of status on public.tournament_matches
  for each row execute procedure public._maybe_auto_advance_mlp_playoff();
