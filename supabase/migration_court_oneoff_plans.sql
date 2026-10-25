-- ============================================================
-- One-off planned check-ins, and "Check in and tell friends" (Doggle parity,
-- Phase 2 of the court card's one "Check in ▾"; the user, 2026-10-24: "A
-- simple 'Check In' button covers all the bases, with options to plan a
-- check in, make it a routine, etc. Please match with parity").
--
-- ── A. One-off plans (Doggle "Plan a check-in for later") ──────────────────
-- Doggle: schedule_dog_place_checkin (0034-0038), reschedule_dog_place_
-- checkin_plan (0114, 0429), cancel_dog_place_checkin_plan (0034), all in
-- dog_place_checkin_plans with routine_id null beside the routine stops.
-- Pickleague does the same in court_plans: a new column `kind` says which a
-- row is ('routine' = an occurrence the materializer made, the default and
-- every row before this file; 'once' = planned by hand, routine_id and
-- routine_date null). A kept routine occurrence whose routine was later
-- deleted keeps kind 'routine' (its routine_id goes null), so a one-off plan
-- is never confused with one.
--
--   plan_court_checkin(p_venue, p_at, p_length_min default 120)
--       a plan of mine at any court (the facility's canonical id), at p_at
--       to the minute: from 15 minutes ago (Doggle) to 60 days ahead
--       (Doggle), 30 min to 4 h long (a routine's rule; the app sends the
--       default, Doggle has no length). Its windows are the whole length,
--       mode not said (as a routine with none). At most 20 still to come
--       (Pickleague's cap; Doggle has none). Refused within 30 minutes of
--       another planned check-in of mine at that court, a routine stop
--       included (Doggle refuses the same time; 30 minutes is the window a
--       check-in keeps a plan in, so two would compete for one check-in),
--       and within 30 minutes of a routine stop not made yet (more than a
--       day ahead: _pl_routine_time_near), which the plan would otherwise
--       quietly take that day (the materializer skips a day with a plan
--       near), losing the stop's arrival override and its Skip.
--   move_court_plan(p_plan_id, p_at)    my planned one-off, still in play
--       (its time no more than 30 minutes ago): a new time from a minute
--       ago (Doggle 0429) to 60 days ahead, end and windows moving with it,
--       its unsent reminder dropped (it re-arms for the new time). The same
--       30-minute refusals as plan_court_checkin.
--   cancel_court_plan(p_plan_id)        my planned one-off (any time, as
--       Doggle): status 'cancelled', its unsent reminder dropped.
--   list_my_court_plans()               my one-off plans still in play
--       (planned or kept, time no more than 30 minutes ago), with the court.
--   Each write returns list_my_court_plans(). Another player's plan, a
--   routine occurrence, a cancelled or finished one: pl:visit.gone (the
--   same words whoever asks, so nobody learns of someone else's plan).
--
-- Starred courts: NOT required. Doggle plans at any place (no favorite
-- check in schedule_dog_place_checkin). Pickleague's routine rule (user
-- decision 1, routines only at starred courts) is about a standing weekly
-- pattern that geofences and auto check-ins hang off; a one-off plan needs
-- none of that: a check-in by hand keeps it anywhere, and at a starred court
-- an arrival keeps it as for a routine stop.
--
-- Kept: a check-in at that court within 30 minutes either side of its time
-- keeps it, exactly as a routine stop (_pl_routine_plan_at has no routine
-- filter: trg_venue_checkins_plan_link / _plan_kept and
-- process_court_arrivals already take any planned row of mine). Doggle's
-- one-off window ends 15 minutes after (its routine stops' 30): Pickleague
-- keeps its one window for both. An unkept one-off stays 'planned' past its
-- window (every read and the keep test look at the time); Doggle marks it
-- 'missed', which nothing in Pickleague shows.
--
-- Reminder: the same path as a routine stop's (process_court_routine_
-- reminders, pg_cron */5, 10 minutes before to 15 after, once per time, not
-- when already checked in there or playing), push_data.kind 'plan_reminder'
-- (send-push gives an unknown kind no buttons, so the routine reminder's
-- Skip today never meets a one-off plan; a tap opens the court's page in
-- this build, lib/pushLinks linkOf, as Doggle's opens the place, and Home in
-- older ones). Category notifyAutoCheckins, as a routine stop's (Settings
-- says "before a check-in you planned" under Auto check-ins). Doggle sends
-- its own "Visit starting soon" 30 minutes ahead; the task said one path.
--
-- Who sees a one-off plan: only its owner, as a routine stop (court_plans
-- stays owner-only; no read of anyone else's occurrences exists). Friends
-- see a player's ROUTINES on their profile (list_profile_court_routines,
-- under plans_level); one-off plans are not there in Doggle either (its
-- PlannedCheckinsSection lists routines only). Doggle also shows friends'
-- planned visits on its feed and place day view and pushes "planned_visit"
-- to friends; Pickleague shows no plan of anyone else anywhere, routine stops
-- included, so that stays out (it needs friends_at_courts to return plans,
-- both kinds, under plans_level: a later step).
--
-- The automatic arrival override stays a ROUTINE thing: _pl_court_arrival_off
-- let an arrival in through "Check me in when I arrive" off whenever a
-- planned row of mine was due (_pl_routine_plan_at); now only a routine stop
-- does (Doggle: tryRoutineArrivalCheckin reads routine stops only, and the
-- setting is "Check me in at my routine courts").
--
-- ── B. "Check in and tell friends" (Doggle 0441, 0451) ─────────────────────
-- send_on_my_way gains p_here boolean default false, last, so every
-- existing caller (named or positional, 1 to 3 arguments) reaches the new
-- function and behaves exactly as before. The three-argument signature is
-- dropped first: beside a four-argument one with a default, a call by name
-- without p_here would be ambiguous to PostgREST. Grants re-stated.
--   p_here true:
--   * only while I'm checked in at that court (open, location-confirmed,
--     not taken back): else reason 'not_here', nothing sent, no window spent;
--   * no ETA (p_eta_minutes is ignored, never refused);
--   * its own windows, so an "on my way" never blocks the "I'm here" that
--     follows (Doggle 0441): one send per court per 30 minutes
--     (pl_throttle kind 'on_my_way_here', key the court) and one push per
--     friend per court per 30 minutes ('on_my_way_here_to', key
--     '<court>|<friend>'; Doggle's 'here:<site>|<friend>'), and at most 3
--     OTHER courts per 30 minutes (Doggle 0451's cap: check-ins one after
--     another would otherwise push one friend once per court): reason
--     'limit' with retry_at, nothing sent, no window spent;
--   * only to a friend who may see my check-ins by name right now
--     (_pl_can_see_presence 'checkins' = 'named'): never one I hid my
--     presence from, nobody while I'm paused or my check-ins are hidden.
--     "I'm here" is presence. Left out, not counted (Pickleague's rule on top
--     of Doggle's);
--   * the push: "<Name> is at <Court>" / "Checked in just now. Tap to see
--     the court." (no emoji: Pickleague's push copy), the same category
--     (notifyFriendsOnTheWay, the friend's "Friends on the way" switch, as
--     Doggle keeps its on_my_way kind) and push_data kind 'on_my_way' with
--     here: true, so every build's tap opens the court; it expires in 30
--     minutes.
--   The answer gains here: true (only then), eta_minutes null, and the
--   reasons 'not_here' and 'limit'.
--
-- ── Replaced (each copied from the LATEST file that defines it; live bodies
-- checked equal to those files, read-only, 2026-10-24) ────────────────────
--   send_on_my_way              (migration_on_my_way.sql) 3 args -> 4 (p_here)
--   _pl_court_arrival_off       (migration_court_routines.sql) routine stops only
--   process_court_routine_reminders (migration_court_routines.sql) + one-off plans
--   unskip_court_routine_occurrence (migration_court_routines.sql) refused next
--                               to another plan of mine there (pl:plan.taken)
--   move_court_routine_occurrence   (migration_court_routines.sql) the same
-- New client RPCs (granted to authenticated, in the hardening allowlist):
--   plan_court_checkin, move_court_plan, cancel_court_plan, list_my_court_plans
-- New internal helpers (execute revoked from public, anon, authenticated):
--   _pl_plan_near, _pl_routine_stop_due, _pl_routine_time_near
-- supabase/tests/check-replaced-functions.mjs has the five.
--
-- APPLY ORDER: after migration_on_my_way.sql, migration_court_routines.sql,
-- migration_court_routines_planned_end.sql and migration_checkin_starts_
-- session.sql (all live). RE-APPLY after any re-run of
-- migration_court_routines.sql (it puts the old _pl_court_arrival_off,
-- process_court_routine_reminders, unskip_court_routine_occurrence and
-- move_court_routine_occurrence back) or of migration_on_my_way.sql (its
-- first block drops every other send_on_my_way, this one included, and makes
-- the 3-argument one again). The test builders do. Re-runnable; no
-- begin/commit.
-- Once migration_plan_sharing.sql is live, RE-APPLY IT after any re-run of
-- THIS file: this file makes the 3-argument plan_court_checkin again beside
-- that file's 4-argument one (p_share), so a call by name without p_share is
-- ambiguous to PostgREST and fails, and puts back a list_my_court_plans
-- without the share.
--   supabase db query --linked -f supabase/migration_court_oneoff_plans.sql
-- Test first: node supabase/tests/build-court-oneoff-plans-test.mjs
-- ============================================================


-- ── 1. court_plans: one-off rows ───────────────────────────────────────────
alter table public.court_plans add column if not exists kind text not null default 'routine';
do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conname = 'court_plans_kind_chk' and conrelid = 'public.court_plans'::regclass) then
    alter table public.court_plans add constraint court_plans_kind_chk
      check (kind in ('routine', 'once') and (kind = 'routine' or (routine_id is null and routine_date is null)));
  end if;
end $$;
create index if not exists court_plans_once_user_idx
  on public.court_plans (user_id, planned_at) where kind = 'once' and status = 'planned';
comment on column public.court_plans.kind is
  '''routine'': an occurrence materialize_court_routines made (routine_id, routine_date). ''once'': planned by '
  'hand (plan_court_checkin; Doggle''s "Plan a check-in for later"), routine_id and routine_date null.';
comment on table public.court_plans is
  'Planned check-ins (Doggle dog_place_checkin_plans): routine occurrences (kind routine) and one-off plans '
  '(kind once). windows are absolute ({starts_at, ends_at, mode, hint, group}). Owner-only; a plan says where '
  'someone will be. rewarded_at is reserved for the kept-plan pickles.';


-- ── 2. Internal helpers ────────────────────────────────────────────────────

-- My planned check-in (either kind) at this court within 30 minutes of p_at,
-- the nearest, leaving p_except out (the plan being moved). All nulls when none.
create or replace function public._pl_plan_near(p_uid uuid, p_venue text, p_at timestamptz, p_except uuid)
returns public.court_plans
language sql
stable
security definer
set search_path = ''
as $$
  select pl.*
    from public.court_plans pl
   where pl.user_id = p_uid and pl.status = 'planned'
     and (p_except is null or pl.id <> p_except)
     and pl.venue_id in (select v.id from public.venues v
                          where v.id = coalesce(public._pl_canonical_venue(p_venue), p_venue)
                             or v.canonical_id = coalesce(public._pl_canonical_venue(p_venue), p_venue))
     and pl.planned_at between p_at - interval '30 minutes' and p_at + interval '30 minutes'
   order by abs(extract(epoch from (pl.planned_at - p_at))), pl.id
   limit 1;
$$;
revoke all on function public._pl_plan_near(uuid, text, timestamptz, uuid) from public, anon, authenticated;

-- A ROUTINE stop of mine at this court whose window (30 minutes either side,
-- _pl_routine_plan_at's) holds p_at. One-off plans don't count.
create or replace function public._pl_routine_stop_due(p_uid uuid, p_venue text, p_at timestamptz)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.court_plans pl
     where pl.user_id = p_uid and pl.status = 'planned'
       and pl.kind = 'routine' and pl.routine_id is not null
       and pl.venue_id in (select v.id from public.venues v
                            where v.id = coalesce(public._pl_canonical_venue(p_venue), p_venue)
                               or v.canonical_id = coalesce(public._pl_canonical_venue(p_venue), p_venue))
       and p_at between pl.planned_at - interval '30 minutes' and pl.planned_at + interval '30 minutes');
$$;
revoke all on function public._pl_routine_stop_due(uuid, text, timestamptz) from public, anon, authenticated;

-- A routine stop of mine at this court that WILL be made within 30 minutes of
-- p_at but isn't yet (the materializer makes only yesterday to tomorrow): an
-- active routine at a court I still star, on that local day, its window not
-- over, no occurrence row for that day yet (a made one, skipped, kept or
-- moved, is _pl_plan_near's to judge). The nearest, with its zone; no row
-- when none. Without it a one-off plan days ahead would quietly take that
-- day from the routine: the materializer skips a day with a plan within 30
-- minutes, so no routine stop, no arrival override, no Skip on the reminder.
create or replace function public._pl_routine_time_near(p_uid uuid, p_venue text, p_at timestamptz)
returns table (routine_id uuid, stop_at timestamptz, tz text)
language sql
stable
security definer
set search_path = ''
as $$
  select cr.id, t.stop_at, cr.tz
    from public.court_routines cr
   cross join lateral (
     select ((p_at at time zone cr.tz)::date + k) as day from generate_series(-1, 1) k) d
   cross join lateral (select (d.day + cr.local_time) at time zone cr.tz as stop_at) t
   where cr.user_id = p_uid and cr.active
     and cr.venue_id in (select v.id from public.venues v
                          where v.id = coalesce(public._pl_canonical_venue(p_venue), p_venue)
                             or v.canonical_id = coalesce(public._pl_canonical_venue(p_venue), p_venue))
     and public._pl_is_starred(cr.user_id, cr.venue_id)
     and (cr.days & (1 << (extract(isodow from d.day)::int - 1))) <> 0
     and t.stop_at between p_at - interval '30 minutes' and p_at + interval '30 minutes'
     and t.stop_at > now() - interval '30 minutes'
     and not exists (select 1 from public.court_plans x where x.routine_id = cr.id and x.routine_date = d.day)
   order by abs(extract(epoch from (t.stop_at - p_at))), cr.id
   limit 1;
$$;
revoke all on function public._pl_routine_time_near(uuid, text, timestamptz) from public, anon, authenticated;


-- ── 3. Client RPCs ─────────────────────────────────────────────────────────

-- My one-off plans still in play: planned or kept, their time no more than
-- 30 minutes ago (a kept one says so; the app shows the planned ones).
create or replace function public.list_my_court_plans()
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
             'plan_id',        pl.id,
             'venue_id',       pl.venue_id,
             'venue_name',     v.name,
             'lat',            v.lat,
             'lng',            v.lng,
             'planned_at',     pl.planned_at,
             'planned_end_at', pl.planned_end_at,
             'status',         pl.status,
             'starred',        public._pl_is_starred(v_me, pl.venue_id))
             order by pl.planned_at, pl.id)
      from public.court_plans pl
      join public.venues v on v.id = pl.venue_id
     where pl.user_id = v_me and pl.kind = 'once'
       and pl.status in ('planned', 'completed')
       and pl.planned_at > now() - interval '30 minutes'), '[]'::jsonb);
end $$;
revoke all on function public.list_my_court_plans() from public, anon;
grant execute on function public.list_my_court_plans() to authenticated;

-- Doggle schedule_dog_place_checkin: plan a check-in at a court for later.
create or replace function public.plan_court_checkin(
  p_venue      text,
  p_at         timestamptz,
  p_length_min integer default 120
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me     uuid := auth.uid();
  v_at     timestamptz := date_trunc('minute', p_at);
  v_len    int := coalesce(p_length_min, 120);
  v_venue  text;
  v_name   text;
  v_status text;
  v_near   public.court_plans;
  v_rt     record;
  v_tz     text;
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  if p_venue is null or btrim(p_venue) = '' then
    raise exception using message = 'Couldn''t plan your check-in because the app sent an incomplete request. Update Pickleague, then try again.', hint = 'pl:request.bad';
  end if;
  v_venue := public._pl_canonical_venue(p_venue);
  select nullif(btrim(v.name), ''), v.confirmation_status into v_name, v_status
    from public.venues v where v.id = v_venue;
  if v_venue is null or not found or v_status = 'rejected' then
    raise exception using message = 'That court isn''t in Pickleague any more, so you can''t plan a check-in there. Find your court again.', hint = 'pl:court.gone';
  end if;
  if v_at is null or v_at < now() - interval '15 minutes' then
    raise exception using message = 'Pick a time later than now for your check-in.', hint = 'pl:visit.bad_time';
  end if;
  if v_at > now() + interval '60 days' then
    raise exception using message = 'You can plan a check-in up to 60 days ahead. Pick an earlier day.', hint = 'pl:visit.too_far';
  end if;
  if v_len < 30 or v_len > 240 or v_len % 15 <> 0 then
    raise exception using message = 'Pick how long you play: 30 minutes to 4 hours.', hint = 'pl:visit.bad_length';
  end if;

  -- One write at a time per player, so two quick taps can't both pass the
  -- checks below.
  perform pg_advisory_xact_lock(hashtext('court_plans:' || v_me::text));
  if (select count(*) from public.court_plans pl
       where pl.user_id = v_me and pl.kind = 'once' and pl.status = 'planned'
         and pl.planned_at > now() - interval '30 minutes') >= 20 then
    raise exception using message = 'You have 20 planned check-ins coming up. Cancel one to plan another.', hint = 'pl:visit.limit';
  end if;
  v_near := public._pl_plan_near(v_me, v_venue, v_at, null);
  if v_near.id is not null then
    v_tz := coalesce((select cr.tz from public.court_routines cr where cr.id = v_near.routine_id), public._pickleague_tz_for(v_me));
    raise exception using
      message = case when v_near.kind = 'routine'
                     then format('Your routine already has you at %s at %s. Change that stop''s time instead.',
                                 coalesce(v_name, 'this court'), public._pl_clock(v_near.planned_at, v_tz))
                     else format('You already plan to check in at %s at %s. Change that time instead.',
                                 coalesce(v_name, 'this court'), public._pl_clock(v_near.planned_at, v_tz)) end,
      hint = 'pl:visit.taken',
      detail = jsonb_build_object('plan_id', v_near.id, 'planned_at', v_near.planned_at,
                                  'routine', v_near.kind = 'routine')::text;
  end if;
  -- A routine stop not made yet (more than a day ahead) holds its time too.
  select * into v_rt from public._pl_routine_time_near(v_me, v_venue, v_at);
  if v_rt.routine_id is not null then
    raise exception using
      message = format('Your routine already has you at %s at %s that day. Pick another time.',
                       coalesce(v_name, 'this court'), public._pl_clock(v_rt.stop_at, v_rt.tz)),
      hint = 'pl:visit.taken',
      detail = jsonb_build_object('plan_id', null, 'planned_at', v_rt.stop_at, 'routine', true)::text;
  end if;

  insert into public.court_plans (user_id, venue_id, planned_at, planned_end_at, windows, status, kind)
  values (v_me, v_venue, v_at, v_at + make_interval(mins => v_len),
          public._pl_windows_at(public._pl_clean_windows(v_me, null, v_len), v_at), 'planned', 'once');
  return public.list_my_court_plans();
end $$;
revoke all on function public.plan_court_checkin(text, timestamptz, integer) from public, anon;
grant execute on function public.plan_court_checkin(text, timestamptz, integer) to authenticated;

-- Doggle reschedule_dog_place_checkin_plan: my one-off plan to a new time.
create or replace function public.move_court_plan(p_plan_id uuid, p_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me   uuid := auth.uid();
  v_at   timestamptz := date_trunc('minute', p_at);
  v_pl   public.court_plans;
  v_near public.court_plans;
  v_rt   record;
  v_by   interval;
  v_name text;
  v_tz   text;
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  perform pg_advisory_xact_lock(hashtext('court_plans:' || v_me::text));
  select * into v_pl from public.court_plans pl
   where pl.id = p_plan_id and pl.user_id = v_me and pl.kind = 'once'
   for update;
  if v_pl.id is null or v_pl.status <> 'planned' or v_pl.planned_at <= now() - interval '30 minutes' then
    raise exception using message = 'That planned check-in is over or was cancelled, so it can''t be changed. Pull to refresh.', hint = 'pl:visit.gone';
  end if;
  if v_at is null or v_at < now() - interval '1 minute' then
    raise exception using message = 'Pick a time later than now for your check-in.', hint = 'pl:visit.bad_time';
  end if;
  if v_at > now() + interval '60 days' then
    raise exception using message = 'You can plan a check-in up to 60 days ahead. Pick an earlier day.', hint = 'pl:visit.too_far';
  end if;
  v_near := public._pl_plan_near(v_me, v_pl.venue_id, v_at, v_pl.id);
  if v_near.id is not null then
    v_name := (select nullif(btrim(v.name), '') from public.venues v where v.id = v_pl.venue_id);
    v_tz := coalesce((select cr.tz from public.court_routines cr where cr.id = v_near.routine_id), public._pickleague_tz_for(v_me));
    raise exception using
      message = case when v_near.kind = 'routine'
                     then format('Your routine already has you at %s at %s. Pick another time.',
                                 coalesce(v_name, 'this court'), public._pl_clock(v_near.planned_at, v_tz))
                     else format('You already plan to check in at %s at %s. Pick another time.',
                                 coalesce(v_name, 'this court'), public._pl_clock(v_near.planned_at, v_tz)) end,
      hint = 'pl:visit.taken',
      detail = jsonb_build_object('plan_id', v_near.id, 'planned_at', v_near.planned_at,
                                  'routine', v_near.kind = 'routine')::text;
  end if;
  select * into v_rt from public._pl_routine_time_near(v_me, v_pl.venue_id, v_at);
  if v_rt.routine_id is not null then
    v_name := (select nullif(btrim(v.name), '') from public.venues v where v.id = v_pl.venue_id);
    raise exception using
      message = format('Your routine already has you at %s at %s that day. Pick another time.',
                       coalesce(v_name, 'this court'), public._pl_clock(v_rt.stop_at, v_rt.tz)),
      hint = 'pl:visit.taken',
      detail = jsonb_build_object('plan_id', null, 'planned_at', v_rt.stop_at, 'routine', true)::text;
  end if;
  v_by := v_at - v_pl.planned_at;
  update public.court_plans
     set planned_at = v_at, planned_end_at = planned_end_at + v_by,
         windows = public._pl_shift_windows(windows, v_by), updated_at = now()
   where id = v_pl.id;
  -- The reminder for the old time, if not sent yet (a sent one re-arms: its
  -- throttle key holds the time).
  delete from public.push_outbox o
   where o.recipient_id = v_me and o.notification_id is null and o.status in ('pending', 'failed')
     and o.push_data ->> 'kind' = 'plan_reminder' and o.push_data ->> 'plan_id' = v_pl.id::text;
  return public.list_my_court_plans();
end $$;
revoke all on function public.move_court_plan(uuid, timestamptz) from public, anon;
grant execute on function public.move_court_plan(uuid, timestamptz) to authenticated;

-- Doggle cancel_dog_place_checkin_plan: "Cancel this visit".
create or replace function public.cancel_court_plan(p_plan_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  update public.court_plans
     set status = 'cancelled', updated_at = now()
   where id = p_plan_id and user_id = v_me and kind = 'once' and status = 'planned';
  if not found then
    raise exception using message = 'That planned check-in is already over or cancelled. Pull to refresh.', hint = 'pl:visit.gone';
  end if;
  delete from public.push_outbox o
   where o.recipient_id = v_me and o.notification_id is null and o.status in ('pending', 'failed')
     and o.push_data ->> 'kind' = 'plan_reminder' and o.push_data ->> 'plan_id' = p_plan_id::text;
  return public.list_my_court_plans();
end $$;
revoke all on function public.cancel_court_plan(uuid) from public, anon;
grant execute on function public.cancel_court_plan(uuid) to authenticated;


-- ── 4. Replaced: the arrival override is for routine stops only ───────────
-- _pl_court_arrival_off: from migration_court_routines.sql (the latest).
-- Changed: "a routine stop is due" is _pl_routine_stop_due (routine stops
-- only) instead of _pl_routine_plan_at (any planned row of mine, which now
-- includes one-off plans). Same signature.
create or replace function public._pl_court_arrival_off(p_uid uuid, p_venue text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_auto    boolean;
  v_radius  int;
  v_routine boolean;
  v_here    boolean;
begin
  select s.auto_checkin, s.court_radius_m, s.routine_auto_checkin into v_auto, v_radius, v_routine
    from public.presence_settings s where s.user_id = p_uid;
  if (not coalesce(v_auto, true) or coalesce(v_radius, 100) <= 0)
     and not (coalesce(v_routine, true) and public._pl_routine_stop_due(p_uid, p_venue, now())) then
    return 'off';
  end if;
  select f.auto_checkin into v_here
    from public.court_favorites f
   where f.user_id = p_uid
     and f.venue_id in (select v.id from public.venues v where v.id = p_venue or v.canonical_id = p_venue)
   order by f.auto_checkin desc
   limit 1;
  if v_here is null then return 'not_starred'; end if;
  if not v_here then return 'off_here'; end if;
  return null;
end $$;
revoke all on function public._pl_court_arrival_off(uuid, text) from public, anon, authenticated;


-- ── 5. Replaced: the reminder, for one-off plans too ──────────────────────
-- process_court_routine_reminders: from migration_court_routines.sql (the
-- latest). Changed: a one-off plan (kind once, any court, starred or not)
-- gets the same reminder, push_data.kind 'plan_reminder' (its own throttle
-- kind too), "We'll check you in" only when an arrival there would
-- (_pl_court_arrival_off is null). A routine stop's reminder is exactly as
-- before (its routine must still exist and its court be starred).
create or replace function public.process_court_routine_reminders()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r      record;
  v_auto boolean;
  v_kind text;
begin
  for r in
    select pl.id as plan_id, pl.user_id, pl.venue_id, pl.planned_at, pl.planned_end_at, pl.kind,
           coalesce(cr.tz, public._pickleague_tz_for(pl.user_id)) as tz, v.name as venue_name,
           coalesce((select s.routine_auto_checkin from public.presence_settings s where s.user_id = pl.user_id), true) as routine_on
      from public.court_plans pl
      left join public.court_routines cr on cr.id = pl.routine_id
      left join public.venues v on v.id = pl.venue_id
     where pl.status = 'planned'
       and (pl.kind = 'once' or (cr.id is not null and public._pl_is_starred(pl.user_id, pl.venue_id)))
       and pl.planned_at <= now() + interval '10 minutes'
       and pl.planned_at > now() - interval '15 minutes'
       and not exists (
         select 1 from public.venue_checkins c
          where c.user_id = pl.user_id and c.checked_out_at is null and c.expires_at > now()
            and c.taken_back_at is null
            and c.venue_id in (select x.id from public.venues x where x.id = pl.venue_id or x.canonical_id = pl.venue_id))
       and not exists (
         select 1 from public.play_sessions s
          where s.user_id = pl.user_id and s.ended_at is null and s.started_at > now() - interval '6 hours')
  loop
    begin
      v_kind := case when r.kind = 'once' then 'plan_reminder' else 'routine_reminder' end;
      if public._pl_throttle_ok(r.user_id::text, v_kind,
                                r.plan_id::text || ':' || extract(epoch from r.planned_at)::bigint::text,
                                interval '100 years') then
        if r.kind = 'once' then
          v_auto := public._pl_court_arrival_off(r.user_id, r.venue_id) is null;
        else
          v_auto := r.routine_on and coalesce((
            select bool_or(f.auto_checkin) from public.court_favorites f
             where f.user_id = r.user_id
               and f.venue_id in (select x.id from public.venues x where x.id = r.venue_id or x.canonical_id = r.venue_id)), false);
        end if;
        perform public._pl_court_push(
          r.user_id,
          public._pl_clock(r.planned_at, r.tz) || ' · ' || coalesce(r.venue_name, 'your court'),
          case when v_auto then 'Your planned check-in. We''ll check you in when you get there.'
               else 'Your planned check-in. Tap Check in when you get there.' end,
          r.venue_name, r.planned_at + interval '30 minutes',
          jsonb_build_object('kind', v_kind, 'plan_id', r.plan_id, 'venue_id', r.venue_id,
                             'venue_name', r.venue_name, 'planned_at', r.planned_at,
                             'planned_end_at', r.planned_end_at));
      end if;
    exception when others then
      raise warning 'process_court_routine_reminders: plan % failed: %', r.plan_id, sqlerrm;
    end;
  end loop;
end $$;
revoke all on function public.process_court_routine_reminders() from public, anon, authenticated;


-- ── 5b. Replaced: a routine stop can't land next to a one-off plan ────────
-- unskip_court_routine_occurrence and move_court_routine_occurrence: from
-- migration_court_routines.sql (the latest). Changed: each takes the plans
-- lock (plan_court_checkin's) and refuses with pl:plan.taken when another
-- planned check-in of mine at that court (a one-off plan, usually) is within
-- 30 minutes of the stop's time (_pl_plan_near), as plan_court_checkin
-- refuses the other way round. Before, "Undo skip" or "Change today's time"
-- could put a routine stop 3 minutes from a one-off plan: two plans, two
-- reminders, one check-in to keep them. Same signatures, same answers.
create or replace function public.unskip_court_routine_occurrence(p_plan_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me   uuid := auth.uid();
  v_pl   public.court_plans;
  v_near public.court_plans;
  v_name text;
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  perform pg_advisory_xact_lock(hashtext('court_plans:' || v_me::text));
  select * into v_pl from public.court_plans pl
   where pl.id = p_plan_id and pl.user_id = v_me and pl.routine_id is not null
     and pl.status in ('cancelled', 'planned') and pl.planned_at > now()
   for update;
  if v_pl.id is null then
    raise exception using message = 'That routine check-in is already over, so it can''t be changed. Pull to refresh.', hint = 'pl:plan.gone';
  end if;
  if v_pl.status = 'cancelled' then
    v_near := public._pl_plan_near(v_me, v_pl.venue_id, v_pl.planned_at, v_pl.id);
    if v_near.id is not null then
      v_name := (select nullif(btrim(v.name), '') from public.venues v where v.id = v_pl.venue_id);
      raise exception using
        message = format('You already plan to check in at %s at %s. Cancel that check-in first, then undo the skip.',
                         coalesce(v_name, 'this court'),
                         public._pl_clock(v_near.planned_at, coalesce((select cr.tz from public.court_routines cr where cr.id = v_pl.routine_id),
                                                                      public._pickleague_tz_for(v_me)))),
        hint = 'pl:plan.taken',
        detail = jsonb_build_object('plan_id', v_near.id, 'planned_at', v_near.planned_at,
                                    'routine', v_near.kind = 'routine')::text;
    end if;
  end if;
  update public.court_plans
     set status = 'planned', updated_at = now()
   where id = v_pl.id;
  return public.list_my_court_routines();
end $$;
revoke all on function public.unskip_court_routine_occurrence(uuid) from public, anon;
grant execute on function public.unskip_court_routine_occurrence(uuid) to authenticated;

create or replace function public.move_court_routine_occurrence(p_plan_id uuid, p_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me   uuid := auth.uid();
  v_pl   record;
  v_at   timestamptz := date_trunc('minute', p_at);
  v_by   interval;
  v_near public.court_plans;
  v_name text;
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  perform pg_advisory_xact_lock(hashtext('court_plans:' || v_me::text));
  select pl.id, pl.venue_id, pl.planned_at, pl.routine_date, pl.status, coalesce(cr.tz, public._pickleague_tz_for(v_me)) as tz
    into v_pl
    from public.court_plans pl
    left join public.court_routines cr on cr.id = pl.routine_id
   where pl.id = p_plan_id and pl.user_id = v_me and pl.routine_id is not null
   for update of pl;
  if not found or v_pl.status <> 'planned' or v_pl.planned_at <= now() - interval '30 minutes' then
    raise exception using message = 'That routine check-in is already over, so it can''t be changed. Pull to refresh.', hint = 'pl:plan.gone';
  end if;
  if v_at is null or v_at <= now() or (v_at at time zone v_pl.tz)::date <> v_pl.routine_date then
    raise exception using message = 'Pick a later time on the same day.', hint = 'pl:plan.bad_time';
  end if;
  v_near := public._pl_plan_near(v_me, v_pl.venue_id, v_at, p_plan_id);
  if v_near.id is not null then
    v_name := (select nullif(btrim(v.name), '') from public.venues v where v.id = v_pl.venue_id);
    raise exception using
      message = format('You already plan to check in at %s at %s. Pick another time.',
                       coalesce(v_name, 'this court'), public._pl_clock(v_near.planned_at, v_pl.tz)),
      hint = 'pl:plan.taken',
      detail = jsonb_build_object('plan_id', v_near.id, 'planned_at', v_near.planned_at,
                                  'routine', v_near.kind = 'routine')::text;
  end if;
  v_by := v_at - v_pl.planned_at;
  update public.court_plans
     set planned_at = v_at, planned_end_at = planned_end_at + v_by,
         windows = public._pl_shift_windows(windows, v_by), updated_at = now()
   where id = p_plan_id;
  delete from public.push_outbox o
   where o.recipient_id = v_me and o.notification_id is null and o.status in ('pending', 'failed')
     and o.push_data ->> 'kind' = 'routine_reminder' and o.push_data ->> 'plan_id' = p_plan_id::text;
  return public.list_my_court_routines();
end $$;
revoke all on function public.move_court_routine_occurrence(uuid, timestamptz) from public, anon;
grant execute on function public.move_court_routine_occurrence(uuid, timestamptz) to authenticated;


-- ── 6. Replaced: send_on_my_way gains p_here ──────────────────────────────
-- From migration_on_my_way.sql (its only definition), every on-my-way rule
-- unchanged; p_here as in the header (B). The old 3-argument function goes
-- first, then any other signature but the new one.
drop function if exists public.send_on_my_way(text, integer, uuid[]);
do $$
declare f regprocedure;
begin
  for f in
    select p.oid::regprocedure from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'send_on_my_way'
       and p.oid is distinct from to_regprocedure('public.send_on_my_way(text,integer,uuid[],boolean)')::oid
  loop
    execute format('drop function %s', f);
  end loop;
end $$;

create or replace function public.send_on_my_way(
  p_venue       text,
  p_eta_minutes int default 15,
  p_recipients  uuid[] default null,
  p_here        boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me       uuid := auth.uid();
  v_here     boolean := coalesce(p_here, false);
  v_eta      int := coalesce(p_eta_minutes, 15);
  v_window   constant interval := interval '30 minutes';
  -- Throttle kinds: on my way, one send per court ('on_my_way', key the
  -- court) and one push per friend, any court ('on_my_way_to', key the
  -- friend); I'm here, one send per court ('on_my_way_here') and one push per
  -- friend per court ('on_my_way_here_to', key '<court>|<friend>').
  v_kind     text := case when coalesce(p_here, false) then 'on_my_way_here' else 'on_my_way' end;
  v_kind_to  text := case when coalesce(p_here, false) then 'on_my_way_here_to' else 'on_my_way_to' end;
  v_venue    text;
  v_court    text;
  v_status   text;
  v_last     timestamptz;
  v_title    text;
  v_body     text;
  v_expires  timestamptz;
  v_data     jsonb;
  v_total    int := 0;
  v_told     int := 0;
  v_retry    timestamptz;
  v_ids      uuid[];
  v_fresh    uuid[];
  v_to       uuid;
begin
  if v_me is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;
  if not v_here and (v_eta < 1 or v_eta > 180) then
    raise exception using
      message = 'Pick how far away you are: 1 minute to 3 hours.',
      hint = 'pl:omw.bad_eta',
      detail = jsonb_build_object('eta_minutes', p_eta_minutes)::text;
  end if;
  if p_recipients is not null and coalesce(cardinality(p_recipients), 0) > 50 then
    raise exception using message = 'You can tell up to 50 friends at once. Pick fewer friends, then send.', hint = 'pl:omw.too_many';
  end if;

  v_venue := public._pl_canonical_venue(p_venue);
  select nullif(trim(v.name), ''), v.confirmation_status into v_court, v_status
    from public.venues v where v.id = v_venue;
  if v_venue is null or not found or v_status = 'rejected' then
    raise exception using
      message = 'That court isn''t in Pickleague any more, so your friends can''t be told you''re on the way. Find your court again.',
      hint = 'pl:court.gone';
  end if;
  v_court := coalesce(v_court, 'the courts');

  -- One sender at a time: two quick taps (or two phones) can't both pass the
  -- window checks below.
  perform pg_advisory_xact_lock(hashtext('omw:' || v_me::text));

  -- I'm here: only while checked in at that court (Doggle 0441's rule), with
  -- a fix (what friends see as "here").
  if v_here and not exists (
    select 1 from public.venue_checkins c
     where c.user_id = v_me and c.checked_out_at is null and c.expires_at > now()
       and c.taken_back_at is null and c.location_confirmed
       and c.venue_id in (select v.id from public.venues v where v.id = v_venue or v.canonical_id = v_venue)) then
    return jsonb_build_object('sent', false, 'count', 0, 'reason', 'not_here', 'here', true,
      'eta_minutes', null, 'venue_id', v_venue, 'venue_name', v_court);
  end if;

  -- Who would be told: accepted friends, real live accounts, not blocked
  -- either way (and for I'm here, not one I hid my presence from). Picked
  -- ids, or (none picked) all my friends, starred first, at most 50.
  -- v_fresh: the ones not told by me in the last 30 minutes (on my way:
  -- about any court; I'm here: about this court).
  select coalesce(array_agg(x.id order by x.id), '{}'),
         coalesce(array_agg(x.id order by x.id) filter (
           where public._pl_omw_last(v_me, v_kind_to, case when v_here then v_venue || '|' || x.id::text else x.id::text end) is null
              or public._pl_omw_last(v_me, v_kind_to, case when v_here then v_venue || '|' || x.id::text else x.id::text end)
                 <= now() - v_window), '{}')
    into v_ids, v_fresh
    from (
      select distinct y.id
        from (
          select unnest(p_recipients) as id where p_recipients is not null
          union all
          (select a.id from (
            select case when f.requester_id = v_me then f.addressee_id else f.requester_id end as id
              from public.friendships f
             where p_recipients is null
               and f.status = 'accepted'
               and (f.requester_id = v_me or f.addressee_id = v_me)
          ) a
           where public._pl_friendable(a.id)
             and not public._pl_blocked_pair(v_me, a.id)
           order by exists (select 1 from public.close_friends cf
                             where cf.user_id = v_me and cf.friend_id = a.id) desc, a.id
           limit 50)
        ) y
       where y.id is not null
         and y.id <> v_me
         and exists (
           select 1 from public.friendships f
            where f.status = 'accepted'
              and ((f.requester_id = v_me and f.addressee_id = y.id)
                   or (f.addressee_id = v_me and f.requester_id = y.id)))
         and public._pl_friendable(y.id)
         and not public._pl_blocked_pair(v_me, y.id)
         -- I'm here is presence: only a friend who may see my check-ins by
         -- name now (not one I hid from, not while I'm paused or my
         -- check-ins are hidden).
         and not (v_here and public._pl_can_see_presence(y.id, v_me, 'checkins') <> 'named')
    ) x;
  v_total := cardinality(v_ids);

  -- Nobody to tell: say so without spending the 30-minute window.
  if v_total = 0 then
    return case when v_here
      then jsonb_build_object('sent', false, 'count', 0, 'reason', 'nobody', 'here', true,
             'eta_minutes', null, 'venue_id', v_venue, 'venue_name', v_court)
      else jsonb_build_object('sent', false, 'count', 0, 'reason', 'nobody',
             'eta_minutes', v_eta, 'venue_id', v_venue, 'venue_name', v_court) end;
  end if;

  -- One send per court per 30 minutes (on my way: a new ETA included).
  v_last := public._pl_omw_last(v_me, v_kind, v_venue);
  if v_last is not null and v_last > now() - v_window then
    return case when v_here
      then jsonb_build_object('sent', false, 'count', 0, 'reason', 'recent', 'here', true,
             'eta_minutes', null, 'venue_id', v_venue, 'venue_name', v_court,
             'sent_at', v_last, 'retry_at', v_last + v_window)
      else jsonb_build_object('sent', false, 'count', 0, 'reason', 'recent',
             'eta_minutes', v_eta, 'venue_id', v_venue, 'venue_name', v_court,
             'sent_at', v_last, 'retry_at', v_last + v_window) end;
  end if;

  -- I'm here: at most 3 other courts per 30 minutes (Doggle 0451), so
  -- checking in court after court can't push one friend again and again
  -- (the per-friend window is per court). No window spent.
  if v_here and (select count(*) from public.pl_throttle t
                  where t.scope = v_me::text and t.kind = 'on_my_way_here' and t.key <> v_venue
                    and t.last_at > now() - v_window) >= 3 then
    return jsonb_build_object('sent', false, 'count', 0, 'reason', 'limit', 'here', true,
      'eta_minutes', null, 'venue_id', v_venue, 'venue_name', v_court,
      'retry_at', (select t.last_at + v_window from public.pl_throttle t
                    where t.scope = v_me::text and t.kind = 'on_my_way_here' and t.key <> v_venue
                      and t.last_at > now() - v_window
                    order by t.last_at desc offset 2 limit 1));
  end if;

  -- Every friend picked was told in the last 30 minutes.
  if cardinality(v_fresh) = 0 then
    select min(public._pl_omw_last(v_me, v_kind_to, case when v_here then v_venue || '|' || i::text else i::text end)) + v_window
      into v_retry from unnest(v_ids) i;
    return case when v_here
      then jsonb_build_object('sent', false, 'count', 0, 'reason', 'recent_friends', 'here', true,
             'eta_minutes', null, 'venue_id', v_venue, 'venue_name', v_court, 'retry_at', v_retry)
      else jsonb_build_object('sent', false, 'count', 0, 'reason', 'recent_friends',
             'eta_minutes', v_eta, 'venue_id', v_venue, 'venue_name', v_court, 'retry_at', v_retry) end;
  end if;

  perform public._pl_throttle_ok(v_me::text, v_kind, v_venue, v_window);

  if v_here then
    v_title := public._pl_display_name(v_me) || ' is at ' || v_court;
    v_body := 'Checked in just now. Tap to see the court.';
    v_expires := now() + v_window;
    v_data := jsonb_build_object('kind', 'on_my_way', 'here', true, 'venue_id', v_venue, 'venue_name', v_court,
                                 'sender_id', v_me);
  else
    v_title := public._pl_display_name(v_me) || ' is on the way to ' || v_court;
    v_body := 'About ' || public._pl_eta_label(v_eta) || ' away. Tap to see the court.';
    v_expires := now() + make_interval(mins => greatest(v_eta, 10));
    v_data := jsonb_build_object('kind', 'on_my_way', 'venue_id', v_venue, 'venue_name', v_court,
                                 'sender_id', v_me, 'eta_minutes', v_eta);
  end if;

  foreach v_to in array v_fresh loop
    perform public._pl_throttle_ok(v_me::text, v_kind_to,
                                   case when v_here then v_venue || '|' || v_to::text else v_to::text end, v_window);
    v_told := v_told + 1;
    -- Their switches: no phone, push off or "Friends on the way" off sends
    -- nothing (counted all the same).
    if not public._pl_push_reaches(v_to, 'notifyFriendsOnTheWay') then
      continue;
    end if;
    begin
      insert into public.push_outbox
        (recipient_id, kind, category, title, body, deep_link, expires_at, push_data)
      values (v_to, 'info', 'notifyFriendsOnTheWay', v_title, v_body, 'home/-', v_expires, v_data);
    exception when others then
      -- One friend's push must never undo the others.
      raise warning 'on my way push for % not queued: %', v_to, sqlerrm;
    end;
  end loop;

  return case when v_here
    then jsonb_build_object('sent', true, 'count', v_told, 'skipped_recent', v_total - v_told, 'here', true,
           'eta_minutes', null, 'venue_id', v_venue, 'venue_name', v_court, 'sent_at', now())
    else jsonb_build_object('sent', true, 'count', v_told, 'skipped_recent', v_total - v_told,
           'eta_minutes', v_eta, 'venue_id', v_venue, 'venue_name', v_court, 'sent_at', now()) end;
end $$;

revoke all on function public.send_on_my_way(text, integer, uuid[], boolean) from public, anon;
grant execute on function public.send_on_my_way(text, integer, uuid[], boolean) to authenticated;

notify pgrst, 'reload schema';
