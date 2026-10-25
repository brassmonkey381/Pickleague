import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { todaysUnconfirmed } from '@just-messin-around/expo-foundation/plans/rules';
import {
  PL_AUTO_SHARE_COPY,
  PL_DAILY_CONFIRM_COPY,
  friendPlanLine,
  parseFriendCourtPlans,
  planIsShared,
  planSheetShareHint,
  routineOccurrences,
  shareToggledMessage,
  stopIsShared,
} from '../planSharing';
import { parseCourtRoutine, type CourtRoutine } from '../courtRoutineRules';
import { parseCourtPlans } from '../courtPlans';
import { refusalCode, refusalMessage } from '../refusals';
import { linkOf } from '../pushLinks';

// Thu Oct 22 2026, 3 PM local.
const NOW = new Date(2026, 9, 22, 15, 0).getTime();
const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m).toISOString();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const readRepo = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

const occ = (planId: string, plannedAt: string, p: Record<string, unknown> = {}) => ({
  plan_id: planId,
  planned_at: plannedAt,
  planned_end_at: null,
  status: 'planned',
  windows: null,
  shared_at: null,
  share_source: null,
  ...p,
});

const routineRow = (p: Record<string, unknown> = {}): CourtRoutine =>
  parseCourtRoutine({
    id: 'r1',
    venue_id: 'v1',
    venue_name: 'Lakeside',
    starred: true,
    local_time: '18:00',
    days: 127,
    tz: 'America/New_York',
    length_min: 120,
    active: true,
    next: occ('p-today', at(22, 18)),
    occurrences: [occ('p-today', at(22, 18)), occ('p-tomorrow', at(23, 18), { shared_at: at(22, 9), share_source: 'auto' })],
    ...p,
  });

describe('reading the share columns', () => {
  it('a routine occurrence carries shared_at / share_source (unknown sources are null)', () => {
    const r = routineRow({
      occurrences: [occ('a', at(22, 18), { shared_at: at(22, 9), share_source: 'confirm' }), occ('b', at(23, 18), { share_source: 'weird' })],
    });
    expect(r.occurrences.map((o) => [o.sharedAt, o.shareSource])).toEqual([
      [at(22, 9), 'confirm'],
      [null, null],
    ]);
    // A server without migration_plan_sharing.sql sends neither: private.
    const old = parseCourtRoutine({ id: 'r', venue_id: 'v', occurrences: [{ plan_id: 'x', planned_at: at(22, 18), status: 'planned' }] });
    expect(old.occurrences[0].sharedAt).toBeNull();
    expect(old.occurrences[0].shareSource).toBeNull();
  });

  it('a one-off plan carries them too', () => {
    const [p, q] = parseCourtPlans([
      { plan_id: 'o1', venue_id: 'v', planned_at: at(22, 18), status: 'planned', shared_at: at(22, 9), share_source: 'plan' },
      { plan_id: 'o2', venue_id: 'v', planned_at: at(22, 19), status: 'planned', share_source: 'hidden' },
    ]);
    expect([p.sharedAt, p.shareSource, planIsShared(p)]).toEqual([at(22, 9), 'plan', true]);
    expect([q.sharedAt, q.shareSource, planIsShared(q)]).toEqual([null, 'hidden', false]);
  });
});

describe('routineOccurrences (the daily sheet adapter list)', () => {
  it('flattens occurrences and next once each, in time order, as routine plans in the routine zone', () => {
    const list = routineOccurrences([routineRow()]);
    expect(list.map((o) => o.id)).toEqual(['p-today', 'p-tomorrow']);
    expect(list[0]).toMatchObject({
      kind: 'routine',
      placeId: 'v1',
      placeName: 'Lakeside',
      tz: 'America/New_York',
      routineId: 'r1',
      venueId: 'v1',
      status: 'planned',
      sharedAt: null,
    });
    expect(list[1].shareSource).toBe('auto');
  });

  it('leaves out a dormant routine (court unstarred): friends could not see its stops', () => {
    expect(routineOccurrences([routineRow({ starred: false })])).toEqual([]);
  });

  it("feeds the foundation's todaysUnconfirmed: today's unshared stop only, and never with auto-share unknown or on", () => {
    const list = routineOccurrences([routineRow()]);
    expect(todaysUnconfirmed(list, { autoShare: false, now: NOW }).map((o) => o.id)).toEqual(['p-today']);
    expect(todaysUnconfirmed(list, { autoShare: null, now: NOW })).toEqual([]);
    expect(todaysUnconfirmed(list, { autoShare: true, now: NOW })).toEqual([]);
  });
});

describe('stopIsShared', () => {
  it('shared once the server says so, or predicted with auto-share on (never over Only you or a skip)', () => {
    expect(stopIsShared({ status: 'planned', sharedAt: at(22, 9), shareSource: 'confirm' }, false)).toBe(true);
    expect(stopIsShared({ status: 'planned', sharedAt: null, shareSource: null }, false)).toBe(false);
    expect(stopIsShared({ status: 'planned', sharedAt: null, shareSource: null }, true)).toBe(true);
    expect(stopIsShared({ status: 'planned', sharedAt: null, shareSource: 'hidden' }, true)).toBe(false);
    expect(stopIsShared({ status: 'cancelled', sharedAt: null, shareSource: null }, true)).toBe(false);
    expect(stopIsShared({ status: 'planned', sharedAt: null, shareSource: null }, null)).toBe(false);
  });
});

describe("friends' plans", () => {
  const row = (p: Record<string, unknown> = {}) => ({
    plan_id: 'fp1',
    user_id: 'u1',
    full_name: ' Sky ',
    avatar_url: null,
    avatar_emoji: '🦊',
    avatar_bg_color: '#fff',
    is_friend: true,
    is_close_friend: true,
    venue_id: 'v1',
    venue_name: 'Lakeside',
    lat: 37.8,
    lng: -122.2,
    planned_at: at(22, 18),
    planned_end_at: at(22, 20),
    kind: 'routine',
    ...p,
  });

  it('parses list_friend_court_plans defensively', () => {
    const list = parseFriendCourtPlans([
      row({ plan_id: 'b', planned_at: at(23, 9), kind: 'once', full_name: null, is_friend: false }),
      row(),
      row(), // duplicate id
      row({ plan_id: 'c', planned_at: 'nope' }),
      row({ plan_id: 'd', user_id: null }),
      null,
      'x',
    ]);
    expect(list.map((p) => p.planId)).toEqual(['fp1', 'b']);
    expect(list[0]).toMatchObject({
      ownerId: 'u1',
      ownerName: 'Sky',
      placeId: 'v1',
      placeName: 'Lakeside',
      kind: 'routine',
      isFriend: true,
      isCloseFriend: true,
      avatarEmoji: '🦊',
      lat: 37.8,
      endAt: at(22, 20),
    });
    expect(list[1]).toMatchObject({ ownerName: 'Player', kind: 'once', isFriend: false, isCloseFriend: true });
    expect(parseFriendCourtPlans(null)).toEqual([]);
    expect(parseFriendCourtPlans({})).toEqual([]);
  });

  it('says a line as "Sky" / "planned 6 PM · routine"', () => {
    expect(friendPlanLine({ ownerName: 'Sky', at: at(22, 18), kind: 'routine' }, NOW)).toEqual({
      title: 'Sky',
      meta: 'planned 6 PM · routine',
      a11y: 'Sky, planned 6 PM, routine',
    });
    expect(friendPlanLine({ ownerName: 'Sky', at: at(23, 9, 30), kind: 'once' }, NOW).meta).toBe('planned tomorrow 9:30 AM');
    expect(friendPlanLine({ ownerName: 'Sky', at: at(24, 18), kind: 'once' }, NOW).meta).toBe('planned Sat 6 PM');
  });
});

describe('copy', () => {
  it("the daily sheet says court and Pickleague's words", () => {
    expect(PL_DAILY_CONFIRM_COPY.placeNoun).toBe('court');
    expect(PL_DAILY_CONFIRM_COPY.title).toBe("Today's routine");
    expect(PL_DAILY_CONFIRM_COPY.intro?.(1)).toBe('Your friends see this stop once you confirm it.');
    expect(PL_DAILY_CONFIRM_COPY.intro?.(2)).toBe('Your friends see these stops once you confirm them.');
    expect(PL_AUTO_SHARE_COPY.label).toBe('Share my routine stops automatically');
  });

  it('the plan sheet and toggles', () => {
    expect(planSheetShareHint(true)).toBe('Friends who can see your plans see it.');
    expect(planSheetShareHint(false)).toBe('Only you see this planned check-in.');
    expect(shareToggledMessage(true, 'routine')).toBe('Shared this stop with your friends.');
    expect(shareToggledMessage(false, 'once')).toBe('Only you see this check-in now.');
  });
});

describe('the new RPCs refuse with codes the app already words', () => {
  const sql = readRepo('supabase/migration_plan_sharing.sql');
  // The message and hint each RPC raises, as the server sends them.
  const raised = (hint: string) => {
    const m = sql.match(new RegExp(`message = '((?:[^']|'')*)', hint = 'pl:${hint.replace('.', '\\.')}'`));
    return m ? m[1].replace(/''/g, "'") : null;
  };

  it.each(['auth.signed_out', 'request.bad', 'plan.gone', 'visit.gone'])('%s', (code) => {
    const message = raised(code);
    expect(message).not.toBeNull();
    const e = { message, hint: `pl:${code}` };
    expect(refusalCode(e)).toBe(code);
    expect(refusalMessage(e)).toBeTruthy();
  });

  it('plan.gone and visit.gone keep their existing copy', () => {
    expect(refusalMessage({ message: 'x', hint: 'pl:plan.gone' })).toBe(
      "That routine check-in is already over, so it can't be changed. Pull to refresh.",
    );
    expect(refusalMessage({ message: 'x', hint: 'pl:visit.gone' })).toBe(
      "That planned check-in is over or was cancelled, so it can't be changed. Pull to refresh.",
    );
  });
});

describe('the server half (migration_plan_sharing.sql) keeps its promises', () => {
  const sql = readRepo('supabase/migration_plan_sharing.sql');
  it('friend push reuses notifyFriendsOnTheWay with a 6 h throttle; visibility is named-only', () => {
    expect(sql).toContain("'notifyFriendsOnTheWay'");
    expect(sql).toContain("interval '6 hours'");
    expect(sql).toContain("_pl_can_see_presence(p_viewer, p_plan.user_id, 'plans') = 'named'");
  });
  it('one-off plans stay private unless the client asks (p_share default false)', () => {
    expect(sql).toMatch(/p_share\s+boolean\s+default\s+false/i);
  });
});

describe('push links', () => {
  it("a friend's plan opens the court", () => {
    expect(linkOf({ kind: 'friend_plan', venue_id: 'v1', deepLink: 'home/-' })).toBe('court/v1');
    expect(linkOf({ kind: 'friend_plan', deepLink: 'home/-' })).toBe('home/-');
  });
});
