-- ============================================================
-- Lock-screen action buttons, round 2: drill requests, drill session
-- reminders, tournament invites.
--
-- Every write here is idempotent, because push delivery is at-least-once and
-- the OS can replay a response: a repeated Accept/Decline/RSVP lands on the
-- same final state and reports success.
--
-- The tournament invite button reuses tournament_respond_to_invite (already
-- granted to authenticated); nothing new is needed for it here.
--
-- Skipped on purpose: an Approve button for league join requests. Approval in
-- Pickleague is "send the requester an invite code" (LeagueMembersScreen), not
-- a status flip, so a one-tap Approve would invent a second, different flow.
--
-- Apply:  supabase db query --linked -f supabase/migration_push_actions_drill_tournament.sql
-- ============================================================

-- ── 1. Drill request: Accept / Decline ─────────────────────────────────────
-- Accept is only offered (by send-push) when the request proposes exactly one
-- slot: with several, a single tap cannot say which time is meant. This
-- function enforces the same rule rather than trusting the button.
create or replace function public.respond_drill_request(p_request uuid, p_accept boolean)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_req    public.drill_requests%rowtype;
  v_target text := case when p_accept then 'accepted' else 'declined' end;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  select * into v_req from public.drill_requests where id = p_request for update;
  if v_req.id is null then raise exception 'Request not found'; end if;
  if v_req.to_user_id <> v_uid then raise exception 'Only the invited player can respond'; end if;

  -- Replayed response: already in the state this tap asks for.
  if v_req.status = v_target then return 'already'; end if;
  if v_req.status <> 'pending' then raise exception 'Request is no longer pending'; end if;

  if p_accept then
    if coalesce(jsonb_array_length(v_req.proposed_slots), 0) <> 1 then
      raise exception 'Pick a time in the app';
    end if;
    update public.drill_requests
       set status = 'accepted', responded_at = now(), accepted_slot = v_req.proposed_slots -> 0
     where id = p_request;
  else
    update public.drill_requests
       set status = 'declined', responded_at = now()
     where id = p_request;
  end if;
  return v_target;
end $$;
revoke execute on function public.respond_drill_request(uuid, boolean) from public, anon;
grant execute on function public.respond_drill_request(uuid, boolean) to authenticated;

-- ── 2. Drill session RSVP: On my way / Can't make it ───────────────────────
create table if not exists public.drill_session_rsvps (
  session_id uuid not null references public.drill_sessions (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  status     text not null check (status in ('on_my_way', 'cant_make_it')),
  updated_at timestamptz not null default now(),
  primary key (session_id, user_id)
);
alter table public.drill_session_rsvps enable row level security;

-- The two players of the session can read both answers. Writes go through
-- rsvp_drill_session only (no insert/update policy).
drop policy if exists drill_session_rsvps_players_read on public.drill_session_rsvps;
create policy drill_session_rsvps_players_read on public.drill_session_rsvps
  for select to authenticated
  using (exists (
    select 1 from public.drill_sessions ds
     where ds.id = drill_session_rsvps.session_id
       and auth.uid() in (ds.player1_id, ds.player2_id)
  ));

create or replace function public.rsvp_drill_session(p_session uuid, p_status text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_ses     public.drill_sessions%rowtype;
  v_partner uuid;
  v_prev    text;
  v_name    text;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if p_status not in ('on_my_way', 'cant_make_it') then raise exception 'Bad status'; end if;

  select * into v_ses from public.drill_sessions where id = p_session;
  if v_ses.id is null then raise exception 'Session not found'; end if;
  if v_uid not in (v_ses.player1_id, v_ses.player2_id) then
    raise exception 'Only the two players can answer';
  end if;
  v_partner := case when v_uid = v_ses.player1_id then v_ses.player2_id else v_ses.player1_id end;

  select status into v_prev from public.drill_session_rsvps
   where session_id = p_session and user_id = v_uid;
  if v_prev = p_status then return 'already'; end if;  -- replay: no second notice

  insert into public.drill_session_rsvps (session_id, user_id, status, updated_at)
  values (p_session, v_uid, p_status, now())
  on conflict (session_id, user_id) do update set status = excluded.status, updated_at = now();

  -- Tell the partner, once per change of answer.
  select full_name into v_name from public.profiles where id = v_uid;
  insert into public.notifications (user_id, title, body, type, entity_id, entity_type)
  values (
    v_partner,
    case p_status when 'on_my_way' then '🥒 ' || coalesce(v_name, 'Your partner') || ' is on the way'
                  else '🥒 ' || coalesce(v_name, 'Your partner') || ' can''t make it' end,
    case p_status when 'on_my_way' then 'Your drill session is still on.'
                  else 'They can''t make your drill session. Open Pickleague to reschedule.' end,
    'drill', p_session, 'drill'
  );
  return p_status;
end $$;
revoke execute on function public.rsvp_drill_session(uuid, text) from public, anon;
grant execute on function public.rsvp_drill_session(uuid, text) to authenticated;
