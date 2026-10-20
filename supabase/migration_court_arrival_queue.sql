-- ============================================================
-- Court arrival check-ins: the queue, the minute, the take-back
-- (state/court-arrival-doggle-parity.md section D item 2 and rows 58-76, with
-- the user's decisions of 2026-10-19). File 2 of 3.
--
-- At a starred court with automatic check-in on, the phone reports a real
-- arrival (it saw the player outside first) with queue_court_arrival. Still
-- there a minute later (no Exit, no Not here), process_court_arrivals checks
-- them in for 30 minutes and pushes "✅ Checked in at <court>"; 5 minutes
-- before it ends, "Still at <court>?". Leaving within 5 minutes of arriving
-- takes the check-in back (cancel_court_arrival), so a drive-by leaves no
-- visit.
--
-- What an arrival check-in is:
--   * presence only (S4): source 'geofence', via_arrival, location_confirmed
--     (friends see the player at the court), but NO fix. arrival_fix_at stays
--     null, so until a real fix arrives it counts for no session (at_court),
--     proves no stay and earns nothing: "only location-confirmed presence
--     earns anything" (docs/play-sessions-presence.md) stays true. Its first
--     real fix (Stay 1 more hour with a fix, a repeat check-in, a Start that
--     adopts it, a check-out) becomes its arrival fix and confirms no stay; a
--     later fix 5+ minutes after that one confirms the stay, as for any
--     check-in.
--   * checked_in_at = the arrival (the phone's Enter, up to 10 minutes back
--     for a slow wake); expires_at = the arrival + 30 minutes.
--   * one open check-in per player (S11): it closes mine at any other court
--     and records which (arrival_closed_ids). A take-back reopens that one if
--     it hasn't run out and nothing else of mine is open.
--   * taken back (an Exit or Not here within 5 minutes of arriving, unless it
--     was confirmed with Check in now, extended, or adopted by a play session
--     started there): taken_back_at set, closed, location_confirmed false
--     (shown to nobody, counted nowhere), its unsent pushes deleted. Never
--     deleted: checkout_venue with an id it never stored closes ALL my open
--     check-ins, so the row stays for any check-out still on its way.
--   * checkin_venue is NOT changed. The processor writes the row itself under
--     the same advisory lock (checkin:<uid>), so the live 1.0.4 check-in path
--     and its re-run chain are untouched. So are checkout_venue,
--     extend_checkin, start_play_session, set_court_favorite and the settings
--     reads.
--
-- Also for every check-in (S7): when the */10 expiry job closes a manual or
-- geofence check-in, "👋 Checked out" goes out once, one stored already over
-- included (saved with no signal, synced after it ended). Not for session
-- check-ins (they end with their session).
--
-- Pushes go straight into push_outbox (no notifications row: lock-screen
-- notices, not inbox items), category notifyAutoCheckins, deep link home/-
-- (none when the court's name is unknown), push_data {kind, venue_id,
-- venue_name, checkin_id, expires_at, via_arrival}, and an outbox expiry:
-- "Still at" at the check-in's end, "Checked in" and failures after 30
-- minutes, "👋 Checked out" after 2 hours. push_data.kind: arrival_checkin,
-- arrival_extend, arrival_failed, arrival_expired (send-push picks the
-- buttons from it); the outbox kind is 'info', the generic notification type,
-- as for the "Check in nearby?" prompt (migration_court_checkin_prompt.sql).
--
-- New: tables pl_pending_arrivals and pl_throttle (+ _pl_throttle_ok,
-- vendored); venue_checkins.via_arrival, arrival_confirmed, taken_back_at,
-- arrival_closed_ids; client RPCs queue_court_arrival, cancel_court_arrival,
-- confirm_court_arrival, court_arrival_pending; internal helpers
-- _pl_push_reaches, _pl_court_arrival_off, _pl_court_arrival_push,
-- _pl_take_back_arrival, process_court_arrivals and
-- _pl_court_arrival_rerun_repair; cron job
-- pickleague-process-court-arrivals ('20 seconds' on pg_cron 1.5 or later,
-- else every minute). No new refusal codes: signed out is pl:auth.signed_out,
-- everything else is an answer, never an error.
--
-- Replaced: _pl_checkin_arrival_fix, _pl_checkin_stay_from_fix,
-- _pl_record_checkout_fix, _pl_session_validity (migration_validity_rules.sql),
-- expire_venue_checkins (migration_venue_checkins.sql), _purge_account and
-- prune_presence_history (migration_presence_p1_hygiene.sql). Same
-- signatures and attributes, except _purge_account's search_path: '' now, as
-- for every other SECURITY DEFINER function here (live: public). Each starts
-- from the last file that defines it, named above it, because the live
-- definitions could not be read when this was written. So before applying,
-- supabase/tests/check-replaced-functions.mjs compares the live bodies with
-- those files (and with this one) and stops on any other difference: a change
-- made on live by hand is merged here first, never reverted.
-- my_session_validity is not replaced: it reads at_court from
-- _pl_session_validity.
--
-- APPLY ORDER: after migration_court_arrival_settings.sql (file 1: this file
-- reads presence_settings.court_radius_m and court_favorites.auto_checkin),
-- before migration_court_checkin_prompt.sql (file 3: it uses _pl_throttle_ok).
-- Then re-run migration_rls_hardening_2026q3.sql: its allowlist names the
-- four client RPCs here.
-- RE-APPLY right after any re-run of migration_validity_rules.sql,
-- migration_venue_checkins.sql, migration_presence_p1_hygiene.sql or
-- migration_moderation_report_block.sql: they put older bodies of the
-- functions above back (for example arrival_fix_at = now() for an arrival
-- check-in, which would let it earn without a fix, or a _purge_account that
-- leaves a deleted account's waiting arrivals, throttle rows and outbox
-- pushes behind). A re-run of migration_validity_rules.sql also changes rows:
-- its one-time backfill gives every arrival check-in with no fix an arrival
-- fix, and its session backfill re-judges ended sessions with the older
-- at_court. Re-applying this file undoes both (section 10): it clears every
-- arrival fix no real fix gave, then re-judges the ended sessions that
-- overlapped an arrival check-in. A stay confirmed in between (a fix 5+
-- minutes after such an arrival fix) is not undone, hence "right after".
-- Re-runnable; no begin/commit.
--   supabase db query --linked -f supabase/migration_court_arrival_queue.sql
-- ============================================================


-- ── 1. Tables ──────────────────────────────────────────────────────────────

-- An arrival waiting out its minute (due_at), or an Exit / Not here marker
-- (cancelled_at): a cancelled row refuses an Enter from before it that
-- arrives late ('left') and holds off the next arrival there for 10 minutes
-- ('recently_left'). One row per player and court; venue_id is canonical.
-- checkin_id is the id the check-in will get (the phone's, so its own notices
-- and buttons name the right row). No coordinates are stored. Taken by
-- process_court_arrivals when due; markers are purged after 2 hours.
-- venue_id has no foreign key on purpose: a court removed in that minute must
-- still reach the processor, which tells the player why they weren't checked
-- in (a cascade would drop the arrival silently after the phone said
-- "Checking you in").
create table if not exists public.pl_pending_arrivals (
  user_id      uuid not null references public.profiles (id) on delete cascade,
  venue_id     text not null,
  arrived_at   timestamptz not null,
  due_at       timestamptz not null,
  cancelled_at timestamptz,
  checkin_id   uuid,
  created_at   timestamptz not null default now(),
  primary key (user_id, venue_id)
);
alter table public.pl_pending_arrivals enable row level security;   -- no policies: RPCs only
revoke all on public.pl_pending_arrivals from anon, authenticated;

-- Vendored from @just-messin-around/expo-foundation@1.49.0 (server kit). Edit upstream, then re-vendor.
-- Generic cooldown (foundation server kit). Placeholder: pl.
-- _pl_throttle_ok(scope, kind, key, window) returns true at most once per
-- window for a (scope, kind, key) and records the hit. Call it from producers
-- before enqueueing, so a burst of events sends one notification.

create table if not exists public.pl_throttle (
  scope      text not null,
  kind       text not null,
  key        text not null,
  last_at    timestamptz not null default now(),
  primary key (scope, kind, key)
);
alter table public.pl_throttle enable row level security;

create or replace function public._pl_throttle_ok(p_scope text, p_kind text, p_key text, p_window interval)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_last timestamptz;
begin
  select last_at into v_last from public.pl_throttle
   where scope = p_scope and kind = p_kind and key = p_key for update;
  if v_last is not null and v_last > now() - p_window then
    return false;
  end if;
  insert into public.pl_throttle (scope, kind, key, last_at) values (p_scope, p_kind, p_key, now())
  on conflict (scope, kind, key) do update set last_at = now();
  return true;
end $$;
revoke execute on function public._pl_throttle_ok(text, text, text, interval) from public, anon, authenticated;
-- (end of vendored block) Pickleague's scope is the player's id as text, so
-- _purge_account and prune_presence_history can clear it. No client
-- privileges, as for the other internal tables.
revoke all on public.pl_throttle from anon, authenticated;


-- ── 2. venue_checkins: arrival columns ─────────────────────────────────────
alter table public.venue_checkins add column if not exists via_arrival        boolean not null default false;
alter table public.venue_checkins add column if not exists arrival_confirmed  boolean not null default false;
alter table public.venue_checkins add column if not exists taken_back_at      timestamptz;
alter table public.venue_checkins add column if not exists arrival_closed_ids uuid[];
-- "Still at" (every 20 s) and the arrival lookups read only open arrival rows.
create index if not exists venue_checkins_arrival_open_idx on public.venue_checkins (expires_at)
  where via_arrival and checked_out_at is null;
comment on column public.venue_checkins.via_arrival is
  'Made by process_court_arrivals: the phone saw the player arrive at a starred court and stay a minute. No fix, so '
  'arrival_fix_at stays null and it earns nothing (at_court, the stay proof) until a real fix arrives.';
comment on column public.venue_checkins.arrival_confirmed is
  'The player confirmed an arrival check-in (Check in now): an Exit or Not here no longer takes it back.';
comment on column public.venue_checkins.taken_back_at is
  'An arrival check-in taken back (left, or Not here, within 5 minutes of arriving): closed, location_confirmed '
  'false, shown to nobody and counted nowhere. Kept, not deleted, so a check-out still on its way finds it.';
comment on column public.venue_checkins.arrival_closed_ids is
  'The check-ins of mine elsewhere this arrival check-in closed (one open check-in per player). A take-back reopens '
  'the latest of them if it has not run out and nothing else of mine is open.';
comment on column public.venue_checkins.arrival_fix_at is
  'When the arrival fix was taken, on the server clock (from its age), never the client''s p_at. Set on insert for a '
  'confirmed row; for an arrival check-in (via_arrival) by its first real fix. The stay proof counts 5 minutes from here.';


-- ── 3. Rewards: an arrival check-in earns nothing without a real fix (S4) ──

-- _pl_checkin_arrival_fix: from migration_validity_rules.sql (its only
-- definition). Changed: an arrival check-in is stored with no arrival fix
-- (before: now(), which would have let a check-in with no fix count for a
-- session and start the stay clock). Not SECURITY DEFINER, search_path ''.
create or replace function public._pl_checkin_arrival_fix()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Every other confirmed row records when its arrival fix was taken: fix_at,
  -- which the Phase 1 functions store on the server clock. An arrival
  -- check-in has no fix: its first real one sets this later
  -- (_pl_checkin_stay_from_fix, _pl_record_checkout_fix).
  new.arrival_fix_at := case when new.location_confirmed and not new.via_arrival
                             then least(coalesce(new.fix_at, now()), now()) end;
  return new;
end $$;
revoke all on function public._pl_checkin_arrival_fix() from public, anon, authenticated;

-- _pl_checkin_stay_from_fix: from migration_validity_rules.sql (its only
-- definition). Changed: on an arrival check-in with no arrival fix yet, the
-- first fix stored on it (extend_checkin, a repeat check-in, a Start that
-- adopts it: each has already confirmed this court) becomes the arrival fix
-- and confirms no stay. Everything else as before.
create or replace function public._pl_checkin_stay_from_fix()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.via_arrival and new.location_confirmed and new.arrival_fix_at is null then
    if new.fix_at is not null then
      new.arrival_fix_at := least(new.fix_at, now());
    end if;
    return new;
  end if;
  if new.location_confirmed and old.location_confirmed and not new.stay_confirmed
     and new.fix_at is not null
     and new.fix_at > coalesce(old.fix_at, '-infinity'::timestamptz)
     and least(new.fix_at, now())
         >= greatest(new.checked_in_at, coalesce(new.arrival_fix_at, new.created_at)) + interval '5 minutes' then
    new.stay_confirmed := true;
  end if;
  return new;
end $$;
revoke all on function public._pl_checkin_stay_from_fix() from public, anon, authenticated;
-- trg_venue_checkins_arrival (before insert) and trg_venue_checkins_stay
-- (before update of fix_at) already call these two (migration_validity_rules.sql).

-- _pl_record_checkout_fix: from migration_validity_rules.sql (its only
-- definition). Changed: on an arrival check-in with no arrival fix yet, a
-- check-out fix that confirms the court and was taken during the check-in
-- becomes its arrival fix and confirms no stay (before: counted from
-- created_at, the processor's insert, so a check-out 5 minutes later would
-- have confirmed a stay no fix ever began). Never raises, as before.
create or replace function public._pl_record_checkout_fix(
  p_ids        uuid[],
  p_lat        double precision,
  p_lng        double precision,
  p_accuracy_m double precision,
  p_fix_age_ms double precision
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fix_at timestamptz;
  v_fix    record;
  r        public.venue_checkins;
begin
  if p_ids is null or cardinality(p_ids) = 0 then return; end if;
  if p_lat is null or p_lng is null or abs(p_lat) > 90 or abs(p_lng) > 180 then return; end if;
  if p_fix_age_ms is null or p_fix_age_ms < -5000 then return; end if;
  v_fix_at := now() - make_interval(secs => greatest(p_fix_age_ms, 0) / 1000.0);

  for r in select * from public.venue_checkins c where c.id = any (p_ids) loop
    select * into v_fix from public._pl_check_fix(r.venue_id, p_lat, p_lng, p_accuracy_m, null, 0);
    update public.venue_checkins c
       set checkout_fix_at         = v_fix_at,
           checkout_fix_accuracy_m = p_accuracy_m,
           checkout_fix_distance_m = v_fix.distance_m,
           checkout_fix_lat        = case when coalesce(v_fix.confirmed, false) then p_lat end,
           checkout_fix_lng        = case when coalesce(v_fix.confirmed, false) then p_lng end,
           arrival_fix_at          = case when r.via_arrival and r.location_confirmed and r.arrival_fix_at is null
                                               and coalesce(v_fix.confirmed, false)
                                               and v_fix_at between r.checked_in_at and r.expires_at
                                          then v_fix_at
                                          else c.arrival_fix_at end,
           stay_confirmed          = c.stay_confirmed
                                     or (r.location_confirmed
                                         and not (r.via_arrival and r.arrival_fix_at is null)
                                         and coalesce(v_fix.confirmed, false)
                                         and v_fix_at >= greatest(r.checked_in_at, coalesce(r.arrival_fix_at, r.created_at))
                                                         + interval '5 minutes'
                                         and v_fix_at <= r.expires_at)
     where c.id = r.id;
  end loop;
exception when others then
  raise warning 'check-out fix not recorded: %', sqlerrm;
end $$;
revoke all on function public._pl_record_checkout_fix(uuid[], double precision, double precision, double precision, double precision)
  from public, anon, authenticated;

-- _pl_session_validity: from migration_validity_rules.sql (its only
-- definition). Changed: at_court skips an arrival check-in that has no real
-- fix yet. Same OUT parameters, so create or replace keeps every caller
-- (_pl_refresh_session_validity, and through it my_session_validity).
create or replace function public._pl_session_validity(
  p_session          uuid,
  out valid          boolean,
  out reason         text,
  out pending        boolean,
  out needs          text,
  out window_ends_at timestamptz,
  out at_court       boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  s            public.play_sessions;
  v_until      timestamptz;
  v_linked     boolean;
  v_window     boolean;
  v_match_done boolean;
  v_drill      boolean;
begin
  valid := false;
  pending := false;
  at_court := false;
  select * into s from public.play_sessions ps where ps.id = p_session;
  if s.id is null then return; end if;

  window_ends_at := s.ended_at + interval '2 hours';
  v_until := coalesce(s.ended_at, now()) + interval '2 hours';

  -- At the court: a location-confirmed check-in of mine at this session's
  -- court (the session's own, or one it adopted) overlapped it, counted from
  -- its arrival fix. An arrival check-in counts only once a real fix gave it
  -- one (S4).
  at_court := s.venue_id is not null and exists (
    select 1
      from public.venue_checkins c
     where c.user_id = s.user_id
       and c.location_confirmed
       and not (c.via_arrival and c.arrival_fix_at is null)
       and c.venue_id in (select v.id from public.venues v where v.id = s.venue_id or v.canonical_id = s.venue_id)
       and coalesce(c.arrival_fix_at, c.checked_in_at) < coalesce(s.ended_at, now())
       and coalesce(c.checked_out_at, c.expires_at) > s.started_at);

  -- Matches the player played in (recorded: pending or completed; never a
  -- scheduled one), linked to this session or recorded in its window, that
  -- count for this session and no other of mine.
  select coalesce(bool_or(x.linked), false),
         coalesce(bool_or(not x.linked), false),
         coalesce(bool_or(x.done), false)
    into v_linked, v_window, v_match_done
    from (select coalesce(m.play_session_id = s.id, false) as linked,
                 m.status = 'completed' as done
            from public.matches m
           where m.status in ('pending', 'completed')
             and (m.player1_id = s.user_id or m.player2_id = s.user_id
                  or m.partner1_id = s.user_id or m.partner2_id = s.user_id)
             and (m.play_session_id = s.id
                  or m.created_at between s.started_at and v_until)
             and public._pl_match_session(s.user_id, m.play_session_id, m.created_at) = s.id) x;

  -- A drill session of mine, held during this session, that I completed
  -- (reviewed) in the window, and that counts for this session and no other.
  select exists (
    select 1
      from public.drill_session_reviews r
      join public.drill_sessions d on d.id = r.session_id
     where r.user_id = s.user_id
       and (d.player1_id = s.user_id or d.player2_id = s.user_id)
       and r.created_at between s.started_at and v_until
       and d.starts_at is not null
       and public._pl_drill_session(s.user_id, d.id, r.created_at, d.starts_at, d.length_minutes) = s.id)
    into v_drill;

  if s.ended_at is null then
    reason := 'open';
    needs := case when now() - s.started_at < interval '5 minutes' then 'minutes'
                  when v_linked or v_window or v_drill then null
                  else 'match_or_drill' end;
    return;
  end if;
  if s.ended_at - s.started_at < interval '5 minutes' then
    reason := 'too_short';
    needs := 'minutes';
    return;
  end if;
  if v_linked then reason := 'linked_match';
  elsif v_window then reason := 'match_in_window';
  elsif v_drill then reason := 'drill_in_window';
  else
    reason := 'no_match_or_drill';
    needs := 'match_or_drill';
    return;
  end if;
  valid := true;
  pending := not (v_match_done or v_drill);
end $$;
revoke all on function public._pl_session_validity(uuid) from public, anon, authenticated;


-- ── 4. Internal helpers ────────────────────────────────────────────────────

-- Whether a push of this category can reach the player at all: a device token,
-- push switched on (send-push sends only on an explicit pushEnabled true: push
-- is opt-in), and the category not switched off. The phone shows its own
-- "Checked in" and "Still at" when this is false (decision D3).
create or replace function public._pl_push_reaches(p_uid uuid, p_pref text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.push_tokens t where t.user_id = p_uid)
     and coalesce((select (p.prefs -> 'pushEnabled') = 'true'::jsonb
                          and (p.prefs -> p_pref) is distinct from 'false'::jsonb
                     from public.user_preferences p where p.user_id = p_uid), false);
$$;
revoke all on function public._pl_push_reaches(uuid, text) from public, anon, authenticated;

-- Why automatic check-in is off for this player at this (canonical) court, or
-- null when it is on: 'off' (switched off everywhere: "Check me in when I
-- arrive" off, or "Notice me at starred courts" at Off), 'off_here' (starred,
-- switched off for this court), 'not_starred'. A missing settings row means
-- the defaults (on, 100 m).
create or replace function public._pl_court_arrival_off(p_uid uuid, p_venue text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_auto   boolean;
  v_radius int;
  v_here   boolean;
begin
  select s.auto_checkin, s.court_radius_m into v_auto, v_radius
    from public.presence_settings s where s.user_id = p_uid;
  if not coalesce(v_auto, true) or coalesce(v_radius, 100) <= 0 then return 'off'; end if;
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

-- One push about a check-in, straight into the outbox. p_kind goes in
-- push_data.kind; the outbox kind is the generic 'info'. Never raises: a push
-- problem must not undo the check-in, take-back or expiry it reports.
create or replace function public._pl_court_arrival_push(
  p_uid          uuid,
  p_kind         text,
  p_title        text,
  p_body         text,
  p_venue        text,
  p_venue_name   text,
  p_checkin_id   uuid,
  p_checkin_ends timestamptz,
  p_via_arrival  boolean,
  p_push_expires timestamptz
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.push_outbox
    (recipient_id, kind, category, title, body, deep_link, expires_at, push_data)
  values (
    p_uid, 'info', 'notifyAutoCheckins', p_title, p_body,
    -- Home's court card. Without the court's name the push can't say which
    -- court, so a tap just opens the app.
    case when p_venue_name is not null then 'home/-' end,
    p_push_expires,
    jsonb_strip_nulls(jsonb_build_object(
      'kind', p_kind, 'venue_id', p_venue, 'venue_name', p_venue_name,
      'checkin_id', p_checkin_id, 'expires_at', p_checkin_ends, 'via_arrival', p_via_arrival)));
exception when others then
  raise warning 'court arrival push % for % not queued: %', p_kind, p_uid, sqlerrm;
end $$;
revoke all on function public._pl_court_arrival_push(uuid, text, text, text, text, text, uuid, timestamptz, boolean, timestamptz)
  from public, anon, authenticated;

-- Take back arrival check-ins that were never a visit (row 63). The caller
-- holds checkin:<p_uid> and has picked the rows (cancel_court_arrival). Each
-- is closed (at p_left, if still open), marked taken back and unconfirmed:
-- shown to nobody, counted nowhere, nothing earned. Its pushes not yet sent
-- ("Checked in", "Still at") are deleted. The check-in it closed elsewhere
-- (S11) is reopened when that one is still closed from the arrival, not
-- taken back, not a session's, not run out, and nothing else of mine is open
-- (one open check-in per player). True when any row was taken back.
create or replace function public._pl_take_back_arrival(p_uid uuid, p_ids uuid[], p_left timestamptz)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  t        record;
  v_any    boolean := false;
  v_reopen uuid;
begin
  if p_uid is null or p_ids is null or cardinality(p_ids) = 0 then return false; end if;
  for t in
    update public.venue_checkins c
       set taken_back_at      = now(),
           location_confirmed = false,
           checked_out_at     = coalesce(c.checked_out_at,
                                         greatest(c.checked_in_at + interval '1 second',
                                                  least(coalesce(p_left, now()), c.expires_at)))
     where c.id = any (p_ids) and c.user_id = p_uid and c.via_arrival and c.taken_back_at is null
    returning c.id, c.checked_in_at, c.arrival_closed_ids
  loop
    v_any := true;
    delete from public.push_outbox o
     where o.recipient_id = p_uid and o.notification_id is null
       and o.status in ('pending', 'failed')
       and o.push_data ->> 'checkin_id' = t.id::text
       and o.push_data ->> 'kind' in ('arrival_checkin', 'arrival_extend');

    if t.arrival_closed_ids is not null
       and not exists (select 1 from public.venue_checkins o
                        where o.user_id = p_uid and o.checked_out_at is null and o.expires_at > now()) then
      select c.id into v_reopen
        from public.venue_checkins c
       where c.id = any (t.arrival_closed_ids) and c.user_id = p_uid
         and c.checked_out_at is not null and c.checked_out_at <= t.checked_in_at
         and c.taken_back_at is null and c.source <> 'session' and c.expires_at > now()
       order by c.checked_in_at desc
       limit 1;
      if v_reopen is not null then
        update public.venue_checkins set checked_out_at = null where id = v_reopen;
      end if;
    end if;
  end loop;
  return v_any;
end $$;
revoke all on function public._pl_take_back_arrival(uuid, uuid[], timestamptz) from public, anon, authenticated;


-- ── 5. Client RPCs ─────────────────────────────────────────────────────────

-- The geofence Enter (a real arrival): check me in here if I'm still here in
-- a minute. Answers, in this order (the phone prompts "Check in nearby?" for
-- any reason but already_checked_in, left and court_gone):
--   court_gone          the court isn't in Pickleague any more
--   off / off_here / not_starred   (_pl_court_arrival_off)
--   no_consent          I haven't chosen who sees me at the courts yet
--   already_checked_in  an open check-in of mine at this court ({open: true});
--                       a taken-back one is closed, so it never holds
--   recently_left       I left here (Exit or Not here) under 10 minutes before
--                       this arrival: a phone at the court's edge must not
--                       check in, get taken back and check in again
--   left                an Exit from after this arrival already landed (this
--                       Enter reached Pickleague after it)
--   queued              {due_at, checkin_id}; a second Enter for the same
--                       arrival keeps the first one's time and id
-- Every answer carries pushable (_pl_push_reaches 'notifyAutoCheckins').
-- p_arrived_at: a late request (a slow wake) keeps the arrival time when it
-- is under 10 minutes old; anything else is now. p_checkin_id: the id the
-- check-in will get (a fresh one when missing or already used). No cooldown
-- (Pickleague has none): only an OPEN check-in here stops an arrival.
create or replace function public.queue_court_arrival(
  p_venue      text,
  p_arrived_at timestamptz default null,
  p_checkin_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me    uuid := auth.uid();
  v_venue text;
  v_push  boolean;
  v_off   text;
  v_at    timestamptz := now();
  v_prev  timestamptz;
  v_cid   uuid;
  v_row   public.pl_pending_arrivals;
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  v_push := public._pl_push_reaches(v_me, 'notifyAutoCheckins');

  v_venue := public._pl_canonical_venue(p_venue);
  if v_venue is null then
    return jsonb_build_object('queued', false, 'reason', 'court_gone', 'pushable', v_push);
  end if;
  v_off := public._pl_court_arrival_off(v_me, v_venue);
  if v_off is not null then
    return jsonb_build_object('queued', false, 'reason', v_off, 'pushable', v_push);
  end if;
  if not exists (select 1 from public.presence_settings s
                  where s.user_id = v_me and s.consent_seen_at is not null) then
    return jsonb_build_object('queued', false, 'reason', 'no_consent', 'pushable', v_push);
  end if;
  if exists (select 1 from public.venue_checkins c
              where c.user_id = v_me and c.checked_out_at is null and c.expires_at > now()
                and c.taken_back_at is null
                and c.venue_id in (select v.id from public.venues v where v.id = v_venue or v.canonical_id = v_venue)) then
    return jsonb_build_object('queued', false, 'reason', 'already_checked_in', 'open', true, 'pushable', v_push);
  end if;

  if p_arrived_at is not null and p_arrived_at < now() and p_arrived_at > now() - interval '10 minutes' then
    v_at := p_arrived_at;
  end if;
  select p.cancelled_at into v_prev
    from public.pl_pending_arrivals p where p.user_id = v_me and p.venue_id = v_venue;
  if v_prev is not null and v_prev < v_at and v_prev > v_at - interval '10 minutes' then
    return jsonb_build_object('queued', false, 'reason', 'recently_left', 'pushable', v_push);
  end if;

  v_cid := p_checkin_id;
  if v_cid is null or exists (select 1 from public.venue_checkins c where c.id = v_cid) then
    v_cid := gen_random_uuid();
  end if;
  -- A row I left (cancelled_at) is reused only by an arrival after I left: an
  -- Enter that reaches Pickleague after its own Exit stays cancelled.
  insert into public.pl_pending_arrivals as p (user_id, venue_id, arrived_at, due_at, checkin_id)
  values (v_me, v_venue, v_at, v_at + interval '1 minute', v_cid)
  on conflict (user_id, venue_id) do update
    set arrived_at   = excluded.arrived_at,
        due_at       = excluded.due_at,
        checkin_id   = excluded.checkin_id,
        cancelled_at = null,
        created_at   = now()
    where p.cancelled_at is not null and p.cancelled_at < excluded.arrived_at;
  select * into v_row from public.pl_pending_arrivals p where p.user_id = v_me and p.venue_id = v_venue;
  if v_row.cancelled_at is not null then
    return jsonb_build_object('queued', false, 'reason', 'left', 'pushable', v_push);
  end if;
  return jsonb_build_object('queued', true, 'pushable', v_push,
                            'due_at', v_row.due_at, 'checkin_id', v_row.checkin_id);
end $$;
revoke all on function public.queue_court_arrival(text, timestamptz, uuid) from public, anon;
grant execute on function public.queue_court_arrival(text, timestamptz, uuid) to authenticated;

-- The geofence Exit at p_left_at (a replay from the phone's offline queue
-- carries the Exit time; within 2 hours, else now), or Not here (p_not_here,
-- the press time): don't check me in here.
--   dropped  an arrival still waiting out its minute was stopped. With none
--            (yet), a marker refuses an Enter from before I left that lands
--            later, and holds off the next arrival here for 10 minutes.
--   removed  it had become a check-in, now taken back (_pl_take_back_arrival):
--            within 5 minutes of arriving (checked_in_at is the arrival;
--            created_at is the processor's insert, a minute later), not
--            confirmed (Check in now), its 30 minutes untouched (not extended
--            or adopted), and no play session of mine started here since.
--   closed   an Exit: the same as removed (a later Exit is leaving a real
--            visit, left to the phone's "Leaving X?": background Exits can
--            be spurious). Not here: when nothing was removed, my open
--            check-in here that began by the press is checked out at it.
-- p_venue null (sign-out): stops every arrival of mine still waiting, so
-- nobody is checked in after signing out. The sign-out's own check-out runs
-- beside this and closes what is open, but the job may land an arrival it
-- had already taken after that check-out ran: this waits for the job (the
-- pending rows, then the lock) and checks such an arrival check-in out
-- (closed). Never a take-back here: that would reopen a check-in elsewhere
-- the sign-out just closed.
create or replace function public.cancel_court_arrival(
  p_venue    text default null,
  p_left_at  timestamptz default null,
  p_not_here boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me      uuid := auth.uid();
  v_left    timestamptz := now();
  v_venue   text;
  v_dropped boolean := false;
  v_closed  boolean := false;
  v_removed boolean := false;
  v_ids     uuid[];
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  if p_left_at is not null and p_left_at < now() and p_left_at > now() - interval '2 hours' then
    v_left := p_left_at;
  end if;

  if p_venue is null then
    -- A row the job has already taken (deleted, not yet committed) makes this
    -- wait for the job's commit, then finds it gone.
    update public.pl_pending_arrivals p
       set cancelled_at = v_left
     where p.user_id = v_me and p.cancelled_at is null and p.arrived_at <= v_left;
    v_dropped := found;
    -- After the pending rows, as below. Then every arrival check-in the job
    -- landed is visible: check it out, and drop its unsent "Checked in".
    perform pg_advisory_xact_lock(hashtext('checkin:' || v_me::text));
    with closed as (
      update public.venue_checkins c
         set checked_out_at = greatest(c.checked_in_at + interval '1 second', least(v_left, c.expires_at))
       where c.user_id = v_me and c.via_arrival and c.checked_out_at is null and c.checked_in_at <= v_left
      returning c.id)
    select array_agg(closed.id) into v_ids from closed;
    v_closed := v_ids is not null;
    if v_closed then
      delete from public.push_outbox o
       where o.recipient_id = v_me and o.notification_id is null
         and o.status in ('pending', 'failed')
         and o.push_data ->> 'checkin_id' in (select x::text from unnest(v_ids) x)
         and o.push_data ->> 'kind' in ('arrival_checkin', 'arrival_extend');
    end if;
    return jsonb_build_object('dropped', v_dropped, 'closed', v_closed, 'removed', false);
  end if;

  v_venue := coalesce(public._pl_canonical_venue(p_venue), p_venue);

  -- Only an arrival from before I left: one after it (I came back) stays.
  update public.pl_pending_arrivals p
     set cancelled_at = v_left
   where p.user_id = v_me and p.venue_id = v_venue
     and p.cancelled_at is null and p.arrived_at <= v_left;
  v_dropped := found;
  if not v_dropped and exists (select 1 from public.venues v where v.id = v_venue) then
    insert into public.pl_pending_arrivals as p (user_id, venue_id, arrived_at, due_at, cancelled_at)
    values (v_me, v_venue, v_left, v_left, v_left)
    on conflict (user_id, venue_id) do update
      set cancelled_at = greatest(p.cancelled_at, excluded.cancelled_at)
      where p.cancelled_at is not null;
  end if;

  -- The lock comes after the pending row, never before: process_court_arrivals
  -- holds the rows it took while it waits for this lock, so taking the lock
  -- first could deadlock with it.
  perform pg_advisory_xact_lock(hashtext('checkin:' || v_me::text));

  select array_agg(c.id) into v_ids
    from public.venue_checkins c
   where c.user_id = v_me
     and c.venue_id in (select v.id from public.venues v where v.id = v_venue or v.canonical_id = v_venue)
     and c.via_arrival and not c.arrival_confirmed and c.taken_back_at is null
     and c.expires_at = c.checked_in_at + interval '30 minutes'
     and c.checked_in_at <= v_left and v_left < c.checked_in_at + interval '5 minutes'
     and not exists (
       select 1 from public.play_sessions s
        where s.user_id = v_me and s.started_at >= c.checked_in_at
          and s.venue_id in (select v.id from public.venues v where v.id = v_venue or v.canonical_id = v_venue));
  v_removed := public._pl_take_back_arrival(v_me, v_ids, v_left);

  if coalesce(p_not_here, false) then
    if not v_removed then
      -- Later, or a check-in I made myself: I'm not here, so check out. A
      -- queued Not here never closes a check-in made after its press.
      update public.venue_checkins c
         set checked_out_at = greatest(c.checked_in_at + interval '1 second', least(v_left, c.expires_at))
       where c.user_id = v_me and c.checked_out_at is null and c.checked_in_at <= v_left
         and c.venue_id in (select v.id from public.venues v where v.id = v_venue or v.canonical_id = v_venue);
      v_closed := found;
    end if;
  else
    v_closed := v_removed;
  end if;
  return jsonb_build_object('dropped', v_dropped, 'closed', v_closed, 'removed', v_removed);
end $$;
revoke all on function public.cancel_court_arrival(text, timestamptz, boolean) from public, anon;
grant execute on function public.cancel_court_arrival(text, timestamptz, boolean) to authenticated;

-- Check in now, pressed after the arrival check-in already landed: it's a
-- real visit, so an Exit or Not here no longer takes it back. True when I
-- have an open arrival check-in here (confirmed now or already).
create or replace function public.confirm_court_arrival(p_venue text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me    uuid := auth.uid();
  v_venue text;
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  v_venue := coalesce(public._pl_canonical_venue(p_venue), p_venue);
  -- In line with cancel_court_arrival, so a take-back never removes a
  -- check-in confirmed while it was deciding.
  perform pg_advisory_xact_lock(hashtext('checkin:' || v_me::text));
  update public.venue_checkins c
     set arrival_confirmed = true
   where c.user_id = v_me and c.via_arrival and c.taken_back_at is null
     and c.checked_out_at is null and c.expires_at > now()
     and c.venue_id in (select v.id from public.venues v where v.id = v_venue or v.canonical_id = v_venue);
  return found;
end $$;
revoke all on function public.confirm_court_arrival(text) from public, anon;
grant execute on function public.confirm_court_arrival(text) to authenticated;

-- Whether an arrival here is still waiting out its minute. Check in now on
-- "At X?" asks it when its own fix didn't confirm: it may promise "you'll be
-- checked in here in a minute" only while this is true. Read-only.
create or replace function public.court_arrival_pending(p_venue text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  return exists (
    select 1 from public.pl_pending_arrivals p
     where p.user_id = v_me
       and p.venue_id = coalesce(public._pl_canonical_venue(p_venue), p_venue)
       and p.cancelled_at is null);
end $$;
revoke all on function public.court_arrival_pending(text) from public, anon;
grant execute on function public.court_arrival_pending(text) to authenticated;


-- ── 6. The processor (pg_cron, every 20 seconds) ───────────────────────────
-- A. Markers from Exits are needed only while an Enter could still be on its
--    way: purged after 2 hours.
-- B. Arrivals that stayed a minute become check-ins (row 61). Skipped
--    quietly: switched off (everywhere or here) or unstarred while it waited
--    (their own choice; the app takes "At X?" down when they make it); an
--    open check-in of mine at this court already (it is never touched);
--    a confirmed check-in of mine elsewhere begun after the arrival (I moved
--    on, and it stands, as checkin_venue never closes one made after its
--    tap); checked out under this id before it landed (Check out on the
--    phone's own "Checked in"). Told why ("Not checked in at <court>"): the
--    court is gone, a play session is running, or anything failing. No
--    consent re-check: consent can't be withdrawn (consent_seen_at only ever
--    stamps).
-- C. "Still at <court>?" 5 minutes before an arrival check-in ends, once, and
--    only while its 30 minutes are untouched (extending was a choice to stay;
--    Stay 1 more hour sends its own reminders on the phone).
-- Doggle's deferred friend push is not ported: Pickleague has no friend
-- check-in push yet (row 64).
create or replace function public.process_court_arrivals()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r        record;
  v_venue  text;
  v_name   text;
  v_fail   text;
  v_id     uuid;
  v_until  timestamptz;
  v_closed uuid[];
begin
  -- A.
  delete from public.pl_pending_arrivals p
   where p.cancelled_at is not null and p.cancelled_at < now() - interval '2 hours';

  -- B.
  for r in
    delete from public.pl_pending_arrivals p
     where p.due_at <= now() and p.cancelled_at is null
    returning p.user_id, p.venue_id, p.arrived_at, p.checkin_id
  loop
    v_venue := null;
    v_name := null;
    v_fail := null;
    begin
      v_venue := public._pl_canonical_venue(r.venue_id);
      if v_venue is null then
        v_fail := 'court_gone';
      else
        select v.name into v_name from public.venues v where v.id = v_venue;
        if public._pl_court_arrival_off(r.user_id, v_venue) is not null then continue; end if;
        perform pg_advisory_xact_lock(hashtext('checkin:' || r.user_id::text));
        if exists (select 1 from public.venue_checkins c
                    where c.user_id = r.user_id and c.checked_out_at is null and c.expires_at > now()
                      and c.venue_id in (select v.id from public.venues v where v.id = v_venue or v.canonical_id = v_venue))
        then continue; end if;
        if exists (select 1 from public.venue_checkins c
                    where c.user_id = r.user_id and c.checked_out_at is null and c.expires_at > now()
                      and c.location_confirmed and c.checked_in_at > r.arrived_at)
        then continue; end if;
        if r.checkin_id is not null
           and exists (select 1 from public.presence_closed_ids e where e.user_id = r.user_id and e.id = r.checkin_id)
        then continue; end if;

        -- A session nobody ended counts as running until the 6-hour expiry
        -- (expire_play_sessions) would close it.
        if exists (select 1 from public.play_sessions s
                    where s.user_id = r.user_id and s.ended_at is null
                      and s.started_at > now() - interval '6 hours') then
          v_fail := 'session';
        else
          v_id := r.checkin_id;
          if v_id is null or exists (select 1 from public.venue_checkins c where c.id = v_id) then
            v_id := gen_random_uuid();
          end if;
          v_until := r.arrived_at + interval '30 minutes';
          -- One open check-in per player (S11): mine elsewhere ends at the
          -- arrival, and the arrival remembers it for a take-back. One that
          -- has already run out is left to expire_venue_checkins, which
          -- closes it at its own end and says so (and the two jobs never
          -- update the same rows at once).
          with closed as (
            update public.venue_checkins c
               set checked_out_at = greatest(c.checked_in_at + interval '1 second', least(r.arrived_at, c.expires_at))
             where c.user_id = r.user_id and c.checked_out_at is null and c.expires_at > now()
            returning c.id)
          select array_agg(closed.id) into v_closed from closed;
          -- No fix (S4): trg_venue_checkins_arrival leaves arrival_fix_at null.
          insert into public.venue_checkins
            (id, user_id, venue_id, checked_in_at, expires_at, source,
             location_confirmed, via_arrival, arrival_closed_ids)
          values
            (v_id, r.user_id, v_venue, r.arrived_at, v_until, 'geofence',
             true, true, v_closed);
          perform public._pl_court_arrival_push(
            r.user_id, 'arrival_checkin',
            '✅ Checked in at ' || coalesce(v_name, 'your starred court'),
            'You''re checked in. Check out when you leave, or tap Stay 1 more hour if you''re staying.',
            v_venue, v_name, v_id, v_until, true, now() + interval '30 minutes');
        end if;
      end if;
    exception when others then
      raise warning 'court arrival for % at % failed: % (%)', r.user_id, r.venue_id, sqlerrm, sqlstate;
      v_fail := 'error';
    end;
    -- The phone said "Checking you in here in a minute", so say why not.
    if v_fail is not null then
      perform public._pl_court_arrival_push(
        r.user_id, 'arrival_failed',
        'Not checked in at ' || coalesce(v_name, 'your starred court'),
        case v_fail
          when 'court_gone' then 'That court isn''t in Pickleague anymore, so we couldn''t check you in.'
          when 'session' then 'You have a play session running, so we didn''t check you in here.'
          else 'Something went wrong on our side, so we couldn''t check you in. Open Pickleague to check in.'
        end,
        coalesce(v_venue, r.venue_id), v_name, null, null, true, now() + interval '30 minutes');
    end if;
  end loop;

  -- C.
  for r in
    select c.id, c.user_id, c.venue_id, c.expires_at
      from public.venue_checkins c
     where c.via_arrival and c.checked_out_at is null and c.taken_back_at is null
       and c.expires_at > now() and c.expires_at <= now() + interval '5 minutes'
       and c.expires_at = c.checked_in_at + interval '30 minutes'
  loop
    begin
      if public._pl_throttle_ok(r.user_id::text, 'arrival_extend', r.id::text, interval '100 years') then
        select v.name into v_name from public.venues v where v.id = r.venue_id;
        perform public._pl_court_arrival_push(
          r.user_id, 'arrival_extend',
          'Still at ' || coalesce(v_name, 'the courts') || '?',
          'Your check-in ends in 5 minutes. Tap Stay 1 more hour if you''re staying.',
          r.venue_id, v_name, r.id, r.expires_at, true, r.expires_at);
      end if;
    exception when others then
      raise warning 'Still at push for check-in % not queued: %', r.id, sqlerrm;
    end;
  end loop;
end $$;
revoke all on function public.process_court_arrivals() from public, anon, authenticated;


-- ── 7. Expiry: "👋 Checked out" for every manual and geofence check-in ─────
-- expire_venue_checkins: from migration_venue_checkins.sql (its only
-- definition; the presence files kept it). Same sweep (checked_out_at =
-- expires_at, */10), now plpgsql so it can tell the player (S7, row 68): once
-- per check-in it closes, manual or geofence, arrival or not, one stored
-- already over included (S7 says every one). Not for session check-ins (they
-- end with their session). Same signature, SECURITY DEFINER, search_path ''.
create or replace function public.expire_venue_checkins() returns void
language plpgsql security definer set search_path = '' as $$
declare
  r record;
begin
  for r in
    with closed as (
      update public.venue_checkins c set checked_out_at = c.expires_at
       where c.checked_out_at is null and c.expires_at <= now()
      returning c.id, c.user_id, c.venue_id, c.source, c.expires_at, c.via_arrival)
    select closed.id, closed.user_id, closed.venue_id, closed.expires_at, closed.via_arrival,
           v.name as venue_name
      from closed
      left join public.venues v on v.id = closed.venue_id
     where closed.source in ('manual', 'geofence')
  loop
    perform public._pl_court_arrival_push(
      r.user_id, 'arrival_expired',
      '👋 Checked out',
      format('Your visit to %s ended after your check-in window — tap to check back in if you''re still there.',
             coalesce(r.venue_name, 'a court')),
      r.venue_id, r.venue_name, r.id, r.expires_at, r.via_arrival, now() + interval '2 hours');
  end loop;
end $$;
revoke execute on function public.expire_venue_checkins() from public, anon, authenticated;
-- The pickleague-expire-venue-checkins job (*/10) keeps calling it by name.


-- ── 8. Account hygiene (row 76) ────────────────────────────────────────────

-- _purge_account: from migration_presence_p1_hygiene.sql (the last file that
-- defines it; migration_moderation_report_block.sql's is older). Plus the
-- pending arrivals, the throttle rows (scope = the account's id) and the
-- pushes written straight to the outbox (court names: the arrival and expiry
-- pushes have no notifications row to cascade from). search_path '' (live:
-- public): every name below is qualified, and the triggers these deletes fire
-- set their own.
create or replace function public._purge_account(p_uid uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_uid is null then
    raise exception 'No account given';
  end if;

  -- Waiting arrivals first: one the court arrival job has already taken
  -- (deleted, not yet committed) makes this wait for the job's commit, so the
  -- check-in it lands is there for the venue_checkins delete below, and its
  -- push for the push_outbox one (each statement sees what committed before
  -- it). Deleted last, that check-in would outlive the account.
  delete from public.pl_pending_arrivals           where user_id      = p_uid;

  delete from public.push_tokens                   where user_id      = p_uid;
  delete from public.notifications                 where user_id      = p_uid;
  delete from public.drill_request_messages        where sender_id    = p_uid;
  delete from public.drill_requests                where from_user_id = p_uid or to_user_id = p_uid;
  delete from public.drill_session_reviews         where user_id      = p_uid;
  delete from public.doubles_pair_join_requests    where user_id      = p_uid;
  delete from public.league_join_requests          where user_id      = p_uid;
  delete from public.mlp_team_join_requests        where user_id      = p_uid;
  delete from public.tournament_partner_requests   where requester_id = p_uid or requested_id = p_uid;
  delete from public.profile_claims                where profile_id   = p_uid;
  delete from public.venue_submission_affirmations where profile_id   = p_uid;
  delete from public.event_slot_votes              where user_id      = p_uid;
  delete from public.player_paddles                where user_id      = p_uid;
  delete from public.match_paddle_usage            where user_id      = p_uid;
  delete from public.player_shop_purchases         where user_id      = p_uid;
  delete from public.redemption_orders             where user_id      = p_uid;
  delete from public.ftue_grants                   where user_id      = p_uid;
  delete from public.league_members                where user_id      = p_uid;
  delete from public.user_blocks where blocker_id = p_uid or blocked_id = p_uid;

  -- Presence and friends (migration_presence_p1_*.sql).
  delete from public.venue_checkins       where user_id   = p_uid;
  delete from public.play_sessions        where user_id   = p_uid;
  delete from public.presence_settings    where user_id   = p_uid;
  delete from public.presence_hidden_from where user_id   = p_uid or hidden_user_id = p_uid;
  delete from public.close_friends        where user_id   = p_uid or friend_id      = p_uid;
  delete from public.friendships          where requester_id = p_uid or addressee_id = p_uid;
  delete from public.friend_request_log   where sender_id = p_uid or addressee_id   = p_uid;
  delete from public.court_favorites      where user_id   = p_uid;
  delete from public.presence_closed_ids  where user_id   = p_uid;
  delete from public.notifications
   where entity_type = 'friend' and entity_id = p_uid
     and push_data ->> 'kind' in ('friend_request', 'friend_accepted');

  -- Court arrivals (migration_court_arrival_queue.sql; the waiting ones went
  -- first, above).
  delete from public.pl_throttle          where scope        = p_uid::text;
  delete from public.push_outbox          where recipient_id = p_uid;

  update public.profiles set
    full_name             = '[deleted account]',
    username              = 'deleted_' || left(replace(p_uid::text, '-', ''), 12),
    avatar_url            = null,
    avatar_emoji          = null,
    avatar_bg_color       = null,
    profile_frame         = null,
    name_color            = null,
    list_name_style_id    = null,
    profile_name_style_id = null,
    tagline               = null,
    phone                 = null,
    dupr_id               = null,
    selected_tags         = '{}',
    availability          = '{}',
    drill_availability    = '{}'::jsonb,
    drill_shot_prefs      = '{}',
    drill_partner_prefs   = '{}',
    drill_custom_tags     = '{}',
    drilling_enabled      = false,
    badges_public         = false,
    pickles               = 0,
    is_unclaimed          = false,
    claim_source          = null,
    guest_expires_at      = null,
    deleted_at            = now()
  where id = p_uid;

  delete from auth.users where id = p_uid;
end;
$$;

comment on function public._purge_account(uuid) is
  'Internal. Anonymises a profile to a tombstone and deletes the auth user. '
  'Reached only through delete_my_account() (self) or moderator_eject_user().';

revoke all on function public._purge_account(uuid) from public, anon, authenticated;

-- prune_presence_history: from migration_presence_p1_hygiene.sql (its only
-- definition). Plus throttle rows older than 2 days: the longest window in
-- use is 30 minutes, and "Still at" (once per check-in) is long over by then.
-- The daily pickleague-presence-retention job keeps calling it by name.
create or replace function public.prune_presence_history() returns void
language sql security definer set search_path = '' as $$
  delete from public.venue_checkins
   where coalesce(checked_out_at, expires_at) < now() - interval '180 days';
  delete from public.friend_request_log
   where sent_at < now() - interval '30 days';
  delete from public.presence_closed_ids
   where created_at < now() - interval '2 days';
  delete from public.pl_throttle
   where last_at < now() - interval '2 days';
$$;
revoke execute on function public.prune_presence_history() from public, anon, authenticated;


-- ── 9. Schedule ────────────────────────────────────────────────────────────
-- Every 20 seconds, so a check-in lands 60 to 80 seconds after the arrival.
-- Sub-minute schedules need pg_cron 1.5 or later; older ones run every
-- minute (up to 60 s later). Unscheduled first, so a re-run replaces it.
do $$
declare
  v_ver   text;
  v_m     text[];
  v_every text := '* * * * *';
begin
  select e.extversion into v_ver from pg_extension e where e.extname = 'pg_cron';
  v_m := regexp_match(coalesce(v_ver, ''), '^(\d+)\.(\d+)');
  if v_m is not null and (v_m[1]::int, v_m[2]::int) >= (1, 5) then
    v_every := '20 seconds';
  end if;
  if exists (select 1 from cron.job where jobname = 'pickleague-process-court-arrivals') then
    perform cron.unschedule('pickleague-process-court-arrivals');
  end if;
  perform cron.schedule('pickleague-process-court-arrivals', v_every,
    $c$ select public.process_court_arrivals(); $c$);
  raise notice 'pickleague-process-court-arrivals: pg_cron %, schedule %', coalesce(v_ver, 'unknown'), v_every;
end $$;


-- ── 10. After a re-run of migration_validity_rules.sql ─────────────────────
-- That file's one-time backfill stamps an arrival fix on every confirmed
-- check-in without one, so on every arrival check-in with no fix, and its
-- older insert trigger (live until this file is re-applied) stamps now() on
-- one the job lands in between. Its session backfill then re-judges every
-- ended session with its older at_court, which counts them. Each run of this
-- file therefore:
--   1. clears an arrival check-in's arrival fix that no real fix gave. A real
--      one is the first fix stored on the row (so fix_at is never null beside
--      it: _pl_checkin_stay_from_fix) or its check-out fix (the very time in
--      checkout_fix_at: _pl_record_checkout_fix, once per row, when it closes
--      it). A confirmed check-out fix taken during the check-in becomes the
--      arrival fix, as _pl_record_checkout_fix would have made it;
--   2. re-judges the ended sessions an arrival check-in overlapped
--      (_pl_refresh_session_validity writes only a verdict that changed).
-- The first time there are no arrival check-ins, so it changes nothing.
create or replace function public._pl_court_arrival_rerun_repair()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fixes    int;
  v_sessions int := 0;
  v_id       uuid;
begin
  update public.venue_checkins c
     set arrival_fix_at = case when c.checkout_fix_lat is not null
                                    and c.checkout_fix_at between c.checked_in_at and c.expires_at
                               then c.checkout_fix_at end
   where c.via_arrival and c.fix_at is null and c.arrival_fix_at is not null
     and c.arrival_fix_at is distinct from c.checkout_fix_at;
  get diagnostics v_fixes = row_count;

  for v_id in
    select distinct s.id
      from public.play_sessions s
      join public.venue_checkins c on c.user_id = s.user_id and c.via_arrival
     where s.ended_at is not null
       and c.checked_in_at < s.ended_at
       and coalesce(c.checked_out_at, c.expires_at) > s.started_at
  loop
    perform public._pl_refresh_session_validity(v_id);
    v_sessions := v_sessions + 1;
  end loop;
  raise notice 'court arrival re-run repair: % arrival fix(es) cleared, % session(s) re-judged', v_fixes, v_sessions;
end $$;
revoke all on function public._pl_court_arrival_rerun_repair() from public, anon, authenticated;

do $$ begin perform public._pl_court_arrival_rerun_repair(); end $$;

notify pgrst, 'reload schema';
