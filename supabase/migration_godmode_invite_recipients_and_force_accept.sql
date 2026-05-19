-- Godmode invites v3: include each code's pending invitee list and add an
-- admin force-accept-for-a-specific-user RPC.
--
-- Why: as a league admin sending invite codes to specific players, godmode
-- needs to force-add those exact players (not just join the league as Brian).
-- For leagues the broadcast only writes a notifications row per recipient,
-- so we reconstruct the invitee list by joining notifications back to the
-- code's token. Tournaments are simpler — broadcasts already pre-create a
-- tournament_registrations row with status='pending'.

drop function if exists public.godmode_list_active_invites();

create function public.godmode_list_active_invites()
returns table (
  code_id          uuid,
  scope_type       text,
  scope_id         uuid,
  scope_name       text,
  token            text,
  expires_at       timestamptz,
  used_count       integer,
  max_uses         integer,
  already_member   boolean,
  pending_invitees jsonb
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
  select
    ic.id            as code_id,
    'league'         as scope_type,
    ic.scope_id      as scope_id,
    l.name           as scope_name,
    ic.token         as token,
    ic.expires_at    as expires_at,
    ic.used_count    as used_count,
    ic.max_uses      as max_uses,
    exists (select 1 from league_members lm where lm.league_id = ic.scope_id and lm.user_id = uid) as already_member,
    coalesce((
      select jsonb_agg(jsonb_build_object('user_id', s.user_id, 'user_name', s.user_name) order by s.user_name)
      from (
        select distinct n.user_id, coalesce(p.full_name, p.username, n.user_id::text) as user_name
        from notifications n
        join profiles p on p.id = n.user_id
        where n.entity_type = 'league'
          and n.entity_id   = ic.scope_id
          and position(ic.token in n.body) > 0
          and not exists (
            select 1 from league_members lm
             where lm.league_id = ic.scope_id and lm.user_id = n.user_id
          )
      ) s
    ), '[]'::jsonb) as pending_invitees
  from invite_codes ic
  join leagues l on l.id = ic.scope_id
  where ic.scope_type = 'league'
    and ic.is_active   = true
    and ic.expires_at  > now()
    and l.is_active    = true

  union all

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
    ) as already_member,
    coalesce((
      select jsonb_agg(jsonb_build_object('user_id', s.user_id, 'user_name', s.user_name) order by s.user_name)
      from (
        select tr.user_id, coalesce(p.full_name, p.username, tr.user_id::text) as user_name
        from tournament_registrations tr
        join profiles p on p.id = tr.user_id
        where tr.tournament_id = ic.scope_id
          and tr.status = 'pending'
          and (tr.redeemed_invite_code_id = ic.id or tr.redeemed_invite_code_id is null)
      ) s
    ), '[]'::jsonb) as pending_invitees
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


create or replace function public.godmode_force_accept_invitee(
  p_code_id uuid,
  p_user_id uuid
)
returns table (
  success     boolean,
  message     text,
  scope_type  text,
  scope_id    uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  uid    uuid := auth.uid();
  v_code invite_codes%rowtype;
begin
  if uid is null then raise exception 'Not authenticated'; end if;
  if uid not in ('252a36e1-5d89-4ad2-8a3e-b786579f019a') then
    raise exception 'Forbidden — godmode only';
  end if;

  select * into v_code from invite_codes where id = p_code_id for update;
  if v_code.id is null then
    return query select false, 'Code not found'::text, ''::text, null::uuid; return;
  end if;
  if not v_code.is_active then
    return query select false, 'Code revoked'::text, v_code.scope_type, v_code.scope_id; return;
  end if;
  if v_code.expires_at <= now() then
    return query select false, 'Code expired'::text, v_code.scope_type, v_code.scope_id; return;
  end if;

  if v_code.scope_type = 'league' then
    if exists (select 1 from league_members where league_id = v_code.scope_id and user_id = p_user_id) then
      return query select true, 'Already a member'::text, v_code.scope_type, v_code.scope_id; return;
    end if;
    insert into league_members (league_id, user_id, role, joined_at)
      values (v_code.scope_id, p_user_id, 'member', now());
    update invite_codes set used_count = used_count + 1 where id = v_code.id;
    return query select true, 'Joined league'::text, v_code.scope_type, v_code.scope_id; return;

  elsif v_code.scope_type = 'tournament' then
    insert into tournament_registrations (tournament_id, user_id, status, invited_by, redeemed_invite_code_id, registered_at)
      values (v_code.scope_id, p_user_id, 'approved', uid, v_code.id, now())
    on conflict (tournament_id, user_id) do update
      set status                  = 'approved',
          invited_by              = excluded.invited_by,
          redeemed_invite_code_id = excluded.redeemed_invite_code_id;
    update invite_codes set used_count = used_count + 1 where id = v_code.id;
    return query select true, 'Approved into tournament'::text, v_code.scope_type, v_code.scope_id; return;
  end if;

  return query select false, 'Unknown scope type'::text, v_code.scope_type, v_code.scope_id;
end;
$$;

grant execute on function public.godmode_force_accept_invitee(uuid, uuid) to authenticated;
