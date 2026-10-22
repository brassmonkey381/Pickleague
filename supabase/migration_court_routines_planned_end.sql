-- ============================================================
-- Routine check-ins: a check-in that keeps a routine occurrence also takes
-- its planned end. Follow-up to migration_court_routines.sql, from the user's
-- report of 2026-10-22 ("the split of closed / open time during a window does
-- not seem to work") and the review of the first fix (gap 1).
--
-- Before: trg_venue_checkins_plan_link (before insert on venue_checkins)
-- linked a location-confirmed check-in to the occurrence it starts in and
-- copied the occurrence's windows, but left planned_end_at null. On the web
-- (no geofence arrivals) every routine check-in is made by hand and lasted
-- the 2 hours the app asked for, so a 3-hour routine split closed 2 h / open
-- 1 h ended while still closed (live, rolled back: check-in until 10:41, open
-- play from 10:51). Nothing offered the rest: "Staying until" keys off
-- planned_end_at, and the web gets no push. With planned_end_at null,
-- set_checkin_plan also ran the windows to expires_at, so any save cut the
-- open part off.
--
-- Now: the link also sets planned_end_at to the occurrence's planned end, at
-- least 30 minutes after the check-in: the rule process_court_arrivals (B)
-- uses for an arrival, which puts no other cap on it (the 4-hour caps apply
-- when the check-in is extended to it: extend_checkin, set_checkin_plan). A
-- planned end already on the row is kept (process_court_arrivals sets
-- plan_id itself, so the link skips its rows anyway).
--
-- expires_at is NOT stretched to the planned end (decided 2026-10-22):
--   * Doggle (db/migrations/0443_routine_window_30.sql): _check_in_dog_place
--     links a check-in to its planned visit through
--     _link_checkin_to_matching_plan, which only marks the plan completed;
--     the check-in keeps its ordinary length. Doggle has no planned length.
--   * The user's decision 3 (migration_court_routines.sql header): an arrival
--     at a routine court lasts the ordinary arrival length, cut to the planned
--     end when that comes first; a later planned end is one tap away
--     ("Staying until 12 PM?", extend_checkin to it).
--   * set_checkin_plan stretches a check-in only to an end the player sends.
-- So a check-in made by hand lasts what the app asked for. The app asks for
-- the routine's length when a stop is due at that court, by hand and from a
-- notification's Check in (lib/courtCheckin manualCheckinMinutes: the routine
-- reminder's planned_end_at, else the routines copy), and the line under a
-- check-in offers "Stay until" while planned_end_at is later than expires_at
-- (CheckinPlanLine: the web's way to the open part, and an older build's
-- check-in's), up to what extend_checkin gives without a fix: least(planned
-- end, now + 4 h, coalesce(fix_at, checked_in_at) + 4 h) (stayUntilOffer;
-- asked for more, extend_checkin refuses with pl:checkin.needs_fix once that
-- cap is the end already). Persona checks: R15, R16
-- (tests/court_routines_personas.sql).
--
-- Replaced (same signature and attributes; execute stays revoked from
-- public, anon, authenticated; the trigger itself is unchanged):
--   _pl_checkin_link_plan  (migration_court_routines.sql) + planned_end_at
--
-- APPLY ORDER: after migration_court_routines.sql. RE-APPLY after any re-run
-- of migration_court_routines.sql: it puts the old body back
-- (build-court-routines-test.mjs and build-presence-test.mjs do this, and
-- state/server-batch2-apply.ps1 applies this file after it when present).
-- Re-runnable; no begin/commit.
--   supabase db query --linked -f supabase/migration_court_routines_planned_end.sql
-- ============================================================

create or replace function public._pl_checkin_link_plan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan uuid;
  v_occ  public.court_plans;
begin
  if new.plan_id is null and new.location_confirmed then
    v_plan := public._pl_routine_plan_at(new.user_id, new.venue_id, new.checked_in_at);
    if v_plan is not null then
      select * into v_occ from public.court_plans pl where pl.id = v_plan;
      new.plan_id := v_plan;
      if new.play_windows is null then
        new.play_windows := v_occ.windows;
      end if;
      -- process_court_arrivals' rule: the occurrence's end, at least 30
      -- minutes after the check-in. expires_at stays as asked (see above).
      if new.planned_end_at is null then
        new.planned_end_at := greatest(v_occ.planned_end_at, new.checked_in_at + interval '30 minutes');
      end if;
    end if;
  end if;
  return new;
end $$;
revoke all on function public._pl_checkin_link_plan() from public, anon, authenticated;
