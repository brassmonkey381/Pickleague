-- ============================================================
-- Drill sessions get a duration.
--
-- Default is 60 minutes (the previous implicit assumption — a single
-- 30-minute slot was being treated as a full drill).  Stored in
-- minutes for clarity; the half-hour grid renders length / 30 cells.
-- ============================================================

alter table public.drill_requests
  add column if not exists length_minutes integer not null default 60
  check (length_minutes > 0 and length_minutes <= 480);

alter table public.drill_sessions
  add column if not exists length_minutes integer not null default 60
  check (length_minutes > 0 and length_minutes <= 480);

-- Update the accept-trigger so the session inherits the request's length.
create or replace function public.create_drill_session_on_accept()
returns trigger language plpgsql security definer as $$
declare
  v_date text;
  v_slot integer;
  v_len  integer;
begin
  if old.status = 'pending' and new.status = 'accepted' and new.accepted_slot is not null then
    v_date := new.accepted_slot ->> 'date';
    v_slot := (new.accepted_slot ->> 'slot')::int;
    v_len  := coalesce(new.length_minutes, 60);
    if v_date is null or v_slot is null then return new; end if;

    insert into public.drill_sessions (
      request_id, player1_id, player2_id, session_date, session_slot, starts_at, length_minutes
    ) values (
      new.id, new.from_user_id, new.to_user_id,
      v_date::date, v_slot,
      (v_date::date)::timestamp + (v_slot * interval '30 minutes'),
      v_len
    )
    on conflict do nothing;
  end if;
  return new;
end;
$$;
