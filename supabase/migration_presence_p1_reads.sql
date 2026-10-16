-- ============================================================
-- Presence Phase 1, file 3 of 5: who is at the courts, as each viewer may see
-- it. Apply order: see migration_presence_p1_schema.sql (needs files 1-2).
--
-- Every read here is SECURITY DEFINER and applies
-- _pl_can_see_presence(viewer, owner, 'checkins') per row:
--   named      the full row
--   anonymous  "Player": counted, never identified (a blocked pair sees each
--              other this way too, like any stranger)
--   none       a deleted owner: neither shown nor counted
-- Only location_confirmed check-ins are ever shown to anyone but their owner.
-- A venue id is resolved to its facility (venues.canonical_id) first, so a
-- duplicate row's id finds everyone at that facility.
--
-- An anonymous row carries only what a count needs, so nobody who saw the
-- named row (before a pause or a hide-from) can link it to the "Player" after:
-- a fresh random checkin_id on every call (unlinkable between calls, never the
-- real id), checked_in_at / expires_at rounded out to the hour, no session
-- fields, and anonymous rows are ordered by that random id, never by arrival.
-- What stays: a viewer watching at the very moment of a pause sees one named
-- row become one more "Player" with the count unchanged (paused and hidden
-- players are counted by design).
--
--   venue_players_here  same signature and columns as 1.0.4 (it was SECURITY
--                       INVOKER and showed every name, ignoring blocks).
--                       Anonymous rows: a random checkin_id, null user_id /
--                       names / ratings, hour-rounded times.
--   court_presence      the same rows for new apps, plus anonymous, is_friend,
--                       is_close_friend, via_session, session_kind (named
--                       rows only)
--   venue_crowd         "6 playing now · mostly 3.5-4.0 · 2 friends" for up to
--                       50 courts
--   friends_at_courts   Home "Friends at the courts" (now / your courts)
--   presence settings   get_my_presence_settings, set_presence_settings,
--                       hide_presence_from, list_presence_hidden
--   court favorites     set_court_favorite (max 5), list_my_court_favorites
-- ============================================================


-- ── 1. Rosters ─────────────────────────────────────────────────────────────
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
   order by (s.vis = 'named') desc, case when s.vis = 'named' then c.checked_in_at end, 1;
$$;
revoke execute on function public.venue_players_here(text) from public, anon;
grant execute on function public.venue_players_here(text) to authenticated;

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


-- ── 2. Crowd ───────────────────────────────────────────────────────────────
-- One facility's crowd as p_viewer sees it (internal). here_now counts every
-- confirmed open check-in, hidden, paused and blocked players included (a
-- blocked pair counts each other like any stranger). The band is the
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
  select (select count(*)::int from here),
         case when (select count(*) from rated) >= 3 then
           (round((select percentile_cont(0.25) within group (order by r) from rated)::numeric * 4) / 4)::numeric(4,2) end,
         case when (select count(*) from rated) >= 3 then
           (round((select percentile_cont(0.75) within group (order by r) from rated)::numeric * 4) / 4)::numeric(4,2) end,
         (select count(*)::int from seen s
           where s.user_id <> p_viewer and s.vis = 'named'
             and public.are_friends(p_viewer, s.user_id));
$$;
revoke all on function public._pl_venue_crowd(uuid, text) from public, anon, authenticated;

-- One row per known venue id asked for (as asked, so the app can map it back).
create or replace function public.venue_crowd(p_venue_ids text[])
returns table (venue_id text, here_now int, band_low numeric, band_high numeric, friends_here int)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if coalesce(cardinality(p_venue_ids), 0) > 50 then raise exception 'At most 50 courts at a time'; end if;
  return query
    select r.vid, x.here_now, x.band_low, x.band_high, x.friends_here
      from (select distinct u.vid, public._pl_canonical_venue(u.vid) as canon
              from unnest(p_venue_ids) as u(vid) where u.vid is not null) r
      cross join lateral public._pl_venue_crowd(auth.uid(), r.canon) x
     where r.canon is not null;
end $$;
revoke all on function public.venue_crowd(text[]) from public, anon;
grant execute on function public.venue_crowd(text[]) to authenticated;


-- ── 3. Home: friends at the courts ─────────────────────────────────────────
-- now:    friends and closed-league mates I may see by name, at courts right
--         now (checked in within the last p_hours, 1-24), grouped by
--         facility; others_here = everyone else counted there (not me).
--         The candidates are resolved first, then read by index. Cap 100.
-- courts: every favorite (max 5), then my leagues' home courts, then where I
--         checked in most in the last 60 days, until there are 3; each with
--         its crowd.
create or replace function public.friends_at_courts(p_hours int default 12)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me    uuid := auth.uid();
  v_since timestamptz := now() - make_interval(hours => greatest(1, least(coalesce(p_hours, 12), 24)));
  v_now   jsonb;
  v_courts jsonb;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;

  with cand as (
    select case when f.requester_id = v_me then f.addressee_id else f.requester_id end as uid
      from public.friendships f
     where f.status = 'accepted' and v_me in (f.requester_id, f.addressee_id)
    union
    select mb.user_id
      from public.league_members ma
      join public.leagues l on l.id = ma.league_id and not l.is_open
      join public.league_members mb on mb.league_id = ma.league_id and mb.user_id <> v_me
     where ma.user_id = v_me
       and ma.admitted_closed and mb.admitted_closed
       and (ma.expires_at is null or ma.expires_at > now())
       and (mb.expires_at is null or mb.expires_at > now())
  ),
  seen as (
    select c.id, c.user_id, c.checked_in_at, c.expires_at, c.source,
           coalesce(v.canonical_id, v.id) as canon,
           p.full_name, p.avatar_url, p.avatar_emoji, p.avatar_bg_color
      from cand
      join public.venue_checkins c on c.user_id = cand.uid and c.checked_out_at is null
      join public.venues v on v.id = c.venue_id
      join public.profiles p on p.id = c.user_id and p.deleted_at is null
     where c.expires_at > now()
       and c.checked_in_at > v_since
       and c.location_confirmed
       and public._pl_can_see_presence(v_me, c.user_id, 'checkins') = 'named'
     order by c.checked_in_at desc
     limit 100
  ),
  people as (
    select s.*,
           exists (select 1 from public.close_friends cf where cf.user_id = v_me and cf.friend_id = s.user_id) as is_close,
           ps.kind as session_kind,
           (s.source = 'session' or ps.id is not null) as via_session
      from seen s
      left join lateral (
        select x.id, x.kind
          from public.play_sessions x
         where x.user_id = s.user_id and x.ended_at is null
           and x.started_at > now() - interval '6 hours'
           and (x.id = s.id or x.venue_id in (select v.id from public.venues v
                                               where v.id = s.canon or v.canonical_id = s.canon))
         order by x.started_at desc
         limit 1
      ) ps on true
  ),
  grouped as (
    select pe.canon,
           min(pe.checked_in_at) as since,
           max(pe.expires_at) as until_at,
           count(*) as n,
           jsonb_agg(jsonb_build_object(
             'user_id', pe.user_id, 'full_name', pe.full_name, 'avatar_url', pe.avatar_url,
             'avatar_emoji', pe.avatar_emoji, 'avatar_bg_color', pe.avatar_bg_color,
             'is_close_friend', pe.is_close, 'via_session', pe.via_session,
             'session_kind', pe.session_kind,
             'checked_in_at', pe.checked_in_at, 'expires_at', pe.expires_at)
             order by pe.is_close desc, pe.checked_in_at) as people
      from people pe
     group by pe.canon
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'venue_id', g.canon, 'venue_name', v.name, 'lat', v.lat, 'lng', v.lng,
           'since', g.since, 'until', g.until_at, 'people', g.people,
           'others_here', greatest(0, cr.here_now - g.n
             - case when exists (select 1 from public.venue_checkins m
                                  where m.user_id = v_me and m.checked_out_at is null
                                    and m.expires_at > now() and m.location_confirmed
                                    and m.venue_id in (select x.id from public.venues x
                                                        where x.id = g.canon or x.canonical_id = g.canon))
                    then 1 else 0 end))
           order by g.n desc, g.since), '[]'::jsonb)
    into v_now
    from grouped g
    join public.venues v on v.id = g.canon
    cross join lateral public._pl_venue_crowd(v_me, g.canon) cr;

  with mine as (
    select coalesce(v.canonical_id, v.id) as canon, 'favorite' as reason, 1 as tier,
           extract(epoch from f.created_at) as ord
      from public.court_favorites f join public.venues v on v.id = f.venue_id
     where f.user_id = v_me
    union all
    select coalesce(v.canonical_id, v.id), 'home', 2, -extract(epoch from coalesce(lm.joined_at, now()))
      from public.league_members lm
      join public.leagues l on l.id = lm.league_id and l.home_venue_id is not null
      join public.venues v on v.id = l.home_venue_id
     where lm.user_id = v_me and (lm.expires_at is null or lm.expires_at > now())
    union all
    select coalesce(v.canonical_id, v.id), 'frequent', 3, -count(*)::double precision
      from public.venue_checkins c join public.venues v on v.id = c.venue_id
     where c.user_id = v_me and c.location_confirmed and c.checked_in_at > now() - interval '60 days'
     group by 1
  ),
  pick as (
    select distinct on (m.canon) m.canon, m.reason, m.tier, m.ord
      from mine m
     order by m.canon, m.tier, m.ord
  ),
  -- Every star shows (at most 5); home and frequent courts fill up to 3.
  ranked as (
    select p.*, row_number() over (order by p.tier, p.ord, p.canon) as rn from pick p
  ),
  top as (
    select * from ranked where tier = 1 or rn <= 3
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'venue_id', t.canon, 'venue_name', v.name, 'reason', t.reason,
           'here_now', cr.here_now, 'band_low', cr.band_low, 'band_high', cr.band_high,
           'friends_here', cr.friends_here)
           order by t.tier, t.ord, t.canon), '[]'::jsonb)
    into v_courts
    from top t
    join public.venues v on v.id = t.canon
    cross join lateral public._pl_venue_crowd(v_me, t.canon) cr;

  return jsonb_build_object('now', v_now, 'courts', v_courts);
end $$;
revoke all on function public.friends_at_courts(int) from public, anon;
grant execute on function public.friends_at_courts(int) to authenticated;


-- ── 4. Who sees me at the courts ───────────────────────────────────────────
-- Defaults when there is no row; an expired pause reads as null.
create or replace function public.get_my_presence_settings()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
           'checkins_level',  coalesce(s.checkins_level, 'leaguemates'),
           'plans_level',     coalesce(s.plans_level, 'friends'),
           'paused_until',    case when s.paused_until > now() then s.paused_until end,
           'consent_seen_at', s.consent_seen_at,
           'auto_checkin',    coalesce(s.auto_checkin, false))
    from (select auth.uid() as me) d
    left join public.presence_settings s on s.user_id = d.me
   where d.me is not null;
$$;
revoke all on function public.get_my_presence_settings() from public, anon;
grant execute on function public.get_my_presence_settings() to authenticated;

-- null leaves a field as it is. A pause runs until p_paused_until (at most 7
-- days ahead; a time already past clears it); p_clear_pause ends it now.
-- p_consent_seen stamps the first time only. Returns the full settings.
create or replace function public.set_presence_settings(
  p_checkins_level text default null,
  p_plans_level    text default null,
  p_paused_until   timestamptz default null,
  p_clear_pause    boolean default false,
  p_consent_seen   boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if p_checkins_level is not null and p_checkins_level not in ('everyone', 'leaguemates', 'friends', 'hidden') then
    raise exception 'Pick who can see you at the courts';
  end if;
  if p_plans_level is not null and p_plans_level not in ('leaguemates', 'friends', 'hidden') then
    raise exception 'Pick who can see your planned games';
  end if;

  insert into public.presence_settings (user_id) values (v_me) on conflict (user_id) do nothing;
  update public.presence_settings set
    checkins_level  = coalesce(p_checkins_level, checkins_level),
    plans_level     = coalesce(p_plans_level, plans_level),
    paused_until    = case
                        when coalesce(p_clear_pause, false) then null
                        when p_paused_until is null then paused_until
                        when p_paused_until > now() then least(p_paused_until, now() + interval '7 days')
                        else null
                      end,
    consent_seen_at = case when coalesce(p_consent_seen, false) then coalesce(consent_seen_at, now())
                           else consent_seen_at end,
    updated_at      = now()
  where user_id = v_me;
  return public.get_my_presence_settings();
end $$;
revoke all on function public.set_presence_settings(text, text, timestamptz, boolean, boolean) from public, anon;
grant execute on function public.set_presence_settings(text, text, timestamptz, boolean, boolean) to authenticated;

-- "Hide my presence from <person>": they see me as an anonymous Player.
-- Returns whether they are hidden from now on.
create or replace function public.hide_presence_from(p_user uuid, p_hidden boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if p_user is null or p_user = v_me then raise exception 'Pick someone else'; end if;
  if coalesce(p_hidden, true) then
    if not exists (select 1 from public.profiles p where p.id = p_user) then
      raise exception 'Player not found';
    end if;
    insert into public.presence_hidden_from (user_id, hidden_user_id) values (v_me, p_user)
    on conflict do nothing;
    return true;
  end if;
  delete from public.presence_hidden_from where user_id = v_me and hidden_user_id = p_user;
  return false;
end $$;
revoke all on function public.hide_presence_from(uuid, boolean) from public, anon;
grant execute on function public.hide_presence_from(uuid, boolean) to authenticated;

create or replace function public.list_presence_hidden()
returns table (user_id uuid, full_name text, avatar_url text, avatar_emoji text, avatar_bg_color text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.full_name, p.avatar_url, p.avatar_emoji, p.avatar_bg_color
    from public.presence_hidden_from h
    join public.profiles p on p.id = h.hidden_user_id and p.deleted_at is null
   where h.user_id = auth.uid()
   order by lower(p.full_name);
$$;
revoke all on function public.list_presence_hidden() from public, anon;
grant execute on function public.list_presence_hidden() to authenticated;


-- ── 5. My courts ───────────────────────────────────────────────────────────
-- Stored canonical; at most 5. Returns whether the court is a favorite now.
create or replace function public.set_court_favorite(p_venue text, p_on boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me    uuid := auth.uid();
  v_canon text := public._pl_canonical_venue(p_venue);
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if v_canon is null then raise exception 'Court not found'; end if;
  perform pg_advisory_xact_lock(hashtext('court_favorites:' || v_me::text));

  if not coalesce(p_on, true) then
    delete from public.court_favorites f
     where f.user_id = v_me
       and f.venue_id in (select v.id from public.venues v where v.id = v_canon or v.canonical_id = v_canon);
    return false;
  end if;

  if exists (select 1 from public.court_favorites where user_id = v_me and venue_id = v_canon) then
    return true;
  end if;
  if (select count(*) from public.court_favorites where user_id = v_me) >= 5 then
    raise exception 'You can star up to 5 courts. Remove one first.';
  end if;
  insert into public.court_favorites (user_id, venue_id) values (v_me, v_canon);
  return true;
end $$;
revoke all on function public.set_court_favorite(text, boolean) from public, anon;
grant execute on function public.set_court_favorite(text, boolean) to authenticated;

create or replace function public.list_my_court_favorites()
returns table (venue_id text, venue_name text, lat double precision, lng double precision)
language sql
stable
security definer
set search_path = ''
as $$
  select v.id, v.name, v.lat, v.lng
    from public.court_favorites f
    join public.venues v on v.id = f.venue_id
   where f.user_id = auth.uid()
   order by f.created_at, v.id;
$$;
revoke all on function public.list_my_court_favorites() from public, anon;
grant execute on function public.list_my_court_favorites() to authenticated;

notify pgrst, 'reload schema';
