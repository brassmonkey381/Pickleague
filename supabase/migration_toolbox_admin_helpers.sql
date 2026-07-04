-- Toolbox admin helpers — SERVICE ROLE ONLY.
--
-- The Migrations toolbox tool needs two capabilities PostgREST doesn't expose:
--   1. reading every function definition (pg_get_functiondef over pg_proc) to
--      diff repo migration files against what's actually live, and
--   2. executing migration SQL (DDL) without a direct Postgres connection.
--
-- Both are locked to service_role: EXECUTE is revoked from public/anon/
-- authenticated (consistent with the 2026-07 RPC lockdown), so they are
-- unreachable with the anon key or any user JWT. The service-role key already
-- grants full data access; these extend it to DDL for local tooling use only.
--
-- Idempotent: create or replace + explicit grants.

-- ── 1. List every public function's definition ─────────────────────────────
create or replace function public.admin_list_function_defs()
returns table (name text, sig text, def text)
language sql
security definer
set search_path = public
as $$
  select p.proname::text,
         p.oid::regprocedure::text,
         pg_get_functiondef(p.oid)
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind = 'f';
$$;

revoke execute on function public.admin_list_function_defs() from public, anon, authenticated;
grant execute on function public.admin_list_function_defs() to service_role;

-- ── 2. Execute migration SQL ────────────────────────────────────────────────
create or replace function public.admin_execute_sql(p_sql text)
returns void
language plpgsql
security definer
as $$
begin
  execute p_sql;
end $$;

revoke execute on function public.admin_execute_sql(text) from public, anon, authenticated;
grant execute on function public.admin_execute_sql(text) to service_role;
