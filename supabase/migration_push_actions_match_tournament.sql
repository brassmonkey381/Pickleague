-- ============================================================
-- Match, tournament and league-invite pushes (push actions, 2026-10-11
-- audit). Needs migration_push_data.sql first. Idempotent.
--
--   Match confirm        the score is in the body (Confirm settles it and
--                        moves ratings; it now also needs unlock)
--   Tournament invite    the entry fee is in the body when there is one
--                        (Accept charges it and needs unlock; Decline added)
--   New tournament /     tagged so send-push can offer Request to join to
--   registration closing someone eligible; the fee is in the body
--   League invite code   push_data carries the code: a Join button, and a tap
--                        that joins (the same auto-redeem as the in-app list)
--   Deleted tournament / league refunds
--                        open the Shop (your balance) instead of a page that
--                        no longer exists
--
-- Each function below is the production definition (2026-10-12) plus these
-- changes.
--
-- Apply:  supabase db query --linked -f supabase/migration_push_actions_match_tournament.sql
-- ============================================================

-- ── Match confirm: the score in the body ────────────────────────────────────
create or replace function public._notify_pending_match()
returns trigger
language plpgsql
security definer
as $function$
declare
  v_recipient uuid;
  v_entering  text;
  v_league    text;
  v_others    uuid[];
  v_mine      integer;
  v_theirs    integer;
  v_score     text;
begin
  if new.status <> 'pending' then return new; end if;

  select full_name into v_entering from public.profiles
    where id = coalesce(new.team1_confirmed_by, new.team2_confirmed_by, new.player1_id);
  select name into v_league from public.leagues where id = new.league_id;

  v_others := array_remove(array[new.player1_id, new.partner1_id, new.player2_id, new.partner2_id],
                           coalesce(new.team1_confirmed_by, new.team2_confirmed_by));
  v_others := array_remove(v_others, null);

  foreach v_recipient in array v_others loop
    if v_recipient is null then continue; end if;
    if v_recipient = new.team1_confirmed_by or v_recipient = new.team2_confirmed_by then continue; end if;

    -- The score from this recipient's side: Confirm settles exactly this.
    if v_recipient in (new.player1_id, new.partner1_id) then
      v_mine := new.player1_score; v_theirs := new.player2_score;
    else
      v_mine := new.player2_score; v_theirs := new.player1_score;
    end if;
    v_score := case
      when v_mine is null or v_theirs is null then 'no score entered'
      when v_mine > v_theirs then format('you won %s-%s', v_mine, v_theirs)
      when v_mine < v_theirs then format('you lost %s-%s', v_mine, v_theirs)
      else format('a %s-%s tie', v_mine, v_theirs)
    end;

    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, is_read, category)
    values (
      v_recipient,
      '🥒 Match needs your team to confirm',
      format('%s entered a match in %s: %s. Confirm within an hour if that''s right.',
             coalesce(v_entering, 'A player'), coalesce(v_league, 'a league'), v_score),
      'match', new.id, 'match', false,
      'notifyMatchConfirms'
    );
  end loop;

  return new;
exception when others then
  return new;
end;
$function$;

-- ── Tournament invite: the entry fee in the body ────────────────────────────
create or replace function public.tournament_invite_player(p_tournament_id uuid, p_user_id uuid)
returns table(success boolean, message text, invite_token text)
language plpgsql
security definer
as $function$
declare
  v_uid             uuid := auth.uid();
  v_tournament_name text;
  v_inviter_name    text;
  v_is_admin        boolean;
  v_existing_status text;
  v_code_id         uuid;
  v_code_token      text;
  v_ante            integer;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if p_user_id is null then
    return query select false, 'Pick a player'::text, null::text; return;
  end if;
  if p_user_id = v_uid then
    return query select false, 'You can''t invite yourself'::text, null::text; return;
  end if;

  -- Caller authority check (creator, tournament admin/co-admin, or league admin).
  select t.name, coalesce(t.pickle_ante, 0), exists (
    select 1 from public.tournaments tt
    where tt.id = p_tournament_id
      and (
        tt.created_by = v_uid
        or exists (
          select 1 from public.tournament_registrations tr
          where tr.tournament_id = tt.id and tr.user_id = v_uid
            and tr.role in ('admin','co-admin') and tr.status = 'approved'
        )
        or (tt.league_id is not null and exists (
          select 1 from public.league_members
          where league_id = tt.league_id and user_id = v_uid and role in ('admin','co-admin')
        ))
      )
  )
  into v_tournament_name, v_ante, v_is_admin
  from public.tournaments t
  where t.id = p_tournament_id;

  if v_tournament_name is null then
    return query select false, 'Tournament not found'::text, null::text; return;
  end if;
  if not v_is_admin then
    return query select false, 'Only tournament admins can invite'::text, null::text; return;
  end if;

  select full_name into v_inviter_name from public.profiles where id = v_uid;

  insert into public.invite_codes
    (scope_type, scope_id, created_by, max_uses, expires_at, pickle_subsidy)
  values
    ('tournament', p_tournament_id, v_uid, 1, now() + interval '7 days', 0)
  returning id, token into v_code_id, v_code_token;

  select status into v_existing_status
    from public.tournament_registrations
   where tournament_id = p_tournament_id and user_id = p_user_id;

  if v_existing_status = 'approved' then
    return query select false, 'Player is already in this tournament'::text, null::text; return;
  elsif v_existing_status = 'pending' then
    update public.tournament_registrations
       set invited_by              = v_uid,
           redeemed_invite_code_id = v_code_id
     where tournament_id = p_tournament_id and user_id = p_user_id;
  elsif v_existing_status is null then
    insert into public.tournament_registrations
      (tournament_id, user_id, status, invited_by, redeemed_invite_code_id)
    values (p_tournament_id, p_user_id, 'pending', v_uid, v_code_id);
  else
    update public.tournament_registrations
       set status                  = 'pending',
           invited_by              = v_uid,
           redeemed_invite_code_id = v_code_id
     where tournament_id = p_tournament_id and user_id = p_user_id;
  end if;

  -- The fee is charged when the invite is accepted (also from the lock
  -- screen), so say it before they press anything.
  insert into public.notifications (user_id, title, body, type, entity_id, entity_type)
  values (
    p_user_id,
    format('🎟️ Tournament invite: %s', v_tournament_name),
    format(
      '%s invited you to "%s".%s Tap to accept or decline, or use invite code %s if you''d rather join by code.',
      coalesce(v_inviter_name, 'A tournament admin'),
      v_tournament_name,
      case when v_ante > 0 then format(' Entry fee: %s 🥒, charged when you accept.', v_ante) else '' end,
      v_code_token
    ),
    'tournament',
    p_tournament_id,
    'tournament'
  );

  return query select true, 'Invited'::text, v_code_token;
end;
$function$;

-- ── Invite-code broadcast: league codes ride in push_data; tournament fee ───
create or replace function public.send_invite_code_to_users(p_code_id uuid, p_user_ids uuid[])
returns table(success boolean, sent integer, skipped integer, message text)
language plpgsql
security definer
as $function$
declare
  v_uid          uuid := auth.uid();
  v_code         public.invite_codes%rowtype;
  v_inviter      text;
  v_scope_name   text;
  v_scope_label  text;   -- "league" / "tournament"
  v_sent         integer := 0;
  v_skipped      integer := 0;
  v_user_id      uuid;
  v_existing     text;
  v_fee          integer := 0;
  v_fee_text     text := '';
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if p_user_ids is null or array_length(p_user_ids, 1) is null then
    return query select false, 0, 0, 'Pick at least one player'::text; return;
  end if;

  select * into v_code from public.invite_codes where id = p_code_id;
  if v_code.id is null then
    return query select false, 0, 0, 'Code not found'::text; return;
  end if;
  if not v_code.is_active then
    return query select false, 0, 0, 'This code has been revoked'::text; return;
  end if;
  if v_code.expires_at <= now() then
    return query select false, 0, 0, 'This code has expired'::text; return;
  end if;
  if not public.is_scope_admin(v_code.scope_type, v_code.scope_id) then
    return query select false, 0, 0, 'Only scope admins can broadcast invites'::text; return;
  end if;

  v_scope_label := v_code.scope_type;
  if v_code.scope_type = 'league' then
    select name into v_scope_name from public.leagues where id = v_code.scope_id;
  elsif v_code.scope_type = 'tournament' then
    select name, greatest(coalesce(pickle_ante, 0) - least(coalesce(v_code.pickle_subsidy, 0), coalesce(pickle_ante, 0)), 0)
      into v_scope_name, v_fee
      from public.tournaments where id = v_code.scope_id;
    if v_fee > 0 then
      v_fee_text := format(' Entry fee: %s 🥒, charged when you accept.', v_fee);
    end if;
  end if;
  if v_scope_name is null then
    return query select false, 0, 0, 'Scope not found'::text; return;
  end if;

  select full_name into v_inviter from public.profiles where id = v_uid;

  foreach v_user_id in array p_user_ids loop
    begin
      if v_user_id is null or v_user_id = v_uid then
        v_skipped := v_skipped + 1; continue;
      end if;
      if not exists (select 1 from public.profiles where id = v_user_id) then
        v_skipped := v_skipped + 1; continue;
      end if;

      if v_code.scope_type = 'league' then
        if exists (
          select 1 from public.league_members
          where league_id = v_code.scope_id and user_id = v_user_id
        ) then
          v_skipped := v_skipped + 1; continue;
        end if;
      elsif v_code.scope_type = 'tournament' then
        select status into v_existing
          from public.tournament_registrations
          where tournament_id = v_code.scope_id and user_id = v_user_id;
        if v_existing = 'approved' then
          v_skipped := v_skipped + 1; continue;
        end if;

        if v_existing is null then
          insert into public.tournament_registrations
            (tournament_id, user_id, status, invited_by, redeemed_invite_code_id)
          values
            (v_code.scope_id, v_user_id, 'pending', v_uid, v_code.id);
        else
          update public.tournament_registrations
             set status                  = 'pending',
                 invited_by              = v_uid,
                 redeemed_invite_code_id = v_code.id
           where tournament_id = v_code.scope_id and user_id = v_user_id;
        end if;
      end if;

      -- Body keeps the human-readable token (and the in-app list still reads
      -- it from there). A league code also rides in push_data, so the push's
      -- Join button and tap can redeem it.
      insert into public.notifications (user_id, title, body, type, entity_id, entity_type, push_data)
      values (
        v_user_id,
        format('🎟️ Invite: %s', v_scope_name),
        -- A tap on a league invite joins on 1.0.4 (lib/push.ts, the same
        -- auto-join as the in-app list), so the body says so.
        format(
          case when v_code.scope_type = 'league'
            then '%s invited you to the %s "%s".%s Tap to join, or use invite code %s.'
            else '%s invited you to the %s "%s".%s Tap to open it, or use invite code %s to join.'
          end,
          coalesce(v_inviter, 'An admin'),
          v_scope_label,
          v_scope_name,
          v_fee_text,
          v_code.token
        ),
        v_scope_label,
        v_code.scope_id,
        v_scope_label,
        case when v_code.scope_type = 'league'
          then jsonb_build_object('kind', 'league_invite', 'invite_code', v_code.token)
          else jsonb_build_object('kind', 'tournament_invite')
        end
      );

      v_sent := v_sent + 1;
    exception when others then
      v_skipped := v_skipped + 1;
    end;
  end loop;

  return query select true, v_sent, v_skipped,
    case when v_sent = 0 then 'No invites sent — everyone you picked is already in.'
         else format('Sent %s invite%s%s.',
              v_sent,
              case when v_sent = 1 then '' else 's' end,
              case when v_skipped > 0 then format(' (%s skipped)', v_skipped) else '' end)
    end::text;
end;
$function$;

-- ── New tournament: tagged for Request to join; the fee in the body ─────────
create or replace function public.notify_new_tournament()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r     record;
  v_fee text := case when coalesce(new.pickle_ante, 0) > 0
                  then format(' Entry fee: %s 🥒, charged only if you''re approved.', new.pickle_ante)
                  else '' end;
begin
  if new.league_id is null then
    return new;  -- standalone tournament, no league audience
  end if;

  for r in
    select u.user_id, bool_or(u.is_member) as is_member
    from (
      select lm.user_id, true as is_member
      from public.league_members lm
      where lm.league_id = new.league_id
      union all
      select b.user_id, false
      from public.bookmarks b
      where b.target_type = 'league' and b.target_id = new.league_id
    ) u
    where new.created_by is null or u.user_id <> new.created_by
    group by u.user_id
  loop
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, category, push_data)
    values (
      r.user_id,
      '🏆 New tournament: ' || new.name,
      case when r.is_member
        then 'A new tournament just opened in your league. Tap to register.'
        else 'A new tournament just opened in a league you bookmarked. Tap to check it out.'
      end || v_fee,
      'tournament', new.id, 'tournament', 'notifyTournamentUpdates',
      jsonb_build_object('kind', 'new_tournament')
    );
  end loop;
  return new;
exception when others then
  -- Never let a notification failure roll back the tournament creation.
  return new;
end $function$;

-- ── Registration closing: tagged; the fee in the body ───────────────────────
create or replace function public.remind_tournament_registration_closings()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r     record;
  v_fee integer;
begin
  for r in
    with due as (
      -- Unregistered league members (request-mode tournaments only)
      select t.id as tournament_id, lm.user_id, false as is_invitee
      from public.tournaments t
      join public.league_members lm on lm.league_id = t.league_id
      where t.status = 'registration'
        and t.registration_mode = 'request'
        and t.registration_closes_at >  now()
        and t.registration_closes_at <= now() + interval '6 hours'
        and not exists (
          select 1 from public.tournament_registrations tr
          where tr.tournament_id = t.id and tr.user_id = lm.user_id
        )
      union all
      -- Pending invitees who haven't accepted yet (any mode)
      select t.id, tr.user_id, true
      from public.tournaments t
      join public.tournament_registrations tr
        on tr.tournament_id = t.id
       and tr.status = 'pending'
       and tr.invited_by is not null
      where t.status = 'registration'
        and t.registration_closes_at >  now()
        and t.registration_closes_at <= now() + interval '6 hours'
    ),
    fresh as (
      insert into public.reminder_log (kind, entity_id, user_id)
      select 'registration_closing', tournament_id, user_id from due
      on conflict do nothing
      returning entity_id, user_id
    )
    select f.user_id, f.entity_id as tournament_id, t.name, coalesce(t.pickle_ante, 0) as ante,
           bool_or(d.is_invitee) as is_invitee
    from fresh f
    join public.tournaments t on t.id = f.entity_id
    join due d on d.tournament_id = f.entity_id and d.user_id = f.user_id
    group by f.user_id, f.entity_id, t.name, t.pickle_ante
  loop
    -- What this player would pay: an invite code's subsidy comes off the ante.
    v_fee := r.ante;
    if r.is_invitee and r.ante > 0 then
      select greatest(r.ante - least(coalesce(ic.pickle_subsidy, 0), r.ante), 0)
        into v_fee
        from public.tournament_registrations tr
        left join public.invite_codes ic on ic.id = tr.redeemed_invite_code_id
       where tr.tournament_id = r.tournament_id and tr.user_id = r.user_id;
      v_fee := coalesce(v_fee, r.ante);
    end if;

    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, category, push_data)
    values (
      r.user_id,
      '⏳ Registration closing soon: ' || r.name,
      case when r.is_invitee
        then 'You have a pending invite and registration closes within 6 hours. Tap to respond.'
             || case when v_fee > 0 then format(' Entry fee: %s 🥒, charged when you accept.', v_fee) else '' end
        else 'Registration closes within 6 hours. Tap to request your spot.'
             || case when v_fee > 0 then format(' Entry fee: %s 🥒, charged only if you''re approved.', v_fee) else '' end
      end,
      'tournament', r.tournament_id, 'tournament', 'notifyTournamentUpdates',
      jsonb_build_object('kind', 'registration_closing')
    );
  end loop;
exception when others then null;
end $function$;

-- ── Refunds for a deleted tournament / league open the Shop ─────────────────
-- The refund notifications are written during the delete (by the shared
-- _refund_tournament_pot, inline inserts, and cascade triggers), pointing at a
-- tournament or league that is gone by commit. Called at the END of the
-- delete: every notification written in this transaction (created_at =
-- now(), the transaction's start time) whose tournament / league no longer
-- exists, and its still-pending push, is repointed at the Shop (the balance
-- the refund landed in). cancel_tournament is untouched: that tournament still
-- exists, and its page is the right landing.
create or replace function public._repoint_deleted_scope_pushes()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.notifications n
     set entity_type = 'shop', entity_id = null
   where n.created_at = now()
     and ((n.entity_type = 'tournament' and not exists (select 1 from public.tournaments t where t.id = n.entity_id))
       or (n.entity_type = 'league'     and not exists (select 1 from public.leagues l     where l.id = n.entity_id)));

  update public.push_outbox o
     set entity_type = 'shop', entity_id = null, deep_link = 'shop/-'
   where o.created_at = now()
     and o.status = 'pending'
     and ((o.entity_type = 'tournament' and not exists (select 1 from public.tournaments t where t.id = o.entity_id))
       or (o.entity_type = 'league'     and not exists (select 1 from public.leagues l     where l.id = o.entity_id)));
end $$;
revoke all on function public._repoint_deleted_scope_pushes() from public, anon, authenticated;

create or replace function public.godmode_delete_tournament(p_tournament_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
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

  -- Refund pushes would open a tournament that no longer exists.
  perform public._repoint_deleted_scope_pushes();
end;
$function$;

create or replace function public.godmode_delete_league(p_league_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
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

  -- Refund pushes (this league's, and any tournament removed with it) would
  -- open a page that no longer exists.
  perform public._repoint_deleted_scope_pushes();
end;
$function$;
