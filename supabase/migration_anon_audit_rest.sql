-- ============================================================================
-- Signed-out (anon) audit, the rest (2026-10). Follows
-- migration_anon_audit_fixes.sql, which fixed the four worst findings.
--
--   1. WAGERS      get_my_wagers_with_details() and calculate_wager_odds()
--                  were executable by anon. Signed in only now (every app
--                  caller is: MyWagersScreen, lib/wager.ts). Neither body has
--                  a NULL-uid hole: the first raises 'Not authenticated', the
--                  second reads no caller identity at all.
--   2. TOURNAMENTS / EVENTS of a closed league were readable by anyone
--                  (SELECT policies `using (true)`). The rule now: a row of a
--                  tournament (tournaments.league_id) or event
--                  (league_events.league_id) in a league is visible only if
--                  public._pl_can_see_league(league_id) (open league, its
--                  creator, a current member, godmode); league_id null stays
--                  public. A tournament is also visible to its creator and to
--                  anyone with a registration in it (an invitee who is not a
--                  league member must still see the invite), and a player
--                  always sees their own rows (registration, match, team,
--                  pair, request, rank, bonus, badge, vote, decline, pot row).
--                    tournaments, tournament_registrations, tournament_matches,
--                    tournament_rounds, mlp_teams, mlp_team_join_requests,
--                    doubles_pairs, doubles_pair_join_requests,
--                    tournament_final_ranks, tournament_plupr_bonuses,
--                    tournament_champion_badges, event_slots,
--                    event_slot_votes, event_declines,
--                    pickle_pot_contributions, pickle_pot_payouts
--                  (the pots are scoped to a league, season or tournament).
--                  Helpers, SECURITY DEFINER (so they read past RLS and the
--                  policies never recurse): _pl_can_see_tournament(id),
--                  _pl_can_see_event(id), _pl_can_see_event_slot(id),
--                  _pl_can_see_mlp_team(id), _pl_can_see_doubles_pair(id),
--                  _pl_can_see_pot_scope(type, id). The policies have NO
--                  subqueries at all (see migration_closed_league_privacy.sql
--                  for the recursion a sublink caused there). Signed out, the
--                  OG cards (mobile/api/_lib/cards.tsx) of a closed league's
--                  tournament or event find nothing and fall back to the
--                  generic card; public ones read exactly as before.
--   3. PROFILES    referral_code and invited_by move to profile_private
--                  (owner-only). Nothing in the app reads either column
--                  (my_referral_code / referral_preview / claim_referral are
--                  RPCs); invited_by is who-invited-whom, the code maps a
--                  shared link to an account. Every profile still gets a code
--                  at sign-up (a trigger on profiles now, instead of the
--                  column default), so links keep working; existing codes and
--                  links move unchanged. Replaced: _pl_link_referral,
--                  my_referral_code, referral_preview (bodies otherwise as
--                  migration_referrals.sql). The silent referral guard trigger
--                  goes with the columns (profile_private grants the owner
--                  UPDATE on phone only).
--                  Stay on profiles, readable by everyone, on purpose:
--                    dupr_id          shown on PlayerProfileScreen as the
--                                     "DUPR <id>" verification chip (and it is
--                                     public on DUPR itself)
--                    pickles          a balance, not contact data; ~40 server
--                                     functions read and write it (moving it is
--                                     a rewrite of the economy, not a privacy
--                                     fix). The column guard still keeps
--                                     players from writing it.
--                    guest_expires_at shipped builds read it directly
--                                     (AppNavigator signs an expired guest out);
--                                     moving it would silently switch that off
--                                     in every installed build. A date only.
--                    is_test_account  the discovery filters read it; harmless.
--                    deleted_at       the signed-out OG cards and the app's
--                                     filters need it to hide tombstones.
--   4. DEFAULTS    Postgres grants EXECUTE on every new function to PUBLIC,
--                  and Supabase's default privileges hand anon EXECUTE on
--                  functions and INSERT/UPDATE/DELETE on tables. Now:
--                    * default privileges (functions postgres creates): no
--                      PUBLIC anywhere, no anon in public; new public tables
--                      give anon SELECT only, new sequences nothing.
--                    * every public function postgres owns loses PUBLIC
--                      EXECUTE (authenticated and service_role keep exactly
--                      what they had, now as explicit grants), and anon keeps
--                      EXECUTE only on the SIGNED-OUT ALLOWLIST below, plus
--                      any function a SELECT/ALL policy for anon or PUBLIC
--                      calls (a policy runs its functions with the caller's
--                      privileges; nothing is ever newly granted to anon).
--                    * anon loses INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/
--                      TRIGGER/MAINTAIN on every public table except
--                      analytics_events and analytics_sessions (the signed-out
--                      analytics path in mobile/src/lib/analytics.ts inserts
--                      there and bumps through analytics_touch), and every
--                      privilege on public sequences. SELECT is unchanged (RLS
--                      decides). authenticated and service_role are untouched.
--   5. GIFTS       player_shop_purchases was world-readable with gift_message.
--                  The message moves to player_shop_gift_messages, readable by
--                  its sender and recipient only; a BEFORE trigger moves any
--                  message a writer still puts in gift_message (gift_shop_item,
--                  gift_real_world_item, an old migration re-run), so the
--                  column stays (always null) and old app builds that select it
--                  keep working (they show "A gift"). Purchases themselves:
--                  signed in only; another player's hidden ones are no longer
--                  listed (the app never showed them).
--   6. GODMODE     is_godmode_user(uuid) loses anon/PUBLIC EXECUTE (no policy
--                  that runs for anon calls it; the zero-argument version was
--                  already signed in only).
--
-- ── SIGNED-OUT ALLOWLIST (anon EXECUTE) ─────────────────────────────────────
-- A future migration that adds a function a signed-out caller needs must
-- `grant execute on function <fn> to anon` itself AND add its name to
-- c_anon_allow in section 6 below (a re-run of this file revokes anon from
-- anything not listed). Today:
--   referral_preview          web invite landing (InviteLandingScreen)
--   get_guest_invite_preview  GuestJoinScreen, before the guest session exists
--   og_card_tz                the OG card endpoint (mobile/api, anon key)
--   analytics_touch           signed-out analytics heartbeat
--   _pl_can_see_league, _pl_can_see_tournament, _pl_can_see_event,
--   _pl_can_see_event_slot, _pl_can_see_mlp_team, _pl_can_see_doubles_pair,
--   _pl_can_see_pot_scope, is_scope_admin
--                             run inside SELECT/ALL policies anon reads through
-- Not on it (signed in only now, though anon could call them before):
-- analytics_claim (it claims a session for auth.uid(); the app calls it on
-- SIGNED_IN), is_expired_guest (an INSERT policy only; anon inserts nothing
-- there now), and every other RPC.
--
-- Re-runnable: every step checks, replaces or is idempotent. Needs
-- migration_closed_league_privacy.sql (_pl_can_see_league) and
-- migration_anon_audit_fixes.sql (profile_private) applied first.
-- The functions it replaces were last defined by migration_referrals.sql
-- (supabase/tests/check-replaced-functions.mjs checks live against it).
--
-- RE-RUN HAZARDS (re-run THIS file after any of them):
--   * migration_referrals.sql re-adds profiles.referral_code / invited_by
--     (with a NEW random code for every profile) and points
--     _pl_link_referral / my_referral_code / referral_preview back at them:
--     every shared invite link stops resolving until this file runs again
--     (which keeps the original codes: profile_private's code always wins).
--   * schema.sql / setup_all_migrations.sql / any older file that creates the
--     "... viewable by everyone" `using (true)` SELECT policies on the tables
--     in item 2 or player_shop_purchases re-opens them.
--   * migration_fix_policy_fn_grants.sql and
--     migration_guest_expiry_enforcement.sql grant is_expired_guest to anon
--     again (harmless, but outside the allowlist).
--   * a file that DROPs and re-creates an allowlisted function without its own
--     `grant ... to anon` takes it offline for signed-out callers (new
--     functions no longer get anon EXECUTE by default).
--   * migration_rls_hardening_2026q3.sql is safe to re-run (it only revokes,
--     and it lists this file's helpers).
-- ============================================================================


-- ── 1. Wager reads: signed in only ─────────────────────────────────────────
revoke execute on function public.get_my_wagers_with_details() from public, anon;
revoke execute on function public.calculate_wager_odds(text, uuid, jsonb) from public, anon;
grant execute on function public.get_my_wagers_with_details() to authenticated, service_role;
grant execute on function public.calculate_wager_odds(text, uuid, jsonb) to authenticated, service_role;


-- ── 2. is_godmode_user(uuid): signed in only ───────────────────────────────
-- Callers: _pl_can_see_league (definer, so it runs as the owner) and signed-in
-- code. No policy evaluated for anon calls it (checked with pg_depend).
revoke execute on function public.is_godmode_user(uuid) from public, anon;
grant execute on function public.is_godmode_user(uuid) to authenticated, service_role;


-- ── 3. Tournaments and events of a closed league ───────────────────────────
-- Policies run their functions with the CALLER's privileges, so anon and
-- authenticated need EXECUTE on these. Each only answers "can I see this".
create or replace function public._pl_can_see_tournament(p_tournament_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_tournament_id is not null and exists (
    select 1 from public.tournaments t
     where t.id = p_tournament_id
       and (
         t.league_id is null
         or public._pl_can_see_league(t.league_id)
         or (auth.uid() is not null and (
               t.created_by = auth.uid()
               or exists (select 1 from public.tournament_registrations r
                           where r.tournament_id = t.id and r.user_id = auth.uid())
             ))
       )
  );
$$;

create or replace function public._pl_can_see_event(p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_event_id is not null and exists (
    select 1 from public.league_events e
     where e.id = p_event_id and public._pl_can_see_league(e.league_id)
  );
$$;

create or replace function public._pl_can_see_event_slot(p_slot_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_slot_id is not null and exists (
    select 1 from public.event_slots s
      join public.league_events e on e.id = s.event_id
     where s.id = p_slot_id and public._pl_can_see_league(e.league_id)
  );
$$;

create or replace function public._pl_can_see_mlp_team(p_team_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_team_id is not null and exists (
    select 1 from public.mlp_teams m
     where m.id = p_team_id and public._pl_can_see_tournament(m.tournament_id)
  );
$$;

create or replace function public._pl_can_see_doubles_pair(p_pair_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_pair_id is not null and exists (
    select 1 from public.doubles_pairs d
     where d.id = p_pair_id and public._pl_can_see_tournament(d.tournament_id)
  );
$$;

-- A pickle pot's scope: 'league', 'season' or 'tournament' (the tables'
-- CHECK constraints allow exactly these).
create or replace function public._pl_can_see_pot_scope(p_scope_type text, p_scope_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case p_scope_type
    when 'league'     then public._pl_can_see_league(p_scope_id)
    when 'season'     then exists (select 1 from public.league_seasons s
                                    where s.id = p_scope_id and public._pl_can_see_league(s.league_id))
    when 'tournament' then public._pl_can_see_tournament(p_scope_id)
    else false
  end;
$$;

do $$
declare sig text;
begin
  foreach sig in array array[
    'public._pl_can_see_tournament(uuid)', 'public._pl_can_see_event(uuid)', 'public._pl_can_see_event_slot(uuid)',
    'public._pl_can_see_mlp_team(uuid)', 'public._pl_can_see_doubles_pair(uuid)', 'public._pl_can_see_pot_scope(text,uuid)'
  ] loop
    execute format('revoke execute on function %s from public', sig);
    execute format('grant execute on function %s to anon, authenticated, service_role', sig);
  end loop;
end $$;

-- Drop the old "everyone" SELECT policies (any SELECT policy whose qual is
-- just `true`) and this file's own, then create the new ones.
do $$
declare r record;
begin
  for r in
    select pol.tablename, pol.policyname
      from pg_policies pol
     where pol.schemaname = 'public'
       and pol.tablename in ('tournaments', 'tournament_registrations', 'tournament_matches', 'tournament_rounds',
                             'mlp_teams', 'mlp_team_join_requests', 'doubles_pairs', 'doubles_pair_join_requests',
                             'tournament_final_ranks', 'tournament_plupr_bonuses', 'tournament_champion_badges',
                             'event_slots', 'event_slot_votes', 'event_declines',
                             'pickle_pot_contributions', 'pickle_pot_payouts')
       and pol.cmd = 'SELECT'
       and (pol.qual = 'true' or pol.policyname like 'Closed league privacy:%')
  loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- NO SUBQUERIES in any of these (plain auth.uid(), column references on the
-- policy's own table, helper calls): a sublink here is what raised "infinite
-- recursion detected in policy" for league_members. created_by / user_id are
-- tested inline, not through a helper, so an INSERT ... RETURNING passes on
-- the new row itself (CreateTournamentScreen, a self-registration).
create policy "Closed league privacy: tournaments" on public.tournaments
  for select using (
    league_id is null
    or public._pl_can_see_league(league_id)
    or (auth.uid() is not null and created_by = auth.uid())
    or public._pl_can_see_tournament(id)
  );

create policy "Closed league privacy: tournament_registrations" on public.tournament_registrations
  for select using (
    user_id = auth.uid()
    or public._pl_can_see_tournament(tournament_id)
  );

create policy "Closed league privacy: tournament_matches" on public.tournament_matches
  for select using (
    auth.uid() in (team1_player1, team1_player2, team2_player1, team2_player2)
    or public._pl_can_see_tournament(tournament_id)
  );

create policy "Closed league privacy: tournament_rounds" on public.tournament_rounds
  for select using (public._pl_can_see_tournament(tournament_id));

create policy "Closed league privacy: mlp_teams" on public.mlp_teams
  for select using (
    auth.uid() in (captain_id, male_1_id, male_2_id, female_1_id, female_2_id)
    or public._pl_can_see_tournament(tournament_id)
  );

create policy "Closed league privacy: mlp_team_join_requests" on public.mlp_team_join_requests
  for select using (
    user_id = auth.uid()
    or public._pl_can_see_mlp_team(team_id)
  );

create policy "Closed league privacy: doubles_pairs" on public.doubles_pairs
  for select using (
    auth.uid() in (captain_id, partner_1_id, partner_2_id)
    or public._pl_can_see_tournament(tournament_id)
  );

create policy "Closed league privacy: doubles_pair_join_requests" on public.doubles_pair_join_requests
  for select using (
    user_id = auth.uid()
    or public._pl_can_see_doubles_pair(pair_id)
  );

create policy "Closed league privacy: tournament_final_ranks" on public.tournament_final_ranks
  for select using (
    user_id = auth.uid()
    or public._pl_can_see_tournament(tournament_id)
  );

create policy "Closed league privacy: tournament_plupr_bonuses" on public.tournament_plupr_bonuses
  for select using (
    user_id = auth.uid()
    or public._pl_can_see_tournament(tournament_id)
  );

create policy "Closed league privacy: tournament_champion_badges" on public.tournament_champion_badges
  for select using (
    user_id = auth.uid()
    or public._pl_can_see_tournament(tournament_id)
  );

create policy "Closed league privacy: event_slots" on public.event_slots
  for select using (public._pl_can_see_event(event_id));

create policy "Closed league privacy: event_slot_votes" on public.event_slot_votes
  for select using (
    user_id = auth.uid()
    or public._pl_can_see_event_slot(slot_id)
  );

create policy "Closed league privacy: event_declines" on public.event_declines
  for select using (
    user_id = auth.uid()
    or public._pl_can_see_event(event_id)
  );

create policy "Closed league privacy: pickle_pot_contributions" on public.pickle_pot_contributions
  for select using (
    user_id = auth.uid()
    or public._pl_can_see_pot_scope(scope_type, scope_id)
  );

create policy "Closed league privacy: pickle_pot_payouts" on public.pickle_pot_payouts
  for select using (
    user_id = auth.uid()
    or public._pl_can_see_pot_scope(scope_type, scope_id)
  );


-- ── 4. Referral code and inviter: owner-only (profile_private) ─────────────
alter table public.profile_private add column if not exists referral_code text;
alter table public.profile_private
  add column if not exists invited_by uuid references public.profiles (id) on delete set null;
create unique index if not exists profile_private_referral_code_uq
  on public.profile_private (lower(referral_code));

comment on table public.profile_private is
  'The owner-only half of a profile: phone (migration_anon_audit_fixes.sql), referral_code and invited_by (migration_anon_audit_rest.sql). Readable by its owner only, never by other players or signed-out visitors; the owner may update phone only. Written by definer functions; deleted by _purge_account.';

-- A fresh code (the old column default). Internal.
create or replace function public._pl_new_referral_code()
returns text
language sql
volatile
set search_path = ''
as $$
  select substr(md5(random()::text || clock_timestamp()::text), 1, 10);
$$;
revoke execute on function public._pl_new_referral_code() from public, anon, authenticated;

-- Move what profiles holds (only while the columns are there: a re-run finds
-- them gone, or re-added by a migration_referrals.sql re-run, whose fresh
-- random codes then lose to the ones already here).
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'profiles' and column_name = 'referral_code') then
    execute $sql$
      insert into public.profile_private (id, referral_code, updated_at)
      select p.id, p.referral_code, now()
        from public.profiles p
       where p.deleted_at is null and nullif(btrim(p.referral_code), '') is not null
      on conflict (id) do update
        set referral_code = coalesce(public.profile_private.referral_code, excluded.referral_code)
    $sql$;
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'profiles' and column_name = 'invited_by') then
    execute $sql$
      insert into public.profile_private (id, invited_by, updated_at)
      select p.id, p.invited_by, now()
        from public.profiles p
       where p.deleted_at is null and p.invited_by is not null
      on conflict (id) do update
        set invited_by = coalesce(public.profile_private.invited_by, excluded.invited_by)
    $sql$;
  end if;
end $$;

-- Every live profile has a code (as before, when the column default made one).
insert into public.profile_private (id, referral_code, updated_at)
select p.id, public._pl_new_referral_code(), now()
  from public.profiles p
  left join public.profile_private pp on pp.id = p.id
 where p.deleted_at is null and pp.referral_code is null
on conflict (id) do update
  set referral_code = coalesce(public.profile_private.referral_code, excluded.referral_code);

drop trigger if exists trg_profiles_referral_guard on public.profiles;
drop function if exists public._pl_profiles_referral_guard();
drop index if exists public.profiles_referral_code_uq;
alter table public.profiles drop column if exists referral_code;
alter table public.profiles drop column if exists invited_by;

-- A new profile gets its private row and code at once. Never blocks a
-- sign-up: after 5 code collisions (10 hex digits; never in practice) the row
-- is made without one and my_referral_code mints it later.
create or replace function public._pl_profile_private_on_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  i integer;
begin
  for i in 1 .. 5 loop
    begin
      insert into public.profile_private (id, referral_code, updated_at)
      values (new.id, public._pl_new_referral_code(), now())
      on conflict (id) do update
        set referral_code = coalesce(public.profile_private.referral_code, excluded.referral_code);
      return new;
    exception when unique_violation then
      null;
    end;
  end loop;
  insert into public.profile_private (id) values (new.id) on conflict (id) do nothing;
  return new;
end;
$$;
revoke execute on function public._pl_profile_private_on_profile() from public, anon, authenticated;

drop trigger if exists trg_profiles_private_row on public.profiles;
create trigger trg_profiles_private_row
  after insert on public.profiles
  for each row execute function public._pl_profile_private_on_profile();

-- _pl_link_referral: as migration_referrals.sql, reading the code and writing
-- invited_by in profile_private.
create or replace function public._pl_link_referral(p_invitee uuid, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code     text := lower(trim(coalesce(p_code, '')));
  v_ref      uuid;
  v_name     text;
  v_existing record;
  v_created  timestamptz;
  v_n        bigint := 0;
  v_paid     boolean := false;
begin
  if p_invitee is null then return jsonb_build_object('linked', false, 'reason', 'signed_out'); end if;
  if v_code = '' or length(v_code) > 64 then
    return jsonb_build_object('linked', false, 'reason', 'no_code');
  end if;

  select p.id, coalesce(nullif(split_part(trim(p.full_name), ' ', 1), ''), 'A friend')
    into v_ref, v_name
    from public.profile_private pp
    join public.profiles p on p.id = pp.id
   where lower(pp.referral_code) = v_code
     and p.deleted_at is null
     and not p.is_unclaimed
   limit 1;
  if v_ref is null then return jsonb_build_object('linked', false, 'reason', 'unknown_code'); end if;
  if v_ref = p_invitee then return jsonb_build_object('linked', false, 'reason', 'self'); end if;

  select referrer_id, rewarded_at into v_existing
    from public.referrals where invitee_id = p_invitee;
  if found then
    if v_existing.referrer_id = v_ref then
      return jsonb_build_object('linked', true, 'already', true, 'referrer_name', v_name,
                                'rewarded', v_existing.rewarded_at is not null);
    end if;
    return jsonb_build_object('linked', false, 'reason', 'already_referred');
  end if;

  select created_at into v_created from public.profiles where id = p_invitee;
  if v_created is null then return jsonb_build_object('linked', false, 'reason', 'no_profile'); end if;
  if v_created < now() - interval '30 days' then
    return jsonb_build_object('linked', false, 'reason', 'too_old');
  end if;

  insert into public.referrals (referrer_id, invitee_id)
  values (v_ref, p_invitee)
  on conflict (invitee_id) do nothing;
  get diagnostics v_n = row_count;
  if v_n = 0 then return jsonb_build_object('linked', false, 'reason', 'already_referred'); end if;

  -- Who invited whom is the invitee's alone (migration_anon_audit_rest.sql).
  insert into public.profile_private (id, invited_by, updated_at)
  values (p_invitee, v_ref, now())
  on conflict (id) do update
    set invited_by = coalesce(public.profile_private.invited_by, excluded.invited_by);

  -- Already confirmed (the usual case for a claim from the app): pay now.
  v_paid := public._pl_pay_referral_reward(p_invitee);

  return jsonb_build_object('linked', true, 'referrer_name', v_name, 'rewarded', v_paid);
end;
$$;
revoke execute on function public._pl_link_referral(uuid, text) from public, anon, authenticated;

-- The caller's referral code (minted if somehow missing).
create or replace function public.my_referral_code()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_code text;
  i      integer;
begin
  if v_uid is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;
  select referral_code into v_code from public.profile_private where id = v_uid;
  if v_code is null and exists (select 1 from public.profiles where id = v_uid) then
    for i in 1 .. 5 loop
      begin
        insert into public.profile_private (id, referral_code, updated_at)
        values (v_uid, public._pl_new_referral_code(), now())
        on conflict (id) do update
          set referral_code = coalesce(public.profile_private.referral_code, excluded.referral_code)
        returning referral_code into v_code;
        exit;
      exception when unique_violation then
        null;
      end;
    end loop;
  end if;
  return v_code;
end;
$$;
revoke execute on function public.my_referral_code() from public, anon;
grant execute on function public.my_referral_code() to authenticated, service_role;

-- Public invite-landing teaser (called signed out by the web page).
create or replace function public.referral_preview(p_code text)
returns json
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_code text := lower(trim(coalesce(p_code, '')));
  v_row  record;
begin
  if v_code = '' or length(v_code) > 64 then return null; end if;
  select coalesce(nullif(split_part(trim(p.full_name), ' ', 1), ''), 'A friend') as first_name,
         p.avatar_url, p.avatar_emoji, p.avatar_bg_color
    into v_row
    from public.profile_private pp
    join public.profiles p on p.id = pp.id
   where lower(pp.referral_code) = v_code
     and p.deleted_at is null
     and not p.is_unclaimed
   limit 1;
  if not found then return null; end if;
  return json_build_object(
    'referrer_name',   v_row.first_name,
    'avatar_url',      v_row.avatar_url,
    'avatar_emoji',    v_row.avatar_emoji,
    'avatar_bg_color', v_row.avatar_bg_color
  );
end;
$$;
revoke execute on function public.referral_preview(text) from public;
grant execute on function public.referral_preview(text) to anon, authenticated, service_role;


-- ── 5. Gift messages: sender and recipient only ────────────────────────────
create table if not exists public.player_shop_gift_messages (
  purchase_id  uuid primary key
               references public.player_shop_purchases (id) on delete cascade
               deferrable initially deferred,
  sender_id    uuid references public.profiles (id) on delete set null,
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  message      text not null,
  created_at   timestamptz not null default now()
);

comment on table public.player_shop_gift_messages is
  'The message of a gifted shop item, readable by its sender and recipient only (migration_anon_audit_rest.sql). Written by trg_player_shop_purchases_gift_private; player_shop_purchases.gift_message is always null.';

alter table public.player_shop_gift_messages enable row level security;
revoke all on table public.player_shop_gift_messages from public, anon, authenticated;
grant select on table public.player_shop_gift_messages to authenticated;
grant all on table public.player_shop_gift_messages to service_role;

drop policy if exists "Gift messages: sender and recipient" on public.player_shop_gift_messages;
create policy "Gift messages: sender and recipient" on public.player_shop_gift_messages
  for select to authenticated
  using (sender_id = (select auth.uid()) or recipient_id = (select auth.uid()));

-- Move the messages there are (before the trigger: no double handling).
insert into public.player_shop_gift_messages (purchase_id, sender_id, recipient_id, message, created_at)
select s.id, s.gifted_by_user_id, s.user_id, s.gift_message, coalesce(s.purchased_at, now())
  from public.player_shop_purchases s
 where nullif(btrim(s.gift_message), '') is not null
on conflict (purchase_id) do nothing;
update public.player_shop_purchases set gift_message = null where gift_message is not null;

-- Whoever writes gift_message (gift_shop_item, gift_real_world_item, an old
-- file re-run), the message lands in the private table and the column stays
-- null. The FK above is deferred: on INSERT the purchase row is not there yet.
create or replace function public._pl_shop_gift_message_private()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if nullif(btrim(coalesce(new.gift_message, '')), '') is not null then
    insert into public.player_shop_gift_messages (purchase_id, sender_id, recipient_id, message)
    values (new.id, new.gifted_by_user_id, new.user_id, new.gift_message)
    on conflict (purchase_id) do update
      set message = excluded.message, sender_id = excluded.sender_id, recipient_id = excluded.recipient_id;
  end if;
  new.gift_message := null;
  return new;
end;
$$;
revoke execute on function public._pl_shop_gift_message_private() from public, anon, authenticated;

drop trigger if exists trg_player_shop_purchases_gift_private on public.player_shop_purchases;
create trigger trg_player_shop_purchases_gift_private
  before insert or update of gift_message on public.player_shop_purchases
  for each row execute function public._pl_shop_gift_message_private();

comment on column public.player_shop_purchases.gift_message is
  'Always null since migration_anon_audit_rest.sql: the message is in player_shop_gift_messages (sender and recipient only). Kept so old app builds that select it still work.';

-- Purchases: signed in; your own and the ones you gave always, others'
-- only when shown (the app lists others' purchases with is_hidden = false).
drop policy if exists "Purchases viewable by everyone" on public.player_shop_purchases;
drop policy if exists "Shop purchases: own, given, or shown" on public.player_shop_purchases;
create policy "Shop purchases: own, given, or shown" on public.player_shop_purchases
  for select using (
    user_id = auth.uid()
    or gifted_by_user_id = auth.uid()
    or (auth.uid() is not null and not is_hidden)
  );


-- ── 6. The sweep: default privileges, function EXECUTE, anon writes ────────
-- (Last, so it covers every function this file made.)

-- New functions postgres creates: no PUBLIC anywhere (a per-schema default can
-- only add, so this one is global), no anon in public. New public tables give
-- anon SELECT only; new public sequences nothing.
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema public revoke execute on functions from anon;
alter default privileges for role postgres in schema public
  revoke insert, update, delete, truncate, references, trigger, maintain on tables from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;

-- supabase_admin's defaults (it owns the extension functions here) need
-- membership in that role, which postgres does not have on hosted Supabase.
do $$
begin
  execute 'alter default privileges for role supabase_admin in schema public revoke execute on functions from anon';
  execute 'alter default privileges for role supabase_admin in schema public revoke insert, update, delete, truncate, references, trigger, maintain on tables from anon';
  execute 'alter default privileges for role supabase_admin in schema public revoke all on sequences from anon';
exception when others then
  raise notice 'supabase_admin default privileges left as they are (%)', sqlerrm;
end $$;

do $$
declare
  -- THE SIGNED-OUT ALLOWLIST (see the header). Add a name here when a new
  -- function must stay callable signed out.
  c_anon_allow constant text[] := array[
    'referral_preview', 'get_guest_invite_preview', 'og_card_tz', 'analytics_touch',
    '_pl_can_see_league', '_pl_can_see_tournament', '_pl_can_see_event', '_pl_can_see_event_slot',
    '_pl_can_see_mlp_team', '_pl_can_see_doubles_pair', '_pl_can_see_pot_scope', 'is_scope_admin'
  ];
  f          record;
  v_anon_ok  boolean;
begin
  for f in
    select p.oid, p.oid::regprocedure as sig, p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proowner = 'postgres'::regrole
       and not exists (select 1 from pg_depend e
                        where e.classid = 'pg_proc'::regclass and e.objid = p.oid and e.deptype = 'e')
  loop
    -- A function a SELECT/ALL policy for anon or PUBLIC calls: anon keeps it.
    v_anon_ok := f.proname = any (c_anon_allow)
      or exists (
        select 1 from pg_depend d
          join pg_policy pol on pol.oid = d.objid
         where d.classid = 'pg_policy'::regclass and d.refclassid = 'pg_proc'::regclass
           and d.refobjid = f.oid
           and pol.polcmd in ('r', '*')
           and (0::oid = any (pol.polroles) or 'anon'::regrole::oid = any (pol.polroles))
      );

    -- What authenticated and service_role can run today, they keep, as
    -- explicit grants (some had it through PUBLIC only).
    if has_function_privilege('authenticated', f.oid, 'EXECUTE') then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
    if has_function_privilege('service_role', f.oid, 'EXECUTE') then
      execute format('grant execute on function %s to service_role', f.sig);
    end if;
    -- anon: kept (never newly granted) when allowed, revoked otherwise.
    if v_anon_ok and has_function_privilege('anon', f.oid, 'EXECUTE') then
      execute format('grant execute on function %s to anon', f.sig);
    end if;
    execute format('revoke execute on function %s from public', f.sig);
    if not v_anon_ok then
      execute format('revoke execute on function %s from anon', f.sig);
    end if;
  end loop;
end $$;

-- anon writes nothing but signed-out analytics. SELECT stays (RLS decides).
do $$
declare t record;
begin
  for t in
    select c.oid::regclass as rel, c.relname, c.relkind
      from pg_class c
     where c.relnamespace = 'public'::regnamespace
       and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
       and c.relowner = 'postgres'::regrole
  loop
    if t.relkind = 'S' then
      execute format('revoke all on sequence %s from anon', t.rel);
    elsif t.relname not in ('analytics_events', 'analytics_sessions') then
      execute format('revoke insert, update, delete, truncate, references, trigger, maintain on table %s from anon', t.rel);
    end if;
  end loop;
end $$;

-- Column-level write grants to anon (none on live today; a table-level revoke
-- does not remove them).
do $$
declare c record;
begin
  for c in
    select distinct a.attrelid::regclass as rel, a.attname, x.privilege_type
      from pg_attribute a
      join pg_class cl on cl.oid = a.attrelid
      cross join lateral aclexplode(a.attacl) x
     where cl.relnamespace = 'public'::regnamespace
       and cl.relowner = 'postgres'::regrole
       and cl.relname not in ('analytics_events', 'analytics_sessions')
       and a.attacl is not null
       and x.grantee = 'anon'::regrole::oid
       and x.privilege_type in ('INSERT', 'UPDATE', 'REFERENCES')
  loop
    execute format('revoke %s (%I) on %s from anon', c.privilege_type, c.attname, c.rel);
  end loop;
end $$;

-- PostgREST: profiles lost two columns, a table is new.
notify pgrst, 'reload schema';
