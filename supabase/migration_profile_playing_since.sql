-- Playing since: the month a player started playing pickleball (not when they
-- joined Pickleague), shown on their Profile's player card as "SINCE MAR 2021"
-- (the user, 2026-11-04). Re-runnable.
--
-- profiles.playing_since is the first day of that month, or null (not set).
-- The app writes it through set_playing_since, not a profile update: the
-- profiles column guard (migration_profiles_column_guard.sql) default-denies
-- client writes to any column off its allowlist, and this function, a
-- definer owned by postgres, passes the guard the way the server's own
-- writers do. It takes any day and keeps its month; null clears it.
-- Pickleball was invented in 1965, so earlier months are refused, and so are
-- months after this one.

alter table public.profiles add column if not exists playing_since date;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_playing_since_month') then
    alter table public.profiles add constraint profiles_playing_since_month
      check (playing_since is null
             or (extract(day from playing_since) = 1 and playing_since >= date '1965-01-01'));
  end if;
end $$;

create or replace function public.set_playing_since(p_since date)
returns date
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_month date := date_trunc('month', p_since)::date;
begin
  if v_uid is null then
    raise exception using message = 'Sign in to set when you started playing.', hint = 'pl:auth.required';
  end if;
  if v_month is not null
     and (v_month < date '1965-01-01' or v_month > date_trunc('month', current_date)::date) then
    raise exception using
      message = 'Pick a month from 1965 up to this month.',
      hint    = 'pl:profile.playing_since_range';
  end if;
  update public.profiles set playing_since = v_month where id = v_uid;
  return v_month;
end;
$$;

revoke execute on function public.set_playing_since(date) from public, anon;
grant execute on function public.set_playing_since(date) to authenticated;
