-- Profiles column guard: a player may edit their own profile, never the
-- columns the server owns (pickles, every rating, match counters, grant
-- flags, guest/claim state, ...).
--
-- The hole it closes (live on 2026-10-22): the policy "Users can update their
-- own profile" is USING (auth.uid() = id) with no column restriction, and
-- authenticated (and anon) hold UPDATE on every column. So any signed-in
-- player could PATCH /rest/v1/profiles?id=eq.<self> and set pickles = 1e9,
-- rating = 8, welcome_pickles_granted = false (and claim it again), ...
-- A column-level grant would not do: Supabase grants table-wide UPDATE, and
-- column revokes don't narrow a table grant.
--
-- What it does:
--   1. trg_profiles_column_guard, BEFORE INSERT OR UPDATE on public.profiles.
--      Only for client roles (current_user anon / authenticated). Server
--      code is untouched: every function that writes profiles is SECURITY
--      DEFINER owned by postgres (match triggers, confirm_match, purchases,
--      grants, payouts, referrals), so current_user there is the owner; edge
--      functions and scripts run as service_role.
--      * UPDATE: default-deny. Only the columns the app writes directly (the
--        allowlist below, audited 2026-10-22) may change; any other column
--        whose value changes (IS DISTINCT FROM, so a row sent back unchanged
--        still saves) is refused with HINT 'pl:profile.server_owned' and
--        DETAIL {"columns": [...]}. A column added later is server-owned
--        until it is added to the allowlist here.
--      * referral_code / invited_by stay with trg_profiles_referral_guard
--        (migration_referrals.sql), which silently keeps them: this guard
--        lets them through, and that trigger (it fires after this one, by
--        name) resets them. Its persona test R8 relies on that.
--      * INSERT: a client never creates a profile (handle_new_user does, as
--        definer), so any client-role insert is refused.
--   2. Grants: anon loses INSERT / UPDATE / DELETE on profiles, authenticated
--      loses INSERT / DELETE (no policy allows either, nothing in the app
--      uses them; account deletion is the _purge_account definer path).
--   3. player_location_ratings: the per-court rating table had the same hole
--      ("Users can manage own location ratings", FOR ALL, auth.uid() =
--      user_id): a player could write their own court rating, wins and
--      losses. Its only writer is _apply_court_plupr_for_match (definer);
--      the app only reads it. The policy goes, and anon / authenticated lose
--      INSERT / UPDATE / DELETE. Reads are unchanged.
--
-- Player-editable columns (who writes them):
--   EditProfileSheet: full_name, username, tagline, gender, selected_tags,
--     avatar_id, avatar_url, avatar_emoji, avatar_bg_color, badges_public
--   ProfileScreen / ShopScreen equip: avatar_emoji, avatar_bg_color,
--     name_color, list_name_style_id, profile_name_style_id; availability
--   DrillScreen: drilling_enabled, drill_availability, drill_shot_prefs,
--     drill_partner_prefs, drill_custom_tags
--
-- Idempotent; no top-level transaction. Tests:
-- supabase/tests/profiles_guard_personas.sql (build-profiles-guard-test.mjs).
-- Apply after migration_referrals.sql with:
--   supabase db query --linked -f supabase/migration_profiles_column_guard.sql

-- ── 1. The guard ────────────────────────────────────────────────────────────
-- SECURITY INVOKER on purpose: it has to see the caller's role.
create or replace function public._pl_profiles_column_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  c_editable constant text[] := array[
    -- profile basics (EditProfileSheet)
    'full_name', 'username', 'tagline', 'gender', 'selected_tags',
    'avatar_id', 'avatar_url', 'badges_public',
    -- equipped cosmetics (EditProfileSheet, ProfileScreen, ShopScreen)
    'avatar_emoji', 'avatar_bg_color', 'name_color',
    'list_name_style_id', 'profile_name_style_id',
    -- availability grid (ProfileScreen)
    'availability',
    -- drilling (DrillScreen)
    'drilling_enabled', 'drill_availability', 'drill_shot_prefs',
    'drill_partner_prefs', 'drill_custom_tags',
    -- kept unchanged by trg_profiles_referral_guard (silently)
    'referral_code', 'invited_by'
  ];
  v_new jsonb;
  v_old jsonb;
  v_bad text[];
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    raise exception using
      message = 'Your Pickleague profile is created when you sign up, so it can''t be created from the app.',
      detail  = '{"columns": ["*"]}',
      hint    = 'pl:profile.server_owned';
  end if;

  v_new := to_jsonb(new);
  v_old := to_jsonb(old);
  select array_agg(k order by k) into v_bad
    from jsonb_object_keys(v_new) as k
   where k <> all (c_editable)
     and v_new -> k is distinct from v_old -> k;

  if v_bad is not null then
    raise exception using
      message = 'Pickleague keeps this part of your profile up to date itself, so it can''t be changed from the app: '
                || array_to_string(v_bad, ', ') || '.',
      detail  = jsonb_build_object('columns', to_jsonb(v_bad))::text,
      hint    = 'pl:profile.server_owned';
  end if;
  return new;
end;
$$;
revoke execute on function public._pl_profiles_column_guard() from public, anon, authenticated;

drop trigger if exists trg_profiles_column_guard on public.profiles;
create trigger trg_profiles_column_guard
  before insert or update on public.profiles
  for each row execute function public._pl_profiles_column_guard();

-- ── 2. Grants on profiles ───────────────────────────────────────────────────
revoke insert, update, delete on public.profiles from anon;
revoke insert, delete on public.profiles from authenticated;

-- ── 3. player_location_ratings: server-written only ─────────────────────────
drop policy if exists "Users can manage own location ratings" on public.player_location_ratings;
revoke insert, update, delete on public.player_location_ratings from anon, authenticated;
