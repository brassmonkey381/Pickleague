-- Add open/private flag to leagues (default: open)
alter table public.leagues
  add column if not exists is_open boolean not null default true;
