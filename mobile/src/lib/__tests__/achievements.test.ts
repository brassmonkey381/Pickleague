import { describe, it, expect } from 'vitest';
import {
  buildAchievementSections,
  achievementStatus,
  progressLabel,
} from '@just-messin-around/expo-foundation/achievements/rules';
import {
  ACHIEVEMENT_GROUPS,
  BADGE_DEFS,
  FTUE_DEFS,
  GETTING_STARTED_DONE_ORDER,
  STREAK_MILESTONES,
  awardLines,
  buildAchievements,
  isHiddenFromProfile,
  overallSummary,
  progressByBadge,
  rewardsForBadge,
  type BadgeAward,
  type CatalogBadge,
  type FtueInput,
} from '../achievements';

// The live badges catalogue (2026-10-27), names and categories.
const LIVE: Array<[string, 'profile' | 'league']> = [
  ['Welcome', 'profile'], ['First Rally', 'profile'], ['Hot Streak', 'profile'], ['Court Hopper', 'profile'],
  ['Doubles Dynamo', 'profile'], ['Singles Specialist', 'profile'], ['Top Rated', 'profile'], ['Veteran', 'profile'],
  ['Hat Trick', 'league'], ['Home Court Hero', 'league'], ['League Regular', 'league'], ['Dominant', 'league'],
  ['League Leader', 'league'], ['Iron Player', 'league'], ['Comeback King', 'league'], ['Period Champion', 'league'],
  ['Season Crown', 'league'], ['Season Silver', 'league'], ['Season Bronze', 'league'], ['Period Sweeper', 'league'],
  ['Tournament Champion', 'profile'], ['Tournament Silver', 'profile'], ['Tournament Bronze', 'profile'],
  ['Perfect Game', 'profile'], ['Century', 'profile'], ['Underdog', 'profile'], ['Cinderella', 'profile'],
  ['Marathon', 'profile'], ['Triple Crown', 'profile'], ['Tournament Veteran I', 'profile'],
  ['Tournament Veteran II', 'profile'], ['Tournament Veteran III', 'profile'], ['Globetrotter II', 'profile'],
  ['Recruiter', 'profile'], ['Squad Builder', 'profile'], ['Club Builder', 'profile'],
];
const catalog: CatalogBadge[] = LIVE.map(([name, category]) => ({ name, category, description: `${name} (db)`, icon: '🏅' }));

function award(badgeName: string, earnedAt: string, extra: Partial<BadgeAward> = {}): BadgeAward {
  return {
    id: `${badgeName}-${earnedAt}`, badgeName, earnedAt, leagueId: null, leagueName: null,
    matchId: null, context: null, isHidden: false, ...extra,
  };
}

const NO_FTUE: FtueInput = {
  join_league: { complete: false, claimedAt: null },
  setup_profile: { complete: false, claimedAt: null },
  first_match: { complete: false, claimedAt: null },
};

const byId = <T extends { id: string }>(list: T[], id: string): T => list.find(a => a.id === id)!;

describe('catalogue', () => {
  // Glyph names are checked by tsc (BadgeDef.glyph is an IconName).
  it('covers every live badge, once, with how-to-earn copy', () => {
    const names = BADGE_DEFS.map(d => d.name);
    expect(new Set(names).size).toBe(names.length);
    for (const [name] of LIVE) expect(names).toContain(name);
    for (const d of BADGE_DEFS) {
      expect(d.how.length).toBeGreaterThan(8);
      expect(d.how.endsWith('.')).toBe(true);
    }
  });

  it('league-category badges are per league', () => {
    for (const [name, cat] of LIVE) {
      if (cat === 'league') expect(BADGE_DEFS.find(d => d.name === name)!.perLeague).toBe(true);
    }
  });

  it('every def sits in a known group', () => {
    const ids = new Set(ACHIEVEMENT_GROUPS.map(g => g.id));
    for (const d of BADGE_DEFS) expect(ids.has(d.group)).toBe(true);
  });
});

describe('buildAchievements (own page)', () => {
  const built = buildAchievements({
    catalog,
    awards: [
      award('Season Crown', '2026-09-01T10:00:00Z', { leagueId: 'L1', leagueName: 'Fall League' }),
      award('Season Crown', '2026-06-01T10:00:00Z', { leagueId: 'L2', leagueName: 'Spring League' }),
      award('Perfect Game', '2026-10-01T10:00:00Z', { matchId: 'M1' }),
    ],
    progress: { 'Hot Streak': { current: 3, target: 5, unit: 'wins' } },
    streak: { current: 21, longest: 21, reachedOn: { 7: '2026-10-05T12:00:00' } },
    ftue: { ...NO_FTUE, join_league: { complete: true, claimedAt: '2026-08-01T00:00:00Z' }, first_match: { complete: true, claimedAt: null } },
  });

  it('a stacked per-league badge is one medal, dated by its first win, every league kept', () => {
    const crown = byId(built.achievements, 'badge:Season Crown');
    expect(crown.earnedAt).toBe('2026-06-01T10:00:00Z');
    expect(crown.meta!.awards.map(a => a.leagueName)).toEqual(['Fall League', 'Spring League']); // newest first
    expect(crown.groupId).toBe('league');
    expect(crown.glyph).toBe('crown');
  });

  it('progress shows only while locked', () => {
    const hot = byId(built.achievements, 'badge:Hot Streak');
    expect(achievementStatus(hot)).toBe('in_progress');
    expect(progressLabel(hot.progress)).toBe('3/5 wins');
    expect(byId(built.achievements, 'badge:Perfect Game').progress).toBeNull();
  });

  it('streak milestones: dated when reached, "21/30 days" toward the next', () => {
    expect(byId(built.achievements, 'streak:7').earnedAt).toBe('2026-10-05T12:00:00');
    const month = byId(built.achievements, 'streak:30');
    expect(month.earnedAt).toBeNull();
    expect(progressLabel(month.progress)).toBe('21/30 days');
    const streaks = built.groups.find(g => g.id === 'streaks')!;
    expect(streaks.badge).toEqual({ label: '21d', glyph: 'fire', tint: 'warning', accessibilityLabel: '21 day streak' });
  });

  it('a milestone the longest streak passed without a reward row still counts (undated)', () => {
    const b = buildAchievements({ catalog, awards: [], streak: { current: 0, longest: 40, reachedOn: {} } });
    expect(achievementStatus(byId(b.achievements, 'streak:30'))).toBe('earned');
    expect(achievementStatus(byId(b.achievements, 'streak:100'))).toBe('locked');
    expect(b.groups.find(g => g.id === 'streaks')!.badge).toBeUndefined(); // no chip at 0
  });

  it('Getting started: claimed = earned, done-but-unclaimed = ready to claim, else locked', () => {
    const join = byId(built.achievements, 'ftue:join_league');
    const first = byId(built.achievements, 'ftue:first_match');
    const profile = byId(built.achievements, 'ftue:setup_profile');
    expect(achievementStatus(join)).toBe('earned');
    expect(achievementStatus(first)).toBe('in_progress');
    expect(first.progress!.label).toBe('Ready to claim');
    expect(first.meta!.claimable).toBe(true);
    expect(achievementStatus(profile)).toBe('locked');
  });

  it('Getting started drops to the bottom once all three are claimed', () => {
    const at = '2026-08-01T00:00:00Z';
    const b = buildAchievements({
      catalog, awards: [],
      ftue: { join_league: { complete: true, claimedAt: at }, setup_profile: { complete: true, claimedAt: at }, first_match: { complete: true, claimedAt: at } },
    });
    expect(b.groups.find(g => g.id === 'getting-started')!.order).toBe(GETTING_STARTED_DONE_ORDER);
    const sections = buildAchievementSections(b.groups, b.achievements);
    expect(sections[sections.length - 1].group.id).toBe('getting-started');
    expect(buildAchievementSections(built.groups, built.achievements)[0].group.id).toBe('getting-started');
  });

  it('Welcome stays out until earned; summaries count what is visible', () => {
    const sections = buildAchievementSections(built.groups, built.achievements);
    const gs = sections.find(s => s.group.id === 'getting-started')!;
    expect(gs.achievements.map(a => a.id)).not.toContain('badge:Welcome');
    expect(gs.summary.total).toBe(3);
    const { earned, total } = overallSummary(built.achievements);
    expect(earned).toBe(1 + 1 + 2); // join_league, Week Streak, Season Crown + Perfect Game
    expect(total).toBe(BADGE_DEFS.length - 1 + STREAK_MILESTONES.length + FTUE_DEFS.length);
  });

  it('a badge the app does not know yet still shows, grouped by its category, with its DB copy', () => {
    const b = buildAchievements({
      catalog: [...catalog, { name: 'Night Owl', category: 'league', description: 'Played after 10pm.', icon: '🦉' }],
      awards: [],
      glyphForEmoji: () => undefined,
    });
    const owl = byId(b.achievements, 'badge:Night Owl');
    expect(owl.groupId).toBe('league');
    expect(owl.description).toBe('Played after 10pm.');
    expect(owl.glyph).toBe('medal');
    expect(owl.meta!.perLeague).toBe(true);
  });

  it('a badge gone from the live catalogue shows only if earned', () => {
    const b = buildAchievements({ catalog: catalog.filter(c => c.name !== 'Cinderella'), awards: [] });
    expect(byId(b.achievements, 'badge:Cinderella').hidden).toBe(true);
  });
});

describe("another player's page", () => {
  const b = buildAchievements({
    catalog,
    awards: [award('Hot Streak', '2026-10-02T10:00:00Z')],
    progress: { 'First Rally': { current: 0, target: 1 } },
    streak: { current: 9, longest: 9, reachedOn: { 3: '2026-10-01T12:00:00' } },
    ftue: NO_FTUE,
    collectibles: [{ id: 'P1', shopItemId: 'S1', name: 'Gold Pin', description: null, icon: '📌', acquiredAt: '2026-10-03T00:00:00Z', isHidden: false, note: 'A gift' }],
    earnedOnly: true,
  });

  it('shows earned ones only: no progress, streaks or quests', () => {
    const sections = buildAchievementSections(b.groups, b.achievements);
    const shown = sections.flatMap(s => s.achievements.map(a => a.id));
    expect(shown.sort()).toEqual(['badge:Hot Streak', 'collectible:P1']);
    expect(b.achievements.some(a => a.id.startsWith('streak:') || a.id.startsWith('ftue:'))).toBe(false);
    expect(b.groups.find(g => g.id === 'streaks')!.badge).toBeUndefined();
    expect(overallSummary(b.achievements)).toEqual({ earned: 2, total: 2 });
  });
});

describe('progressByBadge', () => {
  it('maps counts with units, Top Rated as a percent, and skips per-league and earned rows', () => {
    const out = progressByBadge([
      { badge: 'Court Hopper', current: 3, target: 5, pct: 0.6, earned: false, perLeague: false },
      { badge: 'Top Rated', current: 3.55, target: 4, pct: 0.4, earned: false, perLeague: false },
      { badge: 'Hat Trick', current: 0, target: 0, pct: 0, earned: false, perLeague: true },
      { badge: 'First Rally', current: 9, target: 1, pct: 1, earned: true, perLeague: false },
    ]);
    expect(progressLabel(out['Court Hopper'])).toBe('3/5 courts');
    expect(out['Top Rated']).toEqual({ current: 40, target: 100, label: '40%' });
    expect(out['Hat Trick']).toBeUndefined();
    expect(out['First Rally']).toBeUndefined();
  });
});

describe('detail helpers', () => {
  it('rewardsForBadge lists avatar, tag slot, tags and the name style', () => {
    expect(rewardsForBadge('Top Rated', { 'Top Rated': 'Gilded' })).toEqual([
      'Champion avatar', '+1 tag slot', '🏆 The Champion tag', 'Gilded name style',
    ]);
    expect(rewardsForBadge('Marathon')).toEqual([]);
  });

  it('awardLines: league · date, with the match id', () => {
    const lines = awardLines(
      [award('Dominant', '2026-10-02T15:00:00Z', { leagueName: 'Fall League', matchId: 'M9' }), award('Dominant', 'bad')],
      () => 'Oct 2, 2026',
    );
    expect(lines[0]).toMatchObject({ text: 'Fall League · Oct 2, 2026', matchId: 'M9' });
    expect(lines[1].text).toBe('');
  });

  it('hidden from profile only when every instance is hidden', () => {
    const meta = (hidden: boolean[]) => ({
      kind: 'badge' as const, awards: hidden.map((h, i) => award('X', `2026-01-0${i + 1}`, { isHidden: h })),
      perLeague: false, stacks: true, rewards: [],
    });
    expect(isHiddenFromProfile(meta([true, true]))).toBe(true);
    expect(isHiddenFromProfile(meta([true, false]))).toBe(false);
    expect(isHiddenFromProfile(meta([]))).toBe(false);
  });
});
