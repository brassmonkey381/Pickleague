-- ============================================================
-- Court arrival, file 1 of 3: check-in automation settings, the per-court
-- switch, and the outline area fix (Doggle parity; the user's decisions of
-- 2026-10-19; docs/play-sessions-presence.md).
--
-- What changes:
--   * presence_settings gains the "Check-in automation" settings, per account
--     (Doggle keeps them per account too, so a second phone or a reinstall
--     keeps them):
--       court_radius_m        "Notice me at starred courts": 0 (Off) / 100 /
--                             250 / 1000 m, default 100. The circle around a
--                             starred court with no mapped outline.
--       other_court_radius_m  "Prompt me near other courts": the same
--                             choices, default 0 (Off).
--       departure_reminder    "Remind me to check out when I leave", default on.
--       auto_checkin_set_at   when the player last chose "Check me in when I
--                             arrive"; null = never chose.
--     Both radii are CHECKed in the table, not only in the setter (Doggle had
--     no CHECK on its other-places radius).
--   * presence_settings.auto_checkin ("read in Phase 2") now defaults to true,
--     and every row whose player never chose is set to true. No choice is
--     overwritten: nothing could set it before (set_presence_settings has no
--     such argument), and set_court_arrival_settings stamps
--     auto_checkin_set_at. Automatic check-in ships in 1.0.4 (build 14) with
--     honest "Always" location text; no App Store build has the old arrival
--     alerts, so nobody is moved from "never automatic" to automatic.
--   * court_favorites.auto_checkin (default true): off for one starred court
--     means arriving there asks first. Unstarring deletes the row, so a
--     re-star starts on again (as in Doggle). A venue dedupe re-run
--     (_pl_dedupe_venues) that moves a star to a new canonical row re-creates
--     it, so that court's switch is back on.
--   * venue_set_geom: clearing a court's outline also clears area_sqm (before,
--     the old area stayed), plus a one-time cleanup of areas left behind. A
--     stale area would size a starred court's circle from an outline that no
--     longer exists (list_starred_court_geofences). Doggle has the same bug.
--
-- New client RPCs (SECURITY DEFINER, search_path '', granted to
-- authenticated only, and in the migration_rls_hardening_2026q3.sql
-- allowlist, so a re-run of it takes nothing offline):
--   get_court_arrival_settings()    {court_radius_m, other_court_radius_m,
--                                   auto_checkin, auto_checkin_set_at,
--                                   departure_reminder, consent_seen};
--                                   defaults when there is no row
--   set_court_arrival_settings(p_radius_m, p_other_radius_m, p_auto, p_departure)
--                                   null leaves a field as it is; a radius
--                                   other than 0/100/250/1000 is
--                                   pl:request.bad; p_auto stamps
--                                   auto_checkin_set_at. Returns the settings.
--   list_starred_court_geofences()  my starred courts for the phone's
--                                   geofences, by name: radius_m is the
--                                   equal-area circle of a mapped outline,
--                                   else null (the phone uses court_radius_m)
--   set_starred_court_auto_checkin(p_venue, p_on)
--                                   the per-court switch; false when that
--                                   court isn't starred
-- get_court_arrival_settings is the only reader of auto_checkin. The 1.0.4
-- RPCs (get_my_presence_settings, which still reads it as false when there
-- is no row, set_presence_settings, set_court_favorite,
-- list_my_court_favorites) are not touched.
--
-- No new refusal codes: signed out is pl:auth.signed_out, a bad radius
-- pl:request.bad (mobile/src/lib/refusals.ts).
--
-- Apply order: after migration_checkin_tap_time.sql and
-- migration_admin_venue_boundary.sql; then migration_court_arrival_queue.sql
-- and migration_court_checkin_prompt.sql (files 2 and 3 read these
-- columns); then re-run migration_rls_hardening_2026q3.sql. Re-apply after
-- any re-run of migration_add_venue_geofences.sql (it puts the old
-- venue_set_geom back). A re-run of migration_validity_rules.sql,
-- migration_venue_checkins.sql or migration_presence_p1_hygiene.sql does not
-- touch anything here. Re-runnable; no begin/commit.
--   supabase db query --linked -f supabase/migration_court_arrival_settings.sql
-- Tested by supabase/tests/court_arrival_personas.sql (build-presence-test.mjs).
-- ============================================================


-- ── 1. Settings columns ────────────────────────────────────────────────────
alter table public.presence_settings add column if not exists court_radius_m       int not null default 100;
alter table public.presence_settings add column if not exists other_court_radius_m int not null default 0;
alter table public.presence_settings add column if not exists departure_reminder   boolean not null default true;
alter table public.presence_settings add column if not exists auto_checkin_set_at  timestamptz;

-- The four choices the Settings pills offer (Off / 100 m / 250 m / 1 km).
alter table public.presence_settings drop constraint if exists presence_settings_court_radius_m_check;
alter table public.presence_settings add constraint presence_settings_court_radius_m_check
  check (court_radius_m in (0, 100, 250, 1000));
alter table public.presence_settings drop constraint if exists presence_settings_other_court_radius_m_check;
alter table public.presence_settings add constraint presence_settings_other_court_radius_m_check
  check (other_court_radius_m in (0, 100, 250, 1000));

-- Automatic check-in is on unless the player turns it off. Only rows whose
-- player never chose are touched, so re-running this changes nothing.
alter table public.presence_settings alter column auto_checkin set default true;
update public.presence_settings
   set auto_checkin = true
 where auto_checkin_set_at is null
   and not auto_checkin;

-- The per-court switch. Stars are stored canonical (set_court_favorite).
alter table public.court_favorites add column if not exists auto_checkin boolean not null default true;


-- ── 2. A cleared outline clears its area ───────────────────────────────────
-- venue_set_geom: from its latest definition (migration_add_venue_geofences.sql,
-- the only file that defines it; check it against pg_get_functiondef before
-- applying). Changed: the no-outline branch also nulls area_sqm. Not SECURITY
-- DEFINER (a trigger function); its search_path and the venue_geom_biu
-- trigger are unchanged.
create or replace function public.venue_set_geom()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
begin
  if NEW.boundary is not null then
    begin
      NEW.boundary_geom := ST_MakeValid(ST_GeomFromGeoJSON(NEW.boundary::text));
      NEW.area_sqm := ST_Area(NEW.boundary_geom::geography);
    exception when others then
      NEW.boundary_geom := null;
      NEW.area_sqm := null;
    end;
  else
    -- No outline, so no area: the equal-area circle must not outlive it.
    NEW.boundary_geom := null;
    NEW.area_sqm := null;
  end if;
  return NEW;
end $function$;

-- One time: outlines cleared before this fix left their area behind. It
-- doesn't touch boundary, so venue_geom_biu doesn't fire.
update public.venues
   set area_sqm = null
 where boundary is null
   and area_sqm is not null;


-- ── 3. Settings RPCs ───────────────────────────────────────────────────────
-- My check-in automation settings. A missing row means the defaults (the
-- column defaults above). consent_seen: whether I've chosen who sees me at
-- the courts (the queue only checks in automatically after that).
create or replace function public.get_court_arrival_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me  uuid := auth.uid();
  v_row public.presence_settings;
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  select * into v_row from public.presence_settings s where s.user_id = v_me;
  return jsonb_build_object(
           'court_radius_m',       coalesce(v_row.court_radius_m, 100),
           'other_court_radius_m', coalesce(v_row.other_court_radius_m, 0),
           'auto_checkin',         coalesce(v_row.auto_checkin, true),
           'auto_checkin_set_at',  v_row.auto_checkin_set_at,
           'departure_reminder',   coalesce(v_row.departure_reminder, true),
           'consent_seen',         v_row.consent_seen_at is not null);
end $$;
revoke all on function public.get_court_arrival_settings() from public, anon;
grant execute on function public.get_court_arrival_settings() to authenticated;

-- null leaves a field as it is. Choosing "Check me in when I arrive" either
-- way stamps auto_checkin_set_at, so no later default or one-time update
-- overrides it. Returns the full settings.
create or replace function public.set_court_arrival_settings(
  p_radius_m       int default null,
  p_other_radius_m int default null,
  p_auto           boolean default null,
  p_departure      boolean default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  -- The app offers only these four; anything else is an app bug, refused
  -- before the CHECK would turn it into an unreadable error.
  if (p_radius_m is not null and p_radius_m not in (0, 100, 250, 1000))
     or (p_other_radius_m is not null and p_other_radius_m not in (0, 100, 250, 1000)) then
    raise exception using message = 'Couldn''t save that setting because the app sent an incomplete request. Update Pickleague, then try again.', hint = 'pl:request.bad';
  end if;

  insert into public.presence_settings (user_id) values (v_me) on conflict (user_id) do nothing;
  update public.presence_settings set
    court_radius_m       = coalesce(p_radius_m, court_radius_m),
    other_court_radius_m = coalesce(p_other_radius_m, other_court_radius_m),
    auto_checkin         = coalesce(p_auto, auto_checkin),
    auto_checkin_set_at  = case when p_auto is not null then now() else auto_checkin_set_at end,
    departure_reminder   = coalesce(p_departure, departure_reminder),
    updated_at           = now()
  where user_id = v_me;
  return public.get_court_arrival_settings();
end $$;
revoke all on function public.set_court_arrival_settings(int, int, boolean, boolean) from public, anon;
grant execute on function public.set_court_arrival_settings(int, int, boolean, boolean) to authenticated;


-- ── 4. Starred courts for the phone's geofences ────────────────────────────
-- [{venue_id, name, lat, lng, radius_m, auto_checkin}], by name. radius_m is
-- the radius of the circle with the outline's area (outlines are capped at
-- 200,000 m2, so at most about 252 m), null without an outline: the phone
-- then uses court_radius_m and clamps either to 50-800 m.
-- list_my_court_favorites stays as it was for 1.0.4.
create or replace function public.list_starred_court_geofences()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'venue_id',     v.id,
             'name',         v.name,
             'lat',          v.lat,
             'lng',          v.lng,
             'radius_m',     case when v.area_sqm > 0 then round(sqrt(v.area_sqm / pi()))::int end,
             'auto_checkin', f.auto_checkin)
             order by v.name, v.id)
      from public.court_favorites f
      join public.venues v on v.id = f.venue_id
     where f.user_id = v_me), '[]'::jsonb);
end $$;
revoke all on function public.list_starred_court_geofences() from public, anon;
grant execute on function public.list_starred_court_geofences() to authenticated;

-- The per-court switch: on, arriving at that starred court checks me in; off,
-- it asks first. Returns whether the court is starred (the switch saved).
-- Matches a star on the canonical row or one of its duplicates, as unstarring
-- does (set_court_favorite).
create or replace function public.set_starred_court_auto_checkin(p_venue text, p_on boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me    uuid := auth.uid();
  v_canon text := public._pl_canonical_venue(p_venue);
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  update public.court_favorites f
     set auto_checkin = coalesce(p_on, true)
   where f.user_id = v_me
     and f.venue_id in (select v.id from public.venues v where v.id = v_canon or v.canonical_id = v_canon);
  return found;
end $$;
revoke all on function public.set_starred_court_auto_checkin(text, boolean) from public, anon;
grant execute on function public.set_starred_court_auto_checkin(text, boolean) to authenticated;

notify pgrst, 'reload schema';
