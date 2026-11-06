-- ============================================================
-- My Place stays (persona tests for migration_place_stays.sql).
--
-- NOT runnable on its own: build-place-stays-test.mjs puts, at the marker
-- line below, migration_place_stays.sql twice (it must be re-runnable) and
-- then migration_rls_hardening_2026q3.sql (a re-run must keep the stay RPCs
-- online). Everything runs inside the begin / rollback below, so the linked
-- (live) database is left untouched:
--   node supabase/tests/build-place-stays-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary.
--
-- Personas (temporary accounts created inside the transaction):
--   SA visits; friends with SB, SC and SE
--   SB, SC hosts (SA's friends)
--   SD a stranger to SA
--   SE a friend who goes Only me
--   SF collects items (40 finished stays at SB's)
--   SG near today's play cap
--   SH a guest pass (no pickleballs)
-- ============================================================

begin;

alter default privileges for role postgres grant execute on functions to public;

-- ════ Harness ════════════════════════════════════════════════════════════
create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);
grant select, insert on _results to authenticated;
grant usage on sequence _results_n_seq to authenticated;

create temp table _p (k text primary key, id uuid not null);
insert into _p values
  ('SA', 'aa000000-0000-4000-8000-000000000001'), ('SB', 'aa000000-0000-4000-8000-000000000002'),
  ('SC', 'aa000000-0000-4000-8000-000000000003'), ('SD', 'aa000000-0000-4000-8000-000000000004'),
  ('SE', 'aa000000-0000-4000-8000-000000000005'), ('SF', 'aa000000-0000-4000-8000-000000000006'),
  ('SG', 'aa000000-0000-4000-8000-000000000007'), ('SH', 'aa000000-0000-4000-8000-000000000008');
grant select on _p to authenticated;

create function pg_temp.p(text) returns uuid language sql stable as $$ select id from _p where k = $1 $$;

create function pg_temp.ok(p_test text, p_ok boolean, p_detail text default null) returns void
language sql as $$ insert into _results (test, ok, detail) values (p_test, coalesce(p_ok, false), p_detail) $$;

create function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create function pg_temp.as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role": "anon"}', true);
  perform set_config('role', 'anon', true);
end $$;

create function pg_temp.as_admin() returns void language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

-- Runs p_sql; null if it went through, else the error's message and hint.
create function pg_temp.err(p_sql text) returns jsonb language plpgsql as $$
declare
  v_msg  text;
  v_hint text;
begin
  execute p_sql;
  return null;
exception when others then
  get stacked diagnostics v_msg = message_text, v_hint = pg_exception_hint;
  return jsonb_build_object('msg', v_msg, 'hint', v_hint);
end $$;

create function pg_temp.pickles(p uuid) returns integer language sql stable as $$
  select coalesce(pickles, 0) from public.profiles where id = p
$$;

-- ════ Setup ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data)
select id, 'ps-' || lower(k) || '@pickleague.test', jsonb_build_object('full_name', 'Stay' || k || ' Test')
  from _p;

insert into public.friendships (requester_id, addressee_id, status, responded_at)
select pg_temp.p('SA'), pg_temp.p(k), 'accepted', now() from unnest(array['SB', 'SC', 'SE']) k;
insert into public.friendships (requester_id, addressee_id, status, responded_at)
values (pg_temp.p('SF'), pg_temp.p('SB'), 'accepted', now()),
       (pg_temp.p('SG'), pg_temp.p('SB'), 'accepted', now());

-- @@MIGRATION@@

-- ════ Checks ═════════════════════════════════════════════════════════════
do $$
declare
  r      jsonb;
  r2     jsonb;
  e      jsonb;
  v_bal  integer;
  v_id   uuid;
  v_n    integer;
  v_bad  integer;
  v_cyc  boolean := public._pl_track_current_cycle(now()) is not null;
begin
  -- S1 my own place, a stranger's place: refused with their codes
  perform pg_temp.as_user(pg_temp.p('SA'));
  e := pg_temp.err(format('select public.visit_place(%L)', pg_temp.p('SA')));
  perform pg_temp.as_admin();
  perform pg_temp.ok('S1 own place: stay.self', e ->> 'hint' = 'pl:stay.self', e::text);
  perform pg_temp.as_user(pg_temp.p('SA'));
  e := pg_temp.err(format('select public.visit_place(%L)', pg_temp.p('SD')));
  perform pg_temp.as_admin();
  perform pg_temp.ok('S1 not friends: home.friends_only', e ->> 'hint' = 'pl:home.friends_only', e::text);

  -- S2 a friend's place: a 4-hour stay
  perform pg_temp.as_user(pg_temp.p('SA'));
  r := public.visit_place(pg_temp.p('SB'));
  perform pg_temp.as_admin();
  perform pg_temp.ok('S2 stay starts, 4 hours',
    (r ->> 'ends_at')::timestamptz between now() + interval '3 hours 59 minutes' and now() + interval '4 hours 1 minute', r::text);
  perform pg_temp.ok('S2 host label is the first name', r ->> 'host_label' = 'StaySB''s place', r::text);

  -- S3 again at the same place: the same stay; elsewhere: refused
  perform pg_temp.as_user(pg_temp.p('SA'));
  r2 := public.visit_place(pg_temp.p('SB'));
  e := pg_temp.err(format('select public.visit_place(%L)', pg_temp.p('SC')));
  perform pg_temp.as_admin();
  perform pg_temp.ok('S3 same place: same stay', r2 ->> 'ends_at' = r ->> 'ends_at', r2::text);
  perform pg_temp.ok('S3 another place: stay.elsewhere', e ->> 'hint' = 'pl:stay.elsewhere', e::text);
  perform pg_temp.ok('S3 one open stay', (select count(*) from public.place_stays where visitor_id = pg_temp.p('SA') and returned_at is null) = 1);

  -- S4 who sees it: me (away), the host (guest), a stranger (nothing)
  perform pg_temp.as_user(pg_temp.p('SA'));
  r := public.get_place_stays();
  perform pg_temp.as_admin();
  perform pg_temp.ok('S4 mine: away at SB', r -> 'away' ->> 'host_id' = pg_temp.p('SB')::text and jsonb_array_length(r -> 'guests') = 0, r::text);
  perform pg_temp.as_user(pg_temp.p('SB'));
  r := public.get_place_stays();
  perform pg_temp.as_admin();
  perform pg_temp.ok('S4 host: SA is a guest',
    r -> 'guests' -> 0 ->> 'visitor_id' = pg_temp.p('SA')::text and r -> 'guests' -> 0 ->> 'name' = 'StaySA', r::text);
  perform pg_temp.as_user(pg_temp.p('SD'));
  r := public.get_place_stays(pg_temp.p('SA'));
  perform pg_temp.as_admin();
  perform pg_temp.ok('S4 stranger: nothing', r -> 'away' = 'null'::jsonb and jsonb_array_length(r -> 'guests') = 0, r::text);

  -- S5 home early: no reward, nothing to claim
  v_bal := pg_temp.pickles(pg_temp.p('SA'));
  perform pg_temp.as_user(pg_temp.p('SA'));
  r := public.leave_place();
  r2 := public.claim_place_stay_returns();
  perform pg_temp.as_admin();
  perform pg_temp.ok('S5 early', (r ->> 'ended')::boolean and (r ->> 'early')::boolean, r::text);
  perform pg_temp.ok('S5 nothing to claim, no pickles', jsonb_array_length(r2) = 0 and pg_temp.pickles(pg_temp.p('SA')) = v_bal, r2::text);
  perform pg_temp.as_user(pg_temp.p('SA'));
  r := public.leave_place();
  perform pg_temp.as_admin();
  perform pg_temp.ok('S5 nothing open: ended false', not (r ->> 'ended')::boolean, r::text);

  -- S6 a finished stay: claimed once, +15 in the ledger as a stay
  perform pg_temp.as_user(pg_temp.p('SA'));
  perform public.visit_place(pg_temp.p('SC'));
  perform pg_temp.as_admin();
  update public.place_stays set ends_at = now() - interval '1 minute', created_at = now() - interval '4 hours 1 minute'
   where visitor_id = pg_temp.p('SA') and returned_at is null;
  v_bal := pg_temp.pickles(pg_temp.p('SA'));
  perform pg_temp.as_user(pg_temp.p('SA'));
  r := public.claim_place_stay_returns();
  r2 := public.claim_place_stay_returns();
  perform pg_temp.as_admin();
  perform pg_temp.ok('S6 one return, 15 pickles, a souvenir',
    jsonb_array_length(r) = 1 and (r -> 0 ->> 'pickles')::int = 15 and r -> 0 ->> 'souvenir' like '%StaySC''s place%', r::text);
  perform pg_temp.ok('S6 the return says its pickleballs', r -> 0 ? 'pickleballs', r::text);
  perform pg_temp.ok('S6 the balance moved 15', pg_temp.pickles(pg_temp.p('SA')) = v_bal + 15);
  perform pg_temp.ok('S6 claimed once', jsonb_array_length(r2) = 0, r2::text);
  perform pg_temp.ok('S6 ledger row is a stay',
    exists (select 1 from public.pickle_ledger l where l.profile_id = pg_temp.p('SA') and l.source = '_pl_settle_place_stay' and l.delta = 15));
  perform pg_temp.as_user(pg_temp.p('SA'));
  r := public.get_place_stays();
  perform pg_temp.as_admin();
  perform pg_temp.ok('S6 back home: not away', r -> 'away' = 'null'::jsonb, r::text);

  -- S7 the daily play cap: 5 left pays 5
  insert into public.pickle_ledger (profile_id, delta, balance_after, reason, source, kind)
  values (pg_temp.p('SG'), 495, 495, 'test play', '_grant_match_game_bonus', 'earn');
  insert into public.place_stays (visitor_id, host_id, created_at, ends_at)
  values (pg_temp.p('SG'), pg_temp.p('SB'), now() - interval '5 hours', now() - interval '1 hour');
  v_bal := pg_temp.pickles(pg_temp.p('SG'));
  perform pg_temp.as_user(pg_temp.p('SG'));
  r := public.claim_place_stay_returns();
  perform pg_temp.as_admin();
  perform pg_temp.ok('S7 capped: 5 paid and recorded',
    (r -> 0 ->> 'pickles')::int = 5 and pg_temp.pickles(pg_temp.p('SG')) = v_bal + 5, r::text);

  -- S8 unfriend ends the stay early
  perform pg_temp.as_user(pg_temp.p('SA'));
  perform public.visit_place(pg_temp.p('SB'));
  perform pg_temp.as_admin();
  delete from public.friendships where requester_id = pg_temp.p('SA') and addressee_id = pg_temp.p('SB');
  perform pg_temp.ok('S8 unfriend: ended early',
    exists (select 1 from public.place_stays where visitor_id = pg_temp.p('SA') and host_id = pg_temp.p('SB')
             and returned_at is not null and ended_early and created_at > now() - interval '1 minute')
    and not exists (select 1 from public.place_stays where visitor_id = pg_temp.p('SA') and returned_at is null));

  -- S9 the host goes Only me: stays there end early
  perform pg_temp.as_user(pg_temp.p('SA'));
  perform public.visit_place(pg_temp.p('SE'));
  perform pg_temp.as_user(pg_temp.p('SE'));
  perform public.set_my_place_visibility('only_me');
  perform pg_temp.as_admin();
  perform pg_temp.ok('S9 Only me: ended early',
    not exists (select 1 from public.place_stays where visitor_id = pg_temp.p('SA') and returned_at is null));
  perform pg_temp.as_user(pg_temp.p('SA'));
  e := pg_temp.err(format('select public.visit_place(%L)', pg_temp.p('SE')));
  perform pg_temp.as_admin();
  perform pg_temp.ok('S9 Only me: home.private', e ->> 'hint' = 'pl:home.private', e::text);

  -- S10 items: 40 finished stays bring back some decor, all from the pool
  for v_n in 1..40 loop
    insert into public.place_stays (visitor_id, host_id, created_at, ends_at, returned_at)
    values (pg_temp.p('SF'), pg_temp.p('SB'), now() - interval '5 hours', now() - interval '1 hour', null)
    returning id into v_id;
    perform public._pl_settle_place_stay(v_id);
  end loop;
  select count(*) filter (where s.item_id is not null),
         count(*) filter (where s.item_id is not null and (i.season is not null or i.cost <= 0 or i.is_starter
                                                           or i.rarity not in ('common', 'rare')
                                                           or o.source is distinct from 'grant'))
    into v_n, v_bad
    from public.place_stays s
    left join public.home_items i on i.id = s.item_id
    left join public.home_owned_items o on o.owner_id = s.visitor_id and o.item_id = s.item_id
   where s.visitor_id = pg_temp.p('SF');
  perform pg_temp.ok('S10 some stays brought decor back', v_n > 0, v_n::text);
  perform pg_temp.ok('S10 every item is from the pool and granted', v_bad = 0, v_bad::text);
  perform pg_temp.ok('S10 never the same item twice',
    (select count(*) = count(distinct item_id) from public.place_stays where visitor_id = pg_temp.p('SF') and item_id is not null));

  -- S12 Court Pass: 5 pickleballs for a full stay while a cycle runs, else 0
  select jsonb_build_object('balls', s.pickleballs) into r from public.place_stays s
   where s.visitor_id = pg_temp.p('SA') and s.host_id = pg_temp.p('SC') and not s.ended_early;
  perform pg_temp.ok('S12 full stay: ' || case when v_cyc then '5 (a cycle runs)' else '0 (no cycle runs)' end,
    (r ->> 'balls')::int = case when v_cyc then 5 else 0 end, r::text);
  perform pg_temp.ok('S12 ended early: 0',
    not exists (select 1 from public.place_stays where ended_early and pickleballs <> 0
                 and visitor_id in (select id from _p)));
  select id into v_id from public.place_stays where visitor_id = pg_temp.p('SA') and host_id = pg_temp.p('SC') and not ended_early;
  perform pg_temp.ok('S12 a replay adds nothing',
    coalesce(public._pl_track_add_xp(pg_temp.p('SA'), now(), 'place_stay', v_id::text, 5, null), 0) = 0);
  update public.profiles set is_guest = true where id = pg_temp.p('SH');
  insert into public.place_stays (visitor_id, host_id, created_at, ends_at)
  values (pg_temp.p('SH'), pg_temp.p('SB'), now() - interval '5 hours', now() - interval '1 hour')
  returning id into v_id;
  perform public._pl_settle_place_stay(v_id);
  perform pg_temp.ok('S12 a guest pass: 0',
    (select pickleballs from public.place_stays where id = v_id) = 0);

  -- S11 grants survive the hardening re-run; helpers stay internal
  perform pg_temp.ok('S11 authenticated can call the four',
    has_function_privilege('authenticated', 'public.visit_place(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.leave_place()', 'execute')
    and has_function_privilege('authenticated', 'public.claim_place_stay_returns()', 'execute')
    and has_function_privilege('authenticated', 'public.get_place_stays(uuid)', 'execute'));
  perform pg_temp.ok('S11 anon cannot',
    not has_function_privilege('anon', 'public.visit_place(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.get_place_stays(uuid)', 'execute'));
  perform pg_temp.ok('S11 helpers are internal',
    not has_function_privilege('authenticated', 'public._pl_settle_place_stay(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._pl_place_visit_refusal(uuid, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._pl_end_place_stays(text, uuid, uuid)', 'execute'));
  perform pg_temp.ok('S11 the table is RPC-only',
    not has_table_privilege('authenticated', 'public.place_stays', 'select'));
end $$;

-- ════ Results ════════════════════════════════════════════════════════════
select test, ok, detail
  from (
    select 0 as n,
           'SUMMARY: ' || count(*) filter (where ok) || ' passed, ' || count(*) filter (where not ok) || ' failed' as test,
           bool_and(ok) as ok, null::text as detail
      from _results
    union all
    select n, test, ok, detail from _results
  ) x
 order by n;

rollback;
