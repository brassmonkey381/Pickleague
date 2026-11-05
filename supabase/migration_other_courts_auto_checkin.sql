-- Check me in at other courts (2026-11-05). Brian: auto check-in "to any
-- park when passed through the edge, with confirmation pushes sent", as a
-- setting for both apps. Pickleague's "Ask me when I'm at other courts" gains
-- a second switch under it, "Check me in without asking": off (the default),
-- an arrival at a court I haven't starred asks ("Check in nearby?") as
-- before; on, it checks in the way a starred court does (queue_court_arrival:
-- stay a minute, "✅ Checked in at X" with Stay 1 more hour / Check out,
-- leave within 5 minutes and it's taken back).
--
-- What changes:
--   * presence_settings.other_court_auto boolean, default false.
--   * get_court_arrival_settings() adds 'other_court_auto'.
--   * set_court_arrival_settings gains p_other_auto (last, default null:
--     null leaves it). The 4-argument version is dropped; 1.0.4 phones call
--     it by name without p_other_auto, which the new one still takes.
--   * _pl_court_arrival_off (from migration_court_oneoff_plans.sql, the
--     latest): a court I haven't starred answers null (check in) instead of
--     'not_starred' while other_court_auto is on and other_court_radius_m >
--     0 ("Ask me at other courts" on). "Check me in when I arrive" and
--     "Notice me at starred courts" stay about starred courts only. Starred
--     courts are unchanged. queue_court_arrival and process_court_arrivals
--     both read it, so a switch turned off while an arrival waits stops it.
--
-- Nothing new for points: a check-in pays no pickles
-- (migration_pickle_economy_guards.sql), and an arrival check-in has no fix,
-- so it counts for no session until a real one arrives. Friends get no push
-- for a check-in; one taken back is shown to nobody.
--
-- No new refusal codes. Function names unchanged, so the
-- migration_rls_hardening_2026q3.sql allowlist already covers them.
-- Re-runnable; no begin/commit.
--   supabase db query --linked -f supabase/migration_other_courts_auto_checkin.sql
-- Tested by supabase/tests/other_courts_auto_personas.sql
-- (build-other-courts-auto-test.mjs).

alter table public.presence_settings add column if not exists other_court_auto boolean not null default false;


-- ── Settings RPCs ──────────────────────────────────────────────────────────
-- From migration_court_arrival_settings.sql, plus other_court_auto.
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
           'other_court_auto',     coalesce(v_row.other_court_auto, false),
           'auto_checkin',         coalesce(v_row.auto_checkin, true),
           'auto_checkin_set_at',  v_row.auto_checkin_set_at,
           'departure_reminder',   coalesce(v_row.departure_reminder, true),
           'consent_seen',         v_row.consent_seen_at is not null);
end $$;
revoke all on function public.get_court_arrival_settings() from public, anon;
grant execute on function public.get_court_arrival_settings() to authenticated;

drop function if exists public.set_court_arrival_settings(int, int, boolean, boolean);

-- null leaves a field as it is. Returns the full settings.
create or replace function public.set_court_arrival_settings(
  p_radius_m       int default null,
  p_other_radius_m int default null,
  p_auto           boolean default null,
  p_departure      boolean default null,
  p_other_auto     boolean default null
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
    other_court_auto     = coalesce(p_other_auto, other_court_auto),
    auto_checkin         = coalesce(p_auto, auto_checkin),
    auto_checkin_set_at  = case when p_auto is not null then now() else auto_checkin_set_at end,
    departure_reminder   = coalesce(p_departure, departure_reminder),
    updated_at           = now()
  where user_id = v_me;
  return public.get_court_arrival_settings();
end $$;
revoke all on function public.set_court_arrival_settings(int, int, boolean, boolean, boolean) from public, anon;
grant execute on function public.set_court_arrival_settings(int, int, boolean, boolean, boolean) to authenticated;


-- ── The arrival switch ─────────────────────────────────────────────────────
-- From migration_court_oneoff_plans.sql. Changed: a court I haven't starred
-- checks in while "Ask me at other courts" and "Check me in without asking"
-- are both on. Same signature.
create or replace function public._pl_court_arrival_off(p_uid uuid, p_venue text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_auto       boolean;
  v_radius     int;
  v_routine    boolean;
  v_other_r    int;
  v_other_auto boolean;
  v_here       boolean;
begin
  select s.auto_checkin, s.court_radius_m, s.routine_auto_checkin, s.other_court_radius_m, s.other_court_auto
    into v_auto, v_radius, v_routine, v_other_r, v_other_auto
    from public.presence_settings s where s.user_id = p_uid;
  select f.auto_checkin into v_here
    from public.court_favorites f
   where f.user_id = p_uid
     and f.venue_id in (select v.id from public.venues v where v.id = p_venue or v.canonical_id = p_venue)
   order by f.auto_checkin desc
   limit 1;
  if v_here is null and coalesce(v_other_auto, false) and coalesce(v_other_r, 0) > 0 then
    return null;
  end if;
  if (not coalesce(v_auto, true) or coalesce(v_radius, 100) <= 0)
     and not (coalesce(v_routine, true) and public._pl_routine_stop_due(p_uid, p_venue, now())) then
    return 'off';
  end if;
  if v_here is null then return 'not_starred'; end if;
  if not v_here then return 'off_here'; end if;
  return null;
end $$;
revoke all on function public._pl_court_arrival_off(uuid, text) from public, anon, authenticated;
