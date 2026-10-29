import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  PLAN_MAX_DAYS,
  canPlanLaterToday,
  cancelledMessage,
  defaultPlanAt,
  movedMessage,
  moveSlots,
  nextSlotMs,
  parseCourtPlans,
  planDayTime,
  planEditWindows,
  planInPlay,
  planPickerTitle,
  planTimeProblem,
  planWhen,
  plannedMessage,
  plansAtCourt,
  slotPickerEmptyText,
  todayPlanSlots,
  tomorrowPlanSlots,
} from '../courtPlans';
import { REFUSAL_CODES, refusalMessage } from '../refusals';
import { checkinOptionIds } from '../checkinOptions';

// Thu Oct 22 2026, 3:07 PM local.
const NOW = new Date(2026, 9, 22, 15, 7).getTime();
const local = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m).getTime();
const iso = (day: number, h: number, m = 0) => new Date(local(day, h, m)).toISOString();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const readRepo = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('list_my_court_plans', () => {
  it('parses rows, in time order, kept ones marked', () => {
    const list = parseCourtPlans([
      { plan_id: 'b', venue_id: 'v2', venue_name: 'Two', planned_at: iso(23, 9), planned_end_at: iso(23, 11), status: 'planned', starred: true, lat: 1, lng: 2 },
      { plan_id: 'a', venue_id: 'v1', venue_name: 'One', planned_at: iso(22, 18), planned_end_at: iso(22, 20), status: 'completed' },
    ]);
    expect(list.map((p) => [p.planId, p.status, p.starred])).toEqual([
      ['a', 'completed', false],
      ['b', 'planned', true],
    ]);
    expect(list[1]).toMatchObject({ venueId: 'v2', venueName: 'Two', lat: 1, lng: 2, plannedEndAt: iso(23, 11) });
  });

  it('drops rows with no id, court or time; fills a missing end (2 hours) and name', () => {
    const list = parseCourtPlans([
      null,
      { venue_id: 'v', planned_at: iso(22, 18) },
      { plan_id: 'x', planned_at: iso(22, 18) },
      { plan_id: 'y', venue_id: 'v', planned_at: 'not a time' },
      { plan_id: 'z', venue_id: 'v', planned_at: iso(22, 18) },
    ]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ planId: 'z', venueName: 'A court', plannedEndAt: iso(22, 20), status: 'planned' });
    expect(parseCourtPlans(null)).toEqual([]);
    expect(parseCourtPlans({})).toEqual([]);
  });

  it('reads length and windows (migration_plan_options.sql), Drill included; an older server: from the end, no windows', () => {
    const [p] = parseCourtPlans([
      {
        plan_id: 'd', venue_id: 'v', planned_at: iso(22, 17), planned_end_at: iso(22, 20), length_min: 180,
        windows: [
          { starts_at: iso(22, 17), ends_at: iso(22, 18), mode: 'drill', hint: null, group: [] },
          { starts_at: iso(22, 18), ends_at: iso(22, 20), mode: 'open', hint: 'all_levels', group: [] },
          { starts_at: iso(22, 20), ends_at: iso(22, 21), mode: 'nap', hint: null, group: [] },
        ],
      },
    ]);
    expect(p.lengthMin).toBe(180);
    expect(p.windows.map((w) => w.mode)).toEqual(['drill', 'open', null]);
    expect(planEditWindows(p).slice(0, 2)).toEqual([
      expect.objectContaining({ startMin: 0, endMin: 60, mode: 'drill' }),
      expect.objectContaining({ startMin: 60, endMin: 180, mode: 'open', hint: 'all_levels' }),
    ]);
    const [old] = parseCourtPlans([{ plan_id: 'o', venue_id: 'v', planned_at: iso(22, 17), planned_end_at: iso(22, 18, 30) }]);
    expect(old).toMatchObject({ lengthMin: 90, windows: [] });
    expect(planEditWindows(old)).toEqual([]);
  });

  it('nothing said: the editor starts empty (one window, not set)', () => {
    const [p] = parseCourtPlans([
      { plan_id: 'n', venue_id: 'v', planned_at: iso(22, 17), planned_end_at: iso(22, 19),
        windows: [{ starts_at: iso(22, 17), ends_at: iso(22, 19), mode: null }] },
    ]);
    expect(planEditWindows(p)).toEqual([]);
  });

  it('a plan is in play until 30 minutes past its time, and never once kept', () => {
    expect(planInPlay({ status: 'planned', plannedAt: iso(22, 14, 40) }, NOW)).toBe(true);
    expect(planInPlay({ status: 'planned', plannedAt: iso(22, 14, 37) }, NOW)).toBe(false);
    expect(planInPlay({ status: 'completed', plannedAt: iso(22, 18) }, NOW)).toBe(false);
  });
});

describe('the pickers (Doggle: 15-minute slots)', () => {
  it('the next slot is the next quarter hour at least a minute away', () => {
    expect(nextSlotMs(NOW)).toBe(local(22, 15, 15));
    expect(nextSlotMs(local(22, 15, 14))).toBe(local(22, 15, 15));
    expect(nextSlotMs(local(22, 15, 14) + 30_000)).toBe(local(22, 15, 30));
    expect(nextSlotMs(local(22, 15, 0))).toBe(local(22, 15, 15));
  });

  it("today: from the next slot to 11:45 PM; none left at 11:50 PM", () => {
    const s = todayPlanSlots(NOW);
    expect(s[0]).toEqual({ id: iso(22, 15, 15), name: '3:15 PM' });
    expect(s[s.length - 1]).toEqual({ id: iso(22, 23, 45), name: '11:45 PM' });
    expect(s).toHaveLength(35);
    expect(canPlanLaterToday(NOW)).toBe(true);
    expect(canPlanLaterToday(local(22, 23, 50))).toBe(false);
    expect(todayPlanSlots(local(22, 23, 50))).toEqual([]);
  });

  it('tomorrow: 6 AM to 11:45 PM', () => {
    const s = tomorrowPlanSlots(NOW);
    expect(s[0]).toEqual({ id: iso(23, 6), name: '6 AM' });
    expect(s[s.length - 1].id).toBe(iso(23, 23, 45));
    expect(s).toHaveLength(72);
  });

  it("Change time: the plan's own day from the next slot, its own time listed", () => {
    const today = moveSlots(iso(22, 18, 10), NOW);
    expect(today[0].id).toBe(iso(22, 15, 15));
    expect(today.some((x) => x.id === iso(22, 18, 10))).toBe(true);
    expect(today[today.length - 1].id).toBe(iso(22, 23, 45));
    const sat = moveSlots(iso(24, 9), NOW);
    expect(sat[0].id).toBe(iso(24, 0));
    expect(sat).toHaveLength(96);
    expect(moveSlots('nope', NOW)).toEqual([]);
  });

  it("the court page's picker starts 45 minutes out, snapped to the NEAREST quarter hour (Doggle's defaultPlannedTime)", () => {
    // 3:07 PM + 45 min = 3:52 PM -> 3:45 PM (Doggle: snapToMinuteInterval rounds, it doesn't round up).
    expect(defaultPlanAt(NOW).getTime()).toBe(local(22, 15, 45));
    const at = (h: number, m: number, s = 0) => defaultPlanAt(new Date(2026, 9, 22, h, m, s).getTime());
    // The web check: about 5:15 PM showed 6:15 PM; Doggle shows 6:00 PM.
    expect(at(17, 15)).toEqual(new Date(2026, 9, 22, 18, 0));
    expect(at(17, 16)).toEqual(new Date(2026, 9, 22, 18, 0));
    // Seconds don't count (Doggle reads getMinutes): 6:07:59 is 6:07, nearer 6:00.
    expect(at(17, 22, 59)).toEqual(new Date(2026, 9, 22, 18, 0));
    // Half way and past it: up.
    expect(at(17, 23)).toEqual(new Date(2026, 9, 22, 18, 15));
    expect(at(17, 38)).toEqual(new Date(2026, 9, 22, 18, 30));
    // Rounding into the next hour and the next day.
    expect(at(17, 8)).toEqual(new Date(2026, 9, 22, 18, 0));
    expect(at(23, 10)).toEqual(new Date(2026, 9, 23, 0, 0));
    // Always a quarter hour, seconds and milliseconds zero, at least 37.5 minutes out.
    for (let m = 0; m < 60; m++) {
      const nowMs = new Date(2026, 9, 22, 9, m, 30).getTime() + 123;
      const d = defaultPlanAt(nowMs);
      expect(d.getMinutes() % 15).toBe(0);
      expect(d.getSeconds()).toBe(0);
      expect(d.getMilliseconds()).toBe(0);
      expect(d.getTime() - nowMs).toBeGreaterThan(37 * 60_000);
    }
  });

  it('a picked time: later than now, at most 60 days out (the server says the same)', () => {
    expect(planTimeProblem(new Date(local(22, 15)), NOW)).toBe('Pick a time later than now for your check-in.');
    expect(planTimeProblem(new Date(local(22, 15, 30)), NOW)).toBeNull();
    expect(planTimeProblem(new Date(NOW + (PLAN_MAX_DAYS + 1) * 86_400_000), NOW)).toBe(
      'You can plan a check-in up to 60 days ahead. Pick an earlier day.',
    );
    expect(planTimeProblem(new Date(NaN), NOW)).not.toBeNull();
  });
});

describe('words', () => {
  it("Doggle's titles and toasts, no emoji", () => {
    expect(planPickerTitle('Lakeside', 'today')).toBe('Check in at Lakeside at');
    expect(planPickerTitle('Lakeside', 'tomorrow')).toBe('Check in at Lakeside tomorrow at');
    expect(plannedMessage('Lakeside', iso(22, 17, 30), NOW)).toBe('Planned a check-in at Lakeside for 5:30 PM.');
    expect(plannedMessage('Lakeside', iso(23, 9), NOW)).toBe('Planned a check-in at Lakeside for tomorrow at 9 AM.');
    expect(plannedMessage('Lakeside', iso(22 + 30, 9), NOW)).toBe('Planned a check-in at Lakeside for Nov 21 at 9 AM.');
    expect(movedMessage('Lakeside', iso(24, 18), NOW)).toBe('Moved your check-in at Lakeside to Sat at 6 PM.');
    expect(planWhen(iso(22, 18), NOW)).toBe('6 PM');
  });

  it('Cancel this visit names the time (Doggle: "Cancelled your 5:30 PM visit to X.")', () => {
    expect(cancelledMessage('Lakeside', iso(22, 17, 30), NOW)).toBe('Cancelled your 5:30 PM check-in at Lakeside.');
    expect(cancelledMessage('Lakeside', iso(23, 9), NOW)).toBe('Cancelled your check-in at Lakeside for tomorrow at 9 AM.');
    expect(cancelledMessage('Lakeside', iso(24, 18), NOW)).toBe('Cancelled your check-in at Lakeside for Sat at 6 PM.');
    expect(cancelledMessage('Lakeside', 'nope', NOW)).toBe('Cancelled your check-in at Lakeside.');
  });

  it("the court page's rows name the day", () => {
    expect(planDayTime(iso(22, 18), NOW)).toBe('Today at 6 PM');
    expect(planDayTime(iso(23, 9), NOW)).toBe('Tomorrow at 9 AM');
    expect(planDayTime(iso(24, 18, 30), NOW)).toBe('Sat at 6:30 PM');
    expect(planDayTime(iso(22 + 30, 9), NOW)).toBe('Nov 21 at 9 AM');
  });

  it("the slot pickers' empty line: none left today, or a search that matched nothing", () => {
    expect(slotPickerEmptyText('today', 0)).toBe("No times left today. Plan another day from the court's page.");
    expect(slotPickerEmptyText('today', 12)).toBe('No time matches. Try one like 5:30.');
    expect(slotPickerEmptyText('tomorrow', 72)).toBe('No time matches. Try one like 5:30.');
  });

  it('every visit refusal reads as what to do', () => {
    expect(refusalMessage({ message: 'x', hint: 'pl:visit.gone' })).toBe(
      "That planned check-in is over or was cancelled, so it can't be changed. Pull to refresh.",
    );
    expect(refusalMessage({ message: 'x', hint: 'pl:visit.limit' })).toBe(
      'You have 20 planned check-ins coming up. Cancel one to plan another.',
    );
    expect(refusalMessage({ message: 'x', hint: 'pl:court.gone' }, { action: 'plan_checkin', venueName: 'Lakeside' })).toBe(
      "Lakeside isn't in Pickleague any more, so you can't plan a check-in there. Find your court again.",
    );
    const taken = { message: 'x', hint: 'pl:visit.taken', details: JSON.stringify({ planned_at: iso(22, 18), routine: false }) };
    expect(refusalMessage(taken, { venueName: 'Lakeside', nowMs: NOW })).toBe(
      'You already plan to check in at Lakeside at 6 PM. Pick another time.',
    );
    const routine = { message: 'x', hint: 'pl:visit.taken', details: JSON.stringify({ planned_at: iso(22, 18), routine: true }) };
    expect(refusalMessage(routine, { venueName: 'Lakeside', nowMs: NOW })).toBe(
      "Your routine already has you at Lakeside at 6 PM. Pick another time, or change that stop's time.",
    );
    // A routine stop not made yet (days ahead): plan_id null, its day named.
    const ahead = { message: 'x', hint: 'pl:visit.taken', details: JSON.stringify({ plan_id: null, planned_at: iso(26, 8), routine: true }) };
    expect(refusalMessage(ahead, { venueName: 'Lakeside', nowMs: NOW })).toContain('Your routine already has you at Lakeside at Mon 8 AM.');
  });

  it("Undo skip / Change today's time next to a one-off plan (pl:plan.taken)", () => {
    const e = { message: 'x', hint: 'pl:plan.taken', details: JSON.stringify({ plan_id: 'p', planned_at: iso(22, 18, 3), routine: false }) };
    expect(refusalMessage(e, { venueName: 'Lakeside', nowMs: NOW })).toBe(
      'You already plan to check in at Lakeside at 6:03 PM. Pick another time, or cancel that check-in first.',
    );
  });
});

describe("the court page's list", () => {
  const plans = parseCourtPlans([
    { plan_id: 'far', venue_id: 'v1', venue_name: 'One', planned_at: iso(22 + 20, 9), status: 'planned' },
    { plan_id: 'soon', venue_id: 'v1', venue_name: 'One', planned_at: iso(22, 18), status: 'planned' },
    { plan_id: 'kept', venue_id: 'v1', venue_name: 'One', planned_at: iso(22, 15), status: 'completed' },
    { plan_id: 'past', venue_id: 'v1', venue_name: 'One', planned_at: iso(22, 14), status: 'planned' },
    { plan_id: 'other', venue_id: 'v2', venue_name: 'Two', planned_at: iso(23, 9), status: 'planned' },
  ]);

  it('every plan of mine there still in play, any day, in time order (the feed stops at 6 days)', () => {
    expect(plansAtCourt(plans, 'v1', NOW).map((p) => p.planId)).toEqual(['soon', 'far']);
    expect(plansAtCourt(plans, 'v3', NOW)).toEqual([]);
  });
});

describe('the server and the app agree', () => {
  const sql = readRepo('supabase/migration_court_oneoff_plans.sql');

  it('every pl: code the migration raises has app copy', () => {
    const codes = [...sql.matchAll(/hint = 'pl:([a-z_.]+)'/g)].map((m) => m[1]);
    expect(codes.length).toBeGreaterThan(0);
    for (const c of codes) expect(REFUSAL_CODES as readonly string[]).toContain(c);
  });

  it('the limits match: 15 minutes back, 60 days ahead, 20 plans, 30 minutes either side', () => {
    expect(sql).toMatch(/v_at < now\(\) - interval '15 minutes'/);
    expect(sql).toMatch(/v_at > now\(\) \+ interval '60 days'/);
    expect(sql).toMatch(/\) >= 20 then/);
    expect(sql).toMatch(/p_at - interval '30 minutes' and p_at \+ interval '30 minutes'/);
  });

  it("the reminder carries what lib/pushLinks opens the court with; I'm here's cap is the app's 3", () => {
    expect(sql).toContain("jsonb_build_object('kind', v_kind, 'plan_id', r.plan_id, 'venue_id', r.venue_id");
    expect(sql).toMatch(/'on_my_way_here' and t\.key <> v_venue\s+and t\.last_at > now\(\) - v_window\) >= 3 then/);
    expect(sql).toContain("'reason', 'limit'");
  });

  it('the four RPCs are on the hardening allowlist; p_here keeps the push the app routes', () => {
    const hard = readRepo('supabase/migration_rls_hardening_2026q3.sql');
    for (const fn of ['plan_court_checkin', 'move_court_plan', 'cancel_court_plan', 'list_my_court_plans', 'send_on_my_way']) {
      expect(hard).toContain(`'${fn}'`);
    }
    // kind on_my_way + venue_id: lib/pushLinks opens the court for "is at" too.
    expect(sql).toContain("jsonb_build_object('kind', 'on_my_way', 'here', true, 'venue_id', v_venue");
    expect(sql).toContain("'notifyFriendsOnTheWay', v_title, v_body, 'home/-'");
  });

  it("Plan a check-in for later only shows with a time to pick", () => {
    const ids = (canPlanLater: boolean) =>
      checkinOptionIds({ canOnMyWay: false, canRoutine: false, canTellFriends: false, canPlanLater });
    expect(ids(canPlanLaterToday(NOW))).toContain('planLater');
    expect(ids(canPlanLaterToday(local(22, 23, 50)))).not.toContain('planLater');
  });
});
