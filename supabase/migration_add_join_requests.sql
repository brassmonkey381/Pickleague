-- Run in Supabase SQL Editor

create table if not exists public.league_join_requests (
  id         uuid default gen_random_uuid() primary key,
  league_id  uuid references public.leagues(id) on delete cascade not null,
  user_id    uuid references public.profiles(id) on delete cascade not null,
  message    text,
  status     text not null default 'pending' check (status in ('pending', 'denied')),
  created_at timestamptz default now(),
  unique(league_id, user_id)
);

alter table public.league_join_requests enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='league_join_requests' and policyname='Users can insert own requests') then
    create policy "Users can insert own requests" on public.league_join_requests for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='league_join_requests' and policyname='Users can view own requests') then
    create policy "Users can view own requests" on public.league_join_requests for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='league_join_requests' and policyname='Admins can view league requests') then
    create policy "Admins can view league requests" on public.league_join_requests for select using (
      exists (select 1 from public.league_members where league_id = league_join_requests.league_id and user_id = auth.uid() and role in ('admin','co-admin'))
    );
  end if;
  if not exists (select 1 from pg_policies where tablename='league_join_requests' and policyname='Admins can update requests') then
    create policy "Admins can update requests" on public.league_join_requests for update using (
      exists (select 1 from public.league_members where league_id = league_join_requests.league_id and user_id = auth.uid() and role in ('admin','co-admin'))
    );
  end if;
  if not exists (select 1 from pg_policies where tablename='league_join_requests' and policyname='Users can delete own pending requests') then
    create policy "Users can delete own pending requests" on public.league_join_requests for delete using (auth.uid() = user_id);
  end if;
end $$;
