-- ============================================================
-- Two engagement bonuses:
--   1. Daily login bonus 10 -> 50 pickles (claim_daily_login_streak).
--   2. +25 pickles per game in a recorded match (new trigger).
--
-- game_scores is null for single-game matches and a jsonb array for
-- multi-game matches, so games = coalesce(jsonb_array_length, 1).
-- ============================================================

-- 1. Daily login: 10 -> 50 per claimed day. Milestones unchanged.
create or replace function public.claim_daily_login_streak()
returns table (
  claimed_today     boolean,
  streak_before     int,
  streak_after      int,
  daily_pickles     int,
  milestone_pickles int,
  milestone_label   text,
  used_freeze       boolean,
  freezes_remaining int,
  longest_streak    int
)
language plpgsql security definer as $$
declare
  uid              uuid := auth.uid();
  today            date := (now() at time zone 'utc')::date;
  curr_month       text := to_char(now() at time zone 'utc', 'YYYY-MM');
  rec              user_login_streaks%rowtype;
  gap              int;
  v_streak_before  int := 0;
  v_streak_after   int;
  v_used_freeze    boolean := false;
  v_daily          int := 0;
  v_milestone      int := 0;
  v_milestone_lbl  text := null;
  v_freezes        int;
  v_longest        int;
  v_claimed        boolean;
begin
  if uid is null then raise exception 'Not authenticated'; end if;

  select * into rec from user_login_streaks where user_id = uid for update;

  if found and rec.freezes_refilled_month <> curr_month then
    rec.freezes_remaining := 1;
    rec.freezes_refilled_month := curr_month;
  end if;

  if not found then
    v_streak_before := 0;
    v_streak_after  := 1;
    v_daily         := 50;
    v_freezes       := 1;
    v_longest       := 1;
    v_claimed       := true;
    insert into user_login_streaks (
      user_id, current_streak, longest_streak, last_login_date,
      freezes_remaining, freezes_refilled_month, total_logins
    ) values (
      uid, v_streak_after, v_longest, today, v_freezes, curr_month, 1
    );
  elsif rec.last_login_date = today then
    v_streak_before := rec.current_streak;
    v_streak_after  := rec.current_streak;
    v_freezes       := rec.freezes_remaining;
    v_longest       := rec.longest_streak;
    v_claimed       := false;
    update user_login_streaks
      set freezes_remaining = rec.freezes_remaining,
          freezes_refilled_month = rec.freezes_refilled_month,
          updated_at = now()
      where user_id = uid;
  else
    gap := today - rec.last_login_date;
    v_streak_before := rec.current_streak;
    if gap = 1 then
      v_streak_after := rec.current_streak + 1;
      v_freezes      := rec.freezes_remaining;
    elsif gap = 2 and rec.freezes_remaining > 0 then
      v_streak_after := rec.current_streak + 1;
      v_freezes      := rec.freezes_remaining - 1;
      v_used_freeze  := true;
    else
      v_streak_after := 1;
      v_freezes      := rec.freezes_remaining;
    end if;

    v_daily := 50;
    v_milestone := case v_streak_after
      when 3   then 25
      when 7   then 100
      when 30  then 500
      when 100 then 2000
      else 0
    end;
    v_milestone_lbl := case v_streak_after
      when 3   then '3-day streak'
      when 7   then '7-day streak'
      when 30  then '30-day streak'
      when 100 then '100-day streak'
      else null
    end;
    v_longest := greatest(rec.longest_streak, v_streak_after);
    v_claimed := true;

    update user_login_streaks
      set current_streak         = v_streak_after,
          longest_streak         = v_longest,
          last_login_date        = today,
          freezes_remaining      = v_freezes,
          freezes_refilled_month = curr_month,
          total_logins           = total_logins + 1,
          updated_at             = now()
      where user_id = uid;
  end if;

  if v_claimed then
    update profiles
      set pickles = coalesce(pickles, 0) + v_daily + v_milestone
      where id = uid;
    insert into user_streak_rewards (
      user_id, awarded_date, streak_after, daily_pickles,
      milestone_pickles, milestone_label, used_freeze
    ) values (
      uid, today, v_streak_after, v_daily,
      v_milestone, v_milestone_lbl, v_used_freeze
    );
  end if;

  return query select
    v_claimed,
    v_streak_before,
    v_streak_after,
    v_daily,
    v_milestone,
    v_milestone_lbl,
    v_used_freeze,
    v_freezes,
    v_longest;
end;
$$;


-- 2. +25 pickles per game in a recorded match. One grant per (match, player),
--    fired when the match reaches 'completed'. Idempotent via grants table.
create table if not exists public.match_game_bonus_grants (
  match_id   uuid references public.matches(id)  on delete cascade not null,
  user_id    uuid references public.profiles(id) on delete cascade not null,
  games      integer not null,
  granted_at timestamptz not null default now(),
  primary key (match_id, user_id)
);
alter table public.match_game_bonus_grants enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='match_game_bonus_grants' and policyname='Game bonus grants viewable by owner') then
    create policy "Game bonus grants viewable by owner" on public.match_game_bonus_grants
      for select using (auth.uid() = user_id);
  end if;
end $$;

create or replace function public._grant_match_game_bonus()
returns trigger language plpgsql security definer as $$
declare
  v_uid   uuid;
  v_games integer;
  v_bonus integer;
  v_rowcount integer;
begin
  if coalesce(new.status, 'completed') <> 'completed' then return new; end if;

  v_games := greatest(coalesce(jsonb_array_length(new.game_scores), 1), 1);
  v_bonus := v_games * 25;

  for v_uid in
    select distinct uid from (values
      (new.player1_id), (new.partner1_id), (new.player2_id), (new.partner2_id)
    ) as t(uid)
    where uid is not null
  loop
    begin
      insert into public.match_game_bonus_grants(match_id, user_id, games)
        values (new.id, v_uid, v_games)
        on conflict (match_id, user_id) do nothing;
      get diagnostics v_rowcount = row_count;
      if v_rowcount > 0 then
        update public.profiles set pickles = coalesce(pickles, 0) + v_bonus where id = v_uid;
        begin
          perform public._notify_user(
            v_uid,
            format('🥒 +%s pickles for your match!', v_bonus),
            format('You earned %s 🥒 for playing %s game%s. Tap to see your shop balance.',
                   v_bonus, v_games, case when v_games = 1 then '' else 's' end),
            v_uid,
            'shop'
          );
        exception when others then null;
        end;
      end if;
    exception when others then null;
    end;
  end loop;
  return new;
end;
$$;

drop trigger if exists trg_grant_match_game_bonus on public.matches;
create trigger trg_grant_match_game_bonus
  after insert or update of status on public.matches
  for each row execute function public._grant_match_game_bonus();
