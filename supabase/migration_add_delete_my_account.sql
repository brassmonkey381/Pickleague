-- ============================================================
-- Self-serve account deletion.
--
-- Lets the calling user delete their own auth.users row.  Because
-- profiles.id references auth.users(id) on delete cascade — and most
-- other tables reference profiles.id on delete cascade — removing
-- the auth row cleans up the profile and all dependent data
-- (matches, league memberships, registrations, notifications, etc).
--
-- Password re-verification is enforced client-side via
-- supabase.auth.signInWithPassword before calling this RPC.  We
-- still require auth.uid() here so an unauthenticated caller can
-- never invoke it.
-- ============================================================

create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  delete from auth.users where id = v_uid;
end;
$$;

revoke all on function public.delete_my_account() from public;
grant execute on function public.delete_my_account() to authenticated;
