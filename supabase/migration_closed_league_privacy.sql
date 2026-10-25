-- ============================================================
-- Closed league privacy: a closed (private, invite-only) league's roster, home
-- court, seasons, standings, events and matches are for its members.
--
-- Before this file every one of those tables had a SELECT policy
-- `using (true)`, so anyone holding the public anon key, signed out
-- included, could read a closed league's roster and home court. Worse,
-- invite_codes had "Invite codes lookup" `using (true)`: anyone could list a
-- closed league's live invite code and redeem it.
--
-- ── The rule ────────────────────────────────────────────────────────────────
-- public._pl_can_see_league(league_id) is true when
--   * the league is open (leagues.is_open, null counts as open, as the app
--     reads it), or
--   * the caller created it, or
--   * the caller is a member whose membership has not expired (guest members
--     carry expires_at; the same test share_closed_league and
--     discover_players_near already use), or
--   * the caller is godmode (is_godmode_user(uid)).
-- Signed out (auth.uid() null) only the open test can pass.
--
--   leagues                  is_open, or created_by = me, or _pl_can_see_league(id)
--   league_members           my own rows, or _pl_can_see_league(league_id)
--   league_player_ratings    my own rows, or _pl_can_see_league(league_id)
--   season_snapshots         my own rows, or _pl_can_see_league(league_id)
--   season_final_standings   my own rows, or _pl_can_see_league(league_id)
--   league_seasons           _pl_can_see_league(league_id)
--   league_events            _pl_can_see_league(league_id)
--   matches                  no league, or I played in it, or _pl_can_see_league(league_id)
--   invite_codes             tournament codes as before; league codes only
--                            through "Scope admins manage codes" (admins)
--   league_invites           the legacy "Anyone can look up invite by token"
--                            policy goes (0 rows on live; members still read
--                            theirs through "Invites viewable by league members")
--
-- created_by is tested on the leagues row itself, not through the helper: an
-- INSERT ... RETURNING (LeaguesScreen creates a league with .select()) checks
-- the new row before any helper query could see it, and the creator's admin
-- row is only inserted afterwards.
--
-- Own rows stay readable so a player who left a closed league (or whose guest
-- membership expired) still sees their own history and standings.
--
-- ── What non-members still get ─────────────────────────────────────────────
-- Closed leagues stay discoverable to SIGNED-IN players (Discover and Home list
-- them with "Request code"; a league link opens a "Want in?" page). Two RPCs,
-- authenticated only, give exactly that much:
--   get_league_preview(p_league_id)  one league, open or closed
--   list_league_previews()           active closed leagues I can't see
-- Each row: id, name, description, is_open, is_active, created_at,
-- member_count, match_count, recent_match_count (30 days), play_days, and
-- approx_lat / approx_lng: the home court rounded to 0.02 degrees (about a
-- mile), enough to place the league in a 5-mile search area without naming
-- or pinning its court. No roster, no admin, no home court name, no venue.
-- Signed out: nothing about a closed league.
--
-- Join flows are unchanged: request_league_join, redeem_invite_code,
-- get_guest_invite_preview / redeem_guest_invite are SECURITY DEFINER and
-- never read through these policies.
--
-- Not covered here (follow-ups): tournaments of a closed league and their
-- registrations / teams / brackets, and event_slots / event_slot_votes /
-- event_declines (keyed by event id only), still read `using (true)`.
--
-- Re-runnable: drops the old "everyone" SELECT policies (any SELECT policy
-- whose qual is just `true`) and its own policies by name, then creates them.
-- ============================================================

-- ── The helper ──────────────────────────────────────────────────────────────
-- Policies run their functions with the CALLER's privileges, so anon and
-- authenticated need EXECUTE (anon too: an anon read of leagues evaluates the
-- policy). It only answers "can I see this league", which is harmless.
create or replace function public._pl_can_see_league(p_league_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_league_id is not null and (
    exists (
      select 1 from public.leagues l
       where l.id = p_league_id
         and (coalesce(l.is_open, true)
              or (auth.uid() is not null and l.created_by = auth.uid()))
    )
    or (
      auth.uid() is not null
      and (
        public.is_godmode_user(auth.uid())
        or exists (
          select 1 from public.league_members m
           where m.league_id = p_league_id
             and m.user_id = auth.uid()
             and (m.expires_at is null or m.expires_at > now())
        )
      )
    )
  );
$$;

revoke execute on function public._pl_can_see_league(uuid) from public;
grant execute on function public._pl_can_see_league(uuid) to anon, authenticated, service_role;

-- ── Drop the old "everyone" SELECT policies, and this file's own ───────────
do $$
declare r record;
begin
  for r in
    select pol.tablename, pol.policyname
      from pg_policies pol
     where pol.schemaname = 'public'
       and pol.tablename in ('leagues', 'league_members', 'league_player_ratings', 'league_seasons',
                             'season_snapshots', 'season_final_standings', 'league_events', 'matches')
       and pol.cmd = 'SELECT'
       and (pol.qual = 'true' or pol.policyname like 'Closed league privacy:%')
  loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

drop policy if exists "Anyone can look up invite by token" on public.league_invites;
drop policy if exists "Invite codes lookup" on public.invite_codes;
drop policy if exists "Closed league privacy: tournament codes" on public.invite_codes;

-- ── The new SELECT policies ─────────────────────────────────────────────────
-- Column references are on the policy's own table (no subqueries), so there
-- is nothing for a correlated subquery to capture.
--
-- NO SUBQUERIES AT ALL, not even the usual `(select auth.uid())`: Postgres
-- raises "infinite recursion detected in policy for relation league_members"
-- when a policy being expanded has a sublink and its table is already being
-- expanded. "Admins can update member roles" (UPDATE) reads league_members
-- lm2 in a subquery, so an INSERT ... ON CONFLICT DO UPDATE on league_members
-- (an old bundle's Join, tap_time_personas.sql T37/T38) expands this SELECT
-- policy inside it; with a `(select auth.uid())` sublink here that is an
-- error. Plain auth.uid() is evaluated per row, which is fine at this size.
create policy "Closed league privacy: leagues" on public.leagues
  for select using (
    coalesce(is_open, true)
    or (auth.uid() is not null and created_by = auth.uid())
    or public._pl_can_see_league(id)
  );

create policy "Closed league privacy: league_members" on public.league_members
  for select using (
    user_id = auth.uid()
    or public._pl_can_see_league(league_id)
  );

create policy "Closed league privacy: league_player_ratings" on public.league_player_ratings
  for select using (
    user_id = auth.uid()
    or public._pl_can_see_league(league_id)
  );

create policy "Closed league privacy: season_snapshots" on public.season_snapshots
  for select using (
    user_id = auth.uid()
    or public._pl_can_see_league(league_id)
  );

create policy "Closed league privacy: season_final_standings" on public.season_final_standings
  for select using (
    user_id = auth.uid()
    or public._pl_can_see_league(league_id)
  );

create policy "Closed league privacy: league_seasons" on public.league_seasons
  for select using (public._pl_can_see_league(league_id));

create policy "Closed league privacy: league_events" on public.league_events
  for select using (public._pl_can_see_league(league_id));

create policy "Closed league privacy: matches" on public.matches
  for select using (
    league_id is null
    or auth.uid() in (player1_id, player2_id, partner1_id, partner2_id)
    or public._pl_can_see_league(league_id)
  );

-- Tournament codes keep their open lookup (tournament privacy is a separate
-- follow-up); league codes are read only by their admins, through
-- "Scope admins manage codes".
create policy "Closed league privacy: tournament codes" on public.invite_codes
  for select using (scope_type = 'tournament');

-- ── Previews for signed-in non-members ─────────────────────────────────────
create or replace function public.get_league_preview(p_league_id uuid)
returns table (
  id uuid, name text, description text, is_open boolean, is_active boolean, created_at timestamptz,
  member_count integer, match_count integer, recent_match_count integer, play_days integer,
  approx_lat double precision, approx_lng double precision
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.',
                          hint = 'pl:auth.signed_out';
  end if;

  return query
  select l.id, l.name, l.description, coalesce(l.is_open, true), coalesce(l.is_active, true), l.created_at,
         (select count(*)::integer from public.league_members m
           where m.league_id = l.id and (m.expires_at is null or m.expires_at > now())),
         (select count(*)::integer from public.matches x
           where x.league_id = l.id and x.status = 'completed'),
         (select count(*)::integer from public.matches x
           where x.league_id = l.id and x.status = 'completed' and x.played_at > now() - interval '30 days'),
         (select count(distinct (x.played_at at time zone 'UTC')::date)::integer from public.matches x
           where x.league_id = l.id and x.status = 'completed'),
         case when l.home_court_lat is null or l.home_court_lng is null
                   or (l.home_court_lat = 0 and l.home_court_lng = 0) then null
              else round(l.home_court_lat::numeric * 50) / 50 end::double precision,
         case when l.home_court_lat is null or l.home_court_lng is null
                   or (l.home_court_lat = 0 and l.home_court_lng = 0) then null
              else round(l.home_court_lng::numeric * 50) / 50 end::double precision
    from public.leagues l
   where l.id = p_league_id;
end $$;

create or replace function public.list_league_previews()
returns table (
  id uuid, name text, description text, is_open boolean, is_active boolean, created_at timestamptz,
  member_count integer, match_count integer, recent_match_count integer, play_days integer,
  approx_lat double precision, approx_lng double precision
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.',
                          hint = 'pl:auth.signed_out';
  end if;

  return query
  select p.*
    from public.leagues l
    cross join lateral public.get_league_preview(l.id) p
   where not coalesce(l.is_open, true)
     and coalesce(l.is_active, true)
     and not public._pl_can_see_league(l.id)
   order by l.created_at desc
   limit 500;
end $$;

revoke execute on function public.get_league_preview(uuid) from public, anon;
revoke execute on function public.list_league_previews() from public, anon;
grant execute on function public.get_league_preview(uuid) to authenticated, service_role;
grant execute on function public.list_league_previews() to authenticated, service_role;
