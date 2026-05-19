-- ============================================================
-- Wagering foundation (Unit 1 of 4)
--
-- House-model wagers in pickles. The app sets odds via PLUPR-based
-- math, takes the other side, and auto-settles via DB triggers when
-- the underlying event resolves.
--
-- Subjects in v1:
--   match              — winner team
--   tournament_match   — winner team
--   match_score        — exact final score
--   tournament_match_score — exact final score
--   tournament_rank    — finishing rank (v1: rank=1 only)
--   period_rank        — season-period rank (v1: rank=1 only)
--   season_rank        — season-wide rank
-- ============================================================


-- 0. Allow 'wager' as a notifications.type value.
-- ----------------------------------------------------------------------
alter table public.notifications
  drop constraint if exists notifications_type_check;
alter table public.notifications
  add constraint notifications_type_check
  check (type in ('info','tournament','league','match','drill','wager'));


-- 1. wagers table.
-- ----------------------------------------------------------------------
create table if not exists public.wagers (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles(id) on delete cascade,
  subject_type     text not null check (subject_type in (
                     'match','tournament_match','tournament_rank',
                     'period_rank','season_rank','match_score','tournament_match_score'
                   )),
  subject_id       uuid not null,
  predicate        jsonb not null,
  stake            int not null check (stake > 0),
  odds             numeric(6,3) not null check (odds >= 1),
  potential_payout int not null check (potential_payout >= stake),
  status           text not null default 'open'
                     check (status in ('open','won','lost','cancelled')),
  placed_at        timestamptz not null default now(),
  settled_at       timestamptz,
  notes            text
);
create index if not exists wagers_user_status_idx on public.wagers (user_id, status);
create index if not exists wagers_open_subject_idx
  on public.wagers (subject_type, subject_id) where status = 'open';

alter table public.wagers enable row level security;
drop policy if exists "Users see own wagers" on public.wagers;
create policy "Users see own wagers" on public.wagers
  for select using (auth.uid() = user_id);


-- 2. calculate_wager_odds — pure read, used by client + place_wager.
-- ----------------------------------------------------------------------
-- Probability model:
--   match / tournament_match (winner_team):
--     Bradley-Terry on average PLUPR of involved players.
--     p(team1_wins) = 1 / (1 + 10^((avg_team2 - avg_team1) * 0.5))
--   tournament_rank (rank=1):
--     softmax over profiles.rating of approved registrations (temp 0.3).
--   period_rank / season_rank (rank=1):
--     softmax over league_player_ratings.rating of league_members
--     (fallback profiles.rating, fallback 3.5).
--   *_score:
--     winner-prob (as above) * score-density factor (predicate score).
--
-- 5% house edge. Floor 0.02, ceil 0.95.
-- odds = round((1 - 0.05) / probability, 3).
-- ----------------------------------------------------------------------
create or replace function public.calculate_wager_odds(
  p_subject_type text,
  p_subject_id   uuid,
  p_predicate    jsonb
) returns table(probability numeric, odds numeric)
language plpgsql security definer set search_path = public as $$
declare
  v_house_edge   numeric := 0.05;
  v_prob         numeric;
  v_temp         numeric := 0.3;
  v_avg1         numeric;
  v_avg2         numeric;
  v_p1           numeric;  -- p(team1 wins)
  v_picked       text;
  v_user_id      uuid;
  v_rank         int;
  v_score1       int;
  v_score2       int;
  v_density      numeric;
  v_winner_team  text;
  v_period_no    int;
  v_season_id    uuid;
  v_tournament_id uuid;
  v_league_id    uuid;
  v_sum_exp      numeric;
  v_user_exp     numeric;
  v_user_rating  numeric;
  v_rec          record;
begin
  if p_subject_type in ('match','match_score') then
    select
      ( coalesce(p1.rating, 3.5)
        + coalesce(prt.rating, coalesce(p1.rating, 3.5)) ) / 2.0,
      ( coalesce(p2.rating, 3.5)
        + coalesce(prt2.rating, coalesce(p2.rating, 3.5)) ) / 2.0
      into v_avg1, v_avg2
      from public.matches m
      left join public.profiles p1   on p1.id   = m.player1_id
      left join public.profiles prt  on prt.id  = m.partner1_id
      left join public.profiles p2   on p2.id   = m.player2_id
      left join public.profiles prt2 on prt2.id = m.partner2_id
      where m.id = p_subject_id;

    if v_avg1 is null then
      return query select 0.5::numeric, 1.90::numeric;
      return;
    end if;

    v_p1 := 1.0 / (1.0 + power(10.0, (v_avg2 - v_avg1) * 0.5));

    if p_subject_type = 'match' then
      v_picked := p_predicate->>'winner_team';
      v_prob := case when v_picked = 'team1' then v_p1 else 1.0 - v_p1 end;
    else
      v_score1 := (p_predicate->>'team1_score')::int;
      v_score2 := (p_predicate->>'team2_score')::int;
      v_winner_team := case when v_score1 > v_score2 then 'team1' else 'team2' end;
      v_density := public._wager_score_density(v_score1, v_score2);
      v_prob := (case when v_winner_team = 'team1' then v_p1 else 1.0 - v_p1 end) * v_density;
    end if;

  elsif p_subject_type in ('tournament_match','tournament_match_score') then
    select
      ( coalesce(p1.rating, 3.5)
        + coalesce(prt.rating, coalesce(p1.rating, 3.5)) ) / 2.0,
      ( coalesce(p2.rating, 3.5)
        + coalesce(prt2.rating, coalesce(p2.rating, 3.5)) ) / 2.0
      into v_avg1, v_avg2
      from public.tournament_matches tm
      left join public.profiles p1   on p1.id   = tm.team1_player1
      left join public.profiles prt  on prt.id  = tm.team1_player2
      left join public.profiles p2   on p2.id   = tm.team2_player1
      left join public.profiles prt2 on prt2.id = tm.team2_player2
      where tm.id = p_subject_id;

    if v_avg1 is null then
      return query select 0.5::numeric, 1.90::numeric;
      return;
    end if;

    v_p1 := 1.0 / (1.0 + power(10.0, (v_avg2 - v_avg1) * 0.5));

    if p_subject_type = 'tournament_match' then
      v_picked := p_predicate->>'winner_team';
      v_prob := case when v_picked = 'team1' then v_p1 else 1.0 - v_p1 end;
    else
      v_score1 := (p_predicate->>'team1_score')::int;
      v_score2 := (p_predicate->>'team2_score')::int;
      v_winner_team := case when v_score1 > v_score2 then 'team1' else 'team2' end;
      v_density := public._wager_score_density(v_score1, v_score2);
      v_prob := (case when v_winner_team = 'team1' then v_p1 else 1.0 - v_p1 end) * v_density;
    end if;

  elsif p_subject_type = 'tournament_rank' then
    v_user_id := (p_predicate->>'user_id')::uuid;
    v_rank    := coalesce((p_predicate->>'rank')::int, 1);
    -- Softmax across approved registrants' profiles.rating.
    select sum(exp(coalesce(p.rating, 3.5) / v_temp))
      into v_sum_exp
      from public.tournament_registrations tr
      join public.profiles p on p.id = tr.user_id
     where tr.tournament_id = p_subject_id
       and tr.status = 'approved';

    select exp(coalesce(p.rating, 3.5) / v_temp)
      into v_user_exp
      from public.tournament_registrations tr
      join public.profiles p on p.id = tr.user_id
     where tr.tournament_id = p_subject_id
       and tr.status = 'approved'
       and tr.user_id = v_user_id;

    if v_sum_exp is null or v_sum_exp = 0 or v_user_exp is null then
      v_prob := 0.05;
    else
      v_prob := v_user_exp / v_sum_exp;
      -- v1 only supports rank=1 cleanly; for higher ranks shave probability.
      if v_rank > 1 then
        v_prob := v_prob * power(0.5, v_rank - 1);
      end if;
    end if;

  elsif p_subject_type in ('period_rank','season_rank') then
    v_user_id := (p_predicate->>'user_id')::uuid;
    v_rank    := coalesce((p_predicate->>'rank')::int, 1);
    select league_id into v_league_id
      from public.league_seasons where id = p_subject_id;

    if v_league_id is null then
      return query select 0.05::numeric, 18.05::numeric;
      return;
    end if;

    select sum(exp(coalesce(lpr.rating, coalesce(p.rating, 3.5)) / v_temp))
      into v_sum_exp
      from public.league_members lm
      left join public.league_player_ratings lpr
        on lpr.league_id = v_league_id and lpr.user_id = lm.user_id
      left join public.profiles p on p.id = lm.user_id
     where lm.league_id = v_league_id;

    select exp(coalesce(lpr.rating, coalesce(p.rating, 3.5)) / v_temp)
      into v_user_exp
      from public.league_members lm
      left join public.league_player_ratings lpr
        on lpr.league_id = v_league_id and lpr.user_id = lm.user_id
      left join public.profiles p on p.id = lm.user_id
     where lm.league_id = v_league_id
       and lm.user_id = v_user_id;

    if v_sum_exp is null or v_sum_exp = 0 or v_user_exp is null then
      v_prob := 0.05;
    else
      v_prob := v_user_exp / v_sum_exp;
      if v_rank > 1 then
        v_prob := v_prob * power(0.5, v_rank - 1);
      end if;
    end if;

  else
    v_prob := 0.5;
  end if;

  -- Floor/ceil before applying house edge.
  if v_prob < 0.02 then v_prob := 0.02; end if;
  if v_prob > 0.95 then v_prob := 0.95; end if;

  return query
    select v_prob, round((1.0 - v_house_edge) / v_prob, 3);
end;
$$;

grant execute on function public.calculate_wager_odds(text, uuid, jsonb) to authenticated;


-- 2b. Helper: score-density factor for *_score subjects.
-- ----------------------------------------------------------------------
create or replace function public._wager_score_density(p_s1 int, p_s2 int)
returns numeric language plpgsql immutable as $$
declare
  v_hi int := greatest(p_s1, p_s2);
  v_lo int := least(p_s1, p_s2);
begin
  if v_hi >= 12 then return 0.01; end if;  -- win-by-2 overtime
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
$$;


-- 3. place_wager — atomically validate, debit pickles, insert wager.
-- ----------------------------------------------------------------------
create or replace function public.place_wager(
  p_subject_type text,
  p_subject_id   uuid,
  p_predicate    jsonb,
  p_stake        int
) returns table(success boolean, wager_id uuid, odds numeric, potential_payout int, balance int, message text)
language plpgsql security definer set search_path = public as $$
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

  -- Validate subject exists.
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

  -- Predicate sanity.
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

  -- Balance check.
  select pickles into v_balance from public.profiles where id = v_uid for update;
  if v_balance is null then
    return query select false, null::uuid, null::numeric, null::int, null::int, 'Profile not found.';
    return;
  end if;
  if v_balance < p_stake then
    return query select false, null::uuid, null::numeric, null::int, v_balance, format('Not enough pickles. Balance is %s.', v_balance);
    return;
  end if;

  -- Server-side odds (don't trust client).
  select probability, odds into v_prob, v_odds
    from public.calculate_wager_odds(p_subject_type, p_subject_id, p_predicate);

  if v_odds is null or v_odds < 1 then
    v_odds := 1.0;
  end if;
  v_payout := floor(p_stake * v_odds)::int;
  if v_payout < p_stake then v_payout := p_stake; end if;

  -- Debit + insert atomically.
  update public.profiles set pickles = pickles - p_stake
    where id = v_uid
    returning pickles into v_new_bal;

  insert into public.wagers (user_id, subject_type, subject_id, predicate, stake, odds, potential_payout)
    values (v_uid, p_subject_type, p_subject_id, p_predicate, p_stake, v_odds, v_payout)
    returning id into v_new_id;

  return query select true, v_new_id, v_odds, v_payout, v_new_bal, 'Wager placed.'::text;
end;
$$;

grant execute on function public.place_wager(text, uuid, jsonb, int) to authenticated;


-- 4. cancel_wager — owner-only, only if still open and unresolved.
-- ----------------------------------------------------------------------
create or replace function public.cancel_wager(p_wager_id uuid)
returns table(success boolean, refunded int, balance int, message text)
language plpgsql security definer set search_path = public as $$
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

  -- Subject must still be resolvable (not settled yet).
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
$$;

grant execute on function public.cancel_wager(uuid) to authenticated;


-- 5. Settlement helpers (internal — called by triggers / autolock).
-- ----------------------------------------------------------------------
-- Shared notification insert (skip if user opted out — keep simple in v1).
create or replace function public._wager_notify(
  p_user_id  uuid,
  p_title    text,
  p_body     text,
  p_entity_id uuid
) returns void language plpgsql security definer as $$
begin
  insert into public.notifications (user_id, title, body, type, entity_id, entity_type)
  values (p_user_id, p_title, p_body, 'wager', p_entity_id, 'wager');
exception when others then
  null;
end;
$$;


create or replace function public._settle_wagers_for_match(p_match_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_match  record;
  v_w      record;
  v_won    boolean;
  v_title  text;
  v_body   text;
  v_label  text;
begin
  select id, winner_team, player1_score, player2_score
    into v_match from public.matches where id = p_match_id;
  if v_match.id is null then return; end if;
  if v_match.winner_team is null then return; end if;

  for v_w in (
    select * from public.wagers
     where subject_id = p_match_id
       and subject_type in ('match','match_score')
       and status = 'open'
       for update
  ) loop
    if v_w.subject_type = 'match' then
      v_won  := (v_w.predicate->>'winner_team') = v_match.winner_team;
      v_label := 'match winner';
    else
      v_won := (v_w.predicate->>'team1_score')::int = v_match.player1_score
           and (v_w.predicate->>'team2_score')::int = v_match.player2_score;
      v_label := format('match score %s-%s', v_w.predicate->>'team1_score', v_w.predicate->>'team2_score');
    end if;

    if v_won then
      update public.profiles set pickles = pickles + v_w.potential_payout where id = v_w.user_id;
      update public.wagers set status = 'won', settled_at = now() where id = v_w.id;
      v_title := '🎲 Wager won!';
      v_body  := format('You won %s 🥒 on a %s wager.', v_w.potential_payout, v_label);
    else
      update public.wagers set status = 'lost', settled_at = now() where id = v_w.id;
      v_title := '🎲 Wager settled';
      v_body  := format('Your %s 🥒 wager on a %s didn''t hit.', v_w.stake, v_label);
    end if;
    perform public._wager_notify(v_w.user_id, v_title, v_body, v_w.id);
  end loop;
end;
$$;


create or replace function public._settle_wagers_for_tournament_match(p_tm_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_tm     record;
  v_w      record;
  v_won    boolean;
  v_title  text;
  v_body   text;
  v_label  text;
begin
  select id, winner_team, team1_score, team2_score
    into v_tm from public.tournament_matches where id = p_tm_id;
  if v_tm.id is null then return; end if;
  if v_tm.winner_team is null then return; end if;

  for v_w in (
    select * from public.wagers
     where subject_id = p_tm_id
       and subject_type in ('tournament_match','tournament_match_score')
       and status = 'open'
       for update
  ) loop
    if v_w.subject_type = 'tournament_match' then
      v_won  := (v_w.predicate->>'winner_team') = v_tm.winner_team;
      v_label := 'tournament match winner';
    else
      v_won := (v_w.predicate->>'team1_score')::int = v_tm.team1_score
           and (v_w.predicate->>'team2_score')::int = v_tm.team2_score;
      v_label := format('tournament match score %s-%s', v_w.predicate->>'team1_score', v_w.predicate->>'team2_score');
    end if;

    if v_won then
      update public.profiles set pickles = pickles + v_w.potential_payout where id = v_w.user_id;
      update public.wagers set status = 'won', settled_at = now() where id = v_w.id;
      v_title := '🎲 Wager won!';
      v_body  := format('You won %s 🥒 on a %s wager.', v_w.potential_payout, v_label);
    else
      update public.wagers set status = 'lost', settled_at = now() where id = v_w.id;
      v_title := '🎲 Wager settled';
      v_body  := format('Your %s 🥒 wager on a %s didn''t hit.', v_w.stake, v_label);
    end if;
    perform public._wager_notify(v_w.user_id, v_title, v_body, v_w.id);
  end loop;
end;
$$;


create or replace function public._settle_wagers_for_tournament(p_tournament_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_w        record;
  v_won      boolean;
  v_title    text;
  v_body     text;
  v_pred_uid uuid;
  v_pred_rank int;
  v_winner_at_rank uuid;
begin
  for v_w in (
    select * from public.wagers
     where subject_id = p_tournament_id
       and subject_type = 'tournament_rank'
       and status = 'open'
       for update
  ) loop
    v_pred_uid  := (v_w.predicate->>'user_id')::uuid;
    v_pred_rank := coalesce((v_w.predicate->>'rank')::int, 1);

    select user_id into v_winner_at_rank
      from public.tournament_champion_badges
     where tournament_id = p_tournament_id
       and place = v_pred_rank
     limit 1;

    v_won := (v_winner_at_rank is not null and v_winner_at_rank = v_pred_uid);

    if v_won then
      update public.profiles set pickles = pickles + v_w.potential_payout where id = v_w.user_id;
      update public.wagers set status = 'won', settled_at = now() where id = v_w.id;
      v_title := '🎲 Wager won!';
      v_body  := format('You won %s 🥒 on a tournament rank wager.', v_w.potential_payout);
    else
      update public.wagers set status = 'lost', settled_at = now() where id = v_w.id;
      v_title := '🎲 Wager settled';
      v_body  := format('Your %s 🥒 tournament rank wager didn''t hit.', v_w.stake);
    end if;
    perform public._wager_notify(v_w.user_id, v_title, v_body, v_w.id);
  end loop;
end;
$$;


create or replace function public._settle_wagers_for_period_lock(p_season_id uuid, p_period_number int)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_w        record;
  v_won      boolean;
  v_title    text;
  v_body     text;
  v_pred_uid uuid;
  v_pred_rank int;
  v_actual_rank int;
begin
  for v_w in (
    select * from public.wagers
     where subject_id = p_season_id
       and subject_type = 'period_rank'
       and status = 'open'
       and (predicate->>'period_number')::int = p_period_number
       for update
  ) loop
    v_pred_uid  := (v_w.predicate->>'user_id')::uuid;
    v_pred_rank := coalesce((v_w.predicate->>'rank')::int, 1);

    select rank_at_snapshot into v_actual_rank
      from public.season_snapshots
     where season_id = p_season_id
       and period_number = p_period_number
       and user_id = v_pred_uid
     limit 1;

    v_won := (v_actual_rank is not null and v_actual_rank = v_pred_rank);

    if v_won then
      update public.profiles set pickles = pickles + v_w.potential_payout where id = v_w.user_id;
      update public.wagers set status = 'won', settled_at = now() where id = v_w.id;
      v_title := '🎲 Wager won!';
      v_body  := format('You won %s 🥒 on a period-rank wager.', v_w.potential_payout);
    else
      update public.wagers set status = 'lost', settled_at = now() where id = v_w.id;
      v_title := '🎲 Wager settled';
      v_body  := format('Your %s 🥒 period-rank wager didn''t hit.', v_w.stake);
    end if;
    perform public._wager_notify(v_w.user_id, v_title, v_body, v_w.id);
  end loop;
end;
$$;


-- 6. Triggers — auto-settle when underlying events complete.
-- ----------------------------------------------------------------------
create or replace function public._trg_settle_wagers_match()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public._settle_wagers_for_match(new.id);
  return new;
exception when others then
  return new;
end;
$$;

drop trigger if exists trg_settle_wagers_match on public.matches;
create trigger trg_settle_wagers_match
after insert or update of status on public.matches
for each row when (new.status = 'completed')
execute function public._trg_settle_wagers_match();


create or replace function public._trg_settle_wagers_tournament_match()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public._settle_wagers_for_tournament_match(new.id);
  return new;
exception when others then
  return new;
end;
$$;

drop trigger if exists trg_settle_wagers_tournament_match on public.tournament_matches;
create trigger trg_settle_wagers_tournament_match
after insert or update of status on public.tournament_matches
for each row when (new.status = 'completed')
execute function public._trg_settle_wagers_tournament_match();


create or replace function public._trg_settle_wagers_tournament()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (old.status is distinct from 'completed') and (new.status = 'completed') then
    perform public._settle_wagers_for_tournament(new.id);
  end if;
  return new;
exception when others then
  return new;
end;
$$;

drop trigger if exists trg_settle_wagers_tournament on public.tournaments;
create trigger trg_settle_wagers_tournament
after update of status on public.tournaments
for each row
execute function public._trg_settle_wagers_tournament();


-- 7. Hook period-lock settlement onto _lock_season_period_unchecked.
--    Mirrors the body from migration_restore_season_snapshots_and_fix_autolock.sql
--    and adds a settlement call at the end.
-- ----------------------------------------------------------------------
create or replace function public._lock_season_period_unchecked(
  p_season_id     uuid,
  p_period_number integer,
  p_snapshot_date date
)
returns void language plpgsql security definer as $$
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
        coalesce(sum(case
          when (m.player1_id  = lm.user_id and m.winner_team = 'team1') or
               (m.partner1_id = lm.user_id and m.winner_team = 'team1') or
               (m.player2_id  = lm.user_id and m.winner_team = 'team2') or
               (m.partner2_id = lm.user_id and m.winner_team = 'team2')
          then 1 else 0 end), 0) as wins,
        coalesce(sum(case
          when (m.player1_id  = lm.user_id and m.winner_team = 'team2') or
               (m.partner1_id = lm.user_id and m.winner_team = 'team2') or
               (m.player2_id  = lm.user_id and m.winner_team = 'team1') or
               (m.partner2_id = lm.user_id and m.winner_team = 'team1')
          then 1 else 0 end), 0) as losses
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

  -- Settle any open period-rank wagers for the period that just locked.
  perform public._settle_wagers_for_period_lock(p_season_id, p_period_number);
end;
$$;


notify pgrst, 'reload schema';
