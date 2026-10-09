-- ============================================================
-- Push outbox + per-device deliveries + receipts (work order Phase 7c).
-- Built from the foundation server kit's push_outbox.template.sql
-- (@just-messin-around/expo-foundation 1.34.0), adapted to Pickleague:
--   - one outbox row per notifications row, keyed by notification_id (unique),
--     so enqueue is idempotent
--   - the shared secret stays in private.app_config (send_push_secret), which
--     has no anon/authenticated access, instead of Vault
--   - extra failed-row retry with backoff, receipt polling, retention
--
-- BEFORE: notifications INSERT -> pg_net -> send-push. A failed pg_net call or
-- an Expo 5xx lost the push for good.
-- AFTER:  notifications INSERT -> push_outbox row (same transaction)
--           -> outbox INSERT webhook (pg_net, the fast path)
--           -> every 2 min a drain re-sends anything still pending.
-- send-push claims a row (pending -> sending) before sending, so the webhook
-- and the drain can never send the same row at once. Delivery is
-- at-least-once: every push carries data.outboxId and the app dedupes on it.
--
-- Rollout order (state/live-features-server.ps1 does this):
--   1. apply this file      (rows queue as 'pending'; the old function 400s
--                            on the new payload, nothing is lost)
--   2. deploy send-push     (the drain then sends everything pending)
--
-- Apply:  supabase db query --linked -f supabase/migration_push_outbox.sql
-- ============================================================

create table if not exists public.push_outbox (
  id              uuid primary key default gen_random_uuid(),
  notification_id uuid unique references public.notifications (id) on delete cascade,
  recipient_id    uuid not null references public.profiles (id) on delete cascade,
  channel         text not null default 'push' check (channel in ('push', 'email')),
  kind            text not null,                -- notifications.type
  category        text,                         -- notifications.category (pref gate)
  entity_type     text,
  entity_id       uuid,
  title           text not null,
  body            text not null,
  deep_link       text,                         -- "<entity_type>/<entity_id or ->"
  status          text not null default 'pending'
                  check (status in ('pending', 'sending', 'sent', 'failed', 'expired')),
  error           text,
  expires_at      timestamptz,
  attempts        int not null default 0,
  claimed_at      timestamptz,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz
);
create index if not exists push_outbox_pending_idx on public.push_outbox (created_at) where status = 'pending';
create index if not exists push_outbox_sending_idx on public.push_outbox (claimed_at) where status = 'sending';
create index if not exists push_outbox_failed_idx  on public.push_outbox (claimed_at) where status = 'failed';
create index if not exists push_outbox_created_idx on public.push_outbox (created_at);
alter table public.push_outbox enable row level security;   -- no client policies: service role only

create table if not exists public.push_deliveries (
  outbox_id          uuid not null references public.push_outbox (id) on delete cascade,
  token              text not null,
  ticket_id          text,
  status             text not null check (status in ('ok', 'error')),
  error              text,
  receipt_checked_at timestamptz,
  created_at         timestamptz not null default now(),
  primary key (outbox_id, token)
);
create index if not exists push_deliveries_receipt_idx on public.push_deliveries (created_at)
  where status = 'ok' and receipt_checked_at is null;
alter table public.push_deliveries enable row level security;

-- Stamp claims on the database clock, whichever path claimed.
create or replace function public._push_stamp_claim() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status = 'sending' and old.status is distinct from 'sending' then
    new.claimed_at := now();
    new.attempts := old.attempts + 1;
  end if;
  return new;
end $$;
revoke all on function public._push_stamp_claim() from public, anon, authenticated;
drop trigger if exists push_stamp_claim on public.push_outbox;
create trigger push_stamp_claim before update of status on public.push_outbox
  for each row execute function public._push_stamp_claim();

create or replace function public.claim_pending_push(p_limit int default 50)
returns setof public.push_outbox
language sql volatile security definer set search_path = '' as $$
  with picked as materialized (
    select p.id from public.push_outbox p
     where p.status = 'pending'
     order by p.created_at
     limit greatest(1, least(coalesce(p_limit, 50), 100))
     for update skip locked
  )
  update public.push_outbox o set status = 'sending'
    from picked where o.id = picked.id and o.status = 'pending'
  returning o.*;
$$;
revoke execute on function public.claim_pending_push(int) from public, anon, authenticated;
grant execute on function public.claim_pending_push(int) to service_role;

create or replace function public.release_push_claims(p_ids uuid[])
returns int language plpgsql volatile security definer set search_path = '' as $$
declare v int;
begin
  update public.push_outbox
     set status = 'pending', claimed_at = null, attempts = greatest(attempts - 1, 0)
   where id = any(p_ids) and status = 'sending';
  get diagnostics v = row_count;
  return v;
end $$;
revoke execute on function public.release_push_claims(uuid[]) from public, anon, authenticated;
grant execute on function public.release_push_claims(uuid[]) to service_role;

-- When a push stops being worth sending: a match confirm after its deadline,
-- an event vote after voting closes. Anything else never expires.
create or replace function public._push_expires_at(p_entity_type text, p_entity_id uuid)
returns timestamptz language sql stable security definer set search_path = '' as $$
  select case p_entity_type
    when 'match' then (select m.confirm_deadline from public.matches m
                        where m.id = p_entity_id and m.status = 'pending')
    when 'event' then (select e.vote_ends_at from public.league_events e
                        where e.id = p_entity_id and e.status = 'voting')
  end;
$$;
revoke all on function public._push_expires_at(text, uuid) from public, anon, authenticated;

-- A signed-in user may test-push only their own devices.
create or replace function public.send_test_push() returns uuid
language plpgsql security definer set search_path = '' as $$
declare v uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  insert into public.push_outbox (recipient_id, kind, title, body)
  values (auth.uid(), 'test', 'Test notification', 'Push notifications are working.')
  returning id into v;
  return v;
end $$;
revoke execute on function public.send_test_push() from public, anon;
grant execute on function public.send_test_push() to authenticated;

-- ── Enqueue: the notifications trigger now writes the outbox row ───────────
-- Same transaction as the notification. Wrapped so a push problem can never
-- roll back the in-app notification.
create or replace function public.handle_notification_push()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    insert into public.push_outbox
      (notification_id, recipient_id, kind, category, entity_type, entity_id, title, body, deep_link, expires_at)
    values (
      new.id, new.user_id, coalesce(new.type, 'info'), new.category, new.entity_type, new.entity_id,
      coalesce(nullif(new.title, ''), 'Pickleague'), coalesce(new.body, ''),
      case when new.entity_type is not null then new.entity_type || '/' || coalesce(new.entity_id::text, '-') end,
      public._push_expires_at(new.entity_type, new.entity_id)
    )
    on conflict (notification_id) do nothing;
  exception when others then
    raise warning 'push outbox enqueue failed for notification %: %', new.id, sqlerrm;
  end;
  return new;
end $$;
revoke all on function public.handle_notification_push() from public, anon, authenticated;
-- trg_notification_push (AFTER INSERT ON notifications) already calls this.

-- ── Fast path: outbox INSERT webhook ────────────────────────────────────────
-- Sends only the outbox id; send-push re-reads and claims the row. Reads the
-- URL and secret at call time, never stored in a definition. A failure here
-- never blocks the insert; the drain sends the row.
create or replace function public._push_post(p_body jsonb, p_timeout_ms int) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_url    text;
  v_secret text;
begin
  select value into v_url    from private.app_config where key = 'send_push_url';
  select value into v_secret from private.app_config where key = 'send_push_secret';
  if v_url is null then return; end if;
  perform net.http_post(
    url := v_url,
    body := p_body,
    params := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', coalesce(v_secret, '')),
    timeout_milliseconds := p_timeout_ms
  );
end $$;
revoke all on function public._push_post(jsonb, int) from public, anon, authenticated;

create or replace function public._push_webhook() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform public._push_post(
      jsonb_build_object('type', tg_op, 'table', tg_table_name, 'schema', tg_table_schema,
                         'record', jsonb_build_object('id', new.id), 'old_record', null),
      5000);
  exception when others then
    raise warning 'push webhook enqueue failed for %: %', new.id, sqlerrm;
  end;
  return new;
end $$;
revoke all on function public._push_webhook() from public, anon, authenticated;
drop trigger if exists push_webhook on public.push_outbox;
create trigger push_webhook after insert on public.push_outbox
  for each row execute function public._push_webhook();

-- ── Drain, retry, reaper, expiry (every 2 minutes) ──────────────────────────
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.push_drain() returns void
language plpgsql security definer set search_path = '' as $$
begin
  -- Reaper: a row stuck in 'sending' (its invocation died) goes back to
  -- pending, up to 3 claims. May re-send: at-least-once.
  update public.push_outbox
     set status = case when attempts >= 3 then 'failed' else 'pending' end,
         error  = case when attempts >= 3 then 'Stuck in sending after ' || attempts || ' claims; gave up' else error end
   where status = 'sending' and coalesce(claimed_at, created_at) < now() - interval '10 minutes';

  -- Retry with backoff (2, 4 min after the 1st and 2nd attempt), at most 3
  -- attempts. push_deliveries makes a retry send only to devices that failed.
  -- A recipient with no devices is not worth retrying.
  update public.push_outbox
     set status = 'pending'
   where status = 'failed'
     and attempts < 3
     and error is distinct from 'No push tokens for recipient'
     and claimed_at < now() - make_interval(mins => power(2, attempts)::int)
     and (expires_at is null or expires_at > now());

  update public.push_outbox set status = 'expired'
   where status in ('pending', 'failed') and expires_at is not null and expires_at <= now();

  if exists (select 1 from public.push_outbox where status = 'pending') then
    perform public._push_post(jsonb_build_object('processPending', true), 60000);
  end if;
end $$;
revoke all on function private.push_drain() from public, anon, authenticated;

-- Receipts (Expo has them ~15 min after sending): a receipt error marks that
-- device's delivery 'error' and DeviceNotRegistered prunes the token.
create or replace function private.push_poll_receipts() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.push_deliveries
              where status = 'ok' and receipt_checked_at is null
                and created_at < now() - interval '15 minutes') then
    perform public._push_post(jsonb_build_object('pollReceipts', true), 60000);
  end if;
end $$;
revoke all on function private.push_poll_receipts() from public, anon, authenticated;

-- Keep 30 days of history.
create or replace function private.push_prune() returns void
language sql security definer set search_path = '' as $$
  delete from public.push_outbox
   where created_at < now() - interval '30 days'
     and status in ('sent', 'expired', 'failed');
$$;
revoke all on function private.push_prune() from public, anon, authenticated;

do $$ begin
  if exists (select 1 from cron.job where jobname = 'pickleague-push-drain') then
    perform cron.unschedule('pickleague-push-drain');
  end if;
  perform cron.schedule('pickleague-push-drain', '*/2 * * * *', $c$ select private.push_drain(); $c$);

  if exists (select 1 from cron.job where jobname = 'pickleague-push-receipts') then
    perform cron.unschedule('pickleague-push-receipts');
  end if;
  perform cron.schedule('pickleague-push-receipts', '*/30 * * * *', $c$ select private.push_poll_receipts(); $c$);

  if exists (select 1 from cron.job where jobname = 'pickleague-push-prune') then
    perform cron.unschedule('pickleague-push-prune');
  end if;
  perform cron.schedule('pickleague-push-prune', '40 4 * * *', $c$ select private.push_prune(); $c$);
end $$;

-- Health check (oldest pending/sending older than 15 min = drain or secret broken):
--   select status, count(*), min(created_at) from public.push_outbox
--    where created_at > now() - interval '1 day' group by status;
