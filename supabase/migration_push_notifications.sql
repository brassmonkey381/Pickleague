-- Push notifications foundation
--
-- Every row inserted into public.notifications fans out a phone push via the
-- `send-push` Edge Function. Because this rides on an AFTER INSERT trigger, ALL
-- existing notification sources (the ~19 RPCs/triggers across the app) get push
-- delivery for free — no call-site changes needed.
--
-- Delivery is gated per-user by the `user_preferences.prefs` JSONB blob:
--   pushEnabled (master) + per-category flags (notifyMatchResults, etc.).
-- That gating happens in the Edge Function, which reads prefs server-side.
--
-- ── One-time setup after applying this migration ───────────────────────────
--  1. supabase functions deploy send-push --no-verify-jwt
--  2. Pick a random secret, then set it in BOTH places so they match:
--       update private.app_config set value = '<SECRET>' where key = 'send_push_secret';
--       supabase secrets set PUSH_SHARED_SECRET=<SECRET>
--  3. Enable the pg_net extension (this migration does it, but confirm in dashboard).
--  4. Configure EAS push credentials (APNs key + FCM v1 service account) so
--     standalone builds actually deliver. Expo Go works without them for testing.

create extension if not exists pg_net;

-- ── Device push tokens (one row per device per user) ───────────────────────
create table if not exists public.push_tokens (
  id          uuid default gen_random_uuid() primary key,
  user_id     uuid references public.profiles(id) on delete cascade not null,
  token       text not null unique,
  platform    text,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);
create index if not exists push_tokens_user_idx on public.push_tokens(user_id);

alter table public.push_tokens enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='push_tokens' and policyname='Users manage own push tokens (select)') then
    create policy "Users manage own push tokens (select)" on public.push_tokens
      for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='push_tokens' and policyname='Users manage own push tokens (insert)') then
    create policy "Users manage own push tokens (insert)" on public.push_tokens
      for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='push_tokens' and policyname='Users manage own push tokens (update)') then
    create policy "Users manage own push tokens (update)" on public.push_tokens
      for update using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='push_tokens' and policyname='Users manage own push tokens (delete)') then
    create policy "Users manage own push tokens (delete)" on public.push_tokens
      for delete using (auth.uid() = user_id);
  end if;
end $$;

-- ── Private config: Edge Function URL + shared secret ──────────────────────
-- RLS-enabled with NO policies → unreadable by anon/authenticated. Only
-- SECURITY DEFINER functions (and the service role) can read it.
create schema if not exists private;
create table if not exists private.app_config (
  key   text primary key,
  value text not null
);
alter table private.app_config enable row level security;

insert into private.app_config (key, value) values
  ('send_push_url', 'https://qwsmhztzfgbtzieulkgu.supabase.co/functions/v1/send-push')
  on conflict (key) do nothing;
insert into private.app_config (key, value) values
  ('send_push_secret', 'CHANGE_ME_TO_A_RANDOM_SECRET')
  on conflict (key) do nothing;

-- ── Fan-out trigger: notification insert → Edge Function ───────────────────
create or replace function public.handle_notification_push()
returns trigger
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_url    text;
  v_secret text;
begin
  select value into v_url    from private.app_config where key = 'send_push_url';
  select value into v_secret from private.app_config where key = 'send_push_secret';
  if v_url is null then
    return new;
  end if;

  -- Fire-and-forget. pg_net queues the request; we never block the insert.
  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'x-push-secret', coalesce(v_secret, '')
    ),
    body    := jsonb_build_object('record', to_jsonb(new))
  );
  return new;
exception when others then
  -- A push failure must never roll back the in-app notification insert.
  return new;
end $$;

drop trigger if exists trg_notification_push on public.notifications;
create trigger trg_notification_push
  after insert on public.notifications
  for each row execute function public.handle_notification_push();
