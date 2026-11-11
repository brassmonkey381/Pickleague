-- suggested_courts (PKL-020 change 3, 2026-11-11): the "Your courts" step of the
-- first run, and any later "courts for you" list, ranks courts by more than
-- distance.
--
-- Brian: "suggested courts need a goood basic recommendation algorithm too
-- based on court check-ins, active leagues, etc, not purely distance based.
-- See Doggle for reference algo". Modeled on Doggle's suggested_favorite_parks
-- (0512-0517, parks-v5). Rules and changelog: docs/recommendations/courts.md;
-- every rule change bumps algo_version in the same migration.
--
-- suggested-courts-v1. Candidates: canonical, not rejected, pickleball venues (or with a
-- pickleball alias) within 15 km of the point
-- (people drive to courts; the 60 nearest), not already in my starred courts.
-- Real people only (no test accounts, no deleted profiles). Score:
--   + 12 per distinct player with a confirmed check-in there in 30 days (up to 5)
--   +  8 x ln(1 + confirmed check-ins there in 30 days)
--   + 10 per active open league whose home court it is (up to 3); active =
--        real play in 120 days (_pl_league_real_play) or created in 60 days
--   +  6 per weekly session listed there (court_sessions, current, up to 4)
--   +  6 x ln(1 + matches recorded there in 30 days, open leagues only)
--   +  8 per player who starred it (up to 5)
--   +  2 per court (up to 12), + 5 if lit, - 15 if private or customers only
--   -  6 per km
-- Only counts leave the database, never who. Closed leagues are not counted
-- (their home court is members-only, migration_closed_league_privacy.sql).
-- The top 3 come back recommended = true.
--
-- Point: p_lat/p_lng (the phone), else my home location; no point -> empty list.

create or replace function public.suggested_courts(
  p_lat double precision default null,
  p_lng double precision default null,
  p_limit integer default 6
)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_me uuid := auth.uid();
  v_lat double precision := p_lat;
  v_lng double precision := p_lng;
  v_lim int := greatest(1, least(coalesce(p_limit, 6), 10));
  v_radius double precision := 15000;
  v_rows jsonb := '[]'::jsonb;
begin
  if v_me is null then raise exception 'Not signed in'; end if;

  if v_lat is null or v_lng is null then
    select h.lat, h.lng into v_lat, v_lng
      from public.profile_home_locations h where h.profile_id = v_me;
  end if;

  if v_lat is not null and v_lng is not null then

    with mine as (
      select coalesce(v.canonical_id, v.id) as canon
        from public.court_favorites f
        join public.venues v on v.id = f.venue_id
       where f.user_id = v_me
    ),
    near as (
      select v.id, v.name, v.city, v.address, v.lat, v.lng, v.court_count, v.lit, v.indoor, v.access,
             public.haversine_meters(v_lat, v_lng, v.lat, v.lng) as d
        from public.venues v
       where v.canonical_id is null
         and v.confirmation_status <> 'rejected'
         -- Index-served prefilter, spelled as list_courts_nearby (venues_point_geog_idx).
         and extensions.st_dwithin(
               (extensions.st_setsrid(extensions.st_makepoint(v.lng, v.lat), 4326))::extensions.geography,
               (extensions.st_setsrid(extensions.st_makepoint(v_lng, v_lat), 4326))::extensions.geography,
               v_radius * 1.01 + 25)
         and (v.sport && array['pickleball']
              or exists (select 1 from public.venues a
                          where a.canonical_id = v.id
                            and a.confirmation_status <> 'rejected'
                            and a.sport && array['pickleball']))
         and public.haversine_meters(v_lat, v_lng, v.lat, v.lng) <= v_radius
         and not exists (select 1 from mine m where m.canon = v.id)
       order by d asc
       limit 60
    ),
    -- Every venue id that counts as each candidate (the candidate and its duplicates).
    ids as (
      select n.id as canon, n.id as vid from near n
      union
      select v.canonical_id, v.id from public.venues v where v.canonical_id in (select n.id from near n)
    ),
    real_people as (
      select p.id from public.profiles p
       where not coalesce(p.is_test_account, false) and p.deleted_at is null
    ),
    checks as (
      select i.canon,
             count(distinct c.user_id)::int as players,
             count(*)::int as checkins
        from ids i
        join public.venue_checkins c on c.venue_id = i.vid
        join real_people r on r.id = c.user_id
       where c.checked_in_at > now() - interval '30 days'
         and c.location_confirmed
       group by i.canon
    ),
    lg as (
      select i.canon, count(*)::int as leagues
        from ids i
        join public.leagues l on l.home_venue_id = i.vid
       where coalesce(l.is_active, true)
         and coalesce(l.is_open, true)
         and (l.created_at > now() - interval '60 days' or public._pl_league_real_play(l.id))
       group by i.canon
    ),
    ses as (
      select i.canon, count(*)::int as sessions
        from ids i
        join public.court_sessions s on s.venue_id = i.vid
       where s.hidden_at is null
         and (s.valid_to is null or s.valid_to >= current_date)
         and (s.valid_from is null or s.valid_from <= current_date + 30)
       group by i.canon
    ),
    played as (
      select i.canon, count(distinct m.id)::int as matches
        from ids i
        join public.court_locations cl on cl.venue_id = i.vid
        join public.matches m on m.location_name = cl.name
        join public.leagues l on l.id = m.league_id
       where coalesce(m.played_at, m.created_at) > now() - interval '30 days'
         and coalesce(l.is_open, true)
       group by i.canon
    ),
    favs as (
      select i.canon, count(distinct f.user_id)::int as favorites
        from ids i
        join public.court_favorites f on f.venue_id = i.vid
        join real_people r on r.id = f.user_id
       where f.user_id <> v_me
       group by i.canon
    ),
    scored as (
      select n.*,
             coalesce(c.players, 0) as players, coalesce(c.checkins, 0) as checkins,
             coalesce(g.leagues, 0) as leagues, coalesce(s.sessions, 0) as sessions,
             coalesce(p.matches, 0) as matches, coalesce(f.favorites, 0) as favorites,
               12 * least(coalesce(c.players, 0), 5)
             +  8 * ln(1 + coalesce(c.checkins, 0))
             + 10 * least(coalesce(g.leagues, 0), 3)
             +  6 * least(coalesce(s.sessions, 0), 4)
             +  6 * ln(1 + coalesce(p.matches, 0))
             +  8 * least(coalesce(f.favorites, 0), 5)
             +  2 * least(coalesce(n.court_count, 0), 6)
             + case when n.lit then 5 else 0 end
             - case when n.access in ('private', 'customers') then 15 else 0 end
             -  6 * (n.d / 1000.0) as score
        from near n
        left join checks c on c.canon = n.id
        left join lg g on g.canon = n.id
        left join ses s on s.canon = n.id
        left join played p on p.canon = n.id
        left join favs f on f.canon = n.id
    ),
    ranked as (
      select s.*, row_number() over (order by s.score desc, s.d) as rk from scored s
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'venue_id', r.id,
             'name', r.name,
             'city', r.city,
             'address', r.address,
             'lat', r.lat,
             'lng', r.lng,
             'distance_m', round(r.d::numeric),
             'court_count', r.court_count,
             'lit', r.lit,
             'indoor', r.indoor,
             'players_30d', r.players,
             'checkins_30d', r.checkins,
             'leagues', r.leagues,
             'sessions', r.sessions,
             'matches_30d', r.matches,
             'favorites', r.favorites,
             'score', round(r.score::numeric, 1),
             'recommended', r.rk <= 3
           ) order by r.rk), '[]'::jsonb)
      into v_rows
      from ranked r
     where r.rk <= v_lim;
  end if;

  -- The rules' version (docs/recommendations/courts.md): bump with every rule change.
  return jsonb_build_object('nearby', v_rows, 'algo_version', 'suggested-courts-v1',
                            'located', v_lat is not null and v_lng is not null);
end;
$function$;

revoke all on function public.suggested_courts(double precision, double precision, integer) from public, anon;
grant execute on function public.suggested_courts(double precision, double precision, integer) to authenticated;

notify pgrst, 'reload schema';
