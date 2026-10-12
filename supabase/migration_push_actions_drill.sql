-- ============================================================
-- Drill pushes and their buttons (push actions, 2026-10-11 audit).
-- Needs migration_push_data.sql, migration_time_zones.sql and
-- migration_drill_start_time_fix.sql first. Idempotent.
--
--   Drill request    the proposed times are listed in the body, numbered by
--                    time. 1 time: Accept / Decline. 2 times: 1st time /
--                    2nd time / Decline. 3 times: 1st / 2nd / 3rd time.
--                    4+: Decline (pick in the app). The picks go through the
--                    new accept_drill_slot RPC (refuses past times; replays
--                    say 'already').
--   Accepted         the requester gets Open chat (opens), with the time in
--   / declined       the body / Find another partner (opens).
--   Drill chat       Reply from the lock screen; the tap opens the thread
--                    (push_data.kind = 'drill_chat', which also tells it from
--                    the request push on the same entity; the link stays
--                    drill/<id>, so 1.0.3 phones keep their old landing).
--                    Lock-screen replies are idempotent through client_key.
--   Partner RSVP     "can't make it" offers Find a new time (opens, partner
--                    prefilled) instead of On my way; copy no longer points
--                    at a reschedule flow that doesn't exist.
--   Reminders        tagged, so send-push can tell them from RSVP notices.
--
-- Each trigger/RPC below is the production definition (2026-10-12) plus
-- these changes.
--
-- Apply:  supabase db query --linked -f supabase/migration_push_actions_drill.sql
-- ============================================================

-- ── Lock-screen replies land once ───────────────────────────────────────────
alter table public.drill_request_messages add column if not exists client_key text;
create unique index if not exists drill_request_messages_client_key_idx
  on public.drill_request_messages (client_key) where client_key is not null;

-- ── accept_drill_slot: accept one proposed time from the lock screen ────────
-- p_slot_index is 0-based in TIME order (date, then slot), the order the push
-- body numbers them in. p_slot is the slot the push showed; if the request's
-- times changed since, it refuses rather than accept a time the player never
-- saw. Replays: the same time already accepted returns 'already'.
create or replace function public.accept_drill_slot(p_request uuid, p_slot_index integer, p_slot jsonb default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_req  public.drill_requests%rowtype;
  v_pick jsonb;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  select * into v_req from public.drill_requests where id = p_request for update;
  if v_req.id is null then raise exception 'Request not found'; end if;
  if v_req.to_user_id <> v_uid then raise exception 'Only the invited player can respond'; end if;
  if public.blocked_between(v_req.from_user_id, v_req.to_user_id) then raise exception 'Request not found'; end if;

  if p_slot_index is null or p_slot_index < 0 then raise exception 'Pick a time in the app'; end if;
  select e.value into v_pick
    from jsonb_array_elements(coalesce(v_req.proposed_slots, '[]'::jsonb)) with ordinality as e(value, ord)
   where jsonb_typeof(e.value) = 'object' and e.value ? 'date' and e.value ? 'slot'
   order by e.value ->> 'date', (e.value ->> 'slot')::int, e.ord
  offset p_slot_index
   limit 1;
  if v_pick is null then raise exception 'Pick a time in the app'; end if;

  if p_slot is not null
     and (v_pick ->> 'date' is distinct from p_slot ->> 'date'
          or (v_pick ->> 'slot')::int is distinct from (p_slot ->> 'slot')::int) then
    raise exception 'The proposed times changed. Pick a time in the app';
  end if;

  if v_req.status = 'accepted' then
    if v_req.accepted_slot ->> 'date' = v_pick ->> 'date'
       and (v_req.accepted_slot ->> 'slot')::int = (v_pick ->> 'slot')::int then
      return 'already';
    end if;
    raise exception 'Already accepted for another time';
  end if;
  if v_req.status <> 'pending' then raise exception 'Request is no longer pending'; end if;

  if public._drill_slot_starts_at((v_pick ->> 'date')::date, (v_pick ->> 'slot')::int,
                                  public._pickleague_tz_for(v_req.from_user_id)) <= now() then
    raise exception 'That time has passed. Pick another time in the app';
  end if;

  -- The UPDATE fires create_drill_session_on_accept and notify_on_drill_response.
  update public.drill_requests
     set status = 'accepted', responded_at = now(), accepted_slot = v_pick
   where id = p_request;
  return 'accepted';
end $$;
revoke execute on function public.accept_drill_slot(uuid, integer, jsonb) from public, anon;
grant execute on function public.accept_drill_slot(uuid, integer, jsonb) to authenticated;

-- ── New drill request: the times in the body ────────────────────────────────
create or replace function public.notify_on_drill_request()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_sender_name text;
  v_n           integer;
  v_list        text;
  v_first       text;
  v_body        text;
  v_msg         text := nullif(trim(coalesce(new.message, '')), '');
begin
  select full_name into v_sender_name from public.profiles where id = new.from_user_id;

  -- Numbered by time: the same order as the buttons (send-push) and as
  -- accept_drill_slot's index.
  select count(*),
         string_agg(s.n::text || ') ' || s.label, E'\n' order by s.n),
         min(s.label) filter (where s.n = 1)
    into v_n, v_list, v_first
    from (
      select row_number() over (order by e.value ->> 'date', (e.value ->> 'slot')::int, e.ord) as n,
             public._drill_slot_label((e.value ->> 'date')::date, (e.value ->> 'slot')::int) as label
        from jsonb_array_elements(coalesce(new.proposed_slots, '[]'::jsonb)) with ordinality as e(value, ord)
       where jsonb_typeof(e.value) = 'object' and e.value ? 'date' and e.value ? 'slot'
    ) s;

  v_body := case
    when coalesce(v_n, 0) = 0 then 'Open Pickleague to see the proposed times.'
    when v_n = 1 then v_first
    when v_n <= 3 then 'Which time works?' || E'\n' || v_list
    else 'Pick a time in the app:' || E'\n' || v_list
  end;
  if v_msg is not null then
    v_body := v_body || E'\n' || '"' || left(v_msg, 80) || '"';
  end if;

  insert into public.notifications (user_id, title, body, type, entity_id, entity_type, is_read, push_data)
  values (
    new.to_user_id,
    '🥒 ' || coalesce(v_sender_name, 'Someone') || ' wants to drill',
    v_body,
    'drill',
    new.id,
    'drill',
    false,
    jsonb_build_object('kind', 'drill_request')
  );
  return new;
end;
$function$;

-- ── Accepted / declined, to the requester ───────────────────────────────────
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
begin
  if old.status = 'pending' and new.status in ('accepted','declined') then
    select full_name into v_responder_name from public.profiles where id = new.to_user_id;
    if new.status = 'accepted' then
      v_when := public._drill_slot_label((new.accepted_slot ->> 'date')::date, (new.accepted_slot ->> 'slot')::int);
      v_title := '✅ ' || coalesce(v_responder_name, 'Your drill partner') || ' accepted!';
      v_body  := case when v_when is not null
                   then 'Drill session is on: ' || v_when || '. Open the chat to pick where to play.'
                   else 'Drill session is on. Tap to see the time.' end;
    else
      v_title := coalesce(v_responder_name, 'Your drill partner') || ' declined';
      v_body  := 'Maybe try another time or partner?';
    end if;
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, is_read, push_data)
    values (new.from_user_id, v_title, v_body, 'drill', new.id, 'drill', false,
            jsonb_build_object('kind', 'drill_response'));
  end if;
  return new;
end;
$function$;

-- ── Drill chat ──────────────────────────────────────────────────────────────
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

-- ── On my way / Can't make it, to the partner ───────────────────────────────
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
    case p_status when 'on_my_way' then '🥒 ' || coalesce(v_name, 'Your partner') || ' is on the way'
                  else '🥒 ' || coalesce(v_name, 'Your partner') || ' can''t make it' end,
    case p_status when 'on_my_way' then 'Your drill session is still on.'
                  else 'They can''t make your drill session. Find a new time with them.' end,
    'drill', p_session, 'drill',
    jsonb_build_object('kind', 'drill_rsvp', 'rsvp_status', p_status)
  );
  return p_status;
end $function$;

-- ── 24 h / 2 h reminders ────────────────────────────────────────────────────
create or replace function public.remind_drill_sessions()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare r record;
begin
  for r in
    with windows as (
      select * from (values
        ('drill_session_24h', interval '2 hours', interval '24 hours'),
        ('drill_session_2h',  interval '0 hours', interval '2 hours')
      ) as w(kind, lo, hi)
    ),
    due as (
      select w.kind, ds.id, u.user_id
      from public.drill_sessions ds
      cross join lateral (values (ds.player1_id), (ds.player2_id)) as u(user_id)
      cross join windows w
      where ds.starts_at is not null
        and ds.starts_at >  now() + w.lo
        and ds.starts_at <= now() + w.hi
    ),
    fresh as (
      insert into public.reminder_log (kind, entity_id, user_id)
      select kind, id, user_id from due
      on conflict do nothing
      returning kind, entity_id, user_id
    )
    select
      entity_id,
      user_id,
      case kind when 'drill_session_2h' then 'in about 2 hours'
                else 'in the next 24 hours' end as label
    from fresh
  loop
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, category, push_data)
    values (
      r.user_id,
      '🥒 Drill session coming up',
      'You have a drill session ' || r.label || '. Tap to view details.',
      'drill', r.entity_id, 'drill', null,
      jsonb_build_object('kind', 'drill_session_reminder')
    );
  end loop;
exception when others then null;
end $function$;
