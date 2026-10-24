-- ============================================================
-- Players near a search area: discover_players_near(...)
--
-- Discover's one search area (centre = your location or a searched city,
-- radius = your setting) now limits every search, players and drill partners
-- included; the invite pickers suggest the players near a league's home court
-- or a tournament's venue the same way. discover_players has no location, so
-- this NEW read finds the players who PLAY within p_radius_m of (p_lat,
-- p_lng), by ONE source only (the user, 2026-10-24: "League courts only"):
--   league    the home court of an active league they belong to (a guest pass
--             that has run out doesn't count). Open leagues only, or a closed
--             league the viewer is in too: a closed league's roster is not
--             public.
-- Nothing else places a player: not the courts they starred (court_favorites
-- stays owner-only), not the courts they check in at (venue_checkins, past or
-- live), not fixes. So presence privacy ("Who sees me at the courts", a
-- pause, "hide from") is never read here and can never be bypassed: no
-- check-in is used, so none is revealed.
--
-- Left out, as in discover_players: deleted accounts, test accounts while God
-- mode hides them (_pl_hide_test_accounts_for), and (p_real_people_only)
-- unclaimed DUPR placeholders and guest passes. Also left out here: the
-- viewer, p_exclude, and anyone blocked either way (_pl_blocked_pair).
--
-- One row per player, at their nearest league court in the area: place_name /
-- distance_m say which ("Plays at Lakeside Park, 1.2 mi"); place_kind is
-- always 'league' (kept so the columns stay those the app reads). The
-- columns are the ones the people lists and Find Drillers read; phone, email
-- and the rest of profiles are not returned. Nearest first, then by name.
-- p_query narrows by name or @username (a leading @ is ignored; % and _ are
-- literal). Radius 100 m .. 50 mi (80,468 m); at most 500 rows.
--
-- New function only: nothing existing is replaced, so there is no drift
-- check. The first draft (which also placed players by their starred and
-- frequent courts) was never applied, so this file was edited in place.
-- Client-callable: granted to authenticated here AND listed in
-- migration_rls_hardening_2026q3.sql's allowlist (a re-run of that file keeps
-- it online). Apply this file on its own; do not re-run the hardening file to
-- "install" the grant.
--
-- Idempotent; no top-level transaction statements (the persona test wraps it).
-- Test: supabase/tests/players_near_personas.sql
--   node supabase/tests/build-players-near-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- ============================================================

create or replace function public.discover_players_near(
  p_lat              double precision,
  p_lng              double precision,
  p_radius_m         double precision default 8047,
  p_query            text    default null,
  p_drilling_only    boolean default false,
  p_real_people_only boolean default false,
  p_exclude          uuid[]  default null,
  p_limit            int     default 200
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
  v_me   uuid := auth.uid();
  v_r    double precision;
  v_dlat double precision;
  v_dlng double precision;
  v_hide boolean;
  v_q    text;
begin
  if v_me is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;
  if p_lat is null or p_lng is null or p_lat < -90 or p_lat > 90 or p_lng < -180 or p_lng > 180 then
    raise exception using errcode = '22023',
      message = 'Pick a place to search near (your location or a city), then try again.',
      hint = 'pl:input.invalid';
  end if;

  v_r    := least(greatest(coalesce(p_radius_m, 8047), 100), 80468);
  -- A box around the circle first (cheap), then the great-circle distance.
  -- 1% wider than the circle, so the box never clips its edge (111,320 m a
  -- degree vs the ~111,195 m the distance below implies).
  v_dlat := v_r * 1.01 / 111320.0;
  v_dlng := v_r * 1.01 / (111320.0 * greatest(cos(radians(p_lat)), 0.01));
  v_hide := public._pl_hide_test_accounts_for(v_me);
  v_q    := nullif(btrim(regexp_replace(coalesce(p_query, ''), '^\s*@', '')), '');
  if v_q is not null then
    v_q := replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_');
  end if;

  return query
  with anchors as (
    select lm.user_id as a_user, l.home_court as a_place, 'league'::text as a_kind,
           l.home_court_lat as a_lat, l.home_court_lng as a_lng
      from public.league_members lm
      join public.leagues l on l.id = lm.league_id
     where coalesce(l.is_active, true)
       and l.home_court_lat is not null and l.home_court_lng is not null
       and not (l.home_court_lat = 0 and l.home_court_lng = 0)
       and l.home_court_lat between p_lat - v_dlat and p_lat + v_dlat
       and l.home_court_lng between p_lng - v_dlng and p_lng + v_dlng
       and (lm.expires_at is null or lm.expires_at > now())
       and (l.is_open
            or exists (select 1 from public.league_members mine
                        where mine.league_id = l.id and mine.user_id = v_me
                          and (mine.expires_at is null or mine.expires_at > now())))
  ),
  measured as (
    select a.a_user, a.a_place, a.a_kind,
           2 * 6371008.8 * asin(least(1.0, sqrt(
             power(sin(radians(a.a_lat - p_lat) / 2), 2)
             + cos(radians(p_lat)) * cos(radians(a.a_lat)) * power(sin(radians(a.a_lng - p_lng) / 2), 2)
           ))) as a_dist
      from anchors a
     where a.a_user <> v_me
  ),
  nearest as (
    select distinct on (m.a_user) m.a_user, m.a_place, m.a_kind, m.a_dist
      from measured m
     where m.a_dist <= v_r
     order by m.a_user, m.a_dist, m.a_place
  )
  select p.id, p.username, p.full_name, p.avatar_url, p.avatar_id, p.avatar_emoji, p.avatar_bg_color,
         p.rating, p.doubles_rating, p.total_matches_played,
         p.drilling_enabled, p.drill_availability, p.drill_shot_prefs, p.drill_partner_prefs, p.drill_custom_tags,
         n.a_place, n.a_kind, n.a_dist
    from nearest n
    join public.profiles p on p.id = n.a_user
   where p.deleted_at is null
     and (p_exclude is null or not (p.id = any (p_exclude)))
     and (not coalesce(p_drilling_only, false) or p.drilling_enabled)
     and (not coalesce(p_real_people_only, false) or (not coalesce(p.is_unclaimed, false) and not coalesce(p.is_guest, false)))
     and not (v_hide and p.is_test_account)
     and not public._pl_blocked_pair(v_me, p.id)
     and (v_q is null or p.full_name ilike '%' || v_q || '%' or p.username ilike '%' || v_q || '%')
   order by n.a_dist, p.full_name, p.id
   limit greatest(1, least(coalesce(p_limit, 200), 500));
end $$;

comment on function public.discover_players_near(double precision, double precision, double precision, text, boolean, boolean, uuid[], int) is
  'Players who play within p_radius_m of a point, by the home courts of their leagues only (open leagues, or closed '
  'leagues the viewer is in too). Never starred courts, check-ins or live location. migration_discover_players_near.sql';

revoke all on function public.discover_players_near(double precision, double precision, double precision, text, boolean, boolean, uuid[], int) from public, anon;
grant execute on function public.discover_players_near(double precision, double precision, double precision, text, boolean, boolean, uuid[], int) to authenticated;
