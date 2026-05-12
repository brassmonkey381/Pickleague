-- ============================================================
-- Drill follow-ups:
--   1. Per-request chat (drill_request_messages) — sender and receiver
--      can DM each other on a request without having to accept/decline.
--   2. drill_sessions table — created automatically when a drill_request
--      flips to 'accepted'.  Source of truth for "upcoming drill" lists
--      and the morning-of reminder banner.
-- ============================================================

-- ── 1. Drill request messages ────────────────────────────
create table if not exists public.drill_request_messages (
  id            uuid default gen_random_uuid() primary key,
  request_id    uuid references public.drill_requests(id) on delete cascade not null,
  sender_id     uuid references public.profiles(id) on delete cascade not null,
  body          text not null check (length(trim(body)) > 0),
  created_at    timestamptz not null default now()
);

create index if not exists drill_request_messages_request_idx
  on public.drill_request_messages (request_id, created_at);

alter table public.drill_request_messages enable row level security;

do $$ begin
  -- Only the two participants of the request can read its chat.
  if not exists (select 1 from pg_policies where tablename='drill_request_messages' and policyname='Participants read chat') then
    create policy "Participants read chat" on public.drill_request_messages
      for select using (
        exists (
          select 1 from public.drill_requests r
           where r.id = drill_request_messages.request_id
             and auth.uid() in (r.from_user_id, r.to_user_id)
        )
      );
  end if;

  -- Either participant may post a message.
  if not exists (select 1 from pg_policies where tablename='drill_request_messages' and policyname='Participants send chat') then
    create policy "Participants send chat" on public.drill_request_messages
      for insert with check (
        auth.uid() = sender_id
        and exists (
          select 1 from public.drill_requests r
           where r.id = drill_request_messages.request_id
             and auth.uid() in (r.from_user_id, r.to_user_id)
        )
      );
  end if;

  -- Sender can delete their own messages (no edit, keeps it simple).
  if not exists (select 1 from pg_policies where tablename='drill_request_messages' and policyname='Sender deletes own chat') then
    create policy "Sender deletes own chat" on public.drill_request_messages
      for delete using (auth.uid() = sender_id);
  end if;
end $$;

-- ── 2. Notify the other party when a chat message arrives ─────
create or replace function public.notify_on_drill_chat()
returns trigger language plpgsql security definer as $$
declare
  v_req        record;
  v_recipient  uuid;
  v_sender     text;
begin
  select * into v_req from public.drill_requests where id = new.request_id;
  if v_req.id is null then return new; end if;

  v_recipient := case when new.sender_id = v_req.from_user_id then v_req.to_user_id else v_req.from_user_id end;
  select full_name into v_sender from public.profiles where id = new.sender_id;

  insert into public.notifications (user_id, title, body, type, entity_id, entity_type, is_read)
  values (
    v_recipient,
    '💬 ' || coalesce(v_sender, 'Someone') || ' replied',
    left(new.body, 120),
    'drill',
    new.request_id,
    'drill',
    false
  );
  return new;
exception when others then
  -- Notification failures shouldn't block the message itself.
  return new;
end;
$$;

drop trigger if exists on_drill_chat_insert on public.drill_request_messages;
create trigger on_drill_chat_insert
  after insert on public.drill_request_messages
  for each row execute procedure public.notify_on_drill_chat();

-- ── 3. drill_sessions — scheduled drills after an accept ─────
-- Stores the agreed slot in a flat shape (separate columns + a derived
-- starts_at timestamp) so morning-of queries are just `session_date = today`.
create table if not exists public.drill_sessions (
  id            uuid default gen_random_uuid() primary key,
  request_id    uuid references public.drill_requests(id) on delete set null,
  player1_id    uuid references public.profiles(id) on delete cascade not null,  -- requester
  player2_id    uuid references public.profiles(id) on delete cascade not null,  -- accepter
  session_date  date not null,
  session_slot  integer not null check (session_slot between 0 and 47),
  -- Half-hour grid → starts_at = date + slot * 30 minutes (local time semantics)
  starts_at     timestamptz,
  notes         text,
  reminder_dismissed_by uuid[] not null default '{}',
  created_at    timestamptz not null default now()
);

create index if not exists drill_sessions_player1_date_idx on public.drill_sessions(player1_id, session_date);
create index if not exists drill_sessions_player2_date_idx on public.drill_sessions(player2_id, session_date);

alter table public.drill_sessions enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='drill_sessions' and policyname='Participants read sessions') then
    create policy "Participants read sessions" on public.drill_sessions
      for select using (auth.uid() in (player1_id, player2_id));
  end if;
  -- Participants can update notes / dismiss reminder
  if not exists (select 1 from pg_policies where tablename='drill_sessions' and policyname='Participants update sessions') then
    create policy "Participants update sessions" on public.drill_sessions
      for update using (auth.uid() in (player1_id, player2_id));
  end if;
end $$;

-- ── 4. Trigger: on drill_request accept, create the drill_session ─
create or replace function public.create_drill_session_on_accept()
returns trigger language plpgsql security definer as $$
declare
  v_date text;
  v_slot integer;
begin
  if old.status = 'pending' and new.status = 'accepted' and new.accepted_slot is not null then
    v_date := new.accepted_slot ->> 'date';
    v_slot := (new.accepted_slot ->> 'slot')::int;
    if v_date is null or v_slot is null then return new; end if;

    insert into public.drill_sessions (
      request_id, player1_id, player2_id, session_date, session_slot, starts_at
    ) values (
      new.id, new.from_user_id, new.to_user_id,
      v_date::date, v_slot,
      (v_date::date)::timestamp + (v_slot * interval '30 minutes')
    )
    on conflict do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists on_drill_request_accept on public.drill_requests;
create trigger on_drill_request_accept
  after update on public.drill_requests
  for each row execute procedure public.create_drill_session_on_accept();
