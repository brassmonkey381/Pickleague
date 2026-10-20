-- ============================================================
-- Court arrival, file 3 of 3: the server's "Check in nearby?" push and the
-- scan the app runs once a minute while it is open (Doggle parity; the
-- user's decisions of 2026-10-19; docs/play-sessions-presence.md). Ports
-- Doggle's enqueue_nearby_checkin_prompt and find_nearby_dog_places
-- (doggle/db/migrations/0434, sections 5 and 7).
--
-- ── enqueue_court_checkin_prompt(p_venue, p_venue_name, p_reason) ─────────
-- Returns {enqueued, reason?, pushable}. The app calls it when an arrival
-- asks first instead of checking in (automatic check-in off there, a play
-- session running, a reason below) and when its scan puts me inside an
-- outline or near a court. Held back, nothing sent:
--   already_checked_in  a check-in of mine at that court is open, or began in
--                       the last 2 hours. A taken-back arrival (left within 5
--                       minutes, or Not here) never holds: it was never a
--                       visit, and Doggle deletes those rows outright, so a
--                       drive-by must not silence the prompt when I come back
--                       15 minutes later.
--   cooldown            this court prompted me in the last 30 minutes
--                       (_pl_throttle_ok, scope = my id, kind 'court_prompt').
-- Otherwise the push goes straight into push_outbox, with no notifications
-- row (a prompt is stale in minutes, so it has no place in the in-app feed):
-- kind 'info' (the generic notification type), category
-- notifyCheckinPrompts, push_data {kind 'court_prompt', venue_id,
-- venue_name} (send-push gives that kind the court_checkin buttons, and the
-- Check in button reads the court from it), link home/- (no court screen
-- yet), expires 30 minutes after it was made.
--
-- pushable says whether send-push will deliver it, read the way send-push
-- reads it (functions/send-push/index.ts resolvePrefs, and the kit's token
-- lookup on push_tokens.user_id): a push token AND prefs.pushEnabled exactly
-- true (push is opt-in) AND prefs.notifyCheckinPrompts not exactly false.
-- Not pushable: nothing is queued and the app posts the same words itself; the
-- 30 minutes still apply, so the local prompt is bounded too. Also right on a
-- send-push deployed before it knew notifyCheckinPrompts (it then gates 'info'
-- on the master switch alone): a player who turned the prompts off gets no
-- outbox row at all.
--
-- The words are the app's local fallback's, reasons included:
--   "Check in nearby?"
--   "You're near <court>." (or "You're near a court.") + the reason + " Tap to check in."
--   recently_left  " You left under 10 minutes ago, so we didn't check you in automatically."
--   not_starred    " It isn't one of your starred courts anymore, so we didn't check you in automatically."
--   no_consent     " Choose who sees you at the courts first, so we didn't check you in automatically."
--   anything else adds nothing (an older or newer app's reason never fails).
-- The court is the name the app shows, else the facility's own name.
--
-- ── court_prompt_scan(p_lat, p_lng, p_scan_m) ─────────────────────────────
-- Returns {inside: {venue_id, name} or null,
--          nearby: [{venue_id, name, distance_m, starred, has_outline}]}.
-- Pickleball courts only, never a rejected one, each as its facility
-- (venues.canonical_id), the way resolve_court and the check-in fix judge
-- see them: an outline or a pin on any of a facility's rows is that facility.
--   inside  the smallest outline holding the point, at any distance.
--   nearby  the 8 nearest facilities whose nearest pin is within p_scan_m,
--           clamped to 10..500 m (so the 1 km setting scans 500 m, as in
--           Doggle), nearest first, found through a bounding box on the new
--           venues_lat_lng_idx. has_outline: any row of the facility has
--           one; the app drops those (their outline replaces the circle) and
--           applies its own radius per kind (starred, other courts).
-- The coordinates are used for this one read: never stored, never logged,
-- never put in an error.
--
-- Refusals use existing codes only (mobile/src/lib/refusals.ts):
-- pl:auth.signed_out, pl:request.bad, pl:court.gone.
-- Both RPCs: SECURITY DEFINER, search_path = '', revoked from public and anon,
-- granted to authenticated. Both must be on the allowlist in
-- migration_rls_hardening_2026q3.sql, or a re-run of it takes them offline.
--
-- Apply order: after migration_court_arrival_settings.sql and
-- migration_court_arrival_queue.sql (file 2 adds venue_checkins.taken_back_at,
-- pl_throttle and _pl_throttle_ok, which this file reads); then re-run
-- migration_rls_hardening_2026q3.sql. This file replaces no existing
-- function, so a re-run of migration_validity_rules.sql,
-- migration_venue_checkins.sql or migration_presence_p1_hygiene.sql does not
-- touch anything here: no re-apply needed after them. Re-runnable; no
-- begin/commit.
--   supabase db query --linked -f supabase/migration_court_checkin_prompt.sql
-- ============================================================

-- Today venues has only sport, region, trigram, canonical and boundary
-- indexes; the scan's bounding box ranges over lat and checks lng in the index.
create index if not exists venues_lat_lng_idx on public.venues (lat, lng);


-- ── 1. "Check in nearby?" ──────────────────────────────────────────────────
create or replace function public.enqueue_court_checkin_prompt(
  p_venue      text,
  p_venue_name text default null,
  p_reason     text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me       uuid := auth.uid();
  v_venue    text;
  v_name     text;
  v_body     text;
  v_pushable boolean;
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  if nullif(btrim(p_venue), '') is null then
    raise exception using message = 'Couldn''t send a check-in prompt because the app sent an incomplete request. Update Pickleague, then try again.', hint = 'pl:request.bad';
  end if;
  v_venue := public._pl_canonical_venue(p_venue);
  if v_venue is null then
    raise exception using message = 'That court isn''t in Pickleague any more, so you can''t check in there. Find your court again.', hint = 'pl:court.gone';
  end if;
  -- The geofence Enter and the app-open scan often fire together: one at a
  -- time per player, so the 30-minute check below can't pass twice.
  perform pg_advisory_xact_lock(hashtext('court_prompt:' || v_me::text));

  -- The name the app shows (a starred court's, the scan's), else the
  -- facility's own. A blank or overlong one from the app falls back to that
  -- (it only ever reaches the caller's own phone, but stays a sane length).
  select nullif(btrim(v.name), '') into v_name from public.venues v where v.id = v_venue;
  v_name := coalesce(case when length(btrim(p_venue_name)) between 1 and 100 then btrim(p_venue_name) end, v_name);

  -- What send-push will do with it (resolvePrefs + its token lookup).
  v_pushable := exists (select 1 from public.push_tokens t where t.user_id = v_me)
    and coalesce((select (p.prefs -> 'pushEnabled') = 'true'::jsonb
                         and (p.prefs -> 'notifyCheckinPrompts') is distinct from 'false'::jsonb
                    from public.user_preferences p
                   where p.user_id = v_me), false);

  -- Already checked in here: open now, or begun in the last 2 hours. Taken-back
  -- arrivals don't count (see the header).
  if exists (
    select 1
      from public.venue_checkins c
     where c.user_id = v_me
       and c.venue_id in (select v.id from public.venues v where v.id = v_venue or v.canonical_id = v_venue)
       and c.taken_back_at is null
       and ((c.checked_out_at is null and c.expires_at > now())
            or c.checked_in_at > now() - interval '2 hours')
  ) then
    return jsonb_build_object('enqueued', false, 'reason', 'already_checked_in', 'pushable', v_pushable);
  end if;

  -- Records the prompt when it passes, pushable or not: the app's local
  -- prompt is held to the same 30 minutes.
  if not public._pl_throttle_ok(v_me::text, 'court_prompt', v_venue, interval '30 minutes') then
    return jsonb_build_object('enqueued', false, 'reason', 'cooldown', 'pushable', v_pushable);
  end if;

  -- Same words as the app's local fallback prompt.
  v_body := case when v_name is null then 'You''re near a court.' else format('You''re near %s.', v_name) end
    || case p_reason
         when 'recently_left' then ' You left under 10 minutes ago, so we didn''t check you in automatically.'
         when 'not_starred'   then ' It isn''t one of your starred courts anymore, so we didn''t check you in automatically.'
         when 'no_consent'    then ' Choose who sees you at the courts first, so we didn''t check you in automatically.'
         else '' end
    || ' Tap to check in.';

  if v_pushable then
    -- Wrapped: if the push can't be queued, the answer says not pushable and
    -- the app shows its own prompt instead of nothing.
    begin
      insert into public.push_outbox
        (recipient_id, kind, category, title, body, deep_link, expires_at, push_data)
      values (
        v_me, 'info', 'notifyCheckinPrompts', 'Check in nearby?', v_body, 'home/-',
        now() + interval '30 minutes',
        jsonb_strip_nulls(jsonb_build_object('kind', 'court_prompt', 'venue_id', v_venue, 'venue_name', v_name))
      );
    exception when others then
      raise warning 'court prompt push enqueue failed: %', sqlerrm;
      v_pushable := false;
    end;
  end if;

  return jsonb_build_object('enqueued', true, 'pushable', v_pushable);
end $$;
revoke all on function public.enqueue_court_checkin_prompt(text, text, text) from public, anon;
grant execute on function public.enqueue_court_checkin_prompt(text, text, text) to authenticated;


-- ── 2. The app-open scan ───────────────────────────────────────────────────
create or replace function public.court_prompt_scan(
  p_lat    double precision,
  p_lng    double precision,
  p_scan_m integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me      uuid := auth.uid();
  v_radius  double precision := greatest(10, least(coalesce(p_scan_m, 100), 500));
  v_dlat    double precision;
  v_dlng    double precision;
  v_pt      extensions.geometry;
  v_inside  text;
  v_starred text[];
  v_nearby  jsonb;
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  -- abs() of NaN or an infinity is above every bound, so those land here too.
  -- No coordinates in the message: they are never logged.
  if p_lat is null or p_lng is null or abs(p_lat) > 90 or abs(p_lng) > 180 then
    raise exception using message = 'Couldn''t look for courts near you because the app sent an incomplete request. Update Pickleague, then try again.', hint = 'pl:request.bad';
  end if;
  v_pt := extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326);

  -- 111,320 m per degree of latitude; longitude shrinks with cos(lat). Padded
  -- 10% so the box always holds the circle.
  v_dlat := (v_radius * 1.1) / 111320.0;
  v_dlng := (v_radius * 1.1) / (111320.0 * greatest(cos(radians(p_lat)), 0.01));

  -- Inside: the smallest outline holding the point (resolve_court's rule).
  select coalesce(v.canonical_id, v.id) into v_inside
    from public.venues v
   where v.boundary_geom is not null
     and v.sport @> array['pickleball']
     and v.confirmation_status <> 'rejected'
     and extensions.st_contains(v.boundary_geom, v_pt)
   order by v.area_sqm asc nulls last, v.id
   limit 1;

  -- My stars, as facilities. set_court_favorite stores canonical ids; mapping
  -- them again keeps a star that a later dedupe turned into a duplicate row.
  select array_agg(distinct coalesce(v.canonical_id, v.id)) into v_starred
    from public.court_favorites f
    join public.venues v on v.id = f.venue_id
   where f.user_id = v_me;

  -- Nearby: each facility once, at its nearest pin in range.
  select coalesce(jsonb_agg(jsonb_build_object(
           'venue_id', n.canon,
           'name', cv.name,
           'distance_m', round(n.d::numeric, 1),
           'starred', coalesce(n.canon = any(v_starred), false),
           'has_outline', exists (select 1 from public.venues o
                                   where (o.id = n.canon or o.canonical_id = n.canon)
                                     and o.boundary_geom is not null))
         order by n.d, n.canon), '[]'::jsonb)
    into v_nearby
    from (
      select coalesce(v.canonical_id, v.id) as canon,
             min(public.haversine_meters(p_lat, p_lng, v.lat, v.lng)) as d
        from public.venues v
       where v.lat between p_lat - v_dlat and p_lat + v_dlat
         and v.lng between p_lng - v_dlng and p_lng + v_dlng
         and v.sport @> array['pickleball']
         and v.confirmation_status <> 'rejected'
       group by 1
      having min(public.haversine_meters(p_lat, p_lng, v.lat, v.lng)) <= v_radius
       order by 2, 1
       limit 8
    ) n
    join public.venues cv on cv.id = n.canon;

  return jsonb_build_object(
    'inside', (select jsonb_build_object('venue_id', v.id, 'name', v.name)
                 from public.venues v where v.id = v_inside),
    'nearby', v_nearby);
end $$;
revoke all on function public.court_prompt_scan(double precision, double precision, integer) from public, anon;
grant execute on function public.court_prompt_scan(double precision, double precision, integer) to authenticated;

notify pgrst, 'reload schema';
