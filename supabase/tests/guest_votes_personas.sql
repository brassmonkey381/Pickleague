-- ============================================================
-- Guest votes need an account: persona tests
-- (migration_guest_votes_need_account.sql).
--
-- NOT runnable on its own: build-guest-votes-test.mjs puts, at the marker
-- line below, migration_guest_votes_need_account.sql twice (it must be
-- re-runnable) and then migration_rls_hardening_2026q3.sql (a re-run must
-- keep join_guest_invite and get_guest_invite_slots callable). Everything
-- runs inside the begin / rollback below, so the linked (live) database is
-- left untouched:
--   node supabase/tests/build-guest-votes-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary.
--
-- Personas (temporary accounts made inside the transaction):
--   AD  admin of the closed league L; created the event E and its invites
--   FM  a full member of L
--   NU  a real account, not in L, who opens the invite link
--   GU  an anonymous guest from before: a guest pass in L and a vote cast
-- Invites: T active, TX expired.
-- ============================================================

begin;

alter default privileges for role postgres grant execute on functions to public;

-- ════ Harness ════════════════════════════════════════════════════════════
create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);
grant select, insert on _results to authenticated, anon;
grant usage on sequence _results_n_seq to authenticated, anon;

create temp table _ids (k text primary key, id uuid not null);
insert into _ids values
  ('AD', 'a9f00000-0000-4000-8000-000000000001'), ('FM', 'a9f00000-0000-4000-8000-000000000002'),
  ('NU', 'a9f00000-0000-4000-8000-000000000003'), ('GU', 'a9f00000-0000-4000-8000-000000000004'),
  ('L',  'a9f10000-0000-4000-8000-000000000001'), ('E',  'a9f10000-0000-4000-8000-000000000002'),
  ('S1', 'a9f10000-0000-4000-8000-000000000003'), ('S2', 'a9f10000-0000-4000-8000-000000000004');
grant select on _ids to authenticated, anon;

create function pg_temp.i(text) returns uuid language sql stable as $$ select id from _ids where k = $1 $$;
create function pg_temp.ok(p_test text, p_ok boolean, p_detail text default null) returns void
language sql as $$ insert into _results (test, ok, detail) values (p_test, coalesce(p_ok, false), p_detail) $$;

create function pg_temp.as_user(p uuid, p_anonymous boolean default false) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p, 'role', 'authenticated', 'is_anonymous', p_anonymous)::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create function pg_temp.as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  perform set_config('role', 'anon', true);
end $$;

create function pg_temp.as_admin() returns void language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

-- @@MIGRATION@@


-- ════ Setup ══════════════════════════════════════════════════════════════
do $$
begin
  perform pg_temp.as_admin();
  insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at, is_anonymous)
  select id,
         case when k = 'GU' then null else 'gv-' || lower(k) || '@pickleague.test' end,
         jsonb_build_object('full_name', 'GV Player ' || k),
         case when k = 'GU' then null else now() end,
         k = 'GU'
    from _ids where k in ('AD', 'FM', 'NU', 'GU');
  update public.profiles set is_guest = true, guest_expires_at = now() + interval '5 days'
   where id = pg_temp.i('GU');

  insert into public.leagues (id, name, is_open, created_by)
  values (pg_temp.i('L'), 'GV Closed League', false, pg_temp.i('AD'));
  insert into public.league_members (league_id, user_id, role, expires_at) values
    (pg_temp.i('L'), pg_temp.i('AD'), 'admin', null),
    (pg_temp.i('L'), pg_temp.i('FM'), 'member', null),
    (pg_temp.i('L'), pg_temp.i('GU'), 'member', now() + interval '5 days')
  on conflict (league_id, user_id) do update set role = excluded.role, expires_at = excluded.expires_at;

  insert into public.league_events (id, league_id, title, created_by, status, vote_ends_at)
  values (pg_temp.i('E'), pg_temp.i('L'), 'GV Event', pg_temp.i('AD'), 'voting', now() + interval '2 days');
  insert into public.event_slots (id, event_id, starts_at, ends_at) values
    (pg_temp.i('S1'), pg_temp.i('E'), now() + interval '3 days', now() + interval '3 days 2 hours'),
    (pg_temp.i('S2'), pg_temp.i('E'), now() + interval '4 days', now() + interval '4 days 2 hours');

  insert into public.guest_invites (token, league_id, event_id, created_by, invited_names, expires_at) values
    ('GVTOKEN00001', pg_temp.i('L'), pg_temp.i('E'), pg_temp.i('AD'), '{}', now() + interval '7 days'),
    ('GVTOKEN0000X', pg_temp.i('L'), pg_temp.i('E'), pg_temp.i('AD'), '{}', now() - interval '1 hour');

  -- GU's vote from before this change.
  insert into public.event_slot_votes (slot_id, user_id) values (pg_temp.i('S1'), pg_temp.i('GU'));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('setup crashed', false, sqlerrm);
end $$;


-- ════ V1-V2 the signed-out landing sees the times ════════════════════════
do $$
declare
  n int;
begin
  perform pg_temp.as_anon();
  select count(*) into n from public.get_guest_invite_slots('gvtoken00001');
  perform pg_temp.as_admin();
  perform pg_temp.ok('V1 signed out, the link shows the event''s 2 times', n = 2, n::text);

  perform pg_temp.as_anon();
  select count(*) into n from public.get_guest_invite_slots('GVTOKEN0000X');
  perform pg_temp.as_admin();
  perform pg_temp.ok('V2 an expired link shows no times', n = 0, n::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('V1-V2 block crashed', false, sqlerrm);
end $$;


-- ════ V3-V5 a real account joins and votes ═══════════════════════════════
do $$
declare
  r record;
  n int;
  v text;
  exp timestamptz;
begin
  perform pg_temp.as_user(pg_temp.i('NU'));
  select * into r from public.join_guest_invite('GVTOKEN00001');
  select count(*) into n from public.event_slots where event_id = pg_temp.i('E');
  v := public.vote_event_slots(pg_temp.i('E'), array[pg_temp.i('S2')]);
  perform pg_temp.as_admin();
  select expires_at into exp from public.league_members
   where league_id = pg_temp.i('L') and user_id = pg_temp.i('NU');
  perform pg_temp.ok('V3 a signed-in account joins from the link until the invite expires',
    r.event_id = pg_temp.i('E') and exp is not null
      and exp = (select expires_at from public.guest_invites where token = 'GVTOKEN00001'),
    coalesce(exp::text, 'no membership'));
  perform pg_temp.ok('V4 then sees the closed league''s 2 times and votes', n = 2 and v = 'voted', n || ' / ' || v);

  perform pg_temp.as_user(pg_temp.i('FM'));
  perform public.join_guest_invite('GVTOKEN00001');
  perform pg_temp.as_admin();
  select expires_at into exp from public.league_members
   where league_id = pg_temp.i('L') and user_id = pg_temp.i('FM');
  perform pg_temp.ok('V5 a full member who opens the link stays a full member', exp is null, coalesce(exp::text, 'null'));
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('V3-V5 block crashed', false, sqlerrm);
end $$;


-- ════ V6-V7 refusals ═════════════════════════════════════════════════════
do $$
declare
  e text;
begin
  perform pg_temp.as_user(pg_temp.i('FM'));
  begin
    perform public.join_guest_invite('GVTOKEN0000X');
    e := 'joined';
  exception when others then
    e := sqlerrm;
  end;
  perform pg_temp.as_admin();
  perform pg_temp.ok('V6 an expired link can''t be joined', e like '%expired%', e);

  perform pg_temp.as_user(pg_temp.i('GU'), true);
  begin
    perform public.join_guest_invite('GVTOKEN00001');
    e := 'joined';
  exception when others then
    e := sqlerrm;
  end;
  perform pg_temp.as_admin();
  perform pg_temp.ok('V7 a guest session can''t join', e like '%free Pickleague account%', e);

  perform pg_temp.as_user(pg_temp.i('GU'), true);
  begin
    perform public.redeem_guest_invite('GVTOKEN00001', 'Anyone');
    e := 'redeemed';
  exception when others then
    e := sqlerrm;
  end;
  perform pg_temp.as_admin();
  perform pg_temp.ok('V7 the old guest redeem is refused', e like '%free Pickleague account%', e);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('V6-V7 block crashed', false, sqlerrm);
end $$;


-- ════ V8-V10 a guest from before can't vote; keeps the old vote ══════════
do $$
declare
  e text;
  n int;
begin
  perform pg_temp.as_user(pg_temp.i('GU'), true);
  begin
    e := public.vote_event_slots(pg_temp.i('E'), array[pg_temp.i('S2')]);
  exception when others then
    e := sqlerrm;
  end;
  perform pg_temp.as_admin();
  perform pg_temp.ok('V8 a guest can''t vote (the vote RPC)', e like '%free Pickleague account%', e);

  perform pg_temp.as_user(pg_temp.i('GU'), true);
  begin
    insert into public.event_slot_votes (slot_id, user_id) values (pg_temp.i('S2'), pg_temp.i('GU'));
    e := 'inserted';
  exception when others then
    e := sqlerrm;
  end;
  perform pg_temp.as_admin();
  perform pg_temp.ok('V8 a guest can''t vote (a direct insert)', e like '%free Pickleague account%', e);

  perform pg_temp.as_user(pg_temp.i('GU'), true);
  begin
    insert into public.event_declines (event_id, user_id) values (pg_temp.i('E'), pg_temp.i('GU'));
    e := 'declined';
  exception when others then
    e := sqlerrm;
  end;
  perform pg_temp.as_admin();
  perform pg_temp.ok('V9 a guest can''t decline', e like '%free Pickleague account%', e);

  select count(*) into n from public.event_slot_votes where user_id = pg_temp.i('GU') and slot_id = pg_temp.i('S1');
  perform pg_temp.ok('V10 the guest''s vote from before still counts', n = 1, n::text);

  perform pg_temp.as_user(pg_temp.i('GU'), true);
  delete from public.event_slot_votes where user_id = pg_temp.i('GU') and slot_id = pg_temp.i('S1');
  perform pg_temp.as_admin();
  select count(*) into n from public.event_slot_votes where user_id = pg_temp.i('GU');
  perform pg_temp.ok('V10 and the guest can still withdraw it', n = 0, n::text);
exception when others then
  perform pg_temp.as_admin();
  perform pg_temp.ok('V8-V10 block crashed', false, sqlerrm);
end $$;


-- ════ V11 grants ═════════════════════════════════════════════════════════
do $$
begin
  perform pg_temp.ok('V11 grants: slots for anon; join for accounts only',
    has_function_privilege('anon', 'public.get_guest_invite_slots(text)', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.join_guest_invite(text)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.join_guest_invite(text)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public._pl_vote_needs_account()', 'EXECUTE'));
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
