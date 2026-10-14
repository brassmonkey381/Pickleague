-- ############################################################################
-- ##                                                                        ##
-- ##   DESTRUCTIVE — confirm with the owner before applying.                ##
-- ##   Run the count queries below in a rolled-back transaction first.      ##
-- ##                                                                        ##
-- ##   This DELETES rows from public.notifications (and, by ON DELETE       ##
-- ##   CASCADE, their public.push_outbox rows and those rows'               ##
-- ##   public.push_deliveries). There is no undo short of a backup.         ##
-- ##                                                                        ##
-- ############################################################################
--
-- One-off cleanup (UI compaction plan, phase P3): delete notifications whose
-- target row no longer exists. notifications.entity_id has no foreign key, so
-- when a league, tournament, event, match or drill is deleted its notices stay
-- behind and open nothing. (Pending matches are deleted by the confirm-window
-- cron, so every expired "Match needs your team to confirm" notice is one.)
-- The app already greys these out and leaves them out of the bell
-- (lib/inboxRequests.ts TARGET_TABLES); this removes the backlog.
--
-- Plan rule (section 8 / 9): applied BEFORE the P3 merge to master, because
-- web deploys on merge. Run it as the owner / service role (the SQL editor):
-- it is not meant to run under a user's RLS.
--
-- Which rows count as orphaned, per entity_type (the SAME map the app uses):
--   'tournament' -> public.tournaments.id
--   'league'     -> public.leagues.id
--   'event'      -> public.league_events.id
--   'match'      -> public.matches.id
--   'drill'      -> public.drill_requests.id OR public.drill_sessions.id
--                   (a drill notice points at a request or a session; it is
--                   orphaned only when the id is in NEITHER table)
-- Never touched:
--   - entity_id IS NULL rows (e.g. refunds repointed to the Shop by
--     _repoint_deleted_scope_pushes, and info notices);
--   - refund receipts ("🥒 Pot refunded", "🥒 Ante refunded", "🥒 Subsidy
--     refunded": title contains 'refund'). They are written right before the
--     league / tournament is deleted, so older ones point at a deleted row, but
--     they are the user's only record that pickles came back. The app greys
--     them out (the page is gone) and keeps them;
--   - 'shop', 'shop_item', 'profile', 'plupr_history' (they point at the
--     recipient or the shop, not at a deletable row), 'wager', 'wager_on_me',
--     and any other / unknown entity_type.
--
-- ── Step 1: measure (paste into the SQL editor; nothing is kept) ──────────────
--
--   begin;
--
--   -- Orphans per entity_type (what this migration deletes):
--   select n.entity_type, count(*) as orphans
--     from public.notifications n
--    where n.entity_id is not null
--      and n.title not ilike '%refund%'
--      and (
--           (n.entity_type = 'tournament' and not exists (select 1 from public.tournaments    t  where t.id  = n.entity_id))
--        or (n.entity_type = 'league'     and not exists (select 1 from public.leagues        l  where l.id  = n.entity_id))
--        or (n.entity_type = 'event'      and not exists (select 1 from public.league_events  e  where e.id  = n.entity_id))
--        or (n.entity_type = 'match'      and not exists (select 1 from public.matches        m  where m.id  = n.entity_id))
--        or (n.entity_type = 'drill'      and not exists (select 1 from public.drill_requests dr where dr.id = n.entity_id)
--                                         and not exists (select 1 from public.drill_sessions ds where ds.id = n.entity_id))
--      )
--    group by n.entity_type
--    order by n.entity_type;
--
--   -- Totals BEFORE (write these three numbers down):
--   select count(*) as total_before from public.notifications;
--   select count(*) as orphans_before
--     from public.notifications n
--    where n.entity_id is not null
--      and n.title not ilike '%refund%'
--      and (
--           (n.entity_type = 'tournament' and not exists (select 1 from public.tournaments    t  where t.id  = n.entity_id))
--        or (n.entity_type = 'league'     and not exists (select 1 from public.leagues        l  where l.id  = n.entity_id))
--        or (n.entity_type = 'event'      and not exists (select 1 from public.league_events  e  where e.id  = n.entity_id))
--        or (n.entity_type = 'match'      and not exists (select 1 from public.matches        m  where m.id  = n.entity_id))
--        or (n.entity_type = 'drill'      and not exists (select 1 from public.drill_requests dr where dr.id = n.entity_id)
--                                         and not exists (select 1 from public.drill_sessions ds where ds.id = n.entity_id))
--      );
--   -- non_orphans_before = total_before - orphans_before
--
--   -- Then paste the two DELETE ... statements from Step 2 here (without
--   -- their own begin / commit), and measure AFTER, still inside the
--   -- transaction:
--   select count(*) as total_after from public.notifications;
--   -- Expect: total_after = total_before - orphans_before
--   --         (i.e. the non-orphan count is UNCHANGED), and re-running the
--   --         orphans query above returns 0 rows.
--
--   rollback;   -- <- ALWAYS rollback in Step 1.
--
-- ── Step 2: apply (only after the owner has confirmed the Step 1 numbers) ────

begin;

delete from public.notifications n
 where n.entity_id is not null
   and n.title not ilike '%refund%'
   and (
        (n.entity_type = 'tournament' and not exists (select 1 from public.tournaments    t  where t.id  = n.entity_id))
     or (n.entity_type = 'league'     and not exists (select 1 from public.leagues        l  where l.id  = n.entity_id))
     or (n.entity_type = 'event'      and not exists (select 1 from public.league_events  e  where e.id  = n.entity_id))
     or (n.entity_type = 'match'      and not exists (select 1 from public.matches        m  where m.id  = n.entity_id))
   );

delete from public.notifications n
 where n.entity_id is not null
   and n.title not ilike '%refund%'
   and n.entity_type = 'drill'
   and not exists (select 1 from public.drill_requests dr where dr.id = n.entity_id)
   and not exists (select 1 from public.drill_sessions ds where ds.id = n.entity_id);

commit;
