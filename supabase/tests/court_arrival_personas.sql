-- ============================================================
-- Court arrival check-ins (Doggle parity: state/court-arrival-doggle-parity.md
-- section G "Tests", with the user's decisions of 2026-10-19):
-- migration_court_arrival_settings.sql, migration_court_arrival_queue.sql and
-- migration_court_checkin_prompt.sql.
--
-- NOT runnable on its own: build-presence-test.mjs splices it into
-- presence_p1_personas.sql at -- @@ARRIVALS@@, after the Phase 1, Phase 1.5,
-- refusal and tap-time sections and before the results, reusing their
-- harness (_p, _results, pg_temp.p / ok / as_user / as_admin / checkin, vci,
-- err / as_signed_out, tt_try) inside the same rolled-back transaction. The
-- builder applies the three files after the other presence files, applies
-- them again after the re-runs of migration_validity_rules.sql and
-- migration_venue_checkins.sql (which put older bodies of the functions they
-- replace back, as the files' headers warn), then re-runs the hardening file,
-- as the apply script does. A1 checks that the arrival bodies are the live ones.
--
-- now() is fixed for the whole transaction, so time never passes here: a
-- wait is made by moving rows into the past (pg_temp.ca_wait, ca_age), never
-- by sleeping. process_court_arrivals and expire_venue_checkins are called
-- directly, as pg_cron would.
--
-- Courts (pickleball unless said; far from every real venue; 100 m fences; a
-- fix 11 m north is lat + 0.0001):
--   test:ca-alpha 40.50 N 100.0 W, with a duplicate row test:ca-alpha-osm ·
--   test:ca-bravo 40.51 · test:ca-charlie 40.52 · test:ca-gone 40.53 (removed
--   during a minute) · test:ca-delta 40.54 · the scan cluster test:ca-s1..s9,
--   4 to 178 m north of 40.55, with a rejected court and a basketball court
--   beside s1 · test:ca-q1 / q2, 445 m / 612 m north of 40.57 · two outlines,
--   test:ca-big and test:ca-small, both holding 40.59 · test:ca-yard 40.61
--   (an outline, cleared later)
--
-- Personas:
--   HH happy path · HQ queue answers · HO an open check-in at the court ·
--   HS / HU checked in elsewhere, leaving within / after 5 minutes (S11) ·
--   HP a play session running · HG the court removed during the minute ·
--   HW unstarred or switched off while waiting · HY checked out under the
--   arrival's id before it landed · HME checks in by hand at another court
--   during the minute · HE Exit before due, then re-entry · HF
--   Exit within 5 minutes · HL late Enters · HK back 15 minutes after a
--   take-back · HC Check in now · HX Stay 1 more hour · HJ a Start adopts it ·
--   HN Not here · HT / HZ "Still at" · HR / HV rewards (S4) · HM / HA / HB the
--   expiry push (manual, arrival, session) · HD 1.0.4's check-out · HI / H0 /
--   H1 "Check in nearby?" (push on / push off / prompts off) · HSC the
--   app-open scan · HSE settings · HCN signs out · HCL signs out as the job
--   lands an arrival · HDL deletes the account · HRB a re-run of
--   migration_validity_rules.sql · HIA / HIB two players at one court
-- ============================================================

insert into _p values
  ('HH',  'a7000000-0000-4000-8000-000000000001'), ('HQ',  'a7000000-0000-4000-8000-000000000002'),
  ('HO',  'a7000000-0000-4000-8000-000000000003'), ('HS',  'a7000000-0000-4000-8000-000000000004'),
  ('HU',  'a7000000-0000-4000-8000-000000000005'), ('HP',  'a7000000-0000-4000-8000-000000000006'),
  ('HG',  'a7000000-0000-4000-8000-000000000007'), ('HW',  'a7000000-0000-4000-8000-000000000008'),
  ('HY',  'a7000000-0000-4000-8000-000000000009'), ('HE',  'a7000000-0000-4000-8000-00000000000a'),
  ('HF',  'a7000000-0000-4000-8000-00000000000b'), ('HL',  'a7000000-0000-4000-8000-00000000000c'),
  ('HK',  'a7000000-0000-4000-8000-00000000000d'), ('HC',  'a7000000-0000-4000-8000-00000000000e'),
  ('HX',  'a7000000-0000-4000-8000-00000000000f'), ('HJ',  'a7000000-0000-4000-8000-000000000010'),
  ('HN',  'a7000000-0000-4000-8000-000000000011'), ('HT',  'a7000000-0000-4000-8000-000000000012'),
  ('HZ',  'a7000000-0000-4000-8000-000000000013'), ('HR',  'a7000000-0000-4000-8000-000000000014'),
  ('HV',  'a7000000-0000-4000-8000-000000000015'), ('HM',  'a7000000-0000-4000-8000-000000000016'),
  ('HA',  'a7000000-0000-4000-8000-000000000017'), ('HB',  'a7000000-0000-4000-8000-000000000018'),
  ('HD',  'a7000000-0000-4000-8000-000000000019'), ('HI',  'a7000000-0000-4000-8000-00000000001a'),
  ('H0',  'a7000000-0000-4000-8000-00000000001b'), ('H1',  'a7000000-0000-4000-8000-00000000001c'),
  ('HSC', 'a7000000-0000-4000-8000-00000000001d'), ('HSE', 'a7000000-0000-4000-8000-00000000001e'),
  ('HCN', 'a7000000-0000-4000-8000-00000000001f'), ('HDL', 'a7000000-0000-4000-8000-000000000020'),
  ('HCL', 'a7000000-0000-4000-8000-000000000021'), ('HME', 'a7000000-0000-4000-8000-000000000022'),
  ('HRB', 'a7000000-0000-4000-8000-000000000023'), ('HIA', 'a7000000-0000-4000-8000-000000000024'),
  ('HIB', 'a7000000-0000-4000-8000-000000000025');

insert into auth.users (id, email, raw_user_meta_data)
select id, 'ca-' || lower(k) || '@pickleague.test', jsonb_build_object('full_name', 'CA Player ' || k)
  from _p where id::text like 'a7000000-%';

insert into public.venues (id, sport, name, kind, lat, lng, source, geofence_radius_m) values
  ('test:ca-alpha',     array['pickleball'], 'CA Test Courts Alpha',   'court', 40.50,     -100.0, 'google', 100),
  ('test:ca-alpha-osm', array['pickleball'], 'CA Test Courts Alpha',   'court', 40.50005,  -100.0, 'osm',    100),
  ('test:ca-bravo',     array['pickleball'], 'CA Test Courts Bravo',   'court', 40.51,     -100.0, 'google', 100),
  ('test:ca-charlie',   array['pickleball'], 'CA Test Courts Charlie', 'court', 40.52,     -100.0, 'google', 100),
  ('test:ca-gone',      array['pickleball'], 'CA Test Courts Gone',    'court', 40.53,     -100.0, 'google', 100),
  ('test:ca-delta',     array['pickleball'], 'CA Test Courts Delta',   'court', 40.54,     -100.0, 'google', 100),
  ('test:ca-s1',        array['pickleball'], 'CA Scan Court 1',        'court', 40.55004,  -100.0, 'osm',    100),
  ('test:ca-s2',        array['pickleball'], 'CA Scan Court 2',        'court', 40.5502,   -100.0, 'osm',    100),
  ('test:ca-s3',        array['pickleball'], 'CA Scan Court 3',        'court', 40.5504,   -100.0, 'osm',    100),
  ('test:ca-s4',        array['pickleball'], 'CA Scan Court 4',        'court', 40.5506,   -100.0, 'osm',    100),
  ('test:ca-s5',        array['pickleball'], 'CA Scan Court 5',        'court', 40.5508,   -100.0, 'osm',    100),
  ('test:ca-s6',        array['pickleball'], 'CA Scan Court 6',        'court', 40.5510,   -100.0, 'osm',    100),
  ('test:ca-s7',        array['pickleball'], 'CA Scan Court 7',        'court', 40.5512,   -100.0, 'osm',    100),
  ('test:ca-s8',        array['pickleball'], 'CA Scan Court 8',        'court', 40.5514,   -100.0, 'osm',    100),
  ('test:ca-s9',        array['pickleball'], 'CA Scan Court 9',        'court', 40.5516,   -100.0, 'osm',    100),
  ('test:ca-sb',        array['basketball'], 'CA Scan Hoops',          'court', 40.55003,  -100.0, 'osm',    100),
  ('test:ca-q1',        array['pickleball'], 'CA Scan Far 1',          'court', 40.5740,   -100.0, 'osm',    100),
  ('test:ca-q2',        array['pickleball'], 'CA Scan Far 2',          'court', 40.5755,   -100.0, 'osm',    100);
insert into public.venues (id, sport, name, kind, lat, lng, source, geofence_radius_m, confirmation_status)
values ('test:ca-sr', array['pickleball'], 'CA Scan Rejected', 'court', 40.55002, -100.0, 'osm', 100, 'rejected');
-- Outlines (GeoJSON, lng before lat): venue_geom_biu derives boundary_geom and
-- area_sqm. Big is about 220 m square, Small about 44 m; both hold 40.59 N.
insert into public.venues (id, sport, name, kind, lat, lng, source, geofence_radius_m, boundary) values
  ('test:ca-big',   array['pickleball'], 'CA Test Courts Big',   'court', 40.5905,  -100.0, 'osm', 100,
   '{"type":"Polygon","coordinates":[[[-100.0013,40.589],[-99.9987,40.589],[-99.9987,40.591],[-100.0013,40.591],[-100.0013,40.589]]]}'),
  ('test:ca-small', array['pickleball'], 'CA Test Courts Small', 'court', 40.59001, -100.0, 'osm', 100,
   '{"type":"Polygon","coordinates":[[[-100.00026,40.5898],[-99.99974,40.5898],[-99.99974,40.5902],[-100.00026,40.5902],[-100.00026,40.5898]]]}'),
  ('test:ca-yard',  array['pickleball'], 'CA Test Courts Yard',  'court', 40.61,    -100.0, 'osm', 100,
   '{"type":"Polygon","coordinates":[[[-100.00026,40.6098],[-99.99974,40.6098],[-99.99974,40.6102],[-100.00026,40.6102],[-100.00026,40.6098]]]}');
-- A duplicate row of Alpha, as _pl_dedupe_venues marks one.
update public.venues set canonical_id = 'test:ca-alpha' where id = 'test:ca-alpha-osm';

-- Persona k is ready for automatic check-in: has chosen who sees them at the
-- courts (consent) and starred each court. Leaves the role as k.
create function pg_temp.ca_ready(k text, p_venues text[]) returns void language plpgsql as $$
declare v text;
begin
  perform pg_temp.as_user(pg_temp.p(k));
  perform public.set_presence_settings(p_consent_seen => true);
  foreach v in array p_venues loop
    perform public.set_court_favorite(v, true);
  end loop;
end $$;

-- Push reaches persona k: a device token, and these preferences (push is
-- opt-in: pushEnabled must be true). Leaves the role as admin.
create function pg_temp.ca_push(k text, p_prefs jsonb default '{"pushEnabled": true}'::jsonb) returns void
language plpgsql as $$
begin
  perform pg_temp.as_admin();
  insert into public.push_tokens (user_id, token, platform)
  values (pg_temp.p(k), 'ExponentPushToken[ca-test-' || lower(k) || ']', 'ios');
  insert into public.user_preferences (user_id, prefs) values (pg_temp.p(k), p_prefs)
  on conflict (user_id) do update set prefs = excluded.prefs;
end $$;

-- The geofence Enter as the phone sends it: p_ago back (null: now), with the
-- check-in id the phone picked. Leaves the role as k.
create function pg_temp.ca_queue(k text, p_venue text, p_id uuid default null, p_ago interval default null)
returns jsonb language plpgsql as $$
declare j jsonb;
begin
  perform pg_temp.as_user(pg_temp.p(k));
  j := public.queue_court_arrival(p_venue => p_venue,
         p_arrived_at => case when p_ago is not null then now() - p_ago end, p_checkin_id => p_id);
  return j;
end $$;

-- The geofence Exit p_left_ago back (null: now), or Not here. Leaves the role as k.
create function pg_temp.ca_cancel(k text, p_venue text, p_left_ago interval default null, p_not_here boolean default false)
returns jsonb language plpgsql as $$
declare j jsonb;
begin
  perform pg_temp.as_user(pg_temp.p(k));
  j := public.cancel_court_arrival(p_venue => p_venue,
         p_left_at => case when p_left_ago is not null then now() - p_left_ago end, p_not_here => p_not_here);
  return j;
end $$;

-- One run of the pickleague-process-court-arrivals job. Leaves the role as admin.
create function pg_temp.ca_process() returns void language plpgsql as $$
begin
  perform pg_temp.as_admin();
  perform public.process_court_arrivals();
end $$;

-- An arrival check-in: the Enter p_ago back (1 to 10 minutes, so it is due
-- already), then the job's run. Raises when it isn't queued or doesn't land,
-- so the block reports why. Leaves the role as admin.
create function pg_temp.ca_arrive(k text, p_venue text, p_id uuid, p_ago interval default interval '2 minutes')
returns public.venue_checkins language plpgsql as $$
declare
  j jsonb;
  r public.venue_checkins;
begin
  j := pg_temp.ca_queue(k, p_venue, p_id, p_ago);
  if not coalesce((j ->> 'queued')::boolean, false) then
    raise exception 'arrival of % at % not queued: %', k, p_venue, j;
  end if;
  perform pg_temp.ca_process();
  r := pg_temp.vci(p_id);
  if r.id is null then
    raise exception 'arrival of % at % not checked in', k, p_venue;
  end if;
  return r;
end $$;

-- Waiting: persona k's waiting arrivals and Exit markers move p_by into the
-- past. Leaves the role as admin.
create function pg_temp.ca_wait(k text, p_by interval) returns void language plpgsql as $$
begin
  perform pg_temp.as_admin();
  update public.pl_pending_arrivals
     set arrived_at = arrived_at - p_by, due_at = due_at - p_by,
         cancelled_at = cancelled_at - p_by, created_at = created_at - p_by
   where user_id = pg_temp.p(k);
end $$;

-- Waiting: one check-in moves p_by into the past (its times, its fixes and
-- when it was stored). Leaves the role as admin.
create function pg_temp.ca_age(p_id uuid, p_by interval) returns void language plpgsql as $$
begin
  perform pg_temp.as_admin();
  update public.venue_checkins
     set checked_in_at = checked_in_at - p_by, expires_at = expires_at - p_by,
         checked_out_at = checked_out_at - p_by, taken_back_at = taken_back_at - p_by,
         fix_at = fix_at - p_by, arrival_fix_at = arrival_fix_at - p_by, created_at = created_at - p_by
   where id = p_id;
end $$;

-- Persona k's waiting arrival (or Exit marker) at a canonical court; all
-- nulls when there is none. Read past RLS.
create function pg_temp.ca_pending(k text, p_venue text) returns public.pl_pending_arrivals
language sql security definer as $$
  select * from public.pl_pending_arrivals where user_id = pg_temp.p(k) and venue_id = p_venue;
$$;

-- Pushes written straight to persona k's outbox (no feed row): push_data.kind
-- p_kind (any when null), for one check-in or court when given. Read past RLS.
create function pg_temp.ca_pushes(k text, p_kind text default null, p_checkin uuid default null, p_venue text default null)
returns int language sql security definer as $$
  select count(*)::int from public.push_outbox o
   where o.recipient_id = pg_temp.p(k) and o.notification_id is null
     and (p_kind is null or o.push_data ->> 'kind' = p_kind)
     and (p_checkin is null or o.push_data ->> 'checkin_id' = p_checkin::text)
     and (p_venue is null or o.push_data ->> 'venue_id' = p_venue);
$$;

-- The latest such push; all nulls when there is none.
create function pg_temp.ca_push_row(k text, p_kind text, p_checkin uuid default null, p_venue text default null)
returns public.push_outbox language sql security definer as $$
  select o.* from public.push_outbox o
   where o.recipient_id = pg_temp.p(k) and o.notification_id is null
     and o.push_data ->> 'kind' = p_kind
     and (p_checkin is null or o.push_data ->> 'checkin_id' = p_checkin::text)
     and (p_venue is null or o.push_data ->> 'venue_id' = p_venue)
   order by o.created_at desc, o.id
   limit 1;
$$;

-- The element of a JSON array whose venue_id is p_venue (null when none).
create function pg_temp.ca_elem(p_list jsonb, p_venue text) returns jsonb language sql immutable as $$
  select x.elem from jsonb_array_elements(coalesce(p_list, '[]'::jsonb)) x(elem) where x.elem ->> 'venue_id' = p_venue limit 1;
$$;

-- The venue_ids of a JSON array, in its order.
create function pg_temp.ca_ids(p_list jsonb) returns text[] language sql immutable as $$
  select coalesce(array_agg(x.elem ->> 'venue_id' order by x.ord), '{}')
    from jsonb_array_elements(coalesce(p_list, '[]'::jsonb)) with ordinality x(elem, ord);
$$;


-- ════ A1 grants, attributes, the re-applied bodies, the job ═════════════
do $$
declare
  f     text;
  v_bad text;
  v_client text[] := array[
    'public.get_court_arrival_settings()',
    'public.set_court_arrival_settings(integer,integer,boolean,boolean)',
    'public.list_starred_court_geofences()',
    'public.set_starred_court_auto_checkin(text,boolean)',
    'public.queue_court_arrival(text,timestamptz,uuid)',
    'public.cancel_court_arrival(text,timestamptz,boolean)',
    'public.confirm_court_arrival(text)',
    'public.court_arrival_pending(text)',
    'public.enqueue_court_checkin_prompt(text,text,text)',
    'public.court_prompt_scan(double precision,double precision,integer)'];
  v_new_internal text[] := array[
    'public._pl_throttle_ok(text,text,text,interval)', 'public._pl_push_reaches(uuid,text)',
    'public._pl_court_arrival_off(uuid,text)',
    'public._pl_court_arrival_push(uuid,text,text,text,text,text,uuid,timestamptz,boolean,timestamptz)',
    'public._pl_take_back_arrival(uuid,uuid[],timestamptz)', 'public.process_court_arrivals()',
    'public._pl_court_arrival_rerun_repair()'];
  v_replaced text[] := array[
    'public.expire_venue_checkins()', 'public._purge_account(uuid)', 'public.prune_presence_history()',
    'public._pl_session_validity(uuid)',
    'public._pl_record_checkout_fix(uuid[],double precision,double precision,double precision,double precision)',
    'public._pl_checkin_arrival_fix()', 'public._pl_checkin_stay_from_fix()'];
  -- Every allowlist addition of the court arrival change, the two court
  -- outline editor RPCs included (shipped 2026-10-17 without an entry).
  v_names text[] := array[
    'get_court_arrival_settings','set_court_arrival_settings','list_starred_court_geofences',
    'set_starred_court_auto_checkin','queue_court_arrival','cancel_court_arrival','confirm_court_arrival',
    'court_arrival_pending','enqueue_court_checkin_prompt','court_prompt_scan',
    'admin_list_venue_boundaries','admin_save_venue_boundary'];
begin
  perform pg_temp.as_admin();
  foreach f in array v_client loop
    perform pg_temp.ok('A1 authenticated may execute ' || f,
      to_regprocedure(f) is not null and has_function_privilege('authenticated', f, 'EXECUTE'));
    perform pg_temp.ok('A1 anon may not execute ' || f,
      to_regprocedure(f) is not null and not has_function_privilege('anon', f, 'EXECUTE'));
  end loop;
  foreach f in array v_new_internal || v_replaced loop
    perform pg_temp.ok('A1 internal, clients may not execute ' || f,
      to_regprocedure(f) is not null
      and not has_function_privilege('authenticated', f, 'EXECUTE')
      and not has_function_privilege('anon', f, 'EXECUTE'));
  end loop;

  -- The hardening file ran last, after the court arrival files' second run.
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.prosecdef and p.proname = any(v_names)
     and not has_function_privilege('authenticated', p.oid, 'EXECUTE');
  perform pg_temp.ok('A1 hardening re-run keeps all 12 allowlist additions executable (court outlines editor included)',
    v_bad is null, v_bad);
  select string_agg(w.name, ', ') into v_bad
    from unnest(v_names) w(name)
   where not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                      where ns.nspname = 'public' and p.prosecdef and p.proname = w.name);
  perform pg_temp.ok('A1 all 12 allowlist additions exist as SECURITY DEFINER functions', v_bad is null, v_bad);

  select string_agg(w.sig, ', ') into v_bad
    from unnest(v_client || v_new_internal) w(sig)
   where not exists (select 1 from pg_proc p where p.oid = to_regprocedure(w.sig)
                      and p.prosecdef and array_to_string(p.proconfig, ',') = 'search_path=""');
  perform pg_temp.ok('A1 every new function is SECURITY DEFINER with an empty search_path', v_bad is null, v_bad);

  -- Every replaced function keeps its one signature and its attributes,
  -- except _purge_account's search_path ('' now; live: public).
  -- The identity arguments list OUT parameters too (_pl_session_validity).
  with want(fn, args, definer, cfg) as (values
    ('_pl_checkin_arrival_fix', '', false, 'search_path=""'),
    ('_pl_checkin_stay_from_fix', '', false, 'search_path=""'),
    ('_pl_record_checkout_fix', 'p_ids uuid[], p_lat double precision, p_lng double precision, p_accuracy_m double precision, p_fix_age_ms double precision', true, 'search_path=""'),
    ('_pl_session_validity', 'p_session uuid, OUT valid boolean, OUT reason text, OUT pending boolean, OUT needs text, OUT window_ends_at timestamp with time zone, OUT at_court boolean', true, 'search_path=""'),
    ('expire_venue_checkins', '', true, 'search_path=""'),
    ('_purge_account', 'p_uid uuid', true, 'search_path=""'),
    ('prune_presence_history', '', true, 'search_path=""'),
    ('venue_set_geom', '', false, 'search_path=public, extensions'))
  select string_agg(w.fn || ' ' || coalesce(got.n::text, '0') || ' version(s)', '; ')
    into v_bad
    from want w
    left join lateral (
      select count(*) as n,
             bool_and(pg_get_function_identity_arguments(p.oid) = w.args
                      and p.prosecdef = w.definer
                      and array_to_string(p.proconfig, ',') is not distinct from w.cfg) as same
        from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
       where ns.nspname = 'public' and p.proname = w.fn) got on true
   where got.n is distinct from 1 or not got.same;
  perform pg_temp.ok('A1 every replaced function keeps its one signature, definer and search_path', v_bad is null, v_bad);

  -- The re-runs of migration_validity_rules.sql and migration_venue_checkins.sql
  -- put older bodies back; the builder re-applied the arrival files after them.
  with want(sig, needle) as (values
    ('public._pl_checkin_arrival_fix()', 'via_arrival'),
    ('public._pl_checkin_stay_from_fix()', 'via_arrival'),
    ('public._pl_record_checkout_fix(uuid[],double precision,double precision,double precision,double precision)', 'via_arrival'),
    ('public._pl_session_validity(uuid)', 'via_arrival'),
    ('public.expire_venue_checkins()', 'arrival_expired'),
    ('public._purge_account(uuid)', 'pl_pending_arrivals'),
    ('public.prune_presence_history()', 'pl_throttle'))
  select string_agg(w.sig, ', ') into v_bad
    from want w
   where not coalesce((select p.prosrc like '%' || w.needle || '%' from pg_proc p where p.oid = to_regprocedure(w.sig)), false);
  perform pg_temp.ok('A1 the arrival bodies are live after the older files'' re-runs (re-applied in order)', v_bad is null, v_bad);

  perform pg_temp.ok('A1 pl_pending_arrivals and pl_throttle: RLS on, nothing for clients',
    (select bool_and(c.relrowsecurity) from pg_class c
      where c.oid in ('public.pl_pending_arrivals'::regclass, 'public.pl_throttle'::regclass))
    and not has_table_privilege('authenticated', 'public.pl_pending_arrivals', 'SELECT, INSERT, UPDATE, DELETE')
    and not has_table_privilege('anon', 'public.pl_pending_arrivals', 'SELECT, INSERT, UPDATE, DELETE')
    and not has_table_privilege('authenticated', 'public.pl_throttle', 'SELECT, INSERT, UPDATE, DELETE')
    and not has_table_privilege('anon', 'public.pl_throttle', 'SELECT, INSERT, UPDATE, DELETE'));
  perform pg_temp.ok('A1 the open-arrival index and the venues lat/lng index exist',
    exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'venue_checkins_arrival_open_idx')
    and exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'venues_lat_lng_idx'));

  -- Applied twice: unscheduled, then scheduled again, so still one job.
  select string_agg(j.schedule || ' / ' || j.command, ' | ') into v_bad
    from cron.job j where j.jobname = 'pickleague-process-court-arrivals';
  perform pg_temp.ok('A1 one pg_cron job runs the processor, every 20 seconds (pg_cron 1.5+) or every minute',
    (select count(*) from cron.job where jobname = 'pickleague-process-court-arrivals') = 1
    and exists (select 1 from cron.job where jobname = 'pickleague-process-court-arrivals'
                 and schedule in ('20 seconds', '* * * * *') and command like '%public.process_court_arrivals()%'),
    v_bad);

  perform pg_temp.ok('A1 automatic check-in defaults on, for the account and for each starred court',
    (select column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'presence_settings' and column_name = 'auto_checkin') = 'true'
    and (select column_default from information_schema.columns
          where table_schema = 'public' and table_name = 'court_favorites' and column_name = 'auto_checkin') = 'true');
  perform pg_temp.ok('A1 both radii are CHECKed in the table',
    exists (select 1 from pg_constraint where conrelid = 'public.presence_settings'::regclass
             and conname = 'presence_settings_court_radius_m_check')
    and exists (select 1 from pg_constraint where conrelid = 'public.presence_settings'::regclass
                 and conname = 'presence_settings_other_court_radius_m_check'));
  perform pg_temp.ok('A1 nobody is left with automatic check-in off who never chose it (one-time update)',
    not exists (select 1 from public.presence_settings where not auto_checkin and auto_checkin_set_at is null));
  perform pg_temp.ok('A1 no court keeps an area without an outline (one-time cleanup)',
    not exists (select 1 from public.venues where boundary is null and area_sqm is not null));
  perform pg_temp.ok('A1 (setup) the test outlines were read: an area each, Small smaller than Big',
    (select bool_and(area_sqm > 0 and boundary_geom is not null) from public.venues
      where id in ('test:ca-big', 'test:ca-small', 'test:ca-yard'))
    and (select area_sqm from public.venues where id = 'test:ca-small')
        < (select area_sqm from public.venues where id = 'test:ca-big'));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('A1 block crashed', false, sqlerrm);
end $$;


-- ════ A2 signed out ══════════════════════════════════════════════════════
do $$
declare
  e   jsonb;
  q   text;
  bad text := '';
begin
  perform pg_temp.as_signed_out();
  foreach q in array array[
    'select public.get_court_arrival_settings()',
    'select public.set_court_arrival_settings(p_radius_m => 100)',
    'select public.list_starred_court_geofences()',
    'select public.set_starred_court_auto_checkin(''test:ca-alpha'', true)',
    'select public.queue_court_arrival(''test:ca-alpha'')',
    'select public.cancel_court_arrival(''test:ca-alpha'')',
    'select public.cancel_court_arrival(null)',
    'select public.confirm_court_arrival(''test:ca-alpha'')',
    'select public.court_arrival_pending(''test:ca-alpha'')',
    'select public.enqueue_court_checkin_prompt(''test:ca-alpha'')',
    'select public.court_prompt_scan(40.5, -100.0, 100)']
  loop
    e := pg_temp.err(q);
    if e is null or e ->> 'state' <> 'P0001'
       or e ->> 'msg' <> 'You''re signed out. Sign in to Pickleague and try again.'
       or e ->> 'hint' <> 'pl:auth.signed_out' then
      bad := bad || q || ' -> ' || coalesce(e::text, 'no error') || '; ';
    end if;
  end loop;
  perform pg_temp.as_admin();
  perform pg_temp.ok('A2 every new RPC tells a signed-out caller to sign in (P0001, pl:auth.signed_out)', bad = '', bad);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('A2 block crashed', false, sqlerrm);
end $$;


-- ════ A3 settings, starred courts for the geofences, the outline area ════
do $$
declare
  j   jsonb;
  e   jsonb;
  v_r int;
  me  uuid := pg_temp.p('HSE');
begin
  perform pg_temp.as_user(me);
  j := public.get_court_arrival_settings();
  perform pg_temp.ok('A3 no settings row: the defaults (100 m, other courts Off, automatic check-in and the reminder on)',
    j = '{"court_radius_m": 100, "other_court_radius_m": 0, "auto_checkin": true, "auto_checkin_set_at": null,
          "departure_reminder": true, "consent_seen": false}'::jsonb, j::text);
  j := public.set_court_arrival_settings(p_radius_m => 250);
  perform pg_temp.ok('A3 a setting saved alone leaves the others as they are',
    (j ->> 'court_radius_m')::int = 250 and (j ->> 'other_court_radius_m')::int = 0 and (j ->> 'auto_checkin')::boolean
    and j -> 'auto_checkin_set_at' = 'null'::jsonb and (j ->> 'departure_reminder')::boolean, j::text);
  j := public.set_court_arrival_settings(p_other_radius_m => 1000, p_auto => false, p_departure => false);
  perform pg_temp.ok('A3 choosing "Check me in when I arrive" stamps when, so no default or one-time update overrides it',
    (j ->> 'court_radius_m')::int = 250 and (j ->> 'other_court_radius_m')::int = 1000
    and not (j ->> 'auto_checkin')::boolean and (j ->> 'auto_checkin_set_at')::timestamptz = now()
    and not (j ->> 'departure_reminder')::boolean, j::text);
  e := pg_temp.err('select public.set_court_arrival_settings(p_radius_m => 50)');
  perform pg_temp.ok('A3 a distance the app doesn''t offer is refused: pl:request.bad',
    e ->> 'state' = 'P0001' and e ->> 'hint' = 'pl:request.bad', e::text);
  e := pg_temp.err('select public.set_court_arrival_settings(p_other_radius_m => 75)');
  perform pg_temp.ok('A3 ...for other courts too',
    e ->> 'state' = 'P0001' and e ->> 'hint' = 'pl:request.bad', e::text);
  j := public.get_court_arrival_settings();
  perform pg_temp.ok('A3 ...and nothing was saved',
    (j ->> 'court_radius_m')::int = 250 and (j ->> 'other_court_radius_m')::int = 1000, j::text);
  perform public.set_presence_settings(p_consent_seen => true);
  perform pg_temp.ok('A3 consent_seen follows "who sees me at the courts"',
    (public.get_court_arrival_settings() ->> 'consent_seen')::boolean);
  perform pg_temp.as_admin();
  perform pg_temp.ok('A3 the table refuses any other distance too (CHECK)',
    pg_temp.tt_try(format('update public.presence_settings set court_radius_m = 50 where user_id = %L', me)) like 'err:23514:%'
    and pg_temp.tt_try(format('update public.presence_settings set other_court_radius_m = 500 where user_id = %L', me)) like 'err:23514:%');

  -- Starred courts for the phone's geofences.
  select round(sqrt(v.area_sqm / pi()))::int into v_r from public.venues v where v.id = 'test:ca-yard';
  perform pg_temp.as_user(me);
  perform public.set_court_favorite('test:ca-yard', true);
  perform public.set_court_favorite('test:ca-bravo', true);
  j := public.list_starred_court_geofences();
  perform pg_temp.ok('A3 starred courts for the geofences, by name: an outline gives its equal-area radius, a pin none',
    pg_temp.ca_ids(j) = array['test:ca-bravo', 'test:ca-yard']
    and pg_temp.ca_elem(j, 'test:ca-bravo') -> 'radius_m' = 'null'::jsonb
    and (pg_temp.ca_elem(j, 'test:ca-bravo') ->> 'lat')::float8 = 40.51
    and (pg_temp.ca_elem(j, 'test:ca-bravo') ->> 'lng')::float8 = -100.0
    and pg_temp.ca_elem(j, 'test:ca-bravo') ->> 'name' = 'CA Test Courts Bravo'
    and (pg_temp.ca_elem(j, 'test:ca-yard') ->> 'radius_m')::int = v_r and v_r between 15 and 40
    and (pg_temp.ca_elem(j, 'test:ca-bravo') ->> 'auto_checkin')::boolean
    and (pg_temp.ca_elem(j, 'test:ca-yard') ->> 'auto_checkin')::boolean, j::text);
  perform pg_temp.ok('A3 the per-court switch: off for one starred court',
    public.set_starred_court_auto_checkin('test:ca-bravo', false));
  j := public.list_starred_court_geofences();
  perform pg_temp.ok('A3 ...and the list says so',
    not (pg_temp.ca_elem(j, 'test:ca-bravo') ->> 'auto_checkin')::boolean
    and (pg_temp.ca_elem(j, 'test:ca-yard') ->> 'auto_checkin')::boolean, j::text);
  perform public.set_court_favorite('test:ca-alpha', true);
  perform pg_temp.ok('A3 ...set through a duplicate row of a starred court too',
    public.set_starred_court_auto_checkin('test:ca-alpha-osm', false));
  perform pg_temp.ok('A3 ...false for a court that isn''t starred',
    not public.set_starred_court_auto_checkin('test:ca-charlie', true));
  perform public.set_court_favorite('test:ca-bravo', false);
  perform public.set_court_favorite('test:ca-bravo', true);
  j := public.list_starred_court_geofences();
  perform pg_temp.ok('A3 unstarring forgets the switch: a re-star starts on again',
    (pg_temp.ca_elem(j, 'test:ca-bravo') ->> 'auto_checkin')::boolean
    and not (pg_temp.ca_elem(j, 'test:ca-alpha') ->> 'auto_checkin')::boolean, j::text);

  -- Clearing an outline clears its area (before: the old area stayed).
  perform pg_temp.as_admin();
  update public.venues set boundary = null where id = 'test:ca-yard';
  perform pg_temp.ok('A3 clearing a court''s outline clears its area',
    (select area_sqm is null and boundary_geom is null from public.venues where id = 'test:ca-yard'));
  perform pg_temp.as_user(me);
  j := public.list_starred_court_geofences();
  perform pg_temp.ok('A3 ...so its circle goes back to my distance (no radius)',
    pg_temp.ca_elem(j, 'test:ca-yard') -> 'radius_m' = 'null'::jsonb, j::text);
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('A3 block crashed', false, sqlerrm);
end $$;


-- ════ A4 the happy path: queued, a minute, checked in, told ═════════════
do $$
declare
  j jsonb;
  r public.venue_checkins;
  o public.push_outbox;
  w public.pl_pending_arrivals;
  n int;
begin
  perform pg_temp.ca_ready('HH', array['test:ca-alpha']);
  perform pg_temp.ca_push('HH');
  -- The Enter, at the court's duplicate row: stored canonical.
  j := pg_temp.ca_queue('HH', 'test:ca-alpha-osm', 'c7000000-0000-4000-8000-000000000101');
  perform pg_temp.ok('A4 a real arrival at a starred court waits a minute, under the phone''s id; push reaches the player',
    (j ->> 'queued')::boolean and (j ->> 'pushable')::boolean and j ->> 'reason' is null
    and (j ->> 'due_at')::timestamptz = now() + interval '1 minute'
    and (j ->> 'checkin_id')::uuid = 'c7000000-0000-4000-8000-000000000101', j::text);
  perform pg_temp.ok('A4 ...court_arrival_pending says it is coming (by either row of the court)',
    public.court_arrival_pending('test:ca-alpha') and public.court_arrival_pending('test:ca-alpha-osm'));
  perform pg_temp.ca_process();
  w := pg_temp.ca_pending('HH', 'test:ca-alpha');
  r := pg_temp.vci('c7000000-0000-4000-8000-000000000101');
  perform pg_temp.ok('A4 before its minute is up the job leaves it waiting',
    w.due_at = now() + interval '1 minute' and w.cancelled_at is null and r.id is null, w::text);

  -- A minute and 10 seconds later.
  perform pg_temp.ca_wait('HH', interval '70 seconds');
  perform pg_temp.ca_process();
  r := pg_temp.vci('c7000000-0000-4000-8000-000000000101');
  perform pg_temp.ok('A4 still there a minute later: checked in from the arrival for 30 minutes, presence only (no fix)',
    r.user_id = pg_temp.p('HH') and r.venue_id = 'test:ca-alpha' and r.source = 'geofence'
    and r.via_arrival and r.location_confirmed and not r.arrival_confirmed and r.taken_back_at is null
    and r.checked_in_at = now() - interval '70 seconds'
    and r.expires_at = now() - interval '70 seconds' + interval '30 minutes'
    and r.checked_out_at is null and r.fix_at is null and r.arrival_fix_at is null and not r.stay_confirmed
    and r.arrival_closed_ids is null, r::text);
  w := pg_temp.ca_pending('HH', 'test:ca-alpha');
  perform pg_temp.ok('A4 ...the waiting arrival is used up', w.user_id is null, w::text);
  o := pg_temp.ca_push_row('HH', 'arrival_checkin');
  perform pg_temp.ok('A4 ...and "✅ Checked in at <court>" goes straight to the outbox (no feed row), with what its buttons need',
    o.notification_id is null and o.kind = 'info' and o.category = 'notifyAutoCheckins' and o.status = 'pending'
    and o.title = '✅ Checked in at CA Test Courts Alpha'
    and o.body = 'You''re checked in. Check out when you leave, or tap Stay 1 more hour if you''re staying.'
    and o.deep_link = 'home/-' and o.expires_at = now() + interval '30 minutes'
    and o.push_data ->> 'venue_id' = 'test:ca-alpha' and o.push_data ->> 'venue_name' = 'CA Test Courts Alpha'
    and o.push_data ->> 'checkin_id' = 'c7000000-0000-4000-8000-000000000101'
    and (o.push_data ->> 'expires_at')::timestamptz = r.expires_at
    and o.push_data -> 'via_arrival' = 'true'::jsonb, o::text);

  j := pg_temp.ca_queue('HH', 'test:ca-alpha');
  perform pg_temp.ok('A4 another Enter while checked in there: already_checked_in (open), nothing waits',
    not (j ->> 'queued')::boolean and j ->> 'reason' = 'already_checked_in' and (j ->> 'open')::boolean
    and not public.court_arrival_pending('test:ca-alpha'), j::text);
  perform pg_temp.ca_process();
  select count(*) into n from public.venue_checkins where user_id = pg_temp.p('HH');
  perform pg_temp.ok('A4 another run of the job adds nothing',
    n = 1 and pg_temp.ca_pushes('HH', 'arrival_checkin') = 1, n::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('A4 block crashed', false, sqlerrm);
end $$;


-- ════ A5 the queue's answers, in order ══════════════════════════════════
do $$
declare j jsonb;
begin
  perform pg_temp.as_user(pg_temp.p('HQ'));
  j := public.queue_court_arrival('test:ca-nowhere');
  perform pg_temp.ok('A5 a court Pickleague doesn''t have: court_gone',
    not (j ->> 'queued')::boolean and j ->> 'reason' = 'court_gone', j::text);
  j := public.queue_court_arrival('test:ca-alpha');
  perform pg_temp.ok('A5 no settings row (the defaults: on, 100 m), not starred: not_starred',
    j ->> 'reason' = 'not_starred', j::text);
  perform public.set_court_favorite('test:ca-alpha', true);
  perform public.set_court_arrival_settings(p_auto => false);
  j := public.queue_court_arrival('test:ca-alpha');
  perform pg_temp.ok('A5 "Check me in when I arrive" off: off', j ->> 'reason' = 'off', j::text);
  perform public.set_court_arrival_settings(p_auto => true, p_radius_m => 0);
  j := public.queue_court_arrival('test:ca-alpha');
  perform pg_temp.ok('A5 "Notice me at starred courts" at Off: off', j ->> 'reason' = 'off', j::text);
  perform public.set_court_arrival_settings(p_radius_m => 100);
  perform public.set_starred_court_auto_checkin('test:ca-alpha', false);
  j := public.queue_court_arrival('test:ca-alpha');
  perform pg_temp.ok('A5 switched off for this court: off_here', j ->> 'reason' = 'off_here', j::text);
  perform public.set_starred_court_auto_checkin('test:ca-alpha', true);
  j := public.queue_court_arrival('test:ca-alpha');
  perform pg_temp.ok('A5 never chose who sees me at the courts: no_consent; push can''t reach me (no device)',
    j ->> 'reason' = 'no_consent' and not (j ->> 'pushable')::boolean, j::text);
  perform pg_temp.ok('A5 none of those left an arrival waiting', not public.court_arrival_pending('test:ca-alpha'));

  perform public.set_presence_settings(p_consent_seen => true);
  perform pg_temp.checkin('HQ', 'c7000000-0000-4000-8000-000000000201', 'test:ca-alpha', 120, 40.5001);
  j := public.queue_court_arrival('test:ca-alpha');
  perform pg_temp.ok('A5 an open check-in of mine there: already_checked_in (open)',
    j ->> 'reason' = 'already_checked_in' and (j ->> 'open')::boolean, j::text);
  perform public.checkout_venue(null, null, now());
  perform pg_temp.checkin('HQ', 'c7000000-0000-4000-8000-000000000202', 'test:ca-bravo', 120, 40.5101);
  j := pg_temp.ca_queue('HQ', 'test:ca-alpha', 'c7000000-0000-4000-8000-000000000203');
  perform pg_temp.ok('A5 closed there, open elsewhere: queued (only an open check-in at this court holds it)',
    (j ->> 'queued')::boolean and not (j ->> 'pushable')::boolean, j::text);
  perform public.cancel_court_arrival('test:ca-alpha');
  perform public.checkout_venue(null, null, now());
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('A5 block crashed', false, sqlerrm);
end $$;


-- ════ A6 an open check-in at the court before the minute is up ══════════
do $$
declare
  j jsonb;
  r public.venue_checkins;
  m public.venue_checkins;
  w public.pl_pending_arrivals;
begin
  perform pg_temp.ca_ready('HO', array['test:ca-alpha']);
  j := pg_temp.ca_queue('HO', 'test:ca-alpha', 'c7000000-0000-4000-8000-000000000301');
  -- Checked in by hand there, with a fix, while the arrival waits.
  r := pg_temp.checkin('HO', 'c7000000-0000-4000-8000-000000000302', 'test:ca-alpha', 120, 40.5001);
  perform pg_temp.ca_wait('HO', interval '70 seconds');
  perform pg_temp.ca_process();
  m := pg_temp.vci('c7000000-0000-4000-8000-000000000302');
  w := pg_temp.ca_pending('HO', 'test:ca-alpha');
  perform pg_temp.ok('A6 an open check-in of mine at the court already: the arrival is dropped quietly (no row, no push)',
    (j ->> 'queued')::boolean and (pg_temp.vci('c7000000-0000-4000-8000-000000000301')).id is null
    and pg_temp.ca_pushes('HO') = 0 and w.user_id is null, j::text);
  perform pg_temp.ok('A6 ...and the check-in made by hand is untouched',
    m.checked_out_at is null and not m.via_arrival and m.source = 'manual' and m.arrival_closed_ids is null
    and m.expires_at = r.expires_at and m.fix_at is not distinct from r.fix_at, m::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('A6 block crashed', false, sqlerrm);
end $$;


-- ════ A7 checked in elsewhere: one open check-in per player (S11) ═══════
do $$
declare
  j jsonb;
  a public.venue_checkins;
  b public.venue_checkins;
begin
  -- HS: at Alpha by hand since 20 minutes ago; arrives at Bravo 2 minutes ago.
  perform pg_temp.ca_ready('HS', array['test:ca-bravo']);
  perform pg_temp.checkin('HS', 'c7000000-0000-4000-8000-000000000401', 'test:ca-alpha', 120, 40.5001);
  perform pg_temp.ca_age('c7000000-0000-4000-8000-000000000401', interval '20 minutes');
  b := pg_temp.ca_arrive('HS', 'test:ca-bravo', 'c7000000-0000-4000-8000-000000000402');
  a := pg_temp.vci('c7000000-0000-4000-8000-000000000401');
  perform pg_temp.ok('A7 an arrival check-in at Bravo closes mine at Alpha at the arrival, and remembers it',
    b.checked_out_at is null and b.checked_in_at = now() - interval '2 minutes'
    and b.arrival_closed_ids = array['c7000000-0000-4000-8000-000000000401'::uuid]
    and a.checked_out_at = now() - interval '2 minutes', a::text || ' ' || b::text);
  j := pg_temp.ca_cancel('HS', 'test:ca-bravo');
  a := pg_temp.vci('c7000000-0000-4000-8000-000000000401');
  b := pg_temp.vci('c7000000-0000-4000-8000-000000000402');
  perform pg_temp.ok('A7 leaving Bravo within 5 minutes takes it back and reopens Alpha (still running)',
    (j ->> 'removed')::boolean and (j ->> 'closed')::boolean and not (j ->> 'dropped')::boolean
    and b.taken_back_at = now() and b.checked_out_at = now() and not b.location_confirmed
    and a.checked_out_at is null and a.expires_at = now() + interval '100 minutes',
    j::text || ' ' || a::text || ' ' || b::text);

  -- HU: the same, but leaving Bravo 6 minutes after arriving.
  perform pg_temp.ca_ready('HU', array['test:ca-bravo']);
  perform pg_temp.checkin('HU', 'c7000000-0000-4000-8000-000000000411', 'test:ca-alpha', 120, 40.5001);
  perform pg_temp.ca_age('c7000000-0000-4000-8000-000000000411', interval '30 minutes');
  b := pg_temp.ca_arrive('HU', 'test:ca-bravo', 'c7000000-0000-4000-8000-000000000412', interval '6 minutes');
  j := pg_temp.ca_cancel('HU', 'test:ca-bravo');
  a := pg_temp.vci('c7000000-0000-4000-8000-000000000411');
  b := pg_temp.vci('c7000000-0000-4000-8000-000000000412');
  perform pg_temp.ok('A7 leaving Bravo 6 minutes after arriving takes nothing back: Bravo stays, Alpha stays closed',
    not (j ->> 'removed')::boolean and not (j ->> 'closed')::boolean
    and b.checked_out_at is null and b.taken_back_at is null and b.location_confirmed
    and a.checked_out_at = now() - interval '6 minutes', j::text || ' ' || a::text || ' ' || b::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('A7 block crashed', false, sqlerrm);
end $$;


-- ════ A8 not checked in, told why: a play session, a removed court ══════
do $$
declare
  j jsonb;
  o public.push_outbox;
begin
  -- HP: a play session running (no court).
  perform pg_temp.ca_ready('HP', array['test:ca-alpha']);
  perform public.start_play_session(p_id => 'e7000000-0000-4000-8000-000000000501', p_kind => 'open_play');
  j := pg_temp.ca_queue('HP', 'test:ca-alpha', 'c7000000-0000-4000-8000-000000000501', interval '2 minutes');
  perform pg_temp.ca_process();
  o := pg_temp.ca_push_row('HP', 'arrival_failed');
  perform pg_temp.ok('A8 a play session running: no check-in, and "Not checked in at <court>" says why',
    (j ->> 'queued')::boolean and (pg_temp.vci('c7000000-0000-4000-8000-000000000501')).id is null
    and o.title = 'Not checked in at CA Test Courts Alpha'
    and o.body = 'You have a play session running, so we didn''t check you in here.'
    and o.kind = 'info' and o.category = 'notifyAutoCheckins' and o.deep_link = 'home/-'
    and o.expires_at = now() + interval '30 minutes' and o.notification_id is null
    and o.push_data ->> 'venue_id' = 'test:ca-alpha' and not (o.push_data ? 'checkin_id')
    and pg_temp.ca_pushes('HP', 'arrival_checkin') = 0, o::text);
  perform pg_temp.as_user(pg_temp.p('HP'));
  perform public.end_play_session('e7000000-0000-4000-8000-000000000501', now());

  -- HG: the court is removed from Pickleague during the minute.
  perform pg_temp.ca_ready('HG', array['test:ca-gone']);
  j := pg_temp.ca_queue('HG', 'test:ca-gone', 'c7000000-0000-4000-8000-000000000511', interval '2 minutes');
  perform pg_temp.as_admin();
  delete from public.venues where id = 'test:ca-gone';
  perform pg_temp.ca_process();
  o := pg_temp.ca_push_row('HG', 'arrival_failed');
  perform pg_temp.ok('A8 the court removed during the minute: no check-in, told why, with no link (no name to show)',
    (j ->> 'queued')::boolean and (pg_temp.vci('c7000000-0000-4000-8000-000000000511')).id is null
    and o.title = 'Not checked in at your starred court'
    and o.body = 'That court isn''t in Pickleague anymore, so we couldn''t check you in.'
    and o.deep_link is null and o.push_data ->> 'venue_id' = 'test:ca-gone'
    and not (o.push_data ? 'venue_name'), o::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('A8 block crashed', false, sqlerrm);
end $$;


-- ════ A9 changed while it waited: dropped quietly ═══════════════════════
do $$
declare
  n int;
  r public.venue_checkins;
  m public.venue_checkins;
begin
  -- HW: unstars Alpha and switches Bravo off while both arrivals wait.
  perform pg_temp.ca_ready('HW', array['test:ca-alpha', 'test:ca-bravo']);
  perform pg_temp.ca_queue('HW', 'test:ca-alpha', 'c7000000-0000-4000-8000-000000000601');
  perform pg_temp.ca_queue('HW', 'test:ca-bravo', 'c7000000-0000-4000-8000-000000000602');
  perform public.set_court_favorite('test:ca-alpha', false);
  perform public.set_starred_court_auto_checkin('test:ca-bravo', false);
  perform pg_temp.ca_wait('HW', interval '70 seconds');
  perform pg_temp.ca_process();
  perform pg_temp.ok('A9 unstarred, or switched off for that court, while it waited: no check-in, no push',
    (pg_temp.vci('c7000000-0000-4000-8000-000000000601')).id is null
    and (pg_temp.vci('c7000000-0000-4000-8000-000000000602')).id is null
    and pg_temp.ca_pushes('HW') = 0
    and not exists (select 1 from public.pl_pending_arrivals where user_id = pg_temp.p('HW')));

  -- HY: presses Check out on the phone's own "Checked in" before the row landed.
  perform pg_temp.ca_ready('HY', array['test:ca-alpha']);
  perform pg_temp.ca_queue('HY', 'test:ca-alpha', 'c7000000-0000-4000-8000-000000000611', interval '2 minutes');
  select public.checkout_venue(p_id => 'c7000000-0000-4000-8000-000000000611', p_source => null, p_at => now()) into n;
  perform pg_temp.ca_process();
  perform pg_temp.ok('A9 checked out under the arrival''s id before it landed: never stored, no push',
    n = 0 and (pg_temp.vci('c7000000-0000-4000-8000-000000000611')).id is null and pg_temp.ca_pushes('HY') = 0, n::text);

  -- HME: arrives at Alpha, then checks in by hand at Bravo (with a fix) before
  -- the minute is up. The newer, confirmed check-in stands (no arrival closes
  -- it, as no replay closes a check-in made after its tap), and the arrival is
  -- dropped quietly.
  perform pg_temp.ca_ready('HME', array['test:ca-alpha']);
  perform pg_temp.ca_push('HME');
  perform pg_temp.ca_queue('HME', 'test:ca-alpha', 'c7000000-0000-4000-8000-000000000621', interval '2 minutes');
  r := pg_temp.checkin('HME', 'c7000000-0000-4000-8000-000000000622', 'test:ca-bravo', 120, 40.5101);
  perform pg_temp.ca_process();
  m := pg_temp.vci('c7000000-0000-4000-8000-000000000622');
  perform pg_temp.ok('A9 checked in by hand at another court during the minute: that check-in stands, the arrival is dropped quietly',
    (pg_temp.vci('c7000000-0000-4000-8000-000000000621')).id is null and pg_temp.ca_pushes('HME') = 0
    and (pg_temp.ca_pending('HME', 'test:ca-alpha')).user_id is null
    and r.location_confirmed and m.checked_out_at is null and m.expires_at = r.expires_at, m::text);
  perform pg_temp.as_user(pg_temp.p('HME'));
  perform public.checkout_venue(null, null, now());
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('A9 block crashed', false, sqlerrm);
end $$;


-- ════ A10 Exit and re-entry; late Enters ════════════════════════════════
do $$
declare
  j jsonb;
  r public.venue_checkins;
  w public.pl_pending_arrivals;
begin
  -- HE: an Exit before the minute is up, then back.
  perform pg_temp.ca_ready('HE', array['test:ca-alpha']);
  perform pg_temp.ca_queue('HE', 'test:ca-alpha', 'c7000000-0000-4000-8000-000000000701');
  j := pg_temp.ca_cancel('HE', 'test:ca-alpha');
  perform pg_temp.ok('A10 an Exit before the minute is up: dropped (nothing was stored, nothing taken back)',
    (j ->> 'dropped')::boolean and not (j ->> 'closed')::boolean and not (j ->> 'removed')::boolean
    and not public.court_arrival_pending('test:ca-alpha'), j::text);
  perform pg_temp.ca_wait('HE', interval '3 minutes');
  perform pg_temp.ca_process();
  perform pg_temp.ok('A10 ...and the job never checks it in', (pg_temp.vci('c7000000-0000-4000-8000-000000000701')).id is null);
  j := pg_temp.ca_queue('HE', 'test:ca-alpha', 'c7000000-0000-4000-8000-000000000702');
  perform pg_temp.ok('A10 back 3 minutes after leaving: recently_left (the phone prompts instead)',
    not (j ->> 'queued')::boolean and j ->> 'reason' = 'recently_left', j::text);
  j := pg_temp.ca_queue('HE', 'test:ca-alpha', 'c7000000-0000-4000-8000-000000000703', interval '5 minutes');
  perform pg_temp.ok('A10 an Enter from before the Exit that lands after it: left',
    not (j ->> 'queued')::boolean and j ->> 'reason' = 'left', j::text);
  w := pg_temp.ca_pending('HE', 'test:ca-alpha');
  perform pg_temp.ok('A10 ...neither one replaced the Exit''s marker',
    w.cancelled_at = now() - interval '3 minutes' and w.checkin_id = 'c7000000-0000-4000-8000-000000000701', w::text);
  perform pg_temp.ca_wait('HE', interval '8 minutes');
  j := pg_temp.ca_queue('HE', 'test:ca-alpha', 'c7000000-0000-4000-8000-000000000704');
  perform pg_temp.ok('A10 back 11 minutes after leaving: queued again',
    (j ->> 'queued')::boolean and (j ->> 'checkin_id')::uuid = 'c7000000-0000-4000-8000-000000000704'
    and (j ->> 'due_at')::timestamptz = now() + interval '1 minute', j::text);
  perform public.cancel_court_arrival('test:ca-alpha');

  -- HF: an Exit within 5 minutes of a check-in on arrival.
  perform pg_temp.ca_ready('HF', array['test:ca-alpha']);
  perform pg_temp.ca_push('HF');
  r := pg_temp.ca_arrive('HF', 'test:ca-alpha', 'c7000000-0000-4000-8000-000000000711');
  perform pg_temp.ok('A10 (setup) checked in on arrival, its push queued',
    r.via_arrival and pg_temp.ca_pushes('HF', 'arrival_checkin', 'c7000000-0000-4000-8000-000000000711') = 1, r::text);
  j := pg_temp.ca_cancel('HF', 'test:ca-alpha');
  r := pg_temp.vci('c7000000-0000-4000-8000-000000000711');
  perform pg_temp.ok('A10 an Exit 2 minutes after arriving: removed, and closed = removed',
    (j ->> 'removed')::boolean and (j ->> 'closed')::boolean and not (j ->> 'dropped')::boolean, j::text);
  perform pg_temp.ok('A10 ...taken back, not deleted: closed at the Exit, unconfirmed (shown to nobody, counted nowhere)',
    r.taken_back_at = now() and r.checked_out_at = now() and not r.location_confirmed and r.via_arrival, r::text);
  perform pg_temp.ok('A10 ...and its unsent push is deleted',
    pg_temp.ca_pushes('HF', null, 'c7000000-0000-4000-8000-000000000711') = 0);
  j := pg_temp.ca_cancel('HF', 'test:ca-alpha');
  perform pg_temp.ok('A10 the same Exit replayed (offline queue): nothing more to do',
    not (j ->> 'dropped')::boolean and not (j ->> 'closed')::boolean and not (j ->> 'removed')::boolean, j::text);

  -- HL: Enters that reach Pickleague late.
  perform pg_temp.ca_ready('HL', array['test:ca-alpha', 'test:ca-bravo']);
  j := pg_temp.ca_queue('HL', 'test:ca-alpha', 'c7000000-0000-4000-8000-000000000721', interval '9 minutes');
  w := pg_temp.ca_pending('HL', 'test:ca-alpha');
  perform pg_temp.ok('A10 an Enter 9 minutes late keeps its time (so it is due already)',
    (j ->> 'queued')::boolean and w.arrived_at = now() - interval '9 minutes'
    and w.due_at = now() - interval '8 minutes', w::text);
  j := pg_temp.ca_queue('HL', 'test:ca-bravo', 'c7000000-0000-4000-8000-000000000722', interval '11 minutes');
  w := pg_temp.ca_pending('HL', 'test:ca-bravo');
  perform pg_temp.ok('A10 one 11 minutes late counts from now',
    (j ->> 'queued')::boolean and w.arrived_at = now() and w.due_at = now() + interval '1 minute', w::text);
  j := pg_temp.ca_queue('HL', 'test:ca-bravo', 'c7000000-0000-4000-8000-000000000723', interval '1 minute');
  perform pg_temp.ok('A10 a second Enter for the same arrival keeps the first one''s time and id',
    (j ->> 'queued')::boolean and (j ->> 'checkin_id')::uuid = 'c7000000-0000-4000-8000-000000000722'
    and (j ->> 'due_at')::timestamptz = now() + interval '1 minute', j::text);
  perform public.cancel_court_arrival(null);
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('A10 block crashed', false, sqlerrm);
end $$;


-- ════ A11 a taken-back check-in never holds anything ════════════════════
do $$
declare
  j jsonb;
  r public.venue_checkins;
begin
  perform pg_temp.ca_ready('HK', array['test:ca-alpha']);
  perform pg_temp.ca_push('HK');
  r := pg_temp.ca_arrive('HK', 'test:ca-alpha', 'c7000000-0000-4000-8000-000000000801');
  j := pg_temp.ca_cancel('HK', 'test:ca-alpha');
  perform pg_temp.ok('A11 (setup) taken back', (j ->> 'removed')::boolean, j::text);
  -- 15 minutes later.
  perform pg_temp.ca_age('c7000000-0000-4000-8000-000000000801', interval '15 minutes');
  perform pg_temp.ca_wait('HK', interval '15 minutes');
  perform pg_temp.as_user(pg_temp.p('HK'));
  j := public.enqueue_court_checkin_prompt('test:ca-alpha');
  perform pg_temp.ok('A11 back 15 minutes after a take-back: "Check in nearby?" isn''t held (it was never a visit)',
    (j ->> 'enqueued')::boolean, j::text);
  j := pg_temp.ca_queue('HK', 'test:ca-alpha', 'c7000000-0000-4000-8000-000000000802');
  perform pg_temp.ok('A11 ...and the arrival queues', (j ->> 'queued')::boolean, j::text);
  perform public.cancel_court_arrival('test:ca-alpha');
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('A11 block crashed', false, sqlerrm);
end $$;


-- ════ A12 confirmed, extended or adopted: no take-back ══════════════════
do $$
declare
  j        jsonb;
  v_conf   boolean;
  v_coming boolean;
  r        public.venue_checkins;
begin
  -- HC: Check in now (no fix) on "At X?".
  perform pg_temp.ca_ready('HC', array['test:ca-alpha']);
  perform pg_temp.ca_queue('HC', 'test:ca-alpha', 'c7000000-0000-4000-8000-000000000901');
  v_conf := public.confirm_court_arrival('test:ca-alpha');
  v_coming := public.court_arrival_pending('test:ca-alpha');
  perform pg_temp.ok('A12 Check in now while the arrival waits: nothing to confirm yet, but it is still coming',
    not v_conf and v_coming);
  perform pg_temp.ca_wait('HC', interval '2 minutes');
  perform pg_temp.ca_process();
  perform pg_temp.as_user(pg_temp.p('HC'));
  v_conf := public.confirm_court_arrival('test:ca-alpha');
  r := pg_temp.vci('c7000000-0000-4000-8000-000000000901');
  perform pg_temp.ok('A12 Check in now after it landed: confirmed', v_conf and r.arrival_confirmed, r::text);
  j := pg_temp.ca_cancel('HC', 'test:ca-alpha');
  r := pg_temp.vci('c7000000-0000-4000-8000-000000000901');
  perform pg_temp.ok('A12 ...then an Exit within 5 minutes takes nothing back',
    not (j ->> 'removed')::boolean and not (j ->> 'closed')::boolean
    and r.checked_out_at is null and r.taken_back_at is null and r.location_confirmed, j::text || ' ' || r::text);

  -- HX: Stay 1 more hour, which sends no fix on an arrival check-in.
  perform pg_temp.ca_ready('HX', array['test:ca-alpha']);
  perform pg_temp.ca_arrive('HX', 'test:ca-alpha', 'c7000000-0000-4000-8000-000000000911');
  perform pg_temp.as_user(pg_temp.p('HX'));
  select * into r from public.extend_checkin('c7000000-0000-4000-8000-000000000911', now() + interval '1 hour');
  perform pg_temp.ok('A12 Stay 1 more hour on an arrival check-in with no fix (1.0.4''s extend_checkin, unchanged): extends',
    r.expires_at = now() + interval '1 hour' and r.fix_at is null and r.arrival_fix_at is null and r.location_confirmed,
    r::text);
  j := pg_temp.ca_cancel('HX', 'test:ca-alpha');
  r := pg_temp.vci('c7000000-0000-4000-8000-000000000911');
  perform pg_temp.ok('A12 ...then an Exit within 5 minutes takes nothing back',
    not (j ->> 'removed')::boolean and r.checked_out_at is null and r.taken_back_at is null, j::text || ' ' || r::text);

  -- HJ: a play session started at the court adopts it.
  perform pg_temp.ca_ready('HJ', array['test:ca-alpha']);
  perform pg_temp.ca_arrive('HJ', 'test:ca-alpha', 'c7000000-0000-4000-8000-000000000921');
  perform pg_temp.as_user(pg_temp.p('HJ'));
  perform public.start_play_session(p_id => 'e7000000-0000-4000-8000-000000000921', p_kind => 'open_play',
    p_venue => 'test:ca-alpha');
  j := pg_temp.ca_cancel('HJ', 'test:ca-alpha');
  r := pg_temp.vci('c7000000-0000-4000-8000-000000000921');
  perform pg_temp.ok('A12 a Start at the court adopts it; an Exit within 5 minutes then takes nothing back',
    not (j ->> 'removed')::boolean and r.checked_out_at is null and r.taken_back_at is null
    and r.expires_at > r.checked_in_at + interval '30 minutes', j::text || ' ' || r::text);
  perform pg_temp.as_user(pg_temp.p('HJ'));
  perform public.end_play_session('e7000000-0000-4000-8000-000000000921', now());
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('A12 block crashed', false, sqlerrm);
end $$;


-- ════ A13 Not here ═══════════════════════════════════════════════════════
do $$
declare
  j jsonb;
  r public.venue_checkins;
begin
  perform pg_temp.ca_ready('HN', array['test:ca-alpha', 'test:ca-bravo']);
  perform pg_temp.ca_arrive('HN', 'test:ca-alpha', 'c7000000-0000-4000-8000-000000000a01');
  j := pg_temp.ca_cancel('HN', 'test:ca-alpha', null, true);
  r := pg_temp.vci('c7000000-0000-4000-8000-000000000a01');
  perform pg_temp.ok('A13 Not here 2 minutes after arriving: removed (taken back)',
    (j ->> 'removed')::boolean and not (j ->> 'closed')::boolean
    and r.taken_back_at = now() and not r.location_confirmed, j::text || ' ' || r::text);
  perform pg_temp.ca_arrive('HN', 'test:ca-bravo', 'c7000000-0000-4000-8000-000000000a02', interval '6 minutes');
  j := pg_temp.ca_cancel('HN', 'test:ca-bravo', null, true);
  r := pg_temp.vci('c7000000-0000-4000-8000-000000000a02');
  perform pg_temp.ok('A13 Not here 6 minutes after arriving: closed (checked out now), not taken back',
    (j ->> 'closed')::boolean and not (j ->> 'removed')::boolean
    and r.checked_out_at = now() and r.taken_back_at is null and r.location_confirmed, j::text || ' ' || r::text);
  j := pg_temp.ca_cancel('HN', 'test:ca-charlie', null, true);
  perform pg_temp.ok('A13 Not here with nothing waiting or open there: all three false',
    not (j ->> 'dropped')::boolean and not (j ->> 'closed')::boolean and not (j ->> 'removed')::boolean, j::text);
  perform pg_temp.checkin('HN', 'c7000000-0000-4000-8000-000000000a03', 'test:ca-charlie', 120, 40.5201);
  j := pg_temp.ca_cancel('HN', 'test:ca-charlie', interval '10 minutes', true);
  r := pg_temp.vci('c7000000-0000-4000-8000-000000000a03');
  perform pg_temp.ok('A13 a queued Not here (pressed 10 minutes ago) never closes a check-in made after it',
    not (j ->> 'closed')::boolean and r.checked_out_at is null, j::text || ' ' || r::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('A13 block crashed', false, sqlerrm);
end $$;


-- ════ A14 "Still at <court>?" ═══════════════════════════════════════════
do $$
declare
  r public.venue_checkins;
  o public.push_outbox;
begin
  -- HT: an untouched arrival check-in, 3 minutes from its end.
  perform pg_temp.ca_ready('HT', array['test:ca-alpha']);
  perform pg_temp.ca_arrive('HT', 'test:ca-alpha', 'c7000000-0000-4000-8000-000000000b01');
  perform pg_temp.ok('A14 no "Still at" while more than 5 minutes are left', pg_temp.ca_pushes('HT', 'arrival_extend') = 0);
  perform pg_temp.ca_age('c7000000-0000-4000-8000-000000000b01', interval '25 minutes');
  perform pg_temp.ca_process();
  o := pg_temp.ca_push_row('HT', 'arrival_extend');
  perform pg_temp.ok('A14 5 minutes before an arrival check-in ends: "Still at <court>?", worth sending until it ends',
    o.title = 'Still at CA Test Courts Alpha?'
    and o.body = 'Your check-in ends in 5 minutes. Tap Stay 1 more hour if you''re staying.'
    and o.kind = 'info' and o.category = 'notifyAutoCheckins' and o.deep_link = 'home/-'
    and o.expires_at = now() + interval '3 minutes'
    and o.push_data ->> 'checkin_id' = 'c7000000-0000-4000-8000-000000000b01'
    and (o.push_data ->> 'expires_at')::timestamptz = now() + interval '3 minutes'
    and o.push_data -> 'via_arrival' = 'true'::jsonb, o::text);
  perform pg_temp.ca_process();
  perform pg_temp.ok('A14 ...once', pg_temp.ca_pushes('HT', 'arrival_extend') = 1);

  -- HZ: extended by its player, then 3 minutes from its end.
  perform pg_temp.ca_ready('HZ', array['test:ca-alpha']);
  perform pg_temp.ca_arrive('HZ', 'test:ca-alpha', 'c7000000-0000-4000-8000-000000000b11');
  perform pg_temp.as_user(pg_temp.p('HZ'));
  select * into r from public.extend_checkin('c7000000-0000-4000-8000-000000000b11', now() + interval '30 minutes');
  perform pg_temp.ca_age('c7000000-0000-4000-8000-000000000b11', interval '27 minutes');
  perform pg_temp.ca_process();
  r := pg_temp.vci('c7000000-0000-4000-8000-000000000b11');
  perform pg_temp.ok('A14 never for a check-in its player extended',
    r.expires_at = now() + interval '3 minutes' and pg_temp.ca_pushes('HZ', 'arrival_extend') = 0, r::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('A14 block crashed', false, sqlerrm);
end $$;


-- ════ A15 rewards: nothing without a real fix (S4) ══════════════════════
do $$
declare
  r public.venue_checkins;
  n int;
  v boolean;
begin
  -- HR: 10 minutes into an arrival check-in, a session starts there; then
  -- Stay 1 more hour with a fix.
  perform pg_temp.ca_ready('HR', array['test:ca-alpha']);
  perform pg_temp.ca_arrive('HR', 'test:ca-alpha', 'c7000000-0000-4000-8000-000000000c01');
  perform pg_temp.ca_age('c7000000-0000-4000-8000-000000000c01', interval '10 minutes');
  perform pg_temp.as_user(pg_temp.p('HR'));
  perform public.start_play_session(p_id => 'e7000000-0000-4000-8000-000000000c01', p_kind => 'open_play',
    p_venue => 'test:ca-alpha');
  perform pg_temp.as_admin();
  select at_court into v from public._pl_session_validity('e7000000-0000-4000-8000-000000000c01');
  perform pg_temp.ok('A15 a session at the court with only a no-fix arrival check-in is not at_court', not v);
  perform pg_temp.as_user(pg_temp.p('HR'));
  select * into r from public.extend_checkin(p_id => 'c7000000-0000-4000-8000-000000000c01',
    p_until => now() + interval '3 hours', p_lat => 40.5001, p_lng => -100.0, p_accuracy_m => 10,
    p_fix_at => now(), p_fix_age_ms => 1000);
  perform pg_temp.ok('A15 its first real fix (12 minutes after arriving) becomes its arrival fix and confirms no stay',
    r.arrival_fix_at = now() - interval '1 second' and r.fix_at = now() - interval '1 second'
    and not r.stay_confirmed, r::text);
  perform pg_temp.as_admin();
  select at_court into v from public._pl_session_validity('e7000000-0000-4000-8000-000000000c01');
  perform pg_temp.ok('A15 ...from then on the session is at_court', v);
  -- That fix taken 6 minutes ago instead; a new one now.
  update public.venue_checkins
     set arrival_fix_at = arrival_fix_at - interval '6 minutes', fix_at = fix_at - interval '6 minutes'
   where id = 'c7000000-0000-4000-8000-000000000c01';
  perform pg_temp.as_user(pg_temp.p('HR'));
  select * into r from public.extend_checkin(p_id => 'c7000000-0000-4000-8000-000000000c01',
    p_until => now() + interval '3 hours', p_lat => 40.5001, p_lng => -100.0, p_accuracy_m => 10,
    p_fix_at => now(), p_fix_age_ms => 1000);
  perform pg_temp.ok('A15 ...and a later fix 5+ minutes after it confirms the stay, as for any check-in',
    r.stay_confirmed and r.arrival_fix_at = now() - interval '6 minutes 1 second', r::text);
  perform public.end_play_session('e7000000-0000-4000-8000-000000000c01', now());

  -- HV: checks out with a fix, 12 minutes after arriving.
  perform pg_temp.ca_ready('HV', array['test:ca-alpha']);
  perform pg_temp.ca_arrive('HV', 'test:ca-alpha', 'c7000000-0000-4000-8000-000000000c11');
  perform pg_temp.ca_age('c7000000-0000-4000-8000-000000000c11', interval '10 minutes');
  perform pg_temp.as_user(pg_temp.p('HV'));
  select public.checkout_venue(p_id => 'c7000000-0000-4000-8000-000000000c11', p_source => null, p_at => now(),
    p_lat => 40.5001, p_lng => -100.0, p_accuracy_m => 10, p_fix_age_ms => 1000) into n;
  r := pg_temp.vci('c7000000-0000-4000-8000-000000000c11');
  perform pg_temp.ok('A15 a check-out fix on a no-fix arrival check-in only becomes its arrival fix (no stay)',
    n = 1 and r.checked_out_at = now() and r.checkout_fix_at = now() - interval '1 second'
    and r.arrival_fix_at = now() - interval '1 second' and not r.stay_confirmed, r::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('A15 block crashed', false, sqlerrm);
end $$;


-- ════ A16 "👋 Checked out" when the expiry job closes a check-in (S7) ════
do $$
declare
  o public.push_outbox;
  r public.venue_checkins;
begin
  -- HM: a check-in by hand that ran out an hour ago, and one stored already
  -- over (a replay that synced after it ended).
  perform pg_temp.checkin('HM', 'c7000000-0000-4000-8000-000000000d01', 'test:ca-alpha', 120, 40.5001);
  perform pg_temp.ca_age('c7000000-0000-4000-8000-000000000d01', interval '3 hours');
  insert into public.venue_checkins (id, user_id, venue_id, checked_in_at, expires_at, source, location_confirmed)
  values ('c7000000-0000-4000-8000-000000000d02', pg_temp.p('HM'), 'test:ca-bravo',
          now() - interval '3 hours', now() - interval '1 hour', 'manual', true);
  -- HA: an arrival check-in that ran out 10 minutes ago.
  perform pg_temp.ca_ready('HA', array['test:ca-alpha']);
  perform pg_temp.ca_arrive('HA', 'test:ca-alpha', 'c7000000-0000-4000-8000-000000000d11');
  perform pg_temp.ca_age('c7000000-0000-4000-8000-000000000d11', interval '38 minutes');
  -- HB: a session's check-in that ran out an hour ago.
  perform pg_temp.as_user(pg_temp.p('HB'));
  perform public.start_play_session(p_id => 'e7000000-0000-4000-8000-000000000d21', p_kind => 'open_play',
    p_venue => 'test:ca-alpha', p_lat => 40.5001, p_lng => -100.0, p_accuracy_m => 10,
    p_fix_at => now(), p_fix_age_ms => 1000);
  perform pg_temp.ca_age('e7000000-0000-4000-8000-000000000d21', interval '4 hours');

  perform pg_temp.as_admin();
  perform public.expire_venue_checkins();
  r := pg_temp.vci('c7000000-0000-4000-8000-000000000d01');
  o := pg_temp.ca_push_row('HM', 'arrival_expired', 'c7000000-0000-4000-8000-000000000d01');
  perform pg_temp.ok('A16 a check-in by hand closed by the expiry job: "👋 Checked out", worth sending for 2 hours',
    r.checked_out_at = r.expires_at
    and o.title = '👋 Checked out'
    and o.body = 'Your visit to CA Test Courts Alpha ended after your check-in window — tap to check back in if you''re still there.'
    and o.kind = 'info' and o.category = 'notifyAutoCheckins' and o.deep_link = 'home/-'
    and o.expires_at = now() + interval '2 hours' and o.notification_id is null
    and o.push_data ->> 'venue_id' = 'test:ca-alpha' and o.push_data -> 'via_arrival' = 'false'::jsonb
    and (o.push_data ->> 'expires_at')::timestamptz = r.expires_at, o::text);
  o := pg_temp.ca_push_row('HA', 'arrival_expired', 'c7000000-0000-4000-8000-000000000d11');
  perform pg_temp.ok('A16 ...an arrival check-in too',
    (pg_temp.vci('c7000000-0000-4000-8000-000000000d11')).checked_out_at = now() - interval '10 minutes'
    and o.title = '👋 Checked out' and o.push_data -> 'via_arrival' = 'true'::jsonb, o::text);
  perform pg_temp.ok('A16 ...one stored already over too (S7: every manual and geofence check-in the job closes)',
    (pg_temp.vci('c7000000-0000-4000-8000-000000000d02')).checked_out_at = now() - interval '1 hour'
    and pg_temp.ca_pushes('HM', 'arrival_expired', 'c7000000-0000-4000-8000-000000000d02') = 1);
  perform pg_temp.ok('A16 ...nor a session''s (it ends with its session)',
    (pg_temp.vci('e7000000-0000-4000-8000-000000000d21')).checked_out_at = now() - interval '1 hour'
    and pg_temp.ca_pushes('HB') = 0);
  perform public.expire_venue_checkins();
  perform pg_temp.ok('A16 once: the next run sends nothing more',
    pg_temp.ca_pushes('HM', 'arrival_expired') = 2 and pg_temp.ca_pushes('HA', 'arrival_expired') = 1);
  perform pg_temp.as_user(pg_temp.p('HB'));
  perform public.end_play_session('e7000000-0000-4000-8000-000000000d21', now());
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('A16 block crashed', false, sqlerrm);
end $$;


-- ════ A17 the 1.0.4 RPCs are unchanged ══════════════════════════════════
do $$
declare
  j     jsonb;
  n     int;
  v_bad text;
  r     public.venue_checkins;
begin
  perform pg_temp.as_admin();
  with old(fn, sig) as (values
    ('checkin_venue', 'public.checkin_venue(uuid,text,integer,text,timestamptz,double precision,double precision,double precision,timestamptz,double precision)'),
    ('checkout_venue', 'public.checkout_venue(uuid,text,timestamptz,double precision,double precision,double precision,double precision)'),
    ('extend_checkin', 'public.extend_checkin(uuid,timestamptz,double precision,double precision,double precision,timestamptz,double precision)'),
    ('start_play_session', 'public.start_play_session(uuid,text,uuid,text,timestamptz,double precision,double precision,double precision,timestamptz,double precision)'),
    ('set_court_favorite', 'public.set_court_favorite(text,boolean)'),
    ('list_my_court_favorites', 'public.list_my_court_favorites()'),
    ('get_my_presence_settings', 'public.get_my_presence_settings()'),
    ('set_presence_settings', 'public.set_presence_settings(text,text,timestamptz,boolean,boolean)'))
  select string_agg(w.fn, ', ') into v_bad
    from old w
   where to_regprocedure(w.sig) is null
      or (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = w.fn) <> 1
      or coalesce((select p.prosrc ~ '(via_arrival|taken_back_at|arrival_confirmed|pl_pending_arrivals|court_radius_m)'
                     from pg_proc p where p.oid = to_regprocedure(w.sig)), true);
  perform pg_temp.ok('A17 the 1.0.4 RPCs keep their one signature and a body that knows nothing of arrivals',
    v_bad is null, v_bad);

  -- HD: an arrival check-in taken back, then a check-in by hand elsewhere.
  perform pg_temp.ca_ready('HD', array['test:ca-alpha']);
  perform pg_temp.ca_arrive('HD', 'test:ca-alpha', 'c7000000-0000-4000-8000-000000000e01');
  j := pg_temp.ca_cancel('HD', 'test:ca-alpha');
  perform pg_temp.checkin('HD', 'c7000000-0000-4000-8000-000000000e02', 'test:ca-bravo', 120, 40.5101);
  -- 1.0.4's Exit checks out the geofence check-in it knows of.
  select public.checkout_venue(p_id => 'c7000000-0000-4000-8000-000000000e01', p_source => 'geofence') into n;
  r := pg_temp.vci('c7000000-0000-4000-8000-000000000e02');
  perform pg_temp.ok('A17 checkout_venue with a taken-back id returns 0 and closes nothing else',
    (j ->> 'removed')::boolean and n = 0 and r.checked_out_at is null, j::text || ' ' || n || ' ' || r::text);
  perform pg_temp.as_user(pg_temp.p('HD'));
  select public.checkout_venue(p_id => 'c7000000-0000-4000-8000-000000000e01', p_source => null, p_at => now()) into n;
  r := pg_temp.vci('c7000000-0000-4000-8000-000000000e02');
  perform pg_temp.ok('A17 ...the app''s own Check out with it too', n = 0 and r.checked_out_at is null, n || ' ' || r::text);
  perform pg_temp.as_user(pg_temp.p('HD'));
  perform public.checkout_venue(null, null, now());
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('A17 block crashed', false, sqlerrm);
end $$;


-- ════ A18 "Check in nearby?" ═════════════════════════════════════════════
do $$
declare
  j jsonb;
  e jsonb;
  o public.push_outbox;
begin
  -- HI: push on.
  perform pg_temp.ca_push('HI');
  perform pg_temp.as_user(pg_temp.p('HI'));
  j := public.enqueue_court_checkin_prompt('test:ca-alpha');
  o := pg_temp.ca_push_row('HI', 'court_prompt', null, 'test:ca-alpha');
  perform pg_temp.ok('A18 the prompt goes straight to the outbox (no feed row) when push reaches the player',
    (j ->> 'enqueued')::boolean and (j ->> 'pushable')::boolean and j ->> 'reason' is null
    and o.notification_id is null and o.kind = 'info' and o.category = 'notifyCheckinPrompts'
    and o.title = 'Check in nearby?' and o.body = 'You''re near CA Test Courts Alpha. Tap to check in.'
    and o.deep_link = 'home/-' and o.expires_at = now() + interval '30 minutes'
    and o.push_data = '{"kind": "court_prompt", "venue_id": "test:ca-alpha", "venue_name": "CA Test Courts Alpha"}'::jsonb,
    j::text || ' ' || o::text);
  j := public.enqueue_court_checkin_prompt('test:ca-alpha');
  perform pg_temp.ok('A18 the same court again within 30 minutes: cooldown, nothing more sent',
    not (j ->> 'enqueued')::boolean and j ->> 'reason' = 'cooldown' and (j ->> 'pushable')::boolean
    and pg_temp.ca_pushes('HI', 'court_prompt', null, 'test:ca-alpha') = 1, j::text);
  j := public.enqueue_court_checkin_prompt('test:ca-alpha-osm');
  perform pg_temp.ok('A18 ...also when asked by a duplicate row of that court', j ->> 'reason' = 'cooldown', j::text);
  j := public.enqueue_court_checkin_prompt('test:ca-bravo', 'Bravo by the Lake', 'not_starred');
  o := pg_temp.ca_push_row('HI', 'court_prompt', null, 'test:ca-bravo');
  perform pg_temp.ok('A18 another court has its own 30 minutes; the name the app shows and the reason go in the words',
    (j ->> 'enqueued')::boolean
    and o.body = 'You''re near Bravo by the Lake. It isn''t one of your starred courts anymore, so we didn''t check you in automatically. Tap to check in.'
    and o.push_data ->> 'venue_name' = 'Bravo by the Lake', o::text);
  perform public.enqueue_court_checkin_prompt('test:ca-charlie', null, 'recently_left');
  perform public.enqueue_court_checkin_prompt('test:ca-q1', null, 'no_consent');
  perform public.enqueue_court_checkin_prompt('test:ca-q2', '   ', 'off');
  perform pg_temp.ok('A18 the words for recently_left and no_consent; any other reason adds nothing; a blank name falls back',
    (pg_temp.ca_push_row('HI', 'court_prompt', null, 'test:ca-charlie')).body
      = 'You''re near CA Test Courts Charlie. You left under 10 minutes ago, so we didn''t check you in automatically. Tap to check in.'
    and (pg_temp.ca_push_row('HI', 'court_prompt', null, 'test:ca-q1')).body
      = 'You''re near CA Scan Far 1. Choose who sees you at the courts first, so we didn''t check you in automatically. Tap to check in.'
    and (pg_temp.ca_push_row('HI', 'court_prompt', null, 'test:ca-q2')).body
      = 'You''re near CA Scan Far 2. Tap to check in.');
  -- 31 minutes later.
  perform pg_temp.as_admin();
  update public.pl_throttle set last_at = last_at - interval '31 minutes'
   where scope = pg_temp.p('HI')::text and kind = 'court_prompt' and key = 'test:ca-alpha';
  perform pg_temp.as_user(pg_temp.p('HI'));
  j := public.enqueue_court_checkin_prompt('test:ca-alpha');
  perform pg_temp.ok('A18 the same court after 30 minutes: sent again',
    (j ->> 'enqueued')::boolean and pg_temp.ca_pushes('HI', 'court_prompt', null, 'test:ca-alpha') = 2, j::text);

  -- Held: a check-in of mine there, open or begun in the last 2 hours.
  perform pg_temp.checkin('HI', 'c7000000-0000-4000-8000-000000000f01', 'test:ca-delta', 120, 40.5401);
  j := public.enqueue_court_checkin_prompt('test:ca-delta');
  perform pg_temp.ok('A18 an open check-in of mine there holds it: already_checked_in',
    not (j ->> 'enqueued')::boolean and j ->> 'reason' = 'already_checked_in', j::text);
  perform public.checkout_venue(null, null, now());
  j := public.enqueue_court_checkin_prompt('test:ca-delta');
  perform pg_temp.ok('A18 ...so does one begun there in the last 2 hours, closed or not',
    j ->> 'reason' = 'already_checked_in', j::text);
  perform pg_temp.ca_age('c7000000-0000-4000-8000-000000000f01', interval '3 hours');
  perform pg_temp.as_user(pg_temp.p('HI'));
  j := public.enqueue_court_checkin_prompt('test:ca-delta');
  perform pg_temp.ok('A18 ...but not one begun 3 hours ago', (j ->> 'enqueued')::boolean, j::text);

  -- Not pushable: nothing queued (the app posts the same words itself), and
  -- the 30 minutes still apply.
  perform pg_temp.as_user(pg_temp.p('HQ'));
  j := public.enqueue_court_checkin_prompt('test:ca-charlie');
  perform pg_temp.ok('A18 no device: enqueued, not pushable, nothing in the outbox',
    (j ->> 'enqueued')::boolean and not (j ->> 'pushable')::boolean
    and pg_temp.ca_pushes('HQ', 'court_prompt') = 0, j::text);
  perform pg_temp.ca_push('H0', '{"pushEnabled": false}'::jsonb);
  perform pg_temp.as_user(pg_temp.p('H0'));
  j := public.enqueue_court_checkin_prompt('test:ca-alpha');
  perform pg_temp.ok('A18 a device but push switched off: not pushable, nothing in the outbox',
    (j ->> 'enqueued')::boolean and not (j ->> 'pushable')::boolean
    and pg_temp.ca_pushes('H0', 'court_prompt') = 0, j::text);
  j := public.enqueue_court_checkin_prompt('test:ca-alpha');
  perform pg_temp.ok('A18 ...and its 30 minutes still apply (the local prompt is bounded too)',
    j ->> 'reason' = 'cooldown', j::text);
  j := public.queue_court_arrival('test:ca-alpha');
  perform pg_temp.ok('A18 ...the queue says not pushable too', not (j ->> 'pushable')::boolean, j::text);
  perform pg_temp.ca_push('H1', '{"pushEnabled": true, "notifyCheckinPrompts": false}'::jsonb);
  perform pg_temp.as_user(pg_temp.p('H1'));
  j := public.enqueue_court_checkin_prompt('test:ca-alpha');
  perform pg_temp.ok('A18 push on but "Check-in prompts" off: not pushable, nothing in the outbox',
    (j ->> 'enqueued')::boolean and not (j ->> 'pushable')::boolean
    and pg_temp.ca_pushes('H1', 'court_prompt') = 0, j::text);
  j := public.queue_court_arrival('test:ca-alpha');
  perform pg_temp.ok('A18 ...while "Auto check-ins" still reach the player (pushable by category)',
    (j ->> 'pushable')::boolean, j::text);

  perform pg_temp.as_user(pg_temp.p('HI'));
  e := pg_temp.err('select public.enqueue_court_checkin_prompt(''  '')');
  perform pg_temp.ok('A18 no court named: pl:request.bad', e ->> 'state' = 'P0001' and e ->> 'hint' = 'pl:request.bad', e::text);
  e := pg_temp.err('select public.enqueue_court_checkin_prompt(''test:ca-nowhere'')');
  perform pg_temp.ok('A18 a court Pickleague doesn''t have: pl:court.gone',
    e ->> 'state' = 'P0001' and e ->> 'hint' = 'pl:court.gone', e::text);
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('A18 block crashed', false, sqlerrm);
end $$;


-- ════ A19 the app-open scan ═════════════════════════════════════════════
do $$
declare
  j jsonb;
  e jsonb;
begin
  perform pg_temp.as_user(pg_temp.p('HSC'));
  perform public.set_court_favorite('test:ca-s3', true);
  j := public.court_prompt_scan(40.55, -100.0, 200);
  perform pg_temp.ok('A19 at most 8 courts, nearest first (9 in range; never a rejected court or another sport''s)',
    pg_temp.ca_ids(j -> 'nearby') = array['test:ca-s1', 'test:ca-s2', 'test:ca-s3', 'test:ca-s4',
                                          'test:ca-s5', 'test:ca-s6', 'test:ca-s7', 'test:ca-s8'], j::text);
  perform pg_temp.ok('A19 ...each with its name, distance, starred and outline flags; inside nothing',
    pg_temp.ca_elem(j -> 'nearby', 'test:ca-s1') ->> 'name' = 'CA Scan Court 1'
    and (pg_temp.ca_elem(j -> 'nearby', 'test:ca-s1') ->> 'distance_m')::numeric between 4 and 5
    and not (pg_temp.ca_elem(j -> 'nearby', 'test:ca-s1') ->> 'starred')::boolean
    and (pg_temp.ca_elem(j -> 'nearby', 'test:ca-s3') ->> 'starred')::boolean
    and not (pg_temp.ca_elem(j -> 'nearby', 'test:ca-s3') ->> 'has_outline')::boolean
    and j -> 'inside' = 'null'::jsonb, j::text);
  j := public.court_prompt_scan(40.55, -100.0, 1);
  perform pg_temp.ok('A19 a radius under 10 m counts as 10 m',
    pg_temp.ca_ids(j -> 'nearby') = array['test:ca-s1'], j::text);
  j := public.court_prompt_scan(40.55, -100.0, null);
  perform pg_temp.ok('A19 no radius: 100 m',
    pg_temp.ca_ids(j -> 'nearby') = array['test:ca-s1', 'test:ca-s2', 'test:ca-s3', 'test:ca-s4', 'test:ca-s5'], j::text);
  j := public.court_prompt_scan(40.57, -100.0, 5000);
  perform pg_temp.ok('A19 a radius over 500 m counts as 500 m (the 1 km setting scans 500 m)',
    pg_temp.ca_ids(j -> 'nearby') = array['test:ca-q1'], j::text);
  j := public.court_prompt_scan(40.59, -100.0, 100);
  perform pg_temp.ok('A19 inside two outlines: the smaller one wins',
    j -> 'inside' = '{"venue_id": "test:ca-small", "name": "CA Test Courts Small"}'::jsonb
    and (pg_temp.ca_elem(j -> 'nearby', 'test:ca-small') ->> 'has_outline')::boolean
    and (pg_temp.ca_elem(j -> 'nearby', 'test:ca-big') ->> 'has_outline')::boolean, j::text);
  e := pg_temp.err('select public.court_prompt_scan(91, -100.0, 100)');
  perform pg_temp.ok('A19 a point off the map: pl:request.bad, with no coordinates in the message',
    e ->> 'state' = 'P0001' and e ->> 'hint' = 'pl:request.bad' and e ->> 'msg' not like '%91%', e::text);
  e := pg_temp.err('select public.court_prompt_scan(''NaN''::double precision, -100.0, 100)');
  perform pg_temp.ok('A19 ...NaN too', e ->> 'hint' = 'pl:request.bad', e::text);
  e := pg_temp.err('select public.court_prompt_scan(null, -100.0, 100)');
  perform pg_temp.ok('A19 ...and no point at all', e ->> 'hint' = 'pl:request.bad', e::text);
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('A19 block crashed', false, sqlerrm);
end $$;


-- ════ A20 sign-out, account deletion, retention ═════════════════════════
do $$
declare
  j  jsonb;
  w1 boolean;
  w2 boolean;
  a  public.venue_checkins;
  b  public.venue_checkins;
  me uuid := pg_temp.p('HDL');
begin
  -- HCN: two arrivals waiting, one of them due, then a sign-out.
  perform pg_temp.ca_ready('HCN', array['test:ca-alpha', 'test:ca-bravo']);
  perform pg_temp.ca_queue('HCN', 'test:ca-alpha', 'c7000000-0000-4000-8000-000000000f11', interval '2 minutes');
  perform pg_temp.ca_queue('HCN', 'test:ca-bravo', 'c7000000-0000-4000-8000-000000000f12');
  j := public.cancel_court_arrival(null);
  w1 := public.court_arrival_pending('test:ca-alpha');
  w2 := public.court_arrival_pending('test:ca-bravo');
  perform pg_temp.ok('A20 signing out stops every arrival of mine still waiting',
    (j ->> 'dropped')::boolean and not (j ->> 'closed')::boolean and not (j ->> 'removed')::boolean
    and not w1 and not w2, j::text);
  perform pg_temp.ca_process();
  perform pg_temp.ok('A20 ...so nobody is checked in after signing out',
    (pg_temp.vci('c7000000-0000-4000-8000-000000000f11')).id is null
    and (pg_temp.vci('c7000000-0000-4000-8000-000000000f12')).id is null);

  -- HCL: by hand at Bravo; the job lands an arrival at Alpha (closing Bravo)
  -- after the sign-out's own check-out ran, then the sign-out's cancel.
  perform pg_temp.ca_ready('HCL', array['test:ca-alpha']);
  perform pg_temp.ca_push('HCL');
  perform pg_temp.checkin('HCL', 'c7000000-0000-4000-8000-000000000f31', 'test:ca-bravo', 120, 40.5101);
  perform pg_temp.ca_age('c7000000-0000-4000-8000-000000000f31', interval '20 minutes');
  a := pg_temp.ca_arrive('HCL', 'test:ca-alpha', 'c7000000-0000-4000-8000-000000000f32');
  perform pg_temp.ok('A20 (setup) the arrival check-in landed, closing the one at Bravo',
    a.checked_out_at is null and a.arrival_closed_ids = array['c7000000-0000-4000-8000-000000000f31'::uuid]
    and pg_temp.ca_pushes('HCL', 'arrival_checkin', 'c7000000-0000-4000-8000-000000000f32') = 1, a::text);
  perform pg_temp.as_user(pg_temp.p('HCL'));
  j := public.cancel_court_arrival(null);
  a := pg_temp.vci('c7000000-0000-4000-8000-000000000f32');
  b := pg_temp.vci('c7000000-0000-4000-8000-000000000f31');
  perform pg_temp.ok('A20 signing out as the job lands an arrival: that check-in is checked out (closed), its unsent push dropped',
    (j ->> 'closed')::boolean and not (j ->> 'removed')::boolean and not (j ->> 'dropped')::boolean
    and a.checked_out_at = now() and a.taken_back_at is null
    and pg_temp.ca_pushes('HCL', 'arrival_checkin', 'c7000000-0000-4000-8000-000000000f32') = 0,
    j::text || ' ' || a::text);
  perform pg_temp.ok('A20 ...never a take-back: the check-in it closed elsewhere stays closed',
    b.checked_out_at = now() - interval '2 minutes', b::text);
  perform pg_temp.ok('A20 ...and nothing of mine is open after signing out',
    not exists (select 1 from public.venue_checkins where user_id = pg_temp.p('HCL') and checked_out_at is null));

  -- HDL: a waiting arrival, a prompt (throttle row + outbox push), then deletes the account.
  perform pg_temp.ca_ready('HDL', array['test:ca-alpha']);
  perform pg_temp.ca_push('HDL');
  perform pg_temp.ca_queue('HDL', 'test:ca-alpha', 'c7000000-0000-4000-8000-000000000f21');
  perform public.enqueue_court_checkin_prompt('test:ca-bravo');
  perform pg_temp.as_admin();
  perform pg_temp.ok('A20 (setup) the account has a waiting arrival, a throttle row and a push in the outbox',
    exists (select 1 from public.pl_pending_arrivals where user_id = me)
    and exists (select 1 from public.pl_throttle where scope = me::text)
    and exists (select 1 from public.push_outbox where recipient_id = me));
  perform pg_temp.as_user(me);
  perform public.delete_my_account();
  perform pg_temp.as_admin();
  perform pg_temp.ok('A20 delete_my_account removes its waiting arrivals, throttle rows and outbox pushes',
    not exists (select 1 from public.pl_pending_arrivals where user_id = me)
    and not exists (select 1 from public.pl_throttle where scope = me::text)
    and not exists (select 1 from public.push_outbox where recipient_id = me));

  -- Retention: throttle rows after 2 days (prune_presence_history), Exit
  -- markers after 2 hours (the job).
  insert into public.pl_throttle (scope, kind, key, last_at) values
    (pg_temp.p('HCN')::text, 'court_prompt', 'test:ca-charlie', now() - interval '3 days'),
    (pg_temp.p('HCN')::text, 'court_prompt', 'test:ca-delta',   now() - interval '1 day');
  insert into public.pl_pending_arrivals (user_id, venue_id, arrived_at, due_at, cancelled_at) values
    (pg_temp.p('HCN'), 'test:ca-charlie', now() - interval '3 hours', now() - interval '3 hours', now() - interval '3 hours'),
    (pg_temp.p('HCN'), 'test:ca-delta',   now() - interval '1 hour',  now() - interval '1 hour',  now() - interval '1 hour');
  perform public.prune_presence_history();
  perform pg_temp.ok('A20 retention drops throttle rows older than 2 days, keeps newer ones',
    (select array_agg(key order by key) from public.pl_throttle where scope = pg_temp.p('HCN')::text)
      = array['test:ca-delta']);
  perform public.process_court_arrivals();
  perform pg_temp.ok('A20 the job purges Exit markers after 2 hours, keeps younger ones',
    not exists (select 1 from public.pl_pending_arrivals where user_id = pg_temp.p('HCN') and venue_id = 'test:ca-charlie')
    and exists (select 1 from public.pl_pending_arrivals where user_id = pg_temp.p('HCN') and venue_id = 'test:ca-delta'));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('A20 block crashed', false, sqlerrm);
end $$;


-- ════ A21 re-applied after a re-run of migration_validity_rules.sql ════
-- The builder re-runs that file before any arrival check-in exists, so here
-- its two row changes are made by hand on one: its one-time backfill
-- (verbatim, kept to this row) and its session backfill's older at_court
-- (stored as that body would). Then what re-applying the arrival file runs.
do $$
declare
  r   public.venue_checkins;
  hv  public.venue_checkins;
  hr  public.venue_checkins;
  s   public.play_sessions;
  v   boolean;
begin
  -- HRB: an arrival check-in at Charlie 9 minutes ago (no fix; stored now, so
  -- the backfill below dates its arrival fix 2 minutes ago), and a session
  -- there from 8 minutes ago until now.
  perform pg_temp.ca_ready('HRB', array['test:ca-charlie']);
  perform pg_temp.ca_arrive('HRB', 'test:ca-charlie', 'c7000000-0000-4000-8000-000000001101', interval '9 minutes');
  insert into public.play_sessions (id, user_id, kind, venue_id, started_at, ended_at)
  values ('e7000000-0000-4000-8000-000000001101', pg_temp.p('HRB'), 'open_play', 'test:ca-charlie',
          now() - interval '8 minutes', now());
  s := pg_temp.vrow('e7000000-0000-4000-8000-000000001101');
  perform pg_temp.ok('A21 (setup) a session overlapping only a no-fix arrival check-in is judged not at_court',
    s.valid_reason is not null and not s.at_court, s::text);
  -- HV's and HR's arrival fixes came from real fixes (A15): a check-out fix,
  -- and Stay 1 more hour with one.
  hv := pg_temp.vci('c7000000-0000-4000-8000-000000000c11');
  hr := pg_temp.vci('c7000000-0000-4000-8000-000000000c01');

  update public.venue_checkins
     set arrival_fix_at = greatest(checked_in_at, created_at - interval '2 minutes')
   where location_confirmed and arrival_fix_at is null
     and id = 'c7000000-0000-4000-8000-000000001101';
  select at_court into v from public._pl_session_validity('e7000000-0000-4000-8000-000000001101');
  perform pg_temp.ok('A21 (setup) with the backfill''s arrival fix, the arrival check-in would count for at_court', v);
  update public.play_sessions set at_court = true where id = 'e7000000-0000-4000-8000-000000001101';

  perform public._pl_court_arrival_rerun_repair();
  r := pg_temp.vci('c7000000-0000-4000-8000-000000001101');
  s := pg_temp.vrow('e7000000-0000-4000-8000-000000001101');
  perform pg_temp.ok('A21 re-applying the file clears the arrival fix the re-run stamped (no real fix gave it)',
    r.arrival_fix_at is null and r.fix_at is null and r.location_confirmed and not r.stay_confirmed, r::text);
  perform pg_temp.ok('A21 ...and re-judges the session it overlapped: not at_court again', not s.at_court, s::text);
  perform pg_temp.ok('A21 ...leaving arrival fixes real fixes gave alone (a check-out fix, Stay 1 more hour with a fix)',
    hv.arrival_fix_at is not null and (pg_temp.vci(hv.id)).arrival_fix_at = hv.arrival_fix_at
    and hr.arrival_fix_at is not null and (pg_temp.vci(hr.id)).arrival_fix_at = hr.arrival_fix_at,
    hv.arrival_fix_at::text || ' ' || hr.arrival_fix_at::text);
  perform pg_temp.as_user(pg_temp.p('HRB'));
  perform public.checkout_venue(null, null, now());
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('A21 block crashed', false, sqlerrm);
end $$;


-- ════ A22 one player can't touch another's arrival ═════════════════════
do $$
declare
  j      jsonb;
  v_conf boolean;
  a      public.venue_checkins;
  w      public.pl_pending_arrivals;
  bad    text := '';
begin
  -- HIA: checked in on arrival at Alpha, and another arrival waiting at Bravo.
  perform pg_temp.ca_ready('HIA', array['test:ca-alpha', 'test:ca-bravo']);
  perform pg_temp.ca_arrive('HIA', 'test:ca-alpha', 'c7000000-0000-4000-8000-000000001201');
  perform pg_temp.ca_queue('HIA', 'test:ca-bravo', 'c7000000-0000-4000-8000-000000001202');

  -- HIB: starred Alpha too. Its Enter there carries HIA's check-in id.
  perform pg_temp.ca_ready('HIB', array['test:ca-alpha']);
  j := pg_temp.ca_queue('HIB', 'test:ca-alpha', 'c7000000-0000-4000-8000-000000001201');
  perform pg_temp.ok('A22 an Enter carrying another player''s check-in id is queued under a fresh one',
    (j ->> 'queued')::boolean and (j ->> 'checkin_id')::uuid <> 'c7000000-0000-4000-8000-000000001201', j::text);

  -- Everything HIB can do at Alpha, 2 minutes into HIA's check-in there.
  perform pg_temp.as_user(pg_temp.p('HIB'));
  v_conf := public.confirm_court_arrival('test:ca-alpha');
  if v_conf then bad := bad || 'confirm -> true; '; end if;
  j := public.cancel_court_arrival('test:ca-alpha');
  if not (j ->> 'dropped')::boolean or (j ->> 'closed')::boolean or (j ->> 'removed')::boolean then
    bad := bad || 'Exit -> ' || j::text || '; ';
  end if;
  j := public.cancel_court_arrival('test:ca-alpha', null, true);
  if (j ->> 'dropped')::boolean or (j ->> 'closed')::boolean or (j ->> 'removed')::boolean then
    bad := bad || 'Not here -> ' || j::text || '; ';
  end if;
  j := public.cancel_court_arrival(null);
  if (j ->> 'dropped')::boolean or (j ->> 'closed')::boolean or (j ->> 'removed')::boolean then
    bad := bad || 'sign-out -> ' || j::text || '; ';
  end if;
  perform pg_temp.ok('A22 another player''s Check in now, Exit, Not here and sign-out there act on their own rows only',
    bad = '', bad);

  a := pg_temp.vci('c7000000-0000-4000-8000-000000001201');
  perform pg_temp.ok('A22 ...HIA''s arrival check-in is as it was: open, unconfirmed, not taken back',
    a.user_id = pg_temp.p('HIA') and a.checked_out_at is null and a.taken_back_at is null
    and a.location_confirmed and not a.arrival_confirmed
    and a.expires_at = a.checked_in_at + interval '30 minutes', a::text);
  w := pg_temp.ca_pending('HIA', 'test:ca-bravo');
  perform pg_temp.ok('A22 ...HIA''s arrival waiting at Bravo still waits, and HIA has no Exit marker at Alpha',
    w.cancelled_at is null and w.checkin_id = 'c7000000-0000-4000-8000-000000001202'
    and (pg_temp.ca_pending('HIA', 'test:ca-alpha')).user_id is null, w::text);

  perform pg_temp.as_user(pg_temp.p('HIA'));
  perform public.cancel_court_arrival(null);
  perform pg_temp.as_admin();
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('A22 block crashed', false, sqlerrm);
end $$;
