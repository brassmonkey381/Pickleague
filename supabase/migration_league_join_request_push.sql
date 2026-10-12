-- ============================================================
-- League join request -> a push to the league's admins (push actions,
-- 2026-10-11 audit). Needs migration_push_data.sql first. Idempotent.
--
-- LeagueDetail has long told players "the admins have been notified" after
-- Request to join, but nothing was sent. Now every admin / co-admin gets a
-- push; the tap opens the league's members screen (the 1.0.4 app reads
-- push_data.kind; the link stays league/<id>, so 1.0.3 opens the league),
-- where requests are approved (an approval means sending an invite code, so there is no
-- one-tap Approve, on purpose).
--
-- Fires on a new pending request, and when a request goes back to pending.
-- At most one push per admin, league and requester per hour, so a
-- request / cancel / request loop can't spam the admins.
--
-- Apply:  supabase db query --linked -f supabase/migration_league_join_request_push.sql
-- ============================================================

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
  if tg_op = 'UPDATE' and old.status is not distinct from 'pending' then return new; end if;

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
