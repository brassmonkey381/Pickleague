-- Referrals: Doggle parity (state/referrals-plan.md; Doggle migrations 0149,
-- 0238, 0240, 0242, 0254 and 0348).
--
-- What it does:
--   * Every profile gets a referral_code (random, unique case-insensitively)
--     and an invited_by link. Neither column can be written by a client: a
--     guard trigger keeps both unchanged on any update made by anon or
--     authenticated (the profiles UPDATE grant is table-wide, so a column
--     revoke would do nothing).
--   * public.referrals: one row per invitee (unique), created by
--     claim_referral() or, at sign-up, from the auth metadata key
--     referral_code (RegisterScreen sends it; UpgradeAccountScreen sends it
--     with the guest's new email). RLS: each side reads its own rows only.
--   * The reward: +2500 pickles to the referrer AND +2500 to the invitee, paid
--     once (referrals.rewarded_at is the single gate) when the invitee is a
--     real account (auth.users.is_anonymous false) with a CONFIRMED email.
--     Whichever comes second pays: the link (claim already confirmed) or the
--     confirmation (an AFTER UPDATE trigger on auth.users, plus an AFTER
--     INSERT trigger for auto-confirmed accounts). The trigger body runs in
--     its own exception block: a payout failure never blocks a sign-up, a
--     sign-in or an email confirmation.
--   * Milestones for the referrer: the badges Recruiter / Squad Builder /
--     Club Builder at 1 / 5 / 10 rewarded referrals (Pickleague's badge
--     mechanism, so each badge also brings its usual +150 pickles and a
--     notification), plus +2500 bonus pickles at exactly 5 and +5000 at
--     exactly 10.
--   * Notifications through _notify_user to both sides ('shop' link, like the
--     first-match bonus).
--   * Guests (anonymous sign-ins) never qualify: claim_referral answers
--     {linked:false, reason:'guest'} and the app keeps the code for after the
--     upgrade, when it rides in on the new email's metadata.
--   * referral_preview(code), anon-callable, for the web invite landing (the
--     referrer's first name and avatar only).
--   * my_referral_code() / my_referral_stats() for the Invite & Earn panel.
--   * Daily nudge (pg_cron, 17:00 UTC): an invitee linked 1 to 14 days ago
--     whose email is still unconfirmed gets ONE notification, "Confirm your
--     email to get 2500 pickles" (referrals.nudged_at is the dedupe).
--   * deferred_invite_clicks (Doggle 0348): salted IP-hash rows written by the
--     record-invite-click edge function and consumed by claim-deferred-invite,
--     so a friend who taps a link in a browser and then installs the app is
--     still attributed. No client access at all (RLS on, no policies); rows
--     older than 24 h are purged hourly.
--
-- Idempotent; no top-level transaction. Client RPCs are in the allowlist of
-- migration_rls_hardening_2026q3.sql. Apply with:
--   supabase db query --linked -f supabase/migration_referrals.sql

-- ── 1. Columns on profiles ────────────────────────────────────────────────
alter table public.profiles
  add column if not exists referral_code text
  default substr(md5(random()::text || clock_timestamp()::text), 1, 10);
alter table public.profiles
  add column if not exists invited_by uuid references public.profiles(id) on delete set null;

-- Backfill (a no-op after the volatile default above, kept for re-runs on a
-- database where the column was added without one).
update public.profiles
   set referral_code = substr(md5(random()::text || id::text || clock_timestamp()::text), 1, 10)
 where referral_code is null;

create unique index if not exists profiles_referral_code_uq on public.profiles (lower(referral_code));

-- Clients may never write either column (claim_referral and the auth trigger
-- are SECURITY DEFINER, so they run as the owner and pass through). This one
-- is deliberately SECURITY INVOKER: it has to see the caller's role.
create or replace function public._pl_profiles_referral_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated') then
    new.referral_code := old.referral_code;
    new.invited_by := old.invited_by;
  end if;
  return new;
end;
$$;
revoke execute on function public._pl_profiles_referral_guard() from public, anon, authenticated;

drop trigger if exists trg_profiles_referral_guard on public.profiles;
create trigger trg_profiles_referral_guard
  before update of referral_code, invited_by on public.profiles
  for each row execute function public._pl_profiles_referral_guard();

-- ── 2. The referrals table ────────────────────────────────────────────────
create table if not exists public.referrals (
  id               uuid primary key default gen_random_uuid(),
  referrer_id      uuid not null references public.profiles(id) on delete cascade,
  invitee_id       uuid not null unique references public.profiles(id) on delete cascade,
  created_at       timestamptz not null default now(),
  rewarded_at      timestamptz,
  -- What the payout gave each side (base + any milestone bonus for the
  -- referrer), so the stats never have to re-derive old amounts.
  referrer_pickles integer not null default 0,
  invitee_pickles  integer not null default 0,
  -- The one "confirm your email" nudge.
  nudged_at        timestamptz,
  constraint referrals_not_self check (referrer_id <> invitee_id)
);
alter table public.referrals add column if not exists referrer_pickles integer not null default 0;
alter table public.referrals add column if not exists invitee_pickles integer not null default 0;
alter table public.referrals add column if not exists nudged_at timestamptz;
create index if not exists referrals_referrer_idx on public.referrals (referrer_id);

alter table public.referrals enable row level security;
drop policy if exists referrals_select_own on public.referrals;
create policy referrals_select_own on public.referrals
  for select to authenticated
  using (referrer_id = (select auth.uid()) or invitee_id = (select auth.uid()));
-- No insert/update/delete policies: every write goes through the functions below.

-- ── 3. Milestone badges ───────────────────────────────────────────────────
insert into public.badges (name, description, icon, category, criteria, sort_order) values
  ('Recruiter',     'Invited a friend who joined Pickleague.',  '📣', 'profile', '{"type": "referrals", "min": 1}',  50),
  ('Squad Builder', 'Invited 5 friends who joined Pickleague.', '👥', 'profile', '{"type": "referrals", "min": 5}',  51),
  ('Club Builder',  'Invited 10 friends who joined Pickleague.', '🏟️', 'profile', '{"type": "referrals", "min": 10}', 52)
on conflict (name) do nothing;

-- ── 4. Pay a pending referral (internal) ──────────────────────────────────
-- Returns true when this call paid. Pays only a real (non-anonymous) invitee
-- with a confirmed email; the rewarded_at UPDATE is the single gate, so a
-- second call or a race pays nothing.
create or replace function public._pl_pay_referral_reward(p_invitee uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_base      constant integer := 2500;
  v_qualifies boolean;
  v_id        uuid;
  v_ref       uuid;
  v_count     integer;
  v_bonus     integer := 0;
  v_inv_name  text;
  v_ref_name  text;
begin
  if p_invitee is null then return false; end if;

  select not coalesce(u.is_anonymous, false) and u.email_confirmed_at is not null
    into v_qualifies
    from auth.users u
   where u.id = p_invitee;
  if not coalesce(v_qualifies, false) then return false; end if;

  update public.referrals
     set rewarded_at = now()
   where invitee_id = p_invitee and rewarded_at is null
  returning id, referrer_id into v_id, v_ref;
  if v_ref is null then return false; end if;  -- nothing pending

  select count(*) into v_count
    from public.referrals
   where referrer_id = v_ref and rewarded_at is not null;
  v_bonus := case when v_count = 5 then 2500 when v_count = 10 then 5000 else 0 end;

  update public.profiles set pickles = coalesce(pickles, 0) + c_base + v_bonus where id = v_ref;
  update public.profiles set pickles = coalesce(pickles, 0) + c_base where id = p_invitee;
  update public.referrals
     set referrer_pickles = c_base + v_bonus, invitee_pickles = c_base
   where id = v_id;

  -- Badges (each also brings the usual +150 and its own notification).
  begin
    if v_count >= 1 then
      perform public._maybe_award_profile_badge(v_ref, 'Recruiter', '1 friend joined');
    end if;
    if v_count >= 5 then
      perform public._maybe_award_profile_badge(v_ref, 'Squad Builder', '5 friends joined');
    end if;
    if v_count >= 10 then
      perform public._maybe_award_profile_badge(v_ref, 'Club Builder', '10 friends joined');
    end if;
  exception when others then null;
  end;

  select coalesce(nullif(split_part(trim(full_name), ' ', 1), ''), 'A friend') into v_inv_name
    from public.profiles where id = p_invitee;
  select coalesce(nullif(split_part(trim(full_name), ' ', 1), ''), 'your friend') into v_ref_name
    from public.profiles where id = v_ref;

  begin
    perform public._notify_user(
      v_ref,
      format('🥒 +%s pickles: %s joined with your link', c_base + v_bonus, coalesce(v_inv_name, 'A friend')),
      case
        when v_bonus > 0 then format(
          '%s joined Pickleague with your invite, so you both got %s pickles. That is %s friends: +%s bonus pickles too!',
          coalesce(v_inv_name, 'A friend'), c_base, v_count, v_bonus)
        else format(
          '%s joined Pickleague with your invite, so you both got %s pickles. Tap to spend them in the Shop.',
          coalesce(v_inv_name, 'A friend'), c_base)
      end,
      v_ref,
      'shop'
    );
    perform public._notify_user(
      p_invitee,
      format('🥒 +%s pickles for joining with %s''s link', c_base, coalesce(v_ref_name, 'your friend')),
      format('You and %s both got %s pickles. Tap to spend yours in the Shop.', coalesce(v_ref_name, 'your friend'), c_base),
      p_invitee,
      'shop'
    );
  exception when others then null;
  end;

  return true;
end;
$$;
revoke execute on function public._pl_pay_referral_reward(uuid) from public, anon, authenticated;

-- ── 5. Link an invitee to a referrer (internal) ───────────────────────────
-- Every guard except "who is calling": claim_referral() adds that, the auth
-- trigger passes the new account. Never raises for a refusal; answers
-- {linked, reason?, referrer_name?, rewarded?}. An invitee already linked to
-- the SAME referrer gets linked:true, already:true (the app's sign-in claim
-- after a sign-up that carried the code in its metadata).
create or replace function public._pl_link_referral(p_invitee uuid, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code     text := lower(trim(coalesce(p_code, '')));
  v_ref      uuid;
  v_name     text;
  v_existing record;
  v_created  timestamptz;
  v_n        bigint := 0;
  v_paid     boolean := false;
begin
  if p_invitee is null then return jsonb_build_object('linked', false, 'reason', 'signed_out'); end if;
  if v_code = '' or length(v_code) > 64 then
    return jsonb_build_object('linked', false, 'reason', 'no_code');
  end if;

  select p.id, coalesce(nullif(split_part(trim(p.full_name), ' ', 1), ''), 'A friend')
    into v_ref, v_name
    from public.profiles p
   where lower(p.referral_code) = v_code
     and p.deleted_at is null
     and not p.is_unclaimed
   limit 1;
  if v_ref is null then return jsonb_build_object('linked', false, 'reason', 'unknown_code'); end if;
  if v_ref = p_invitee then return jsonb_build_object('linked', false, 'reason', 'self'); end if;

  select referrer_id, rewarded_at into v_existing
    from public.referrals where invitee_id = p_invitee;
  if found then
    if v_existing.referrer_id = v_ref then
      return jsonb_build_object('linked', true, 'already', true, 'referrer_name', v_name,
                                'rewarded', v_existing.rewarded_at is not null);
    end if;
    return jsonb_build_object('linked', false, 'reason', 'already_referred');
  end if;

  select created_at into v_created from public.profiles where id = p_invitee;
  if v_created is null then return jsonb_build_object('linked', false, 'reason', 'no_profile'); end if;
  if v_created < now() - interval '30 days' then
    return jsonb_build_object('linked', false, 'reason', 'too_old');
  end if;

  insert into public.referrals (referrer_id, invitee_id)
  values (v_ref, p_invitee)
  on conflict (invitee_id) do nothing;
  get diagnostics v_n = row_count;
  if v_n = 0 then return jsonb_build_object('linked', false, 'reason', 'already_referred'); end if;

  update public.profiles set invited_by = v_ref where id = p_invitee and invited_by is null;

  -- Already confirmed (the usual case for a claim from the app): pay now.
  v_paid := public._pl_pay_referral_reward(p_invitee);

  return jsonb_build_object('linked', true, 'referrer_name', v_name, 'rewarded', v_paid);
end;
$$;
revoke execute on function public._pl_link_referral(uuid, text) from public, anon, authenticated;

-- ── 6. Client RPCs ────────────────────────────────────────────────────────
-- The caller's referral code (minted if somehow missing).
create or replace function public.my_referral_code()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_code text;
begin
  if v_uid is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;
  select referral_code into v_code from public.profiles where id = v_uid;
  if v_code is null then
    update public.profiles
       set referral_code = substr(md5(random()::text || id::text || clock_timestamp()::text), 1, 10)
     where id = v_uid
    returning referral_code into v_code;
  end if;
  return v_code;
end;
$$;
revoke execute on function public.my_referral_code() from public, anon;
grant execute on function public.my_referral_code() to authenticated;

-- Link the caller to the code's owner (and pay at once when the caller's email
-- is already confirmed). Guests are refused with reason 'guest'.
create or replace function public.claim_referral(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_anon boolean;
begin
  if v_uid is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;

  select coalesce(u.is_anonymous, false) into v_anon from auth.users u where u.id = v_uid;
  if coalesce(v_anon, true)
     or coalesce((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'is_anonymous')::boolean, false) then
    return jsonb_build_object('linked', false, 'reason', 'guest');
  end if;

  return public._pl_link_referral(v_uid, p_code);
end;
$$;
revoke execute on function public.claim_referral(text) from public, anon;
grant execute on function public.claim_referral(text) to authenticated;

-- Public invite-landing teaser (called signed out by the web page).
create or replace function public.referral_preview(p_code text)
returns json
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_code text := lower(trim(coalesce(p_code, '')));
  v_row  record;
begin
  if v_code = '' or length(v_code) > 64 then return null; end if;
  select coalesce(nullif(split_part(trim(p.full_name), ' ', 1), ''), 'A friend') as first_name,
         p.avatar_url, p.avatar_emoji, p.avatar_bg_color
    into v_row
    from public.profiles p
   where lower(p.referral_code) = v_code
     and p.deleted_at is null
     and not p.is_unclaimed
   limit 1;
  if not found then return null; end if;
  return json_build_object(
    'referrer_name',   v_row.first_name,
    'avatar_url',      v_row.avatar_url,
    'avatar_emoji',    v_row.avatar_emoji,
    'avatar_bg_color', v_row.avatar_bg_color
  );
end;
$$;
revoke execute on function public.referral_preview(text) from public;
grant execute on function public.referral_preview(text) to anon, authenticated;

-- The Invite & Earn counters: invited (linked), joined (rewarded), pending,
-- and every referral pickle the caller got (as referrer, plus their own
-- welcome if they were invited).
create or replace function public.my_referral_stats()
returns json
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_invited integer;
  v_joined  integer;
  v_pickles integer;
begin
  if v_uid is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;

  select count(*), count(*) filter (where rewarded_at is not null), coalesce(sum(referrer_pickles), 0)
    into v_invited, v_joined, v_pickles
    from public.referrals
   where referrer_id = v_uid;

  v_pickles := v_pickles + coalesce(
    (select invitee_pickles from public.referrals where invitee_id = v_uid), 0);

  return json_build_object(
    'invited', v_invited,
    'joined', v_joined,
    'pending', v_invited - v_joined,
    'pickles_earned', v_pickles
  );
end;
$$;
revoke execute on function public.my_referral_stats() from public, anon;
grant execute on function public.my_referral_stats() to authenticated;

-- ── 7. Auth triggers: link from metadata, pay on confirmation ─────────────
create or replace function public._pl_referral_on_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
begin
  begin
    if not coalesce(new.is_anonymous, false) then
      v_code := nullif(trim(coalesce(new.raw_user_meta_data ->> 'referral_code', '')), '');
      if v_code is not null
         and not exists (select 1 from public.referrals r where r.invitee_id = new.id) then
        perform public._pl_link_referral(new.id, v_code);  -- pays too, when confirmed
      end if;
      if new.email_confirmed_at is not null then
        perform public._pl_pay_referral_reward(new.id);
      end if;
    end if;
  exception when others then
    -- Never block a sign-up, sign-in or confirmation over a referral.
    raise warning 'referral payout skipped for %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;
revoke execute on function public._pl_referral_on_auth_user() from public, anon, authenticated;

-- Named to sort after on_auth_user_created (same event, alphabetical order),
-- so the profile row exists first.
drop trigger if exists pl_referrals_on_auth_user_insert on auth.users;
create trigger pl_referrals_on_auth_user_insert
  after insert on auth.users
  for each row execute function public._pl_referral_on_auth_user();

drop trigger if exists pl_referrals_on_auth_user_confirm on auth.users;
create trigger pl_referrals_on_auth_user_confirm
  after update of email_confirmed_at, is_anonymous on auth.users
  for each row
  when ((old.email_confirmed_at is null and new.email_confirmed_at is not null)
        or (coalesce(old.is_anonymous, false) and not coalesce(new.is_anonymous, false)))
  execute function public._pl_referral_on_auth_user();

-- ── 8. The daily "confirm your email" nudge ───────────────────────────────
create or replace function public.notify_stalled_referral_invitees()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r   record;
  v_n integer := 0;
begin
  for r in
    select ref.id, ref.invitee_id
      from public.referrals ref
      join auth.users u on u.id = ref.invitee_id
     where ref.rewarded_at is null
       and ref.nudged_at is null
       and u.email_confirmed_at is null
       and ref.created_at between now() - interval '14 days' and now() - interval '1 day'
  loop
    update public.referrals set nudged_at = now() where id = r.id and nudged_at is null;
    if found then
      perform public._notify_user(
        r.invitee_id,
        '🥒 Confirm your email to get 2500 pickles',
        'You joined with a friend''s invite. Confirm your email and you both get 2500 pickles.',
        r.invitee_id,
        'home'
      );
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;
revoke execute on function public.notify_stalled_referral_invitees() from public, anon, authenticated;

-- ── 9. Deferred invite clicks (Doggle 0348) ───────────────────────────────
-- A friend taps an invite link, the web landing stashes the code in the
-- BROWSER's storage, then they install the app, which has its own storage and
-- never sees it. record-invite-click stores sha256(ip|salt) + code; on first
-- sign-in the app asks claim-deferred-invite, which answers the code only when
-- exactly one code matches this network and platform in the last 2 hours
-- (ambiguity loses: crediting the wrong referrer is worse than nobody). The
-- salt lives in the edge-function secret INVITE_CLICK_SALT, never here.
create table if not exists public.deferred_invite_clicks (
  id          uuid primary key default gen_random_uuid(),
  code        text not null,
  ip_hash     text not null,
  platform    text,              -- 'ios' / 'android' / 'other' only
  created_at  timestamptz not null default now(),
  claimed_at  timestamptz,
  claimed_by  uuid references auth.users(id) on delete set null
);
create index if not exists deferred_invite_clicks_lookup_idx
  on public.deferred_invite_clicks (ip_hash, created_at desc)
  where claimed_at is null;
-- Clients never touch it (both edge functions use the service role): RLS on,
-- no policies, and no table grants beyond the service role.
alter table public.deferred_invite_clicks enable row level security;
revoke all on table public.deferred_invite_clicks from anon, authenticated;

create or replace function public.purge_deferred_invite_clicks()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare v_n integer;
begin
  delete from public.deferred_invite_clicks where created_at < now() - interval '24 hours';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke execute on function public.purge_deferred_invite_clicks() from public, anon, authenticated;

-- ── 10. Schedules ─────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'pickleague-referral-nudges') then
      perform cron.unschedule('pickleague-referral-nudges');
    end if;
    perform cron.schedule('pickleague-referral-nudges', '0 17 * * *',
      $c$ select public.notify_stalled_referral_invitees(); $c$);

    if exists (select 1 from cron.job where jobname = 'pickleague-purge-invite-clicks') then
      perform cron.unschedule('pickleague-purge-invite-clicks');
    end if;
    perform cron.schedule('pickleague-purge-invite-clicks', '35 * * * *',
      $c$ select public.purge_deferred_invite_clicks(); $c$);
  end if;
end $$;

notify pgrst, 'reload schema';
