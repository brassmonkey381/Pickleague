-- ============================================================
-- Fair rewards for what players do in the app (follows
-- migration_pickle_economy_guards.sql).
--
-- The user, 2026-10-28: "i like the daily login bonus system we have for
-- Doggle. First 7 day streak builds up each day, then every subsequent day is
-- a flat bonus slightly higher than the average of those 7 days. Let's do the
-- same for pickleague." / "Most pickleballers are grinders!" / "I like front
-- loading games played payouts daily." / "Make the 7, 30, 100, 365 day bonus
-- one time badges and payouts" / "social earning sounds good." Shop prices,
-- the play streak and the 500/day cap stay as they are.
-- Model: state/pickle-fair-week.md. Doggle: db/migrations/0468, 0469.
--
-- ── What changes ──────────────────────────────────────────────────────────
--   1. Daily login (claim_daily_login_streak), uncapped gold as before:
--      * days 1-7 of a streak pay 15, 24, 33, 42, 51, 60, 75; day 8 on, 50
--        (it was 50 every day).
--      * streak badges, once per account (they paid again on every streak
--        before): Week Streak (7 days) +200, Month Streak (30) +1,000,
--        100-Day Streak (100) +2,500, Year Streak (365) +10,000. The 3-day
--        +25 goes (the build-up covers the first week). A streak already past
--        a mark collects it on its next claim. Each is its own gold row in
--        pickle history ("Week Streak badge").
--      * login_streak_milestones records them; the 7 / 30 / 100 milestones
--        already paid are backfilled, so nobody is paid twice.
--   2. Match pay (_grant_match_game_bonus), inside the daily cap: front-loaded
--      per day, per match: a player's first 3 matches of their day pay 40
--      each, then 35, 30, 25, 20, 15, 10, 5, and 0 from the 12th match, whoever
--      they're with (it was 25 a game). The same players (the same 2 in singles,
--      the same 4 in doubles) earn at most 120 together within 12 hours (it
--      was: the 4th match within 24 hours paid nothing).
--      match_game_bonus_grants.paid records each match's pay for that limit.
--   3. Social earns, new, inside the daily cap:
--      * New opponent (_grant_new_opponent_bonus): +50 for each player you
--        play for the first time (either side), at most 3 a week (rolling 7
--        days).
--      * Check-in to match (_grant_checkin_match_bonus): +25 once a day when
--        a completed match was played within 4 hours after you checked in at
--        a court.
--   4. Season organiser (_grant_season_organiser_bonus), uncapped gold: +200
--      to a league's creator when one of its seasons completes with real play
--      (_pl_league_real_play: 4+ players, 2+ matches each, 2+ opponents) and
--      lasted 4+ weeks; once per season, at most once per 28 days per organiser.
--   5. The daily cap (_pl_play_cap_left, _pl_profiles_play_cap) counts the two
--      new social sources.
--
-- New tables (RLS on; the owner reads their own login_streak_milestones):
--   login_streak_milestones, new_opponent_grants, checkin_match_grants,
--   season_organiser_grants
-- New internal functions (execute revoked from public, anon, authenticated):
--   _grant_new_opponent_bonus(), _grant_checkin_match_bonus(),
--   _grant_season_organiser_bonus()
-- Replaced (check-replaced-functions.mjs refuses to go on if live differs):
--   claim_daily_login_streak()   migration_local_day_boundaries.sql
--   _grant_match_game_bonus()    migration_pickle_economy_guards.sql
--   _pl_play_cap_left(uuid)      migration_pickle_economy_guards.sql
--   _pl_profiles_play_cap()      migration_pickle_economy_guards.sql
-- pickle_ledger_sources gains the three new sources.
--
-- Idempotent; no top-level transaction. Persona test:
--   supabase/tests/fair_rewards_personas.sql
-- Apply with state/fair-rewards-apply.ps1, then re-run
-- migration_rls_hardening_2026q3.sql.
-- ============================================================


-- ════ 0. Tables ══════════════════════════════════════════════════════════

-- What each match paid each player (the same-players limit adds these up).
alter table public.match_game_bonus_grants add column if not exists paid integer;

create table if not exists public.login_streak_milestones (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  days       integer not null,
  paid       integer not null,
  awarded_at timestamptz not null default now(),
  primary key (user_id, days)
);
create table if not exists public.new_opponent_grants (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  opponent_id uuid not null references public.profiles(id) on delete cascade,
  match_id    uuid references public.matches(id) on delete set null,
  granted_at  timestamptz not null default now(),
  primary key (user_id, opponent_id)
);
create index if not exists new_opponent_grants_recent_idx on public.new_opponent_grants (user_id, granted_at desc);
create table if not exists public.checkin_match_grants (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  play_date  date not null,
  match_id   uuid references public.matches(id) on delete set null,
  granted_at timestamptz not null default now(),
  primary key (user_id, play_date)
);
create table if not exists public.season_organiser_grants (
  season_id  uuid primary key references public.league_seasons(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  granted_at timestamptz not null default now()
);
create index if not exists season_organiser_grants_user_idx on public.season_organiser_grants (user_id, granted_at desc);

do $$
declare t text;
begin
  foreach t in array array['login_streak_milestones', 'new_opponent_grants', 'checkin_match_grants', 'season_organiser_grants'] loop
    if not (select c.relrowsecurity from pg_class c where c.oid = ('public.' || t)::regclass) then
      execute format('alter table public.%I enable row level security', t);
    end if;
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'login_streak_milestones'
                  and policyname = 'Own streak badges') then
    create policy "Own streak badges" on public.login_streak_milestones
      for select to authenticated using (auth.uid() = user_id);
  end if;
end $$;
grant select on table public.login_streak_milestones to authenticated;

-- The 7 / 30 / 100 milestones already paid (the old 100 / 500 / 2,000), once each.
insert into public.login_streak_milestones (user_id, days, paid, awarded_at)
select r.user_id, r.streak_after, max(r.milestone_pickles), min(r.awarded_at)
  from public.user_streak_rewards r
 where r.streak_after in (7, 30, 100) and r.milestone_pickles > 0
   and exists (select 1 from public.profiles p where p.id = r.user_id)
 group by r.user_id, r.streak_after
on conflict do nothing;


-- ════ 1. Daily login: Doggle's build-up, streak badges once ═════════════

CREATE OR REPLACE FUNCTION public.claim_daily_login_streak()
 RETURNS TABLE(claimed_today boolean, streak_before integer, streak_after integer, daily_pickles integer, milestone_pickles integer, milestone_label text, used_freeze boolean, freezes_remaining integer, longest_streak integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  uid              uuid := auth.uid();
  -- Declarations run in order, so uid is set here (null -> the default zone,
  -- then the 'Not authenticated' raise below).
  v_tz             text := public._pickleague_tz_for(uid);
  today            date := (now() at time zone v_tz)::date;
  curr_month       text := to_char(now() at time zone v_tz, 'YYYY-MM');
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
  -- Doggle's login bonus (migration_fair_rewards.sql §1): days 1-7 build up,
  -- then a flat 50, a little above their average (43).
  v_sched          int[] := array[15, 24, 33, 42, 51, 60, 75];
  m                record;
  v_rows           int;
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
    v_daily         := v_sched[1];
    v_freezes       := 1;
    v_longest       := 1;
    v_claimed       := true;
    insert into user_login_streaks (
      user_id, current_streak, longest_streak, last_login_date,
      freezes_remaining, freezes_refilled_month, total_logins
    ) values (
      uid, v_streak_after, v_longest, today, v_freezes, curr_month, 1
    );
  elsif rec.last_login_date >= today
        or exists (select 1 from user_streak_rewards r
                    where r.user_id = uid
                      and r.awarded_at >= (today::timestamp at time zone v_tz)) then
    v_streak_before := rec.current_streak;
    v_streak_after  := rec.current_streak;
    v_freezes       := rec.freezes_remaining;
    v_longest       := rec.longest_streak;
    v_claimed       := false;
    update user_login_streaks
      set freezes_remaining = rec.freezes_remaining,
          freezes_refilled_month = rec.freezes_refilled_month,
          last_login_date = greatest(rec.last_login_date, today),
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

    v_daily := case when v_streak_after <= 7 then v_sched[v_streak_after] else 50 end;
    -- Streak badges: once per account, at the first claim that reaches them
    -- (a long streak already running collects the ones it passed).
    for m in
      select * from (values (7, 'Week Streak', 200), (30, 'Month Streak', 1000),
                            (100, '100-Day Streak', 2500), (365, 'Year Streak', 10000)) v (days, name, pickles)
       where v.days <= v_streak_after
       order by v.days
    loop
      insert into public.login_streak_milestones (user_id, days, paid)
      values (uid, m.days, m.pickles)
      on conflict do nothing;
      get diagnostics v_rows = row_count;
      if v_rows > 0 then
        v_milestone := v_milestone + m.pickles;
        v_milestone_lbl := m.name;
      end if;
    end loop;
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
      set pickles = coalesce(pickles, 0) + v_daily
      where id = uid;
    if v_milestone > 0 then
      -- Its own gold row in pickle history, named for the badge.
      perform set_config('pl.pickle_reason', v_milestone_lbl || ' badge', true);
      update profiles
        set pickles = coalesce(pickles, 0) + v_milestone
        where id = uid;
      perform set_config('pl.pickle_reason', '', true);
    end if;
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
$function$;


-- ════ 2. Match pay: front-loaded per day ═════════════════════════════════

create or replace function public._grant_match_game_bonus()
returns trigger language plpgsql security definer as $$
declare
  v_uid   uuid;
  v_games integer;
  v_bonus integer;
  v_rowcount integer;
  v_players uuid[];
  v_tz    text;
  v_n     integer;
  v_group integer;
begin
  if coalesce(new.status, 'completed') <> 'completed' then return new; end if;

  -- At most 5 games count (migration_pickle_economy_guards.sql §3); the grant
  -- row keeps the count, the pay is per match (migration_fair_rewards.sql §2).
  v_games := least(greatest(coalesce(jsonb_array_length(new.game_scores), 1), 1), 5);

  -- This match's players, sorted: "the same players" means exactly this set.
  select array_agg(u order by u) into v_players
    from unnest(array[new.player1_id, new.partner1_id, new.player2_id, new.partner2_id]) as u
   where u is not null;

  for v_uid in
    select distinct uid from (values
      (new.player1_id), (new.partner1_id), (new.player2_id), (new.partner2_id)
    ) as t(uid)
    where uid is not null
  loop
    begin
      -- The day's curve: this player's nth match today, whoever it's with.
      -- 1-3 pay 40, then 35, 30, 25, 20, 15, 10, 5, and 0 from the 12th.
      v_tz := public._pickleague_tz_for(v_uid);
      select count(*) + 1 into v_n
        from public.match_game_bonus_grants g
       where g.user_id = v_uid
         and g.match_id <> new.id
         and g.granted_at >= ((now() at time zone v_tz)::date)::timestamp at time zone v_tz;
      v_bonus := case when v_n <= 3 then 40 else greatest(40 - 5 * (v_n - 3), 0) end;

      -- The same players earn at most 120 together within 12 hours.
      select coalesce(sum(coalesce(g.paid, 25 * g.games)), 0) into v_group
        from public.match_game_bonus_grants g
        join public.matches x on x.id = g.match_id
       where g.user_id = v_uid
         and g.match_id <> new.id
         and coalesce(x.played_at, x.created_at)
             between coalesce(new.played_at, now()) - interval '12 hours' and coalesce(new.played_at, now()) + interval '12 hours'
         and (select array_agg(u order by u)
                from unnest(array[x.player1_id, x.partner1_id, x.player2_id, x.partner2_id]) as u
               where u is not null) = v_players;
      v_bonus := greatest(least(v_bonus, 120 - v_group, public._pl_play_cap_left(v_uid)), 0);

      insert into public.match_game_bonus_grants(match_id, user_id, games, paid)
        values (new.id, v_uid, v_games, v_bonus)
        on conflict (match_id, user_id) do nothing;
      get diagnostics v_rowcount = row_count;
      if v_rowcount > 0 and v_bonus > 0 then
        update public.profiles set pickles = coalesce(pickles, 0) + v_bonus where id = v_uid;
        begin
          perform public._notify_user(
            v_uid,
            format('🥒 +%s pickles for your match!', v_bonus),
            case when v_n <= 3
                 then format('You earned %s 🥒 for playing. Your first 3 matches each day pay the most.', v_bonus)
                 else format('You earned %s 🥒 for playing. Each match today pays a little less; tomorrow starts at 40 again.', v_bonus) end,
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


-- ════ 3. Social earns ════════════════════════════════════════════════════

-- +50 for each player you play for the first time, at most 3 in 7 days.
create or replace function public._grant_new_opponent_bonus()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_players uuid[];
  v_uid     uuid;
  v_other   uuid;
  v_recent  integer;
  v_pay     integer;
  v_rows    integer;
begin
  if coalesce(new.status, 'completed') <> 'completed' then return new; end if;
  v_players := array(select distinct u from unnest(array[new.player1_id, new.partner1_id, new.player2_id, new.partner2_id]) u
                      where u is not null);

  foreach v_uid in array v_players loop
    begin
      foreach v_other in array v_players loop
        continue when v_other = v_uid;
        -- Played together before (either side, any league)? Not new.
        continue when exists (
          select 1 from public.matches x
           where x.id <> new.id
             and coalesce(x.status, 'completed') = 'completed'
             and v_uid  in (x.player1_id, x.partner1_id, x.player2_id, x.partner2_id)
             and v_other in (x.player1_id, x.partner1_id, x.player2_id, x.partner2_id));
        select count(*) into v_recent from public.new_opponent_grants g
         where g.user_id = v_uid and g.granted_at > now() - interval '7 days';
        exit when v_recent >= 3;
        v_pay := least(50, public._pl_play_cap_left(v_uid));
        exit when v_pay <= 0;
        insert into public.new_opponent_grants (user_id, opponent_id, match_id)
        values (v_uid, v_other, new.id)
        on conflict do nothing;
        get diagnostics v_rows = row_count;
        continue when v_rows = 0;
        update public.profiles set pickles = coalesce(pickles, 0) + v_pay where id = v_uid;
        begin
          perform public._notify_user(
            v_uid,
            format('🥒 +%s pickles: a new opponent!', v_pay),
            format('You earned %s 🥒 for playing someone new. Up to 3 new players a week pay.', v_pay),
            v_uid,
            'shop'
          );
        exception when others then null;
        end;
      end loop;
    exception when others then null;
    end;
  end loop;
  return new;
end $$;
revoke execute on function public._grant_new_opponent_bonus() from public, anon, authenticated;

create or replace trigger trg_grant_new_opponent_bonus
  after insert or update of status on public.matches
  for each row execute function public._grant_new_opponent_bonus();

-- +25 once a day when a match comes within 4 hours of your check-in.
create or replace function public._grant_checkin_match_bonus()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid;
  v_at   timestamptz := coalesce(new.played_at, now());
  v_tz   text;
  v_day  date;
  v_pay  integer;
  v_rows integer;
begin
  if coalesce(new.status, 'completed') <> 'completed' then return new; end if;

  for v_uid in
    select distinct u from unnest(array[new.player1_id, new.partner1_id, new.player2_id, new.partner2_id]) u
     where u is not null
  loop
    begin
      continue when not exists (
        select 1 from public.venue_checkins c
         where c.user_id = v_uid
           and c.checked_in_at between v_at - interval '4 hours' and v_at + interval '15 minutes');
      v_tz  := public._pickleague_tz_for(v_uid);
      v_day := (v_at at time zone v_tz)::date;
      -- Today's (or yesterday's late) match only: no back-filled days.
      continue when v_day < (now() at time zone v_tz)::date - 1;
      v_pay := least(25, public._pl_play_cap_left(v_uid));
      continue when v_pay <= 0;
      insert into public.checkin_match_grants (user_id, play_date, match_id)
      values (v_uid, v_day, new.id)
      on conflict do nothing;
      get diagnostics v_rows = row_count;
      continue when v_rows = 0;
      update public.profiles set pickles = coalesce(pickles, 0) + v_pay where id = v_uid;
      begin
        perform public._notify_user(
          v_uid,
          format('🥒 +%s pickles for showing up!', v_pay),
          format('You checked in and played: %s 🥒.', v_pay),
          v_uid,
          'shop'
        );
      exception when others then null;
      end;
    exception when others then null;
    end;
  end loop;
  return new;
end $$;
revoke execute on function public._grant_checkin_match_bonus() from public, anon, authenticated;

create or replace trigger trg_grant_checkin_match_bonus
  after insert or update of status on public.matches
  for each row execute function public._grant_checkin_match_bonus();


-- ════ 4. Season organiser ════════════════════════════════════════════════

create or replace function public._grant_season_organiser_bonus()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_rows  integer;
begin
  -- Only the server's completion (it sets elo_reset_applied, which clients
  -- can't since migration_pickle_economy_guards.sql §7).
  if new.status <> 'completed' or old.status = 'completed' or not coalesce(new.elo_reset_applied, false) then
    return new;
  end if;
  begin
    select l.created_by into v_owner from public.leagues l where l.id = new.league_id;
    if v_owner is null
       or new.end_date - new.start_date < 28
       or not public._pl_league_real_play(new.league_id)
       or exists (select 1 from public.season_organiser_grants g
                   where g.user_id = v_owner and g.granted_at > now() - interval '28 days') then
      return new;
    end if;
    insert into public.season_organiser_grants (season_id, user_id) values (new.id, v_owner)
    on conflict do nothing;
    get diagnostics v_rows = row_count;
    if v_rows = 0 then return new; end if;

    perform set_config('pl.pickle_meta', jsonb_build_object('season_id', new.id, 'league_id', new.league_id)::text, true);
    update public.profiles set pickles = coalesce(pickles, 0) + 200 where id = v_owner;
    perform set_config('pl.pickle_meta', '', true);
    begin
      perform public._notify_user(
        v_owner,
        '🥒 +200 pickles for running a season!',
        format('%s wrapped up with real play. Thanks for organising: 200 🥒.', coalesce(new.name, 'Your season')),
        new.league_id,
        'shop'
      );
    exception when others then null;
    end;
  exception when others then
    raise warning 'season organiser bonus: skipped for season % (%: %)', new.id, sqlstate, sqlerrm;
  end;
  return new;
end $$;
revoke execute on function public._grant_season_organiser_bonus() from public, anon, authenticated;

create or replace trigger trg_grant_season_organiser_bonus
  after update of status on public.league_seasons
  for each row execute function public._grant_season_organiser_bonus();


-- ════ 5. The daily cap counts the social earns ═══════════════════════════

create or replace function public._pl_play_cap_left(p_uid uuid)
returns integer
language plpgsql
volatile    -- sees the rows earlier grants of the same transaction wrote
security definer
set search_path = ''
as $$
declare
  v_tz    text := public._pickleague_tz_for(p_uid);
  v_start timestamptz := ((now() at time zone v_tz)::date)::timestamp at time zone v_tz;
  v_paid  integer;
begin
  select coalesce(sum(l.delta), 0)::integer into v_paid
    from public.pickle_ledger l
   where l.profile_id = p_uid
     and l.created_at >= v_start
     and l.delta > 0
     and l.source = any (array[
       '_grant_match_game_bonus', '_grant_daily_streak_bonus', '_grant_court_bonus',
       '_grant_pickles_on_badge', '_grant_tournament_participation_bonus', 'submit_drill_review',
       '_grant_new_opponent_bonus', '_grant_checkin_match_bonus']);
  return greatest(500 - v_paid, 0);
end $$;
revoke execute on function public._pl_play_cap_left(uuid) from public, anon, authenticated;

create or replace function public._pl_profiles_play_cap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_src  text;
  v_left integer;
begin
  if coalesce(new.pickles, 0) <= coalesce(old.pickles, 0) then
    return new;
  end if;
  begin
    v_src := public._pl_play_source();
    if v_src = any (array[
         '_grant_match_game_bonus', '_grant_daily_streak_bonus', '_grant_court_bonus',
         '_grant_pickles_on_badge', '_grant_tournament_participation_bonus', 'submit_drill_review',
         '_grant_new_opponent_bonus', '_grant_checkin_match_bonus']) then
      v_left := public._pl_play_cap_left(new.id);
      if new.pickles - coalesce(old.pickles, 0) > v_left then
        new.pickles := coalesce(old.pickles, 0) + v_left;
      end if;
    end if;
  exception when others then
    raise warning 'play cap: left a % pickles raise on profile % unchecked (%: %)',
      new.pickles - coalesce(old.pickles, 0), new.id, sqlstate, sqlerrm;
  end;
  return new;
end $$;
revoke execute on function public._pl_profiles_play_cap() from public, anon, authenticated;


-- ════ 6. Pickle history labels for the new sources ═══════════════════════

insert into public.pickle_ledger_sources (source, sign, reason, kind, category, is_bonus, why) values
  ('_grant_new_opponent_bonus',     1, 'New opponent',      'earn',  'match',  false, 'social: a player you never played before (3 a week)'),
  ('_grant_checkin_match_bonus',    1, 'Checked in and played', 'earn', 'match', false, 'social: a match after a court check-in (once a day)'),
  ('_grant_season_organiser_bonus', 1, 'Season organiser',  'bonus', 'league', true,  'ran a season with real play (once per season, 28 days apart)')
on conflict (source, sign) do update
  set reason = excluded.reason, kind = excluded.kind, category = excluded.category,
      is_bonus = excluded.is_bonus, why = excluded.why;
