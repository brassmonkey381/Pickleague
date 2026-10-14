-- ============================================================
-- Drill "lock-in" + "Confirm" (2026-10-14). Needs migration_time_zones.sql,
-- migration_drill_start_time_fix.sql, migration_push_actions_drill.sql and
-- migration_push_actions_drill_tournament.sql first. Idempotent.
--
-- "On my way" is now "Confirm" everywhere a person reads it. The stored RSVP
-- value stays 'on_my_way' and the lock-screen action id stays drill_on_my_way
-- (the drill_session_rsvps check constraint and installed 1.0.3/1.0.4 apps
-- depend on both); only the copy changes.
--
-- LOCK-IN = a drill request that has BOTH an accepted time (status
-- 'accepted', with its drill_sessions row) AND a court (location_name).
-- It happens two ways:
--
--   (i)  the time is accepted while a court is already set.
--        The requester gets ONE notice: notify_on_drill_response's
--        "✅ <Name> accepted!" now says "We're playing at <court>, <when>."
--        and is tagged kind 'drill_locked' on the SESSION, so send-push gives
--        it Confirm / Can't make it. The acceptor (auth.uid()) is recorded as
--        confirmed ('on_my_way') without a notice.
--   (ii) a court is set on an already-accepted request whose session hasn't
--        started. The OTHER player gets "📍 We're playing at <court>" /
--        "<when> · Tap Confirm to lock it in." (kind 'drill_locked', entity =
--        the session, so the same buttons). The court-setter is recorded as
--        confirmed without a notice.
--   change: a different court on a locked-in request is case (ii) again:
--        the partner is told the new place and their earlier 'on_my_way' is
--        cleared (they confirmed a different court); the setter's stays
--        confirmed. A 'cant_make_it' answer is left alone.
--
-- With no auth.uid() (service role, SQL editor) nobody is recorded as
-- confirmed and both players hear about it (in case i the requester's notice
-- is the accepted one, so only the invitee gets the 📍 notice).
--
-- The app's in-chat "📍 We're playing at: <court>" message still lands in the
-- thread but no longer pushes: the lock-in notice already said it, so each
-- player gets exactly one notification per lock-in.
--
-- <when> is the session start in the recipient's own zone
-- (_pickleague_local_label + _pickleague_tz_for), e.g. "Sat Oct 18, 9 AM".
--
-- Apply:  supabase db query --linked -f supabase/migration_drill_lock_in_confirm.sql
-- ============================================================

-- ── The session start, in a player's own zone ──────────────────────────────
create or replace function public._drill_session_when(p_session uuid, p_user uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    public._pickleague_local_label(ds.starts_at, public._pickleague_tz_for(p_user)),
    public._drill_slot_label(ds.session_date, ds.session_slot)
  )
  from public.drill_sessions ds
  where ds.id = p_session;
$$;
revoke execute on function public._drill_session_when(uuid, uuid) from public, anon, authenticated;

-- ── "📍 We're playing at <court>" to one player ─────────────────────────────
create or replace function public._drill_notify_locked(p_session uuid, p_user uuid, p_location text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_when text := public._drill_session_when(p_session, p_user);
begin
  if p_user is null then return; end if;
  insert into public.notifications (user_id, title, body, type, entity_id, entity_type, is_read, push_data)
  values (
    p_user,
    '📍 We''re playing at ' || p_location,
    coalesce(v_when || ' · ', '') || 'Tap Confirm to lock it in.',
    'drill', p_session, 'drill', false,
    -- On the session, untagged as an RSVP: send-push offers Confirm /
    -- Can't make it while the recipient hasn't answered.
    jsonb_build_object('kind', 'drill_locked')
  );
end $$;
revoke execute on function public._drill_notify_locked(uuid, uuid, text) from public, anon, authenticated;

-- ── Confirm / Can't make it, to the partner ─────────────────────────────────
-- Production definition (migration_push_actions_drill.sql, the newer of the
-- two; it added push_data) with the on_my_way copy changed to "confirmed".
create or replace function public.rsvp_drill_session(p_session uuid, p_status text)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid     uuid := auth.uid();
  v_ses     public.drill_sessions%rowtype;
  v_partner uuid;
  v_prev    text;
  v_name    text;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if p_status not in ('on_my_way', 'cant_make_it') then raise exception 'Bad status'; end if;

  select * into v_ses from public.drill_sessions where id = p_session;
  if v_ses.id is null then raise exception 'Session not found'; end if;
  if v_uid not in (v_ses.player1_id, v_ses.player2_id) then
    raise exception 'Only the two players can answer';
  end if;
  v_partner := case when v_uid = v_ses.player1_id then v_ses.player2_id else v_ses.player1_id end;

  select status into v_prev from public.drill_session_rsvps
   where session_id = p_session and user_id = v_uid;
  if v_prev = p_status then return 'already'; end if;  -- replay: no second notice

  insert into public.drill_session_rsvps (session_id, user_id, status, updated_at)
  values (p_session, v_uid, p_status, now())
  on conflict (session_id, user_id) do update set status = excluded.status, updated_at = now();

  -- Tell the partner, once per change of answer.
  select full_name into v_name from public.profiles where id = v_uid;
  insert into public.notifications (user_id, title, body, type, entity_id, entity_type, push_data)
  values (
    v_partner,
    case p_status when 'on_my_way' then '🥒 ' || coalesce(v_name, 'Your partner') || ' confirmed'
                  else '🥒 ' || coalesce(v_name, 'Your partner') || ' can''t make it' end,
    case p_status when 'on_my_way' then 'Your drill session is on.'
                  else 'They can''t make your drill session. Find a new time with them.' end,
    'drill', p_session, 'drill',
    jsonb_build_object('kind', 'drill_rsvp', 'rsvp_status', p_status)
  );
  return p_status;
end $function$;
revoke execute on function public.rsvp_drill_session(uuid, text) from public, anon;
grant execute on function public.rsvp_drill_session(uuid, text) to authenticated;

-- ── Accepted / declined, to the requester ───────────────────────────────────
-- Production definition (migration_push_actions_drill.sql) plus: when a court
-- is already set, this IS the lock-in notice (case i): it names the court and
-- sits on the session (kind drill_locked) so it carries Confirm buttons.
-- on_drill_request_accept runs before on_drill_response (same timing, name
-- order), so the session row exists here.
create or replace function public.notify_on_drill_response()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_responder_name text;
  v_title          text;
  v_body           text;
  v_when           text;
  v_session        uuid;
begin
  if old.status = 'pending' and new.status in ('accepted','declined') then
    select full_name into v_responder_name from public.profiles where id = new.to_user_id;
    if new.status = 'accepted' then
      v_when := public._drill_slot_label((new.accepted_slot ->> 'date')::date, (new.accepted_slot ->> 'slot')::int);
      v_title := '✅ ' || coalesce(v_responder_name, 'Your drill partner') || ' accepted!';
      if new.location_name is not null then
        select id into v_session from public.drill_sessions
         where request_id = new.id order by created_at desc limit 1;
        if v_session is not null then
          v_when := coalesce(public._drill_session_when(v_session, new.from_user_id), v_when);
        end if;
        v_body := 'We''re playing at ' || new.location_name
                  || case when v_when is not null then ', ' || v_when else '' end || '.';
      else
        v_body  := case when v_when is not null
                     then 'Drill session is on: ' || v_when || '. Open the chat to pick where to play.'
                     else 'Drill session is on. Tap to see the time.' end;
      end if;
    else
      v_title := coalesce(v_responder_name, 'Your drill partner') || ' declined';
      v_body  := 'Maybe try another time or partner?';
    end if;
    if v_session is not null then
      insert into public.notifications (user_id, title, body, type, entity_id, entity_type, is_read, push_data)
      values (new.from_user_id, v_title, v_body, 'drill', v_session, 'drill', false,
              jsonb_build_object('kind', 'drill_locked'));
    else
      insert into public.notifications (user_id, title, body, type, entity_id, entity_type, is_read, push_data)
      values (new.from_user_id, v_title, v_body, 'drill', new.id, 'drill', false,
              jsonb_build_object('kind', 'drill_response'));
    end if;
  end if;
  return new;
end;
$function$;

-- ── Lock-in: record the locker's Confirm, tell the other player ─────────────
create or replace function public.lock_in_drill_on_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_uid     uuid := auth.uid();
  v_locker  uuid;
  v_ses     public.drill_sessions%rowtype;
  v_accept  boolean;  -- case i: this update accepted the time
begin
  if new.status is distinct from 'accepted' or new.location_name is null then return new; end if;
  v_accept := old.status is distinct from 'accepted';
  if not v_accept and old.location_name is not distinct from new.location_name then
    return new;  -- already accepted, court unchanged: nothing locked in now
  end if;

  select * into v_ses from public.drill_sessions
   where request_id = new.id order by created_at desc limit 1;
  if v_ses.id is null then return new; end if;
  -- Case ii only for a session still ahead.
  if not v_accept and coalesce(v_ses.starts_at <= now(), v_ses.session_date < current_date) then
    return new;
  end if;

  v_locker := case when v_uid in (new.from_user_id, new.to_user_id) then v_uid end;

  begin
    -- A court CHANGE: the partner confirmed a different place; ask again.
    if not v_accept and old.location_name is not null then
      delete from public.drill_session_rsvps
       where session_id = v_ses.id
         and status = 'on_my_way'
         and (v_locker is null or user_id <> v_locker);
    end if;

    -- The locker is confirmed, silently (no rsvp_drill_session notice).
    if v_locker is not null then
      insert into public.drill_session_rsvps (session_id, user_id, status, updated_at)
      values (v_ses.id, v_locker, 'on_my_way', now())
      on conflict (session_id, user_id) do update set status = 'on_my_way', updated_at = now();
    end if;

    if v_accept then
      -- The requester already got notify_on_drill_response's lock-in notice.
      if v_locker is distinct from new.to_user_id then
        perform public._drill_notify_locked(v_ses.id, new.to_user_id, new.location_name);
      end if;
    else
      if v_locker is distinct from new.from_user_id then
        perform public._drill_notify_locked(v_ses.id, new.from_user_id, new.location_name);
      end if;
      if v_locker is distinct from new.to_user_id then
        perform public._drill_notify_locked(v_ses.id, new.to_user_id, new.location_name);
      end if;
    end if;
  exception when others then
    -- Saving the court/answer must never fail over a notice.
    raise warning 'lock_in_drill_on_update: %', sqlerrm;
  end;
  return new;
end;
$function$;
revoke execute on function public.lock_in_drill_on_update() from public, anon, authenticated;

-- "on_drill_session_lock_in" sorts after on_drill_request_accept (creates the
-- session) and on_drill_response (the requester's notice): AFTER UPDATE
-- triggers fire in name order.
drop trigger if exists on_drill_session_lock_in on public.drill_requests;
create trigger on_drill_session_lock_in
  after update on public.drill_requests
  for each row execute procedure public.lock_in_drill_on_update();

-- ── Drill chat ──────────────────────────────────────────────────────────────
-- Production definition (migration_push_actions_drill.sql) plus: the app's
-- "📍 We're playing at: <court>" message for the court just locked in stays
-- in the thread without a push (the lock-in notice already said it).
create or replace function public.notify_on_drill_chat()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_req        record;
  v_recipient  uuid;
  v_sender     text;
begin
  select * into v_req from public.drill_requests where id = new.request_id;
  if v_req.id is null then return new; end if;

  if v_req.status = 'accepted' and v_req.location_name is not null
     and new.body = '📍 We''re playing at: ' || v_req.location_name then
    return new;
  end if;

  v_recipient := case when new.sender_id = v_req.from_user_id then v_req.to_user_id else v_req.from_user_id end;
  select full_name into v_sender from public.profiles where id = new.sender_id;

  insert into public.notifications (user_id, title, body, type, entity_id, entity_type, is_read, push_data)
  values (
    v_recipient,
    '💬 ' || coalesce(v_sender, 'Someone') || ' replied',
    left(new.body, 120),
    'drill',
    new.request_id,
    'drill',
    false,
    -- kind = drill_chat: the 1.0.4 app opens the thread itself. The link stays
    -- drill/<request id>, so a 1.0.3 phone still opens the requests list.
    jsonb_build_object('kind', 'drill_chat')
  );
  return new;
exception when others then
  -- Notification failures shouldn't block the message itself.
  return new;
end;
$function$;
