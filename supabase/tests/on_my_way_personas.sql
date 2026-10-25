-- ============================================================
-- "On my way" (persona tests for migration_on_my_way.sql).
--
-- NOT runnable on its own: build-on-my-way-test.mjs puts
-- migration_on_my_way.sql (twice: it must be re-runnable) at the marker line
-- below. Everything runs inside the begin / rollback below, so the linked
-- (live) database is left untouched:
--   node supabase/tests/build-on-my-way-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary.
--
-- now() is fixed for the whole transaction, so time passing is a backdated
-- pl_throttle row. Personas (temporary accounts, example.invalid emails):
--   SN  the sender
--   F1  SN's friend AND close friend, push on                  -> pushed
--   F2  SN's friend, push on                                   -> pushed
--   F3  SN's friend, no phone registered                       -> counted, no push
--   F4  SN's friend, "Friends on the way" switched off         -> counted, no push
--   F5  SN's friend, push on (the second court)                -> pushed
--   F6  SN's friend, push on (the window tests)                -> pushed
--   NF  not a friend                                           -> ignored
--   PD  a pending request only                                 -> ignored
--   BK  friends, then SN blocked them                          -> ignored
--   BB  friends, then they blocked SN                          -> ignored
--   DL  friends, account deleted                               -> ignored
--   GU  friends, a guest pass                                  -> ignored
--   S2  a second sender: close friend C1, friend C2 (no star)
--   C1, C2  S2's friends, push on
--   S3  a third sender with a friend (C2) but no close friends
--   NF also stands in for a sender with no friends at all
-- ============================================================

begin;

-- The pg_temp helpers below are called by the personas (as anon /
-- authenticated). Since migration_anon_audit_rest.sql, functions postgres
-- creates are no longer EXECUTE-able by PUBLIC by default, so this test
-- transaction (rolled back below) gives the helpers the old default back.
alter default privileges for role postgres grant execute on functions to public;

-- ════ Harness ════════════════════════════════════════════════════════════
create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);
grant select, insert on _results to authenticated;
grant usage on sequence _results_n_seq to authenticated;

create temp table _p (k text primary key, id uuid not null);
insert into _p values
  ('SN', 'a8000000-0000-4000-8000-000000000001'), ('F1', 'a8000000-0000-4000-8000-000000000002'),
  ('F2', 'a8000000-0000-4000-8000-000000000003'), ('F3', 'a8000000-0000-4000-8000-000000000004'),
  ('F4', 'a8000000-0000-4000-8000-000000000005'), ('F5', 'a8000000-0000-4000-8000-000000000006'),
  ('F6', 'a8000000-0000-4000-8000-000000000007'), ('NF', 'a8000000-0000-4000-8000-000000000008'),
  ('PD', 'a8000000-0000-4000-8000-000000000009'), ('BK', 'a8000000-0000-4000-8000-00000000000a'),
  ('BB', 'a8000000-0000-4000-8000-00000000000b'), ('DL', 'a8000000-0000-4000-8000-00000000000c'),
  ('GU', 'a8000000-0000-4000-8000-00000000000d'), ('S2', 'a8000000-0000-4000-8000-00000000000e'),
  ('C1', 'a8000000-0000-4000-8000-00000000000f'), ('C2', 'a8000000-0000-4000-8000-000000000010'),
  ('S3', 'a8000000-0000-4000-8000-000000000011');
grant select on _p to authenticated;

create function pg_temp.p(text) returns uuid language sql stable as $$ select id from _p where k = $1 $$;
create function pg_temp.ids(text[]) returns uuid[] language sql stable as $$
  select coalesce(array_agg(id order by k), '{}') from _p where k = any ($1)
$$;

create function pg_temp.ok(p_test text, p_ok boolean, p_detail text default null) returns void
language sql as $$ insert into _results (test, ok, detail) values (p_test, coalesce(p_ok, false), p_detail) $$;

create function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create function pg_temp.as_signed_out() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role": "authenticated"}', true);
  perform set_config('role', 'authenticated', true);
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

-- send_on_my_way as one persona.
create function pg_temp.send(p_who text, p_venue text, p_eta int, p_to text[]) returns jsonb
language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.as_user(pg_temp.p(p_who));
  v := public.send_on_my_way(p_venue, p_eta, case when p_to is null then null else pg_temp.ids(p_to) end);
  perform pg_temp.as_admin();
  return v;
end $$;

-- The persona keys with an on-my-way outbox row from this sender, comma-joined.
create function pg_temp.pushed(p_from text) returns text language sql stable as $$
  select coalesce(string_agg(k.k, ',' order by k.k), '')
    from public.push_outbox o join _p k on k.id = o.recipient_id
   where o.push_data ->> 'kind' = 'on_my_way' and o.push_data ->> 'sender_id' = pg_temp.p(p_from)::text
$$;

-- Moves this sender's on-my-way throttle rows back by p_ago (time passing).
create function pg_temp.age_throttle(p_who text, p_ago interval) returns void language sql as $$
  update public.pl_throttle set last_at = last_at - p_ago
   where scope = pg_temp.p(p_who)::text and kind in ('on_my_way', 'on_my_way_to')
$$;


-- ════ Setup (before the migration) ══════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data)
select id, 'omw-' || lower(k) || '@example.invalid', jsonb_build_object('full_name', 'Omw ' || k)
  from _p;
update public.profiles set full_name = 'Sam Sender' where id = pg_temp.p('SN');
update public.profiles set deleted_at = now() where id = pg_temp.p('DL');
update public.profiles set is_guest = true where id = pg_temp.p('GU');

insert into public.venues (id, sport, name, kind, lat, lng, source, geofence_radius_m) values
  ('test:omw-court',  array['pickleball'], 'Omw Test Courts',  'court', 44.1, -150.1, 'google', 100),
  ('test:omw-alias',  array['pickleball'], 'Omw Test Alias',   'court', 44.1, -150.1, 'google', 100),
  ('test:omw-second', array['pickleball'], 'Omw Second Courts', 'court', 44.2, -150.2, 'google', 100),
  ('test:omw-third',  array['pickleball'], 'Omw Third Courts', 'court', 44.3, -150.3, 'google', 100),
  ('test:omw-rejected', array['pickleball'], 'Omw Rejected Courts', 'court', 44.4, -150.4, 'google', 100),
  ('test:omw-rej-alias', array['pickleball'], 'Omw Rejected Alias', 'court', 44.4, -150.4, 'google', 100);
update public.venues set canonical_id = 'test:omw-court' where id = 'test:omw-alias';
update public.venues set confirmation_status = 'rejected' where id = 'test:omw-rejected';
update public.venues set canonical_id = 'test:omw-rejected' where id = 'test:omw-rej-alias';

-- Friendships first (a block deletes them; BK / BB are re-added after).
insert into public.friendships (requester_id, addressee_id, status, responded_at)
select pg_temp.p('SN'), pg_temp.p(k), 'accepted', now()
  from unnest(array['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'DL', 'GU']) k;
insert into public.friendships (requester_id, addressee_id, status)
values (pg_temp.p('PD'), pg_temp.p('SN'), 'pending');
insert into public.friendships (requester_id, addressee_id, status, responded_at)
select pg_temp.p('S2'), pg_temp.p(k), 'accepted', now() from unnest(array['C1', 'C2']) k;
insert into public.friendships (requester_id, addressee_id, status, responded_at)
values (pg_temp.p('S3'), pg_temp.p('C2'), 'accepted', now());
insert into public.close_friends (user_id, friend_id) values
  (pg_temp.p('SN'), pg_temp.p('F1')), (pg_temp.p('S2'), pg_temp.p('C1'));

insert into public.user_blocks (blocker_id, blocked_id) values
  (pg_temp.p('SN'), pg_temp.p('BK')), (pg_temp.p('BB'), pg_temp.p('SN'));
-- Even with a friendship row left over, a block keeps them out.
insert into public.friendships (requester_id, addressee_id, status, responded_at)
select pg_temp.p('SN'), pg_temp.p(k), 'accepted', now() from unnest(array['BK', 'BB']) k;

-- Phones and switches: everyone but F3 has a phone; push on for all; F4 has
-- "Friends on the way" off.
insert into public.push_tokens (user_id, token, platform)
select id, 'ExponentPushToken[omw-' || lower(k) || ']', 'ios' from _p where k <> 'F3';
insert into public.user_preferences (user_id, prefs)
select id,
       case when k = 'F4' then '{"pushEnabled": true, "notifyFriendsOnTheWay": false}'::jsonb
            else '{"pushEnabled": true}'::jsonb end
  from _p
on conflict (user_id) do update set prefs = excluded.prefs;

-- @@MIGRATION@@


-- ════ O1 grants and attributes ═══════════════════════════════════════════
do $$
declare f text := 'public.send_on_my_way(text,integer,uuid[])';
begin
  perform pg_temp.as_admin();
  perform pg_temp.ok('O1 authenticated may call send_on_my_way, anon may not',
    has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute'));
  perform pg_temp.ok('O1 security definer, search_path ''''',
    (select prosecdef and proconfig = array['search_path=""'] from pg_proc where oid = f::regprocedure));
  perform pg_temp.ok('O1 one definition (no overload for PostgREST to choose between)',
    (select count(*) = 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'send_on_my_way'));
  perform pg_temp.ok('O1 the helpers are internal (no client execute)',
    not has_function_privilege('authenticated', 'public._pl_eta_label(integer)', 'execute')
    and not has_function_privilege('authenticated', 'public._pl_omw_last(uuid,text,text)', 'execute')
    and not has_function_privilege('anon', 'public._pl_omw_last(uuid,text,text)', 'execute'));
end $$;


-- ════ O2 refusals (each says why and what to do) ═════════════════════════
do $$
declare e jsonb;
begin
  perform pg_temp.as_signed_out();
  e := pg_temp.err($q$select public.send_on_my_way('test:omw-court', 15, null)$q$);
  perform pg_temp.ok('O2 signed out: pl:auth.signed_out', e->>'hint' = 'pl:auth.signed_out', e::text);

  perform pg_temp.as_user(pg_temp.p('SN'));
  e := pg_temp.err($q$select public.send_on_my_way('test:omw-court', 0, null)$q$);
  perform pg_temp.ok('O2 ETA 0: pl:omw.bad_eta', e->>'hint' = 'pl:omw.bad_eta', e::text);
  e := pg_temp.err($q$select public.send_on_my_way('test:omw-court', 181, null)$q$);
  perform pg_temp.ok('O2 ETA 181: pl:omw.bad_eta, with the range in the message',
    e->>'hint' = 'pl:omw.bad_eta' and e->>'msg' ilike '%1 minute to 3 hours%', e::text);
  e := pg_temp.err($q$select public.send_on_my_way('test:omw-court', 15,
                     (select array_agg(gen_random_uuid()) from generate_series(1, 51)))$q$);
  perform pg_temp.ok('O2 51 friends: pl:omw.too_many', e->>'hint' = 'pl:omw.too_many', e::text);
  e := pg_temp.err($q$select public.send_on_my_way('test:omw-nowhere', 15, null)$q$);
  perform pg_temp.ok('O2 unknown court: pl:court.gone', e->>'hint' = 'pl:court.gone', e::text);
  e := pg_temp.err($q$select public.send_on_my_way('test:omw-rejected', 15, null)$q$);
  perform pg_temp.ok('O2 a court an admin rejected: pl:court.gone (its page says gone too)', e->>'hint' = 'pl:court.gone', e::text);
  e := pg_temp.err($q$select public.send_on_my_way('test:omw-rej-alias', 15, null)$q$);
  perform pg_temp.ok('O2 an alias of a rejected court: pl:court.gone', e->>'hint' = 'pl:court.gone', e::text);
  e := pg_temp.err($q$select public.send_on_my_way(null, 15, null)$q$);
  perform pg_temp.ok('O2 no court: pl:court.gone', e->>'hint' = 'pl:court.gone', e::text);
  perform pg_temp.as_admin();
  perform pg_temp.ok('O2 refusals queue nothing and spend no window',
    pg_temp.pushed('SN') = '' and not exists (select 1 from public.pl_throttle where scope = pg_temp.p('SN')::text));
end $$;


-- ════ O3 nobody to tell ═════════════════════════════════════════════════
do $$
declare v jsonb;
begin
  v := pg_temp.send('SN', 'test:omw-court', 15, array['NF', 'PD', 'BK', 'BB', 'DL', 'GU', 'SN']);
  perform pg_temp.ok('O3 only non-friends, blocked, deleted, guest and myself picked: reason nobody',
    (v->>'sent')::boolean = false and v->>'reason' = 'nobody' and (v->>'count')::int = 0, v::text);
  v := pg_temp.send('SN', 'test:omw-court', 15, array[]::text[]);
  perform pg_temp.ok('O3 an empty pick: reason nobody', v->>'reason' = 'nobody', v::text);
  v := pg_temp.send('NF', 'test:omw-court', 15, null);
  perform pg_temp.ok('O3 no pick and no friends at all: reason nobody', v->>'reason' = 'nobody', v::text);
  perform pg_temp.ok('O3 nobody spends no window and queues nothing',
    pg_temp.pushed('SN') = '' and pg_temp.pushed('NF') = ''
    and not exists (select 1 from public.pl_throttle where scope in (pg_temp.p('SN')::text, pg_temp.p('NF')::text)));
end $$;


-- ════ O4 the send ═══════════════════════════════════════════════════════
do $$
declare
  v jsonb;
  o record;
begin
  -- Picked through the alias: the facility is told about.
  v := pg_temp.send('SN', 'test:omw-alias', null,
                    array['F1', 'F2', 'F3', 'F4', 'NF', 'PD', 'BK', 'BB', 'DL', 'GU', 'SN']);
  perform pg_temp.ok('O4 sent to the 4 real friends picked (F1-F4), the rest ignored',
    (v->>'sent')::boolean and (v->>'count')::int = 4 and (v->>'skipped_recent')::int = 0, v::text);
  perform pg_temp.ok('O4 ETA null reads as 15', (v->>'eta_minutes')::int = 15, v::text);
  perform pg_temp.ok('O4 the alias is answered as its facility',
    v->>'venue_id' = 'test:omw-court' and v->>'venue_name' = 'Omw Test Courts', v::text);
  perform pg_temp.ok('O4 pushes only where they reach: F1 F2 (F3 no phone, F4 switched off)',
    pg_temp.pushed('SN') = 'F1,F2', pg_temp.pushed('SN'));

  select * into o from public.push_outbox
   where recipient_id = pg_temp.p('F1') and push_data ->> 'kind' = 'on_my_way';
  perform pg_temp.ok('O4 title names the sender and the court',
    o.title = 'Sam Sender is on the way to Omw Test Courts', o.title);
  perform pg_temp.ok('O4 body: about 15 min', o.body = 'About 15 min away. Tap to see the court.', o.body);
  perform pg_temp.ok('O4 link home/- (what older bundles route; this build reads kind + venue_id for the court page)',
    o.deep_link = 'home/-', o.deep_link);
  perform pg_temp.ok('O4 category notifyFriendsOnTheWay, kind info, pending',
    o.category = 'notifyFriendsOnTheWay' and o.kind = 'info' and o.status = 'pending', format('%s %s %s', o.category, o.kind, o.status));
  perform pg_temp.ok('O4 push_data: kind, court, sender, ETA',
    o.push_data ->> 'venue_id' = 'test:omw-court' and o.push_data ->> 'venue_name' = 'Omw Test Courts'
    and o.push_data ->> 'sender_id' = pg_temp.p('SN')::text and (o.push_data ->> 'eta_minutes')::int = 15,
    o.push_data::text);
  perform pg_temp.ok('O4 the push expires at the ETA', o.expires_at = now() + interval '15 minutes', o.expires_at::text);
  perform pg_temp.ok('O4 no notifications row (a lock-screen notice only)',
    o.notification_id is null
    and not exists (select 1 from public.notifications n where n.user_id = pg_temp.p('F1') and n.title like '%on the way%'));
  perform pg_temp.ok('O4 throttle rows: the court, and each of the 4 friends told',
    (select count(*) from public.pl_throttle where scope = pg_temp.p('SN')::text and kind = 'on_my_way' and key = 'test:omw-court') = 1
    and (select count(*) from public.pl_throttle where scope = pg_temp.p('SN')::text and kind = 'on_my_way_to') = 4);
end $$;


-- ════ O5 not spam: the court window ══════════════════════════════════════
do $$
declare v jsonb;
begin
  v := pg_temp.send('SN', 'test:omw-court', 5, array['F1', 'F2', 'F6']);
  perform pg_temp.ok('O5 again at the court within 30 min (new ETA, a new friend too): reason recent',
    (v->>'sent')::boolean = false and v->>'reason' = 'recent'
    and (v->>'sent_at')::timestamptz = now() and (v->>'retry_at')::timestamptz = now() + interval '30 minutes', v::text);
  v := pg_temp.send('SN', 'test:omw-alias', 20, array['F6']);
  perform pg_temp.ok('O5 the alias shares the facility''s window', v->>'reason' = 'recent', v::text);
  perform pg_temp.ok('O5 nothing more queued', pg_temp.pushed('SN') = 'F1,F2', pg_temp.pushed('SN'));
end $$;


-- ════ O6 not spam: each friend once per 30 minutes, any court ════════════
do $$
declare v jsonb;
begin
  perform pg_temp.age_throttle('SN', interval '10 minutes');
  v := pg_temp.send('SN', 'test:omw-second', 15, array['F1', 'F2']);
  perform pg_temp.ok('O6 another court, only friends told 10 min ago: reason recent_friends',
    (v->>'sent')::boolean = false and v->>'reason' = 'recent_friends'
    and (v->>'retry_at')::timestamptz = now() + interval '20 minutes', v::text);
  perform pg_temp.ok('O6 recent_friends spends no window at the second court',
    not exists (select 1 from public.pl_throttle where scope = pg_temp.p('SN')::text and key = 'test:omw-second'));
  v := pg_temp.send('SN', 'test:omw-second', 30, array['F1', 'F5']);
  perform pg_temp.ok('O6 a fresh friend there: sent to F5 only, F1 skipped',
    (v->>'sent')::boolean and (v->>'count')::int = 1 and (v->>'skipped_recent')::int = 1, v::text);
  perform pg_temp.ok('O6 F5 pushed once, F1 not again',
    pg_temp.pushed('SN') = 'F1,F2,F5'
    and (select count(*) from public.push_outbox where recipient_id = pg_temp.p('F1') and push_data ->> 'kind' = 'on_my_way') = 1,
    pg_temp.pushed('SN'));
  perform pg_temp.ok('O6 F5''s push: the second court, about 30 min',
    (select title = 'Sam Sender is on the way to Omw Second Courts' and body = 'About 30 min away. Tap to see the court.'
            and deep_link = 'home/-' and push_data ->> 'venue_id' = 'test:omw-second'
       from public.push_outbox where recipient_id = pg_temp.p('F5') and push_data ->> 'kind' = 'on_my_way'));
end $$;


-- ════ O7 after 30 minutes ═══════════════════════════════════════════════
do $$
declare v jsonb;
begin
  perform pg_temp.age_throttle('SN', interval '21 minutes');   -- the first send is now 31 min old
  v := pg_temp.send('SN', 'test:omw-court', 60, array['F1', 'F5', 'F6']);
  perform pg_temp.ok('O7 31 min later at the first court: sent to F1 and F6 (F5 was told 21 min ago)',
    (v->>'sent')::boolean and (v->>'count')::int = 2 and (v->>'skipped_recent')::int = 1, v::text);
  perform pg_temp.ok('O7 60 minutes reads "about 1 hr" and expires in an hour',
    (select body = 'About 1 hr away. Tap to see the court.' and expires_at = now() + interval '60 minutes'
       from public.push_outbox where recipient_id = pg_temp.p('F6') and push_data ->> 'kind' = 'on_my_way'));
  perform pg_temp.ok('O7 F1 now has two pushes, 30+ minutes apart',
    (select count(*) from public.push_outbox where recipient_id = pg_temp.p('F1') and push_data ->> 'kind' = 'on_my_way') = 2);
end $$;


-- ════ O8 no pick: all my friends (a star never decides who is told) ════
do $$
declare v jsonb;
begin
  perform pg_temp.ok('O8 another sender''s windows are their own: S2 at the court SN just used',
    (pg_temp.send('S2', 'test:omw-court', 15, array['C2']) ->> 'sent')::boolean);
  v := pg_temp.send('S2', 'test:omw-third', 5, null);
  perform pg_temp.ok('O8 no pick: every friend, starred or not (C1 told, C2 skipped as told minutes ago)',
    (v->>'sent')::boolean and (v->>'count')::int = 1 and (v->>'skipped_recent')::int = 1
    and pg_temp.pushed('S2') = 'C1,C2', v::text || ' ' || pg_temp.pushed('S2'));
  perform pg_temp.ok('O8 a short ETA still keeps the push for 10 minutes',
    (select expires_at = now() + interval '10 minutes' and body = 'About 5 min away. Tap to see the court.'
       from public.push_outbox where recipient_id = pg_temp.p('C1') and push_data ->> 'kind' = 'on_my_way'));
end $$;


-- ════ O9 ETA wording ════════════════════════════════════════════════════
do $$
begin
  perform pg_temp.as_admin();
  perform pg_temp.ok('O9 ETA labels: 1 min, 45 min, 1 hr, 1 hr 30 min, 2 hr, 3 hr',
    public._pl_eta_label(1) = '1 min' and public._pl_eta_label(45) = '45 min' and public._pl_eta_label(60) = '1 hr'
    and public._pl_eta_label(90) = '1 hr 30 min' and public._pl_eta_label(120) = '2 hr' and public._pl_eta_label(180) = '3 hr');
end $$;


-- ════ O10 the defaults: court only (15 minutes, all my friends) ══════════
do $$
declare v jsonb;
begin
  perform pg_temp.as_user(pg_temp.p('S3'));
  v := public.send_on_my_way('test:omw-second');
  perform pg_temp.as_admin();
  perform pg_temp.ok('O10 left out: 15 minutes, and a sender with no close friends still tells their friend (C2)',
    (v->>'sent')::boolean and (v->>'eta_minutes')::int = 15 and (v->>'count')::int = 1 and pg_temp.pushed('S3') = 'C2',
    v::text || ' ' || pg_temp.pushed('S3'));
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
