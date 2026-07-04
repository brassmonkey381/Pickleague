-- Deleting a tournament stranded open wagers: godmode_delete_tournament just
-- cascade-deleted the tournament, leaving tournament_rank wagers 'open'
-- forever with the bettors' stakes locked (found during a [SIM] cleanup —
-- 7 wagers / 395 pickles stranded). Now open wagers on the tournament are
-- cancelled and refunded (with a notification) before the delete.
--
-- Also:
-- - tournament_participation_grants.tournament_id had NO foreign key (the
--   only tournament-referencing table without one), so deletes orphaned its
--   rows. Backfilled orphans were removed by hand; the FK prevents new ones.
-- - the RPC now also accepts the service_role caller, so the sim cleanup
--   script goes through the refunding path instead of a raw cascade delete.

alter table public.tournament_participation_grants
  drop constraint if exists tournament_participation_grants_tournament_id_fkey;
alter table public.tournament_participation_grants
  add constraint tournament_participation_grants_tournament_id_fkey
  foreign key (tournament_id) references public.tournaments(id) on delete cascade;

create or replace function public.godmode_delete_tournament(p_tournament_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_w    record;
begin
  if not public.is_godmode_user() and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized';
  end if;

  select name into v_name from public.tournaments where id = p_tournament_id;
  if v_name is null then return; end if;

  -- Refund open wagers before the tournament (their settlement subject)
  -- disappears. Settled wagers are historical records and stay put.
  for v_w in
    select w.id, w.user_id, w.stake
      from public.wagers w
     where w.subject_type = 'tournament_rank'
       and w.subject_id = p_tournament_id
       and w.status = 'open'
  loop
    update public.wagers
       set status = 'cancelled', settled_at = now(),
           notes = coalesce(notes || ' · ', '') || 'refunded: tournament deleted'
     where id = v_w.id;
    update public.profiles set pickles = pickles + v_w.stake where id = v_w.user_id;
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type)
    values (
      v_w.user_id,
      '🎲 Wager refunded',
      format('"%s" was deleted — your %s 🥒 stake was returned.', v_name, v_w.stake),
      'wager', v_w.id, 'wager'
    );
  end loop;

  delete from public.tournaments where id = p_tournament_id;
end;
$$;
