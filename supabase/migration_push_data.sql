-- ============================================================
-- push_data: what a generator tells send-push about one push (push actions,
-- 2026-10-11 audit). Additive and idempotent; safe to re-run.
--
-- notifications.push_data (jsonb, nullable) is copied to push_outbox.push_data
-- by handle_notification_push. send-push reads a small, fixed set of keys:
--   kind       which push this is ('event_record', 'drill_chat', ...). Several
--              pushes share an entity (a drill chat and the drill request it
--              belongs to are both drill/<request id>), so the entity alone
--              cannot pick the right buttons.
--   deep_link  where a tap goes, when that is not "<entity_type>/<entity_id>"
--              (e.g. 'drill_chat/<id>' opens the chat thread itself)
--   + a few ids the buttons need (invite_code, partner_id, ...).
--
-- SECURITY: clients may INSERT notifications (self, and admins to their
-- members; TournamentDetail inserts bracket notices). Unfiltered, a client
-- could put any category or link on someone's push. A BEFORE trigger drops
-- push_data on every client write, so only SECURITY DEFINER generators (which
-- run as the function owner) can set it.
--
-- Apply:  supabase db query --linked -f supabase/migration_push_data.sql
-- ============================================================

alter table public.notifications add column if not exists push_data jsonb;
alter table public.push_outbox   add column if not exists push_data jsonb;

-- NOT security definer on purpose: current_user must be the caller's role.
create or replace function public._notifications_strip_client_push_data()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      new.push_data := null;
    else
      new.push_data := old.push_data;
    end if;
  end if;
  return new;
end $$;
revoke all on function public._notifications_strip_client_push_data() from public, anon, authenticated;

drop trigger if exists trg_notifications_strip_client_push_data on public.notifications;
create trigger trg_notifications_strip_client_push_data
  before insert or update of push_data on public.notifications
  for each row execute function public._notifications_strip_client_push_data();

-- Same as migration_push_outbox.sql, plus push_data and its deep_link override.
create or replace function public.handle_notification_push()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    insert into public.push_outbox
      (notification_id, recipient_id, kind, category, entity_type, entity_id, title, body, deep_link, expires_at, push_data)
    values (
      new.id, new.user_id, coalesce(new.type, 'info'), new.category, new.entity_type, new.entity_id,
      coalesce(nullif(new.title, ''), 'Pickleague'), coalesce(new.body, ''),
      coalesce(
        nullif(new.push_data ->> 'deep_link', ''),
        case when new.entity_type is not null then new.entity_type || '/' || coalesce(new.entity_id::text, '-') end
      ),
      public._push_expires_at(new.entity_type, new.entity_id),
      new.push_data
    )
    on conflict (notification_id) do nothing;
  exception when others then
    raise warning 'push outbox enqueue failed for notification %: %', new.id, sqlerrm;
  end;
  return new;
end $$;
revoke all on function public.handle_notification_push() from public, anon, authenticated;
-- trg_notification_push (AFTER INSERT ON notifications) already calls this.
