-- Godmode helper: list all active invite_codes joined with scope name and the
-- caller's membership status. Server-gated to the godmode allowlist so we don't
-- have to rely on client checks.
--
-- The base invite_codes table is already readable by everyone (policy "Invite
-- codes lookup" using (true)) so this RPC is mostly for convenience: it joins
-- the scope's display name and computes whether the caller already belongs.

create or replace function public.godmode_list_active_invites()
returns table (
  code_id        uuid,
  scope_type     text,
  scope_id       uuid,
  scope_name     text,
  token          text,
  expires_at     timestamptz,
  used_count     integer,
  max_uses       integer,
  already_member boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Not authenticated'; end if;
  -- Mirrors the client-side GODMODE_USER_IDS allowlist.
  if uid not in ('252a36e1-5d89-4ad2-8a3e-b786579f019a') then
    raise exception 'Forbidden — godmode only';
  end if;

  return query
  select
    ic.id as code_id,
    ic.scope_type,
    ic.scope_id,
    case ic.scope_type
      when 'league'     then (select name from leagues     where id = ic.scope_id)
      when 'tournament' then (select name from tournaments where id = ic.scope_id)
    end as scope_name,
    ic.token,
    ic.expires_at,
    ic.used_count,
    ic.max_uses,
    case ic.scope_type
      when 'league' then exists (
        select 1 from league_members where league_id = ic.scope_id and user_id = uid
      )
      when 'tournament' then exists (
        select 1 from tournament_registrations
         where tournament_id = ic.scope_id and user_id = uid and status = 'approved'
      )
      else false
    end as already_member
  from invite_codes ic
  where ic.is_active = true
    and ic.expires_at > now()
  order by ic.expires_at asc;
end;
$$;

grant execute on function public.godmode_list_active_invites() to authenticated;
