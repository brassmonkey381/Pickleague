-- Godmode helper: list all active invite_codes joined with scope name and the
-- caller's membership status. Server-gated to the godmode allowlist.
--
-- Scope filtering:
--   * INNER JOIN on leagues / tournaments drops invite_codes that point to
--     deleted scopes (no more "unknown scope" rows in the UI).
--   * Tournament invites are hidden when the tournament is completed or
--     cancelled — old codes for finished events become invisible.
--   * League invites require leagues.is_active = true.

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
  if uid not in ('252a36e1-5d89-4ad2-8a3e-b786579f019a') then
    raise exception 'Forbidden — godmode only';
  end if;

  return query
  -- League invites: existing, active league.
  select
    ic.id            as code_id,
    'league'         as scope_type,
    ic.scope_id      as scope_id,
    l.name           as scope_name,
    ic.token         as token,
    ic.expires_at    as expires_at,
    ic.used_count    as used_count,
    ic.max_uses      as max_uses,
    exists (select 1 from league_members where league_id = ic.scope_id and user_id = uid) as already_member
  from invite_codes ic
  join leagues l on l.id = ic.scope_id
  where ic.scope_type = 'league'
    and ic.is_active   = true
    and ic.expires_at  > now()
    and l.is_active    = true

  union all

  -- Tournament invites: must reference a tournament that's still joinable.
  select
    ic.id            as code_id,
    'tournament'     as scope_type,
    ic.scope_id      as scope_id,
    t.name           as scope_name,
    ic.token         as token,
    ic.expires_at    as expires_at,
    ic.used_count    as used_count,
    ic.max_uses      as max_uses,
    exists (
      select 1 from tournament_registrations
       where tournament_id = ic.scope_id and user_id = uid and status = 'approved'
    ) as already_member
  from invite_codes ic
  join tournaments t on t.id = ic.scope_id
  where ic.scope_type   = 'tournament'
    and ic.is_active    = true
    and ic.expires_at   > now()
    and t.status not in ('completed','cancelled')

  order by expires_at asc;
end;
$$;

grant execute on function public.godmode_list_active_invites() to authenticated;
