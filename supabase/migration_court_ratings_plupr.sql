-- Court ratings on the PLUPR system (not ELO).
--
-- player_location_ratings.rating is already decimal(6,3) default 3.250, but the
-- update trigger still computed classic ELO (K=32, ÷400, base 1000). This swaps
-- it to the same PLUPR margin-of-victory model as the main rating, and recomputes
-- all existing court ratings from match history on the new scale.
--
-- Reuses _plupr_expected_diff (10*tanh((t1-t2)/1.0)) from the main PLUPR migration.

-- ── Shared per-match court update (trigger + recompute both call this) ─────
create or replace function public._apply_court_plupr_for_match(m public.matches)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  PLUPR_FLOOR constant decimal := 2.000;
  BASE        constant decimal := 3.250;
  v_loc          text;
  v_bucket       text;
  v_cat          text;
  r1 decimal; r_p1 decimal := BASE;
  r2 decimal; r_p2 decimal := BASE;
  team1_avg decimal; team2_avg decimal;
  expected_diff  decimal;
  s1 int; s2 int;
  surprise decimal;
  k_factor decimal;
  p1_court_count int;
  delta1 decimal; delta2 decimal;
  won1 boolean;
begin
  v_loc := m.location_name;
  if v_loc is null or length(btrim(v_loc)) = 0 then
    return;
  end if;

  if m.match_type = 'singles' then
    v_bucket := 'singles';
  elsif m.match_type = 'doubles' then
    v_cat := m.doubles_category;
    if    v_cat = 'mixed'                         then v_bucket := 'doubles_mixed';
    elsif v_cat in ('mens', 'womens', 'gendered') then v_bucket := 'doubles_gendered';
    else  return;
    end if;
  else
    return;
  end if;

  -- Current court ratings (default → baseline).
  select rating into r1 from public.player_location_ratings
   where user_id = m.player1_id and location_name = v_loc and match_type = v_bucket;
  r1 := coalesce(r1, BASE);
  select rating into r2 from public.player_location_ratings
   where user_id = m.player2_id and location_name = v_loc and match_type = v_bucket;
  r2 := coalesce(r2, BASE);

  if m.match_type = 'doubles' then
    if m.partner1_id is not null then
      select rating into r_p1 from public.player_location_ratings
       where user_id = m.partner1_id and location_name = v_loc and match_type = v_bucket;
      r_p1 := coalesce(r_p1, BASE);
    end if;
    if m.partner2_id is not null then
      select rating into r_p2 from public.player_location_ratings
       where user_id = m.partner2_id and location_name = v_loc and match_type = v_bucket;
      r_p2 := coalesce(r_p2, BASE);
    end if;
    team1_avg := (r1 + r_p1) / 2.0;
    team2_avg := (r2 + r_p2) / 2.0;
  else
    team1_avg := r1;
    team2_avg := r2;
  end if;

  won1 := (m.winner_team = 'team1') or (m.winner_id = m.player1_id);

  -- K decays with player1's experience AT THIS court + bucket.
  select coalesce(wins, 0) + coalesce(losses, 0) into p1_court_count
    from public.player_location_ratings
   where user_id = m.player1_id and location_name = v_loc and match_type = v_bucket;
  p1_court_count := coalesce(p1_court_count, 0);
  if    p1_court_count <  5  then k_factor := 0.20;
  elsif p1_court_count < 15  then k_factor := 0.12;
  else                            k_factor := 0.06;
  end if;

  -- Default to 11-7 by winner when scores are missing (typical game, not a shutout).
  if won1 then
    s1 := coalesce(m.player1_score, 11); s2 := coalesce(m.player2_score, 7);
  else
    s1 := coalesce(m.player1_score, 7);  s2 := coalesce(m.player2_score, 11);
  end if;

  expected_diff := public._plupr_expected_diff(team1_avg, team2_avg);
  surprise      := ((s1 - s2)::decimal - expected_diff) / 10.0;
  delta1        := round((k_factor * surprise)::numeric, 3);
  delta2        := -delta1;

  -- Team 1 (player1 + partner1) take delta1; team 2 take delta2.
  if m.player1_id is not null then
    insert into public.player_location_ratings (user_id, location_name, match_type, rating, wins, losses, updated_at)
    values (m.player1_id, v_loc, v_bucket, greatest(PLUPR_FLOOR, BASE + delta1),
            case when won1 then 1 else 0 end, case when won1 then 0 else 1 end, now())
    on conflict (user_id, location_name, match_type) do update
      set rating     = greatest(PLUPR_FLOOR, public.player_location_ratings.rating + delta1),
          wins       = public.player_location_ratings.wins   + case when won1 then 1 else 0 end,
          losses     = public.player_location_ratings.losses + case when won1 then 0 else 1 end,
          updated_at = now();
  end if;

  if m.match_type = 'doubles' and m.partner1_id is not null then
    insert into public.player_location_ratings (user_id, location_name, match_type, rating, wins, losses, updated_at)
    values (m.partner1_id, v_loc, v_bucket, greatest(PLUPR_FLOOR, BASE + delta1),
            case when won1 then 1 else 0 end, case when won1 then 0 else 1 end, now())
    on conflict (user_id, location_name, match_type) do update
      set rating     = greatest(PLUPR_FLOOR, public.player_location_ratings.rating + delta1),
          wins       = public.player_location_ratings.wins   + case when won1 then 1 else 0 end,
          losses     = public.player_location_ratings.losses + case when won1 then 0 else 1 end,
          updated_at = now();
  end if;

  if m.player2_id is not null then
    insert into public.player_location_ratings (user_id, location_name, match_type, rating, wins, losses, updated_at)
    values (m.player2_id, v_loc, v_bucket, greatest(PLUPR_FLOOR, BASE + delta2),
            case when won1 then 0 else 1 end, case when won1 then 1 else 0 end, now())
    on conflict (user_id, location_name, match_type) do update
      set rating     = greatest(PLUPR_FLOOR, public.player_location_ratings.rating + delta2),
          wins       = public.player_location_ratings.wins   + case when won1 then 0 else 1 end,
          losses     = public.player_location_ratings.losses + case when won1 then 1 else 0 end,
          updated_at = now();
  end if;

  if m.match_type = 'doubles' and m.partner2_id is not null then
    insert into public.player_location_ratings (user_id, location_name, match_type, rating, wins, losses, updated_at)
    values (m.partner2_id, v_loc, v_bucket, greatest(PLUPR_FLOOR, BASE + delta2),
            case when won1 then 0 else 1 end, case when won1 then 1 else 0 end, now())
    on conflict (user_id, location_name, match_type) do update
      set rating     = greatest(PLUPR_FLOOR, public.player_location_ratings.rating + delta2),
          wins       = public.player_location_ratings.wins   + case when won1 then 0 else 1 end,
          losses     = public.player_location_ratings.losses + case when won1 then 1 else 0 end,
          updated_at = now();
  end if;
end;
$$;

-- ── Trigger: apply on a match becoming completed (PLUPR now) ───────────────
create or replace function public._update_court_ratings()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    if not (
      (TG_OP = 'UPDATE' and coalesce(old.status, '') = 'pending' and new.status = 'completed')
      or (TG_OP = 'INSERT' and new.status = 'completed')
    ) then
      return new;
    end if;
    perform public._apply_court_plupr_for_match(new);
    return new;
  exception when others then
    raise warning '_update_court_ratings failed for match %: % / %', new.id, sqlstate, sqlerrm;
    return new;
  end;
end;
$$;

drop trigger if exists trg_update_court_ratings on public.matches;
create trigger trg_update_court_ratings
  after insert or update of status on public.matches
  for each row execute procedure public._update_court_ratings();

-- ── Recompute all court ratings from history on the PLUPR scale ────────────
create or replace function public.recompute_court_plupr()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare m public.matches;
begin
  truncate public.player_location_ratings;
  for m in
    select * from public.matches
    where status = 'completed'
      and location_name is not null
      and length(btrim(location_name)) > 0
    order by played_at nulls last, created_at
  loop
    perform public._apply_court_plupr_for_match(m);
  end loop;
end;
$$;

select public.recompute_court_plupr();
