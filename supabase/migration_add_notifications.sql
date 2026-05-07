-- In-app notifications

create table if not exists public.notifications (
  id          uuid default gen_random_uuid() primary key,
  user_id     uuid references public.profiles(id) on delete cascade not null,
  title       text not null,
  body        text not null,
  type        text not null default 'info'
                check (type in ('info','tournament','league','match')),
  entity_id   uuid,    -- e.g. tournament_id or league_id
  entity_type text,    -- 'tournament' | 'league' | 'match'
  is_read     boolean not null default false,
  created_at  timestamptz default now()
);

alter table public.notifications enable row level security;

do $$ begin
  -- Users read their own
  if not exists (select 1 from pg_policies where tablename='notifications' and policyname='Users read own notifications') then
    create policy "Users read own notifications" on public.notifications
      for select using (auth.uid() = user_id);
  end if;
  -- Users mark their own as read
  if not exists (select 1 from pg_policies where tablename='notifications' and policyname='Users update own notifications') then
    create policy "Users update own notifications" on public.notifications
      for update using (auth.uid() = user_id);
  end if;
  -- Tournament admins/co-admins can insert for their members
  if not exists (select 1 from pg_policies where tablename='notifications' and policyname='Tournament admins can notify members') then
    create policy "Tournament admins can notify members" on public.notifications
      for insert with check (
        auth.uid() = user_id
        or (
          entity_type = 'tournament'
          and exists (
            select 1 from public.tournament_registrations
            where tournament_id = notifications.entity_id
              and user_id = auth.uid()
              and role in ('admin','co-admin')
              and status = 'approved'
          )
        )
        or (
          entity_type = 'league'
          and exists (
            select 1 from public.league_members
            where league_id = notifications.entity_id
              and user_id = auth.uid()
              and role in ('admin','co-admin')
          )
        )
      );
  end if;
  if not exists (select 1 from pg_policies where tablename='notifications' and policyname='Users delete own notifications') then
    create policy "Users delete own notifications" on public.notifications
      for delete using (auth.uid() = user_id);
  end if;
end $$;
