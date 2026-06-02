-- Drill self-review: 5 facet ratings + text, new pickle reward.
--
-- Reshapes the review from a single 1-5 star (length-based bonus) to five
-- facet ratings (Consistency, Effort, Organization, Intentionality, Fun) plus a
-- long-text self-review. Reward = 5 pickles per facet answered (≤25) + 0.1
-- pickle per character of the review, capped at 50 (≤75 total). One review per
-- participant per session (unchanged idempotency via the PK).

alter table public.drill_session_reviews
  add column if not exists consistency    int check (consistency    between 1 and 5),
  add column if not exists effort         int check (effort         between 1 and 5),
  add column if not exists organization   int check (organization   between 1 and 5),
  add column if not exists intentionality int check (intentionality between 1 and 5),
  add column if not exists fun            int check (fun            between 1 and 5);

-- New signature → drop the old 3-arg function.
drop function if exists public.submit_drill_review(uuid, int, text);

create or replace function public.submit_drill_review(
  p_session_id     uuid,
  p_consistency    int,
  p_effort         int,
  p_organization   int,
  p_intentionality int,
  p_fun            int,
  p_notes          text
)
returns table (success boolean, pickles_granted int, new_balance int, message text)
language plpgsql security definer as $$
declare
  v_uid        uuid := auth.uid();
  v_session    public.drill_sessions%rowtype;
  v_balance    int;
  v_notes      text;
  v_answered   int := 0;
  v_sum        int := 0;
  v_facet_pick int;
  v_text_pick  int;
  v_total      int;
  c1 int; c2 int; c3 int; c4 int; c5 int;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select pickles into v_balance from public.profiles where id = v_uid;
  v_balance := coalesce(v_balance, 0);

  select * into v_session from public.drill_sessions where id = p_session_id;
  if not found then
    return query select false, 0, v_balance, 'Drill session not found'::text;
    return;
  end if;
  if v_uid <> v_session.player1_id and v_uid <> v_session.player2_id then
    return query select false, 0, v_balance, 'Not a participant'::text;
    return;
  end if;
  if v_session.starts_at is not null and v_session.starts_at > now() then
    return query select false, 0, v_balance, 'You can review after the session starts'::text;
    return;
  end if;
  if exists (
    select 1 from public.drill_session_reviews
     where session_id = p_session_id and user_id = v_uid
  ) then
    return query select false, 0, v_balance, 'Already reviewed'::text;
    return;
  end if;

  -- Clamp each facet to 1..5, or null when unanswered.
  c1 := case when p_consistency    is null then null else least(greatest(p_consistency,    1), 5) end;
  c2 := case when p_effort         is null then null else least(greatest(p_effort,         1), 5) end;
  c3 := case when p_organization   is null then null else least(greatest(p_organization,   1), 5) end;
  c4 := case when p_intentionality is null then null else least(greatest(p_intentionality, 1), 5) end;
  c5 := case when p_fun            is null then null else least(greatest(p_fun,            1), 5) end;

  if c1 is not null then v_answered := v_answered + 1; v_sum := v_sum + c1; end if;
  if c2 is not null then v_answered := v_answered + 1; v_sum := v_sum + c2; end if;
  if c3 is not null then v_answered := v_answered + 1; v_sum := v_sum + c3; end if;
  if c4 is not null then v_answered := v_answered + 1; v_sum := v_sum + c4; end if;
  if c5 is not null then v_answered := v_answered + 1; v_sum := v_sum + c5; end if;

  if v_answered = 0 then
    return query select false, 0, v_balance, 'Rate at least one aspect'::text;
    return;
  end if;

  v_notes      := nullif(btrim(coalesce(p_notes, '')), '');
  v_facet_pick := v_answered * 5;                                              -- 5 per facet
  v_text_pick  := least(floor(char_length(coalesce(v_notes, '')) * 0.1)::int, 50); -- 0.1/char, cap 50
  v_total      := v_facet_pick + v_text_pick;

  insert into public.drill_session_reviews
    (session_id, user_id, rating, consistency, effort, organization, intentionality, fun, notes, pickles_granted)
  values
    (p_session_id, v_uid, round(v_sum::numeric / v_answered)::int, c1, c2, c3, c4, c5, v_notes, v_total);

  update public.profiles
     set pickles = pickles + v_total
   where id = v_uid
   returning pickles into v_balance;

  return query select true, v_total, v_balance, 'Thanks for reviewing!'::text;
end;
$$;

grant execute on function public.submit_drill_review(uuid, int, int, int, int, int, text) to authenticated;
