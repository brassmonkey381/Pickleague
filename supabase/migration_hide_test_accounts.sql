-- ============================================================
-- Hide test accounts from discovery: one app-wide admin switch.
--
-- What it does. Pickleague's live database holds seeded demo players, SIM
-- accounts, the App Review fixture (qa_player_*) and accounts made from God
-- mode's "Quick-create test account". With the switch on, an ordinary player
-- stops coming across those accounts where they meet people they aren't
-- connected to:
--   suggest_friends        Friends > Suggested
--   court_presence         who is at a court (strangers; friends and closed-
--   venue_players_here     league mates still see them, as before)
--   _pl_venue_crowd        the "6 playing now" counts behind venue_crowd and
--                          friends_at_courts' others_here (same exemption)
--   discover_players       NEW: the player search behind every people picker
--                          (Friends > Find, invites, gifts, doubles / MLP
--                          partners), Find Drillers, a league's suggested
--                          players and a tournament's Invite Players. Those
--                          screens read public.profiles directly before.
-- A viewer who is a test account or an admin (God mode) still sees them all,
-- so the App Review account isn't left with an empty app. Not touched (not
-- discovery): your own data, friends lists, friend requests, rosters of
-- leagues and tournaments you're in, match history, standings, wagers.
--
-- The switch is OFF by default, so applying this file changes nothing anyone
-- sees until an admin turns it on in God mode.
--
--   1. profiles.is_test_account   boolean not null default false (+ partial
--      index). Separate from the SIM conventions on purpose: cleanup scripts
--      delete SIM accounts, and a real QA account must never be one delete
--      away. Only an admin RPC, the service role or a migration may change it:
--      a trigger refuses a client's own UPDATE (profiles' RLS lets a user
--      update any column of their own row). New accounts whose sign-in email
--      is a test address (see 5) are marked as they are created.
--   2. app_settings   key / value jsonb, RLS on with no policies and no client
--      grants: read and written only through the RPCs below.
--   3. Helpers (internal, revoked from clients):
--        _pl_test_account_viewer_exempt(viewer)  an admin or a test account
--        _pl_hide_test_accounts_for(viewer)      switch on and viewer not exempt
--        discovery_hidden(target)                the one-row answer for auth.uid()
--      Discovery reads call _pl_hide_test_accounts_for once per query (an
--      uncorrelated scalar subquery, so an InitPlan) and then read
--      p.is_test_account from the profile row they already join.
--   4. RPCs (admins only; anyone else gets 'pl:admin.only' with a message):
--        get_hide_test_accounts() / set_hide_test_accounts(p_on)
--        get_profile_test_account(p_profile) / set_profile_test_account(p_profile, p_on)
--      and discover_players(...) for every signed-in player.
--   5. Backfill (also the rule for new accounts): the 12 demo players seeded by
--      scripts/seed-users.js (by id where scripts/seed-summer-slam.js has one, and
--      by username + full name together; their drill data is supabase/seed_drill_demo.sql),
--      every account whose sign-in email ends in @pickleague.test (seed-users,
--      seed-shady-lee, SIM players, God mode's quick-create, persona tests),
--      and qa_player_<n>@pickleague.club (the App Review fixture,
--      docs/app-review-notes.md). Never the God mode account. Unclaimed DUPR
--      placeholders (dupr-*@unclaimed.pickleague.club) are real club members,
--      not test accounts.
--
-- Each replaced function is copied from the file that last defined it and
-- keeps its signature, return type, security, search_path, grants and
-- comments; the only change is the filter, marked "migration_hide_test_accounts.sql":
--   suggest_friends(int)         migration_presence_p1_friends.sql
--   venue_players_here(text)     migration_presence_p1_reads.sql
--   court_presence(text)         migration_presence_p1_reads.sql
--   _pl_venue_crowd(uuid, text)  migration_presence_p1_reads.sql
-- Before applying on live, run supabase/tests/check-replaced-functions.mjs: it
-- fails with DRIFT if a live body differs from both that file and this one.
-- Re-apply this file after any re-run of migration_presence_p1_friends.sql or
-- migration_presence_p1_reads.sql (they put the unfiltered bodies back), then
-- re-run migration_rls_hardening_2026q3.sql (the new RPCs are on its allowlist).
--
-- Idempotent; no top-level transaction statements (the persona test wraps it).
-- Test: supabase/tests/hide_test_accounts_personas.sql
--   node supabase/tests/build-hide-test-accounts-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- ============================================================


-- ── 1. The flag ────────────────────────────────────────────────────────────
alter table public.profiles add column if not exists is_test_account boolean not null default false;
comment on column public.profiles.is_test_account is
  'A seeded, SIM, QA or review account. Hidden from discovery while app_settings '
  'hide_test_accounts is on (migration_hide_test_accounts.sql). Admin RPC, service '
  'role or migration only; never deleted by SIM cleanup.';
create index if not exists profiles_is_test_account_idx on public.profiles (id) where is_test_account;

-- Whether p_user's sign-in email is a test address (internal; reads auth.users).
create or replace function public._pl_is_test_email(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from auth.users u
     where u.id = p_user
       and (u.email ilike '%@pickleague.test'
            or u.email ~* '^qa_player_[0-9]+@pickleague\.club$')
  );
$$;
revoke all on function public._pl_is_test_email(uuid) from public, anon, authenticated;

-- Two triggers, fired in name order:
--   trg_profiles_test_account_1_guard  SECURITY INVOKER on purpose: current_user
--     is the caller's role, so a client (anon / authenticated) is told no when
--     it changes the flag, and its own INSERT starts unmarked. An admin RPC
--     (SECURITY DEFINER, so the function owner), the service role and a
--     migration go through.
--   trg_profiles_test_account_2_mark   SECURITY DEFINER (it reads auth.users):
--     a new profile whose sign-in email is a test address starts marked.
create or replace function public._pl_guard_test_account_flag()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'UPDATE' and new.is_test_account is distinct from old.is_test_account then
      raise exception using
        message = 'Only a Pickleague admin can mark or unmark a test account. Nothing was changed; ask an admin to switch it on your profile.',
        hint = 'pl:admin.only';
    end if;
    if tg_op = 'INSERT' then
      new.is_test_account := false;
    end if;
  end if;
  return new;
end $$;
revoke all on function public._pl_guard_test_account_flag() from public, anon, authenticated;

create or replace function public._pl_mark_new_test_account()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not new.is_test_account then
    new.is_test_account := public._pl_is_test_email(new.id);
  end if;
  return new;
end $$;
revoke all on function public._pl_mark_new_test_account() from public, anon, authenticated;

drop trigger if exists trg_profiles_test_account_1_guard on public.profiles;
create trigger trg_profiles_test_account_1_guard
  before insert or update of is_test_account on public.profiles
  for each row execute function public._pl_guard_test_account_flag();
drop trigger if exists trg_profiles_test_account_2_mark on public.profiles;
create trigger trg_profiles_test_account_2_mark
  before insert on public.profiles
  for each row execute function public._pl_mark_new_test_account();


-- ── 2. App-wide settings ───────────────────────────────────────────────────
create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id) on delete set null
);
alter table public.app_settings enable row level security;
-- No policies and no grants: the RPCs below are the only way in.
revoke all on table public.app_settings from public, anon, authenticated;
insert into public.app_settings (key, value) values ('hide_test_accounts', 'false'::jsonb)
on conflict (key) do nothing;


-- ── 3. Helpers ─────────────────────────────────────────────────────────────
-- Admins and test accounts see test accounts everywhere.
create or replace function public._pl_test_account_viewer_exempt(p_viewer uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_viewer is not null
     and (public.is_godmode_user(p_viewer)
          or exists (select 1 from public.profiles p where p.id = p_viewer and p.is_test_account));
$$;
revoke all on function public._pl_test_account_viewer_exempt(uuid) from public, anon, authenticated;

-- True when discovery should leave test accounts out for p_viewer: the switch
-- is on and p_viewer is neither an admin nor a test account. Call it once per
-- query, as an uncorrelated scalar subquery: (select public._pl_hide_test_accounts_for(...)).
create or replace function public._pl_hide_test_accounts_for(p_viewer uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select s.value = 'true'::jsonb from public.app_settings s
                    where s.key = 'hide_test_accounts'), false)
     and not public._pl_test_account_viewer_exempt(p_viewer);
$$;
revoke all on function public._pl_hide_test_accounts_for(uuid) from public, anon, authenticated;

-- One target, for the signed-in viewer: true when discovery hides p_target.
create or replace function public.discovery_hidden(p_target uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public._pl_hide_test_accounts_for(auth.uid())
     and exists (select 1 from public.profiles p where p.id = p_target and p.is_test_account);
$$;
revoke all on function public.discovery_hidden(uuid) from public, anon, authenticated;


-- ── 4. Admin RPCs ──────────────────────────────────────────────────────────
create or replace function public.get_hide_test_accounts()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;
  if not public.is_godmode_user(auth.uid()) then
    raise exception using
      message = 'Only a Pickleague admin can see the test account setting. Sign in with an admin account to use it.',
      hint = 'pl:admin.only';
  end if;
  return coalesce((select s.value = 'true'::jsonb from public.app_settings s
                    where s.key = 'hide_test_accounts'), false);
end $$;
revoke all on function public.get_hide_test_accounts() from public, anon;
grant execute on function public.get_hide_test_accounts() to authenticated;

-- Returns the new value.
create or replace function public.set_hide_test_accounts(p_on boolean)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;
  if not public.is_godmode_user(auth.uid()) then
    raise exception using
      message = 'Only a Pickleague admin can hide or show test accounts. Nothing was changed; sign in with an admin account to change it.',
      hint = 'pl:admin.only';
  end if;
  if p_on is null then
    raise exception using message = 'The app didn''t say whether to hide test accounts. Update Pickleague and try again.', hint = 'pl:request.bad';
  end if;
  insert into public.app_settings (key, value, updated_at, updated_by)
  values ('hide_test_accounts', to_jsonb(p_on), now(), auth.uid())
  on conflict (key) do update
    set value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  return p_on;
end $$;
revoke all on function public.set_hide_test_accounts(boolean) from public, anon;
grant execute on function public.set_hide_test_accounts(boolean) to authenticated;

create or replace function public.get_profile_test_account(p_profile uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_flag boolean;
begin
  if auth.uid() is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;
  if not public.is_godmode_user(auth.uid()) then
    raise exception using
      message = 'Only a Pickleague admin can see whether an account is a test account. Sign in with an admin account to use it.',
      hint = 'pl:admin.only';
  end if;
  if p_profile is null then
    raise exception using message = 'The app didn''t say which account. Update Pickleague and try again.', hint = 'pl:request.bad';
  end if;
  select p.is_test_account into v_flag from public.profiles p where p.id = p_profile;
  if not found then
    raise exception using message = 'That account isn''t in Pickleague any more. Go back and pick someone else.', hint = 'pl:player.gone';
  end if;
  return v_flag;
end $$;
revoke all on function public.get_profile_test_account(uuid) from public, anon;
grant execute on function public.get_profile_test_account(uuid) to authenticated;

-- Returns the new value. Marking yourself is allowed (an admin is exempt anyway).
create or replace function public.set_profile_test_account(p_profile uuid, p_on boolean)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;
  if not public.is_godmode_user(auth.uid()) then
    raise exception using
      message = 'Only a Pickleague admin can mark or unmark a test account. Nothing was changed; ask an admin to do it.',
      hint = 'pl:admin.only';
  end if;
  if p_profile is null or p_on is null then
    raise exception using message = 'The app sent an incomplete request. Update Pickleague and try again.', hint = 'pl:request.bad';
  end if;
  update public.profiles p set is_test_account = p_on where p.id = p_profile;
  if not found then
    raise exception using message = 'That account isn''t in Pickleague any more, so it can''t be marked. Go back and pick someone else.', hint = 'pl:player.gone';
  end if;
  return p_on;
end $$;
revoke all on function public.set_profile_test_account(uuid, boolean) from public, anon;
grant execute on function public.set_profile_test_account(uuid, boolean) to authenticated;


-- ── 5. Player search for discovery ─────────────────────────────────────────
-- Every screen that lists people you aren't connected to yet reads this rather
-- than public.profiles (which every client can still read row by row: a
-- profile you open, a roster, a match). Whole profile rows, as those screens
-- read them; the app trims columns with .select(). Deleted accounts never;
-- test accounts left out while the switch is on (see _pl_hide_test_accounts_for).
--   p_min_rating / p_max_rating  overall PLUPR band (null: no bound)
--   p_exclude                    ids to leave out (yourself, members already in)
--   p_drilling_only              only players with drilling on (Find Drillers)
--   p_real_people_only           leave out unclaimed DUPR placeholders and guest passes
--   p_limit                      1-500, default 500
--   p_near_rating                the order (and so which rows a small p_limit
--                                keeps): closest overall PLUPR first, then by
--                                name. Null (the people pickers): by name.
-- A caller that ranks the rows itself (a league's suggested players, Find
-- Drillers, a tournament's Invite Players) passes p_near_rating, so a capped
-- pool is the players nearest its level, never the first names alphabetically.
-- An earlier draft of this file had no p_near_rating; drop that overload so a
-- re-run never leaves two discover_players for PostgREST to choose between.
drop function if exists public.discover_players(numeric, numeric, uuid[], boolean, boolean, int);
create or replace function public.discover_players(
  p_min_rating       numeric default null,
  p_max_rating       numeric default null,
  p_exclude          uuid[]  default null,
  p_drilling_only    boolean default false,
  p_real_people_only boolean default false,
  p_limit            int     default 500,
  p_near_rating      numeric default null
)
returns setof public.profiles
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;
  return query
    select p.*
      from public.profiles p
     where p.deleted_at is null
       and (p_min_rating is null or p.rating >= p_min_rating)
       and (p_max_rating is null or p.rating <= p_max_rating)
       and (p_exclude is null or not (p.id = any (p_exclude)))
       and (not coalesce(p_drilling_only, false) or p.drilling_enabled)
       and (not coalesce(p_real_people_only, false) or (not p.is_unclaimed and not p.is_guest))
       and not ((select public._pl_hide_test_accounts_for(auth.uid())) and p.is_test_account)
     -- Null p_near_rating: every row ties here and the name decides.
     order by abs(p.rating - p_near_rating) nulls last, p.full_name, p.id
     limit greatest(1, least(coalesce(p_limit, 500), 500));
end $$;
revoke all on function public.discover_players(numeric, numeric, uuid[], boolean, boolean, int, numeric) from public, anon;
grant execute on function public.discover_players(numeric, numeric, uuid[], boolean, boolean, int, numeric) to authenticated;


-- ── 6. Backfill ────────────────────────────────────────────────────────────
-- Never the God mode account (scripts/seed-summer-slam.js lists it beside the
-- demo players, but it is a real person).
update public.profiles p
   set is_test_account = true
 where not p.is_test_account
   and not public.is_godmode_user(p.id)
   and (
     -- 11 of the 12 demo players of scripts/seed-users.js, by id (from
     -- scripts/seed-summer-slam.js; it has no id for Jordan Williams, who is
     -- matched by the pair below and by his @pickleague.test email).
     p.id in (
       '1952ae44-20e7-4752-b926-04aad95bbf8a',  -- Marcus Rivera
       'a84662e0-05a4-4d11-88d7-cfc2b028bd12',  -- Sarah Chen
       '64a9bb93-0267-4174-a8b3-4b6320511f23',  -- Priya Patel
       'bd506b6e-0b85-422e-b18a-ab1214e3b1cd',  -- Derek Thompson
       '26a641dd-13b3-4530-a876-246663e8ef2e',  -- Kevin Okafor
       'ce5192a2-8b10-40f8-8083-c7ee7aa7cd8a',  -- Ashley Nguyen
       '62971d61-374f-4029-89e3-e3f8b16599b1',  -- Tyler Brooks
       '6380d220-dbc3-4243-8f71-8390274afb85',  -- Lauren Summers
       '8d902b05-e7c7-4547-b4d0-9bfd5271e13a',  -- Carlos Mendez
       '40cb0f53-ca88-4d71-9e78-99a08d64f77c',  -- Rachel Kim
       'eb6bbd6d-ef84-4a77-8b27-70fc358f7331'   -- Megan Foster
     )
     -- The same players by username AND full name together (a real player who
     -- picked one of these handles alone is not caught).
     or (p.username, p.full_name) in (
       ('marcusrivera', 'Marcus Rivera'), ('sarahchen', 'Sarah Chen'), ('derekthompson', 'Derek Thompson'),
       ('priyapatel', 'Priya Patel'), ('jordanwilliams', 'Jordan Williams'), ('ashleynguyen', 'Ashley Nguyen'),
       ('tylerbrooks', 'Tyler Brooks'), ('meganfoster', 'Megan Foster'), ('carlosmendez', 'Carlos Mendez'),
       ('rachelkim', 'Rachel Kim'), ('kevinokafor', 'Kevin Okafor'), ('laurensummers', 'Lauren Summers')
     )
     -- Test sign-in emails: @pickleague.test, qa_player_<n>@pickleague.club.
     or public._pl_is_test_email(p.id)
   );


-- ── 7. Discovery reads, filtered ───────────────────────────────────────────

-- suggest_friends: from migration_presence_p1_friends.sql (its only definition).
-- People I have really played with: completed matches together in the last
-- 180 days (any of the four player columns), drill sessions in the last 180
-- days, closed leagues we are both in (both admitted while it was closed, as
-- share_closed_league counts them). Ranked in that order (score packs the
-- three counts). Leaves out friends, pending requests, a decline in the last
-- 30 days, blocked pairs, guests, unclaimed placeholders and deleted accounts.
create or replace function public.suggest_friends(p_limit int default 10)
returns table (user_id uuid, full_name text, avatar_url text, avatar_emoji text, avatar_bg_color text,
               doubles_rating numeric, reason text, score int)
language sql
stable
security definer
set search_path = ''
as $$
  with me as (
    select auth.uid() as id
     where auth.uid() is not null and not public._pl_presence_viewer_is_guest(auth.uid())
  ),
  co_match as (
    select u.uid, count(distinct m.id) as n
      from me
      join public.matches m
        on me.id in (m.player1_id, m.partner1_id, m.player2_id, m.partner2_id)
       and m.status = 'completed'
       and m.played_at > now() - interval '180 days'
      cross join lateral unnest(array[m.player1_id, m.partner1_id, m.player2_id, m.partner2_id]) as u(uid)
     where u.uid is not null and u.uid <> me.id
     group by u.uid
  ),
  co_drill as (
    select case when d.player1_id = me.id then d.player2_id else d.player1_id end as uid, count(*) as n
      from me
      join public.drill_sessions d
        on me.id in (d.player1_id, d.player2_id)
       and d.session_date between current_date - 180 and current_date
     group by 1
  ),
  co_league as (
    select mb.user_id as uid, count(distinct l.id) as n, min(l.name) as league_name
      from me
      join public.league_members ma on ma.user_id = me.id and ma.admitted_closed
                                   and (ma.expires_at is null or ma.expires_at > now())
      join public.leagues l on l.id = ma.league_id and not l.is_open
      join public.league_members mb on mb.league_id = ma.league_id and mb.user_id <> me.id
                                   and mb.admitted_closed
                                   and (mb.expires_at is null or mb.expires_at > now())
     group by mb.user_id
  ),
  cand as (
    select x.uid, sum(x.m) as m, sum(x.d) as d, sum(x.l) as l, max(x.league_name) as league_name
      from (
        select uid, n as m, 0 as d, 0 as l, null::text as league_name from co_match
        union all select uid, 0, n, 0, null from co_drill
        union all select uid, 0, 0, n, league_name from co_league
      ) x
     group by x.uid
  )
  select p.id, p.full_name, p.avatar_url, p.avatar_emoji, p.avatar_bg_color, p.doubles_rating,
         case when c.m > 0 then c.m || case when c.m = 1 then ' match together' else ' matches together' end
              when c.d > 0 then 'Drilled ' || c.d || 'x'
              else 'Both in ' || c.league_name end,
         (least(c.m, 99) * 10000 + least(c.d, 99) * 100 + least(c.l, 99))::int
    from cand c
    cross join me
    join public.profiles p on p.id = c.uid
   where not p.is_guest and not p.is_unclaimed and p.deleted_at is null
     -- Test accounts, while the admin switch is on (migration_hide_test_accounts.sql).
     and not ((select public._pl_hide_test_accounts_for(auth.uid())) and p.is_test_account)
     and not public.blocked_between(me.id, p.id)
     and not exists (
       select 1 from public.friendships f
        where least(f.requester_id, f.addressee_id) = least(me.id, p.id)
          and greatest(f.requester_id, f.addressee_id) = greatest(me.id, p.id)
          and (f.status in ('pending', 'accepted') or f.responded_at > now() - interval '30 days'))
   order by 8 desc, lower(p.full_name)
   limit greatest(1, least(coalesce(p_limit, 10), 50));
$$;
revoke all on function public.suggest_friends(int) from public, anon;
grant execute on function public.suggest_friends(int) to authenticated;


-- venue_players_here: from migration_presence_p1_reads.sql (the newest of its
-- two definitions; migration_venue_checkins.sql's is older).
create or replace function public.venue_players_here(p_venue text)
returns table (
  checkin_id      uuid,
  user_id         uuid,
  full_name       text,
  avatar_url      text,
  avatar_emoji    text,
  avatar_bg_color text,
  rating          numeric,
  doubles_rating  numeric,
  checked_in_at   timestamptz,
  expires_at      timestamptz
)
language sql
volatile
security definer
set search_path = ''
as $$
  with canon as (select public._pl_canonical_venue(p_venue) as id)
  select case when s.vis = 'named' then c.id else gen_random_uuid() end,
         case when s.vis = 'named' then c.user_id end,
         case when s.vis = 'named' then p.full_name end,
         case when s.vis = 'named' then p.avatar_url end,
         case when s.vis = 'named' then p.avatar_emoji end,
         case when s.vis = 'named' then p.avatar_bg_color end,
         case when s.vis = 'named' then p.rating end,
         case when s.vis = 'named' then p.doubles_rating end,
         case when s.vis = 'named' then c.checked_in_at else date_trunc('hour', c.checked_in_at) end,
         case when s.vis = 'named' then c.expires_at else date_trunc('hour', c.expires_at) + interval '1 hour' end
    from canon
    join public.venue_checkins c
      on c.venue_id in (select v.id from public.venues v where v.id = canon.id or v.canonical_id = canon.id)
    join public.profiles p on p.id = c.user_id and p.deleted_at is null
    cross join lateral (
      select public._pl_can_see_presence(auth.uid(), c.user_id, 'checkins') as vis offset 0
    ) s
   where auth.uid() is not null
     and c.checked_out_at is null
     and c.expires_at > now()
     and (c.location_confirmed or c.user_id = auth.uid())
     and s.vis <> 'none'
     -- Guests get counts only (venue_crowd), never rows: just their own.
     and (c.user_id = auth.uid() or not public._pl_presence_viewer_is_guest(auth.uid()))
     -- A test account, while the admin switch is on, is not shown to anyone it
     -- isn't connected to (migration_hide_test_accounts.sql).
     and not ((select public._pl_hide_test_accounts_for(auth.uid())) and p.is_test_account
              and c.user_id is distinct from auth.uid()
              and not public.are_friends(auth.uid(), c.user_id)
              and not public.share_closed_league(auth.uid(), c.user_id))
   order by (s.vis = 'named') desc, case when s.vis = 'named' then c.checked_in_at end, 1;
$$;
revoke execute on function public.venue_players_here(text) from public, anon;
grant execute on function public.venue_players_here(text) to authenticated;

-- court_presence: from migration_presence_p1_reads.sql (its only definition).
-- My own row first, then named players by arrival, then anonymous ones (in no
-- meaningful order). via_session: the check-in came from a session, or the
-- player has an open session at this court (session_kind is its kind); named
-- rows only.
create or replace function public.court_presence(p_venue text)
returns table (
  checkin_id      uuid,
  user_id         uuid,
  full_name       text,
  avatar_url      text,
  avatar_emoji    text,
  avatar_bg_color text,
  doubles_rating  numeric,
  checked_in_at   timestamptz,
  expires_at      timestamptz,
  anonymous       boolean,
  is_friend       boolean,
  is_close_friend boolean,
  via_session     boolean,
  session_kind    text
)
language sql
volatile
security definer
set search_path = ''
as $$
  with canon as (select public._pl_canonical_venue(p_venue) as id),
  grp as (select v.id from public.venues v, canon where v.id = canon.id or v.canonical_id = canon.id),
  vis_rows as (
    select c.*, p.full_name, p.avatar_url, p.avatar_emoji, p.avatar_bg_color,
           p.doubles_rating as rating, s.vis
      from public.venue_checkins c
      join public.profiles p on p.id = c.user_id and p.deleted_at is null
      cross join lateral (
        select public._pl_can_see_presence(auth.uid(), c.user_id, 'checkins') as vis offset 0
      ) s
     where auth.uid() is not null
       and c.venue_id in (select id from grp)
       and c.checked_out_at is null
       and c.expires_at > now()
       and (c.location_confirmed or c.user_id = auth.uid())
       and s.vis <> 'none'
       -- Guests get counts only (venue_crowd), never rows: just their own.
       and (c.user_id = auth.uid() or not public._pl_presence_viewer_is_guest(auth.uid()))
       -- A test account, while the admin switch is on, is not shown to anyone it
       -- isn't connected to (migration_hide_test_accounts.sql).
       and not ((select public._pl_hide_test_accounts_for(auth.uid())) and p.is_test_account
                and c.user_id is distinct from auth.uid()
                and not public.are_friends(auth.uid(), c.user_id)
                and not public.share_closed_league(auth.uid(), c.user_id))
  )
  select case when r.vis = 'named' then r.id else gen_random_uuid() end,
         case when r.vis = 'named' then r.user_id end,
         case when r.vis = 'named' then r.full_name end,
         case when r.vis = 'named' then r.avatar_url end,
         case when r.vis = 'named' then r.avatar_emoji end,
         case when r.vis = 'named' then r.avatar_bg_color end,
         case when r.vis = 'named' then r.rating end,
         case when r.vis = 'named' then r.checked_in_at else date_trunc('hour', r.checked_in_at) end,
         case when r.vis = 'named' then r.expires_at else date_trunc('hour', r.expires_at) + interval '1 hour' end,
         r.vis <> 'named',
         r.vis = 'named' and r.user_id <> auth.uid() and public.are_friends(auth.uid(), r.user_id),
         r.vis = 'named' and exists (select 1 from public.close_friends cf
                                      where cf.user_id = auth.uid() and cf.friend_id = r.user_id),
         r.vis = 'named' and (r.source = 'session' or ps.id is not null),
         case when r.vis = 'named' then ps.kind end
    from vis_rows r
    left join lateral (
      select s.id, s.kind
        from public.play_sessions s
       where r.vis = 'named'
         and s.user_id = r.user_id and s.ended_at is null
         and s.started_at > now() - interval '6 hours'
         and (s.id = r.id or s.venue_id in (select id from grp))
       order by s.started_at desc
       limit 1
    ) ps on true
   order by (r.user_id = auth.uid()) desc, (r.vis = 'named') desc,
            case when r.vis = 'named' then r.checked_in_at end, 1;
$$;
revoke all on function public.court_presence(text) from public, anon;
grant execute on function public.court_presence(text) to authenticated;


-- _pl_venue_crowd: from migration_presence_p1_reads.sql (its only definition).
-- Behind venue_crowd and friends_at_courts' others_here; friends_here is
-- unchanged (friends are exempt).
-- One facility's crowd as p_viewer sees it (internal). here_now counts every
-- confirmed open check-in, hidden and paused players included, except a
-- blocked pair (either way), who never count for each other. The band is the
-- 25th-75th percentile of the PLUPR doubles ratings of the rated players this
-- viewer sees only as anonymous (never the viewer, never anyone shown by name,
-- whose rating the viewer already has), rounded to 0.25, and only with 3+ of
-- them (rated = has played a match, as the standings treat it), so it never
-- describes one person. friends_here counts friends the viewer sees by name.
create or replace function public._pl_venue_crowd(p_viewer uuid, p_canon text)
returns table (here_now int, band_low numeric, band_high numeric, friends_here int)
language sql
stable
security definer
set search_path = ''
as $$
  with here as (
    select distinct c.user_id, p.doubles_rating, p.total_matches_played
      from public.venue_checkins c
      join public.profiles p on p.id = c.user_id and p.deleted_at is null
     where c.venue_id in (select v.id from public.venues v where v.id = p_canon or v.canonical_id = p_canon)
       and c.checked_out_at is null
       and c.expires_at > now()
       and c.location_confirmed
       -- A test account, while the admin switch is on, is not counted for anyone
       -- it isn't connected to (migration_hide_test_accounts.sql).
       and not ((select public._pl_hide_test_accounts_for(p_viewer)) and p.is_test_account
                and c.user_id is distinct from p_viewer
                and not public.are_friends(p_viewer, c.user_id)
                and not public.share_closed_league(p_viewer, c.user_id))
  ),
  seen as (
    select h.*, public._pl_can_see_presence(p_viewer, h.user_id, 'checkins') as vis
      from here h
  ),
  rated as (
    select s.doubles_rating as r from seen s
     where s.vis = 'anonymous'
       and s.doubles_rating is not null and s.total_matches_played > 0
  )
  select (select count(*)::int from seen s where s.vis <> 'none'),
         case when (select count(*) from rated) >= 3 then
           (round((select percentile_cont(0.25) within group (order by r) from rated)::numeric * 4) / 4)::numeric(4,2) end,
         case when (select count(*) from rated) >= 3 then
           (round((select percentile_cont(0.75) within group (order by r) from rated)::numeric * 4) / 4)::numeric(4,2) end,
         (select count(*)::int from seen s
           where s.user_id <> p_viewer and s.vis = 'named'
             and public.are_friends(p_viewer, s.user_id));
$$;
revoke all on function public._pl_venue_crowd(uuid, text) from public, anon, authenticated;


notify pgrst, 'reload schema';
