-- ============================================================
-- Referrals, Doggle parity (persona tests for migration_referrals.sql).
--
-- NOT runnable on its own: build-referral-test.mjs puts, at the marker line
-- below, migration_referrals.sql twice (it must be re-runnable), then
-- migration_anon_audit_rest.sql (which moves referral_code / invited_by from
-- profiles to the owner-only profile_private) and then
-- migration_rls_hardening_2026q3.sql (a re-run must keep the referral RPCs
-- online). Everything runs inside the begin / rollback below, so the linked
-- (live) database is left untouched:
--   node supabase/tests/build-referral-test.mjs <out.sql>
--   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
-- Every row should read ok = true; the first row is the summary.
--
-- Personas (temporary accounts created inside the transaction):
--   RA  a referrer                  RB  a second referrer
--   N1  new, confirmed at sign-up (auto-confirm), claims RA's code
--   N2  new, unconfirmed, RA's code in the sign-up metadata; confirms later
--   N3  new, confirmed, tries its own code
--   N4  new, confirmed, claims twice (RA, then RB, then RA again)
--   OL  a 40-day-old account
--   G   a guest (anonymous sign-in) who upgrades with RB's code
--   F   unconfirmed, linked to RA; its confirmation meets a broken payout
--   NU  unconfirmed, linked 2 days ago (the daily nudge)
--   RM  a referrer whose 10 invitees M01..M10 join (milestones)
--   UC  an unclaimed placeholder profile with a code
-- ============================================================

begin;

-- The pg_temp helpers below are called by the personas (as anon /
-- authenticated). Since migration_anon_audit_rest.sql, functions postgres
-- creates are no longer EXECUTE-able by PUBLIC by default, so this test
-- transaction (rolled back below) gives the helpers the old default back.
alter default privileges for role postgres grant execute on functions to public;

-- ════ Harness ════════════════════════════════════════════════════════════
create temp table _results (n serial primary key, test text not null, ok boolean not null, detail text);
grant select, insert on _results to authenticated, anon;
grant usage on sequence _results_n_seq to authenticated, anon;

create temp table _p (k text primary key, id uuid not null);
insert into _p values
  ('RA', 'a7000000-0000-4000-8000-000000000001'), ('RB', 'a7000000-0000-4000-8000-000000000002'),
  ('N1', 'a7000000-0000-4000-8000-000000000011'), ('N2', 'a7000000-0000-4000-8000-000000000012'),
  ('N3', 'a7000000-0000-4000-8000-000000000013'), ('N4', 'a7000000-0000-4000-8000-000000000014'),
  ('OL', 'a7000000-0000-4000-8000-000000000015'), ('G',  'a7000000-0000-4000-8000-000000000016'),
  ('F',  'a7000000-0000-4000-8000-000000000017'), ('NU', 'a7000000-0000-4000-8000-000000000018'),
  ('RM', 'a7000000-0000-4000-8000-000000000020'), ('UC', 'a7000000-0000-4000-8000-000000000030'),
  ('M01', 'a7000000-0000-4000-8000-000000000101'), ('M02', 'a7000000-0000-4000-8000-000000000102'),
  ('M03', 'a7000000-0000-4000-8000-000000000103'), ('M04', 'a7000000-0000-4000-8000-000000000104'),
  ('M05', 'a7000000-0000-4000-8000-000000000105'), ('M06', 'a7000000-0000-4000-8000-000000000106'),
  ('M07', 'a7000000-0000-4000-8000-000000000107'), ('M08', 'a7000000-0000-4000-8000-000000000108'),
  ('M09', 'a7000000-0000-4000-8000-000000000109'), ('M10', 'a7000000-0000-4000-8000-000000000110');
grant select on _p to authenticated, anon;

create function pg_temp.p(text) returns uuid language sql stable as $$ select id from _p where k = $1 $$;

create function pg_temp.ok(p_test text, p_ok boolean, p_detail text default null) returns void
language sql as $$ insert into _results (test, ok, detail) values (p_test, coalesce(p_ok, false), p_detail) $$;

create function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create function pg_temp.as_guest(p uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated', 'is_anonymous', true)::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create function pg_temp.as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role": "anon"}', true);
  perform set_config('role', 'anon', true);
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

-- @@MIGRATION@@

-- (again: migration_anon_audit_rest.sql, spliced above, takes the default away)
alter default privileges for role postgres grant execute on functions to public;


-- A persona's pickles, referral code and referral row (read as admin).
create function pg_temp.pickles(k text) returns integer language sql stable as $$
  select pickles from public.profiles where id = pg_temp.p(k) $$;
-- security definer: the code lives in the owner-only profile_private, and
-- this is also called while a persona (or anon) is the current role.
create function pg_temp.code(k text) returns text language sql stable security definer as $$
  select referral_code from public.profile_private where id = pg_temp.p(k) $$;
create function pg_temp.rewarded(k text) returns boolean language sql stable as $$
  select rewarded_at is not null from public.referrals where invitee_id = pg_temp.p(k) $$;
create function pg_temp.referrer_of(k text) returns uuid language sql stable as $$
  select referrer_id from public.referrals where invitee_id = pg_temp.p(k) $$;
create function pg_temp.claim(k text, p_code text) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform pg_temp.as_user(pg_temp.p(k));
  r := public.claim_referral(p_code);
  perform pg_temp.as_admin();
  return r;
end $$;



-- ════ Setup (after the migration, so the auth triggers are live) ═════════
do $$
begin
  perform pg_temp.as_admin();
  -- Referrers: real, confirmed, months old.
  insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at, created_at)
  select pg_temp.p(k), 'rf-' || lower(k) || '@pickleague.test',
         jsonb_build_object('full_name', n || ' Referrer'), now() - interval '90 days', now() - interval '90 days'
    from (values ('RA', 'Alice'), ('RB', 'Bob'), ('RM', 'Mia')) v(k, n);
  update public.profiles set created_at = now() - interval '90 days' where id in (pg_temp.p('RA'), pg_temp.p('RB'), pg_temp.p('RM'));

  -- N1, N3, N4: confirmed at sign-up (auto-confirm), no code in the metadata.
  insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
  select pg_temp.p(k), 'rf-' || lower(k) || '@pickleague.test', jsonb_build_object('full_name', 'Newbie ' || k), now()
    from (values ('N1'), ('N3'), ('N4')) v(k);

  -- N2, F, NU: unconfirmed sign-ups with RA's code in the metadata.
  insert into auth.users (id, email, raw_user_meta_data)
  select pg_temp.p(k), 'rf-' || lower(k) || '@pickleague.test',
         jsonb_build_object('full_name', 'Pending ' || k, 'referral_code', upper(pg_temp.code('RA')))
    from (values ('N2'), ('F'), ('NU')) v(k);

  -- OL: confirmed, 40 days old.
  insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at, created_at)
  values (pg_temp.p('OL'), 'rf-ol@pickleague.test', '{"full_name": "Old Timer"}', now() - interval '40 days', now() - interval '40 days');
  update public.profiles set created_at = now() - interval '40 days' where id = pg_temp.p('OL');

  -- G: a guest (anonymous sign-in, no email).
  insert into auth.users (id, is_anonymous, raw_user_meta_data)
  values (pg_temp.p('G'), true, '{"full_name": "Guest"}');
  update public.profiles set is_guest = true, guest_expires_at = now() + interval '7 days' where id = pg_temp.p('G');

  -- M01..M10: confirmed new accounts.
  insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
  select id, 'rf-' || lower(k) || '@pickleague.test', jsonb_build_object('full_name', 'Member ' || k), now()
    from _p where k like 'M%';

  -- UC: an unclaimed placeholder (a code that must not work).
  insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
  values (pg_temp.p('UC'), 'rf-uc@pickleague.test', '{"full_name": "Unclaimed Uma"}', now());
  update public.profiles set is_unclaimed = true where id = pg_temp.p('UC');
end $$;


-- ════ R1 schema, grants, attributes ══════════════════════════════════════
do $$
declare
  f text;
begin
  perform pg_temp.as_admin();
  perform pg_temp.ok('R1 every persona got a 10-char referral code on sign-up',
    (select bool_and(length(referral_code) = 10) and count(*) = (select count(*) from _p)
       from public.profile_private where id in (select id from _p)));
  perform pg_temp.ok('R1 no live profile is without a code',
    not exists (select 1 from public.profiles p left join public.profile_private pp on pp.id = p.id
                 where p.deleted_at is null and pp.referral_code is null));
  perform pg_temp.ok('R1 codes are unique case-insensitively (unique index on lower())',
    exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'profile_private_referral_code_uq'));
  foreach f in array array['public.claim_referral(text)', 'public.my_referral_code()', 'public.my_referral_stats()'] loop
    perform pg_temp.ok('R1 ' || f || ': authenticated yes, anon no (after the hardening re-run)',
      has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute'));
  end loop;
  perform pg_temp.ok('R1 referral_preview: anon and authenticated may call it',
    has_function_privilege('anon', 'public.referral_preview(text)', 'execute')
    and has_function_privilege('authenticated', 'public.referral_preview(text)', 'execute'));
  foreach f in array array['public._pl_pay_referral_reward(uuid)', 'public._pl_link_referral(uuid,text)',
                           'public._pl_referral_on_auth_user()', 'public.notify_stalled_referral_invitees()',
                           'public.purge_deferred_invite_clicks()'] loop
    perform pg_temp.ok('R1 internal ' || f || ': neither anon nor authenticated',
      not has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute'));
  end loop;
  perform pg_temp.ok('R1 every referral SECURITY DEFINER function pins search_path ''''',
    (select bool_and(proconfig = array['search_path=""']) from pg_proc
      where pronamespace = 'public'::regnamespace and prosecdef
        and proname in ('claim_referral', 'my_referral_code', 'my_referral_stats', 'referral_preview',
                        '_pl_pay_referral_reward', '_pl_link_referral', '_pl_referral_on_auth_user',
                        'notify_stalled_referral_invitees', 'purge_deferred_invite_clicks')));
  perform pg_temp.ok('R1 9 such functions exist',
    (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and prosecdef
        and proname in ('claim_referral', 'my_referral_code', 'my_referral_stats', 'referral_preview',
                        '_pl_pay_referral_reward', '_pl_link_referral', '_pl_referral_on_auth_user',
                        'notify_stalled_referral_invitees', 'purge_deferred_invite_clicks')) = 9);
  perform pg_temp.ok('R1 RLS on referrals and deferred_invite_clicks',
    (select bool_and(relrowsecurity) from pg_class where oid in ('public.referrals'::regclass, 'public.deferred_invite_clicks'::regclass)));
  perform pg_temp.ok('R1 both cron jobs are scheduled',
    (select count(*) from cron.job where jobname in ('pickleague-referral-nudges', 'pickleague-purge-invite-clicks')) = 2);
  perform pg_temp.ok('R1 the three milestone badges exist once each',
    (select count(*) from public.badges where name in ('Recruiter', 'Squad Builder', 'Club Builder')) = 3);
end $$;


-- ════ R2 claim on an already-confirmed account pays at once ══════════════
do $$
declare
  r   jsonb;
  ra0 integer := pg_temp.pickles('RA');
  n10 integer := pg_temp.pickles('N1');
begin
  r := pg_temp.claim('N1', '  ' || upper(pg_temp.code('RA')) || ' ');
  perform pg_temp.ok('R2 N1 claims RA''s code (any case, padded): linked, rewarded, first name',
    (r ->> 'linked')::boolean and (r ->> 'rewarded')::boolean and r ->> 'referrer_name' = 'Alice', r::text);
  perform pg_temp.ok('R2 RA +2500 and N1 +2500',
    pg_temp.pickles('RA') - ra0 = 2500 + 150 and pg_temp.pickles('N1') - n10 = 2500,
    format('RA %s, N1 %s', pg_temp.pickles('RA') - ra0, pg_temp.pickles('N1') - n10));
  perform pg_temp.ok('R2 RA earned Recruiter (its +150 is the badge''s own grant, counted above)',
    exists (select 1 from public.player_badges pb join public.badges b on b.id = pb.badge_id
             where pb.user_id = pg_temp.p('RA') and b.name = 'Recruiter'));
  perform pg_temp.ok('R2 N1.invited_by = RA', (select invited_by from public.profile_private where id = pg_temp.p('N1')) = pg_temp.p('RA'));
  perform pg_temp.ok('R2 both got a shop notification',
    exists (select 1 from public.notifications where user_id = pg_temp.p('RA') and entity_type = 'shop' and title like '%Newbie joined%')
    and exists (select 1 from public.notifications where user_id = pg_temp.p('N1') and entity_type = 'shop' and title like '%Alice%'));
  perform pg_temp.ok('R2 referral row stores the amounts',
    (select referrer_pickles = 2500 and invitee_pickles = 2500 from public.referrals where invitee_id = pg_temp.p('N1')));

  -- Idempotent re-pay.
  perform pg_temp.ok('R2 paying again pays nothing', not public._pl_pay_referral_reward(pg_temp.p('N1')));
  perform pg_temp.ok('R2 ... balances unchanged',
    pg_temp.pickles('RA') - ra0 = 2650 and pg_temp.pickles('N1') - n10 = 2500);
  -- Re-confirming (a second update) pays nothing either.
  update auth.users set email_confirmed_at = now() where id = pg_temp.p('N1');
  perform pg_temp.ok('R2 ... nor does another auth.users update', pg_temp.pickles('N1') - n10 = 2500);
end $$;


-- ════ R3 metadata link at sign-up, pay on confirmation ═══════════════════
do $$
declare
  ra0 integer := pg_temp.pickles('RA');
  n20 integer := pg_temp.pickles('N2');
  r   jsonb;
begin
  perform pg_temp.ok('R3 N2 was linked to RA at sign-up from its metadata (upper-cased code)',
    pg_temp.referrer_of('N2') = pg_temp.p('RA'));
  perform pg_temp.ok('R3 ... but not paid while unconfirmed', not pg_temp.rewarded('N2'));
  perform pg_temp.ok('R3 a direct pay call refuses an unconfirmed invitee', not public._pl_pay_referral_reward(pg_temp.p('N2')));

  update auth.users set email_confirmed_at = now() where id = pg_temp.p('N2');
  perform pg_temp.ok('R3 confirming the email pays', pg_temp.rewarded('N2'));
  perform pg_temp.ok('R3 ... +2500 each', pg_temp.pickles('RA') - ra0 = 2500 and pg_temp.pickles('N2') - n20 = 2500,
    format('RA %s, N2 %s', pg_temp.pickles('RA') - ra0, pg_temp.pickles('N2') - n20));

  -- The app's claim at first sign-in (code still stashed): same referrer = linked, already.
  r := pg_temp.claim('N2', pg_temp.code('RA'));
  perform pg_temp.ok('R3 N2''s sign-in claim of the same code: linked, already, rewarded',
    (r ->> 'linked')::boolean and (r ->> 'already')::boolean and (r ->> 'rewarded')::boolean, r::text);
  perform pg_temp.ok('R3 ... and pays nothing more', pg_temp.pickles('N2') - n20 = 2500);
end $$;


-- ════ R4 refusals ════════════════════════════════════════════════════════
do $$
declare
  r jsonb;
  e jsonb;
  n40 integer := pg_temp.pickles('N4');
begin
  r := pg_temp.claim('N3', pg_temp.code('N3'));
  perform pg_temp.ok('R4 self-referral: reason self', not (r ->> 'linked')::boolean and r ->> 'reason' = 'self', r::text);
  perform pg_temp.ok('R4 ... no row', pg_temp.referrer_of('N3') is null);

  r := pg_temp.claim('N4', pg_temp.code('RA'));
  perform pg_temp.ok('R4 N4 first claim (RA) links', (r ->> 'linked')::boolean, r::text);
  r := pg_temp.claim('N4', pg_temp.code('RB'));
  perform pg_temp.ok('R4 double claim with another code: already_referred', r ->> 'reason' = 'already_referred', r::text);
  perform pg_temp.ok('R4 ... still RA''s', pg_temp.referrer_of('N4') = pg_temp.p('RA'));
  r := pg_temp.claim('N4', pg_temp.code('RA'));
  perform pg_temp.ok('R4 same code again: linked, already (no second payout)',
    (r ->> 'already')::boolean and pg_temp.pickles('N4') - n40 = 2500, r::text);

  r := pg_temp.claim('OL', pg_temp.code('RA'));
  perform pg_temp.ok('R4 a 40-day-old account: too_old', r ->> 'reason' = 'too_old', r::text);
  r := pg_temp.claim('N3', 'zzzzzzzzzz');
  perform pg_temp.ok('R4 unknown code', r ->> 'reason' = 'unknown_code', r::text);
  r := pg_temp.claim('N3', '   ');
  perform pg_temp.ok('R4 blank code', r ->> 'reason' = 'no_code', r::text);
  r := pg_temp.claim('N3', null);
  perform pg_temp.ok('R4 null code', r ->> 'reason' = 'no_code', r::text);
  r := pg_temp.claim('N3', repeat('a', 65));
  perform pg_temp.ok('R4 a 65-char code', r ->> 'reason' = 'no_code', r::text);
  r := pg_temp.claim('N3', pg_temp.code('UC'));
  perform pg_temp.ok('R4 an unclaimed placeholder''s code does not work', r ->> 'reason' = 'unknown_code', r::text);

  perform pg_temp.as_signed_out();
  e := pg_temp.err($q$select public.claim_referral('abc')$q$);
  perform pg_temp.ok('R4 signed out: pl:auth.signed_out', e ->> 'hint' = 'pl:auth.signed_out', e::text);
  e := pg_temp.err($q$select public.my_referral_stats()$q$);
  perform pg_temp.ok('R4 my_referral_stats signed out: pl:auth.signed_out', e ->> 'hint' = 'pl:auth.signed_out', e::text);
  perform pg_temp.as_anon();
  e := pg_temp.err($q$select public.claim_referral('abc')$q$);
  perform pg_temp.ok('R4 the anon role cannot call claim_referral', e is not null, e::text);
  perform pg_temp.as_admin();
end $$;


-- ════ R5 guests never qualify; an upgraded guest does ════════════════════
do $$
declare
  r   jsonb;
  rb0 integer := pg_temp.pickles('RB');
  g0  integer := pg_temp.pickles('G');
begin
  perform pg_temp.as_guest(pg_temp.p('G'));
  r := public.claim_referral(pg_temp.code('RB'));
  perform pg_temp.as_admin();
  perform pg_temp.ok('R5 a guest''s claim: linked false, reason guest', r ->> 'reason' = 'guest', r::text);
  perform pg_temp.ok('R5 ... no row', pg_temp.referrer_of('G') is null);
  -- Even with an is_anonymous-less JWT, auth.users says guest.
  r := pg_temp.claim('G', pg_temp.code('RB'));
  perform pg_temp.ok('R5 ... also when only auth.users says anonymous', r ->> 'reason' = 'guest', r::text);
  perform pg_temp.ok('R5 a direct pay call refuses a guest', not public._pl_pay_referral_reward(pg_temp.p('G')));

  -- Upgrade step 1: updateUser({ email, data: { referral_code } }) - email pending, still anonymous.
  update auth.users
     set raw_user_meta_data = raw_user_meta_data || jsonb_build_object('referral_code', pg_temp.code('RB')),
         email_change = 'rf-g@pickleague.test'
   where id = pg_temp.p('G');
  perform pg_temp.ok('R5 metadata alone links nothing (still a guest)', pg_temp.referrer_of('G') is null);
  -- Step 2: the new email is confirmed; the account stops being anonymous.
  update auth.users
     set email = 'rf-g@pickleague.test', email_change = '', email_confirmed_at = now(), is_anonymous = false
   where id = pg_temp.p('G');
  perform pg_temp.ok('R5 on confirmation the upgraded guest is linked to RB and paid',
    pg_temp.referrer_of('G') = pg_temp.p('RB') and pg_temp.rewarded('G'));
  perform pg_temp.ok('R5 ... +2500 each (RB +150 for Recruiter too)',
    pg_temp.pickles('G') - g0 = 2500 and pg_temp.pickles('RB') - rb0 = 2650,
    format('G %s, RB %s', pg_temp.pickles('G') - g0, pg_temp.pickles('RB') - rb0));
end $$;


-- ════ R6 a confirmation still succeeds when the payout throws ═══════════
create function pg_temp.boom() returns trigger language plpgsql as $$
begin raise exception 'simulated payout failure'; end $$;
create trigger zz_test_boom before update on public.referrals for each row execute function pg_temp.boom();

do $$
declare
  ra0 integer := pg_temp.pickles('RA');
  f0  integer := pg_temp.pickles('F');
  e   jsonb;
begin
  perform pg_temp.ok('R6 F is linked and unpaid', pg_temp.referrer_of('F') = pg_temp.p('RA') and not pg_temp.rewarded('F'));
  e := pg_temp.err(format($q$update auth.users set email_confirmed_at = now() where id = %L$q$, pg_temp.p('F')));
  perform pg_temp.ok('R6 the confirmation goes through despite the broken payout', e is null, e::text);
  perform pg_temp.ok('R6 ... the email is confirmed',
    (select email_confirmed_at is not null from auth.users where id = pg_temp.p('F')));
  perform pg_temp.ok('R6 ... nothing was paid (the payout rolled back as a whole)',
    not pg_temp.rewarded('F') and pg_temp.pickles('F') = f0 and pg_temp.pickles('RA') = ra0);
end $$;

drop trigger zz_test_boom on public.referrals;

do $$
declare
  f0   integer := pg_temp.pickles('F');
  paid boolean;
begin
  paid := public._pl_pay_referral_reward(pg_temp.p('F'));
  perform pg_temp.ok('R6 once fixed, the claim (or a later trigger) pays',
    paid and pg_temp.pickles('F') - f0 = 2500, format('paid %s, +%s', paid, pg_temp.pickles('F') - f0));
end $$;


-- ════ R7 milestones ══════════════════════════════════════════════════════
do $$
declare
  rm0 integer := pg_temp.pickles('RM');
  k   text;
  r   jsonb;
  amt integer[];
begin
  foreach k in array array['M01','M02','M03','M04','M05','M06','M07','M08','M09','M10'] loop
    r := pg_temp.claim(k, pg_temp.code('RM'));
    if not coalesce((r ->> 'rewarded')::boolean, false) then
      perform pg_temp.ok('R7 ' || k || ' claim rewarded', false, r::text);
    end if;
  end loop;
  select array_agg(referrer_pickles order by created_at, invitee_id) into amt
    from public.referrals where referrer_id = pg_temp.p('RM');
  perform pg_temp.ok('R7 10 rewarded referrals', array_length(amt, 1) = 10, amt::text);
  perform pg_temp.ok('R7 the 5th paid 2500 + 2500 bonus, the 10th 2500 + 5000',
    (select count(*) from public.referrals where referrer_id = pg_temp.p('RM') and referrer_pickles = 5000) = 1
    and (select count(*) from public.referrals where referrer_id = pg_temp.p('RM') and referrer_pickles = 7500) = 1
    and (select count(*) from public.referrals where referrer_id = pg_temp.p('RM') and referrer_pickles = 2500) = 8, amt::text);
  perform pg_temp.ok('R7 all three badges',
    (select count(*) from public.player_badges pb join public.badges b on b.id = pb.badge_id
      where pb.user_id = pg_temp.p('RM') and b.name in ('Recruiter', 'Squad Builder', 'Club Builder')) = 3);
  perform pg_temp.ok('R7 RM total: 10 x 2500 + 2500 + 5000 + 3 badges x 150 = 32950',
    pg_temp.pickles('RM') - rm0 = 32950, (pg_temp.pickles('RM') - rm0)::text);
  perform pg_temp.ok('R7 the milestone notifications say so',
    (select count(*) from public.notifications where user_id = pg_temp.p('RM') and body like '%bonus pickles too!%') = 2);

  perform pg_temp.as_user(pg_temp.p('RM'));
  r := public.my_referral_stats()::jsonb;
  perform pg_temp.as_admin();
  perform pg_temp.ok('R7 my_referral_stats: 10 invited, 10 joined, 0 pending, 32500 pickles',
    r = '{"invited": 10, "joined": 10, "pending": 0, "pickles_earned": 32500}'::jsonb, r::text);
end $$;


-- ════ R8 stats, code, preview, RLS, the column guard ═════════════════════
do $$
declare
  r jsonb;
  e jsonb;
  c text;
  n integer;
begin
  perform pg_temp.as_user(pg_temp.p('RA'));
  r := public.my_referral_stats()::jsonb;
  c := public.my_referral_code();
  -- RA: N1, N2, N4, F rewarded (4), NU pending (1).
  perform pg_temp.ok('R8 RA stats: 5 invited, 4 joined, 1 pending, 10000 pickles',
    r = '{"invited": 5, "joined": 4, "pending": 1, "pickles_earned": 10000}'::jsonb, r::text);
  perform pg_temp.ok('R8 my_referral_code is RA''s code', c = pg_temp.code('RA'), c);
  select count(*) into n from public.referrals;
  perform pg_temp.ok('R8 RLS: RA sees only its own 5 rows', n = 5, n::text);
  e := pg_temp.err($q$select count(*) from public.deferred_invite_clicks$q$);
  perform pg_temp.ok('R8 a client cannot read deferred_invite_clicks', e is not null, e::text);
  e := pg_temp.err($q$insert into public.referrals (referrer_id, invitee_id) values ('a7000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000013')$q$);
  perform pg_temp.ok('R8 a client cannot insert a referral row', e is not null, e::text);

  perform pg_temp.as_user(pg_temp.p('N1'));
  r := public.my_referral_stats()::jsonb;
  perform pg_temp.ok('R8 N1 (an invitee) stats count its own welcome: 2500',
    (r ->> 'pickles_earned')::integer = 2500 and (r ->> 'invited')::integer = 0, r::text);
  select count(*) into n from public.referrals;
  perform pg_temp.ok('R8 RLS: N1 sees its one row', n = 1, n::text);
  -- Both columns live in profile_private (migration_anon_audit_rest.sql),
  -- where the owner may update the phone only.
  e := pg_temp.err($q$update public.profile_private set referral_code = 'hacked', invited_by = null$q$);
  update public.profiles set tagline = 'hi' where id = pg_temp.p('N1');
  perform pg_temp.as_admin();
  perform pg_temp.ok('R8 a client cannot change its referral_code or invited_by (and still edits its profile)',
    e is not null and pg_temp.code('N1') <> 'hacked'
    and (select invited_by = pg_temp.p('RA') from public.profile_private where id = pg_temp.p('N1'))
    and (select tagline = 'hi' from public.profiles where id = pg_temp.p('N1')), e::text);

  perform pg_temp.as_anon();
  r := public.referral_preview(upper(pg_temp.code('RA')))::jsonb;
  perform pg_temp.ok('R8 referral_preview (anon): first name only', r ->> 'referrer_name' = 'Alice', r::text);
  perform pg_temp.ok('R8 referral_preview unknown code: null', public.referral_preview('nope') is null);
  perform pg_temp.ok('R8 referral_preview of an unclaimed placeholder: null', public.referral_preview(pg_temp.code('UC')) is null);
  perform pg_temp.as_admin();
end $$;


-- ════ R9 the daily nudge, the purge ══════════════════════════════════════
do $$
declare
  n integer;
begin
  perform pg_temp.as_admin();
  perform pg_temp.ok('R9 NU is linked and unconfirmed', pg_temp.referrer_of('NU') = pg_temp.p('RA') and not pg_temp.rewarded('NU'));
  n := public.notify_stalled_referral_invitees();
  perform pg_temp.ok('R9 a referral made today is not nudged yet',
    (select nudged_at is null from public.referrals where invitee_id = pg_temp.p('NU')));
  update public.referrals set created_at = now() - interval '2 days' where invitee_id = pg_temp.p('NU');
  n := public.notify_stalled_referral_invitees();
  perform pg_temp.ok('R9 two days on: nudged once', n >= 1
    and (select nudged_at is not null from public.referrals where invitee_id = pg_temp.p('NU'))
    and (select count(*) from public.notifications where user_id = pg_temp.p('NU') and title like '%Confirm your email%') = 1, n::text);
  n := public.notify_stalled_referral_invitees();
  perform pg_temp.ok('R9 the next day: not again',
    (select count(*) from public.notifications where user_id = pg_temp.p('NU') and title like '%Confirm your email%') = 1);
  -- 20 days old and never nudged: past the window.
  update public.referrals set created_at = now() - interval '20 days', nudged_at = null where invitee_id = pg_temp.p('NU');
  delete from public.notifications where user_id = pg_temp.p('NU');
  n := public.notify_stalled_referral_invitees();
  perform pg_temp.ok('R9 past 14 days: no nudge',
    not exists (select 1 from public.notifications where user_id = pg_temp.p('NU')));
  -- A confirmed (rewarded) invitee is never nudged.
  perform pg_temp.ok('R9 rewarded invitees were not nudged',
    not exists (select 1 from public.notifications where user_id in (pg_temp.p('N1'), pg_temp.p('N2')) and title like '%Confirm your email%'));

  insert into public.deferred_invite_clicks (code, ip_hash, platform, created_at) values
    ('old', 'h1', 'ios', now() - interval '25 hours'),
    ('new', 'h1', 'ios', now() - interval '1 hour');
  n := public.purge_deferred_invite_clicks();
  perform pg_temp.ok('R9 purge removes clicks older than 24 h only',
    n >= 1 and not exists (select 1 from public.deferred_invite_clicks where code = 'old')
    and exists (select 1 from public.deferred_invite_clicks where code = 'new'), n::text);
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
