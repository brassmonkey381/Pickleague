-- Promote a guest to a full league member when they vote.
--
-- A guest who redeems an invite gets a TEMPORARY membership (league_members
-- .expires_at = +7d) and a guest profile (is_guest, guest_expires_at) that the
-- cleanup cron eventually removes. Once a guest actually participates by casting
-- an event vote, we treat that as commitment: their membership in that event's
-- league is made permanent (expires_at = NULL) and their guest pass is set to
-- never expire, so neither the cron nor the app-level guard removes them.
--
-- Runs as an AFTER INSERT trigger on event_slot_votes so it covers every vote
-- path (native, web, any client). Only guests are affected; real members are a
-- no-op. This function has no RETURNS TABLE, so the bare column names below are
-- unambiguous.

create or replace function public.promote_guest_voter()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_guest  boolean;
  v_league_id uuid;
begin
  select is_guest into v_is_guest from public.profiles where id = new.user_id;
  if not coalesce(v_is_guest, false) then
    return new;  -- real members aren't touched
  end if;

  select le.league_id into v_league_id
  from public.event_slots es
  join public.league_events le on le.id = es.event_id
  where es.id = new.slot_id;
  if v_league_id is null then
    return new;
  end if;

  -- Permanent membership: add if missing, or clear the temp expiry if present.
  insert into public.league_members (league_id, user_id, role, expires_at)
  values (v_league_id, new.user_id, 'member', null)
  on conflict (league_id, user_id) do update set expires_at = null;

  -- Stop their guest pass from expiring (keeps the account + membership alive).
  update public.profiles
  set guest_expires_at = null
  where id = new.user_id;

  return new;
exception when others then
  return new;  -- never let promotion block a vote
end;
$$;

drop trigger if exists trg_promote_guest_voter on public.event_slot_votes;
create trigger trg_promote_guest_voter
  after insert on public.event_slot_votes
  for each row execute function public.promote_guest_voter();
