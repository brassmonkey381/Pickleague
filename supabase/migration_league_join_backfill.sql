-- ############################################################################
-- ##                                                                        ##
-- ##   DESTRUCTIVE — confirm with the owner before applying.                ##
-- ##   Run state/league-join-backfill-dryrun.sql first and review counts.   ##
-- ##                                                                        ##
-- ##   This DELETES rows from public.league_join_requests and               ##
-- ##   public.notifications (and, by ON DELETE CASCADE, their               ##
-- ##   public.push_outbox rows). There is no undo short of a backup.        ##
-- ##                                                                        ##
-- ############################################################################
--
-- One-off cleanup for the league membership audit (2026-10-14). Clears the
-- backlog that migration_league_join_resolution.sql now prevents:
--   1. join requests whose requester is already a member (D1)
--   2. admins' league_join_request notices with no pending request behind
--      them (D3)
--   3. league invite notices whose recipient is now a member (D4)
--
-- REQUIRES migration_league_join_resolution.sql applied first: step 1's
-- deletes fire trg_league_join_request_resolved, which clears those
-- requests' notices as well (step 2 catches whatever is left).
--
-- Run as the owner / service role (SQL editor), not under a user's RLS:
--   supabase db query --linked -f supabase/migration_league_join_backfill.sql

begin;

-- 1. Requests from people already in the league (any status).
delete from public.league_join_requests r
 where exists (select 1 from public.league_members m
                where m.league_id = r.league_id and m.user_id = r.user_id);

-- 2. Join-request notices with no matching pending request.
delete from public.notifications n
 where n.entity_type = 'league'
   and n.push_data ->> 'kind' = 'league_join_request'
   and not exists (select 1 from public.league_join_requests r
                    where r.league_id = n.entity_id
                      and r.status = 'pending'
                      and r.user_id::text = n.push_data ->> 'requester_id');

-- 3. League invite notices (push_data kind, or the pre-push_data title)
--    whose recipient is now a member of that league.
delete from public.notifications n
 where n.entity_type = 'league'
   and (n.push_data ->> 'kind' = 'league_invite'
        or (coalesce(n.push_data ->> 'kind', '') = '' and n.title like '🎟️ Invite:%'))
   and exists (select 1 from public.league_members m
                where m.league_id = n.entity_id and m.user_id = n.user_id);

commit;
