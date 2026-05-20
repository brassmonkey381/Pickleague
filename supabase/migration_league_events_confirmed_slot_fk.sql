-- league_events.confirmed_slot_id pointed at event_slots(id) without an
-- actual FK constraint, so PostgREST couldn't resolve embedded selects
-- like `event_slots:event_slots!league_events_confirmed_slot_id_fkey(starts_at)`
-- — the join silently returned null and the LeagueDetail Coming Up
-- filter dropped every scheduled event. Adds the FK + reloads schema.

do $$ begin
  if not exists (
    select 1 from information_schema.table_constraints
     where table_name='league_events' and constraint_name='league_events_confirmed_slot_id_fkey'
  ) then
    alter table public.league_events
      add constraint league_events_confirmed_slot_id_fkey
      foreign key (confirmed_slot_id) references public.event_slots(id) on delete set null;
  end if;
end $$;

notify pgrst, 'reload schema';
