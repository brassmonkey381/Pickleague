-- Regression fix from the 2026-07 RPC lockdown: functions referenced inside
-- RLS POLICY expressions execute with the CALLING role's privileges, so
-- revoking EXECUTE from anon/authenticated broke every statement guarded by
-- those policies ("permission denied for function is_expired_guest" on
-- event_slot_votes inserts — i.e. all event voting). Found by the toolbox
-- guest-flow scenario.
--
-- Rule for the allowlist going forward: any function referenced by an RLS
-- policy must keep EXECUTE for anon + authenticated, even if clients never
-- call it via /rpc.

grant execute on function public.is_expired_guest(uuid) to anon, authenticated;
grant execute on function public.is_scope_admin(text, uuid) to anon, authenticated;
