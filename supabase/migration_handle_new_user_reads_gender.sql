-- ============================================================
-- handle_new_user: read gender from auth user_metadata.
--
-- profiles.gender is NOT NULL with no default. The trigger only set
-- id, username, full_name — so any insert into auth.users that didn't
-- trigger an external UPDATE (e.g. the godmode edge function) blew up
-- at the trigger with a not-null violation.
--
-- Fix: pull gender from raw_user_meta_data with a sensible default of
-- 'prefer-not-to-say'. Username dedup logic is unchanged.
-- ============================================================

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_base      text;
  v_candidate text;
  v_n         int := 1;
  v_gender    text;
begin
  v_base := lower(regexp_replace(
              coalesce(new.raw_user_meta_data->>'username',
                       split_part(new.email, '@', 1)),
              '[^a-z0-9]', '', 'g'
            ));
  if length(coalesce(v_base, '')) = 0 then
    v_base := 'player';
  end if;

  v_candidate := v_base;
  while exists (select 1 from public.profiles where username = v_candidate) loop
    v_n := v_n + 1;
    v_candidate := v_base || v_n::text;
  end loop;

  v_gender := coalesce(new.raw_user_meta_data->>'gender', 'prefer-not-to-say');
  if v_gender not in ('male','female','other','prefer-not-to-say') then
    v_gender := 'prefer-not-to-say';
  end if;

  insert into public.profiles (id, username, full_name, gender)
  values (
    new.id,
    v_candidate,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    v_gender
  );
  return new;
end;
$$;
