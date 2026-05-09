-- ============================================================
-- Drill partner scheduling
-- ============================================================

-- ── 1. Profile drill columns ──────────────────────────
alter table public.profiles
  add column if not exists drilling_enabled    boolean not null default false,
  add column if not exists drill_availability  jsonb   not null default '{}'::jsonb,
  add column if not exists drill_shot_prefs    text[]  not null default '{}',
  add column if not exists drill_partner_prefs text[]  not null default '{}',
  add column if not exists drill_custom_tags   text[]  not null default '{}';
-- drill_availability format: { "YYYY-MM-DD": [bool x 48] }
-- drill_shot_prefs/drill_partner_prefs: array of preset slugs
-- drill_custom_tags: free-text user-added tags

-- ── 2. Drill requests table ───────────────────────────
create table if not exists public.drill_requests (
  id              uuid default gen_random_uuid() primary key,
  from_user_id    uuid references public.profiles(id) on delete cascade not null,
  to_user_id      uuid references public.profiles(id) on delete cascade not null,
  proposed_slots  jsonb not null default '[]'::jsonb,
  -- Format: [{ "date": "YYYY-MM-DD", "slot": 0..47 }, ...]
  message         text,
  status          text not null default 'pending'
                    check (status in ('pending','accepted','declined','cancelled')),
  accepted_slot   jsonb,  -- { date, slot } when accepted
  created_at      timestamptz default now(),
  responded_at    timestamptz
);

create index if not exists drill_requests_to_user_idx
  on public.drill_requests(to_user_id, status, created_at desc);
create index if not exists drill_requests_from_user_idx
  on public.drill_requests(from_user_id, status, created_at desc);

alter table public.drill_requests enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='drill_requests' and policyname='Users see own drill requests') then
    create policy "Users see own drill requests" on public.drill_requests
      for select using (auth.uid() = from_user_id or auth.uid() = to_user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='drill_requests' and policyname='Users send drill requests') then
    create policy "Users send drill requests" on public.drill_requests
      for insert with check (auth.uid() = from_user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='drill_requests' and policyname='Users update drill requests they are part of') then
    create policy "Users update drill requests they are part of" on public.drill_requests
      for update using (auth.uid() = from_user_id or auth.uid() = to_user_id);
  end if;
end $$;

-- ── 3. Expand notifications type check to include 'drill' ──
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in ('info','tournament','league','match','drill'));

-- ── 4. Trigger: notify receiver on new drill request ──
create or replace function public.notify_on_drill_request()
returns trigger language plpgsql security definer as $$
declare
  v_sender_name text;
  v_slot_count  integer;
begin
  select full_name into v_sender_name from public.profiles where id = new.from_user_id;
  v_slot_count := coalesce(jsonb_array_length(new.proposed_slots), 0);
  insert into public.notifications (user_id, title, body, type, entity_id, entity_type, is_read)
  values (
    new.to_user_id,
    '🏓 ' || coalesce(v_sender_name, 'Someone') || ' wants to drill',
    case
      when new.message is not null and length(trim(new.message)) > 0
        then 'Proposed ' || v_slot_count || ' time slot' || (case when v_slot_count = 1 then '' else 's' end) || ' · "' || left(new.message, 80) || '"'
      else 'Proposed ' || v_slot_count || ' time slot' || (case when v_slot_count = 1 then '' else 's' end)
    end,
    'drill',
    new.id,
    'drill',
    false
  );
  return new;
end;
$$;

drop trigger if exists on_drill_request_insert on public.drill_requests;
create trigger on_drill_request_insert
  after insert on public.drill_requests
  for each row execute procedure public.notify_on_drill_request();

-- ── 5. Trigger: notify sender when request is responded to ──
create or replace function public.notify_on_drill_response()
returns trigger language plpgsql security definer as $$
declare
  v_responder_name text;
  v_title          text;
  v_body           text;
begin
  if old.status = 'pending' and new.status in ('accepted','declined') then
    select full_name into v_responder_name from public.profiles where id = new.to_user_id;
    if new.status = 'accepted' then
      v_title := '✅ ' || coalesce(v_responder_name, 'Your drill partner') || ' accepted!';
      v_body  := 'Drill session is on. Tap to see the time.';
    else
      v_title := coalesce(v_responder_name, 'Your drill partner') || ' declined';
      v_body  := 'Maybe try another time or partner?';
    end if;
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, is_read)
    values (new.from_user_id, v_title, v_body, 'drill', new.id, 'drill', false);
  end if;
  return new;
end;
$$;

drop trigger if exists on_drill_response on public.drill_requests;
create trigger on_drill_response
  after update on public.drill_requests
  for each row execute procedure public.notify_on_drill_response();
