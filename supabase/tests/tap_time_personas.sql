-- ============================================================
-- Offline check-in time (P1) and league joins from old builds (P2)
-- (supabase/migration_checkin_tap_time.sql; docs/play-sessions-presence.md,
-- the user's decisions of 2026-10-16).
--
-- NOT runnable on its own: build-presence-test.mjs splices it into
-- presence_p1_personas.sql at -- @@TAPTIME@@, after the Phase 1, Phase 1.5
-- and refusal sections and before the results, reusing their harness (_p,
-- _results, pg_temp.p / ok / as_user / as_admin, validity / vrow / vci,
-- err / reads_nothing_to_answer, _rf_msgs) inside the same rolled-back
-- transaction. now() is fixed for the whole transaction, so times compare
-- exactly.
--
-- P1 (a check-in's fix is judged at the tap, up to 12 hours back):
--   (a) a phone whose clock is off by 10 minutes is never refused live;
--   (b) an offline replay with its tap-time fix counts: open when it is still
--       running, stored already over when it isn't (and said so by the app);
--   (c) a fix more than 2 minutes before or after the tap is refused;
--   (d) a backdated tap with a fix from now is refused (every call shape);
--   plus the 12-hour limit, Start at a court replayed (open, already over,
--   too old, backdated), the lock-screen check-in, a replay that never
--   overrides a newer check-in, and 1.0.4's call shapes on this server.
-- P2 (UPDATE (league_id, user_id) granted for old bundles' merge upsert):
--   the old-style join of an open league works; closed leagues, joining as
--   admin and joining someone else stay refused; every way of moving a
--   membership or raising a role stays closed; a real move says why.
--
-- Personas (court test:tt-court at 40.4 N, 100.0 W, a fix 11 m north is
-- 40.4001; test:tt-court2 at 40.41, fix 40.4101):
--   TA live, phone clock off · TB a 40-minute replay · TN the same from a
--   phone 10 min fast · TC a replay already over, then its check-out · TQ the
--   expiry job · TD refusals · TE / TW a replay behind a newer check-in (other
--   court / same court) · TF a replay at a court open since before its tap ·
--   TG no fix (1.0.4 embedded) · TH a 40-minute Start replay · TI a Start
--   replay already over, then its End · TJ a Start backdated, too old · TY a
--   late Start behind a newer check-in · TS a live Start, phone slow · TK the
--   lock-screen check-in · TL the runtime-1.0.4 OTA's calls · TM 1.0.4
--   embedded calls · TX extending a check-in stored already over · TV viewer
--   P2: LA league admin (TT Open, TT Closed) · LC co-admin · LM member ·
--   LJ joins with an old bundle · LO runs another open league
-- ============================================================

insert into _p values
  ('TA', 'a3000000-0000-4000-8000-000000000001'), ('TB', 'a3000000-0000-4000-8000-000000000002'),
  ('TN', 'a3000000-0000-4000-8000-000000000003'), ('TC', 'a3000000-0000-4000-8000-000000000004'),
  ('TQ', 'a3000000-0000-4000-8000-000000000005'), ('TD', 'a3000000-0000-4000-8000-000000000006'),
  ('TE', 'a3000000-0000-4000-8000-000000000007'), ('TW', 'a3000000-0000-4000-8000-000000000008'),
  ('TF', 'a3000000-0000-4000-8000-000000000009'), ('TG', 'a3000000-0000-4000-8000-00000000000a'),
  ('TH', 'a3000000-0000-4000-8000-00000000000b'), ('TI', 'a3000000-0000-4000-8000-00000000000c'),
  ('TJ', 'a3000000-0000-4000-8000-00000000000d'), ('TY', 'a3000000-0000-4000-8000-00000000000e'),
  ('TS', 'a3000000-0000-4000-8000-00000000000f'), ('TK', 'a3000000-0000-4000-8000-000000000010'),
  ('TL', 'a3000000-0000-4000-8000-000000000011'), ('TM', 'a3000000-0000-4000-8000-000000000012'),
  ('TX', 'a3000000-0000-4000-8000-000000000013'), ('TV', 'a3000000-0000-4000-8000-000000000014'),
  ('LA', 'a3000000-0000-4000-8000-000000000021'), ('LC', 'a3000000-0000-4000-8000-000000000022'),
  ('LM', 'a3000000-0000-4000-8000-000000000023'), ('LJ', 'a3000000-0000-4000-8000-000000000024'),
  ('LO', 'a3000000-0000-4000-8000-000000000025');

insert into auth.users (id, email, raw_user_meta_data)
select id, 'tt-' || lower(k) || '@pickleague.test', jsonb_build_object('full_name', 'TT Player ' || k)
  from _p where id::text like 'a3000000-%';

insert into public.venues (id, sport, name, kind, lat, lng, source, geofence_radius_m) values
  ('test:tt-court',  array['pickleball'], 'TT Test Courts',     'court', 40.4,  -100.0, 'google', 100),
  ('test:tt-court2', array['pickleball'], 'TT Test Courts Two', 'court', 40.41, -100.0, 'google', 100);

-- TT League (open) for the match that makes TI's session count; the P2 leagues.
insert into public.leagues (id, name, is_open, created_by) values
  ('b3000000-0000-4000-8000-000000000001', 'TT Open',       true,  pg_temp.p('LA')),
  ('b3000000-0000-4000-8000-000000000002', 'TT Closed',     false, pg_temp.p('LA')),
  ('b3000000-0000-4000-8000-000000000003', 'TT Other Open', true,  pg_temp.p('LO')),
  ('b3000000-0000-4000-8000-000000000004', 'TT League',     true,  pg_temp.p('TI'));
insert into public.league_members (league_id, user_id, role) values
  ('b3000000-0000-4000-8000-000000000001', pg_temp.p('LA'), 'admin'),
  ('b3000000-0000-4000-8000-000000000001', pg_temp.p('LC'), 'co-admin'),
  ('b3000000-0000-4000-8000-000000000001', pg_temp.p('LM'), 'member'),
  ('b3000000-0000-4000-8000-000000000002', pg_temp.p('LA'), 'admin'),
  ('b3000000-0000-4000-8000-000000000003', pg_temp.p('LO'), 'admin'),
  ('b3000000-0000-4000-8000-000000000004', pg_temp.p('TI'), 'admin'),
  ('b3000000-0000-4000-8000-000000000004', pg_temp.p('TV'), 'member')
on conflict do nothing;

-- A check-in as the app sends it, live or replayed: the tap `p_tap_ago` ago,
-- the fix `p_fix_before` before the tap, both stamped on a phone clock that is
-- `p_skew` off, and the fix's age at send measured on that same clock (so the
-- skew never reaches it). Leaves the role as k.
create function pg_temp.tt_ci(k text, p_id uuid, p_venue text, p_lat double precision, p_tap_ago interval,
                              p_fix_before interval default interval '5 seconds', p_minutes int default 120,
                              p_source text default 'manual', p_skew interval default interval '0')
returns public.venue_checkins language plpgsql as $$
declare r public.venue_checkins;
begin
  perform pg_temp.as_user(pg_temp.p(k));
  select * into r from public.checkin_venue(p_id => p_id, p_venue => p_venue, p_minutes => p_minutes,
    p_source => p_source, p_at => now() - p_tap_ago + p_skew,
    p_lat => p_lat, p_lng => -100.0, p_accuracy_m => 10,
    p_fix_at => now() - p_tap_ago - p_fix_before + p_skew,
    p_fix_age_ms => extract(epoch from (p_tap_ago + p_fix_before)) * 1000);
  return r;
end $$;

-- A Start at a court as the app sends it (same clocks as tt_ci). Leaves the role as k.
create function pg_temp.tt_start(k text, p_id uuid, p_venue text, p_lat double precision, p_tap_ago interval,
                                 p_fix_before interval default interval '5 seconds', p_skew interval default interval '0')
returns public.play_sessions language plpgsql as $$
declare s public.play_sessions;
begin
  perform pg_temp.as_user(pg_temp.p(k));
  select * into s from public.start_play_session(p_id => p_id, p_kind => 'open_play', p_source => null,
    p_venue => p_venue, p_at => now() - p_tap_ago + p_skew,
    p_lat => p_lat, p_lng => -100.0, p_accuracy_m => 10,
    p_fix_at => now() - p_tap_ago - p_fix_before + p_skew,
    p_fix_age_ms => extract(epoch from (p_tap_ago + p_fix_before)) * 1000);
  return s;
end $$;

-- How many rows `viewer` gets at a court (court_presence), and the crowd count.
create function pg_temp.tt_rows(viewer text, p_venue text) returns int language plpgsql as $$
declare v int;
begin
  perform pg_temp.as_user(pg_temp.p(viewer));
  select count(*) into v from public.court_presence(p_venue);
  return v;
end $$;
create function pg_temp.tt_crowd(viewer text, p_venue text) returns int language plpgsql as $$
declare v int;
begin
  perform pg_temp.as_user(pg_temp.p(viewer));
  select c.here_now into v from public.venue_crowd(array[p_venue]) c;
  return coalesce(v, 0);
end $$;

-- Run p_sql as the current role: 'ok:<rows>' or 'err:<sqlstate>:<hint>:<message>'.
create function pg_temp.tt_try(p_sql text) returns text language plpgsql as $$
declare
  n  int;
  st text;
  h  text;
  m  text;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return 'ok:' || n;
exception when others then
  get stacked diagnostics st = returned_sqlstate, h = pg_exception_hint, m = message_text;
  return 'err:' || st || ':' || coalesce(h, '') || ':' || m;
end $$;


-- ════ T30 the tap rule (_pl_tap_fix) ════════════════════════════════════
do $$
declare t record;
begin
  perform pg_temp.as_admin();
  perform pg_temp.ok('T30 _pl_tap_fix is internal: closed to clients, not SECURITY DEFINER',
    not has_function_privilege('authenticated', 'public._pl_tap_fix(timestamptz,timestamptz,double precision)', 'execute')
    and not has_function_privilege('anon', 'public._pl_tap_fix(timestamptz,timestamptz,double precision)', 'execute')
    and not (select prosecdef from pg_proc where oid = 'public._pl_tap_fix(timestamptz,timestamptz,double precision)'::regprocedure)
    and (select array_to_string(proconfig, ',') from pg_proc
          where oid = 'public._pl_tap_fix(timestamptz,timestamptz,double precision)'::regprocedure) = 'search_path=""');

  -- (a) live calls: the fix 3 s before the tap, sent at once (age 3 s), on a
  -- phone clock 10 minutes fast, then 10 minutes slow.
  select * into t from public._pl_tap_fix(now() + interval '10 minutes', now() + interval '10 minutes' - interval '3 seconds', 3000);
  perform pg_temp.ok('T30 (a) live, phone 10 min fast: ok, the tap is now, the fix 3 s ago (server clock)',
    t.verdict = 'ok' and t.tap_at = now() and t.fix_at = now() - interval '3 seconds', t::text);
  select * into t from public._pl_tap_fix(now() - interval '10 minutes', now() - interval '10 minutes' - interval '3 seconds', 3000);
  perform pg_temp.ok('T30 (a) live, phone 10 min slow: ok, the tap is now, the fix 3 s ago',
    t.verdict = 'ok' and t.tap_at = now() and t.fix_at = now() - interval '3 seconds', t::text);
  select * into t from public._pl_tap_fix(null, now(), 1000);
  perform pg_temp.ok('T30 no tap sent (extend): the tap is the send, a 1 s-old fix is ok',
    t.verdict = 'ok' and t.tap_at = now() and t.fix_at = now() - interval '1 second', t::text);
  select * into t from public._pl_tap_fix(null, now(), 180000);
  perform pg_temp.ok('T30 no tap sent: a fix 3 min old at send is stale', t.verdict = 'stale', t::text);

  -- (b) replays: the tap-time fix, sent later.
  select * into t from public._pl_tap_fix(now() - interval '40 minutes', now() - interval '40 minutes 5 seconds', 2405000);
  perform pg_temp.ok('T30 (b) a 40-minute replay with its tap-time fix: ok, dated at the tap',
    t.verdict = 'ok' and t.tap_at = now() - interval '40 minutes' and t.fix_at = now() - interval '40 minutes 5 seconds', t::text);
  select * into t from public._pl_tap_fix(now() - interval '30 minutes', now() - interval '30 minutes 5 seconds', 2405000);
  perform pg_temp.ok('T30 (b) the same replay from a phone 10 min fast: the true tap',
    t.verdict = 'ok' and t.tap_at = now() - interval '40 minutes', t::text);
  select * into t from public._pl_tap_fix(now() - interval '10 minutes', now() - interval '9 minutes', 540000);
  perform pg_temp.ok('T30 a fix 1 min after the tap is within 2 minutes: ok',
    t.verdict = 'ok' and t.tap_at = now() - interval '10 minutes', t::text);
  select * into t from public._pl_tap_fix(now() - interval '11 hours 50 minutes', now() - interval '11 hours 50 minutes 5 seconds', 42605000);
  perform pg_temp.ok('T30 a tap 11 h 50 min ago is inside the 12 hours', t.verdict = 'ok', t::text);

  -- (c) the fix more than 2 minutes from the tap.
  select * into t from public._pl_tap_fix(now() - interval '10 minutes', now() - interval '13 minutes', 780000);
  perform pg_temp.ok('T30 (c) a fix 3 min before the tap: stale', t.verdict = 'stale', t::text);
  select * into t from public._pl_tap_fix(now() - interval '10 minutes', now() - interval '7 minutes', 420000);
  perform pg_temp.ok('T30 (c) a fix 3 min after the tap: after_tap', t.verdict = 'after_tap', t::text);

  -- (d) a backdated tap with a fix from now, with and without an age.
  select * into t from public._pl_tap_fix(now() - interval '3 hours', now(), 0);
  perform pg_temp.ok('T30 (d) a tap 3 h back with a fix from now: after_tap', t.verdict = 'after_tap', t::text);
  select * into t from public._pl_tap_fix(now() - interval '3 hours', now(), null);
  perform pg_temp.ok('T30 (d) ...the same with no age (the legacy shape): after_tap', t.verdict = 'after_tap', t::text);

  -- The 12-hour limit; no age.
  select * into t from public._pl_tap_fix(now() - interval '13 hours', now() - interval '13 hours 5 seconds', 46805000);
  perform pg_temp.ok('T30 a tap 13 h ago: too_old', t.verdict = 'too_old' and t.tap_at = now() - interval '13 hours', t::text);
  select * into t from public._pl_tap_fix(now(), now() - interval '1 minute', null);
  perform pg_temp.ok('T30 no age, a fresh fix a minute before the tap: ok, dated now', t.verdict = 'ok' and t.tap_at = now(), t::text);
  select * into t from public._pl_tap_fix(null, now() - interval '3 minutes', null);
  perform pg_temp.ok('T30 no age, a fix 3 min old by the server clock: stale_clock', t.verdict = 'stale_clock', t::text);

  -- Crafted values (PostgREST casts the strings) are judged, never a raw
  -- interval or timestamp overflow.
  select * into t from public._pl_tap_fix(now(), now() - interval '5 seconds', 'NaN'::double precision);
  perform pg_temp.ok('T30 a NaN age: judged (too old), no error', t.verdict = 'too_old', t::text);
  select * into t from public._pl_tap_fix(now(), now() - interval '5 seconds', 'Infinity'::double precision);
  perform pg_temp.ok('T30 an infinite age: judged (too old), no error', t.verdict = 'too_old', t::text);
  select * into t from public._pl_tap_fix('infinity'::timestamptz, now(), 1000);
  perform pg_temp.ok('T30 an infinite tap counts as no tap: dated now, never backdated',
    t.verdict = 'ok' and t.tap_at = now(), t::text);
  select * into t from public._pl_tap_fix('0001-01-01 00:00:00+00'::timestamptz, now(), 0);
  perform pg_temp.ok('T30 a tap in year 1 with a fix from now: after_tap, no overflow', t.verdict = 'after_tap', t::text);
  select * into t from public._pl_tap_fix(now(), '-infinity'::timestamptz, null);
  perform pg_temp.ok('T30 an infinite fix time with no age: stale_clock', t.verdict = 'stale_clock', t::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T30 block crashed', false, sqlerrm);
end $$;


-- ════ T31 check-ins judged at the tap ════════════════════════════════════
do $$
declare
  r public.venue_checkins;
  n int;
begin
  -- (a) live from a phone 10 min fast, then 10 min slow: confirmed, at the
  -- true time (before: a slow phone was backdated by its offset).
  r := pg_temp.tt_ci('TA', 'c3000000-0000-4000-8000-000000000001', 'test:tt-court', 40.4001, interval '0',
                     interval '3 seconds', 120, 'manual', interval '10 minutes');
  perform pg_temp.ok('T31 (a) live check-in from a phone 10 min fast: confirmed, checked in now, fix 3 s ago',
    r.location_confirmed and r.checked_in_at = now() and r.expires_at = now() + interval '120 minutes'
    and r.fix_at = now() - interval '3 seconds' and r.arrival_fix_at = now() - interval '3 seconds', r::text);
  perform public.checkout_venue(null, null, now());
  r := pg_temp.tt_ci('TA', 'c3000000-0000-4000-8000-000000000002', 'test:tt-court', 40.4001, interval '0',
                     interval '3 seconds', 120, 'manual', - interval '10 minutes');
  perform pg_temp.ok('T31 (a) live check-in from a phone 10 min slow: confirmed, checked in now (not 10 min back)',
    r.location_confirmed and r.checked_in_at = now() and r.fix_at = now() - interval '3 seconds', r::text);
  perform public.checkout_venue(null, null, now());

  -- (b) a check-in saved with no signal 40 minutes ago, synced now: open.
  r := pg_temp.tt_ci('TB', 'c3000000-0000-4000-8000-000000000003', 'test:tt-court', 40.4001, interval '40 minutes');
  perform pg_temp.ok('T31 (b) a 40-minute replay is stored open from the tap, its arrival fix dated by its age',
    r.location_confirmed and r.checked_out_at is null
    and r.checked_in_at = now() - interval '40 minutes' and r.expires_at = now() + interval '80 minutes'
    and r.fix_at = now() - interval '40 minutes 5 seconds' and r.arrival_fix_at = now() - interval '40 minutes 5 seconds'
    and r.expires_at > r.created_at, r::text);
  perform pg_temp.ok('T31 (b) ...and shown at the court (one row, one in the crowd)',
    pg_temp.tt_rows('TV', 'test:tt-court') = 1 and pg_temp.tt_crowd('TV', 'test:tt-court') = 1);
  perform pg_temp.as_user(pg_temp.p('TB'));
  perform public.checkout_venue(null, null, now());
  r := pg_temp.tt_ci('TN', 'c3000000-0000-4000-8000-000000000004', 'test:tt-court', 40.4001, interval '40 minutes',
                     interval '5 seconds', 120, 'manual', interval '10 minutes');
  perform pg_temp.ok('T31 (b) the same replay from a phone 10 min fast is dated at the true tap',
    r.location_confirmed and r.checked_in_at = now() - interval '40 minutes', r::text);
  perform public.checkout_venue(null, null, now());

  -- (b) tapped 3 hours ago for 120 minutes, synced now: stored, already over.
  r := pg_temp.tt_ci('TC', 'c3000000-0000-4000-8000-000000000005', 'test:tt-court2', 40.4101, interval '3 hours');
  perform pg_temp.ok('T31 (b) a replay that synced after it would have ended is stored, already over',
    r.location_confirmed and r.checked_in_at = now() - interval '3 hours' and r.expires_at = now() - interval '1 hour'
    and r.checked_out_at is null and r.expires_at <= r.created_at, r::text);
  perform pg_temp.ok('T31 (b) ...shown to nobody and counted in no crowd',
    pg_temp.tt_rows('TV', 'test:tt-court2') = 0 and pg_temp.tt_crowd('TV', 'test:tt-court2') = 0
    and pg_temp.tt_rows('TC', 'test:tt-court2') = 0);
  -- Its check-out, queued at tap + 30 min with the fix taken then (aged 2.5 h).
  perform pg_temp.as_user(pg_temp.p('TC'));
  select public.checkout_venue(p_id => 'c3000000-0000-4000-8000-000000000005', p_source => null,
    p_at => now() - interval '150 minutes', p_lat => 40.4101, p_lng => -100.0, p_accuracy_m => 10,
    p_fix_age_ms => 9000000) into n;
  r := pg_temp.vci('c3000000-0000-4000-8000-000000000005');
  perform pg_temp.ok('T31 (b) ...its queued check-out records when I left, and the stay (30 min apart at the court)',
    n = 1 and r.checked_out_at = now() - interval '150 minutes' and r.stay_confirmed
    and r.checkout_fix_at = now() - interval '150 minutes', r::text);

  -- The expiry job closes a stored-over check-in at its own end.
  r := pg_temp.tt_ci('TQ', 'c3000000-0000-4000-8000-000000000006', 'test:tt-court2', 40.4101, interval '2 hours',
                     interval '5 seconds', 60);
  perform pg_temp.as_admin();
  perform public.expire_venue_checkins();
  r := pg_temp.vci('c3000000-0000-4000-8000-000000000006');
  perform pg_temp.ok('T31 (b) expire_venue_checkins closes a stored-over check-in at its expiry',
    r.checked_out_at = now() - interval '1 hour' and r.expires_at = now() - interval '1 hour', r::text);
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T31 block crashed', false, sqlerrm);
end $$;


-- ════ T32 refusals: the fix away from the tap, the 12-hour limit ═════════
do $$
declare
  e     jsonb;
  td    uuid := pg_temp.p('TD');
  label text;
begin
  -- The tap time as the server words it for TD (their zone; the helpers are
  -- closed to clients, so read it as the server).
  perform pg_temp.as_admin();
  label := public._pickleague_local_label(now() - interval '13 hours', public._pickleague_tz_for(td));
  perform pg_temp.as_user(td);
  -- (c) a fix 3 min before the tap.
  e := pg_temp.err($q$select public.checkin_venue(p_id => 'c3000000-0000-4000-8000-000000000101', p_venue => 'test:tt-court',
    p_at => now() - interval '10 minutes', p_lat => 40.4001, p_lng => -100.0, p_accuracy_m => 10,
    p_fix_at => now() - interval '13 minutes', p_fix_age_ms => 780000)$q$);
  perform pg_temp.ok('T32 (c) a fix 3 min before the tap: why and what to do (pl:fix.stale)',
    e ->> 'state' = 'P0001' and e ->> 'hint' = 'pl:fix.stale'
    and e ->> 'msg' = 'Your location is out of date: it was taken more than 2 minutes before you tapped. Try again at the court.', e::text);
  perform pg_temp.ok('T32 ...keeps the words 1.0.4 reads ("location is out of date", "2 minutes")',
    e ->> 'msg' ~* 'location is out of date' and e ->> 'msg' ~ '2 minutes' and not pg_temp.reads_nothing_to_answer(e ->> 'msg'), e ->> 'msg');
  -- (c) a fix 3 min after the tap.
  e := pg_temp.err($q$select public.checkin_venue(p_id => 'c3000000-0000-4000-8000-000000000101', p_venue => 'test:tt-court',
    p_at => now() - interval '10 minutes', p_lat => 40.4001, p_lng => -100.0, p_accuracy_m => 10,
    p_fix_at => now() - interval '7 minutes', p_fix_age_ms => 420000)$q$);
  perform pg_temp.ok('T32 (c) a fix 3 min after the tap: why and what to do (pl:fix.after_tap)',
    e ->> 'state' = 'P0001' and e ->> 'hint' = 'pl:fix.after_tap'
    and e ->> 'msg' = 'Your location was taken more than 2 minutes after you tapped Check in, so it can''t show you were at the court then. Check in again when you''re at the court.'
    and not pg_temp.reads_nothing_to_answer(e ->> 'msg'), e::text);
  -- (d) a tap 3 hours back with a fix from now, with an age and without one.
  e := pg_temp.err($q$select public.checkin_venue(p_id => 'c3000000-0000-4000-8000-000000000101', p_venue => 'test:tt-court',
    p_at => now() - interval '3 hours', p_lat => 40.4001, p_lng => -100.0, p_accuracy_m => 10,
    p_fix_at => now(), p_fix_age_ms => 0)$q$);
  perform pg_temp.ok('T32 (d) a backdated tap with a fix from now is refused (pl:fix.after_tap)',
    e ->> 'hint' = 'pl:fix.after_tap', e::text);
  e := pg_temp.err($q$select public.checkin_venue(p_id => 'c3000000-0000-4000-8000-000000000101', p_venue => 'test:tt-court',
    p_at => now() - interval '3 hours', p_lat => 40.4001, p_lng => -100.0, p_accuracy_m => 10, p_fix_at => now())$q$);
  perform pg_temp.ok('T32 (d) ...also with no age (the legacy shape)', e ->> 'hint' = 'pl:fix.after_tap', e::text);
  -- Tapped 13 hours ago.
  e := pg_temp.err($q$select public.checkin_venue(p_id => 'c3000000-0000-4000-8000-000000000101', p_venue => 'test:tt-court',
    p_at => now() - interval '13 hours', p_lat => 40.4001, p_lng => -100.0, p_accuracy_m => 10,
    p_fix_at => now() - interval '13 hours 5 seconds', p_fix_age_ms => 46805000)$q$);
  perform pg_temp.ok('T32 a check-in synced 13 h after its tap: when it was saved, why, what to do (pl:checkin.too_old)',
    e ->> 'state' = 'P0001' and e ->> 'hint' = 'pl:checkin.too_old'
    and e ->> 'msg' = format('This check-in was saved with no signal at %s and reached Pickleague more than 12 hours later, too late to count. Check in again when you''re at the court.',
                             label)
    and (e ->> 'detail')::jsonb ? 'tapped_at' and ((e ->> 'detail')::jsonb ->> 'limit_hours')::int = 12
    and ((e ->> 'detail')::jsonb ->> 'tapped_at')::timestamptz = now() - interval '13 hours'
    and not pg_temp.reads_nothing_to_answer(e ->> 'msg'), e::text);
  -- The time is the player's: a player in another zone gets it in theirs.
  perform pg_temp.as_admin();
  insert into public.pickleague_time_zones (profile_id, tz) values (td, 'Asia/Tokyo')
  on conflict (profile_id) do update set tz = excluded.tz;
  label := public._pickleague_local_label(now() - interval '13 hours', 'Asia/Tokyo');
  perform pg_temp.as_user(td);
  e := pg_temp.err($q$select public.checkin_venue(p_id => 'c3000000-0000-4000-8000-000000000101', p_venue => 'test:tt-court',
    p_at => now() - interval '13 hours', p_lat => 40.4001, p_lng => -100.0, p_accuracy_m => 10,
    p_fix_at => now() - interval '13 hours 5 seconds', p_fix_age_ms => 46805000)$q$);
  perform pg_temp.ok('T32 ...in the player''s own zone',
    e ->> 'msg' like '%saved with no signal at ' || label || ' and%', e::text);
  perform pg_temp.as_admin();
  perform pg_temp.ok('T32 refused check-ins store nothing',
    not exists (select 1 from public.venue_checkins where user_id = td));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T32 block crashed', false, sqlerrm);
end $$;


-- ════ T33 a replay never overrides a newer check-in; no fix as before ════
do $$
declare
  r  public.venue_checkins;
  b  public.venue_checkins;
  n  int;
  e  jsonb;
begin
  -- A live check-in at court Two lands first, then a check-in queued 30 min
  -- ago at court One: the replay ends where the live one starts.
  b := pg_temp.tt_ci('TE', 'c3000000-0000-4000-8000-000000000201', 'test:tt-court2', 40.4101, interval '0', interval '2 seconds');
  r := pg_temp.tt_ci('TE', 'c3000000-0000-4000-8000-000000000202', 'test:tt-court', 40.4001, interval '30 minutes');
  perform pg_temp.ok('T33 a replay behind a newer check-in ends where that one starts (stored, over)',
    r.checked_in_at = now() - interval '30 minutes' and r.expires_at = b.checked_in_at and r.expires_at = now()
    and r.location_confirmed and r.checked_out_at is null, r::text);
  b := pg_temp.vci('c3000000-0000-4000-8000-000000000201');
  perform pg_temp.ok('T33 ...and the newer check-in stays open, the only one shown',
    b.checked_out_at is null and b.expires_at = now() + interval '120 minutes'
    and pg_temp.tt_rows('TE', 'test:tt-court2') = 1 and pg_temp.tt_rows('TE', 'test:tt-court') = 0, b::text);
  perform pg_temp.as_user(pg_temp.p('TE'));
  perform public.checkout_venue(null, null, now());

  -- The same at one court: the replay is not merged into the newer row.
  b := pg_temp.tt_ci('TW', 'c3000000-0000-4000-8000-000000000203', 'test:tt-court', 40.4001, interval '0', interval '2 seconds');
  r := pg_temp.tt_ci('TW', 'c3000000-0000-4000-8000-000000000204', 'test:tt-court', 40.4001, interval '30 minutes');
  b := pg_temp.vci('c3000000-0000-4000-8000-000000000203');
  perform pg_temp.ok('T33 at the same court: the replay is its own row up to the newer one, which keeps its fix',
    r.id = 'c3000000-0000-4000-8000-000000000204' and r.expires_at = now()
    and b.checked_out_at is null and b.fix_at = now() - interval '2 seconds', r::text || ' ' || b::text);
  perform pg_temp.as_user(pg_temp.p('TW'));
  perform public.checkout_venue(null, null, now());

  -- A replay at a court where I have been checked in since before its tap:
  -- quiet (the same row), and an older fix never replaces a newer one.
  b := pg_temp.tt_ci('TF', 'c3000000-0000-4000-8000-000000000205', 'test:tt-court', 40.4001, interval '60 minutes');
  r := pg_temp.tt_ci('TF', 'c3000000-0000-4000-8000-000000000206', 'test:tt-court', 40.4001, interval '30 minutes');
  perform pg_temp.ok('T33 a replay at a court open since before its tap returns that row, extended; its later fix proves the stay',
    r.id = 'c3000000-0000-4000-8000-000000000205' and r.expires_at = now() + interval '90 minutes'
    and r.fix_at = now() - interval '30 minutes 5 seconds' and r.stay_confirmed, r::text);
  r := pg_temp.tt_ci('TF', 'c3000000-0000-4000-8000-000000000207', 'test:tt-court', 40.4001, interval '45 minutes');
  perform pg_temp.ok('T33 ...a replay with an older fix leaves the newer fix and the end alone',
    r.id = 'c3000000-0000-4000-8000-000000000205' and r.fix_at = now() - interval '30 minutes 5 seconds'
    and r.expires_at = now() + interval '90 minutes', r::text);
  perform pg_temp.as_user(pg_temp.p('TF'));
  select count(*) into n from public.venue_checkins where user_id = pg_temp.p('TF');
  perform pg_temp.ok('T33 ...and adds no row', n = 1, n::text);
  perform public.checkout_venue(null, null, now());

  -- No fix (1.0.4 embedded bundles): a private row, the 6-hour clamp, as before.
  perform pg_temp.as_user(pg_temp.p('TG'));
  select * into r from public.checkin_venue(p_id => 'c3000000-0000-4000-8000-000000000208', p_venue => 'test:tt-court',
    p_minutes => 240, p_source => 'manual', p_at => now() - interval '3 hours');
  perform pg_temp.ok('T33 no fix, tapped 3 h ago: a private row from the tap, as before',
    not r.location_confirmed and r.checked_in_at = now() - interval '3 hours' and r.expires_at = now() + interval '1 hour', r::text);
  select * into r from public.checkin_venue(p_id => 'c3000000-0000-4000-8000-000000000209', p_venue => 'test:tt-court2',
    p_minutes => 120, p_source => 'manual', p_at => now() - interval '8 hours');
  perform pg_temp.ok('T33 no fix, tapped 8 h ago: clamped to 6 h back, as before',
    not r.location_confirmed and r.checked_in_at = now() - interval '6 hours', r::text);
  perform public.checkout_venue(null, null, now());
  select * into r from public.checkin_venue(p_id => 'c3000000-0000-4000-8000-00000000020b', p_venue => 'test:tt-court',
    p_minutes => 60, p_source => 'manual', p_at => now() - interval '3 hours');
  select * into r from public.extend_checkin(p_id => 'c3000000-0000-4000-8000-00000000020b', p_until => now() + interval '1 hour');
  perform pg_temp.ok('T33 no fix: a private row stored already over still extends as before (1.0.4 sees no change)',
    not r.location_confirmed and r.expires_at = now() + interval '1 hour', r::text);
  perform public.checkout_venue(null, null, now());

  -- A check-in stored already over can't be extended back to life before the
  -- expiry job closes it (with or without a fix).
  r := pg_temp.tt_ci('TX', 'c3000000-0000-4000-8000-00000000020a', 'test:tt-court', 40.4001, interval '3 hours');
  perform pg_temp.as_user(pg_temp.p('TX'));
  e := pg_temp.err($q$select public.extend_checkin('c3000000-0000-4000-8000-00000000020a', now() + interval '1 hour')$q$);
  perform pg_temp.ok('T33 extending a check-in stored already over: it ended, when, what to do (pl:checkin.closed)',
    e ->> 'state' = 'P0001' and e ->> 'hint' = 'pl:checkin.closed'
    and e ->> 'msg' like 'Your check-in at TT Test Courts already ended (%). Check in again when you''re at the court.'
    and ((e ->> 'detail')::jsonb ->> 'ended_at')::timestamptz = now() - interval '1 hour', e::text);
  e := pg_temp.err($q$select public.extend_checkin(p_id => 'c3000000-0000-4000-8000-00000000020a', p_until => now() + interval '1 hour',
    p_lat => 40.4001, p_lng => -100.0, p_accuracy_m => 10, p_fix_at => now(), p_fix_age_ms => 0)$q$);
  perform pg_temp.ok('T33 ...also with a confirming fix (check in again instead)', e ->> 'hint' = 'pl:checkin.closed', e::text);
  r := pg_temp.vci('c3000000-0000-4000-8000-00000000020a');
  perform pg_temp.ok('T33 ...and it stays as stored', r.expires_at = now() - interval '1 hour' and r.checked_out_at is null, r::text);
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T33 block crashed', false, sqlerrm);
end $$;


-- ════ T34 Start at a court, replayed ═════════════════════════════════════
do $$
declare
  s  public.play_sessions;
  c  public.venue_checkins;
  b  public.venue_checkins;
  j  jsonb;
  n  int;
begin
  -- A Start saved with no signal 40 minutes ago, with its tap-time fix.
  s := pg_temp.tt_start('TH', 'f3000000-0000-4000-8000-000000000001', 'test:tt-court', 40.4001, interval '40 minutes');
  c := pg_temp.vci('f3000000-0000-4000-8000-000000000001');
  perform pg_temp.ok('T34 a 40-minute Start replay checks me in from the tap, for 180 min from the tap',
    s.started_at = now() - interval '40 minutes' and c.source = 'session' and c.location_confirmed
    and c.checked_in_at = now() - interval '40 minutes' and c.expires_at = now() + interval '140 minutes'
    and c.checked_out_at is null and c.arrival_fix_at = now() - interval '40 minutes 5 seconds', c::text);
  perform pg_temp.as_user(pg_temp.p('TH'));
  perform public.end_play_session('f3000000-0000-4000-8000-000000000001', now());

  -- A Start replayed 4 hours late: the session is stored; its check-in is
  -- stored already over, and its End (queued at tap + 2 h, with the fix taken
  -- then) closes it and proves the stay. A match makes it count.
  s := pg_temp.tt_start('TI', 'f3000000-0000-4000-8000-000000000002', 'test:tt-court', 40.4001, interval '4 hours');
  c := pg_temp.vci('f3000000-0000-4000-8000-000000000002');
  perform pg_temp.ok('T34 a Start replayed 4 h late: the session is stored, its check-in stored already over',
    s.started_at = now() - interval '4 hours' and s.ended_at is null
    and c.location_confirmed and c.checked_in_at = now() - interval '4 hours' and c.expires_at = now() - interval '1 hour'
    and c.checked_out_at is null and c.expires_at <= c.created_at, c::text);
  perform pg_temp.as_user(pg_temp.p('TI'));
  select public.end_play_session(p_id => 'f3000000-0000-4000-8000-000000000002', p_at => now() - interval '2 hours',
    p_lat => 40.4001, p_lng => -100.0, p_accuracy_m => 10, p_fix_age_ms => 7200000) into n;
  c := pg_temp.vci('f3000000-0000-4000-8000-000000000002');
  perform pg_temp.ok('T34 ...its queued End closes the check-in at the End tap and proves the stay',
    n = 1 and c.checked_out_at = now() - interval '2 hours' and c.stay_confirmed, c::text);
  perform pg_temp.as_admin();
  insert into public.matches (league_id, player1_id, player2_id, player1_score, player2_score, match_type,
                              winner_id, winner_team, status, confirm_deadline, created_at, played_at)
  values ('b3000000-0000-4000-8000-000000000004', pg_temp.p('TI'), pg_temp.p('TV'), 11, 5, 'singles',
          pg_temp.p('TI'), 'team1', 'pending', now() + interval '1 hour', now() - interval '90 minutes', now() - interval '90 minutes');
  j := pg_temp.validity('TI', 'f3000000-0000-4000-8000-000000000002');
  perform pg_temp.ok('T34 ...so the session was at the court: valid AND at_court (rewards can pay)',
    (j ->> 'at_court')::boolean and (j ->> 'valid')::boolean, j::text);

  -- A Start 13 hours old: the session is clamped as before, no check-in.
  s := pg_temp.tt_start('TJ', 'f3000000-0000-4000-8000-000000000003', 'test:tt-court', 40.4001, interval '13 hours');
  perform pg_temp.ok('T34 a Start 13 h old: the session clamped to 12 h back as before, no check-in, no error',
    s.started_at = now() - interval '12 hours'
    and not exists (select 1 from public.venue_checkins where id = 'f3000000-0000-4000-8000-000000000003'), s::text);
  perform pg_temp.as_user(pg_temp.p('TJ'));
  perform public.end_play_session('f3000000-0000-4000-8000-000000000003', now() - interval '11 hours');
  -- A Start with a backdated tap and a fix from now.
  perform pg_temp.as_user(pg_temp.p('TJ'));
  select * into s from public.start_play_session(p_id => 'f3000000-0000-4000-8000-000000000004', p_kind => 'open_play',
    p_venue => 'test:tt-court', p_at => now() - interval '3 hours',
    p_lat => 40.4001, p_lng => -100.0, p_accuracy_m => 10, p_fix_at => now(), p_fix_age_ms => 0);
  perform pg_temp.ok('T34 (d) a Start with a backdated tap and a fix from now: stored, no check-in, no error',
    s.started_at = now() - interval '3 hours'
    and not exists (select 1 from public.venue_checkins where id = 'f3000000-0000-4000-8000-000000000004'), s::text);
  perform public.end_play_session('f3000000-0000-4000-8000-000000000004', now());

  -- A late Start never closes a check-in made after its tap.
  b := pg_temp.tt_ci('TY', 'c3000000-0000-4000-8000-000000000301', 'test:tt-court2', 40.4101, interval '0', interval '2 seconds');
  s := pg_temp.tt_start('TY', 'f3000000-0000-4000-8000-000000000005', 'test:tt-court', 40.4001, interval '1 hour');
  c := pg_temp.vci('f3000000-0000-4000-8000-000000000005');
  b := pg_temp.vci('c3000000-0000-4000-8000-000000000301');
  perform pg_temp.ok('T34 a late Start ends its check-in where a newer one starts, and leaves that one open',
    c.checked_in_at = now() - interval '1 hour' and c.expires_at = now() and b.checked_out_at is null,
    c::text || ' ' || b::text);
  perform pg_temp.as_user(pg_temp.p('TY'));
  perform public.end_play_session('f3000000-0000-4000-8000-000000000005', now());
  perform public.checkout_venue(null, null, now());

  -- (a) a live Start from a phone 10 min slow (p_at sent, as the app does).
  s := pg_temp.tt_start('TS', 'f3000000-0000-4000-8000-000000000006', 'test:tt-court', 40.4001, interval '0',
                        interval '5 seconds', - interval '10 minutes');
  c := pg_temp.vci('f3000000-0000-4000-8000-000000000006');
  perform pg_temp.ok('T34 (a) a live Start from a phone 10 min slow: the session keeps the app''s time, its check-in is now',
    s.started_at = now() - interval '10 minutes' and c.location_confirmed and c.checked_in_at = now()
    and c.expires_at = now() + interval '180 minutes' and c.fix_at = now() - interval '5 seconds', c::text);
  perform pg_temp.as_user(pg_temp.p('TS'));
  perform public.end_play_session('f3000000-0000-4000-8000-000000000006', now());
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T34 block crashed', false, sqlerrm);
end $$;


-- ════ T35 the lock-screen check-in; 1.0.4's calls on this server ════════
do $$
declare
  r  public.venue_checkins;
  s  public.play_sessions;
  e  jsonb;
  n  int;
begin
  -- The lock-screen / arrival Check in (source 'geofence'), saved with no
  -- signal 20 minutes ago, then checked out by leaving the fence.
  r := pg_temp.tt_ci('TK', 'c3000000-0000-4000-8000-000000000401', 'test:tt-court', 40.4001, interval '20 minutes',
                     interval '4 seconds', 120, 'geofence');
  perform pg_temp.ok('T35 a lock-screen Check in replayed 20 min late counts, from the tap',
    r.source = 'geofence' and r.location_confirmed and r.checked_in_at = now() - interval '20 minutes'
    and r.checked_out_at is null, r::text);
  select public.checkout_venue(p_id => 'c3000000-0000-4000-8000-000000000401', p_source => 'geofence', p_at => now()) into n;
  perform pg_temp.ok('T35 ...and leaving the fence checks it out', n = 1, n::text);
  r := pg_temp.tt_ci('TK', 'c3000000-0000-4000-8000-000000000402', 'test:tt-court', 40.4001, interval '0',
                     interval '4 seconds', 120, 'geofence');
  perform pg_temp.ok('T35 a live lock-screen Check in: confirmed now', r.source = 'geofence' and r.checked_in_at = now(), r::text);
  perform public.checkout_venue(null, null, now());

  -- The runtime-1.0.4 OTA: every call sends p_at, p_fix_at and the age at send.
  r := pg_temp.tt_ci('TL', 'c3000000-0000-4000-8000-000000000404', 'test:tt-court2', 40.4101, interval '30 minutes');
  perform pg_temp.ok('T35 1.0.4 OTA check-in queued 30 min ago: counts now, open (it was refused before)',
    r.location_confirmed and r.checked_in_at = now() - interval '30 minutes' and r.expires_at = now() + interval '90 minutes'
    and r.checked_out_at is null, r::text);
  perform public.checkout_venue(null, null, now());
  perform pg_temp.as_user(pg_temp.p('TL'));
  select * into r from public.checkin_venue(p_id => 'c3000000-0000-4000-8000-000000000403', p_venue => 'test:tt-court',
    p_minutes => 120, p_source => 'manual', p_at => now(), p_lat => 40.4001, p_lng => -100.0, p_accuracy_m => 12,
    p_fix_at => now() - interval '2.5 seconds', p_fix_age_ms => 2500);
  perform pg_temp.ok('T35 1.0.4 OTA live check-in: accepted as before',
    r.location_confirmed and r.checked_in_at = now() and r.fix_at = now() - interval '2.5 seconds', r::text);
  select * into r from public.extend_checkin(p_id => 'c3000000-0000-4000-8000-000000000403', p_until => now() + interval '3 hours',
    p_lat => 40.4001, p_lng => -100.0, p_accuracy_m => 12, p_fix_at => now(), p_fix_age_ms => 0);
  perform pg_temp.ok('T35 1.0.4 OTA extend with a fix: as before', r.expires_at = now() + interval '3 hours', r::text);
  select public.checkout_venue(p_id => 'c3000000-0000-4000-8000-000000000403', p_source => null, p_at => now(),
    p_lat => 40.4001, p_lng => -100.0, p_accuracy_m => 12, p_fix_age_ms => 1000) into n;
  perform pg_temp.ok('T35 1.0.4 OTA check-out with a fix: as before', n = 1, n::text);
  e := pg_temp.err($q$select public.checkin_venue(p_id => 'c3000000-0000-4000-8000-000000000405', p_venue => 'test:tt-court',
    p_minutes => 120, p_source => 'manual', p_at => now() - interval '13 hours', p_lat => 40.4001, p_lng => -100.0,
    p_accuracy_m => 12, p_fix_at => now() - interval '13 hours 3 seconds', p_fix_age_ms => 46803000)$q$);
  perform pg_temp.ok('T35 1.0.4 OTA check-in queued 13 h ago: a complete P0001 text it shows as is, nothing it misreads',
    e ->> 'state' = 'P0001' and e ->> 'hint' = 'pl:checkin.too_old'
    and not pg_temp.reads_nothing_to_answer(e ->> 'msg')
    and e ->> 'msg' !~* '(need to be at the court|precise enough|open Pickleague at the court)', e::text);
  select * into s from public.start_play_session(p_id => 'f3000000-0000-4000-8000-000000000401', p_kind => 'open_play',
    p_source => null, p_venue => 'test:tt-court', p_at => now(), p_lat => 40.4001, p_lng => -100.0, p_accuracy_m => 12,
    p_fix_at => now() - interval '4 seconds', p_fix_age_ms => 4000);
  perform pg_temp.ok('T35 1.0.4 OTA live Start at a court: checked in as before',
    exists (select 1 from public.venue_checkins where id = 'f3000000-0000-4000-8000-000000000401'
             and location_confirmed and checked_in_at = now() and expires_at = now() + interval '180 minutes'));
  perform public.end_play_session('f3000000-0000-4000-8000-000000000401', now());

  -- 1.0.4 embedded bundles: no fix anywhere.
  perform pg_temp.as_user(pg_temp.p('TM'));
  select * into r from public.checkin_venue(p_id => 'c3000000-0000-4000-8000-000000000406', p_venue => 'test:tt-court',
    p_minutes => 120, p_source => 'manual', p_at => now());
  perform pg_temp.ok('T35 1.0.4 embedded check-in {p_id, p_venue, p_minutes, p_source, p_at}: private row, as before',
    not r.location_confirmed and r.checked_in_at = now(), r::text);
  select * into r from public.extend_checkin(p_id => 'c3000000-0000-4000-8000-000000000406', p_until => now() + interval '3 hours');
  perform pg_temp.ok('T35 1.0.4 embedded extend {p_id, p_until}: as before', r.expires_at = now() + interval '3 hours', r::text);
  select public.checkout_venue(p_id => 'c3000000-0000-4000-8000-000000000406', p_source => null) into n;
  perform pg_temp.ok('T35 1.0.4 embedded check-out {p_id, p_source}: as before', n = 1, n::text);
  select * into s from public.start_play_session(p_id => 'f3000000-0000-4000-8000-000000000402', p_kind => 'open_play',
    p_source => null, p_venue => 'test:tt-court', p_at => now() - interval '20 minutes');
  perform pg_temp.ok('T35 1.0.4 embedded Start {p_id, p_kind, p_source, p_venue, p_at}: stored untracked, as before',
    s.started_at = now() - interval '20 minutes'
    and not exists (select 1 from public.venue_checkins where id = 'f3000000-0000-4000-8000-000000000402'), s::text);
  select public.end_play_session(p_id => 'f3000000-0000-4000-8000-000000000402', p_at => now()) into n;
  perform pg_temp.ok('T35 1.0.4 embedded End {p_id, p_at}: as before', n = 1, n::text);
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T35 block crashed', false, sqlerrm);
end $$;


-- ════ T36 P2: league_members column grants ═══════════════════════════════
do $$
begin
  perform pg_temp.as_admin();
  perform pg_temp.ok('T36 clients may name league_id / user_id / role in an UPDATE, nothing else',
    has_column_privilege('authenticated', 'public.league_members', 'role', 'UPDATE')
    and has_column_privilege('authenticated', 'public.league_members', 'league_id', 'UPDATE')
    and has_column_privilege('authenticated', 'public.league_members', 'user_id', 'UPDATE')
    and not has_column_privilege('authenticated', 'public.league_members', 'admitted_closed', 'UPDATE')
    and not has_column_privilege('authenticated', 'public.league_members', 'expires_at', 'UPDATE')
    and not has_column_privilege('authenticated', 'public.league_members', 'joined_at', 'UPDATE')
    and not has_column_privilege('authenticated', 'public.league_members', 'id', 'UPDATE'));
  perform pg_temp.ok('T36 no table-wide UPDATE, and nothing for anon',
    not has_table_privilege('authenticated', 'public.league_members', 'UPDATE')
    and not has_table_privilege('anon', 'public.league_members', 'UPDATE')
    and not has_column_privilege('anon', 'public.league_members', 'league_id', 'UPDATE')
    and not has_column_privilege('anon', 'public.league_members', 'user_id', 'UPDATE')
    and not has_column_privilege('anon', 'public.league_members', 'role', 'UPDATE'));
  perform pg_temp.ok('T36 the identity lock is in place and closed to clients',
    exists (select 1 from pg_trigger t where t.tgrelid = 'public.league_members'::regclass
             and t.tgname = 'trg_league_members_lock_identity' and t.tgenabled = 'O'
             and pg_get_triggerdef(t.oid) like '%BEFORE UPDATE OF league_id, user_id ON public.league_members FOR EACH ROW%')
    and not has_function_privilege('authenticated', 'public._league_members_lock_identity()', 'execute')
    and not has_function_privilege('anon', 'public._league_members_lock_identity()', 'execute'));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T36 block crashed', false, sqlerrm);
end $$;


-- ════ T37 P2: an old bundle's Join ═══════════════════════════════════════
-- What 1.0.2 / 1.0.3 / an embedded 1.0.4 bundle sends for Join: PostgREST's
-- merge upsert with no on_conflict (the primary key).
create function pg_temp.tt_old_join(p_league uuid, p_user uuid, p_role text default 'member') returns text
language plpgsql as $$
begin
  return pg_temp.tt_try(format(
    'insert into public.league_members (league_id, user_id, role) values (%L, %L, %L) '
    'on conflict (id) do update set league_id = excluded.league_id, user_id = excluded.user_id, role = excluded.role',
    p_league, p_user, p_role));
end $$;

do $$
declare
  t    text;
  lj   uuid := pg_temp.p('LJ');
  open uuid := 'b3000000-0000-4000-8000-000000000001';
begin
  -- Without the grant (as live before this file): the bundle's Join failed.
  perform pg_temp.as_admin();
  revoke update (league_id, user_id) on public.league_members from authenticated;
  perform pg_temp.as_user(lj);
  t := pg_temp.tt_old_join(open, lj);
  perform pg_temp.ok('T37 (before) without the grant an old bundle''s Join fails with 42501 ("You don''t have access")',
    t like 'err:42501:%permission denied%', t);
  perform pg_temp.as_admin();
  grant update (league_id, user_id) on public.league_members to authenticated;

  perform pg_temp.as_user(lj);
  t := pg_temp.tt_old_join(open, lj);
  perform pg_temp.ok('T37 an old bundle''s Join of an open league works', t = 'ok:1', t);
  perform pg_temp.as_admin();
  perform pg_temp.ok('T37 ...as a plain member, not admitted while closed',
    exists (select 1 from public.league_members where league_id = open and user_id = lj
             and role = 'member' and not admitted_closed));
  perform pg_temp.as_user(lj);
  t := pg_temp.tt_old_join(open, lj);
  perform pg_temp.ok('T37 an old bundle''s second Join: the unique-key error it always got', t like 'err:23505:%', t);
  t := pg_temp.tt_try(format('insert into public.league_members (league_id, user_id, role) values (%L, %L, ''member'') '
                             'on conflict (league_id, user_id) do nothing', open, lj));
  perform pg_temp.ok('T37 the current app''s Join (ON CONFLICT DO NOTHING) is still a quiet no-op', t = 'ok:0', t);
  t := pg_temp.tt_old_join('b3000000-0000-4000-8000-000000000002', lj);
  perform pg_temp.ok('T37 an old bundle''s Join of a closed league is still refused', t like 'err:42501:%row-level security%', t);
  t := pg_temp.tt_old_join('b3000000-0000-4000-8000-000000000003', lj, 'admin');
  perform pg_temp.ok('T37 joining an open league as admin is still refused', t like 'err:42501:%row-level security%', t);
  t := pg_temp.tt_old_join('b3000000-0000-4000-8000-000000000003', pg_temp.p('LM'));
  perform pg_temp.ok('T37 joining someone else is still refused', t like 'err:42501:%row-level security%', t);
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T37 block crashed', false, sqlerrm);
end $$;


-- ════ T38 P2: nobody can move a membership or raise a role ════════════════
do $$
declare
  t      text;
  la     uuid := pg_temp.p('LA');
  lc     uuid := pg_temp.p('LC');
  lm     uuid := pg_temp.p('LM');
  open   uuid := 'b3000000-0000-4000-8000-000000000001';
  closed uuid := 'b3000000-0000-4000-8000-000000000002';
  other  uuid := 'b3000000-0000-4000-8000-000000000003';
  la_row uuid;
  lc_row uuid;
  lm_row uuid;
  msg    text := 'A league membership can''t be moved to another league or player. Leave the league, then join the one you want.';
  before text;
  after  text;
begin
  perform pg_temp.as_admin();
  select id into la_row from public.league_members where league_id = open and user_id = la;
  select id into lc_row from public.league_members where league_id = open and user_id = lc;
  select id into lm_row from public.league_members where league_id = open and user_id = lm;
  select string_agg(id || ':' || league_id || ':' || user_id, ',' order by id) into before
    from public.league_members where league_id in (open, closed, other);

  -- Members and co-admins reach no row through UPDATE.
  perform pg_temp.as_user(lm);
  t := pg_temp.tt_try(format('update public.league_members set role = ''admin'' where id = %L', lm_row));
  perform pg_temp.ok('T38 a member can''t raise their own role (0 rows)', t = 'ok:0', t);
  t := pg_temp.tt_try(format('update public.league_members set league_id = %L where id = %L', other, lm_row));
  perform pg_temp.ok('T38 a member can''t move their own row to another league (0 rows)', t = 'ok:0', t);
  t := pg_temp.tt_try(format('update public.league_members set user_id = %L where id = %L', lm, lc_row));
  perform pg_temp.ok('T38 a member can''t take over another member''s row (0 rows)', t = 'ok:0', t);
  t := pg_temp.tt_try(format(
    'insert into public.league_members (id, league_id, user_id, role) values (%L, %L, %L, ''member'') '
    'on conflict (id) do update set league_id = excluded.league_id, user_id = excluded.user_id, role = excluded.role',
    la_row, open, lm));
  perform pg_temp.ok('T38 a member''s upsert onto the admin''s row is refused', t like 'err:42501:%row-level security%', t);
  t := pg_temp.tt_try(format(
    'insert into public.league_members (id, league_id, user_id, role) values (%L, %L, %L, ''admin'') '
    'on conflict (id) do update set league_id = excluded.league_id, user_id = excluded.user_id, role = excluded.role',
    lm_row, open, lm));
  perform pg_temp.ok('T38 a member''s upsert of their own row to admin is refused', t like 'err:42501:%row-level security%', t);
  perform pg_temp.as_user(lc);
  t := pg_temp.tt_try(format('update public.league_members set role = ''admin'' where id = %L', lc_row));
  perform pg_temp.ok('T38 a co-admin can''t raise their own role (0 rows)', t = 'ok:0', t);

  -- An admin reaches rows of their league, and the identity lock stops any move.
  perform pg_temp.as_user(la);
  t := pg_temp.tt_try(format('update public.league_members set user_id = %L where id = %L', la, lm_row));
  perform pg_temp.ok('T38 an admin moving a member''s row onto themselves: why, what to do (pl:membership.locked)',
    t = 'err:P0001:pl:membership.locked:' || msg, t);
  t := pg_temp.tt_try(format('update public.league_members set league_id = %L where id = %L', closed, lm_row));
  perform pg_temp.ok('T38 an admin moving a member into their closed league is refused the same way',
    t = 'err:P0001:pl:membership.locked:' || msg, t);
  t := pg_temp.tt_try(format(
    'insert into public.league_members (id, league_id, user_id, role) values (%L, %L, %L, ''admin'') '
    'on conflict (id) do update set league_id = excluded.league_id, user_id = excluded.user_id, role = excluded.role',
    la_row, closed, la));
  perform pg_temp.ok('T38 an admin''s upsert moving their own row to another league is refused (pl:membership.locked)',
    t like 'err:P0001:pl:membership.locked:%', t);
  t := pg_temp.tt_try(format(
    'insert into public.league_members (id, league_id, user_id, role) values (%L, %L, %L, ''member'') '
    'on conflict (id) do update set league_id = excluded.league_id, user_id = excluded.user_id, role = excluded.role',
    lm_row, open, la));
  perform pg_temp.ok('T38 an admin''s upsert taking over a member''s row is refused (pl:membership.locked)',
    t like 'err:P0001:pl:membership.locked:%', t);
  t := pg_temp.tt_try(format(
    'insert into public.league_members (league_id, user_id, role) values (%L, %L, ''member'') '
    'on conflict (id) do update set league_id = excluded.league_id, user_id = excluded.user_id, role = excluded.role',
    open, pg_temp.p('LO')));
  perform pg_temp.ok('T38 an admin''s upsert carrying someone else''s id is refused (RLS)', t like 'err:42501:%row-level security%', t);
  t := pg_temp.tt_try(format('update public.league_members set user_id = user_id, league_id = league_id, role = ''co-admin'' where id = %L', lm_row));
  perform pg_temp.ok('T38 naming the same ids (what an old bundle''s upsert does) is allowed: an admin can still promote', t = 'ok:1', t);
  t := pg_temp.tt_try(format('update public.league_members set admitted_closed = true where id = %L', lm_row));
  perform pg_temp.ok('T38 admitted_closed is still not writable', t like 'err:42501:%permission denied%', t);

  -- Server code (full UPDATE) is stopped too.
  perform pg_temp.as_admin();
  t := pg_temp.tt_try(format('update public.league_members set user_id = %L where id = %L', la, lm_row));
  perform pg_temp.ok('T38 server code moving a membership is refused (pl:membership.locked)',
    t = 'err:P0001:pl:membership.locked:' || msg, t);
  insert into _rf_msgs (msg) values (msg);

  select string_agg(id || ':' || league_id || ':' || user_id, ',' order by id) into after
    from public.league_members where league_id in (open, closed, other);
  perform pg_temp.ok('T38 every membership is where it was (same ids, leagues and players)',
    after = before, coalesce(after, 'null') || ' / ' || coalesce(before, 'null'));
  perform pg_temp.ok('T38 ...and the promotion is the only role change',
    (select role from public.league_members where id = lm_row) = 'co-admin'
    and (select role from public.league_members where id = lc_row) = 'co-admin'
    and (select role from public.league_members where id = la_row) = 'admin');
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T38 block crashed', false, sqlerrm);
end $$;


-- ════ T39 signatures and words ═══════════════════════════════════════════
do $$
declare
  bad text;
begin
  perform pg_temp.as_admin();
  with want(fn, args, definer, cfg) as (values
    ('_pl_raise_unconfirmed_fix', 'p_fresh boolean, p_precise boolean, p_confirmed boolean, p_distance_m double precision, p_had_age boolean, p_what text', false, 'search_path=""'),
    ('checkin_venue', 'p_id uuid, p_venue text, p_minutes integer, p_source text, p_at timestamp with time zone, p_lat double precision, p_lng double precision, p_accuracy_m double precision, p_fix_at timestamp with time zone, p_fix_age_ms double precision', true, 'search_path=""'),
    ('extend_checkin', 'p_id uuid, p_until timestamp with time zone, p_lat double precision, p_lng double precision, p_accuracy_m double precision, p_fix_at timestamp with time zone, p_fix_age_ms double precision', true, 'search_path=""'),
    ('start_play_session', 'p_id uuid, p_kind text, p_source uuid, p_venue text, p_at timestamp with time zone, p_lat double precision, p_lng double precision, p_accuracy_m double precision, p_fix_at timestamp with time zone, p_fix_age_ms double precision', true, 'search_path=""'),
    ('_league_members_lock_identity', '', false, 'search_path=""'))
  select string_agg(w.fn, '; ') into bad
    from want w
    left join lateral (
      select count(*) as n,
             bool_and(pg_get_function_identity_arguments(p.oid) = w.args
                      and p.prosecdef = w.definer
                      and array_to_string(p.proconfig, ',') is not distinct from w.cfg) as same
        from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = w.fn) got on true
   where got.n is distinct from 1 or not got.same;
  perform pg_temp.ok('T39 every replaced function keeps its one live signature, definer and search_path', bad is null, bad);
  perform pg_temp.ok('T39 the client RPCs stay open to signed-in players, closed to anon',
    has_function_privilege('authenticated', 'public.checkin_venue(uuid,text,integer,text,timestamptz,double precision,double precision,double precision,timestamptz,double precision)', 'execute')
    and has_function_privilege('authenticated', 'public.start_play_session(uuid,text,uuid,text,timestamptz,double precision,double precision,double precision,timestamptz,double precision)', 'execute')
    and has_function_privilege('authenticated', 'public.extend_checkin(uuid,timestamptz,double precision,double precision,double precision,timestamptz,double precision)', 'execute')
    and not has_function_privilege('anon', 'public.checkin_venue(uuid,text,integer,text,timestamptz,double precision,double precision,double precision,timestamptz,double precision)', 'execute')
    and not has_function_privilege('anon', 'public.start_play_session(uuid,text,uuid,text,timestamptz,double precision,double precision,double precision,timestamptz,double precision)', 'execute'));
  -- Every refusal text so far (this section's included): no network, auth or
  -- permission word, no em dash, and the new ones never read as "Nothing to
  -- answer" on 1.0.4's lock screen.
  select string_agg(distinct msg, ' | ') into bad
    from _rf_msgs
   where msg ~* '(failed to fetch|network request failed|networkerror|fetch failed|load failed|timed out|network connection was lost|internet connection appears to be offline|jwt|refresh token|permission denied|row-level security)'
      or msg like '%—%';
  perform pg_temp.ok('T39 no refusal text uses a network, auth or permission word, or an em dash', bad is null, bad);
  select string_agg(distinct msg, ' | ') into bad
    from _rf_msgs
   where (msg like 'Your location was taken%' or msg like 'This check-in was saved%' or msg like 'A league membership%'
          or msg like 'Your location is out of date: it was taken%')
     and pg_temp.reads_nothing_to_answer(msg);
  perform pg_temp.ok('T39 the new texts never say "expired" or "not found"',
    bad is null and (select count(*) from _rf_msgs
                      where msg like 'Your location was taken%' or msg like 'This check-in was saved%'
                         or msg like 'A league membership%' or msg like 'Your location is out of date: it was taken%') >= 4,
    bad);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T39 block crashed', false, sqlerrm);
end $$;
