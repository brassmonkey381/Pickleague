-- Tournament registration deadline + "registration closing soon" reminder.
-- Fills the second gap noted in migration_notification_generators.sql.
--
--   1. tournaments.registration_closes_at (nullable) — informational deadline
--      set at creation. The client hides "Request to Join" once it passes;
--      nothing auto-transitions status (starting the bracket stays an admin
--      action).
--   2. remind_tournament_registration_closings() — fires once per (tournament,
--      user) when the deadline is within 6 hours and status is still
--      'registration', to:
--        • league members with NO registration yet (request mode only —
--          invite-only tournaments can't be requested into), and
--        • pending admin-invited registrants (any mode) who haven't responded.
--   3. run_notification_reminders() dispatcher gains the new pass.
--
-- Idempotent: add column if not exists + create or replace.

alter table public.tournaments
  add column if not exists registration_closes_at timestamptz;

-- ── Registration closing soon (≤6h) ────────────────────────────────────────
create or replace function public.remind_tournament_registration_closings()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare r record;
begin
  for r in
    with due as (
      -- Unregistered league members (request-mode tournaments only)
      select t.id as tournament_id, lm.user_id, false as is_invitee
      from public.tournaments t
      join public.league_members lm on lm.league_id = t.league_id
      where t.status = 'registration'
        and t.registration_mode = 'request'
        and t.registration_closes_at >  now()
        and t.registration_closes_at <= now() + interval '6 hours'
        and not exists (
          select 1 from public.tournament_registrations tr
          where tr.tournament_id = t.id and tr.user_id = lm.user_id
        )
      union all
      -- Pending invitees who haven't accepted yet (any mode)
      select t.id, tr.user_id, true
      from public.tournaments t
      join public.tournament_registrations tr
        on tr.tournament_id = t.id
       and tr.status = 'pending'
       and tr.invited_by is not null
      where t.status = 'registration'
        and t.registration_closes_at >  now()
        and t.registration_closes_at <= now() + interval '6 hours'
    ),
    fresh as (
      insert into public.reminder_log (kind, entity_id, user_id)
      select 'registration_closing', tournament_id, user_id from due
      on conflict do nothing
      returning entity_id, user_id
    )
    select f.user_id, f.entity_id as tournament_id, t.name,
           bool_or(d.is_invitee) as is_invitee
    from fresh f
    join public.tournaments t on t.id = f.entity_id
    join due d on d.tournament_id = f.entity_id and d.user_id = f.user_id
    group by f.user_id, f.entity_id, t.name
  loop
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, category)
    values (
      r.user_id,
      '⏳ Registration closing soon: ' || r.name,
      case when r.is_invitee
        then 'You have a pending invite and registration closes within 6 hours. Tap to respond.'
        else 'Registration closes within 6 hours. Tap to request your spot.'
      end,
      'tournament', r.tournament_id, 'tournament', 'notifyTournamentUpdates'
    );
  end loop;
exception when others then null;
end $$;

-- ── Dispatcher (adds the registration-closing pass) ────────────────────────
create or replace function public.run_notification_reminders()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.remind_drill_sessions();
  perform public.remind_event_starts();
  perform public.remind_event_record_results();
  perform public.remind_tournament_starts();
  perform public.remind_tournament_registration_closings();
  perform public.remind_vote_closings();
end $$;
