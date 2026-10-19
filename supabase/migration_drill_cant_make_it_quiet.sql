-- ============================================================
-- A drill session either player answered "Can't make it" for goes quiet:
-- no 24 h or 2 h reminder for either player. The partner was already told
-- "They can't make your drill session. Find a new time with them."
-- (rsvp_drill_session), so a later "coming up" reminder contradicted it.
--
-- The answer is the latest row in drill_session_rsvps, so switching back to
-- "On my way" before a window opens brings that window's reminder back.
-- The app hides these sessions from "Review your drills" as well.
--
-- Same body as migration_push_actions_drill.sql except the not exists line.
-- Apply:  supabase db query --linked -f supabase/migration_drill_cant_make_it_quiet.sql
-- ============================================================

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
        and not exists (
          select 1 from public.drill_session_rsvps rs
           where rs.session_id = ds.id and rs.status = 'cant_make_it'
        )
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
