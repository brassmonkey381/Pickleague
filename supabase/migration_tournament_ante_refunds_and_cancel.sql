-- Tournament economy lifecycle: ante refunds + a real cancel flow.
--
-- Found by the tournament ugly-path sweep. Antes are charged into the pot
-- the moment a registration is approved (_charge_tournament_ante), but
-- NOTHING ever refunded them:
--   - a paid-up player who withdrew or was kicked during registration
--     forfeited their ante into the pot silently;
--   - there was no way to cancel a tournament at all (the 'cancelled'
--     status renders in the app but nothing ever set it);
--   - godmode_delete_tournament refunded open wagers (earlier fix) but
--     vaporized the pot — antes and voluntary contributions were charged
--     from players and never returned.
--
-- Fixes:
--   1. pickle_pot_contributions gains kind ('contribution'|'ante'|
--      'ante_subsidy') + refunded_at, so ante rows are distinguishable and
--      refunds are idempotent.
--   2. Leaving 'approved' (withdraw/kick/un-approve) while the tournament
--      is still in REGISTRATION refunds that player's ante (and the invite
--      code creator's subsidy). Once active, antes are committed.
--   3. cancel_tournament(uuid) RPC — creator/godmode; registration or
--      active; not paid out. Refunds every unrefunded contribution and
--      open wager, sets status='cancelled', notifies participants.
--   4. godmode_delete_tournament refunds the pot too (when no payout was
--      dispatched) before deleting.

alter table public.pickle_pot_contributions
  add column if not exists kind text not null default 'contribution'
    check (kind in ('contribution', 'ante', 'ante_subsidy')),
  add column if not exists refunded_at timestamptz;

-- ── 1. stamp ante ledger rows ───────────────────────────────────────────
create or replace function public._charge_tournament_ante()
returns trigger language plpgsql security definer as $$
declare
  v_ante         integer;
  v_balance      integer;
  v_subsidy      integer := 0;
  v_creator      uuid;
  v_creator_bal  integer;
  v_user_pays    integer;
begin
  if new.status <> 'approved' then return new; end if;
  if TG_OP = 'UPDATE' and old.status = 'approved' then return new; end if;

  select pickle_ante into v_ante from public.tournaments where id = new.tournament_id;
  if v_ante is null or v_ante <= 0 then return new; end if;

  if new.redeemed_invite_code_id is not null then
    select coalesce(pickle_subsidy, 0), created_by into v_subsidy, v_creator
      from public.invite_codes where id = new.redeemed_invite_code_id;
    if v_subsidy is null then v_subsidy := 0; end if;
    if v_subsidy > v_ante then v_subsidy := v_ante; end if;
  end if;

  v_user_pays := v_ante - v_subsidy;

  select pickles into v_balance from public.profiles where id = new.user_id;
  if coalesce(v_balance, 0) < v_user_pays then
    raise exception 'User % has only % 🥒, ante is % (after %🥒 subsidy)',
      new.user_id, coalesce(v_balance, 0), v_user_pays, v_subsidy;
  end if;
  if v_user_pays > 0 then
    update public.profiles set pickles = pickles - v_user_pays where id = new.user_id;
  end if;

  if v_subsidy > 0 and v_creator is not null then
    select pickles into v_creator_bal from public.profiles where id = v_creator;
    if coalesce(v_creator_bal, 0) < v_subsidy then
      raise exception 'Code creator can''t cover the % 🥒 subsidy', v_subsidy;
    end if;
    update public.profiles set pickles = pickles - v_subsidy where id = v_creator;
  end if;

  perform public._update_pool('tournament', new.tournament_id, v_ante);

  if v_user_pays > 0 then
    insert into public.pickle_pot_contributions
      (scope_type, scope_id, user_id, amount_paid, bonus_amount, pool_added, kind)
    values ('tournament', new.tournament_id, new.user_id, v_user_pays, 0, v_user_pays, 'ante');
  end if;
  if v_subsidy > 0 and v_creator is not null then
    insert into public.pickle_pot_contributions
      (scope_type, scope_id, user_id, amount_paid, bonus_amount, pool_added, kind)
    values ('tournament', new.tournament_id, v_creator, v_subsidy, 0, v_subsidy, 'ante_subsidy');
  end if;

  return new;
end;
$$;

-- ── 2. refund antes when a paid player leaves during registration ───────
create or replace function public._refund_registration_ante(p_tournament_id uuid, p_user_id uuid, p_invite_code_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_t      record;
  v_row    record;
  v_name   text;
begin
  select status, champion_payout_applied_at, name into v_t
    from public.tournaments where id = p_tournament_id;
  -- Only pre-lock: once the bracket is active the ante is committed to the
  -- pot (cancel_tournament handles the abandon-everything case). Skip
  -- entirely if the tournament row is already gone (cascade deletes).
  if v_t.status is null or v_t.status <> 'registration' or v_t.champion_payout_applied_at is not null then
    return;
  end if;
  v_name := v_t.name;

  -- The player's own ante…
  for v_row in
    select id, user_id, amount_paid, pool_added from public.pickle_pot_contributions
     where scope_type = 'tournament' and scope_id = p_tournament_id
       and user_id = p_user_id and kind = 'ante' and refunded_at is null
  loop
    update public.profiles set pickles = pickles + v_row.amount_paid where id = v_row.user_id;
    perform public._update_pool('tournament', p_tournament_id, -v_row.pool_added);
    update public.pickle_pot_contributions set refunded_at = now() where id = v_row.id;
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type)
    values (v_row.user_id, '🥒 Ante refunded',
            format('Your %s 🥒 ante for "%s" was refunded.', v_row.amount_paid, v_name),
            'tournament', p_tournament_id, 'tournament');
  end loop;

  -- …and the invite-code creator's subsidy for this registration, if any.
  if p_invite_code_id is not null then
    for v_row in
      select c.id, c.user_id, c.amount_paid, c.pool_added
        from public.pickle_pot_contributions c
        join public.invite_codes ic on ic.id = p_invite_code_id
       where c.scope_type = 'tournament' and c.scope_id = p_tournament_id
         and c.user_id = ic.created_by and c.kind = 'ante_subsidy' and c.refunded_at is null
       limit 1
    loop
      update public.profiles set pickles = pickles + v_row.amount_paid where id = v_row.user_id;
      perform public._update_pool('tournament', p_tournament_id, -v_row.pool_added);
      update public.pickle_pot_contributions set refunded_at = now() where id = v_row.id;
      insert into public.notifications (user_id, title, body, type, entity_id, entity_type)
      values (v_row.user_id, '🥒 Subsidy refunded',
              format('Your %s 🥒 invite subsidy for "%s" was refunded.', v_row.amount_paid, v_name),
              'tournament', p_tournament_id, 'tournament');
    end loop;
  end if;
end;
$$;
revoke execute on function public._refund_registration_ante(uuid, uuid, uuid) from public, anon, authenticated;

create or replace function public._refund_ante_on_reg_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'approved' then
      perform public._refund_registration_ante(old.tournament_id, old.user_id, old.redeemed_invite_code_id);
    end if;
    return old;
  end if;
  if old.status = 'approved' and new.status <> 'approved' then
    perform public._refund_registration_ante(new.tournament_id, new.user_id, new.redeemed_invite_code_id);
  end if;
  return new;
end;
$$;
revoke execute on function public._refund_ante_on_reg_change() from public, anon, authenticated;

drop trigger if exists trg_refund_ante_on_reg_change on public.tournament_registrations;
create trigger trg_refund_ante_on_reg_change
  after update or delete on public.tournament_registrations
  for each row execute function public._refund_ante_on_reg_change();

-- ── 3. refund the whole pot (cancel / delete paths) ─────────────────────
create or replace function public._refund_tournament_pot(p_tournament_id uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_name     text;
  v_user     record;
  v_refunded integer := 0;
begin
  select name into v_name from public.tournaments where id = p_tournament_id;
  for v_user in
    select user_id, sum(amount_paid)::int as paid, sum(pool_added)::int as pooled
      from public.pickle_pot_contributions
     where scope_type = 'tournament' and scope_id = p_tournament_id and refunded_at is null
     group by user_id
  loop
    update public.profiles set pickles = pickles + v_user.paid where id = v_user.user_id;
    perform public._update_pool('tournament', p_tournament_id, -v_user.pooled);
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type)
    values (v_user.user_id, '🥒 Pot refunded',
            format('%s 🥒 you put into "%s" (ante/contributions) was returned.', v_user.paid, coalesce(v_name, 'a tournament')),
            'tournament', p_tournament_id, 'tournament');
    v_refunded := v_refunded + v_user.paid;
  end loop;
  update public.pickle_pot_contributions set refunded_at = now()
   where scope_type = 'tournament' and scope_id = p_tournament_id and refunded_at is null;
  return v_refunded;
end;
$$;
revoke execute on function public._refund_tournament_pot(uuid) from public, anon, authenticated;

-- ── 4. cancel_tournament RPC (admin action, client-callable) ────────────
create or replace function public.cancel_tournament(p_tournament_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_t        record;
  v_w        record;
  v_refunded integer;
  v_reg      record;
begin
  select id, name, status, created_by, champion_payout_applied_at into v_t
    from public.tournaments where id = p_tournament_id;
  if v_t.id is null then raise exception 'Tournament not found'; end if;
  if auth.uid() is distinct from v_t.created_by and not public.is_godmode_user()
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only the tournament creator can cancel it';
  end if;
  if v_t.status not in ('registration', 'active') then
    raise exception 'Tournament is already %', v_t.status;
  end if;
  if v_t.champion_payout_applied_at is not null then
    raise exception 'Payout already dispatched — cannot cancel';
  end if;

  -- Refund the pot (antes + voluntary contributions)…
  v_refunded := public._refund_tournament_pot(p_tournament_id);

  -- …and every open wager on the tournament.
  for v_w in
    select w.id, w.user_id, w.stake from public.wagers w
     where w.subject_type = 'tournament_rank' and w.subject_id = p_tournament_id and w.status = 'open'
  loop
    update public.wagers
       set status = 'cancelled', settled_at = now(),
           notes = coalesce(notes || ' · ', '') || 'refunded: tournament cancelled'
     where id = v_w.id;
    update public.profiles set pickles = pickles + v_w.stake where id = v_w.user_id;
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type)
    values (v_w.user_id, '🎲 Wager refunded',
            format('"%s" was cancelled — your %s 🥒 stake was returned.', v_t.name, v_w.stake),
            'wager', v_w.id, 'wager');
  end loop;

  update public.tournaments set status = 'cancelled' where id = p_tournament_id;

  for v_reg in
    select user_id from public.tournament_registrations
     where tournament_id = p_tournament_id and status = 'approved' and user_id <> v_t.created_by
  loop
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type)
    values (v_reg.user_id, '🚫 Tournament cancelled',
            format('"%s" was cancelled by the organizer. Antes, contributions and wagers were refunded.', v_t.name),
            'tournament', p_tournament_id, 'tournament');
  end loop;

  return format('Cancelled — %s 🥒 refunded from the pot.', v_refunded);
end;
$$;
revoke execute on function public.cancel_tournament(uuid) from public, anon;
grant execute on function public.cancel_tournament(uuid) to authenticated;

-- ── 5. deletion refunds the pot too (when nothing was paid out) ─────────
create or replace function public.godmode_delete_tournament(p_tournament_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_t   record;
  v_w   record;
begin
  if not public.is_godmode_user() and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized';
  end if;

  select name, champion_payout_applied_at into v_t from public.tournaments where id = p_tournament_id;
  if v_t.name is null then return; end if;

  -- Pot contributions come back unless the pot was already distributed.
  if v_t.champion_payout_applied_at is null then
    perform public._refund_tournament_pot(p_tournament_id);
  end if;

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
      format('"%s" was deleted — your %s 🥒 stake was returned.', v_t.name, v_w.stake),
      'wager', v_w.id, 'wager'
    );
  end loop;

  delete from public.tournaments where id = p_tournament_id;
end;
$$;
