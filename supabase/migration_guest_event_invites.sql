-- Guest invites to a league event vote
--
-- A league member picks phone contacts and sends ONE group text with a shared
-- link (https://pickleague.club/g/<token>). Each tapper lands on a page that
-- shows the invited roster, picks their name, gets a 7-day guest pass (temporary
-- league membership + an anonymous auth session), and is dropped on the vote.
--
-- Guests authenticate via Supabase ANONYMOUS sign-in, so every existing RLS rule
-- keyed on auth.uid() (voting, reading the league as a member, etc.) just works.
--
-- ── Infra prerequisite (one-time) ──────────────────────────────────────────
--   Enable Authentication → Providers → "Anonymous sign-ins" in Supabase.
--   The feature is inert until that is on.

-- ── Temporary membership: NULL expires_at = permanent; guests get now()+7d ──
alter table public.league_members
  add column if not exists expires_at timestamptz;

-- ── Guest flags on the profile ─────────────────────────────────────────────
alter table public.profiles
  add column if not exists is_guest boolean not null default false,
  add column if not exists guest_expires_at timestamptz;

-- ── handle_new_user: tolerate anonymous users (no email / no metadata) ──────
-- Anonymous auth.users rows have a NULL email, which made full_name resolve to
-- NULL and violate the NOT NULL constraint. Add a 'Guest' fallback. The username
-- path already falls back to 'player' (length-0 base), so it's unchanged here.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_base      text;
  v_candidate text;
  v_n         int := 1;
  v_gender    text;
begin
  v_base := lower(regexp_replace(
              coalesce(new.raw_user_meta_data->>'username',
                       split_part(new.email, '@', 1)),
              '[^a-z0-9]', '', 'g'
            ));
  if length(coalesce(v_base, '')) = 0 then
    v_base := 'player';
  end if;

  v_candidate := v_base;
  while exists (select 1 from public.profiles where username = v_candidate) loop
    v_n := v_n + 1;
    v_candidate := v_base || v_n::text;
  end loop;

  v_gender := coalesce(new.raw_user_meta_data->>'gender', 'prefer-not-to-say');
  if v_gender not in ('male','female','other','prefer-not-to-say') then
    v_gender := 'prefer-not-to-say';
  end if;

  insert into public.profiles (id, username, full_name, gender)
  values (
    new.id,
    v_candidate,
    coalesce(
      nullif(new.raw_user_meta_data->>'full_name', ''),
      nullif(split_part(new.email, '@', 1), ''),
      'Guest'
    ),
    v_gender
  );
  return new;
end;
$$;

-- ── Guest invites table ────────────────────────────────────────────────────
create table if not exists public.guest_invites (
  id            uuid default gen_random_uuid() primary key,
  token         text not null unique,
  league_id     uuid not null references public.leagues(id) on delete cascade,
  event_id      uuid not null references public.league_events(id) on delete cascade,
  created_by    uuid references public.profiles(id) on delete set null,
  invited_names text[] not null default '{}',
  expires_at    timestamptz not null default (now() + interval '7 days'),
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);
create index if not exists guest_invites_token_idx on public.guest_invites(token);

-- RLS: only the creator can read/manage rows directly. The pre-auth landing page
-- reads its preview through the SECURITY DEFINER RPC below, never the table.
alter table public.guest_invites enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='guest_invites' and policyname='Creator manages own guest invites') then
    create policy "Creator manages own guest invites" on public.guest_invites
      for all using (auth.uid() = created_by) with check (auth.uid() = created_by);
  end if;
end $$;

-- ── RPC: preview (callable pre-auth by the anon role) ──────────────────────
create or replace function public.get_guest_invite_preview(p_token text)
returns table (
  valid         boolean,
  league_name   text,
  event_id      uuid,
  event_title   text,
  invited_names text[],
  expires_at    timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare v_inv public.guest_invites;
begin
  select * into v_inv
  from public.guest_invites
  where upper(token) = upper(p_token)
  limit 1;

  if v_inv.id is null or not v_inv.is_active or v_inv.expires_at < now() then
    return query select false, null::text, null::uuid, null::text, null::text[], null::timestamptz;
    return;
  end if;

  return query
    select true,
           l.name,
           e.id,
           e.title,
           v_inv.invited_names,
           v_inv.expires_at
    from public.leagues l
    join public.league_events e on e.id = v_inv.event_id
    where l.id = v_inv.league_id;
end;
$$;

grant execute on function public.get_guest_invite_preview(text) to anon, authenticated;

-- ── RPC: create (inviter, must be a league member) ─────────────────────────
create or replace function public.create_guest_invite(
  p_league_id     uuid,
  p_event_id      uuid,
  p_invited_names text[]
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_token text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if not exists (
    select 1 from public.league_members
    where league_id = p_league_id and user_id = auth.uid()
  ) then
    raise exception 'Only league members can invite guests';
  end if;
  if not exists (
    select 1 from public.league_events
    where id = p_event_id and league_id = p_league_id
  ) then
    raise exception 'Event does not belong to this league';
  end if;

  -- Use core gen_random_uuid() (pg_catalog, always on search_path) rather than
  -- pgcrypto's gen_random_bytes/encode, which live in the `extensions` schema
  -- and would not resolve under this function's `search_path = public`.
  v_token := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));  -- 12-char URL-safe token

  insert into public.guest_invites (token, league_id, event_id, created_by, invited_names)
  values (v_token, p_league_id, p_event_id, auth.uid(), coalesce(p_invited_names, '{}'));

  return v_token;
end;
$$;

grant execute on function public.create_guest_invite(uuid, uuid, text[]) to authenticated;

-- ── RPC: redeem (guest, after anonymous sign-in) ───────────────────────────
create or replace function public.redeem_guest_invite(p_token text, p_name text)
returns table (
  league_id   uuid,
  league_name text,
  event_id    uuid,
  event_title text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inv  public.guest_invites;
  v_name text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  -- Only an anonymous (guest) session may redeem. Without this, a real user who
  -- called this RPC directly would have their profile overwritten (is_guest=true,
  -- name, 7-day expiry) and get signed out / cron-removed. The client never calls
  -- this for a real user, but the server must enforce it too.
  if coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) is not true then
    raise exception 'Only a guest session can redeem a guest invite';
  end if;

  select * into v_inv
  from public.guest_invites
  where upper(token) = upper(p_token)
  limit 1;

  if v_inv.id is null or not v_inv.is_active or v_inv.expires_at < now() then
    raise exception 'This guest invite is no longer valid';
  end if;

  v_name := nullif(trim(coalesce(p_name, '')), '');

  -- Stamp the guest's profile (name + guest flag + expiry).
  update public.profiles
  set full_name        = coalesce(v_name, full_name),
      is_guest         = true,
      guest_expires_at = v_inv.expires_at
  where id = auth.uid();

  -- Temporary league membership (idempotent if they re-tap the link).
  insert into public.league_members (league_id, user_id, role, expires_at)
  values (v_inv.league_id, auth.uid(), 'member', v_inv.expires_at)
  on conflict (league_id, user_id) do nothing;

  return query
    select l.id, l.name, e.id, e.title
    from public.leagues l
    join public.league_events e on e.id = v_inv.event_id
    where l.id = v_inv.league_id;
end;
$$;

grant execute on function public.redeem_guest_invite(text, text) to authenticated;

-- ── Cleanup: drop expired temporary memberships (daily) ────────────────────
create or replace function public.cleanup_expired_guests()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.league_members
  where expires_at is not null and expires_at < now();
end;
$$;

do $$ begin
  if not exists (select 1 from cron.job where jobname = 'pickleague-cleanup-expired-guests') then
    perform cron.schedule(
      'pickleague-cleanup-expired-guests',
      '15 3 * * *',
      $cron$ select public.cleanup_expired_guests(); $cron$
    );
  end if;
end $$;
