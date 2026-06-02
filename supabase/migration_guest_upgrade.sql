-- Upgrade an anonymous guest to a real account.
--
-- Adds phone capture (from the invite) and the server-side finalize RPC the
-- client calls after supabase.auth.updateUser({email, password}). Phones are
-- stored on the invite and matched to the guest's chosen roster name on redeem;
-- they never reach the client (get_guest_invite_preview returns names only).

-- ── Columns ────────────────────────────────────────────────────────────────
alter table public.profiles
  add column if not exists phone text;

-- Index-aligned with guest_invites.invited_names.
alter table public.guest_invites
  add column if not exists invited_phones text[] not null default '{}';

-- ── create_guest_invite: store invited phones alongside names ──────────────
-- Drop the 3-arg version so a 3-arg call resolves to the new defaulted one.
drop function if exists public.create_guest_invite(uuid, uuid, text[]);
create or replace function public.create_guest_invite(
  p_league_id      uuid,
  p_event_id       uuid,
  p_invited_names  text[],
  p_invited_phones text[] default '{}'
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

  v_token := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));

  insert into public.guest_invites (token, league_id, event_id, created_by, invited_names, invited_phones)
  values (v_token, p_league_id, p_event_id, auth.uid(),
          coalesce(p_invited_names, '{}'), coalesce(p_invited_phones, '{}'));

  return v_token;
end;
$$;

grant execute on function public.create_guest_invite(uuid, uuid, text[], text[]) to authenticated;

-- ── redeem_guest_invite: capture the phone for the chosen roster name ──────
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
#variable_conflict use_column
declare
  v_inv   public.guest_invites;
  v_name  text;
  v_phone text;
  i       int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
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

  -- Best-effort: match the chosen name to a roster phone (exact, case-insensitive).
  v_phone := null;
  if v_name is not null then
    for i in 1 .. coalesce(array_length(v_inv.invited_names, 1), 0) loop
      if lower(trim(v_inv.invited_names[i])) = lower(v_name)
         and i <= coalesce(array_length(v_inv.invited_phones, 1), 0) then
        v_phone := nullif(trim(v_inv.invited_phones[i]), '');
        exit;
      end if;
    end loop;
  end if;

  update public.profiles
  set full_name        = coalesce(v_name, full_name),
      is_guest         = true,
      guest_expires_at = v_inv.expires_at,
      phone            = coalesce(v_phone, phone)
  where id = auth.uid();

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

-- ── complete_guest_upgrade: finalize the profile after updateUser ──────────
-- Called by the client AFTER supabase.auth.updateUser({email, password, data}).
-- Finalizes profile fields a guest didn't set, clears guest flags, and makes
-- their temporary memberships permanent. Only acts on a guest (no-op otherwise).
create or replace function public.complete_guest_upgrade(
  p_full_name text,
  p_gender    text,
  p_phone     text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_guest  boolean;
  v_full      text;
  v_base      text;
  v_candidate text;
  v_n         int := 1;
  v_gender    text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select is_guest into v_is_guest from public.profiles where id = auth.uid();
  if not coalesce(v_is_guest, false) then
    return;  -- only guests upgrade
  end if;

  v_full := nullif(trim(coalesce(p_full_name, '')), '');

  -- Username from the name (mirrors handle_new_user), deduped against OTHERS.
  v_base := lower(regexp_replace(coalesce(v_full, ''), '[^a-z0-9]', '', 'g'));
  if length(coalesce(v_base, '')) = 0 then
    v_base := 'player';
  end if;
  v_candidate := v_base;
  while exists (select 1 from public.profiles where username = v_candidate and id <> auth.uid()) loop
    v_n := v_n + 1;
    v_candidate := v_base || v_n::text;
  end loop;

  v_gender := coalesce(p_gender, 'prefer-not-to-say');
  if v_gender not in ('male','female','other','prefer-not-to-say') then
    v_gender := 'prefer-not-to-say';
  end if;

  update public.profiles
  set full_name        = coalesce(v_full, full_name),
      username         = v_candidate,
      gender           = v_gender,
      phone            = coalesce(nullif(trim(coalesce(p_phone, '')), ''), phone),
      is_guest         = false,
      guest_expires_at = null
  where id = auth.uid();

  -- Temporary memberships become permanent now that they're a real member.
  update public.league_members
  set expires_at = null
  where user_id = auth.uid();
end;
$$;

grant execute on function public.complete_guest_upgrade(text, text, text) to authenticated;
