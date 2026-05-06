-- Run this if you already applied schema.sql and need to add the new columns

alter table public.matches
  add column if not exists scheduled_at          timestamptz,
  add column if not exists status                text not null default 'completed',
  add column if not exists player1_rating_before integer,
  add column if not exists player2_rating_before integer,
  add column if not exists player1_rating_after  integer,
  add column if not exists player2_rating_after  integer;

-- Add status constraint
alter table public.matches
  drop constraint if exists matches_status_check;
alter table public.matches
  add constraint matches_status_check check (status in ('scheduled', 'completed'));

-- Mark all existing rows as completed
update public.matches set status = 'completed' where status is null;

-- Add update policy
create policy "League members can update scheduled matches"
  on public.matches for update using (
    exists (
      select 1 from public.league_members
      where league_id = matches.league_id and user_id = auth.uid()
    )
  );

-- Replace the ELO trigger with the updated version
drop trigger if exists on_match_created on public.matches;

create or replace function public.update_elo_ratings()
returns trigger language plpgsql security definer as $$
declare
  rating1   integer;
  rating2   integer;
  expected1 float;
  expected2 float;
  k         integer := 32;
  new_r1    integer;
  new_r2    integer;
  score1    float;
  score2    float;
begin
  if new.status <> 'completed' then
    return new;
  end if;
  if TG_OP = 'UPDATE' and old.status = 'completed' then
    return new;
  end if;

  select rating into rating1 from public.profiles where id = new.player1_id;
  select rating into rating2 from public.profiles where id = new.player2_id;

  expected1 := 1.0 / (1.0 + power(10.0, (rating2 - rating1)::float / 400.0));
  expected2 := 1.0 - expected1;

  score1 := case when new.winner_id = new.player1_id then 1.0 else 0.0 end;
  score2 := 1.0 - score1;

  new_r1 := rating1 + round(k * (score1 - expected1));
  new_r2 := rating2 + round(k * (score2 - expected2));

  new.player1_rating_before := rating1;
  new.player2_rating_before := rating2;
  new.player1_rating_after  := new_r1;
  new.player2_rating_after  := new_r2;

  update public.profiles set rating = new_r1 where id = new.player1_id;
  update public.profiles set rating = new_r2 where id = new.player2_id;

  return new;
end;
$$;

create trigger on_match_completed
  before insert or update on public.matches
  for each row execute procedure public.update_elo_ratings();
