-- ============================================================
-- Player search by name: search_players(...)
--
-- Discover > Players' search was limited to the search area (players placed
-- by the home courts of their leagues: discover_players_near), and only a
-- handful of players are in a league with a located court, so a name search
-- found almost no one. The user, 2026-10-24: typing a NAME finds anyone, with
-- the players near the search area listed first; with no name typed the list
-- stays the nearby list (the app reads discover_players_near for that, as
-- before).
--
-- discover_players (the invite pickers' "search all") cannot do this alone:
-- it applies no blocks, and the app can only leave out the players IT blocked
-- (who blocked you is not readable: user_blocks is owner-only). So this NEW
-- read searches everyone by name or @username, server side, with:
--   - blocks both ways left out (_pl_blocked_pair), and the viewer;
--   - deleted accounts, test accounts while God mode hides them
--     (_pl_hide_test_accounts_for), p_exclude and (p_real_people_only)
--     unclaimed DUPR placeholders and guest passes left out, as in
--     discover_players / discover_players_near;
--   - a place ONLY for the players discover_players_near places in the area
--     (it is called here, so the rule lives in one function: the home courts
--     of their leagues, open leagues or closed leagues the viewer is in too).
--     Everyone else comes back with place_name / place_kind / distance_m null:
--     a starred court, a check-in, presence or where they are now is never
--     read, so nothing about where anyone else plays is revealed. A closed
--     league's member is still found by name, without the place.
-- The columns are discover_players_near's (the people lists'); no phone,
-- email or the rest of profiles.
--
-- Order: the placed players first, nearest first; then everyone else, names
-- that START with the query (or a word in the name does) before names that
-- only contain it, then by name. p_query: at least 2 characters after a
-- leading @ (else refused with pl:input.invalid), at most 80 kept; % and _
-- are literal. No centre (p_lat / p_lng null): nobody is placed, everyone is
-- searched by name. Radius as discover_players_near (100 m .. 50 mi);
-- p_limit 1 .. 200, default 60.
--
-- New function only: nothing existing is replaced, so there is no drift
-- check. Client-callable: granted to authenticated here AND listed in
-- migration_rls_hardening_2026q3.sql's allowlist (a re-run of that file keeps
-- it online). Apply this file on its own; do not re-run the hardening file to
-- "install" the grant. Needs migration_discover_players_near.sql (live).
--
-- Idempotent; no top-level transaction statements (the persona test wraps it).
-- Test: supabase/tests/search_players_personas.sql
--   node supabase/tests/build-search-players-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- ============================================================

create or replace function public.search_players(
  p_query            text,
  p_lat              double precision default null,
  p_lng              double precision default null,
  p_radius_m         double precision default 8047,
  p_real_people_only boolean default false,
  p_exclude          uuid[]  default null,
  p_limit            int     default 60
)
returns table (
  id                   uuid,
  username             text,
  full_name            text,
  avatar_url           text,
  avatar_id            int,
  avatar_emoji         text,
  avatar_bg_color      text,
  rating               numeric,
  doubles_rating       numeric,
  total_matches_played int,
  drilling_enabled     boolean,
  drill_availability   jsonb,
  drill_shot_prefs     text[],
  drill_partner_prefs  text[],
  drill_custom_tags    text[],
  place_name           text,
  place_kind           text,
  distance_m           double precision
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_me     uuid := auth.uid();
  v_raw    text;
  v_q      text;
  v_hide   boolean;
  v_ids    uuid[];
  v_places text[];
  v_dists  double precision[];
begin
  if v_me is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;
  v_raw := left(btrim(regexp_replace(coalesce(p_query, ''), '^\s*@', '')), 80);
  if char_length(v_raw) < 2 then
    raise exception using errcode = '22023',
      message = 'Type at least 2 letters of a name to search.',
      hint = 'pl:input.invalid';
  end if;
  if (p_lat is null) <> (p_lng is null)
     or (p_lat is not null and (p_lat < -90 or p_lat > 90 or p_lng < -180 or p_lng > 180)) then
    raise exception using errcode = '22023',
      message = 'Pick a place to search near (your location or a city), then try again.',
      hint = 'pl:input.invalid';
  end if;

  v_q    := replace(replace(replace(v_raw, '\', '\\'), '%', '\%'), '_', '\_');
  v_hide := public._pl_hide_test_accounts_for(v_me);

  -- Who is near: discover_players_near's own rule (league home courts only),
  -- narrowed by the same name. Nobody without a centre.
  if p_lat is not null then
    select coalesce(array_agg(n.id), '{}'), coalesce(array_agg(n.place_name), '{}'), coalesce(array_agg(n.distance_m), '{}')
      into v_ids, v_places, v_dists
      from public.discover_players_near(p_lat, p_lng, p_radius_m, v_raw, false, p_real_people_only, p_exclude, 500) n;
  end if;

  return query
  with near as (
    select u.n_id, u.n_place, u.n_dist
      from unnest(coalesce(v_ids, '{}'::uuid[]), coalesce(v_places, '{}'::text[]), coalesce(v_dists, '{}'::double precision[]))
           as u(n_id, n_place, n_dist)
  )
  select p.id, p.username, p.full_name, p.avatar_url, p.avatar_id, p.avatar_emoji, p.avatar_bg_color,
         p.rating, p.doubles_rating, p.total_matches_played,
         p.drilling_enabled, p.drill_availability, p.drill_shot_prefs, p.drill_partner_prefs, p.drill_custom_tags,
         n.n_place,
         case when n.n_id is null then null else 'league' end,
         n.n_dist
    from public.profiles p
    left join near n on n.n_id = p.id
   where p.deleted_at is null
     and p.id <> v_me
     and (p_exclude is null or not (p.id = any (p_exclude)))
     and (not coalesce(p_real_people_only, false) or (not coalesce(p.is_unclaimed, false) and not coalesce(p.is_guest, false)))
     and not (v_hide and p.is_test_account)
     and not public._pl_blocked_pair(v_me, p.id)
     and (p.full_name ilike '%' || v_q || '%' or p.username ilike '%' || v_q || '%')
   order by (n.n_id is null),
            n.n_dist,
            (case when p.full_name ilike v_q || '%' or p.full_name ilike '% ' || v_q || '%' or p.username ilike v_q || '%'
                  then 0 else 1 end),
            p.full_name, p.id
   limit greatest(1, least(coalesce(p_limit, 60), 200));
end $$;

comment on function public.search_players(text, double precision, double precision, double precision, boolean, uuid[], int) is
  'Everyone whose name or @username contains p_query (2+ characters), blocks both ways and test accounts left out; '
  'the players discover_players_near places near (p_lat, p_lng) first, with that place, everyone else unplaced. '
  'migration_search_players.sql';

revoke all on function public.search_players(text, double precision, double precision, double precision, boolean, uuid[], int) from public, anon;
grant execute on function public.search_players(text, double precision, double precision, double precision, boolean, uuid[], int) to authenticated;
