-- ============================================================
-- Pre-launch generosity: bump base pickle grants.
--
--   welcome        1000 -> 2500   (claim_welcome_pickles)
--   first match     200 ->  500   (_grant_first_match_bonus trigger)
--   badge earned     50 ->  150   (_grant_pickles_on_badge trigger)
--
-- Small known user base for the friends launch — fast cosmetic payoffs
-- matter more than economy balance, and redemptions were just made 2.5x
-- pricier so pickles still have a long-term sink. Rebalance before any
-- wider release.
-- ============================================================

-- 1. Welcome grant: 1000 -> 2500
create or replace function public.claim_welcome_pickles()
returns table (granted boolean, new_balance integer)
language plpgsql security definer as $$
declare
  v_uid       uuid := auth.uid();
  v_already   boolean;
  v_balance   integer;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select welcome_pickles_granted, pickles
    into v_already, v_balance
    from public.profiles
   where id = v_uid;

  if v_already then
    return query select false, v_balance;
    return;
  end if;

  update public.profiles
     set pickles                 = pickles + 2500,
         welcome_pickles_granted = true
   where id = v_uid
   returning pickles into v_balance;

  return query select true, v_balance;
end;
$$;

-- 2. First-match bonus: 200 -> 500
create or replace function public._grant_first_match_bonus()
returns trigger language plpgsql security definer as $$
declare
  v_uid   uuid;
  v_count integer;
begin
  if coalesce(new.status, 'completed') <> 'completed' then return new; end if;

  for v_uid in
    select distinct uid from (values
      (new.player1_id), (new.partner1_id), (new.player2_id), (new.partner2_id)
    ) as t(uid)
    where uid is not null
  loop
    begin
      if exists (select 1 from public.first_match_bonus_grants where user_id = v_uid) then
        continue;
      end if;

      select count(*) into v_count from public.matches
        where player1_id = v_uid or partner1_id = v_uid
           or player2_id = v_uid or partner2_id = v_uid;

      if v_count = 1 then
        insert into public.first_match_bonus_grants(user_id) values (v_uid)
          on conflict (user_id) do nothing;

        update public.profiles set pickles = coalesce(pickles, 0) + 500 where id = v_uid;

        begin
          perform public._notify_user(
            v_uid,
            '🥒 First match! +500 pickles to spend in the Shop.',
            '🥒 First match! +500 pickles to spend in the Shop.',
            v_uid,
            'shop'
          );
        exception when others then null;
        end;
      end if;
    exception when others then null;
    end;
  end loop;
  return new;
end;
$$;

-- 3. Badge-earned bonus: 50 -> 150
create or replace function public._grant_pickles_on_badge()
returns trigger language plpgsql security definer as $$
declare
  v_badge_name text;
begin
  if current_setting('pickleague.skip_badge_pickle_grant', true) = 'on' then
    return new;
  end if;

  select name into v_badge_name from public.badges where id = new.badge_id;
  if v_badge_name is null then return new; end if;

  update public.profiles set pickles = coalesce(pickles, 0) + 150 where id = new.user_id;

  begin
    perform public._notify_user(
      new.user_id,
      format('🥒 +150 pickles for earning %s!', v_badge_name),
      format('You received 150 🥒 for earning the %s badge. Tap to see your shop balance.', v_badge_name),
      new.user_id,
      'shop'
    );
  exception when others then null;
  end;

  return new;
end;
$$;
