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
--   test:p15-court (40.2 N, 100.0 W)
-- ============================================================

insert into _p values
  ('V1', 'a1500000-0000-4000-8000-000000000001'), ('V2', 'a1500000-0000-4000-8000-000000000002'),
  ('V3', 'a1500000-0000-4000-8000-000000000003'), ('V4', 'a1500000-0000-4000-8000-000000000004'),
  ('V5', 'a1500000-0000-4000-8000-000000000005'), ('V6', 'a1500000-0000-4000-8000-000000000006'),
  ('V7', 'a1500000-0000-4000-8000-000000000007'), ('V8', 'a1500000-0000-4000-8000-000000000008'),
  ('VO', 'a1500000-0000-4000-8000-000000000009'), ('VF', 'a1500000-0000-4000-8000-00000000000a'),
  ('VS', 'a1500000-0000-4000-8000-00000000000b');

insert into auth.users (id, email, raw_user_meta_data)
select id, 'p15-' || lower(k) || '@pickleague.test', jsonb_build_object('full_name', 'P15 Player ' || k)
  from _p where k = any (array['V1','V2','V3','V4','V5','V6','V7','V8','VO','VF','VS']);

insert into public.venues (id, sport, name, kind, lat, lng, source, geofence_radius_m)
values ('test:p15-court', array['pickleball'], 'P15 Test Courts', 'court', 40.2, -100.0, 'google', 100);

insert into public.leagues (id, name, is_open, created_by)
values ('b1500000-0000-4000-8000-000000000001', 'P15 Validity League', true, pg_temp.p('VO'));
insert into public.league_members (league_id, user_id, role)
select 'b1500000-0000-4000-8000-000000000001', id, case when k = 'VO' then 'admin' else 'member' end
  from _p where k = any (array['V1','V2','V3','V4','V5','V6','V7','V8','VO','VF','VS'])
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
-- past (arrival fix included) unless p_now. Leaves the role as VS.
create function pg_temp.vstay_checkin(p_id uuid, p_now boolean default false)
returns void language plpgsql as $$
begin
  perform pg_temp.checkin('VS', p_id, 'test:p15-court', 120, 40.2001);
  if not p_now then
    perform pg_temp.as_admin();
    update public.venue_checkins
       set checked_in_at = now() - interval '30 minutes', fix_at = now() - interval '30 minutes'
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
    'public._pl_record_checkout_fix(uuid[],double precision,double precision,double precision,double precision)',
    'public._pl_matches_link_session()', 'public._pl_matches_refresh_validity()',
    'public._pl_drill_reviews_refresh_validity()', 'public._pl_play_sessions_refresh_validity()',
    'public._pl_checkin_stay_from_fix()'];
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
  -- migration_presence_p1_checkins.sql was re-run after this file: its guard
  -- kept the Phase 1.5 checkout_venue, and only that one.
  perform pg_temp.ok('V1 one checkout_venue, with every Phase 1 parameter first and the fix after',
    (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'checkout_venue') = 1
    and (select pg_get_function_identity_arguments(oid) from pg_proc
          where pronamespace = 'public'::regnamespace and proname = 'checkout_venue')
        = 'p_id uuid, p_source text, p_at timestamp with time zone, p_lat double precision, p_lng double precision, p_accuracy_m double precision, p_fix_age_ms double precision',
    (select string_agg(pg_get_function_identity_arguments(oid), ' | ') from pg_proc
      where pronamespace = 'public'::regnamespace and proname = 'checkout_venue'));
  perform pg_temp.ok('V1 every checkout_venue parameter has a default (1.0.4 sends only p_id, p_source)',
    (select pronargdefaults = 7 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'checkout_venue'));
  select string_agg(t, ', ') into v_bad
    from unnest(array['matches.trg_matches_link_session', 'matches.trg_matches_session_validity',
                      'play_sessions.trg_play_sessions_validity',
                      'drill_session_reviews.trg_drill_reviews_session_validity',
                      'venue_checkins.trg_venue_checkins_stay']) t
   where not exists (select 1 from pg_trigger g join pg_class c on c.oid = g.tgrelid
                      where c.relnamespace = 'public'::regnamespace
                        and c.relname || '.' || g.tgname = t and not g.tgisinternal);
  perform pg_temp.ok('V1 the five validity triggers exist', v_bad is null, v_bad);
  perform pg_temp.ok('V1 matches.play_session_id -> play_sessions on delete set null, indexed',
    exists (select 1 from pg_constraint
             where conrelid = 'public.matches'::regclass and contype = 'f' and confdeltype = 'n'
               and confrelid = 'public.play_sessions'::regclass)
    and exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'matches_play_session_id_idx'));
  perform pg_temp.ok('V1 the match insert policy names only my own session',
    (select with_check like '%play_session_id%' and with_check like '%play_sessions%' and with_check like '%auth.uid()%'
       from pg_policies where schemaname = 'public' and tablename = 'matches'
        and policyname = 'League members can record matches'));
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
  -- V1: 4 minutes with a linked match: too short.
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
  -- Exactly 5 minutes counts (V1's match was recorded inside this one's window).
  perform pg_temp.vsession('V1', 'f1500000-0000-4000-8000-000000000102', interval '20 minutes', interval '15 minutes');
  s := pg_temp.vrow('f1500000-0000-4000-8000-000000000102');
  perform pg_temp.ok('V2 exactly 5 minutes with a match in the window counts',
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
    and (j ->> 'rewards_pending_confirmation')::boolean, j::text);
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
  perform pg_temp.ok('V3 a drill I completed in the window counts (nothing to confirm)',
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
  perform pg_temp.ok('V5 an unconfirmed arrival never has a confirmed stay',
    n = 1 and not r.location_confirmed and not r.stay_confirmed, r::text);

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
