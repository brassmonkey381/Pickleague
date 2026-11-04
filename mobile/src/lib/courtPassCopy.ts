// Court Pass words (Pickleague's monthly reward track, kit RewardTrack 1.94;
// docs/court-pass.md), ported from Doggle's lib/parkPassCopy. The kit's
// defaults are generic; this is where Pickleague's names go: the pass is the
// Court Pass, its XP is pickleballs.
//
// Import-free (types only), so vitest runs it without the kit installed
// (lib/__tests__/courtPassCopy.test.ts, which also pins the amounts below to
// the SQL that pays them).
//
// Premium is "coming soon" in v1 (expo-foundation docs/reward-track-plan.md).
// Nothing here may mention a price, buying, upgrading, a notify-me, a date for
// premium, the web, "unlocks when you upgrade" or "you would have earned". The
// test checks the premium strings for those words.
import type { RewardTrackCopy } from '@just-messin-around/expo-foundation/gamification/rewardTrack';

export const COURT_PASS_NAME = 'Court Pass';

/** The kit copy with Pickleague's XP word. Everything else keeps the kit default. */
export const COURT_PASS_COPY: Partial<RewardTrackCopy> = {
  units: 'pickleballs',
  unit: 'pickleball',
  lockedNextStep: () => 'Play matches, new opponents and tournaments, or check in and play, to earn pickleballs.',
  premiumComingSoonReason: 'The premium track is coming soon.',
};

export const COURT_PASS_PREMIUM_TITLE = 'Premium track coming soon';
export const COURT_PASS_PREMIUM_HINT = { collapsed: 'Tap to preview', expanded: 'Tap to hide' };
/** The detail sheet's line for a premium reward. */
export const COURT_PASS_PREMIUM_SHEET = 'Coming soon';

/** The intro under the screen title. */
export const COURT_PASS_INTRO =
  'Every month a new Court Pass opens. Earn pickleballs by playing matches, new opponents and tournaments, ' +
  'and each tier you reach pays out on its own. Everything you earn is yours to keep.';

/**
 * Today's pickleballs. `cap` is the server's me.daily_cap: null is no daily cap
 * (Brian, 2026-11-03, as Doggle 0501; every seeded pass is null). A number
 * (a pass given a cap in SQL) shows it, with the Pacific reset.
 */
export function courtPassDailyLine(todayXp: number, cap: number | null): string {
  if (cap == null) return `Today: ${Math.max(0, todayXp)} pickleballs.`;
  const today = Math.max(0, Math.min(todayXp, cap));
  return `Today: ${today} / ${cap} pickleballs. The pickleball day resets at midnight Pacific time.`;
}

/**
 * The screen's earned line. me.today_xp counts the Pacific day (the events'
 * xp_day), so "Today: N" is right only for a viewer whose clock reads Pacific
 * time; anyone else would see yesterday's number for hours after their own
 * midnight. They get the pass total instead, which is true in every zone.
 * A capped pass keeps its line: it names the Pacific reset itself.
 */
export function courtPassEarnedLine(
  me: { todayXp: number; xp: number; dailyCap: number | null },
  onPacificTime: boolean,
): string {
  if (me.dailyCap != null || onPacificTime) return courtPassDailyLine(me.todayXp, me.dailyCap);
  return `This Court Pass: ${Math.max(0, me.xp)} pickleballs.`;
}

/**
 * True when the device's wall clock reads Pacific time at `at` (same date,
 * hour and minute as America/Los_Angeles), so its "today" is the server's
 * xp_day. False when Intl can't tell (the pass-total line is safe anywhere).
 */
export function viewerOnPacificTime(at: Date = new Date()): boolean {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(at);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    return (
      get('year') === at.getFullYear() &&
      get('month') === at.getMonth() + 1 &&
      get('day') === at.getDate() &&
      get('hour') % 24 === at.getHours() &&
      get('minute') === at.getMinutes()
    );
  } catch {
    return false;
  }
}

/** "December 1" in the viewer's own zone and language. */
export function courtPassDate(iso: string, locale?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(locale, { month: 'long', day: 'numeric' });
}

/** The screen's line when no Court Pass is running. */
export function nextCourtPassLine(nextStartsAt: string | null, locale?: string): string {
  const date = nextStartsAt ? courtPassDate(nextStartsAt, locale) : '';
  return date ? `Next Court Pass starts ${date}` : 'The next Court Pass is on its way.';
}

/** "December" for a cycle's start, in the viewer's zone (the earlier-cycle payout toast). */
export function courtPassMonth(iso: string, locale?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(locale, { month: 'long' });
}

/**
 * The toast when a read paid tiers from an earlier cycle (reached before it
 * ended, paid on the next open). `cycleId` is 'YYYY-MM'.
 */
export function earlierRewardsToast(cycleId: string, locale?: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(cycleId);
  // Mid-month UTC, so no zone moves it into the next or previous month.
  const month = m ? courtPassMonth(`${m[1]}-${m[2]}-15T12:00:00Z`, locale) : '';
  return month
    ? `Your ${month} Court Pass rewards are in your account.`
    : 'Your last Court Pass rewards are in your account.';
}

/** What the Home chip and the My Place link need (a slice of the kit model). */
export type CourtPassSummary =
  | { kind: 'running'; tier: number; xpToNext: number; finished: boolean; newCount: number;
      /** 0..1 of the way from this tier to the next (Home's stat card bar). */
      progress: number }
  | { kind: 'next'; startsAt: string };

/** "Court Pass · Tier 7 · 22 to next"; "Court Pass · starts December 1" between passes. */
export function courtPassChipLabel(s: CourtPassSummary, locale?: string): string {
  if (s.kind === 'next') {
    const date = courtPassDate(s.startsAt, locale);
    return date ? `${COURT_PASS_NAME}, starts ${date}` : COURT_PASS_NAME;
  }
  const tail = s.finished ? 'all tiers done' : `${s.xpToNext} to next`;
  return `${COURT_PASS_NAME}, Tier ${s.tier}, ${tail}`;
}

/** The chip read aloud. */
export function courtPassChipA11y(s: CourtPassSummary, locale?: string): string {
  if (s.kind === 'next') return `${nextCourtPassLine(s.startsAt, locale)}. Open Court Pass`;
  const fresh = s.newCount > 0 ? ` ${s.newCount} new ${s.newCount === 1 ? 'reward' : 'rewards'}.` : '';
  const tail = s.finished
    ? 'every tier reached.'
    : `${s.xpToNext} ${s.xpToNext === 1 ? 'pickleball' : 'pickleballs'} to the next tier.`;
  return `${COURT_PASS_NAME}, tier ${s.tier}, ${tail}${fresh} Open Court Pass`;
}

/** The new-rewards sheet's title. */
export function newRewardsTitle(count: number): string {
  return count === 1 ? 'New Court Pass reward' : `${count} new Court Pass rewards`;
}

export const NEW_REWARDS_BODY = 'You reached a new tier. It is in your account now, yours to keep.';

/** Why a guest's track doesn't move, and what to do (the screen's panel). */
export const COURT_PASS_GUEST =
  "Guest passes don't earn pickleballs. Finish signing up and every match from then on counts.";
/** Why a test account's track doesn't move, and what to do. */
export const COURT_PASS_TEST_ACCOUNT =
  "Test accounts don't earn pickleballs, so real players' tracks stay fair. Use your real account to earn.";

/** One way to earn pickleballs, for the "How to earn pickleballs" sheet. */
export type PickleballWay = { title: string; amount: string; detail: string };

/**
 * Every way to earn, and how many. The play ways pay floor(pickles x 0.5)
 * (migration_court_pass_xp.sql reward_track_xp_sources): match pay and new
 * opponents and check-in matches in migration_fair_rewards.sql, tournaments in
 * migration_pickle_economy_guards.sql. The daily login is a flat +5
 * (c_login_xp), not half of its pickles. Change both together: the test pins
 * them.
 */
export const PICKLEBALL_WAYS: PickleballWay[] = [
  {
    title: 'Play a match',
    amount: '20 to 2',
    detail:
      'Your first 3 matches a day earn 20 each, then 17, 15, 12, 10, 7, 5 and 2. The same players earn for up to 3 matches in 12 hours.',
  },
  { title: 'Play someone new', amount: '25', detail: 'Each player you play for the first time, up to 3 a week.' },
  { title: 'Check in, then play', amount: '12', detail: 'Once a day, when you play a match within 4 hours of checking in at a court.' },
  { title: 'Play a tournament', amount: '25', detail: 'Each tournament you finish where 4 or more players played.' },
  { title: 'Open Pickleague', amount: '5', detail: 'Once a day, with your daily login reward.' },
];

/** The sheet's footnote. No daily pickleball cap (every pass's daily_cap is null), so it names none. */
export const PICKLEBALL_RULES =
  'Playing earns half the pickles it pays, rounded down; opening Pickleague adds 5 once a day. ' +
  'Badges, play streaks, new courts, drill reviews, gifts, prizes and getting started earn pickles but no pickleballs.';
