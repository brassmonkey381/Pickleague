-- ============================================================
-- League roles + invite codes
-- Run in Supabase SQL Editor
-- ============================================================

-- 1. Add role column to league_members
alter table public.league_members
  add column if not exists role text not null default 'member'
  check (role in ('admin', 'co-admin', 'member'));

-- 2. Promote existing league creators to admin
update public.league_members lm
set role = 'admin'
from public.leagues l
where lm.league_id = l.id
  and lm.user_id = l.created_by
  and lm.role = 'member';

-- 3. League invites table
create table if not exists public.league_invites (
  id          uuid default gen_random_uuid() primary key,
  league_id   uuid references public.leagues(id) on delete cascade not null,
  created_by  uuid references public.profiles(id) on delete set null,
  token       text unique not null default upper(encode(gen_random_bytes(6), 'hex')),
  expires_at  timestamptz not null default (now() + interval '7 days'),
  max_uses    integer default null,    -- null = unlimited
  used_count  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz default now()
);

alter table public.league_invites enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='league_invites' and policyname='Invites viewable by league members') then
    create policy "Invites viewable by league members" on public.league_invites for select using (
      exists (select 1 from public.league_members where league_id = league_invites.league_id and user_id = auth.uid())
    );
  end if;
  if not exists (select 1 from pg_policies where tablename='league_invites' and policyname='Admins can manage invites') then
    create policy "Admins can manage invites" on public.league_invites for insert with check (
      exists (select 1 from public.league_members where league_id = league_invites.league_id and user_id = auth.uid() and role in ('admin','co-admin'))
    );
  end if;
  if not exists (select 1 from pg_policies where tablename='league_invites' and policyname='Admins can update invites') then
    create policy "Admins can update invites" on public.league_invites for update using (
      exists (select 1 from public.league_members where league_id = league_invites.league_id and user_id = auth.uid() and role in ('admin','co-admin'))
    );
  end if;
  -- Anyone can look up an invite by token (needed for joining via code)
  if not exists (select 1 from pg_policies where tablename='league_invites' and policyname='Anyone can look up invite by token') then
    create policy "Anyone can look up invite by token" on public.league_invites for select using (true);
  end if;
end $$;

-- Allow admins to update member roles
do $$ begin
  if not exists (select 1 from pg_policies where tablename='league_members' and policyname='Admins can update member roles') then
    create policy "Admins can update member roles" on public.league_members for update using (
      exists (select 1 from public.league_members lm2 where lm2.league_id = league_members.league_id and lm2.user_id = auth.uid() and lm2.role = 'admin')
    );
  end if;
  if not exists (select 1 from pg_policies where tablename='league_members' and policyname='Admins can remove members') then
    create policy "Admins can remove members" on public.league_members for delete using (
      user_id = auth.uid() or
      exists (select 1 from public.league_members lm2 where lm2.league_id = league_members.league_id and lm2.user_id = auth.uid() and lm2.role = 'admin')
    );
  end if;
end $$;
