-- ============================================================
-- Presence Phase 1.5 persona tests: validity rules
-- (docs/play-sessions-presence.md "Phase 1.5"; migration_validity_rules.sql).
--
-- NOT runnable on its own: build-presence-test.mjs splices it into
-- presence_p1_personas.sql at -- @@VALIDITY@@, after the Phase 1 sections
-- and before the results, so it reuses that file's harness (_p, _results,
-- pg_temp.p / ok / as_user / as_admin / checkin) inside the same rolled-back
-- transaction. now() is fixed for the whole transaction.
--
-- Personas (P15 Validity League, open, every one a member):
--   V1 short session · V2 linked match, then confirmed · V3 match in the
--   window, then expired · V4 match after the window · V5 bystander (other
--   players' matches) · V6 drill · V7 open session · V8 broken refresh ·
--   VO opponent / recorder · VF another player · VS stay proof, at court
--   test:p15-court (40.2 N, 100.0 W) · VT stay timing (backdated arrival) ·
--   VE End as a check-out · VX sessions stacked around one match · VH two
--   honest sessions · VK a too-short session after a real one · VW a
--   backdated match · VG a client asserting confirmations · VQ a scheduled
--   match · VD an old drill and a moved one · VJ one drill, two sessions ·
--   VC at the court or not
-- ============================================================

insert into _p values
  ('V1', 'a1500000-0000-4000-8000-000000000001'), ('V2', 'a1500000-0000-4000-8000-000000000002'),
  ('V3', 'a1500000-0000-4000-8000-000000000003'), ('V4', 'a1500000-0000-4000-8000-000000000004'),
  ('V5', 'a1500000-0000-4000-8000-000000000005'), ('V6', 'a1500000-0000-4000-8000-000000000006'),
  ('V7', 'a1500000-0000-4000-8000-000000000007'), ('V8', 'a1500000-0000-4000-8000-000000000008'),
  ('VO', 'a1500000-0000-4000-8000-000000000009'), ('VF', 'a1500000-0000-4000-8000-00000000000a'),
  ('VS', 'a1500000-0000-4000-8000-00000000000b'), ('VT', 'a1500000-0000-4000-8000-00000000000c'),
  ('VE', 'a1500000-0000-4000-8000-00000000000d'), ('VX', 'a1500000-0000-4000-8000-00000000000e'),
  ('VH', 'a1500000-0000-4000-8000-00000000000f'), ('VK', 'a1500000-0000-4000-8000-000000000010'),
  ('VW', 'a1500000-0000-4000-8000-000000000011'), ('VG', 'a1500000-0000-4000-8000-000000000012'),
  ('VQ', 'a1500000-0000-4000-8000-000000000013'), ('VD', 'a1500000-0000-4000-8000-000000000014'),
  ('VJ', 'a1500000-0000-4000-8000-000000000015'), ('VC', 'a1500000-0000-4000-8000-000000000016');

insert into auth.users (id, email, raw_user_meta_data)
select id, 'p15-' || lower(k) || '@pickleague.test', jsonb_build_object('full_name', 'P15 Player ' || k)
  from _p where k like 'V%' and id::text like 'a1500000-%';

insert into public.venues (id, sport, name, kind, lat, lng, source, geofence_radius_m)
values ('test:p15-court', array['pickleball'], 'P15 Test Courts', 'court', 40.2, -100.0, 'google', 100);

insert into public.leagues (id, name, is_open, created_by)
values ('b1500000-0000-4000-8000-000000000001', 'P15 Validity League', true, pg_temp.p('VO'));
insert into public.league_members (league_id, user_id, role)
select 'b1500000-0000-4000-8000-000000000001', id, case when k = 'VO' then 'admin' else 'member' end
  from _p where k like 'V%' and id::text like 'a1500000-%'
on conflict do nothing;

-- A play session for persona k: started p_started ago, ended p_ended ago
-- (null: still open). Leaves the role as k.
create function pg_temp.vsession(k text, p_id uuid, p_started interval, p_ended interval default null)
returns void language plpgsql as $$
begin
  perform pg_temp.as_user(pg_temp.p(k));
  perform public.start_play_session(p_id => p_id, p_kind => 'open_play', p_at => now() - p_started);
  if p_ended is not null then
    perform public.end_play_session(p_id, now() - p_ended);
  end if;
end $$;

-- A singles match p1 vs p2 (p1 won 11-5) recorded by `recorder` under RLS, as
-- MatchEntry inserts it: pending, the recorder's team confirmed. Leaves the
-- role as the recorder.
create function pg_temp.vmatch(recorder text, p1 text, p2 text, p_session uuid default null)
returns uuid language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.as_user(pg_temp.p(recorder));
  insert into public.matches (league_id, player1_id, player2_id, player1_score, player2_score, match_type,
                              winner_id, winner_team, status, confirm_deadline,
                              team1_confirmed_by, team2_confirmed_by, play_session_id)
  values ('b1500000-0000-4000-8000-000000000001', pg_temp.p(p1), pg_temp.p(p2), 11, 5, 'singles',
          pg_temp.p(p1), 'team1', 'pending', now() + interval '1 hour',
          case when recorder = p1 then pg_temp.p(recorder) end,
          case when recorder = p2 then pg_temp.p(recorder) end,
          p_session)
  returning id into v;
  return v;
end $$;

-- A pending singles match p1 vs p2 written by the server (no signed-in
-- caller, so the insert guard leaves its times alone), recorded at p_at.
-- Leaves the role as admin.
create function pg_temp.vmatch_at(p1 text, p2 text, p_at timestamptz)
returns uuid language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.as_admin();
  insert into public.matches (league_id, player1_id, player2_id, player1_score, player2_score, match_type,
                              winner_id, winner_team, status, confirm_deadline, created_at, played_at)
  values ('b1500000-0000-4000-8000-000000000001', pg_temp.p(p1), pg_temp.p(p2), 11, 5, 'singles',
          pg_temp.p(p1), 'team1', 'pending', now() + interval '1 hour', p_at, p_at)
  returning id into v;
  return v;
end $$;

-- my_session_validity as persona k. Leaves the role as k.
create function pg_temp.validity(k text, p_session uuid) returns jsonb language plpgsql as $$
declare j jsonb;
begin
  perform pg_temp.as_user(pg_temp.p(k));
  j := public.my_session_validity(p_session);
  return j;
end $$;

-- The stored session row (read past RLS). Leaves the role as admin.
create function pg_temp.vrow(p_session uuid) returns public.play_sessions language plpgsql as $$
declare s public.play_sessions;
begin
  perform pg_temp.as_admin();
  select * into s from public.play_sessions where id = p_session;
  return s;
end $$;

-- A confirmed check-in for VS at the test court, moved 30 minutes into the
-- past (arrival fix and stored time included) unless p_now. Leaves the role
-- as VS.
create function pg_temp.vstay_checkin(p_id uuid, p_now boolean default false)
returns void language plpgsql as $$
begin
  perform pg_temp.checkin('VS', p_id, 'test:p15-court', 120, 40.2001);
  if not p_now then
    perform pg_temp.as_admin();
    update public.venue_checkins
       set checked_in_at = now() - interval '30 minutes', fix_at = now() - interval '30 minutes',
           arrival_fix_at = now() - interval '30 minutes', created_at = now() - interval '30 minutes'
     where id = p_id;
  end if;
  perform pg_temp.as_user(pg_temp.p('VS'));
end $$;

create function pg_temp.vci(p_id uuid) returns public.venue_checkins language plpgsql as $$
declare r public.venue_checkins;
begin
  perform pg_temp.as_admin();
  select * into r from public.venue_checkins where id = p_id;
  return r;
end $$;


-- ════ V1 grants, signatures, triggers, backfill ══════════════════════════
do $$
declare
  f text;
  v_bad text;
  v_internal text[] := array[
    'public._pl_session_validity(uuid)', 'public._pl_refresh_session_validity(uuid)',
    'public._pl_sessions_around(uuid,uuid[],timestamptz)',
    'public._pl_match_session(uuid,uuid,timestamptz)',
    'public._pl_drill_session(uuid,uuid,timestamptz,timestamptz,integer)',
    'public._pl_record_checkout_fix(uuid[],double precision,double precision,double precision,double precision)',
    'public._pl_matches_link_session()', 'public._pl_matches_refresh_validity()',
    'public._pl_matches_client_insert_guard()', 'public._pl_play_sessions_no_overlap()',
    'public._pl_drill_reviews_refresh_validity()', 'public._pl_play_sessions_refresh_validity()',
    'public._pl_checkin_stay_from_fix()', 'public._pl_checkin_arrival_fix()'];
begin
  -- The hardening file ran after the last run of migration_validity_rules.sql.
  perform pg_temp.ok('V1 authenticated may execute my_session_validity (allowlisted: the hardening re-run kept it)',
    to_regprocedure('public.my_session_validity(uuid)') is not null
    and has_function_privilege('authenticated', 'public.my_session_validity(uuid)', 'EXECUTE'));
  perform pg_temp.ok('V1 anon may not execute my_session_validity',
    not has_function_privilege('anon', 'public.my_session_validity(uuid)', 'EXECUTE'));
  foreach f in array v_internal loop
    perform pg_temp.ok('V1 internal, clients may not execute ' || f,
      to_regprocedure(f) is not null
      and not has_function_privilege('authenticated', f, 'EXECUTE')
      and not has_function_privilege('anon', f, 'EXECUTE'));
  end loop;
  -- migration_presence_p1_checkins.sql was re-run after this file: its guards
  -- kept the Phase 1.5 checkout_venue and end_play_session, and only those.
  perform pg_temp.ok('V1 one checkout_venue, with every Phase 1 parameter first and the fix after',
    (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'checkout_venue') = 1
    and (select pg_get_function_identity_arguments(oid) from pg_proc
          where pronamespace = 'public'::regnamespace and proname = 'checkout_venue')
        = 'p_id uuid, p_source text, p_at timestamp with time zone, p_lat double precision, p_lng double precision, p_accuracy_m double precision, p_fix_age_ms double precision',
    (select string_agg(pg_get_function_identity_arguments(oid), ' | ') from pg_proc
      where pronamespace = 'public'::regnamespace and proname = 'checkout_venue'));
  perform pg_temp.ok('V1 every checkout_venue parameter has a default (1.0.4 sends only p_id, p_source)',
    (select pronargdefaults = 7 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'checkout_venue'));
  perform pg_temp.ok('V1 one end_play_session, with p_id and p_at first and the fix after',
    (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'end_play_session') = 1
    and (select pg_get_function_identity_arguments(oid) from pg_proc
          where pronamespace = 'public'::regnamespace and proname = 'end_play_session')
        = 'p_id uuid, p_at timestamp with time zone, p_lat double precision, p_lng double precision, p_accuracy_m double precision, p_fix_age_ms double precision',
    (select string_agg(pg_get_function_identity_arguments(oid), ' | ') from pg_proc
      where pronamespace = 'public'::regnamespace and proname = 'end_play_session'));
  perform pg_temp.ok('V1 every end_play_session parameter after p_id has a default (1.0.4 sends {p_id, p_at})',
    (select pronargdefaults = 5 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'end_play_session'));
  select string_agg(t, ', ') into v_bad
    from unnest(array['matches.trg_matches_link_session', 'matches.trg_matches_session_validity',
                      'matches.a_matches_client_insert_guard',
                      'play_sessions.trg_play_sessions_validity', 'play_sessions.trg_play_sessions_no_overlap',
                      'drill_session_reviews.trg_drill_reviews_session_validity',
                      'venue_checkins.trg_venue_checkins_stay', 'venue_checkins.trg_venue_checkins_arrival']) t
   where not exists (select 1 from pg_trigger g join pg_class c on c.oid = g.tgrelid
                      where c.relnamespace = 'public'::regnamespace
                        and c.relname || '.' || g.tgname = t and not g.tgisinternal);
  perform pg_temp.ok('V1 the eight validity triggers exist', v_bad is null, v_bad);
  -- BEFORE triggers fire in name order: the guard must run before PLUPR.
  perform pg_temp.ok('V1 the match insert guard fires before on_match_completed (PLUPR)',
    exists (select 1 from pg_trigger where tgrelid = 'public.matches'::regclass and tgname = 'on_match_completed')
    and 'a_matches_client_insert_guard' collate "C" < 'on_match_completed' collate "C");
  perform pg_temp.ok('V1 matches.play_session_id -> play_sessions on delete set null, indexed',
    exists (select 1 from pg_constraint
             where conrelid = 'public.matches'::regclass and contype = 'f' and confdeltype = 'n'
               and confrelid = 'public.play_sessions'::regclass)
    and exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'matches_play_session_id_idx'));
  perform pg_temp.ok('V1 the match insert policy names only my own session',
    (select with_check like '%play_session_id%' and with_check like '%play_sessions%' and with_check like '%auth.uid()%'
       from pg_policies where schemaname = 'public' and tablename = 'matches'
        and policyname = 'League members can record matches'));
  perform pg_temp.ok('V1 clients may update only a drill session''s notes and reminder dismissals',
    not has_table_privilege('authenticated', 'public.drill_sessions', 'UPDATE')
    and not has_column_privilege('authenticated', 'public.drill_sessions', 'starts_at', 'UPDATE')
    and not has_column_privilege('authenticated', 'public.drill_sessions', 'session_date', 'UPDATE')
    and not has_column_privilege('authenticated', 'public.drill_sessions', 'length_minutes', 'UPDATE')
    and has_column_privilege('authenticated', 'public.drill_sessions', 'reminder_dismissed_by', 'UPDATE')
    and has_column_privilege('authenticated', 'public.drill_sessions', 'notes', 'UPDATE')
    and not has_column_privilege('anon', 'public.drill_sessions', 'reminder_dismissed_by', 'UPDATE'));
  -- Not an arrival check-in (migration_court_arrival_queue.sql, applied
  -- before these personas): it has no fix, so no arrival fix until a real one.
  perform pg_temp.ok('V1 every confirmed check-in knows when its arrival fix was taken (backfill + insert trigger)',
    not exists (select 1 from public.venue_checkins where location_confirmed and arrival_fix_at is null and not via_arrival),
    (select count(*)::text from public.venue_checkins where location_confirmed and arrival_fix_at is null and not via_arrival));
  perform pg_temp.ok('V1 every ended session has been judged (backfill + the End trigger)',
    not exists (select 1 from public.play_sessions where ended_at is not null and valid_reason is null),
    (select count(*)::text from public.play_sessions where ended_at is not null and valid_reason is null));
  perform pg_temp.ok('V1 no open session counts',
    not exists (select 1 from public.play_sessions where ended_at is null and valid));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('V1 block crashed', false, sqlerrm);
end $$;


-- ════ V2 sessions: too short, linked, in the window, too late ════════════
do $$
declare
  j  jsonb;
  s  public.play_sessions;
  m  uuid;
  m2 uuid;
begin
  -- V1: exactly 5 minutes (20 to 15 min ago), then 4 minutes (4 min ago to
  -- now) with a linked match. Sessions never overlap, so oldest first.
  perform pg_temp.vsession('V1', 'f1500000-0000-4000-8000-000000000102', interval '20 minutes', interval '15 minutes');
  perform pg_temp.vsession('V1', 'f1500000-0000-4000-8000-000000000101', interval '4 minutes', interval '0 minutes');
  m := pg_temp.vmatch('V1', 'V1', 'VO', 'f1500000-0000-4000-8000-000000000101');
  perform pg_temp.as_admin();
  perform pg_temp.ok('V2 (setup) the short session''s match is linked',
    (select play_session_id from public.matches where id = m) = 'f1500000-0000-4000-8000-000000000101');
  s := pg_temp.vrow('f1500000-0000-4000-8000-000000000101');
  perform pg_temp.ok('V2 a 4-minute session does not count, even with a linked match',
    not s.valid and s.valid_reason = 'too_short' and s.validated_at is null, s::text);
  j := pg_temp.validity('V1', 'f1500000-0000-4000-8000-000000000101');
  perform pg_temp.ok('V2 ...my_session_validity says it needed more minutes',
    j ->> 'valid' = 'false' and j ->> 'reason' = 'too_short' and j ->> 'needs' = 'minutes', j::text);
  -- A too-short session never takes the match: it counts for the 5-minute
  -- one, whose window holds it.
  s := pg_temp.vrow('f1500000-0000-4000-8000-000000000102');
  perform pg_temp.ok('V2 exactly 5 minutes with a match in the window counts (the too-short session can''t take it)',
    s.valid and s.valid_reason = 'match_in_window', s::text);

  -- V2: 30 minutes, then a linked match (pending), then confirmed.
  perform pg_temp.vsession('V2', 'f1500000-0000-4000-8000-000000000201', interval '40 minutes', interval '10 minutes');
  s := pg_temp.vrow('f1500000-0000-4000-8000-000000000201');
  perform pg_temp.ok('V2 30 minutes and nothing recorded: not yet',
    not s.valid and s.valid_reason = 'no_match_or_drill', s::text);
  j := pg_temp.validity('V2', 'f1500000-0000-4000-8000-000000000201');
  perform pg_temp.ok('V2 ...needs a match or drill by ended + 2 h',
    j ->> 'valid' = 'false' and j ->> 'needs' = 'match_or_drill'
    and (j ->> 'window_ends_at')::timestamptz = now() - interval '10 minutes' + interval '2 hours', j::text);
  m := pg_temp.vmatch('V2', 'V2', 'VO', 'f1500000-0000-4000-8000-000000000201');
  s := pg_temp.vrow('f1500000-0000-4000-8000-000000000201');
  perform pg_temp.ok('V2 a linked match makes it count; pending, so its rewards wait',
    s.valid and s.valid_reason = 'linked_match' and s.rewards_pending_confirmation and s.validated_at = now(), s::text);
  j := pg_temp.validity('V2', 'f1500000-0000-4000-8000-000000000201');
  perform pg_temp.ok('V2 ...my_session_validity: valid, nothing needed',
    j ->> 'valid' = 'true' and j ->> 'reason' = 'linked_match' and j -> 'needs' = 'null'::jsonb
    and (j ->> 'rewards_pending_confirmation')::boolean and j ? 'at_court', j::text);
  perform pg_temp.as_user(pg_temp.p('VO'));
  perform public.confirm_match(m);
  s := pg_temp.vrow('f1500000-0000-4000-8000-000000000201');
  perform pg_temp.ok('V2 the other team confirms: rewards no longer wait, still valid since the same moment',
    (select status from public.matches where id = m) = 'completed'
    and s.valid and not s.rewards_pending_confirmation and s.validated_at = now(), s::text);
  perform pg_temp.ok('V2 someone else asking about my session gets nothing',
    pg_temp.validity('VO', 'f1500000-0000-4000-8000-000000000201') is null);
  perform pg_temp.ok('V2 an unknown session (a Start still queued) gets nothing, no error',
    pg_temp.validity('V2', 'f1500000-0000-4000-8000-0000000002ff') is null);

  -- V3: a match V3 played in, recorded by the opponent, unlinked, in the window.
  perform pg_temp.vsession('V3', 'f1500000-0000-4000-8000-000000000301', interval '40 minutes', interval '10 minutes');
  m := pg_temp.vmatch('VO', 'VO', 'V3');
  s := pg_temp.vrow('f1500000-0000-4000-8000-000000000301');
  perform pg_temp.ok('V2 an unlinked match I played in, recorded within 2 h, counts (pending)',
    s.valid and s.valid_reason = 'match_in_window' and s.rewards_pending_confirmation, s::text);
  -- Nobody confirms within the hour: the expiry deletes it, and the session no longer counts.
  perform pg_temp.as_admin();
  delete from public.matches where id = m;
  s := pg_temp.vrow('f1500000-0000-4000-8000-000000000301');
  perform pg_temp.ok('V2 ...the unconfirmed match expires (deleted): it no longer counts',
    not s.valid and s.valid_reason = 'no_match_or_drill' and s.validated_at is null
    and not s.rewards_pending_confirmation, s::text);

  -- V4: ended 4 h ago, so its window closed 2 h ago. A match now is too late,
  -- and so is linking it.
  perform pg_temp.vsession('V4', 'f1500000-0000-4000-8000-000000000401', interval '5 hours', interval '4 hours');
  m := pg_temp.vmatch('V4', 'V4', 'VO', 'f1500000-0000-4000-8000-000000000401');
  perform pg_temp.as_admin();
  perform pg_temp.ok('V2 a link to a session that ended over 2 h ago is dropped (the match still lands)',
    exists (select 1 from public.matches where id = m and play_session_id is null));
  s := pg_temp.vrow('f1500000-0000-4000-8000-000000000401');
  perform pg_temp.ok('V2 a match recorded after the 2 h window does not count',
    not s.valid and s.valid_reason = 'no_match_or_drill', s::text);
  j := pg_temp.validity('V4', 'f1500000-0000-4000-8000-000000000401');
  perform pg_temp.ok('V2 ...its window ended 2 h ago',
    (j ->> 'window_ends_at')::timestamptz = now() - interval '2 hours' and j ->> 'needs' = 'match_or_drill', j::text);

  -- V5: other players' matches never count for me, and I can't link my
  -- session to a match I'm not in.
  perform pg_temp.vsession('V5', 'f1500000-0000-4000-8000-000000000501', interval '40 minutes', interval '10 minutes');
  m := pg_temp.vmatch('VO', 'VO', 'VF');
  m2 := pg_temp.vmatch('V5', 'VO', 'VF', 'f1500000-0000-4000-8000-000000000501');
  perform pg_temp.as_admin();
  perform pg_temp.ok('V2 linking my session to a match I''m not in is dropped',
    exists (select 1 from public.matches where id = m2 and play_session_id is null));
  s := pg_temp.vrow('f1500000-0000-4000-8000-000000000501');
  perform pg_temp.ok('V2 another player''s match does not count for me',
    not s.valid and s.valid_reason = 'no_match_or_drill', s::text);
  -- Someone else's session id on my insert: dropped, never an error.
  m := pg_temp.vmatch('VO', 'VO', 'V2', 'f1500000-0000-4000-8000-000000000201');
  perform pg_temp.as_admin();
  perform pg_temp.ok('V2 a match can''t be linked to someone else''s session (stored unlinked)',
    exists (select 1 from public.matches where id = m and play_session_id is null));
  -- A session id the server doesn't have yet (its Start still queued): the
  -- match lands unlinked, no foreign-key error.
  m := pg_temp.vmatch('VO', 'VO', 'VF', 'f1500000-0000-4000-8000-0000000005ff');
  perform pg_temp.as_admin();
  perform pg_temp.ok('V2 a link to a session not stored yet lands unlinked, no error',
    exists (select 1 from public.matches where id = m and play_session_id is null));
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('V2 block crashed', false, sqlerrm);
end $$;


-- ════ V3 drills, open sessions ═══════════════════════════════════════════
do $$
declare
  s public.play_sessions;
  j jsonb;
  m uuid;
begin
  -- V6 drilled with VO this evening; a drill counts once V6 completes it
  -- (submits their review) within the window. VO's review is VO's.
  perform pg_temp.vsession('V6', 'f1500000-0000-4000-8000-000000000601', interval '40 minutes', interval '10 minutes');
  perform pg_temp.as_admin();
  insert into public.drill_sessions (id, player1_id, player2_id, session_date, session_slot, starts_at, length_minutes)
  values ('d1500000-0000-4000-8000-000000000601', pg_temp.p('V6'), pg_temp.p('VO'), current_date, 36,
          now() - interval '40 minutes', 30);
  perform pg_temp.as_user(pg_temp.p('VO'));
  perform public.submit_drill_review('d1500000-0000-4000-8000-000000000601', 4, 4, 4, 4, 4, 'Partner review');
  s := pg_temp.vrow('f1500000-0000-4000-8000-000000000601');
  perform pg_temp.ok('V3 my partner completing the drill does not count for me',
    not s.valid and s.valid_reason = 'no_match_or_drill', s::text);
  perform pg_temp.as_user(pg_temp.p('V6'));
  perform public.submit_drill_review('d1500000-0000-4000-8000-000000000601', 5, 5, 4, 4, 5, 'Worked on resets');
  s := pg_temp.vrow('f1500000-0000-4000-8000-000000000601');
  perform pg_temp.ok('V3 a drill held during the session that I completed in the window counts (nothing to confirm)',
    s.valid and s.valid_reason = 'drill_in_window' and not s.rewards_pending_confirmation, s::text);

  -- V7: an open session never counts, even with a linked match.
  perform pg_temp.vsession('V7', 'f1500000-0000-4000-8000-000000000701', interval '30 minutes');
  m := pg_temp.vmatch('V7', 'V7', 'VO', 'f1500000-0000-4000-8000-000000000701');
  perform pg_temp.as_admin();
  perform pg_temp.ok('V3 (setup) a match recorded during the session is linked',
    (select play_session_id from public.matches where id = m) = 'f1500000-0000-4000-8000-000000000701');
  j := pg_temp.validity('V7', 'f1500000-0000-4000-8000-000000000701');
  s := pg_temp.vrow('f1500000-0000-4000-8000-000000000701');
  perform pg_temp.ok('V3 an open session never counts; it needs nothing more than ending',
    not s.valid and j ->> 'valid' = 'false' and j ->> 'reason' = 'open' and j -> 'needs' = 'null'::jsonb
    and j -> 'window_ends_at' = 'null'::jsonb, j::text);
  perform pg_temp.as_user(pg_temp.p('V7'));
  perform public.end_play_session('f1500000-0000-4000-8000-000000000701', now());
  s := pg_temp.vrow('f1500000-0000-4000-8000-000000000701');
  perform pg_temp.ok('V3 ...ending it judges it: the linked match counts',
    s.valid and s.valid_reason = 'linked_match', s::text);
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('V3 block crashed', false, sqlerrm);
end $$;


-- ════ V4 a broken validity refresh never blocks a write ══════════════════
create temp table _v_saved_refresh as
select pg_get_functiondef('public._pl_refresh_session_validity(uuid)'::regprocedure) as def;
create or replace function public._pl_refresh_session_validity(p_session uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'validity refresh is broken (test)';
end $$;

do $$
declare
  m uuid;
  n int;
begin
  perform pg_temp.vsession('V8', 'f1500000-0000-4000-8000-000000000801', interval '40 minutes');
  select public.end_play_session('f1500000-0000-4000-8000-000000000801', now() - interval '10 minutes') into n;
  perform pg_temp.ok('V4 End lands while the refresh is broken', n = 1, n::text);
  m := pg_temp.vmatch('V8', 'V8', 'VO', 'f1500000-0000-4000-8000-000000000801');
  perform pg_temp.as_admin();
  perform pg_temp.ok('V4 the match insert lands (linked) while the refresh is broken',
    exists (select 1 from public.matches where id = m and play_session_id = 'f1500000-0000-4000-8000-000000000801'));
  perform pg_temp.as_user(pg_temp.p('VO'));
  perform public.confirm_match(m);
  perform pg_temp.as_admin();
  perform pg_temp.ok('V4 ...and so does its confirmation',
    (select status from public.matches where id = m) = 'completed');
  insert into public.drill_sessions (id, player1_id, player2_id, session_date, session_slot, starts_at, length_minutes)
  values ('d1500000-0000-4000-8000-000000000801', pg_temp.p('V8'), pg_temp.p('VO'), current_date, 36,
          now() - interval '40 minutes', 30);
  perform pg_temp.as_user(pg_temp.p('V8'));
  perform public.submit_drill_review('d1500000-0000-4000-8000-000000000801', 4, 4, 4, 4, 4, null);
  perform pg_temp.as_admin();
  perform pg_temp.ok('V4 ...and so does a drill review',
    exists (select 1 from public.drill_session_reviews
             where session_id = 'd1500000-0000-4000-8000-000000000801' and user_id = pg_temp.p('V8')));
  perform pg_temp.ok('V4 (setup) the session was left unjudged',
    (select not valid and valid_reason is null from public.play_sessions
      where id = 'f1500000-0000-4000-8000-000000000801'));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('V4 block crashed', false, sqlerrm);
end $$;

do $$ begin execute (select def from _v_saved_refresh); end $$;

do $$
declare
  j jsonb;
  s public.play_sessions;
begin
  j := pg_temp.validity('V8', 'f1500000-0000-4000-8000-000000000801');
  s := pg_temp.vrow('f1500000-0000-4000-8000-000000000801');
  perform pg_temp.ok('V4 once it works again, the owner''s next look heals the session',
    j ->> 'valid' = 'true' and s.valid and s.valid_reason = 'linked_match' and not s.rewards_pending_confirmation,
    j::text || ' ' || s::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('V4 heal block crashed', false, sqlerrm);
end $$;


-- ════ V5 stay proof: arrival + a later fix at the court, 5+ min apart ════
-- VS at test:p15-court (40.2): a fix 11 m north is 40.2001; 40.25 is 5.6 km away.
do $$
declare
  r public.venue_checkins;
  n int;
begin
  -- Checked in 30 min ago, checks out at the court with a fresh fix.
  perform pg_temp.vstay_checkin('c1500000-0000-4000-8000-000000000001');
  select public.checkout_venue(p_id => 'c1500000-0000-4000-8000-000000000001', p_source => null, p_at => now(),
    p_lat => 40.2001, p_lng => -100.0, p_accuracy_m => 10, p_fix_age_ms => 1000) into n;
  r := pg_temp.vci('c1500000-0000-4000-8000-000000000001');
  perform pg_temp.ok('V5 a check-out fix at the court 30 min after a confirmed arrival: stay confirmed',
    n = 1 and r.checked_out_at is not null and r.stay_confirmed
    and r.checkout_fix_at = now() - interval '1 second' and r.checkout_fix_lat = 40.2001
    and r.checkout_fix_distance_m between 10 and 12 and r.checkout_fix_accuracy_m = 10, r::text);
  perform pg_temp.as_user(pg_temp.p('VS'));
  select public.checkout_venue(p_id => 'c1500000-0000-4000-8000-000000000001', p_source => null, p_at => now(),
    p_lat => 40.25, p_lng => -100.0, p_accuracy_m => 10, p_fix_age_ms => 0) into n;
  r := pg_temp.vci('c1500000-0000-4000-8000-000000000001');
  perform pg_temp.ok('V5 a replayed check-out changes nothing (its fix included)',
    n = 0 and r.stay_confirmed and r.checkout_fix_lat = 40.2001, r::text);

  -- No fix at check-out (the current app's call shape): closes as before.
  perform pg_temp.vstay_checkin('c1500000-0000-4000-8000-000000000002');
  select public.checkout_venue(p_id => 'c1500000-0000-4000-8000-000000000002', p_source => null, p_at => now()) into n;
  r := pg_temp.vci('c1500000-0000-4000-8000-000000000002');
  perform pg_temp.ok('V5 a check-out without a fix still closes, and proves no stay',
    n = 1 and r.checked_out_at = now() and not r.stay_confirmed and r.checkout_fix_at is null, r::text);

  -- A fix somewhere else.
  perform pg_temp.vstay_checkin('c1500000-0000-4000-8000-000000000003');
  select public.checkout_venue(p_id => 'c1500000-0000-4000-8000-000000000003', p_source => null, p_at => now(),
    p_lat => 40.25, p_lng => -100.0, p_accuracy_m => 10, p_fix_age_ms => 0) into n;
  r := pg_temp.vci('c1500000-0000-4000-8000-000000000003');
  perform pg_temp.ok('V5 a check-out fix away from the court: closes, no stay, its coordinates not kept',
    n = 1 and r.checked_out_at is not null and not r.stay_confirmed
    and r.checkout_fix_lat is null and r.checkout_fix_lng is null and r.checkout_fix_distance_m > 5000, r::text);

  -- Too soon: checked in just now.
  perform pg_temp.vstay_checkin('c1500000-0000-4000-8000-000000000004', true);
  select public.checkout_venue(p_id => 'c1500000-0000-4000-8000-000000000004', p_source => null, p_at => now(),
    p_lat => 40.2001, p_lng => -100.0, p_accuracy_m => 10, p_fix_age_ms => 0) into n;
  r := pg_temp.vci('c1500000-0000-4000-8000-000000000004');
  perform pg_temp.ok('V5 a check-out fix under 5 minutes after arrival proves no stay',
    n = 1 and not r.stay_confirmed and r.checkout_fix_lat = 40.2001, r::text);

  -- Unconfirmed arrival (a 1.0.4 check-in with no fix).
  perform pg_temp.as_user(pg_temp.p('VS'));
  perform public.checkin_venue(p_id => 'c1500000-0000-4000-8000-000000000005', p_venue => 'test:p15-court',
    p_minutes => 120, p_source => 'manual', p_at => now() - interval '30 minutes');
  select public.checkout_venue(p_id => 'c1500000-0000-4000-8000-000000000005', p_source => null, p_at => now(),
    p_lat => 40.2001, p_lng => -100.0, p_accuracy_m => 10, p_fix_age_ms => 0) into n;
  r := pg_temp.vci('c1500000-0000-4000-8000-000000000005');
  perform pg_temp.ok('V5 an unconfirmed arrival never has a confirmed stay (nor an arrival fix time)',
    n = 1 and not r.location_confirmed and not r.stay_confirmed and r.arrival_fix_at is null, r::text);

  -- Extend with a confirming fix 30 min after arrival, then a 1.0.4 check-out.
  perform pg_temp.vstay_checkin('c1500000-0000-4000-8000-000000000006');
  select * into r from public.extend_checkin(p_id => 'c1500000-0000-4000-8000-000000000006',
    p_until => now() + interval '2 hours', p_lat => 40.2001, p_lng => -100.0, p_accuracy_m => 10,
    p_fix_at => now(), p_fix_age_ms => 0);
  perform pg_temp.ok('V5 an extension with a confirming fix 30 min after arrival confirms the stay',
    r.stay_confirmed and r.checked_out_at is null, r::text);
  perform pg_temp.as_user(pg_temp.p('VS'));
  select public.checkout_venue(p_id => 'c1500000-0000-4000-8000-000000000006', p_source => null) into n;
  r := pg_temp.vci('c1500000-0000-4000-8000-000000000006');
  perform pg_temp.ok('V5 1.0.4''s {p_id, p_source} check-out still resolves and closes; the stay stays confirmed',
    n = 1 and r.checked_out_at is not null and r.stay_confirmed, r::text);

  -- Queued offline: the fix was taken at the tap and carries its age.
  perform pg_temp.vstay_checkin('c1500000-0000-4000-8000-000000000007');
  select public.checkout_venue(p_id => 'c1500000-0000-4000-8000-000000000007', p_source => null,
    p_at => now() - interval '10 minutes',
    p_lat => 40.2001, p_lng => -100.0, p_accuracy_m => 10, p_fix_age_ms => 600000) into n;
  r := pg_temp.vci('c1500000-0000-4000-8000-000000000007');
  perform pg_temp.ok('V5 a queued check-out''s fix counts by its age (taken 20 min after arrival)',
    n = 1 and r.stay_confirmed and r.checkout_fix_at = now() - interval '10 minutes'
    and r.checked_out_at = now() - interval '10 minutes', r::text);
  perform pg_temp.vstay_checkin('c1500000-0000-4000-8000-000000000008');
  select public.checkout_venue(p_id => 'c1500000-0000-4000-8000-000000000008', p_source => null,
    p_at => now() - interval '28 minutes',
    p_lat => 40.2001, p_lng => -100.0, p_accuracy_m => 10, p_fix_age_ms => 1680000) into n;
  r := pg_temp.vci('c1500000-0000-4000-8000-000000000008');
  perform pg_temp.ok('V5 ...and one taken 2 min after arrival proves no stay',
    n = 1 and not r.stay_confirmed, r::text);

  -- Half a fix, or a fix with no age: the check-out still closes, nothing stored.
  perform pg_temp.vstay_checkin('c1500000-0000-4000-8000-000000000009');
  select public.checkout_venue(p_id => 'c1500000-0000-4000-8000-000000000009', p_source => null, p_at => now(),
    p_lat => 40.2001, p_lng => null, p_accuracy_m => 10, p_fix_age_ms => 0) into n;
  r := pg_temp.vci('c1500000-0000-4000-8000-000000000009');
  perform pg_temp.ok('V5 half a fix: closes, no error, nothing stored',
    n = 1 and r.checked_out_at is not null and not r.stay_confirmed and r.checkout_fix_at is null, r::text);
  perform pg_temp.vstay_checkin('c1500000-0000-4000-8000-00000000000a');
  select public.checkout_venue(p_id => 'c1500000-0000-4000-8000-00000000000a', p_source => null, p_at => now(),
    p_lat => 40.2001, p_lng => -100.0, p_accuracy_m => 10, p_fix_age_ms => null) into n;
  r := pg_temp.vci('c1500000-0000-4000-8000-00000000000a');
  perform pg_temp.ok('V5 a fix with no age can''t be placed in time: closes, nothing stored',
    n = 1 and not r.stay_confirmed and r.checkout_fix_at is null, r::text);

  -- Positional calls and the sign-out shape still resolve.
  perform pg_temp.vstay_checkin('c1500000-0000-4000-8000-00000000000b');
  select public.checkout_venue('c1500000-0000-4000-8000-00000000000b', null, now()) into n;
  perform pg_temp.ok('V5 a positional 3-argument check-out resolves', n = 1, n::text);
  perform pg_temp.vstay_checkin('c1500000-0000-4000-8000-00000000000c');
  select public.checkout_venue(null, 'signout', now()) into n;
  perform pg_temp.ok('V5 sign-out''s checkout_venue(null, ''signout'', now) still closes everything', n = 1, n::text);
  perform pg_temp.as_user(pg_temp.p('VS'));
  perform pg_temp.ok('V5 nothing of mine is left open',
    not exists (select 1 from public.venue_checkins where user_id = pg_temp.p('VS') and checked_out_at is null));
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('V5 block crashed', false, sqlerrm);
end $$;


-- ════ V6 the stay counts from the arrival fix, never a backdated p_at ═════
-- VT claims to have arrived 10 minutes ago, but the fix that would prove it
-- is fresh. Since migration_checkin_tap_time.sql such a call is refused (the
-- fix must be taken within 2 minutes of the tap); an honest replay, whose fix
-- was taken at the tap, counts from that fix.
do $$
declare
  r public.venue_checkins;
  s public.play_sessions;
  n int;
  e text;
  h text;
begin
  perform pg_temp.as_user(pg_temp.p('VT'));
  begin
    perform public.checkin_venue(p_id => 'c1500000-0000-4000-8000-000000000101',
      p_venue => 'test:p15-court', p_minutes => 120, p_source => 'manual', p_at => now() - interval '10 minutes',
      p_lat => 40.2001, p_lng => -100.0, p_accuracy_m => 10, p_fix_at => now(), p_fix_age_ms => 0);
    e := 'no error';
  exception when others then
    get stacked diagnostics h = pg_exception_hint;
    e := h;
  end;
  perform pg_temp.ok('V6 a check-in backdated 10 min with a fix from now is refused (pl:fix.after_tap), nothing stored',
    e = 'pl:fix.after_tap'
    and not exists (select 1 from public.venue_checkins where id = 'c1500000-0000-4000-8000-000000000101'), e);
  -- The honest replay: tapped 10 minutes ago with the fix taken then.
  select * into r from public.checkin_venue(p_id => 'c1500000-0000-4000-8000-000000000101',
    p_venue => 'test:p15-court', p_minutes => 120, p_source => 'manual', p_at => now() - interval '10 minutes',
    p_lat => 40.2001, p_lng => -100.0, p_accuracy_m => 10, p_fix_at => now() - interval '10 minutes',
    p_fix_age_ms => 600000);
  perform pg_temp.ok('V6 an honest 10-minute replay is dated at the tap, its arrival by its tap-time fix',
    r.location_confirmed and r.checked_in_at = now() - interval '10 minutes'
    and r.arrival_fix_at = now() - interval '10 minutes', r::text);
  select public.checkout_venue(p_id => 'c1500000-0000-4000-8000-000000000101', p_source => null, p_at => now(),
    p_lat => 40.2001, p_lng => -100.0, p_accuracy_m => 10, p_fix_age_ms => 0) into n;
  r := pg_temp.vci('c1500000-0000-4000-8000-000000000101');
  perform pg_temp.ok('V6 ...and a check-out fix at the court now proves the stay (10 min apart)',
    n = 1 and r.stay_confirmed and r.checkout_fix_lat = 40.2001, r::text);

  -- The arrival fix really was taken 6 minutes before the check-out fix (a
  -- replay tapped 6 minutes ago; before the check-ins below, which a replay
  -- would end at).
  perform pg_temp.as_user(pg_temp.p('VT'));
  perform public.checkin_venue(p_id => 'c1500000-0000-4000-8000-000000000106', p_venue => 'test:p15-court',
    p_minutes => 120, p_source => 'manual', p_at => now() - interval '6 minutes',
    p_lat => 40.2001, p_lng => -100.0, p_accuracy_m => 10, p_fix_at => now() - interval '6 minutes',
    p_fix_age_ms => 360000);
  select public.checkout_venue(p_id => 'c1500000-0000-4000-8000-000000000106', p_source => null, p_at => now(),
    p_lat => 40.2001, p_lng => -100.0, p_accuracy_m => 10, p_fix_age_ms => 0) into n;
  r := pg_temp.vci('c1500000-0000-4000-8000-000000000106');
  perform pg_temp.ok('V6 ...an arrival fix 6 minutes before the check-out fix proves the stay',
    n = 1 and r.stay_confirmed and r.arrival_fix_at = now() - interval '6 minutes', r::text);

  -- Tapped a minute ago (fix taken then), then extended with a fresh fix.
  perform pg_temp.as_user(pg_temp.p('VT'));
  perform public.checkin_venue(p_id => 'c1500000-0000-4000-8000-000000000102', p_venue => 'test:p15-court',
    p_minutes => 120, p_source => 'manual', p_at => now() - interval '1 minute',
    p_lat => 40.2001, p_lng => -100.0, p_accuracy_m => 10, p_fix_at => now() - interval '1 minute',
    p_fix_age_ms => 60000);
  select * into r from public.extend_checkin(p_id => 'c1500000-0000-4000-8000-000000000102',
    p_until => now() + interval '2 hours', p_lat => 40.2001, p_lng => -100.0, p_accuracy_m => 10,
    p_fix_at => now(), p_fix_age_ms => 0);
  perform pg_temp.ok('V6 a check-in extended a minute after its arrival fix proves no stay',
    r.arrival_fix_at = now() - interval '1 minute' and r.fix_at = now() and not r.stay_confirmed, r::text);
  perform public.checkout_venue(null, null, now());
  -- That check-in started a session (migration_checkin_starts_session.sql),
  -- ended at its check-out, now(): the no-overlap rule would move the
  -- backdated Start below up to it. Gone, so this checks the Start alone.
  perform pg_temp.as_admin();
  delete from public.play_sessions where user_id = pg_temp.p('VT') and checkin_id = id;
  perform pg_temp.as_user(pg_temp.p('VT'));

  -- A session started "10 minutes ago" at the court with a fix from now:
  -- the session is stored, its check-in is not (the fix isn't the tap's).
  select * into s from public.start_play_session(p_id => 'f1500000-0000-4000-8000-000000000c01', p_kind => 'open_play',
    p_venue => 'test:p15-court', p_at => now() - interval '10 minutes',
    p_lat => 40.2001, p_lng => -100.0, p_accuracy_m => 10, p_fix_at => now(), p_fix_age_ms => 0);
  perform pg_temp.ok('V6 a Start backdated 10 min with a fix from now: session stored, no check-in, no error',
    s.started_at = now() - interval '10 minutes'
    and not exists (select 1 from public.venue_checkins where id = 'f1500000-0000-4000-8000-000000000c01'), s::text);
  perform pg_temp.as_user(pg_temp.p('VT'));
  perform public.end_play_session('f1500000-0000-4000-8000-000000000c01', now());

  -- A repeat check-in at the same court a minute after the first.
  perform public.checkin_venue(p_id => 'c1500000-0000-4000-8000-000000000104', p_venue => 'test:p15-court',
    p_minutes => 120, p_source => 'manual', p_at => now() - interval '1 minute',
    p_lat => 40.2001, p_lng => -100.0, p_accuracy_m => 10, p_fix_at => now() - interval '1 minute',
    p_fix_age_ms => 60000);
  select * into r from public.checkin_venue(p_id => 'c1500000-0000-4000-8000-000000000105',
    p_venue => 'test:p15-court', p_minutes => 120, p_source => 'manual', p_at => null,
    p_lat => 40.2001, p_lng => -100.0, p_accuracy_m => 10, p_fix_at => now(), p_fix_age_ms => 0);
  perform pg_temp.ok('V6 a repeat check-in a minute after the first is quiet and proves no stay',
    r.id = 'c1500000-0000-4000-8000-000000000104' and r.fix_at = now() and not r.stay_confirmed, r::text);
  perform public.checkout_venue(null, null, now());
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('V6 block crashed', false, sqlerrm);
end $$;


-- ════ V7 End is the session check-in's check-out ═════════════════════════
do $$
declare
  r public.venue_checkins;
  n int;
begin
  -- 30 minutes at the court (a Start replayed with the fix taken at its tap,
  -- so the arrival fix is 30 minutes old: migration_checkin_tap_time.sql),
  -- then End there.
  perform pg_temp.as_user(pg_temp.p('VE'));
  perform public.start_play_session(p_id => 'f1500000-0000-4000-8000-000000000d01', p_kind => 'open_play',
    p_venue => 'test:p15-court', p_at => now() - interval '30 minutes',
    p_lat => 40.2001, p_lng => -100.0, p_accuracy_m => 10, p_fix_at => now() - interval '30 minutes',
    p_fix_age_ms => 1800000);
  perform pg_temp.ok('V7 (setup) the replayed Start checked in from its tap, arrival fix 30 min ago',
    (select checked_in_at = now() - interval '30 minutes' and arrival_fix_at = now() - interval '30 minutes'
       from public.venue_checkins where id = 'f1500000-0000-4000-8000-000000000d01'));
  select public.end_play_session(p_id => 'f1500000-0000-4000-8000-000000000d01', p_at => now(),
    p_lat => 40.2001, p_lng => -100.0, p_accuracy_m => 10, p_fix_age_ms => 1000) into n;
  r := pg_temp.vci('f1500000-0000-4000-8000-000000000d01');
  perform pg_temp.ok('V7 End with a fix at the court 30 min after arrival: the session check-in closes, stay confirmed',
    n = 1 and r.checked_out_at = now() and r.stay_confirmed
    and r.checkout_fix_at = now() - interval '1 second' and r.checkout_fix_lat = 40.2001, r::text);
  perform pg_temp.as_user(pg_temp.p('VE'));
  select public.end_play_session(p_id => 'f1500000-0000-4000-8000-000000000d01', p_at => now(),
    p_lat => 40.25, p_lng => -100.0, p_accuracy_m => 10, p_fix_age_ms => 0) into n;
  r := pg_temp.vci('f1500000-0000-4000-8000-000000000d01');
  perform pg_temp.ok('V7 a replayed End changes nothing (its fix included)',
    n = 0 and r.stay_confirmed and r.checkout_fix_lat = 40.2001, r::text);

  -- 1.0.4's and the current app's {p_id, p_at}: closes, no fix, no stay.
  perform pg_temp.as_user(pg_temp.p('VE'));
  perform public.start_play_session(p_id => 'f1500000-0000-4000-8000-000000000d02', p_kind => 'open_play',
    p_venue => 'test:p15-court', p_lat => 40.2001, p_lng => -100.0, p_accuracy_m => 10,
    p_fix_at => now(), p_fix_age_ms => 0);
  select public.end_play_session(p_id => 'f1500000-0000-4000-8000-000000000d02', p_at => now()) into n;
  r := pg_temp.vci('f1500000-0000-4000-8000-000000000d02');
  perform pg_temp.ok('V7 a {p_id, p_at} End still resolves and closes the check-in, proving no stay',
    n = 1 and r.checked_out_at is not null and not r.stay_confirmed and r.checkout_fix_at is null, r::text);

  -- Sign-out's positional (id, at).
  perform pg_temp.as_user(pg_temp.p('VE'));
  perform public.start_play_session(p_id => 'f1500000-0000-4000-8000-000000000d03', p_kind => 'open_play');
  select public.end_play_session('f1500000-0000-4000-8000-000000000d03', now()) into n;
  perform pg_temp.ok('V7 a positional (id, at) End still resolves', n = 1, n::text);

  -- A fix away from the court: closes, no stay, coordinates not kept.
  perform public.start_play_session(p_id => 'f1500000-0000-4000-8000-000000000d04', p_kind => 'open_play',
    p_venue => 'test:p15-court', p_lat => 40.2001, p_lng => -100.0, p_accuracy_m => 10,
    p_fix_at => now(), p_fix_age_ms => 0);
  select public.end_play_session(p_id => 'f1500000-0000-4000-8000-000000000d04', p_at => now(),
    p_lat => 40.25, p_lng => -100.0, p_accuracy_m => 10, p_fix_age_ms => 0) into n;
  r := pg_temp.vci('f1500000-0000-4000-8000-000000000d04');
  perform pg_temp.ok('V7 an End fix away from the court: closes, no stay, its coordinates not kept',
    n = 1 and r.checked_out_at is not null and not r.stay_confirmed and r.checkout_fix_lat is null
    and r.checkout_fix_distance_m > 5000, r::text);

  -- Under 5 minutes after arrival.
  perform pg_temp.as_user(pg_temp.p('VE'));
  perform public.start_play_session(p_id => 'f1500000-0000-4000-8000-000000000d05', p_kind => 'open_play',
    p_venue => 'test:p15-court', p_lat => 40.2001, p_lng => -100.0, p_accuracy_m => 10,
    p_fix_at => now(), p_fix_age_ms => 0);
  select public.end_play_session(p_id => 'f1500000-0000-4000-8000-000000000d05', p_at => now(),
    p_lat => 40.2001, p_lng => -100.0, p_accuracy_m => 10, p_fix_age_ms => 0) into n;
  r := pg_temp.vci('f1500000-0000-4000-8000-000000000d05');
  perform pg_temp.ok('V7 an End fix under 5 minutes after arrival proves no stay',
    n = 1 and not r.stay_confirmed and r.checkout_fix_lat = 40.2001, r::text);

  -- An adopted manual check-in stays open, and End's fix doesn't touch it.
  perform pg_temp.checkin('VE', 'c1500000-0000-4000-8000-000000000d06', 'test:p15-court', 120, 40.2001);
  perform public.start_play_session(p_id => 'f1500000-0000-4000-8000-000000000d06', p_kind => 'open_play',
    p_venue => 'test:p15-court');
  select public.end_play_session(p_id => 'f1500000-0000-4000-8000-000000000d06', p_at => now(),
    p_lat => 40.2001, p_lng => -100.0, p_accuracy_m => 10, p_fix_age_ms => 0) into n;
  r := pg_temp.vci('c1500000-0000-4000-8000-000000000d06');
  perform pg_temp.ok('V7 End leaves an adopted check-in open, without a check-out fix',
    n = 1 and r.checked_out_at is null and r.checkout_fix_at is null
    and not exists (select 1 from public.venue_checkins where id = 'f1500000-0000-4000-8000-000000000d06'), r::text);
  perform pg_temp.as_user(pg_temp.p('VE'));
  perform public.checkout_venue(null, null, now());
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('V7 block crashed', false, sqlerrm);
end $$;


-- ════ V8 one match counts for one session; sessions never overlap ════════
do $$
declare
  m  uuid;
  m1 uuid;
  i  int;
  n  int;
  s  public.play_sessions;
begin
  -- VX records one pending match against VO (who never confirms), then, in
  -- the same instant and from nowhere, stacks sessions around it.
  m := pg_temp.vmatch('VX', 'VX', 'VO');
  perform pg_temp.as_user(pg_temp.p('VX'));
  for i in 1..5 loop
    perform public.start_play_session(p_id => ('f1500000-0000-4000-8000-000000000e0' || i)::uuid,
      p_kind => 'open_play', p_at => now() - interval '6 minutes');
    perform public.end_play_session(('f1500000-0000-4000-8000-000000000e0' || i)::uuid, now());
  end loop;
  perform public.start_play_session(p_id => 'f1500000-0000-4000-8000-000000000e06', p_kind => 'open_play',
    p_at => now() - interval '11 hours');
  perform public.end_play_session('f1500000-0000-4000-8000-000000000e06', now());
  -- A late Start: its End gets there first, then the Start, dated 6 minutes back.
  perform public.end_play_session('f1500000-0000-4000-8000-000000000e07', now());
  select * into s from public.start_play_session(p_id => 'f1500000-0000-4000-8000-000000000e07',
    p_kind => 'open_play', p_at => now() - interval '6 minutes');
  perform pg_temp.ok('V8 a late Start stored ended next to my other sessions starts when they ended',
    s.started_at = now() and s.ended_at = now(), s::text);
  perform pg_temp.as_admin();
  select count(*) filter (where valid) into n from public.play_sessions where user_id = pg_temp.p('VX');
  perform pg_temp.ok('V8 one match, seven sessions stacked around it after the fact: exactly one counts',
    n = 1, (select string_agg(id::text || ' ' || started_at::text || '..' || ended_at::text || ' ' || valid_reason, '; ')
              from public.play_sessions where user_id = pg_temp.p('VX')));
  perform pg_temp.ok('V8 ...the first; each backdated Start after it starts (and ends) when it ended',
    (select valid and started_at = now() - interval '6 minutes'
       from public.play_sessions where id = 'f1500000-0000-4000-8000-000000000e01')
    and not exists (select 1 from public.play_sessions
                     where user_id = pg_temp.p('VX') and id <> 'f1500000-0000-4000-8000-000000000e01'
                       and (started_at <> now() or ended_at <> now() or valid_reason <> 'too_short')));

  -- VH, honestly: S1 2 h to 1 h ago, S2 from 30 minutes ago, a match during S2.
  perform pg_temp.vsession('VH', 'f1500000-0000-4000-8000-000000000f01', interval '120 minutes', interval '60 minutes');
  perform pg_temp.vsession('VH', 'f1500000-0000-4000-8000-000000000f02', interval '30 minutes');
  m := pg_temp.vmatch('VH', 'VH', 'VO');
  perform pg_temp.as_user(pg_temp.p('VH'));
  perform public.end_play_session('f1500000-0000-4000-8000-000000000f02', now());
  perform pg_temp.ok('V8 a match recorded during my second session counts for it, not the first (whose window holds it too)',
    (pg_temp.vrow('f1500000-0000-4000-8000-000000000f02')).valid_reason = 'match_in_window'
    and (pg_temp.vrow('f1500000-0000-4000-8000-000000000f01')).valid_reason = 'no_match_or_drill');
  -- A match recorded during S1 (written by the server, so it can be dated).
  m1 := pg_temp.vmatch_at('VH', 'VO', now() - interval '90 minutes');
  perform pg_temp.ok('V8 ...one recorded during the first counts for the first',
    (pg_temp.vrow('f1500000-0000-4000-8000-000000000f01')).valid_reason = 'match_in_window'
    and (pg_temp.vrow('f1500000-0000-4000-8000-000000000f02')).valid_reason = 'match_in_window');
  perform pg_temp.as_admin();
  delete from public.matches where id = m;
  perform pg_temp.ok('V8 the second''s match expires: only the session it counted for stops counting',
    (pg_temp.vrow('f1500000-0000-4000-8000-000000000f02')).valid_reason = 'no_match_or_drill'
    and (pg_temp.vrow('f1500000-0000-4000-8000-000000000f01')).valid);

  -- VK: a real session (60 to 30 min ago), then a newer one that runs 3
  -- minutes, with a match recorded during it.
  perform pg_temp.vsession('VK', 'f1500000-0000-4000-8000-000000001001', interval '60 minutes', interval '30 minutes');
  perform pg_temp.vsession('VK', 'f1500000-0000-4000-8000-000000001002', interval '3 minutes');
  m := pg_temp.vmatch('VK', 'VK', 'VO');
  perform pg_temp.ok('V8 while a newer session runs, a match recorded now counts for it, not for the one before',
    (pg_temp.vrow('f1500000-0000-4000-8000-000000001001')).valid_reason = 'no_match_or_drill');
  perform pg_temp.as_user(pg_temp.p('VK'));
  perform public.end_play_session('f1500000-0000-4000-8000-000000001002', now());
  perform pg_temp.ok('V8 ...it ends after 3 minutes, too short to take a match: the one before counts instead',
    (pg_temp.vrow('f1500000-0000-4000-8000-000000001002')).valid_reason = 'too_short'
    and (pg_temp.vrow('f1500000-0000-4000-8000-000000001001')).valid_reason = 'match_in_window');

  perform pg_temp.as_admin();
  select count(*) into n
    from public.play_sessions a
    join public.play_sessions b on b.user_id = a.user_id and b.id > a.id
   where a.user_id in (select id from _p where id::text like 'a1500000-%')
     and a.started_at < coalesce(b.ended_at, 'infinity') and b.started_at < coalesce(a.ended_at, 'infinity');
  perform pg_temp.ok('V8 no two sessions of any P15 persona overlap', n = 0, n::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('V8 block crashed', false, sqlerrm);
end $$;


-- ════ V9 "recorded" is the server's clock ═════════════════════════════════
do $$
declare
  r public.matches;
  s public.play_sessions;
begin
  -- VW's session ended 4 h ago: its window closed 2 h ago.
  perform pg_temp.vsession('VW', 'f1500000-0000-4000-8000-000000001101', interval '5 hours', interval '4 hours');
  insert into public.matches (league_id, player1_id, player2_id, player1_score, player2_score, match_type,
                              winner_id, winner_team, status, confirm_deadline, team1_confirmed_by,
                              created_at, played_at)
  values ('b1500000-0000-4000-8000-000000000001', pg_temp.p('VW'), pg_temp.p('VO'), 11, 5, 'singles',
          pg_temp.p('VW'), 'team1', 'pending', now() + interval '1 hour', pg_temp.p('VW'),
          now() - interval '270 minutes', now() - interval '270 minutes')
  returning * into r;
  perform pg_temp.ok('V9 a client can''t backdate a match''s recorded time (created_at is the server''s now)',
    r.created_at = now() and r.played_at = now() - interval '270 minutes', r::text);
  s := pg_temp.vrow('f1500000-0000-4000-8000-000000001101');
  perform pg_temp.ok('V9 ...so a backdated match can''t make a session whose window closed count',
    not s.valid and s.valid_reason = 'no_match_or_drill', s::text);

  perform pg_temp.as_user(pg_temp.p('VW'));
  insert into public.matches (league_id, player1_id, player2_id, player1_score, player2_score, match_type,
                              winner_id, winner_team, created_at, played_at)
  values ('b1500000-0000-4000-8000-000000000001', pg_temp.p('VW'), pg_temp.p('VO'), 11, 5, 'singles',
          pg_temp.p('VW'), 'team1', null, now() - interval '270 minutes')
  returning * into r;
  s := pg_temp.vrow('f1500000-0000-4000-8000-000000001101');
  perform pg_temp.ok('V9 a null created_at with a backdated played_at is stamped now too, and doesn''t count',
    r.created_at = now() and not s.valid, r::text || ' ' || s::text);

  perform pg_temp.as_user(pg_temp.p('VW'));
  insert into public.matches (league_id, player1_id, player2_id, player1_score, player2_score, match_type,
                              winner_id, winner_team, created_at)
  values ('b1500000-0000-4000-8000-000000000001', pg_temp.p('VW'), pg_temp.p('VO'), 11, 5, 'singles',
          pg_temp.p('VW'), 'team1', now() + interval '1 day')
  returning * into r;
  perform pg_temp.ok('V9 a created_at in the future is stamped now (it can''t pre-validate a later session)',
    r.created_at = now(), r::text);
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('V9 block crashed', false, sqlerrm);
end $$;


-- ════ V10 a client can't assert a confirmation ═══════════════════════════
do $$
declare
  r     public.matches;
  m     uuid;
  m2    uuid;
  t     text;
  v_r1  numeric;
  v_r2  numeric;
  s     public.play_sessions;
begin
  -- No status at all (the column defaults to 'completed'), linked to my session.
  perform pg_temp.vsession('VG', 'f1500000-0000-4000-8000-000000001201', interval '40 minutes');
  insert into public.matches (league_id, player1_id, player2_id, player1_score, player2_score, match_type,
                              winner_id, winner_team, play_session_id)
  values ('b1500000-0000-4000-8000-000000000001', pg_temp.p('VG'), pg_temp.p('VO'), 11, 5, 'singles',
          pg_temp.p('VG'), 'team1', 'f1500000-0000-4000-8000-000000001201')
  returning * into r;
  perform pg_temp.ok('V10 a client insert with no status lands pending, due in an hour, only my team confirmed',
    r.status = 'pending' and r.confirm_deadline = now() + interval '1 hour'
    and r.team1_confirmed_by = pg_temp.p('VG') and r.team2_confirmed_by is null
    and r.play_session_id = 'f1500000-0000-4000-8000-000000001201', r::text);
  perform public.end_play_session('f1500000-0000-4000-8000-000000001201', now());
  s := pg_temp.vrow('f1500000-0000-4000-8000-000000001201');
  perform pg_temp.ok('V10 ...so the session it makes count waits for the other team (rewards pending)',
    s.valid and s.valid_reason = 'linked_match' and s.rewards_pending_confirmation, s::text);

  -- 'completed' with both teams' confirmations and no deadline.
  perform pg_temp.as_admin();
  select rating into v_r1 from public.profiles where id = pg_temp.p('VG');
  select rating into v_r2 from public.profiles where id = pg_temp.p('VO');
  perform pg_temp.as_user(pg_temp.p('VG'));
  insert into public.matches (league_id, player1_id, player2_id, player1_score, player2_score, match_type,
                              winner_id, winner_team, status, confirm_deadline,
                              team1_confirmed_by, team2_confirmed_by)
  values ('b1500000-0000-4000-8000-000000000001', pg_temp.p('VG'), pg_temp.p('VO'), 11, 5, 'singles',
          pg_temp.p('VG'), 'team1', 'completed', null, pg_temp.p('VG'), pg_temp.p('VO'))
  returning * into r;
  perform pg_temp.as_admin();
  perform pg_temp.ok('V10 a client''s ''completed'' with both confirmations lands pending, the other team unconfirmed',
    r.status = 'pending' and r.confirm_deadline = now() + interval '1 hour'
    and r.team1_confirmed_by = pg_temp.p('VG') and r.team2_confirmed_by is null, r::text);
  perform pg_temp.ok('V10 ...and moves nobody''s rating (PLUPR waits for the confirmation)',
    (select rating from public.profiles where id = pg_temp.p('VG')) is not distinct from v_r1
    and (select rating from public.profiles where id = pg_temp.p('VO')) is not distinct from v_r2);

  -- Me on both teams (doubles): only one team's confirmation, and I can't add the other.
  perform pg_temp.as_user(pg_temp.p('VG'));
  insert into public.matches (league_id, player1_id, partner1_id, player2_id, partner2_id,
                              player1_score, player2_score, match_type, winner_id, winner_team,
                              status, team1_confirmed_by, team2_confirmed_by)
  values ('b1500000-0000-4000-8000-000000000001', pg_temp.p('VG'), pg_temp.p('VO'), pg_temp.p('VF'), pg_temp.p('VG'),
          11, 5, 'doubles', pg_temp.p('VG'), 'team1', 'pending', pg_temp.p('VG'), pg_temp.p('VG'))
  returning * into r;
  perform pg_temp.ok('V10 a caller on both teams gets one team''s confirmation only',
    r.team1_confirmed_by = pg_temp.p('VG') and r.team2_confirmed_by is null, r::text);
  select public.confirm_match(r.id) into t;
  perform pg_temp.as_admin();
  perform pg_temp.ok('V10 ...and confirming it again leaves it pending (my team had already)',
    t = 'already_your_team' and (select status from public.matches where id = r.id) = 'pending', t);

  -- Scheduled: kept, with no confirmations, and it never counts.
  perform pg_temp.vsession('VQ', 'f1500000-0000-4000-8000-000000001301', interval '40 minutes', interval '10 minutes');
  insert into public.matches (league_id, player1_id, player2_id, player1_score, player2_score, match_type,
                              status, scheduled_at, confirm_deadline, team1_confirmed_by)
  values ('b1500000-0000-4000-8000-000000000001', pg_temp.p('VQ'), pg_temp.p('VO'), 11, 5, 'singles',
          'scheduled', now() + interval '1 day', now() + interval '1 hour', pg_temp.p('VQ'))
  returning * into r;
  s := pg_temp.vrow('f1500000-0000-4000-8000-000000001301');
  perform pg_temp.ok('V10 a scheduled match stays scheduled, unconfirmed, and doesn''t make a session count',
    r.status = 'scheduled' and r.confirm_deadline is null and r.team1_confirmed_by is null
    and not s.valid and s.valid_reason = 'no_match_or_drill', r::text || ' ' || s::text);

  -- A pending match stored with no deadline (before the guard) still expires.
  perform pg_temp.as_admin();
  insert into public.matches (league_id, player1_id, player2_id, player1_score, player2_score, match_type,
                              winner_id, winner_team, status, confirm_deadline, created_at)
  values ('b1500000-0000-4000-8000-000000000001', pg_temp.p('VO'), pg_temp.p('VF'), 11, 5, 'singles',
          pg_temp.p('VO'), 'team1', 'pending', null, now() - interval '61 minutes')
  returning id into m;
  insert into public.matches (league_id, player1_id, player2_id, player1_score, player2_score, match_type,
                              winner_id, winner_team, status, confirm_deadline, created_at)
  values ('b1500000-0000-4000-8000-000000000001', pg_temp.p('VO'), pg_temp.p('VF'), 11, 5, 'singles',
          pg_temp.p('VO'), 'team1', 'pending', null, now() - interval '30 minutes')
  returning id into m2;
  perform public.expire_pending_matches();
  perform pg_temp.ok('V10 a pending match with no deadline expires an hour after it was stored, not before',
    not exists (select 1 from public.matches where id = m) and exists (select 1 from public.matches where id = m2));
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('V10 block crashed', false, sqlerrm);
end $$;


-- ════ V11 a drill counts only when it was held during the session ════════
do $$
declare
  s    public.play_sessions;
  n    int;
  v_ok boolean;
begin
  -- VD: 30 minutes, nothing recorded; a drill from 30 days ago, never reviewed.
  perform pg_temp.vsession('VD', 'f1500000-0000-4000-8000-000000001401', interval '40 minutes', interval '10 minutes');
  perform pg_temp.as_admin();
  insert into public.drill_sessions (id, player1_id, player2_id, session_date, session_slot, starts_at, length_minutes)
  values ('d1500000-0000-4000-8000-000000001401', pg_temp.p('VD'), pg_temp.p('VO'), current_date - 30, 36,
          now() - interval '30 days', 60),
         ('d1500000-0000-4000-8000-000000001402', pg_temp.p('VD'), pg_temp.p('VO'), current_date + 7, 36,
          now() + interval '7 days', 60);
  perform pg_temp.as_user(pg_temp.p('VD'));
  select success into v_ok from public.submit_drill_review('d1500000-0000-4000-8000-000000001401', 5, 5, 5, 5, 5, 'Old drill');
  s := pg_temp.vrow('f1500000-0000-4000-8000-000000001401');
  perform pg_temp.ok('V11 reviewing a drill from 30 days ago lands, but doesn''t make today''s session count',
    v_ok and not s.valid and s.valid_reason = 'no_match_or_drill', s::text);
  -- A drill next week can't be moved into today to review it now.
  perform pg_temp.as_user(pg_temp.p('VD'));
  begin
    update public.drill_sessions set starts_at = now() - interval '1 hour'
     where id = 'd1500000-0000-4000-8000-000000001402';
    get diagnostics n = row_count;
    perform pg_temp.ok('V11 a participant can''t move a drill''s start time', false, n::text || ' row(s) updated');
  exception when insufficient_privilege then
    perform pg_temp.ok('V11 a participant can''t move a drill''s start time', true);
  end;
  update public.drill_sessions set reminder_dismissed_by = array[pg_temp.p('VD')]
   where id = 'd1500000-0000-4000-8000-000000001402';
  get diagnostics n = row_count;
  perform pg_temp.ok('V11 ...but can still dismiss its reminder (the app''s one update)', n = 1, n::text);

  -- VJ: two sessions (100 to 70 and 60 to 30 min ago), one drill held across
  -- both (65 to 5 min ago): it counts for the one that started closest to it.
  perform pg_temp.vsession('VJ', 'f1500000-0000-4000-8000-000000001501', interval '100 minutes', interval '70 minutes');
  perform pg_temp.vsession('VJ', 'f1500000-0000-4000-8000-000000001502', interval '60 minutes', interval '30 minutes');
  perform pg_temp.as_admin();
  insert into public.drill_sessions (id, player1_id, player2_id, session_date, session_slot, starts_at, length_minutes)
  values ('d1500000-0000-4000-8000-000000001501', pg_temp.p('VJ'), pg_temp.p('VO'), current_date, 36,
          now() - interval '65 minutes', 60);
  perform pg_temp.as_user(pg_temp.p('VJ'));
  perform public.submit_drill_review('d1500000-0000-4000-8000-000000001501', 4, 4, 4, 4, 4, null);
  perform pg_temp.ok('V11 one drill review counts for one session: the one that started closest to the drill',
    (pg_temp.vrow('f1500000-0000-4000-8000-000000001502')).valid_reason = 'drill_in_window'
    and (pg_temp.vrow('f1500000-0000-4000-8000-000000001501')).valid_reason = 'no_match_or_drill');
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('V11 block crashed', false, sqlerrm);
end $$;


-- ════ V12 at_court: valid is about playing, at_court about being there ═══
do $$
declare
  s public.play_sessions;
  j jsonb;
begin
  -- An untracked session (no court) with a match recorded during it.
  perform pg_temp.vsession('VC', 'f1500000-0000-4000-8000-000000001601', interval '60 minutes', interval '40 minutes');
  perform pg_temp.vmatch_at('VC', 'VO', now() - interval '50 minutes');
  s := pg_temp.vrow('f1500000-0000-4000-8000-000000001601');
  perform pg_temp.ok('V12 an untracked session with a match counts as played, but not as at a court',
    s.valid and not s.at_court, s::text);

  -- At the court: a Start replayed 20 minutes late with the fix taken at its
  -- tap (migration_checkin_tap_time.sql judges the fix at the tap).
  perform pg_temp.as_user(pg_temp.p('VC'));
  perform public.start_play_session(p_id => 'f1500000-0000-4000-8000-000000001602', p_kind => 'open_play',
    p_venue => 'test:p15-court', p_at => now() - interval '20 minutes',
    p_lat => 40.2001, p_lng => -100.0, p_accuracy_m => 10, p_fix_at => now() - interval '20 minutes 5 seconds',
    p_fix_age_ms => 1205000);
  perform pg_temp.vmatch('VC', 'VC', 'VO');
  perform public.end_play_session('f1500000-0000-4000-8000-000000001602', now());
  s := pg_temp.vrow('f1500000-0000-4000-8000-000000001602');
  j := pg_temp.validity('VC', 'f1500000-0000-4000-8000-000000001602');
  perform pg_temp.ok('V12 a session with a confirmed check-in at its court is valid and at_court',
    s.valid and s.at_court and (j ->> 'at_court')::boolean, s::text || ' ' || j::text);

  -- A court named, but no fix confirmed it: not at_court.
  perform pg_temp.as_user(pg_temp.p('VC'));
  perform public.start_play_session(p_id => 'f1500000-0000-4000-8000-000000001603', p_kind => 'open_play',
    p_venue => 'test:p15-court');
  perform public.end_play_session('f1500000-0000-4000-8000-000000001603', now());
  s := pg_temp.vrow('f1500000-0000-4000-8000-000000001603');
  perform pg_temp.ok('V12 a session naming a court that no fix confirmed is not at_court',
    s.venue_id = 'test:p15-court' and not s.at_court, s::text);
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('V12 block crashed', false, sqlerrm);
end $$;
