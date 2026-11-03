// lib/courtPassCopy: the Court Pass words, and the pin that keeps "How to earn
// pickleballs" true. Ported from Doggle's scripts/tests/parkPassCopy.test.mjs
// (docs/court-pass.md, "courtPassCopy.test.ts (the pin)").
//
// The pin reads the SQL that pays (the live earn files) and the SQL that turns
// pay into pickleballs (migration_court_pass_xp.sql, the cycles file). A file
// it can't find fails the test with the file's name: it never passes silently.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  COURT_PASS_COPY,
  COURT_PASS_GUEST,
  COURT_PASS_INTRO,
  COURT_PASS_PREMIUM_HINT,
  COURT_PASS_PREMIUM_SHEET,
  COURT_PASS_PREMIUM_TITLE,
  COURT_PASS_TEST_ACCOUNT,
  NEW_REWARDS_BODY,
  PICKLEBALL_RULES,
  PICKLEBALL_WAYS,
  courtPassChipA11y,
  courtPassChipLabel,
  courtPassDailyLine,
  courtPassEarnedLine,
  viewerOnPacificTime,
  earlierRewardsToast,
  newRewardsTitle,
  nextCourtPassLine,
} from '../courtPassCopy';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function sql(file: string): string {
  const p = path.join(ROOT, 'supabase', file);
  if (!fs.existsSync(p)) throw new Error(`supabase/${file} is missing: the How to earn pin reads it.`);
  return fs.readFileSync(p, 'utf8');
}

/** The statement starting at `start` (a regex), up to its closing semicolon. */
function statement(text: string, start: RegExp, file: string): string {
  const m = start.exec(text);
  if (!m) throw new Error(`supabase/${file}: no statement matching ${start}.`);
  const end = text.indexOf(';', m.index);
  return text.slice(m.index, end < 0 ? undefined : end);
}

const way = (title: string) => {
  const w = PICKLEBALL_WAYS.find((x) => x.title === title);
  if (!w) throw new Error(`PICKLEBALL_WAYS has no "${title}"`);
  return w;
};

describe('the chip and the screen lines', () => {
  it('the chip reads "Court Pass · Tier 7 · 22 to next"', () => {
    const s = { kind: 'running' as const, tier: 7, xpToNext: 22, finished: false, newCount: 0 };
    expect(courtPassChipLabel(s)).toBe('Court Pass · Tier 7 · 22 to next');
    expect(courtPassChipA11y(s)).toBe('Court Pass, tier 7, 22 pickleballs to the next tier. Open Court Pass');
    expect(courtPassChipA11y({ ...s, xpToNext: 1 })).toMatch(/1 pickleball to the next tier/);
  });

  it('a finished pass says so; a new reward is read aloud', () => {
    const s = { kind: 'running' as const, tier: 30, xpToNext: 0, finished: true, newCount: 1 };
    expect(courtPassChipLabel(s)).toBe('Court Pass · Tier 30 · all tiers done');
    expect(courtPassChipA11y(s)).toMatch(/every tier reached\. 1 new reward\./);
    expect(courtPassChipA11y({ ...s, newCount: 3 })).toMatch(/3 new rewards\./);
  });

  it('between passes the chip and the screen name the next start, in the viewer zone', () => {
    // Dec 1 2026 00:00 Pacific is 08:00Z.
    const next = '2026-12-01T08:00:00Z';
    const local = new Date(next).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
    expect(nextCourtPassLine(next, 'en-US')).toBe(`Next Court Pass starts ${local}`);
    expect(courtPassChipLabel({ kind: 'next', startsAt: next }, 'en-US')).toBe(`Court Pass · starts ${local}`);
    expect(nextCourtPassLine(null)).toBe('The next Court Pass is on its way.');
    expect(nextCourtPassLine('not a date')).toBe('The next Court Pass is on its way.');
    expect(courtPassChipLabel({ kind: 'next', startsAt: 'not a date' })).toBe('Court Pass');
  });

  it("no daily cap (null): the daily line is just today's pickleballs, no limit and no reset", () => {
    expect(courtPassDailyLine(40, null)).toBe('Today: 40 pickleballs.');
    expect(courtPassDailyLine(345, null)).toBe('Today: 345 pickleballs.');
    expect(courtPassDailyLine(-5, null)).toBe('Today: 0 pickleballs.');
    expect(courtPassDailyLine(345, null)).not.toMatch(/\/|cap\b|limit|up to|reset|midnight/i);
  });

  it('today is the Pacific day: off Pacific time the line shows the pass total instead', () => {
    const me = { todayXp: 60, xp: 410, dailyCap: null };
    expect(courtPassEarnedLine(me, true)).toBe('Today: 60 pickleballs.');
    expect(courtPassEarnedLine(me, false)).toBe('This Court Pass: 410 pickleballs.');
    expect(courtPassEarnedLine({ ...me, xp: -3 }, false)).toBe('This Court Pass: 0 pickleballs.');
    // A capped pass names the Pacific reset itself, so it keeps its line anywhere.
    expect(courtPassEarnedLine({ ...me, dailyCap: 125 }, false)).toBe(
      'Today: 60 / 125 pickleballs. The pickleball day resets at midnight Pacific time.',
    );
  });

  it('viewerOnPacificTime reads the device zone against Los Angeles', () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const at = new Date('2026-11-05T05:30:00Z');
    if (zone === 'America/Los_Angeles') expect(viewerOnPacificTime(at)).toBe(true);
    else if (zone === 'UTC' || zone === 'America/New_York') expect(viewerOnPacificTime(at)).toBe(false);
    else expect(typeof viewerOnPacificTime(at)).toBe('boolean');
  });

  it('a pass given a cap in SQL still shows it, clamped, with the Pacific reset', () => {
    expect(courtPassDailyLine(40, 125)).toBe(
      'Today: 40 / 125 pickleballs. The pickleball day resets at midnight Pacific time.',
    );
    expect(courtPassDailyLine(130, 125)).toMatch(/^Today: 125 \/ 125 /);
    expect(courtPassDailyLine(-5, 125)).toMatch(/^Today: 0 \/ 125 /);
  });

  it('an earlier cycle paid on this open names its month', () => {
    expect(earlierRewardsToast('2026-11', 'en-US')).toBe('Your November Court Pass rewards are in your account.');
    expect(earlierRewardsToast('2026-12', 'en-US')).toBe('Your December Court Pass rewards are in your account.');
    expect(earlierRewardsToast('2027-01', 'en-US')).toBe('Your January Court Pass rewards are in your account.');
    expect(earlierRewardsToast('junk')).toBe('Your last Court Pass rewards are in your account.');
  });

  it('the XP word is pickleballs', () => {
    expect(COURT_PASS_COPY.units).toBe('pickleballs');
    expect(COURT_PASS_COPY.unit).toBe('pickleball');
  });

  it('guests and test accounts are told why and what to do', () => {
    expect(COURT_PASS_GUEST).toMatch(/Finish signing up/);
    expect(COURT_PASS_TEST_ACCOUNT).toMatch(/Use your real account/);
  });
});

describe('premium is coming soon, nothing more', () => {
  // No price, buy / upgrade / notify, date, web, "unlocks when you upgrade" or "you would have earned".
  // No date in any form: ordinals, bare day numbers, every month name or abbreviation.
  const BANNED =
    /price|\$|buy|purchase|upgrade|notify|remind|web|unlock|would have|\d{1,2}(st|nd|rd|th)|\b\d{1,2}\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i;

  it('the premium guard catches a date in any month', () => {
    for (const s of ['Premium track coming in November', 'coming Nov 15', 'Back in sept.', 'Opens May', 'coming the 3rd', 'Out Jan']) {
      expect(s, s).toMatch(BANNED);
    }
  });

  it('the premium words name no price, purchase, date or upgrade', () => {
    const premium = [
      COURT_PASS_PREMIUM_TITLE,
      COURT_PASS_PREMIUM_SHEET,
      COURT_PASS_PREMIUM_HINT.collapsed,
      COURT_PASS_PREMIUM_HINT.expanded,
      COURT_PASS_COPY.premiumComingSoonReason!,
    ];
    for (const s of premium) expect(s, s).not.toMatch(BANNED);
    expect(COURT_PASS_PREMIUM_TITLE).toBe('Premium track coming soon');
  });

  it('the intro and the new-reward words do not pitch premium either', () => {
    for (const s of [COURT_PASS_INTRO, NEW_REWARDS_BODY, newRewardsTitle(1), newRewardsTitle(3)]) {
      expect(s, s).not.toMatch(/price|buy|purchas|upgrade|notify|premium/i);
    }
    expect(newRewardsTitle(1)).toBe('New Court Pass reward');
    expect(newRewardsTitle(3)).toBe('3 new Court Pass rewards');
  });
});

describe('"How to earn pickleballs" lists what the SQL pays', () => {
  it('five ways', () => {
    expect(PICKLEBALL_WAYS.length).toBe(5);
    for (const w of PICKLEBALL_WAYS) {
      expect(w.title.length, w.title).toBeGreaterThan(3);
      expect(w.detail, w.title).toMatch(/[.!]$/);
    }
  });

  it('match pay: 40 x3 then 5 less a match, at most 3 with the same players in 12 hours', () => {
    const fair = sql('migration_fair_rewards.sql');
    expect(fair).toMatch(/v_bonus := case when v_n <= 3 then 40 else greatest\(40 - 5 \* \(v_n - 3\), 0\) end;/);
    expect(fair).toMatch(/if v_group >= 3 then v_bonus := 0; end if;/);
    // The curve the SQL pays: 40, 40, 40, 35, ... 5, then 0.
    const pickles = Array.from({ length: 12 }, (_, i) => {
      const n = i + 1;
      return n <= 3 ? 40 : Math.max(40 - 5 * (n - 3), 0);
    }).filter((p) => p > 0);
    expect(pickles).toEqual([40, 40, 40, 35, 30, 25, 20, 15, 10, 5]);
    const balls = [...new Set(pickles.map((p) => Math.floor(p / 2)))];
    expect(balls).toEqual([20, 17, 15, 12, 10, 7, 5, 2]);
    const match = way('Play a match');
    expect(match.amount).toBe(`${balls[0]} to ${balls[balls.length - 1]}`);
    expect(match.detail).toContain(`earn ${balls[0]} each, then ${balls.slice(1, -1).join(', ')} and ${balls[balls.length - 1]}.`);
    expect(match.detail).toMatch(/up to 3 matches in 12 hours/);
  });

  it('new opponents, check-in matches and tournaments', () => {
    const fair = sql('migration_fair_rewards.sql');
    expect(fair).toMatch(/exit when v_recent >= 3;/);
    expect(fair).toMatch(/v_pay := least\(50, public\._pl_play_cap_left\(v_uid\)\);/);
    expect(fair).toMatch(/v_pay := least\(25, public\._pl_play_cap_left\(v_uid\)\);/);
    expect(sql('migration_pickle_economy_guards.sql')).toMatch(/v_pay := least\(50, public\._pl_play_cap_left\(v_uid\)\);/);
    expect(way('Play someone new').amount).toBe(String(Math.floor(50 / 2)));
    expect(way('Check in, then play').amount).toBe(String(Math.floor(25 / 2)));
    expect(way('Play a tournament').amount).toBe(String(Math.floor(50 / 2)));
  });

  it('the login, the allowlist and no daily cap in the Court Pass SQL', () => {
    const file = 'migration_court_pass_xp.sql';
    const xp = sql(file);
    expect(xp).toMatch(/c_login_xp constant int := 5;/);
    expect(way('Open Pickleague').amount).toBe('5');

    // The allowlist seed: exactly the four play sources, each at 0.5.
    const seed = statement(xp, /insert into public\.reward_track_xp_sources\b/i, file);
    const rows = [...seed.matchAll(/\(\s*'([a-z_]+)'\s*,\s*([0-9.]+)/g)].map((m) => [m[1], Number(m[2])] as const);
    expect(rows.map(([s]) => s).sort()).toEqual(
      ['_grant_checkin_match_bonus', '_grant_match_game_bonus', '_grant_new_opponent_bonus', '_grant_tournament_participation_bonus'],
    );
    for (const [s, ratio] of rows) expect(ratio, s).toBe(0.5);
    for (const out of ['_grant_daily_streak_bonus', '_grant_court_bonus', '_grant_pickles_on_badge', 'submit_drill_review']) {
      expect(seed, out).not.toContain(out);
    }

    // No daily cap (Brian, 2026-11-03): every seeded cycle's daily_xp_cap is
    // null, and a null cap adds every earn in full.
    const seeded: Record<string, string[]> = {
      'migration_court_pass_cycles_2026_11.sql': ['2026-11'],
      'migration_court_pass_cycles_2026_12_2027_01.sql': ['2026-12', '2027-01'],
    };
    for (const [cyclesFile, ids] of Object.entries(seeded)) {
      const cycles = statement(sql(cyclesFile), /insert into public\.reward_track_cycles\b/i, cyclesFile);
      expect(cycles, cyclesFile).toMatch(/\(id, title, starts_at, ends_at, premium_state, daily_xp_cap\)/);
      for (const id of ids) {
        const at = cycles.indexOf(`'${id}'`);
        expect(at, `${cyclesFile} seeds ${id}`).toBeGreaterThan(-1);
        const next = cycles.indexOf("('", at + 1);
        const row = cycles.slice(at, next < 0 ? undefined : next).replace(/\s+/g, ' ');
        // The row's last value is daily_xp_cap.
        expect(row, `${id}'s daily_xp_cap`).toMatch(/'(coming_soon|off)', null\)/);
      }
    }
    expect(xp).toMatch(/if v_cap is null then\s+v_add := p_xp;/);
    expect(xp).toMatch(/'today_xp', 0, 'daily_cap', null,/);
    expect(sql('migration_court_pass_tables.sql')).toMatch(/daily_xp_cap\s+integer,/);

    // So the copy names no daily pickleball limit, and no reset that implies one.
    for (const s of [PICKLEBALL_RULES, COURT_PASS_INTRO, ...PICKLEBALL_WAYS.map((w) => w.detail)]) {
      expect(s, s).not.toMatch(/\b125\b|up to \d+ a day|cap\b|limit|resets?\b|midnight/i);
    }
    expect(PICKLEBALL_RULES).toContain('half the pickles it pays');
  });
});
