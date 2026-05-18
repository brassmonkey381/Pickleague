-- Daily login streaks.
--
-- Rewards: 10 pickles per qualifying day. Milestone bonuses on top: 25 at 3-day,
-- 100 at 7-day, 500 at 30-day, 2000 at 100-day.
-- Grace: one streak-freeze per calendar month (auto-refilled). A freeze bridges
-- exactly one missed day; a 2+ day gap still resets the streak.
-- Idempotent per UTC date — repeat calls on the same day are no-ops for rewards.

create table if not exists user_login_streaks (
  user_id                 uuid primary key references auth.users(id) on delete cascade,
  current_streak          int  not null default 0,
  longest_streak          int  not null default 0,
  last_login_date         date not null default (now() at time zone 'utc')::date,
  freezes_remaining       int  not null default 1,
  freezes_refilled_month  text not null default to_char(now() at time zone 'utc', 'YYYY-MM'),
  total_logins            int  not null default 0,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

alter table user_login_streaks enable row level security;

create policy "Users see own streak"
  on user_login_streaks for select
  using (auth.uid() = user_id);

-- No insert/update/delete policies — writes go through the SECURITY DEFINER RPC only.

create table if not exists user_streak_rewards (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  awarded_at       timestamptz not null default now(),
  awarded_date     date not null,
  streak_after     int  not null,
  daily_pickles    int  not null,
  milestone_pickles int not null default 0,
  milestone_label  text,
  used_freeze      boolean not null default false
);

alter table user_streak_rewards enable row level security;

create policy "Users see own streak rewards"
  on user_streak_rewards for select
  using (auth.uid() = user_id);

create unique index if not exists user_streak_rewards_user_date_idx
  on user_streak_rewards (user_id, awarded_date);

-- RPC: claim_daily_login_streak()
--
-- Returns one row describing today's result. Safe to call repeatedly — pickles
-- are only granted on the first call per UTC day per user.
create or replace function claim_daily_login_streak()
returns table (
  claimed_today      boolean,   -- whether THIS call granted pickles
  streak_before      int,
  streak_after       int,
  daily_pickles      int,
  milestone_pickles  int,
  milestone_label    text,
  used_freeze        boolean,
  freezes_remaining  int,
  longest_streak     int
)
language plpgsql
security definer
set search_path = public
as $$
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

  -- Auto-refill freeze on first call of a new calendar month.
  if found and rec.freezes_refilled_month <> curr_month then
    rec.freezes_remaining := 1;
    rec.freezes_refilled_month := curr_month;
  end if;

  if not found then
    -- First-ever login
    v_streak_before := 0;
    v_streak_after  := 1;
    v_daily         := 10;
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
    -- Already claimed today — return current state, no reward
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

    v_daily := 10;
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

grant execute on function claim_daily_login_streak() to authenticated;
