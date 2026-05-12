-- ============================================================
-- Match confirmation flow.
--
-- New lifecycle for matches:
--   1. Insert as status='pending', confirm_deadline = now() + 1 hour.
--      The entering user auto-confirms their team.
--   2. Notification fires to every OTHER player on the match.
--   3. At least one player from the OTHER team must call confirm_match.
--      When both teams have a confirmer, status flips to 'completed'
--      and PLUPRs apply.
--   4. If confirm_deadline passes without both teams confirming, a
--      cron job DELETES the row. The match never happened.
--
-- The PLUPR trigger is refactored so the math runs once at entry time
-- (locking in the players' ratings AT THE MOMENT of play), gets saved
-- on the row as pending_delta1/2, and is actually applied only when
-- status transitions to 'completed'.
-- ============================================================


-- 1. Schema additions -----------------------------------------------------
alter table public.matches
  add column if not exists team1_confirmed_by uuid references public.profiles(id) on delete set null,
  add column if not exists team2_confirmed_by uuid references public.profiles(id) on delete set null,
  add column if not exists confirm_deadline   timestamptz,
  add column if not exists pending_delta1     decimal(6,3),
  add column if not exists pending_delta2     decimal(6,3);

alter table public.matches drop constraint if exists matches_status_check;
alter table public.matches add constraint matches_status_check
  check (status in ('pending', 'scheduled', 'completed'));

create index if not exists matches_pending_deadline_idx
  on public.matches (status, confirm_deadline)
  where status = 'pending';


-- 2. Internal: apply pre-computed deltas + category to all 4 players ------
create or replace function public._apply_match_deltas_to_players(
  p_league_id    uuid,
  p_player1_id   uuid, p_partner1_id uuid,
  p_player2_id   uuid, p_partner2_id uuid,
  p_match_type   text,
  p_cat          text,    -- 'singles' | 'gendered' | 'mixed' | null
  p_delta1       decimal,
  p_delta2       decimal
) returns void language plpgsql security definer as $$
declare
  GLOBAL_WEIGHT constant decimal := 0.5;
  v_singles_cat text := case when p_match_type = 'singles' then 'singles' else p_cat end;
begin
  -- League PLUPR: full delta on all 4 players
  perform public._apply_plupr_delta_to_league(p_league_id, p_player1_id, p_delta1, v_singles_cat);
  perform public._apply_plupr_delta_to_league(p_league_id, p_player2_id, p_delta2, v_singles_cat);
  if p_match_type = 'doubles' then
    if p_partner1_id is not null then perform public._apply_plupr_delta_to_league(p_league_id, p_partner1_id, p_delta1, p_cat); end if;
    if p_partner2_id is not null then perform public._apply_plupr_delta_to_league(p_league_id, p_partner2_id, p_delta2, p_cat); end if;
  end if;

  -- Global PLUPR: 0.5x delta (league matches dilute global)
  perform public._apply_plupr_delta_to_global(p_player1_id, p_delta1 * GLOBAL_WEIGHT, v_singles_cat);
  perform public._apply_plupr_delta_to_global(p_player2_id, p_delta2 * GLOBAL_WEIGHT, v_singles_cat);
  if p_match_type = 'doubles' then
    if p_partner1_id is not null then perform public._apply_plupr_delta_to_global(p_partner1_id, p_delta1 * GLOBAL_WEIGHT, p_cat); end if;
    if p_partner2_id is not null then perform public._apply_plupr_delta_to_global(p_partner2_id, p_delta2 * GLOBAL_WEIGHT, p_cat); end if;
  end if;

  -- Bump total_matches_played so "Not Rated" flips to a real rating display.
  update public.profiles set total_matches_played = coalesce(total_matches_played, 0) + 1,
                              last_match_at = now()
   where id in (p_player1_id, p_player2_id);
  if p_match_type = 'doubles' then
    update public.profiles set total_matches_played = coalesce(total_matches_played, 0) + 1,
                                last_match_at = now()
     where id in (p_partner1_id, p_partner2_id) and id is not null;
  end if;
end;
$$;


-- 3. Rewritten PLUPR trigger (handles INSERT and UPDATE) ------------------
create or replace function public.update_plupr_ratings()
returns trigger language plpgsql security definer as $$
declare
  PLUPR_FLOOR   constant decimal := 2.000;
  PLUPR_DIV     constant decimal := 2.0;
  GLOBAL_WEIGHT constant decimal := 0.5;
  r1            decimal; r_p1 decimal := 3.250;
  r2            decimal; r_p2 decimal := 3.250;
  team1_avg     decimal; team2_avg decimal;
  expected1     decimal;
  k_factor      decimal;
  margin_factor decimal;
  win_score     integer; loss_score integer;
  delta1        decimal; delta2 decimal;
  won1          boolean;
  cat           text;
  p1_count      integer;
begin
  -- ── INSERT path: compute deltas + snapshots; apply only if completed ──
  if TG_OP = 'INSERT' then
    select rating into r1 from public.profiles where id = new.player1_id;
    select rating into r2 from public.profiles where id = new.player2_id;

    if new.match_type = 'doubles' then
      if new.partner1_id is not null then select rating into r_p1 from public.profiles where id = new.partner1_id; end if;
      if new.partner2_id is not null then select rating into r_p2 from public.profiles where id = new.partner2_id; end if;
      team1_avg := (r1 + r_p1) / 2.0;
      team2_avg := (r2 + r_p2) / 2.0;
      cat := public.classify_doubles_match(new.player1_id, new.partner1_id, new.player2_id, new.partner2_id);
      new.doubles_category := cat;
    else
      team1_avg := r1; team2_avg := r2;
      new.doubles_category := null; cat := null;
    end if;

    new.player1_rating_before := r1;
    new.player2_rating_before := r2;

    -- Unspecified doubles: no rating impact regardless of status
    if new.match_type = 'doubles' and cat = 'unspecified' then
      new.player1_rating_after := r1;
      new.player2_rating_after := r2;
      new.pending_delta1 := 0;
      new.pending_delta2 := 0;
      return new;
    end if;

    -- Compute deltas using current ratings.
    select coalesce(total_matches_played, 0) into p1_count from public.profiles where id = new.player1_id;
    if    p1_count <  5 then k_factor := 0.20;
    elsif p1_count < 15 then k_factor := 0.12;
    else                     k_factor := 0.06;
    end if;

    won1 := (new.winner_team = 'team1') or (new.winner_id = new.player1_id);
    if won1 then win_score := coalesce(new.player1_score, 11); loss_score := coalesce(new.player2_score, 0);
    else         win_score := coalesce(new.player2_score, 11); loss_score := coalesce(new.player1_score, 0);
    end if;
    margin_factor := 0.6 + greatest(0, win_score - loss_score)::decimal / greatest(win_score, 1) * 0.4;

    expected1 := 1.0 / (1.0 + power(10.0, (team2_avg - team1_avg) / PLUPR_DIV));
    delta1 := round((k_factor * margin_factor * (case when won1 then 1.0 - expected1 else 0.0 - expected1 end))::numeric, 3);
    delta2 := -delta1;

    -- Snapshot for history + later replay on confirmation.
    new.player1_rating_after := greatest(PLUPR_FLOOR, r1 + delta1 * GLOBAL_WEIGHT);
    new.player2_rating_after := greatest(PLUPR_FLOOR, r2 + delta2 * GLOBAL_WEIGHT);
    new.pending_delta1 := delta1;
    new.pending_delta2 := delta2;

    -- Only apply NOW if the row goes in already-completed (backwards compat
    -- for tests or admin direct inserts). Pending/scheduled defers application.
    if new.status = 'completed' then
      perform public._apply_match_deltas_to_players(
        new.league_id,
        new.player1_id, new.partner1_id, new.player2_id, new.partner2_id,
        new.match_type, cat, delta1, delta2
      );
    end if;

    return new;
  end if;

  -- ── UPDATE path: apply stored deltas when transitioning to completed ──
  if TG_OP = 'UPDATE' and old.status = 'pending' and new.status = 'completed' then
    -- Only act if the row actually has deltas (skip unspecified-doubles rows).
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
$$;

drop trigger if exists on_match_completed on public.matches;
create trigger on_match_completed
  before insert or update on public.matches
  for each row execute procedure public.update_plupr_ratings();


-- 4. Notification trigger on pending insert -------------------------------
create or replace function public._notify_pending_match()
returns trigger language plpgsql security definer as $$
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

  -- Notify every OTHER player on the match.
  v_others := array_remove(array[new.player1_id, new.partner1_id, new.player2_id, new.partner2_id],
                           coalesce(new.team1_confirmed_by, new.team2_confirmed_by));
  v_others := array_remove(v_others, null);

  foreach v_recipient in array v_others loop
    if v_recipient is null then continue; end if;
    -- Skip notifying the auto-confirmer (already in the loop above via array_remove,
    -- but double-check).
    if v_recipient = new.team1_confirmed_by or v_recipient = new.team2_confirmed_by then continue; end if;
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, is_read)
    values (
      v_recipient,
      '🏓 Match needs your team to confirm',
      format('%s entered a match in %s. Open match history to confirm within an hour.',
             coalesce(v_entering, 'A player'), coalesce(v_league, 'a league')),
      'match', new.id, 'match', false
    );
  end loop;

  return new;
exception when others then
  -- Don't block the insert if notifications fail.
  return new;
end;
$$;

drop trigger if exists on_match_pending_notify on public.matches;
create trigger on_match_pending_notify
  after insert on public.matches
  for each row execute procedure public._notify_pending_match();


-- 5. confirm_match RPC ----------------------------------------------------
create or replace function public.confirm_match(p_match_id uuid)
returns text language plpgsql security definer as $$
declare
  v_uid    uuid := auth.uid();
  v_match  record;
  v_team   text;          -- 'team1' | 'team2' | null
  v_both   boolean := false;
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

  -- Which team is the caller on?
  if    v_uid in (v_match.player1_id, v_match.partner1_id) then v_team := 'team1';
  elsif v_uid in (v_match.player2_id, v_match.partner2_id) then v_team := 'team2';
  else  raise exception 'Only players on this match can confirm it';
  end if;

  -- Record the confirmer (overwrites any prior team-mate confirmer harmlessly).
  if v_team = 'team1' then
    update public.matches set team1_confirmed_by = v_uid where id = p_match_id;
  else
    update public.matches set team2_confirmed_by = v_uid where id = p_match_id;
  end if;

  -- Both teams confirmed? Flip to completed (triggers PLUPR apply).
  select (team1_confirmed_by is not null and team2_confirmed_by is not null)
    into v_both from public.matches where id = p_match_id;
  if v_both then
    update public.matches set status = 'completed' where id = p_match_id;
    return 'completed';
  end if;
  return 'one_team_confirmed';
end;
$$;

grant execute on function public.confirm_match(uuid) to authenticated;


-- 6. expire_pending_matches: cron-driven cleanup --------------------------
create or replace function public.expire_pending_matches()
returns integer language plpgsql security definer as $$
declare
  v_deleted integer;
begin
  delete from public.matches
   where status = 'pending'
     and confirm_deadline is not null
     and confirm_deadline < now();
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

grant execute on function public.expire_pending_matches() to authenticated;

-- pg_cron schedule: every minute. Drop any prior schedule first.
do $$
declare v_jobid bigint;
begin
  select jobid into v_jobid from cron.job where jobname = 'pickleague-expire-pending-matches';
  if v_jobid is not null then perform cron.unschedule(v_jobid); end if;
end$$;

select cron.schedule(
  'pickleague-expire-pending-matches',
  '* * * * *',
  $cmd$ select public.expire_pending_matches(); $cmd$
);
