-- League lifecycle fixes, found by the league deep sweep.
--
-- 1. godmode_delete_league was a bare DELETE — the same money-vaporizer the
--    tournament sweep fixed: league/season pot contributions were charged
--    from players and never returned, and open period_rank wagers on the
--    league's seasons were stranded 'open' forever with stakes locked.
--    Now every unrefunded contribution (league + its seasons) is refunded,
--    open period_rank wagers are cancelled + refunded, and the RPC accepts
--    the service_role caller (sim cleanup path).
--
-- 2. Changing a league's home court silently failed to relabel matches:
--    LeagueDetailScreen re-derived is_home_court with per-row UPDATEs on
--    `matches`, but matches has NO RLS UPDATE policy, so every one of those
--    updates matched zero rows and no-opped. New relabel_league_home_court
--    RPC (league admin / creator) does it server-side in one statement.

create or replace function public.relabel_league_home_court(p_league_id uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_home  text;
  v_rows  integer;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not exists (
    select 1 from public.leagues l
     where l.id = p_league_id
       and (l.created_by = auth.uid()
            or exists (select 1 from public.league_members m
                        where m.league_id = l.id and m.user_id = auth.uid()
                          and m.role in ('admin', 'co-admin')))
  ) and not public.is_godmode_user() then
    raise exception 'Only league admins can relabel home-court matches';
  end if;

  select home_court into v_home from public.leagues where id = p_league_id;
  update public.matches
     set is_home_court = (v_home is not null and location_name = v_home)
   where league_id = p_league_id;
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;
revoke execute on function public.relabel_league_home_court(uuid) from public, anon;
grant execute on function public.relabel_league_home_court(uuid) to authenticated;

create or replace function public.godmode_delete_league(p_league_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_user record;
  v_w    record;
begin
  if not public.is_godmode_user() and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized';
  end if;

  select name into v_name from public.leagues where id = p_league_id;
  if v_name is null then return; end if;

  -- Refund every unrefunded pot contribution: the league's own pool plus
  -- each of its seasons' pools.
  for v_user in
    select c.user_id, sum(c.amount_paid)::int as paid
      from public.pickle_pot_contributions c
     where c.refunded_at is null
       and (
         (c.scope_type = 'league' and c.scope_id = p_league_id)
         or (c.scope_type = 'season' and c.scope_id in
              (select s.id from public.league_seasons s where s.league_id = p_league_id))
       )
     group by c.user_id
  loop
    update public.profiles set pickles = pickles + v_user.paid where id = v_user.user_id;
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type)
    values (v_user.user_id, '🥒 Pot refunded',
            format('%s 🥒 you put into "%s" (or its seasons) was returned.', v_user.paid, v_name),
            'league', p_league_id, 'league');
  end loop;
  update public.pickle_pot_contributions c set refunded_at = now()
   where c.refunded_at is null
     and (
       (c.scope_type = 'league' and c.scope_id = p_league_id)
       or (c.scope_type = 'season' and c.scope_id in
            (select s.id from public.league_seasons s where s.league_id = p_league_id))
     );

  -- Cancel + refund open period-rank wagers on the league's seasons.
  for v_w in
    select w.id, w.user_id, w.stake
      from public.wagers w
     where w.subject_type = 'period_rank'
       and w.status = 'open'
       and w.subject_id in (select s.id from public.league_seasons s where s.league_id = p_league_id)
  loop
    update public.wagers
       set status = 'cancelled', settled_at = now(),
           notes = coalesce(notes || ' · ', '') || 'refunded: league deleted'
     where id = v_w.id;
    update public.profiles set pickles = pickles + v_w.stake where id = v_w.user_id;
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type)
    values (v_w.user_id, '🎲 Wager refunded',
            format('"%s" was deleted — your %s 🥒 stake was returned.', v_name, v_w.stake),
            'wager', v_w.id, 'wager');
  end loop;

  delete from public.leagues where id = p_league_id;
end;
$$;
