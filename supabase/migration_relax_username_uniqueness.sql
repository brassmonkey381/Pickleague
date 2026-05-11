-- ============================================================
-- Relax username uniqueness:
--   - Email (auth.users.email) stays the only hard uniqueness gate.
--   - profiles.username is no longer unique — two people named
--     "John Smith" can both sign up.
--   - handle_new_user() now auto-suffixes the username (johnsmith,
--     johnsmith2, johnsmith3 ...) so display handles stay distinct
--     even without a DB-level constraint.
-- ============================================================

-- 1. Drop the unique constraint. The auto-generated name is
--    profiles_username_key, but be defensive about prior renames.
do $$
declare
  v_conname text;
begin
  select conname into v_conname
    from pg_constraint
   where conrelid = 'public.profiles'::regclass
     and contype  = 'u'
     and conkey   = (
       select array_agg(attnum)
         from pg_attribute
        where attrelid = 'public.profiles'::regclass
          and attname  = 'username'
     );
  if v_conname is not null then
    execute format('alter table public.profiles drop constraint %I', v_conname);
  end if;
end$$;

-- Drop any standalone unique index on username too (older migrations).
drop index if exists public.profiles_username_key;
drop index if exists public.profiles_username_idx;

-- Keep a non-unique index so lookups by handle stay fast.
create index if not exists profiles_username_lookup_idx
  on public.profiles (lower(username));

-- 2. Rewrite handle_new_user to auto-suffix collisions.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_base      text;
  v_candidate text;
  v_n         int := 1;
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

  insert into public.profiles (id, username, full_name)
  values (
    new.id,
    v_candidate,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1))
  );
  return new;
end;
$$;
