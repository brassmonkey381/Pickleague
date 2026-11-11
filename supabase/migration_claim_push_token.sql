-- claim_push_token (PKL-020): a phone's push token belongs to whoever is signed
-- in on it now.
--
-- Bug: push_tokens.token is unique and the app upserted on it. When a second
-- account signs in on a phone whose token row still belongs to the first
-- account (a new sign-up on the same phone, or a sign-out whose unregister
-- didn't land), the upsert becomes an UPDATE of the other account's row. The
-- update policy (auth.uid() = user_id) refuses it, so the first run's Alerts
-- step and the Settings switch showed "You don't have access to that." and the
-- new account got no pushes.
--
-- This moves the row to the caller. One device, one owner: the previous
-- account stops getting pushes on that phone, which is what signing in as
-- someone else on it means. Expo tokens are only readable on the device, so
-- only that device can claim its row.
create or replace function public.claim_push_token(p_token text, p_platform text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if p_token is null or char_length(p_token) not between 10 and 512 then
    raise exception 'bad push token' using errcode = '22023';
  end if;
  if p_platform is not null and p_platform not in ('ios', 'android') then
    raise exception 'bad platform' using errcode = '22023';
  end if;
  insert into public.push_tokens (user_id, token, platform, updated_at)
  values (v_me, p_token, p_platform, now())
  on conflict (token) do update
     set user_id = excluded.user_id,
         platform = excluded.platform,
         updated_at = now();
end $$;
revoke all on function public.claim_push_token(text, text) from public, anon;
grant execute on function public.claim_push_token(text, text) to authenticated;
