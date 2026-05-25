-- ============================================================
-- FTUE checklist grants
--
-- Tracks which first-time-user-experience steps a user has CLAIMED a
-- pickle reward for. Each step can only be claimed once per user.
--
-- Adds:
--   * ftue_grants(user_id, step)            — one row per claimed step
--   * claim_ftue_step(p_step)               — verifies + grants pickles
--
-- Reward amounts (intentionally generous for the small launch cohort;
-- can be rebalanced later):
--   join_league   = 500
--   setup_profile = 500
--   first_match   = 1000
-- ============================================================

create table if not exists public.ftue_grants (
  user_id    uuid references public.profiles(id) on delete cascade not null,
  step       text not null check (step in ('join_league','setup_profile','first_match')),
  granted_at timestamptz not null default now(),
  primary key (user_id, step)
);

alter table public.ftue_grants enable row level security;

drop policy if exists "Users see own ftue grants" on public.ftue_grants;
create policy "Users see own ftue grants" on public.ftue_grants
  for select using (auth.uid() = user_id);
-- only the SECURITY DEFINER RPC writes; no insert/update policy needed

-- claim_ftue_step — verifies the step is actually complete server-side,
-- then (if not already claimed) inserts the grant row and credits pickles.
create or replace function public.claim_ftue_step(p_step text)
returns table (success boolean, granted integer, new_balance integer, message text)
language plpgsql security definer as $$
declare
  v_uid       uuid := auth.uid();
  v_balance   integer;
  v_complete  boolean := false;
  v_amount    integer := 0;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  -- Reward amounts (generous launch tuning).
  v_amount := case p_step
    when 'join_league'   then 500
    when 'setup_profile' then 500
    when 'first_match'   then 1000
    else null
  end;

  -- Current balance, used in every early-return branch.
  select pickles into v_balance from public.profiles where id = v_uid;

  if v_amount is null then
    return query select false, 0, v_balance, 'Unknown step'::text; return;
  end if;

  -- Verify the step is actually complete (server-side source of truth).
  if p_step = 'join_league' then
    v_complete := exists (select 1 from public.league_members where user_id = v_uid);
  elsif p_step = 'setup_profile' then
    select (avatar_emoji is not null
            or tagline is not null
            or coalesce(array_length(selected_tags, 1), 0) > 0)
      into v_complete
      from public.profiles where id = v_uid;
  elsif p_step = 'first_match' then
    select coalesce(total_matches_played, 0) > 0
      into v_complete
      from public.profiles where id = v_uid;
  end if;

  if not coalesce(v_complete, false) then
    return query select false, 0, v_balance, 'Step not complete yet'::text; return;
  end if;

  -- Already claimed?
  if exists (select 1 from public.ftue_grants where user_id = v_uid and step = p_step) then
    return query select false, 0, v_balance, 'Already claimed'::text; return;
  end if;

  -- Grant: record the claim and credit pickles atomically.
  insert into public.ftue_grants (user_id, step) values (v_uid, p_step);
  update public.profiles set pickles = pickles + v_amount
   where id = v_uid
   returning pickles into v_balance;

  return query select true, v_amount, v_balance, 'Claimed'::text;
end;
$$;

grant execute on function public.claim_ftue_step(text) to authenticated;
