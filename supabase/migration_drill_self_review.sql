-- Drill self-review + pickle bonus
-- ---------------------------------------------------------------------------
-- Each drill-session participant can submit a short self-review (1-5 star
-- rating + optional notes) once. Submitting awards a pickle bonus of
-- 25 pickles per half-hour of drilling (30 min = 25, 60 = 50, 90 = 75).
--
-- Adds:
--   * table public.drill_session_reviews (PK session_id + user_id)
--   * RPC submit_drill_review(session, rating, notes) — SECURITY DEFINER

create table if not exists public.drill_session_reviews (
  session_id      uuid references public.drill_sessions(id) on delete cascade not null,
  user_id         uuid references public.profiles(id) on delete cascade not null,
  rating          int  check (rating between 1 and 5),
  notes           text,
  pickles_granted int  not null default 0,
  created_at      timestamptz not null default now(),
  primary key (session_id, user_id)
);

alter table public.drill_session_reviews enable row level security;

-- select: participants of the session can read reviews; insert handled by RPC only
do $$ begin
  if not exists (
    select 1 from pg_policies
     where tablename = 'drill_session_reviews'
       and policyname = 'Reviews readable by session participants'
  ) then
    create policy "Reviews readable by session participants" on public.drill_session_reviews
      for select using (
        exists (select 1 from public.drill_sessions s
                where s.id = session_id and (s.player1_id = auth.uid() or s.player2_id = auth.uid()))
      );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- submit_drill_review: each participant reviews their own session once and
-- claims a pickle bonus scaled by session length.
create or replace function public.submit_drill_review(
  p_session_id uuid,
  p_rating     int,
  p_notes      text
)
returns table (success boolean, pickles_granted int, new_balance int, message text)
language plpgsql security definer as $$
declare
  v_uid       uuid := auth.uid();
  v_session   public.drill_sessions%rowtype;
  v_balance   int;
  v_bonus     int;
  v_rating    int;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  -- Current balance (used in every early-return path).
  select pickles into v_balance from public.profiles where id = v_uid;
  v_balance := coalesce(v_balance, 0);

  select * into v_session from public.drill_sessions where id = p_session_id;
  if not found then
    return query select false, 0, v_balance, 'Drill session not found'::text;
    return;
  end if;

  -- Must be a participant of this session.
  if v_uid <> v_session.player1_id and v_uid <> v_session.player2_id then
    return query select false, 0, v_balance, 'Not a participant'::text;
    return;
  end if;

  -- Session must have started (can't review a future drill).
  if v_session.starts_at is not null and v_session.starts_at > now() then
    return query select false, 0, v_balance, 'You can review after the session starts'::text;
    return;
  end if;

  -- One review per participant per session.
  if exists (
    select 1 from public.drill_session_reviews
     where session_id = p_session_id and user_id = v_uid
  ) then
    return query select false, 0, v_balance, 'Already reviewed'::text;
    return;
  end if;

  -- Clamp the rating into 1..5.
  v_rating := least(greatest(coalesce(p_rating, 1), 1), 5);

  -- 25 pickles per half hour of drilling, minimum one half hour.
  v_bonus := greatest(floor(coalesce(v_session.length_minutes, 30) / 30.0)::int, 1) * 25;

  insert into public.drill_session_reviews (session_id, user_id, rating, notes, pickles_granted)
  values (p_session_id, v_uid, v_rating, nullif(btrim(coalesce(p_notes, '')), ''), v_bonus);

  update public.profiles
     set pickles = pickles + v_bonus
   where id = v_uid
   returning pickles into v_balance;

  return query select true, v_bonus, v_balance, 'Thanks for reviewing!'::text;
end;
$$;

grant execute on function public.submit_drill_review(uuid, int, text) to authenticated;
