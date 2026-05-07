-- Tournament roles + bracket release time + partner requests

-- 1. Add role to tournament_registrations
alter table public.tournament_registrations
  add column if not exists role text not null default 'member'
  check (role in ('admin', 'co-admin', 'member'));

-- 2. Set existing tournament creators to admin
update public.tournament_registrations tr
set role = 'admin'
from public.tournaments t
where tr.tournament_id = t.id
  and tr.user_id = t.created_by
  and tr.status = 'approved'
  and tr.role = 'member';

-- 3. Add bracket release time to tournaments
alter table public.tournaments
  add column if not exists bracket_release_time timestamptz;

-- 4. Partner requests (for MLP / fixed-partner formats)
create table if not exists public.tournament_partner_requests (
  id              uuid default gen_random_uuid() primary key,
  tournament_id   uuid references public.tournaments(id) on delete cascade not null,
  requester_id    uuid references public.profiles(id) on delete cascade not null,
  requested_id    uuid references public.profiles(id) on delete cascade not null,
  status          text not null default 'pending'
                    check (status in ('pending', 'accepted', 'rejected')),
  created_at      timestamptz default now(),
  -- one active request per player per tournament
  unique(tournament_id, requester_id)
);

alter table public.tournament_partner_requests enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='tournament_partner_requests' and policyname='Partner requests viewable by participants') then
    create policy "Partner requests viewable by participants" on public.tournament_partner_requests
      for select using (auth.uid() in (requester_id, requested_id));
  end if;
  if not exists (select 1 from pg_policies where tablename='tournament_partner_requests' and policyname='Users can send partner requests') then
    create policy "Users can send partner requests" on public.tournament_partner_requests
      for insert with check (auth.uid() = requester_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='tournament_partner_requests' and policyname='Participants can update request status') then
    create policy "Participants can update request status" on public.tournament_partner_requests
      for update using (auth.uid() in (requester_id, requested_id));
  end if;
  if not exists (select 1 from pg_policies where tablename='tournament_partner_requests' and policyname='Requester can cancel request') then
    create policy "Requester can cancel request" on public.tournament_partner_requests
      for delete using (auth.uid() = requester_id);
  end if;
  -- Admins/co-admins can view all requests for their tournament
  if not exists (select 1 from pg_policies where tablename='tournament_partner_requests' and policyname='Admin can view all requests') then
    create policy "Admin can view all requests" on public.tournament_partner_requests
      for select using (
        exists (
          select 1 from public.tournament_registrations
          where tournament_id = tournament_partner_requests.tournament_id
            and user_id = auth.uid()
            and role in ('admin','co-admin')
            and status = 'approved'
        )
      );
  end if;
end $$;

-- 5. Allow admins to manage member roles
do $$ begin
  if not exists (select 1 from pg_policies where tablename='tournament_registrations' and policyname='Admin can update member roles') then
    create policy "Admin can update member roles" on public.tournament_registrations
      for update using (
        exists (
          select 1 from public.tournament_registrations tr2
          where tr2.tournament_id = tournament_registrations.tournament_id
            and tr2.user_id = auth.uid()
            and tr2.role = 'admin'
        )
      );
  end if;
end $$;
