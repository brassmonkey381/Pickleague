-- ============================================================
-- Refusal messages and codes (supabase/migration_refusal_messages.sql;
-- docs/play-sessions-presence.md rule 11: every refusal says why and what to do).
--
-- NOT runnable on its own: build-presence-test.mjs splices it into
-- presence_p1_personas.sql at -- @@REFUSALS@@, after the Phase 1 and Phase 1.5
-- sections and before the results, reusing that file's harness (_p, _results,
-- pg_temp.p / ok / as_user / as_admin / checkin) inside the same rolled-back
-- transaction. now() is fixed for the whole transaction.
--
-- Checks, for every refusal the file touches: SQLSTATE stays P0001, the text
-- (the reason, then what to do), the 'pl:<code>' hint the app maps, and that
-- the text keeps what the shipped 1.0.4 app matches (and nothing it would
-- misread). Plus: signatures unchanged, the new helpers closed to clients,
-- the new returned reasons, the pending-match notices, the 1-hour expiry
-- notices, and the keys my_session_validity adds.
--
-- Personas (RF Test League, open; court test:rf-court at 40.3 N, 100.0 W):
--   RA records · RB / RD opponents · RC RA's partner · RN a league member
--   who records others' matches · RQ / RR friend requests · RE expiry ·
--   RS / RT session outcomes (in no other match: every match here is
--   recorded at the same now()) · RW a drill held another day
-- ============================================================

insert into _p values
  ('RA', 'a2000000-0000-4000-8000-000000000001'), ('RB', 'a2000000-0000-4000-8000-000000000002'),
  ('RC', 'a2000000-0000-4000-8000-000000000003'), ('RD', 'a2000000-0000-4000-8000-000000000004'),
  ('RN', 'a2000000-0000-4000-8000-000000000005'), ('RQ', 'a2000000-0000-4000-8000-000000000006'),
  ('RR', 'a2000000-0000-4000-8000-000000000007'), ('RE', 'a2000000-0000-4000-8000-000000000008'),
  ('RS', 'a2000000-0000-4000-8000-000000000009'), ('RT', 'a2000000-0000-4000-8000-00000000000a'),
  ('RW', 'a2000000-0000-4000-8000-00000000000b');

insert into auth.users (id, email, raw_user_meta_data)
select id, 'rf-' || lower(k) || '@pickleague.test',
       jsonb_build_object('full_name', case k
         when 'RA' then 'Rita Recorder' when 'RB' then 'Ben Opponent' when 'RC' then 'Cora Partner'
         when 'RD' then 'Dan Opponent' when 'RN' then 'Nell Nonplayer' when 'RQ' then 'Quinn Asker'
         when 'RR' then 'Remy Decliner' when 'RE' then 'Ezra Expiry' when 'RS' then 'Sid Sessions'
         when 'RT' then 'Tia Opponent' when 'RW' then 'Wren Drill' end)
  from _p where id::text like 'a2000000-%';

insert into public.venues (id, sport, name, kind, lat, lng, source, geofence_radius_m)
values ('test:rf-court', array['pickleball'], 'RF Test Courts', 'court', 40.3, -100.0, 'google', 100);

insert into public.leagues (id, name, is_open, created_by)
values ('b2000000-0000-4000-8000-000000000001', 'RF Test League', true, pg_temp.p('RN'));
insert into public.league_members (league_id, user_id, role)
select 'b2000000-0000-4000-8000-000000000001', id, case when k = 'RN' then 'admin' else 'member' end
  from _p where id::text like 'a2000000-%'
on conflict do nothing;

-- Every refusal text the section sees, for the 1.0.4 word checks at the end.
create temp table _rf_msgs (msg text not null);
grant select, insert on _rf_msgs to authenticated;

-- Run p_sql; null when it succeeds, else {state, msg, hint, detail}.
create function pg_temp.err(p_sql text) returns jsonb language plpgsql as $$
declare
  v_state  text;
  v_msg    text;
  v_hint   text;
  v_detail text;
begin
  execute p_sql;
  return null;
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text,
                          v_hint = pg_exception_hint, v_detail = pg_exception_detail;
  insert into _rf_msgs (msg) values (v_msg);
  return jsonb_build_object('state', v_state, 'msg', v_msg, 'hint', v_hint, 'detail', v_detail);
end $$;

-- A request with no user in it (signed out, the anon key).
create function pg_temp.as_signed_out() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role": "authenticated"}', true);
  perform set_config('role', 'authenticated', true);
end $$;

-- 1.0.4's lock screen: these words read as "Nothing to answer".
create function pg_temp.reads_nothing_to_answer(m text) returns boolean language sql immutable as $$
  select coalesce(m, '') ~* '(no longer pending|expired|not found|Invite already)'
$$;


-- ════ T20 signed out ════════════════════════════════════════════════════
do $$
declare
  e   jsonb;
  q   text;
  bad text := '';
begin
  perform pg_temp.as_signed_out();
  foreach q in array array[
    'select public.checkin_venue(p_id => gen_random_uuid(), p_venue => ''test:rf-court'')',
    'select public.extend_checkin(gen_random_uuid(), now() + interval ''1 hour'')',
    'select public.checkout_venue(null, null, now())',
    'select public.start_play_session(p_id => gen_random_uuid(), p_kind => ''open_play'')',
    'select public.end_play_session(gen_random_uuid(), now())',
    'select public.resolve_court(40.3, -100.0)',
    'select public.my_session_validity(gen_random_uuid())',
    'select public.confirm_match(gen_random_uuid())',
    'select public.send_friend_request(gen_random_uuid())',
    'select public.respond_friend_request(gen_random_uuid(), true)',
    'select public.cancel_friend_request(gen_random_uuid())',
    'select public.remove_friend(gen_random_uuid())',
    'select public.set_close_friend(gen_random_uuid(), true)',
    'select public.friendship_status_with(gen_random_uuid())',
    'select public.venue_crowd(array[''test:rf-court''])',
    'select public.friends_at_courts(12)',
    'select public.set_presence_settings(p_consent_seen => true)',
    'select public.hide_presence_from(gen_random_uuid(), true)',
    'select public.set_court_favorite(''test:rf-court'', true)',
    'select * from public.submit_drill_review(gen_random_uuid(), 5, null, null, null, null, null)']
  loop
    e := pg_temp.err(q);
    if e is null or e ->> 'state' <> 'P0001'
       or e ->> 'msg' <> 'You''re signed out. Sign in to Pickleague and try again.'
       or e ->> 'hint' <> 'pl:auth.signed_out' then
      bad := bad || q || ' -> ' || coalesce(e::text, 'no error') || '; ';
    end if;
  end loop;
  perform pg_temp.as_admin();
  perform pg_temp.ok('T20 every in-scope RPC tells a signed-out caller to sign in (P0001, pl:auth.signed_out)',
    bad = '', bad);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T20 block crashed', false, sqlerrm);
end $$;


-- ════ T21 check-ins, extensions, starts, courts ═════════════════════════
do $$
declare
  e  jsonb;
  ra uuid := pg_temp.p('RA');
begin
  perform pg_temp.as_user(ra);
  e := pg_temp.err($q$select public.checkin_venue(p_id => 'c2000000-0000-4000-8000-000000000001', p_venue => 'test:rf-court',
    p_lat => 40.303, p_lng => -100.0, p_accuracy_m => 10, p_fix_at => now(), p_fix_age_ms => 1000)$q$);
  perform pg_temp.ok('T21 not at the court: why, how far, what to do (pl:fix.not_at_court)',
    e ->> 'state' = 'P0001' and e ->> 'hint' = 'pl:fix.not_at_court'
    and e ->> 'msg' like 'You need to be at the court to check in. You''re about % m away, so try again when you''re there.'
    and (e ->> 'detail')::jsonb ? 'distance_m', e::text);
  perform pg_temp.ok('T21 ...keeps the words 1.0.4 offers "Start without a court" on',
    e ->> 'msg' ~* 'need to be at the court' and not pg_temp.reads_nothing_to_answer(e ->> 'msg'), e ->> 'msg');

  e := pg_temp.err($q$select public.checkin_venue(p_id => 'c2000000-0000-4000-8000-000000000001', p_venue => 'test:rf-court',
    p_lat => 40.3001, p_lng => -100.0, p_accuracy_m => 10, p_fix_at => now(), p_fix_age_ms => 180000)$q$);
  perform pg_temp.ok('T21 a stale fix says it is over 2 minutes old (pl:fix.stale)',
    e ->> 'hint' = 'pl:fix.stale' and e ->> 'msg' ~* 'location is out of date' and e ->> 'msg' ~ '2 minutes', e::text);
  e := pg_temp.err($q$select public.checkin_venue(p_id => 'c2000000-0000-4000-8000-000000000001', p_venue => 'test:rf-court',
    p_lat => 40.3001, p_lng => -100.0, p_accuracy_m => 10, p_fix_at => now() - interval '3 minutes')$q$);
  perform pg_temp.ok('T21 a stale fix with no age names the phone clock (pl:fix.stale_clock)',
    e ->> 'hint' = 'pl:fix.stale_clock' and e ->> 'msg' ~* 'location is out of date', e::text);
  e := pg_temp.err($q$select public.checkin_venue(p_id => 'c2000000-0000-4000-8000-000000000001', p_venue => 'test:rf-court',
    p_lat => 40.3001, p_lng => -100.0, p_accuracy_m => 5000, p_fix_at => now(), p_fix_age_ms => 1000)$q$);
  perform pg_temp.ok('T21 an approximate fix (pl:fix.imprecise)',
    e ->> 'hint' = 'pl:fix.imprecise' and e ->> 'msg' ~* 'precise enough', e::text);
  e := pg_temp.err($q$select public.checkin_venue(p_id => 'c2000000-0000-4000-8000-000000000001', p_venue => 'test:rf-court',
    p_lat => 40.3001, p_lng => null, p_accuracy_m => 10, p_fix_at => now(), p_fix_age_ms => 1000)$q$);
  perform pg_temp.ok('T21 half a fix (pl:fix.malformed)',
    e ->> 'hint' = 'pl:fix.malformed' and e ->> 'msg' like 'Your location didn''t come through%Try again.', e::text);
  e := pg_temp.err($q$select public.checkin_venue(p_id => 'c2000000-0000-4000-8000-000000000001', p_venue => 'test:rf-gone',
    p_lat => 40.3001, p_lng => -100.0, p_accuracy_m => 10, p_fix_at => now(), p_fix_age_ms => 1000)$q$);
  perform pg_temp.ok('T21 a court that is gone (pl:court.gone), never read as "Nothing to answer" by 1.0.4',
    e ->> 'hint' = 'pl:court.gone'
    and e ->> 'msg' = 'That court isn''t in Pickleague any more, so you can''t check in there. Find your court again.'
    and not pg_temp.reads_nothing_to_answer(e ->> 'msg'), e::text);
  e := pg_temp.err($q$select public.checkin_venue(p_id => null, p_venue => 'test:rf-court')$q$);
  perform pg_temp.ok('T21 an incomplete request (pl:request.bad)',
    e ->> 'hint' = 'pl:request.bad' and e ->> 'msg' like 'Couldn''t check you in because%Update Pickleague, then try again.', e::text);

  -- Extend: nothing open, then a check-in that already ended.
  e := pg_temp.err($q$select public.extend_checkin('c2000000-0000-4000-8000-000000000099', now() + interval '1 hour')$q$);
  perform pg_temp.ok('T21 extend with nothing open (pl:checkin.none)',
    e ->> 'hint' = 'pl:checkin.none'
    and e ->> 'msg' = 'You''re not checked in anywhere, so there''s nothing to extend. Check in when you''re at a court.', e::text);
  perform pg_temp.checkin('RA', 'c2000000-0000-4000-8000-000000000002', 'test:rf-court', 120, 40.3001);
  perform public.checkout_venue('c2000000-0000-4000-8000-000000000002', null, now());
  e := pg_temp.err($q$select public.extend_checkin('c2000000-0000-4000-8000-000000000002', now() + interval '1 hour')$q$);
  perform pg_temp.ok('T21 extend a check-in that ended: which court, when, what to do (pl:checkin.closed)',
    e ->> 'hint' = 'pl:checkin.closed'
    and e ->> 'msg' like 'Your check-in at RF Test Courts already ended (%). Check in again when you''re at the court.'
    and (e ->> 'detail')::jsonb ? 'ended_at'
    and e ->> 'msg' !~* 'expired', e::text);

  -- Extend past 4 hours after the last confirming fix, with no fix.
  perform pg_temp.checkin('RA', 'c2000000-0000-4000-8000-000000000003', 'test:rf-court', 120, 40.3001);
  perform pg_temp.as_admin();
  update public.venue_checkins
     set checked_in_at = now() - interval '4 hours', fix_at = now() - interval '4 hours',
         expires_at = now() + interval '1 minute'
   where id = 'c2000000-0000-4000-8000-000000000003';
  perform pg_temp.as_user(ra);
  e := pg_temp.err($q$select public.extend_checkin('c2000000-0000-4000-8000-000000000003', now() + interval '1 hour')$q$);
  perform pg_temp.ok('T21 extend with no fix 4 h on: when it last confirmed you, the rule, what to do (pl:checkin.needs_fix)',
    e ->> 'hint' = 'pl:checkin.needs_fix'
    and e ->> 'msg' like 'Pickleague last confirmed you at RF Test Courts (%), and a check-in lasts at most 4 hours past that. To stay checked in, open Pickleague at the court so it can confirm you''re still there.'
    and (e ->> 'detail')::jsonb ? 'last_fix_at', e::text);
  e := pg_temp.err($q$select public.extend_checkin(p_id => 'c2000000-0000-4000-8000-000000000003', p_until => now() + interval '1 hour',
    p_lat => 40.303, p_lng => -100.0, p_accuracy_m => 10, p_fix_at => now(), p_fix_age_ms => 1000)$q$);
  perform pg_temp.ok('T21 extend with a far fix (pl:fix.not_at_court, "stay checked in")',
    e ->> 'hint' = 'pl:fix.not_at_court' and e ->> 'msg' like 'You need to be at the court to stay checked in. You''re about % m away%', e::text);
  perform public.checkout_venue(null, null, now());

  -- Starts.
  e := pg_temp.err($q$select public.start_play_session(p_id => null, p_kind => 'open_play')$q$);
  perform pg_temp.ok('T21 a Start with no id (pl:request.bad)', e ->> 'hint' = 'pl:request.bad', e::text);
  perform pg_temp.as_user(pg_temp.p('RB'));
  perform public.start_play_session(p_id => 'f2000000-0000-4000-8000-000000000001', p_kind => 'open_play');
  perform public.end_play_session('f2000000-0000-4000-8000-000000000001', now());
  perform pg_temp.as_user(ra);
  e := pg_temp.err($q$select public.start_play_session(p_id => 'f2000000-0000-4000-8000-000000000001', p_kind => 'open_play')$q$);
  perform pg_temp.ok('T21 a Start whose id is another account''s session (pl:session.not_yours)',
    e ->> 'hint' = 'pl:session.not_yours'
    and e ->> 'msg' = 'That play session belongs to another account, so it wasn''t saved. Start a new session.', e::text);

  -- Courts and hiding.
  e := pg_temp.err($q$select public.set_court_favorite('test:rf-gone', true)$q$);
  perform pg_temp.ok('T21 starring a court that is gone (pl:court.gone)',
    e ->> 'hint' = 'pl:court.gone' and e ->> 'msg' = 'That court isn''t in Pickleague any more, so it can''t be starred.', e::text);
  e := pg_temp.err(format('select public.hide_presence_from(%L, true)', ra));
  perform pg_temp.ok('T21 hiding from yourself (pl:presence.pick_someone)',
    e ->> 'hint' = 'pl:presence.pick_someone' and e ->> 'msg' = 'You can''t hide from yourself. Pick another player.', e::text);
  e := pg_temp.err($q$select public.hide_presence_from('a2000000-0000-4000-8000-0000000000ff', true)$q$);
  perform pg_temp.ok('T21 hiding from an unknown player (pl:player.gone)',
    e ->> 'hint' = 'pl:player.gone'
    and e ->> 'msg' = 'We couldn''t find that player, so there''s nothing to hide from.', e::text);
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T21 block crashed', false, sqlerrm);
end $$;


-- ════ T22 match confirm + the pending-match notices ═════════════════════
do $$
declare
  e   jsonb;
  t   text;
  m1  uuid;
  m2  uuid;
  n   record;
begin
  -- RA (with partner RC) records a doubles match against RB and RD.
  perform pg_temp.as_user(pg_temp.p('RA'));
  insert into public.matches (league_id, player1_id, partner1_id, player2_id, partner2_id,
                              player1_score, player2_score, match_type, winner_id, winner_team, status)
  values ('b2000000-0000-4000-8000-000000000001', pg_temp.p('RA'), pg_temp.p('RC'), pg_temp.p('RB'), pg_temp.p('RD'),
          11, 5, 'doubles', pg_temp.p('RA'), 'team1', 'pending')
  returning id into m1;
  perform pg_temp.as_admin();
  select title, body into n from public.notifications where user_id = pg_temp.p('RC') and entity_id = m1;
  perform pg_temp.ok('T22 the recorder''s partner hears their team is confirmed, and the deadline',
    n.title = '🥒 Rita Recorder recorded your match'
    and n.body like 'In RF Test League: you won 11-5. Your team is confirmed. The other team has until % to confirm, or the match is removed.',
    n::text);
  select title, body into n from public.notifications where user_id = pg_temp.p('RB') and entity_id = m1;
  perform pg_temp.ok('T22 an opponent hears who recorded it and the deadline',
    n.title = '🥒 Match needs your team to confirm'
    and n.body like 'Rita Recorder entered a match in RF Test League: you lost 5-11. Confirm by % if that''s right, or it''s removed.',
    n::text);
  perform pg_temp.ok('T22 the recorder gets no notice',
    not exists (select 1 from public.notifications where user_id = pg_temp.p('RA') and entity_id = m1));

  perform pg_temp.as_user(pg_temp.p('RC'));
  t := public.confirm_match(m1);
  perform pg_temp.ok('T22 the partner''s stale Confirm -> already_your_team, still pending',
    t = 'already_your_team' and (select status from public.matches where id = m1) = 'pending', t);
  perform pg_temp.as_user(pg_temp.p('RB'));
  t := public.confirm_match(m1);
  perform pg_temp.ok('T22 the other team confirms -> completed', t = 'completed', t);
  e := pg_temp.err(format('select public.confirm_match(%L)', m1));
  perform pg_temp.ok('T22 Confirm on a confirmed match (pl:match.already_confirmed), "no longer pending" kept for 1.0.4',
    e ->> 'hint' = 'pl:match.already_confirmed'
    and e ->> 'msg' = 'This match is no longer pending: it''s already confirmed. Nothing more to do.', e::text);

  -- RN, a league member who didn't play, records RA vs RB: both teams confirm.
  perform pg_temp.as_user(pg_temp.p('RN'));
  insert into public.matches (league_id, player1_id, player2_id, player1_score, player2_score, match_type,
                              winner_id, winner_team, status)
  values ('b2000000-0000-4000-8000-000000000001', pg_temp.p('RA'), pg_temp.p('RB'), 11, 7, 'singles',
          pg_temp.p('RA'), 'team1', 'pending')
  returning id into m2;
  perform pg_temp.as_admin();
  select title, body into n from public.notifications where user_id = pg_temp.p('RA') and entity_id = m2;
  perform pg_temp.ok('T22 a match a non-player recorded names the real recorder and asks both teams',
    n.title = '🥒 Match needs your team to confirm'
    and n.body like 'Nell Nonplayer entered a match in RF Test League: you won 11-7. Both teams need to confirm by % if that''s right, or it''s removed.',
    n::text);
  perform pg_temp.as_user(pg_temp.p('RA'));
  t := public.confirm_match(m2);
  perform pg_temp.ok('T22 the first team to confirm it -> one_team_confirmed', t = 'one_team_confirmed', t);
  perform pg_temp.as_user(pg_temp.p('RN'));
  e := pg_temp.err(format('select public.confirm_match(%L)', m2));
  perform pg_temp.ok('T22 a non-player can''t confirm (pl:match.not_player)', e ->> 'hint' = 'pl:match.not_player', e::text);

  -- Past its deadline (the cron hasn't run yet), gone, scheduled.
  perform pg_temp.as_admin();
  insert into public.matches (id, league_id, player1_id, player2_id, player1_score, player2_score, match_type,
                              winner_id, winner_team, status, confirm_deadline, created_at)
  values ('e2000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', pg_temp.p('RA'), pg_temp.p('RB'),
          11, 4, 'singles', pg_temp.p('RA'), 'team1', 'pending', now() - interval '1 minute', now() - interval '61 minutes');
  insert into public.matches (id, league_id, player1_id, player2_id, player1_score, player2_score, match_type,
                              status, scheduled_at)
  values ('e2000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000001', pg_temp.p('RA'), pg_temp.p('RB'),
          11, 5, 'singles', 'scheduled', now() + interval '1 day');
  perform pg_temp.as_user(pg_temp.p('RA'));
  e := pg_temp.err($q$select public.confirm_match('e2000000-0000-4000-8000-000000000001')$q$);
  perform pg_temp.ok('T22 too late to confirm: when the hour ended, what to do (pl:match.confirm_expired)',
    e ->> 'hint' = 'pl:match.confirm_expired'
    and e ->> 'msg' like 'Too late to confirm: the hour to confirm this match expired (%). Ask whoever recorded it to enter it again.'
    and (e ->> 'detail')::jsonb ? 'deadline' and pg_temp.reads_nothing_to_answer(e ->> 'msg'), e::text);
  e := pg_temp.err($q$select public.confirm_match('e2000000-0000-4000-8000-0000000000ff')$q$);
  perform pg_temp.ok('T22 Confirm on a match that is gone (pl:match.removed), still "Nothing to answer" on 1.0.4',
    e ->> 'hint' = 'pl:match.removed' and e ->> 'msg' like 'This match was removed: it expired because%'
    and pg_temp.reads_nothing_to_answer(e ->> 'msg'), e::text);
  e := pg_temp.err($q$select public.confirm_match('e2000000-0000-4000-8000-000000000002')$q$);
  perform pg_temp.ok('T22 Confirm on a scheduled match (pl:match.scheduled)',
    e ->> 'hint' = 'pl:match.scheduled' and e ->> 'msg' like 'This match is no longer pending: it''s scheduled%', e::text);
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T22 block crashed', false, sqlerrm);
end $$;


-- ════ T23 the 1-hour expiry tells the players why ═══════════════════════
do $$
declare
  n   int;
  s   public.play_sessions;
  r   record;
begin
  -- RE played a 30-minute session; a match linked to it was never confirmed.
  perform pg_temp.as_user(pg_temp.p('RE'));
  perform public.start_play_session(p_id => 'f2000000-0000-4000-8000-000000000101', p_kind => 'open_play',
    p_at => now() - interval '50 minutes');
  perform public.end_play_session('f2000000-0000-4000-8000-000000000101', now() - interval '20 minutes');
  perform pg_temp.as_admin();
  insert into public.matches (id, league_id, player1_id, player2_id, player1_score, player2_score, match_type,
                              winner_id, winner_team, status, confirm_deadline, created_at, team1_confirmed_by,
                              play_session_id)
  values ('e2000000-0000-4000-8000-000000000101', 'b2000000-0000-4000-8000-000000000001', pg_temp.p('RE'), pg_temp.p('RB'),
          11, 6, 'singles', pg_temp.p('RE'), 'team1', 'pending', now() - interval '1 minute', now() - interval '25 minutes',
          pg_temp.p('RE'), 'f2000000-0000-4000-8000-000000000101');
  select * into s from public.play_sessions where id = 'f2000000-0000-4000-8000-000000000101';
  perform pg_temp.ok('T23 setup: the session counts through the pending match', s.valid, s::text);

  select public.expire_pending_matches() into n;
  perform pg_temp.ok('T23 the expiry still deletes and counts the expired matches',
    n >= 2 and not exists (select 1 from public.matches
                            where id in ('e2000000-0000-4000-8000-000000000101', 'e2000000-0000-4000-8000-000000000001')),
    n::text);
  select * into s from public.play_sessions where id = 'f2000000-0000-4000-8000-000000000101';
  perform pg_temp.ok('T23 ...and the session no longer counts', not s.valid, s::text);

  select title, body, entity_id, entity_type, category, push_data into r
    from public.notifications
   where user_id = pg_temp.p('RE') and push_data ->> 'kind' = 'match_expired';
  perform pg_temp.ok('T23 the recorder hears why the match is gone, and that the session stopped counting',
    r.title = '🥒 Match removed'
    and r.body like 'Your match vs Ben Opponent (recorded %) was removed because the other team didn''t confirm it within an hour. Record it again and ask them to confirm. Your play session from % no longer counts. Record a match or drill by % to make it count.',
    r::text);
  perform pg_temp.ok('T23 ...as a result notice that opens Match History, not a greyed-out link to a deleted row',
    r.entity_id is null and r.entity_type = 'match' and r.category = 'notifyMatchResults'
    and r.push_data ->> 'deep_link' = 'match/-', r::text);
  perform pg_temp.ok('T23 the opponent hears their team didn''t confirm in time',
    exists (select 1 from public.notifications
             where user_id = pg_temp.p('RB') and push_data ->> 'kind' = 'match_expired'
               and body like 'Your match vs Ezra Expiry (recorded %) was removed because your team didn''t confirm it within an hour.%'));
  perform pg_temp.ok('T23 a match neither team confirmed says so',
    exists (select 1 from public.notifications
             where user_id = pg_temp.p('RA') and push_data ->> 'kind' = 'match_expired'
               and body like 'Your match vs Ben Opponent (recorded %) was removed because neither team confirmed it within an hour.%'));
  perform pg_temp.ok('T23 the push carries the Match History link',
    exists (select 1 from public.push_outbox o join public.notifications nt on nt.id = o.notification_id
             where nt.user_id = pg_temp.p('RE') and nt.push_data ->> 'kind' = 'match_expired'
               and o.deep_link = 'match/-'));
  perform pg_temp.ok('T23 a pending match still inside its hour is kept',
    exists (select 1 from public.matches m
             where m.league_id = 'b2000000-0000-4000-8000-000000000001' and m.status = 'pending'
               and m.player1_id = pg_temp.p('RA') and m.player1_score = 11 and m.player2_score = 7));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T23 block crashed', false, sqlerrm);
end $$;


-- ════ T24 what my_session_validity adds ═════════════════════════════════
do $$
declare
  j  jsonb;
  t  text;
begin
  -- RS: two sessions; a match recorded now falls in both windows and counts
  -- for the later one only.
  perform pg_temp.as_user(pg_temp.p('RS'));
  perform public.start_play_session(p_id => 'f2000000-0000-4000-8000-000000000201', p_kind => 'open_play',
    p_at => now() - interval '80 minutes');
  perform public.end_play_session('f2000000-0000-4000-8000-000000000201', now() - interval '40 minutes');
  perform public.start_play_session(p_id => 'f2000000-0000-4000-8000-000000000202', p_kind => 'open_play',
    p_at => now() - interval '30 minutes');
  perform public.end_play_session('f2000000-0000-4000-8000-000000000202', now() - interval '10 minutes');
  insert into public.matches (league_id, player1_id, player2_id, player1_score, player2_score, match_type,
                              winner_id, winner_team, status)
  values ('b2000000-0000-4000-8000-000000000001', pg_temp.p('RS'), pg_temp.p('RT'), 11, 3, 'singles',
          pg_temp.p('RS'), 'team1', 'pending');

  j := public.my_session_validity('f2000000-0000-4000-8000-000000000201');
  perform pg_temp.ok('T24 the earlier session says the match counted for the later one',
    not (j ->> 'valid')::boolean and j ->> 'needs' = 'match_or_drill'
    and j ->> 'why' = 'match_counted_elsewhere'
    and (j ->> 'match_at')::timestamptz = now()
    and (j ->> 'counted_for_started_at')::timestamptz = now() - interval '30 minutes', j::text);
  perform pg_temp.ok('T24 ...with its stored start and end',
    (j ->> 'started_at')::timestamptz = now() - interval '80 minutes'
    and (j ->> 'ended_at')::timestamptz = now() - interval '40 minutes', j::text);
  j := public.my_session_validity('f2000000-0000-4000-8000-000000000202');
  perform pg_temp.ok('T24 the session the match counts for is pending until the other team confirms, by when',
    (j ->> 'valid')::boolean and (j ->> 'match_pending')::boolean
    and (j ->> 'rewards_pending_confirmation')::boolean
    and (j ->> 'confirm_by')::timestamptz = now() + interval '1 hour' and not j ? 'why', j::text);

  -- A late Start that overlaps the last one is moved; the stored start shows it.
  perform public.start_play_session(p_id => 'f2000000-0000-4000-8000-000000000203', p_kind => 'open_play',
    p_at => now() - interval '15 minutes');
  perform public.end_play_session('f2000000-0000-4000-8000-000000000203', now() - interval '7 minutes');
  j := public.my_session_validity('f2000000-0000-4000-8000-000000000203');
  perform pg_temp.ok('T24 a Start moved by the no-overlap rule shows its stored start (too short by the server)',
    j ->> 'reason' = 'too_short' and (j ->> 'started_at')::timestamptz = now() - interval '10 minutes', j::text);

  -- RW reviews an old drill during a session: it doesn't count, and says why.
  perform pg_temp.as_user(pg_temp.p('RW'));
  perform public.start_play_session(p_id => 'f2000000-0000-4000-8000-000000000204', p_kind => 'open_play',
    p_at => now() - interval '40 minutes');
  perform public.end_play_session('f2000000-0000-4000-8000-000000000204', now() - interval '10 minutes');
  perform pg_temp.as_admin();
  insert into public.drill_sessions (id, player1_id, player2_id, session_date, session_slot, starts_at, length_minutes)
  values ('d2000000-0000-4000-8000-000000000001', pg_temp.p('RW'), pg_temp.p('RT'), current_date - 1, 36,
          now() - interval '1 day', 60);
  perform pg_temp.as_user(pg_temp.p('RW'));
  perform public.submit_drill_review('d2000000-0000-4000-8000-000000000001', 4, 4, 4, 4, 4, null);
  j := public.my_session_validity('f2000000-0000-4000-8000-000000000204');
  perform pg_temp.ok('T24 a drill reviewed in the window but held another day: why, and when it was',
    not (j ->> 'valid')::boolean and j ->> 'why' = 'drill_not_during_session'
    and (j ->> 'drill_starts_at')::timestamptz = now() - interval '1 day', j::text);

  -- Still null for a session that isn't mine.
  perform pg_temp.as_user(pg_temp.p('RT'));
  perform pg_temp.ok('T24 another player''s session is still null',
    public.my_session_validity('f2000000-0000-4000-8000-000000000204') is null);
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T24 block crashed', false, sqlerrm);
end $$;


-- ════ T25 drill review answers ══════════════════════════════════════════
do $$
declare
  r record;
begin
  perform pg_temp.as_admin();
  insert into public.drill_sessions (id, player1_id, player2_id, session_date, session_slot, starts_at, length_minutes)
  values ('d2000000-0000-4000-8000-000000000002', pg_temp.p('RW'), pg_temp.p('RT'), current_date + 1, 36,
          now() + interval '1 day', 60);
  perform pg_temp.as_user(pg_temp.p('RW'));
  select * into r from public.submit_drill_review('d2000000-0000-4000-8000-000000000002', 4, null, null, null, null, null);
  perform pg_temp.ok('T25 too early: when it starts, then what to do',
    not r.success and r.message like 'This drill starts %. You can review it after it starts.', r::text);
  select * into r from public.submit_drill_review('d2000000-0000-4000-8000-000000000001', 4, null, null, null, null, null);
  perform pg_temp.ok('T25 a second review', not r.success
    and r.message = 'You already reviewed this drill. Each drill gets one review.', r::text);
  select * into r from public.submit_drill_review('d2000000-0000-4000-8000-0000000000ff', 4, null, null, null, null, null);
  perform pg_temp.ok('T25 a drill that is gone', not r.success
    and r.message = 'This drill was cancelled or removed, so it can''t be reviewed.', r::text);
  perform pg_temp.as_user(pg_temp.p('RN'));
  select * into r from public.submit_drill_review('d2000000-0000-4000-8000-000000000001', 4, null, null, null, null, null);
  perform pg_temp.ok('T25 someone else''s drill', not r.success
    and r.message = 'Only the two players in this drill can review it.', r::text);
  perform pg_temp.as_user(pg_temp.p('RT'));
  select * into r from public.submit_drill_review('d2000000-0000-4000-8000-000000000001', null, null, null, null, null, null);
  perform pg_temp.ok('T25 nothing rated', not r.success and r.message = 'Rate at least one thing to send your review.', r::text);
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T25 block crashed', false, sqlerrm);
end $$;


-- ════ T26 friends ═══════════════════════════════════════════════════════
do $$
declare
  e  jsonb;
  t  text;
begin
  perform pg_temp.as_user(pg_temp.p('RQ'));
  perform public.send_friend_request(pg_temp.p('RR'));
  perform pg_temp.as_user(pg_temp.p('RR'));
  t := public.respond_friend_request(pg_temp.p('RQ'), false);
  perform pg_temp.ok('T26 decline -> declined', t = 'declined', t);
  t := public.respond_friend_request(pg_temp.p('RQ'), true);
  perform pg_temp.ok('T26 Accept on a request I declined -> already_declined (never "declined" to an Accept)',
    t = 'already_declined' and (select status from public.friendships
                                 where requester_id = pg_temp.p('RQ') and addressee_id = pg_temp.p('RR')) = 'declined', t);
  t := public.respond_friend_request(pg_temp.p('RQ'), false);
  perform pg_temp.ok('T26 a Decline replay still reads declined', t = 'declined', t);

  perform pg_temp.as_user(pg_temp.p('RQ'));
  perform public.send_friend_request(pg_temp.p('RC'));
  perform pg_temp.as_user(pg_temp.p('RC'));
  perform public.respond_friend_request(pg_temp.p('RQ'), true);
  perform pg_temp.as_user(pg_temp.p('RQ'));
  t := public.send_friend_request(pg_temp.p('RC'));
  perform pg_temp.ok('T26 Add friend on a friend -> already_friends', t = 'already_friends', t);

  e := pg_temp.err(format('select public.set_close_friend(%L, true)', pg_temp.p('RR')));
  perform pg_temp.ok('T26 starring a non-friend names them (pl:friend.not_friends)',
    e ->> 'hint' = 'pl:friend.not_friends'
    and e ->> 'msg' = 'You and Remy Decliner aren''t friends, so they can''t be a close friend.', e::text);
  e := pg_temp.err('select public.send_friend_request(null)');
  perform pg_temp.ok('T26 no player (pl:player.gone)', e ->> 'hint' = 'pl:player.gone', e::text);
  e := pg_temp.err(format('select public.send_friend_request(%L)', pg_temp.p('RQ')));
  perform pg_temp.ok('T26 yourself (pl:friend.self)', e ->> 'hint' = 'pl:friend.self', e::text);
  e := pg_temp.err(format('select public.send_friend_request(%L)', pg_temp.p('U')));
  perform pg_temp.ok('T26 an unclaimed profile (pl:friend.unclaimed)', e ->> 'hint' = 'pl:friend.unclaimed', e::text);
  e := pg_temp.err(format('select public.send_friend_request(%L)', pg_temp.p('G')));
  perform pg_temp.ok('T26 a guest pass (pl:friend.guest)', e ->> 'hint' = 'pl:friend.guest', e::text);
  e := pg_temp.err(format('select public.send_friend_request(%L)', pg_temp.p('D')));
  perform pg_temp.ok('T26 a deleted account gets the vague line (pl:friend.unavailable)',
    e ->> 'hint' = 'pl:friend.unavailable' and e ->> 'msg' = 'This player isn''t available', e::text);
  perform pg_temp.as_user(pg_temp.p('O'));
  e := pg_temp.err(format('select public.send_friend_request(%L)', pg_temp.p('K')));
  perform pg_temp.ok('T26 a block gets the same vague line as a deleted account',
    e ->> 'hint' = 'pl:friend.unavailable' and e ->> 'msg' = 'This player isn''t available', e::text);
  perform pg_temp.as_user(pg_temp.p('G'));
  e := pg_temp.err(format('select public.send_friend_request(%L)', pg_temp.p('RQ')));
  perform pg_temp.ok('T26 a guest caller (pl:friend.guest_caller)', e ->> 'hint' = 'pl:friend.guest_caller', e::text);
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T26 block crashed', false, sqlerrm);
end $$;


-- ════ T27 signatures, attributes, grants, words ═════════════════════════
do $$
declare
  bad text;
begin
  perform pg_temp.as_admin();
  -- Every replaced function keeps its live identity signature and attributes
  -- (checked against the live database on 2026-10-16).
  with want(fn, args, definer, cfg) as (values
    ('_pl_raise_unconfirmed_fix', 'p_fresh boolean, p_precise boolean, p_confirmed boolean, p_distance_m double precision, p_had_age boolean, p_what text', false, 'search_path=""'),
    ('_pl_require_fix_shape', 'p_lat double precision, p_lng double precision', false, 'search_path=""'),
    ('checkin_venue', 'p_id uuid, p_venue text, p_minutes integer, p_source text, p_at timestamp with time zone, p_lat double precision, p_lng double precision, p_accuracy_m double precision, p_fix_at timestamp with time zone, p_fix_age_ms double precision', true, 'search_path=""'),
    ('extend_checkin', 'p_id uuid, p_until timestamp with time zone, p_lat double precision, p_lng double precision, p_accuracy_m double precision, p_fix_at timestamp with time zone, p_fix_age_ms double precision', true, 'search_path=""'),
    ('checkout_venue', 'p_id uuid, p_source text, p_at timestamp with time zone, p_lat double precision, p_lng double precision, p_accuracy_m double precision, p_fix_age_ms double precision', true, 'search_path=""'),
    ('start_play_session', 'p_id uuid, p_kind text, p_source uuid, p_venue text, p_at timestamp with time zone, p_lat double precision, p_lng double precision, p_accuracy_m double precision, p_fix_at timestamp with time zone, p_fix_age_ms double precision', true, 'search_path=""'),
    ('end_play_session', 'p_id uuid, p_at timestamp with time zone, p_lat double precision, p_lng double precision, p_accuracy_m double precision, p_fix_age_ms double precision', true, 'search_path=""'),
    ('resolve_court', 'p_lat double precision, p_lng double precision, p_radius_m double precision, p_sport text', true, 'search_path=""'),
    ('my_session_validity', 'p_session uuid', true, 'search_path=""'),
    ('confirm_match', 'p_match_id uuid', true, null),
    ('_notify_pending_match', '', true, null),
    ('expire_pending_matches', '', true, null),
    ('submit_drill_review', 'p_session_id uuid, p_consistency integer, p_effort integer, p_organization integer, p_intentionality integer, p_fun integer, p_notes text', true, null),
    ('send_friend_request', 'p_user uuid', true, 'search_path=""'),
    ('respond_friend_request', 'p_user uuid, p_accept boolean', true, 'search_path=""'),
    ('cancel_friend_request', 'p_user uuid', true, 'search_path=""'),
    ('remove_friend', 'p_user uuid', true, 'search_path=""'),
    ('set_close_friend', 'p_user uuid, p_on boolean', true, 'search_path=""'),
    ('friendship_status_with', 'p_user uuid', true, 'search_path=""'),
    ('venue_crowd', 'p_venue_ids text[]', true, 'search_path=""'),
    ('friends_at_courts', 'p_hours integer', true, 'search_path=""'),
    ('set_presence_settings', 'p_checkins_level text, p_plans_level text, p_paused_until timestamp with time zone, p_clear_pause boolean, p_consent_seen boolean', true, 'search_path=""'),
    ('hide_presence_from', 'p_user uuid, p_hidden boolean', true, 'search_path=""'),
    ('set_court_favorite', 'p_venue text, p_on boolean', true, 'search_path=""'))
  select string_agg(w.fn || ' ' || coalesce(got.n::text, '0') || ' version(s)', '; ')
    into bad
    from want w
    left join lateral (
      select count(*) as n,
             bool_and(pg_get_function_identity_arguments(p.oid) = w.args
                      and p.prosecdef = w.definer
                      and array_to_string(p.proconfig, ',') is not distinct from w.cfg) as same
        from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
       where ns.nspname = 'public' and p.proname = w.fn) got on true
   where got.n is distinct from 1 or not got.same;
  perform pg_temp.ok('T27 every replaced function keeps its one live signature, definer and search_path',
    bad is null, bad);

  perform pg_temp.ok('T27 the new helpers are closed to clients',
    not has_function_privilege('authenticated', 'public._pl_session_explain(uuid)', 'execute')
    and not has_function_privilege('anon', 'public._pl_session_explain(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._pl_notify_match_expired(public.matches, uuid[])', 'execute')
    and not has_function_privilege('anon', 'public._pl_notify_match_expired(public.matches, uuid[])', 'execute'));
  perform pg_temp.ok('T27 the client RPCs are still open to signed-in players',
    has_function_privilege('authenticated', 'public.my_session_validity(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.confirm_match(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.send_friend_request(uuid)', 'execute')
    and has_function_privilege('authenticated',
          'public.extend_checkin(uuid, timestamptz, double precision, double precision, double precision, timestamptz, double precision)',
          'execute'));

  -- No refusal text uses a word 1.0.4 reads as "no connection" (it would queue
  -- the refused write and replay it), as an auth or permission failure, or
  -- carries an em dash.
  select string_agg(distinct msg, ' | ') into bad
    from _rf_msgs
   where msg ~* '(failed to fetch|network request failed|networkerror|fetch failed|load failed|timed out|network connection was lost|internet connection appears to be offline|jwt|refresh token|permission denied|row-level security)'
      or msg like '%—%';
  perform pg_temp.ok('T27 no refusal text uses a network, auth or permission word, or an em dash',
    bad is null and (select count(*) from _rf_msgs) >= 40, coalesce(bad, (select count(*) from _rf_msgs)::text));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('T27 block crashed', false, sqlerrm);
end $$;
