-- ============================================================
-- League join requests resolve themselves (league membership audit,
-- 2026-10-14). Needs migration_add_join_requests.sql,
-- migration_league_join_request_push.sql, migration_unified_invite_codes.sql
-- and migration_push_actions_match_tournament.sql first. Idempotent:
-- create or replace / drop trigger if exists / drop policy if exists.
--
-- Before this, nothing closed a join request. Joining by ANY path (code,
-- open Join, guest invite, godmode) left the row 'pending', so the admins
-- kept the 🙋 notice, the Up next row and "Sam wants to join" on
-- LeagueMembers, and removing the member later brought the request back.
-- Now the row's lifecycle lives here:
--
--   pending ──approve / any join──▶ (row deleted; requester is a member)
--   pending ──deny──────────────────▶ denied     (7-day cooldown, then
--                                                 request_league_join resets it)
--   pending ──withdraw──────────────▶ withdrawn  (re-request allowed; the
--                                                 admins are re-notified only
--                                                 if their last notice for
--                                                 this pair is > 1 hour old)
--   private league turns open ──────▶ every pending requester is admitted
--
-- Whenever a row LEAVES pending (or a pending row is deleted, e.g. account
-- deletion), the admins' league_join_request notices for that pair are
-- DELETED (owner decision: resolved notices are deleted, not rewritten).
-- When someone joins, their own league_invite notices for that league go too.
--
-- Contents:
--   1. columns + status check ('withdrawn') + RLS (insert pending only; the
--      user DELETE policy is dropped: withdraw goes through the RPC, so a
--      denied / withdrawn row can't be deleted to dodge the cooldown)
--   2. internal helpers (EXECUTE revoked from public, anon, authenticated)
--   3. triggers: before-guard/stamps, notify (re-gated), resolved, member
--      joined, league opened
--   4. redeem_invite_code: "already a member / registered" checked BEFORE
--      revoked / expired / max uses
--   5. send_invite_code_to_users: one live invite notice per league per person
--   6. client RPCs (granted to authenticated): request_league_join,
--      withdraw_league_join_request, approve_league_join_request,
--      deny_league_join_request
--   7. BACKFILL (commented out; the executable copy is
--      migration_league_join_backfill.sql)
--
-- Apply:  supabase db query --linked -f supabase/migration_league_join_resolution.sql
-- ============================================================


-- ── 1. Table: timestamps, 'withdrawn', RLS ─────────────────────────────────
alter table public.league_join_requests add column if not exists denied_at    timestamptz;
alter table public.league_join_requests add column if not exists withdrawn_at timestamptz;
-- When the admins were last notified about this pair. The after-trigger
-- notifies only when the before-trigger moved it (the 1-hour anti-spam
-- window survives the notices themselves being deleted on withdraw).
alter table public.league_join_requests add column if not exists notified_at  timestamptz;

alter table public.league_join_requests drop constraint if exists league_join_requests_status_check;
alter table public.league_join_requests add constraint league_join_requests_status_check
  check (status in ('pending', 'denied', 'withdrawn'));

-- A user may only file a PENDING request for themselves (old app builds
-- still upsert directly; new ones call request_league_join).
drop policy if exists "Users can insert own requests" on public.league_join_requests;
create policy "Users can insert own requests" on public.league_join_requests
  for insert with check (auth.uid() = user_id and status = 'pending');

-- Withdraw is withdraw_league_join_request(); no app build deletes directly.
-- Deleting a denied / withdrawn row would reset the cooldown and the
-- anti-spam window, so users can no longer delete their rows.
drop policy if exists "Users can delete own pending requests" on public.league_join_requests;


-- ── 2. Internal helpers ────────────────────────────────────────────────────
-- How long a denial blocks a new request. Shared by the deny notice and
-- request_league_join so the date the requester is told is the date it opens.
create or replace function public._league_join_deny_cooldown()
returns interval language sql immutable as $$ select interval '7 days' $$;
revoke execute on function public._league_join_deny_cooldown() from public, anon, authenticated;

-- How often a request / withdraw / request loop may notify the admins.
create or replace function public._league_join_renotify_window()
returns interval language sql immutable as $$ select interval '1 hour' $$;
revoke execute on function public._league_join_renotify_window() from public, anon, authenticated;

-- Delete every admin's league_join_request notice for this league + requester.
-- push_outbox rows go with them (ON DELETE CASCADE).
create or replace function public._clear_league_join_notices(p_league_id uuid, p_requester_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.notifications n
   where n.entity_type = 'league'
     and n.entity_id = p_league_id
     and n.push_data ->> 'kind' = 'league_join_request'
     and n.push_data ->> 'requester_id' = p_requester_id::text;
$$;
revoke execute on function public._clear_league_join_notices(uuid, uuid) from public, anon, authenticated;

-- The "✅ You're in <league>" notice (approve, league turned open).
create or replace function public._notify_league_join_admitted(p_league_id uuid, p_user_id uuid, p_body text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_league text;
begin
  select name into v_league from public.leagues where id = p_league_id;
  if v_league is null then return; end if;
  insert into public.notifications (user_id, title, body, type, entity_id, entity_type, category, push_data)
  values (
    p_user_id,
    '✅ You''re in ' || v_league,
    replace(p_body, '%league%', v_league),
    'league', p_league_id, 'league', 'notifyLeagueUpdates',
    jsonb_build_object('kind', 'league_join_approved')
  );
exception when others then
  -- A notice problem must never undo the membership.
  raise warning '_notify_league_join_admitted failed: %', sqlerrm;
end $$;
revoke execute on function public._notify_league_join_admitted(uuid, uuid, text) from public, anon, authenticated;


-- ── 3a. Before insert / status change: guard + stamps ──────────────────────
create or replace function public._league_join_request_before()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_to_pending boolean := false;
begin
  -- OLD is only read on UPDATE (nested ifs: SQL boolean ops don't short-circuit).
  if new.status = 'pending' then
    if tg_op = 'INSERT' then
      v_to_pending := true;
    elsif old.status is distinct from 'pending' then
      v_to_pending := true;
    end if;
  end if;

  if v_to_pending then
    -- D8: members can't request; an open league is joined, not requested.
    if exists (select 1 from public.league_members
                where league_id = new.league_id and user_id = new.user_id) then
      raise exception 'You''re already a member of this league.';
    end if;
    if exists (select 1 from public.leagues where id = new.league_id and is_open) then
      raise exception 'This league is open. Tap Join instead.';
    end if;

    -- Notify the admins now unless they were notified about this pair
    -- within the window (withdraw then request again).
    -- A denied row coming back (request_league_join already enforced the
    -- 7-day wait) always notifies: the anti-spam window is for withdraw ->
    -- request again, not for a fresh ask after a decline. clock_timestamp(),
    -- not now(): the notify trigger fires only when notified_at moves, and
    -- now() is frozen for the whole transaction.
    if tg_op = 'INSERT' then
      new.notified_at := clock_timestamp();
    elsif old.status = 'denied'
       or old.notified_at is null
       or old.notified_at <= now() - public._league_join_renotify_window() then
      new.notified_at := clock_timestamp();
    else
      new.notified_at := old.notified_at;
    end if;
  elsif tg_op = 'UPDATE' then
    new.notified_at := old.notified_at;
  end if;

  if tg_op = 'INSERT' then
    -- Direct inserts (old builds) can't preset the stamps.
    new.denied_at := null;
    new.withdrawn_at := null;
  elsif new.status is distinct from old.status then
    if new.status = 'denied'    then new.denied_at    := now(); end if;
    if new.status = 'withdrawn' then new.withdrawn_at := now(); end if;
  end if;
  return new;
end $$;
revoke execute on function public._league_join_request_before() from public, anon, authenticated;

drop trigger if exists trg_league_join_request_before on public.league_join_requests;
create trigger trg_league_join_request_before
  before insert or update of status on public.league_join_requests
  for each row execute function public._league_join_request_before();


-- ── 3b. Notify the admins (re-gated by notified_at) ────────────────────────
-- Same body as migration_league_join_request_push.sql, plus: an UPDATE back
-- to pending notifies only when the before-trigger moved notified_at.
create or replace function public.notify_league_join_request()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league text;
  v_name   text;
  r        record;
begin
  if new.status is distinct from 'pending' then return new; end if;
  if tg_op = 'UPDATE' then
    if old.status is not distinct from 'pending' then return new; end if;
    if new.notified_at is not distinct from old.notified_at then return new; end if;
  end if;

  select name into v_league from public.leagues where id = new.league_id;
  if v_league is null then return new; end if;
  select full_name into v_name from public.profiles where id = new.user_id;

  for r in
    select lm.user_id
      from public.league_members lm
     where lm.league_id = new.league_id
       and lm.role in ('admin', 'co-admin')
       and lm.user_id <> new.user_id
       and not exists (
         select 1 from public.notifications n
          where n.user_id = lm.user_id
            and n.entity_type = 'league'
            and n.entity_id = new.league_id
            and n.push_data ->> 'kind' = 'league_join_request'
            and n.push_data ->> 'requester_id' = new.user_id::text
            and n.created_at > now() - interval '1 hour'
       )
  loop
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, category, push_data)
    values (
      r.user_id,
      '🙋 Join request: ' || v_league,
      coalesce(v_name, 'A player') || ' asked to join. Tap to review requests.',
      'league', new.league_id, 'league', 'notifyLeagueUpdates',
      jsonb_build_object(
        'kind', 'league_join_request',
        'requester_id', new.user_id
      )
    );
  end loop;
  return new;
exception when others then
  -- A notification problem must never block the request itself.
  return new;
end $$;
revoke all on function public.notify_league_join_request() from public, anon, authenticated;

drop trigger if exists trg_notify_league_join_request on public.league_join_requests;
create trigger trg_notify_league_join_request
  after insert or update of status on public.league_join_requests
  for each row execute function public.notify_league_join_request();


-- ── 3c. A request left pending: clear the admins' notices; tell a denied
--        requester ─────────────────────────────────────────────────────────
create or replace function public._league_join_request_resolved()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league text;
begin
  if tg_op = 'DELETE' then
    if old.status = 'pending' then
      perform public._clear_league_join_notices(old.league_id, old.user_id);
    end if;
    return old;
  end if;

  if old.status = 'pending' and new.status is distinct from 'pending' then
    perform public._clear_league_join_notices(old.league_id, old.user_id);
  end if;

  -- Denied (deny_league_join_request, or an old build's direct update): ONE
  -- notice to the requester, replacing any earlier one for this league.
  if new.status = 'denied' and old.status is distinct from 'denied' then
    begin
      select name into v_league from public.leagues where id = new.league_id;
      if v_league is not null then
        delete from public.notifications
         where user_id = new.user_id and entity_type = 'league' and entity_id = new.league_id
           and push_data ->> 'kind' = 'league_join_denied';
        insert into public.notifications (user_id, title, body, type, entity_id, entity_type, category, push_data)
        values (
          new.user_id,
          'Your request to join ' || v_league || ' wasn''t approved',
          'You can ask again after '
            || to_char(coalesce(new.denied_at, now()) + public._league_join_deny_cooldown(), 'FMMonth FMDD') || '.',
          'league', new.league_id, 'league', 'notifyLeagueUpdates',
          jsonb_build_object('kind', 'league_join_denied')
        );
      end if;
    exception when others then
      raise warning '_league_join_request_resolved: deny notice failed: %', sqlerrm;
    end;
  end if;
  return new;
end $$;
revoke execute on function public._league_join_request_resolved() from public, anon, authenticated;

drop trigger if exists trg_league_join_request_resolved on public.league_join_requests;
create trigger trg_league_join_request_resolved
  after delete or update of status on public.league_join_requests
  for each row execute function public._league_join_request_resolved();


-- ── 3d. Someone joined (any path): their request and invite notices go ─────
create or replace function public._league_member_joined()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Fires 3c for a pending row, which clears the admins' notices. Removing
  -- the member later leaves nothing behind to resurrect (D2).
  delete from public.league_join_requests
   where league_id = new.league_id and user_id = new.user_id;

  -- The joiner's own invite / denial notices for this league (D4). Invites
  -- written before push_data existed are matched by their title.
  delete from public.notifications n
   where n.user_id = new.user_id
     and n.entity_type = 'league'
     and n.entity_id = new.league_id
     and (
       n.push_data ->> 'kind' in ('league_invite', 'league_join_denied')
       or (coalesce(n.push_data ->> 'kind', '') = '' and n.title like '🎟️ Invite:%')
     );
  return new;
end $$;
revoke execute on function public._league_member_joined() from public, anon, authenticated;

drop trigger if exists trg_league_member_joined on public.league_members;
create trigger trg_league_member_joined
  after insert on public.league_members
  for each row execute function public._league_member_joined();


-- ── 3e. A private league turned open: admit every pending requester ────────
create or replace function public._league_opened_admit_requesters()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_users uuid[];
  v_user  uuid;
  v_n     integer;
begin
  if not (old.is_open is false and new.is_open is true) then return new; end if;

  select coalesce(array_agg(user_id), '{}') into v_users
    from public.league_join_requests
   where league_id = new.id and status = 'pending';

  foreach v_user in array v_users loop
    insert into public.league_members (league_id, user_id, role)
    values (new.id, v_user, 'member')
    on conflict (league_id, user_id) do nothing;
    get diagnostics v_n = row_count;
    if v_n > 0 then
      perform public._notify_league_join_admitted(new.id, v_user, '%league% is now open, so you''re in.');
    end if;
  end loop;
  return new;
end $$;
revoke execute on function public._league_opened_admit_requesters() from public, anon, authenticated;

drop trigger if exists trg_league_opened_admit_requesters on public.leagues;
create trigger trg_league_opened_admit_requesters
  after update of is_open on public.leagues
  for each row execute function public._league_opened_admit_requesters();


-- ── 4. redeem_invite_code: membership first ────────────────────────────────
-- From migration_unified_invite_codes.sql (its latest definition). One change:
-- "already a member" (league) / "already registered" (tournament) is checked
-- BEFORE revoked / expired / max uses, so a member tapping an old or used-up
-- code gets success + the already-member message, not an error (D4). The
-- original checks further down are kept as they were.
create or replace function public.redeem_invite_code(p_token text)
returns table (
  success      boolean,
  scope_type   text,
  scope_id     uuid,
  scope_name   text,
  subsidy      integer,
  message      text
) language plpgsql security definer as $$
declare
  v_uid         uuid := auth.uid();
  v_code        public.invite_codes%rowtype;
  v_scope_name  text;
  v_ante        integer;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  select * into v_code from public.invite_codes
   where upper(token) = upper(regexp_replace(p_token, '-', '', 'g'));
  if v_code.id is null then
    return query select false, ''::text, null::uuid, ''::text, 0, 'Invalid invite code.'::text;
    return;
  end if;

  -- Already in: success, whatever state the code is in.
  if v_code.scope_type = 'league' then
    select name into v_scope_name from public.leagues where id = v_code.scope_id;
    if v_scope_name is not null and exists (
      select 1 from public.league_members where league_id = v_code.scope_id and user_id = v_uid
    ) then
      return query select true, v_code.scope_type, v_code.scope_id, v_scope_name, 0,
                          format('You''re already a member of %s.', v_scope_name)::text;
      return;
    end if;
  elsif v_code.scope_type = 'tournament' then
    select name into v_scope_name from public.tournaments where id = v_code.scope_id;
    if v_scope_name is not null and exists (
      select 1 from public.tournament_registrations
       where tournament_id = v_code.scope_id and user_id = v_uid
    ) then
      return query select true, v_code.scope_type, v_code.scope_id, v_scope_name, 0,
                          format('You''re already registered for %s.', v_scope_name)::text;
      return;
    end if;
  end if;
  v_scope_name := null;

  if not v_code.is_active then
    return query select false, v_code.scope_type, v_code.scope_id, ''::text, 0, 'This code has been revoked.'::text;
    return;
  end if;
  if v_code.expires_at <= now() then
    return query select false, v_code.scope_type, v_code.scope_id, ''::text, 0, 'This code has expired.'::text;
    return;
  end if;
  if v_code.max_uses is not null and v_code.used_count >= v_code.max_uses then
    return query select false, v_code.scope_type, v_code.scope_id, ''::text, 0, 'This code has reached its max uses.'::text;
    return;
  end if;

  if v_code.scope_type = 'league' then
    select name into v_scope_name from public.leagues where id = v_code.scope_id;
    if v_scope_name is null then
      return query select false, v_code.scope_type, v_code.scope_id, ''::text, 0, 'League no longer exists.'::text;
      return;
    end if;
    if exists (select 1 from public.league_members where league_id = v_code.scope_id and user_id = v_uid) then
      return query select true, v_code.scope_type, v_code.scope_id, v_scope_name, 0,
                          format('You''re already a member of %s.', v_scope_name)::text;
      return;
    end if;
    insert into public.league_members (league_id, user_id, role)
      values (v_code.scope_id, v_uid, 'member')
      on conflict do nothing;
    update public.invite_codes set used_count = used_count + 1 where id = v_code.id;
    return query select true, v_code.scope_type, v_code.scope_id, v_scope_name, 0,
                       format('Joined %s!', v_scope_name)::text;
    return;
  end if;

  if v_code.scope_type = 'tournament' then
    select name, pickle_ante into v_scope_name, v_ante
      from public.tournaments where id = v_code.scope_id;
    if v_scope_name is null then
      return query select false, v_code.scope_type, v_code.scope_id, ''::text, 0, 'Tournament no longer exists.'::text;
      return;
    end if;
    if exists (
      select 1 from public.tournament_registrations
       where tournament_id = v_code.scope_id and user_id = v_uid
    ) then
      return query select true, v_code.scope_type, v_code.scope_id, v_scope_name, 0,
                          format('You''re already registered for %s.', v_scope_name)::text;
      return;
    end if;

    -- Insert as approved → fires reworked _charge_tournament_ante which
    -- reads redeemed_invite_code_id and applies the subsidy split.
    insert into public.tournament_registrations
      (tournament_id, user_id, status, invited_by, redeemed_invite_code_id)
    values
      (v_code.scope_id, v_uid, 'approved', v_code.created_by, v_code.id);

    update public.invite_codes set used_count = used_count + 1 where id = v_code.id;

    return query select true, v_code.scope_type, v_code.scope_id, v_scope_name, v_code.pickle_subsidy,
                       case when v_code.pickle_subsidy > 0 and coalesce(v_ante, 0) > 0
                         then format('Joined %s — saved %s 🥒 thanks to the code!', v_scope_name, v_code.pickle_subsidy)
                         else format('Joined %s!', v_scope_name)
                       end::text;
    return;
  end if;

  return query select false, v_code.scope_type, v_code.scope_id, ''::text, 0, 'Unknown scope type.'::text;
end;
$$;
grant execute on function public.redeem_invite_code(text) to authenticated;


-- ── 5. send_invite_code_to_users: one live invite per league per person ────
-- From migration_push_actions_match_tournament.sql (its latest definition).
-- One change: before a league invite notice is inserted, the recipient's
-- earlier league_invite notice(s) for that league are deleted (D5: a second
-- broadcast no longer stacks a duplicate notice + push).
create or replace function public.send_invite_code_to_users(p_code_id uuid, p_user_ids uuid[])
returns table(success boolean, sent integer, skipped integer, message text)
language plpgsql
security definer
as $function$
declare
  v_uid          uuid := auth.uid();
  v_code         public.invite_codes%rowtype;
  v_inviter      text;
  v_scope_name   text;
  v_scope_label  text;   -- "league" / "tournament"
  v_sent         integer := 0;
  v_skipped      integer := 0;
  v_user_id      uuid;
  v_existing     text;
  v_fee          integer := 0;
  v_fee_text     text := '';
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if p_user_ids is null or array_length(p_user_ids, 1) is null then
    return query select false, 0, 0, 'Pick at least one player'::text; return;
  end if;

  select * into v_code from public.invite_codes where id = p_code_id;
  if v_code.id is null then
    return query select false, 0, 0, 'Code not found'::text; return;
  end if;
  if not v_code.is_active then
    return query select false, 0, 0, 'This code has been revoked'::text; return;
  end if;
  if v_code.expires_at <= now() then
    return query select false, 0, 0, 'This code has expired'::text; return;
  end if;
  if not public.is_scope_admin(v_code.scope_type, v_code.scope_id) then
    return query select false, 0, 0, 'Only scope admins can broadcast invites'::text; return;
  end if;

  v_scope_label := v_code.scope_type;
  if v_code.scope_type = 'league' then
    select name into v_scope_name from public.leagues where id = v_code.scope_id;
  elsif v_code.scope_type = 'tournament' then
    select name, greatest(coalesce(pickle_ante, 0) - least(coalesce(v_code.pickle_subsidy, 0), coalesce(pickle_ante, 0)), 0)
      into v_scope_name, v_fee
      from public.tournaments where id = v_code.scope_id;
    if v_fee > 0 then
      v_fee_text := format(' Entry fee: %s 🥒, charged when you accept.', v_fee);
    end if;
  end if;
  if v_scope_name is null then
    return query select false, 0, 0, 'Scope not found'::text; return;
  end if;

  select full_name into v_inviter from public.profiles where id = v_uid;

  foreach v_user_id in array p_user_ids loop
    begin
      if v_user_id is null or v_user_id = v_uid then
        v_skipped := v_skipped + 1; continue;
      end if;
      if not exists (select 1 from public.profiles where id = v_user_id) then
        v_skipped := v_skipped + 1; continue;
      end if;

      if v_code.scope_type = 'league' then
        if exists (
          select 1 from public.league_members
          where league_id = v_code.scope_id and user_id = v_user_id
        ) then
          v_skipped := v_skipped + 1; continue;
        end if;
        -- One live invite per league per person: the new one replaces any
        -- earlier one (its push_outbox row goes too, ON DELETE CASCADE).
        delete from public.notifications n
         where n.user_id = v_user_id
           and n.entity_type = 'league'
           and n.entity_id = v_code.scope_id
           and (
             n.push_data ->> 'kind' = 'league_invite'
             or (coalesce(n.push_data ->> 'kind', '') = '' and n.title like '🎟️ Invite:%')
           );
      elsif v_code.scope_type = 'tournament' then
        select status into v_existing
          from public.tournament_registrations
          where tournament_id = v_code.scope_id and user_id = v_user_id;
        if v_existing = 'approved' then
          v_skipped := v_skipped + 1; continue;
        end if;

        if v_existing is null then
          insert into public.tournament_registrations
            (tournament_id, user_id, status, invited_by, redeemed_invite_code_id)
          values
            (v_code.scope_id, v_user_id, 'pending', v_uid, v_code.id);
        else
          update public.tournament_registrations
             set status                  = 'pending',
                 invited_by              = v_uid,
                 redeemed_invite_code_id = v_code.id
           where tournament_id = v_code.scope_id and user_id = v_user_id;
        end if;
      end if;

      -- Body keeps the human-readable token (and the in-app list still reads
      -- it from there). A league code also rides in push_data, so the push's
      -- Join button and tap can redeem it.
      insert into public.notifications (user_id, title, body, type, entity_id, entity_type, push_data)
      values (
        v_user_id,
        format('🎟️ Invite: %s', v_scope_name),
        -- A tap on a league invite joins on 1.0.4 (lib/push.ts, the same
        -- auto-join as the in-app list), so the body says so.
        format(
          case when v_code.scope_type = 'league'
            then '%s invited you to the %s "%s".%s Tap to join, or use invite code %s.'
            else '%s invited you to the %s "%s".%s Tap to open it, or use invite code %s to join.'
          end,
          coalesce(v_inviter, 'An admin'),
          v_scope_label,
          v_scope_name,
          v_fee_text,
          v_code.token
        ),
        v_scope_label,
        v_code.scope_id,
        v_scope_label,
        case when v_code.scope_type = 'league'
          then jsonb_build_object('kind', 'league_invite', 'invite_code', v_code.token)
          else jsonb_build_object('kind', 'tournament_invite')
        end
      );

      v_sent := v_sent + 1;
    exception when others then
      v_skipped := v_skipped + 1;
    end;
  end loop;

  return query select true, v_sent, v_skipped,
    case when v_sent = 0 then 'No invites sent — everyone you picked is already in.'
         else format('Sent %s invite%s%s.',
              v_sent,
              case when v_sent = 1 then '' else 's' end,
              case when v_skipped > 0 then format(' (%s skipped)', v_skipped) else '' end)
    end::text;
end;
$function$;
grant execute on function public.send_invite_code_to_users(uuid, uuid[]) to authenticated;


-- ── 6. Client RPCs ─────────────────────────────────────────────────────────

-- Ask to join. Returns one of:
--   'member'          already in (nothing changes)
--   'joined'          the league is open: joined now, no request filed
--   'pending'         a request is already with the admins (no new notice)
--   'denied:<iso>'    denied within the cooldown; <iso> (UTC) is when the
--                     requester may ask again
--   'sent'            a new request, or a withdrawn / cooled-down denied one
--                     back to pending (admins notified per 3a's window)
create or replace function public.request_league_join(p_league_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_open    boolean;
  v_req     public.league_join_requests%rowtype;
  v_until   timestamptz;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  select is_open into v_open from public.leagues where id = p_league_id;
  if not found then raise exception 'That league no longer exists.'; end if;

  if exists (select 1 from public.league_members where league_id = p_league_id and user_id = v_uid) then
    return 'member';
  end if;

  if v_open then
    insert into public.league_members (league_id, user_id, role)
    values (p_league_id, v_uid, 'member')
    on conflict (league_id, user_id) do nothing;
    return 'joined';
  end if;

  select * into v_req from public.league_join_requests
   where league_id = p_league_id and user_id = v_uid
   for update;

  if v_req.id is null then
    insert into public.league_join_requests (league_id, user_id, status)
    values (p_league_id, v_uid, 'pending')
    on conflict (league_id, user_id) do nothing;
    return 'sent';
  end if;

  if v_req.status = 'pending' then
    return 'pending';
  end if;

  if v_req.status = 'denied' then
    -- Rows denied before denied_at existed count from created_at.
    v_until := coalesce(v_req.denied_at, v_req.created_at, now()) + public._league_join_deny_cooldown();
    if v_until > now() then
      return 'denied:' || to_char(v_until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
    end if;
    -- Cooldown over: the old denial notice goes; the request is new again.
    delete from public.notifications
     where user_id = v_uid and entity_type = 'league' and entity_id = p_league_id
       and push_data ->> 'kind' = 'league_join_denied';
  end if;

  -- denied (cooled down) or withdrawn -> pending. 3a decides whether the
  -- admins hear about it again.
  update public.league_join_requests set status = 'pending' where id = v_req.id;
  return 'sent';
end $$;
revoke execute on function public.request_league_join(uuid) from public, anon;
grant execute on function public.request_league_join(uuid) to authenticated;

-- Take back my pending request. 'withdrawn', or 'none' if nothing was pending.
-- The row stays (status 'withdrawn') so the anti-spam window survives.
create or replace function public.withdraw_league_join_request(p_league_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  update public.league_join_requests
     set status = 'withdrawn'
   where league_id = p_league_id and user_id = v_uid and status = 'pending';
  return case when found then 'withdrawn' else 'none' end;
end $$;
revoke execute on function public.withdraw_league_join_request(uuid) from public, anon;
grant execute on function public.withdraw_league_join_request(uuid) to authenticated;

-- One-tap Approve (admins / co-admins). 'approved', or 'member' when the
-- requester had already joined (the stale row is cleaned up).
create or replace function public.approve_league_join_request(p_request_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_req public.league_join_requests%rowtype;
  v_n   integer;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  select * into v_req from public.league_join_requests where id = p_request_id for update;
  if v_req.id is null then raise exception 'That request is no longer open.'; end if;
  if not exists (select 1 from public.league_members
                  where league_id = v_req.league_id and user_id = v_uid and role in ('admin', 'co-admin')) then
    raise exception 'Only league admins can approve requests.';
  end if;
  if v_req.status <> 'pending' then raise exception 'That request is no longer open.'; end if;

  -- 3d deletes the request and (via 3c) every admin's notice for it.
  insert into public.league_members (league_id, user_id, role)
  values (v_req.league_id, v_req.user_id, 'member')
  on conflict (league_id, user_id) do nothing;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    delete from public.league_join_requests where id = v_req.id;
    return 'member';
  end if;

  perform public._notify_league_join_admitted(v_req.league_id, v_req.user_id, 'An admin approved your request.');
  return 'approved';
end $$;
revoke execute on function public.approve_league_join_request(uuid) from public, anon;
grant execute on function public.approve_league_join_request(uuid) to authenticated;

-- Deny (admins / co-admins). The status change does the rest: 3a stamps
-- denied_at, 3c clears the admins' notices and sends the requester ONE
-- "wasn't approved" notice with the date they may ask again.
create or replace function public.deny_league_join_request(p_request_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_req public.league_join_requests%rowtype;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  select * into v_req from public.league_join_requests where id = p_request_id for update;
  if v_req.id is null then raise exception 'That request is no longer open.'; end if;
  if not exists (select 1 from public.league_members
                  where league_id = v_req.league_id and user_id = v_uid and role in ('admin', 'co-admin')) then
    raise exception 'Only league admins can deny requests.';
  end if;
  if v_req.status <> 'pending' then raise exception 'That request is no longer open.'; end if;
  update public.league_join_requests set status = 'denied' where id = v_req.id;
  return 'denied';
end $$;
revoke execute on function public.deny_league_join_request(uuid) from public, anon;
grant execute on function public.deny_league_join_request(uuid) to authenticated;

notify pgrst, 'reload schema';


-- ############################################################################
-- ##                                                                        ##
-- ##   BACKFILL — DESTRUCTIVE, LEFT COMMENTED OUT ON PURPOSE.               ##
-- ##   Run the count query first (state/league-join-backfill-dryrun.sql),   ##
-- ##   review it with the owner, then apply the executable copy:            ##
-- ##     supabase/migration_league_join_backfill.sql (one transaction).     ##
-- ##                                                                        ##
-- ##   This DELETES rows from public.league_join_requests and               ##
-- ##   public.notifications (and, by ON DELETE CASCADE, their               ##
-- ##   public.push_outbox rows). There is no undo short of a backup.        ##
-- ##                                                                        ##
-- ############################################################################
--
-- Read-only counts:
--
-- select
--   (select count(*) from public.league_join_requests r
--     where exists (select 1 from public.league_members m
--                    where m.league_id = r.league_id and m.user_id = r.user_id))
--     as requests_from_members,
--   (select count(*) from public.notifications n
--     where n.entity_type = 'league' and n.push_data ->> 'kind' = 'league_join_request'
--       and not exists (select 1 from public.league_join_requests r
--                        where r.league_id = n.entity_id and r.status = 'pending'
--                          and r.user_id::text = n.push_data ->> 'requester_id'))
--     as orphan_join_request_notices,
--   (select count(*) from public.notifications n
--     where n.entity_type = 'league'
--       and (n.push_data ->> 'kind' = 'league_invite'
--            or (coalesce(n.push_data ->> 'kind', '') = '' and n.title like '🎟️ Invite:%'))
--       and exists (select 1 from public.league_members m
--                    where m.league_id = n.entity_id and m.user_id = n.user_id))
--     as invites_to_members;
--
-- The deletes (needs this migration applied first: deleting a pending request
-- fires 3c, which clears its notices too):
--
-- begin;
-- delete from public.league_join_requests r
--  where exists (select 1 from public.league_members m
--                 where m.league_id = r.league_id and m.user_id = r.user_id);
-- delete from public.notifications n
--  where n.entity_type = 'league' and n.push_data ->> 'kind' = 'league_join_request'
--    and not exists (select 1 from public.league_join_requests r
--                     where r.league_id = n.entity_id and r.status = 'pending'
--                       and r.user_id::text = n.push_data ->> 'requester_id');
-- delete from public.notifications n
--  where n.entity_type = 'league'
--    and (n.push_data ->> 'kind' = 'league_invite'
--         or (coalesce(n.push_data ->> 'kind', '') = '' and n.title like '🎟️ Invite:%'))
--    and exists (select 1 from public.league_members m
--                 where m.league_id = n.entity_id and m.user_id = n.user_id);
-- commit;
