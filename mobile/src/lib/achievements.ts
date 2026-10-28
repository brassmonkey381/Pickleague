// Pickleague's achievements, mapped onto the foundation achievements kit
// (@just-messin-around/expo-foundation/achievements). PURE: no React, no
// Supabase. lib/achievementsData.ts reads the rows; this file turns them into
// the kit's Achievement / AchievementGroup model.
//
// Sources, by group:
//   Getting started  the three FTUE quests (ftue_grants) + the Welcome badge
//   Streaks          daily-login milestones 3/7/30/100 (user_streak_rewards,
//                    migration_add_login_streaks) + the Hot Streak badge
//   Play milestones  account-wide badges with a threshold (First Rally, Century, ...)
//   Big wins         per-match stacking badges (Perfect Game, Underdog, ...)
//   League           per-league badges (award_league_badge, season podium, ...)
//   Tournaments      tournament podium + Tournament Veteran I-III
//   Community        referrals + Veteran
//   Collection       cosmetic badges bought or gifted in the Shop (only once owned)
// A badge row the catalogue below doesn't know yet (a new badges row) still
// shows: in League or Play milestones by its category, with its DB description.
import type {
  Achievement,
  AchievementGroup,
  AchievementProgress,
} from '@just-messin-around/expo-foundation/achievements/rules';
import type { IconName } from '@just-messin-around/expo-foundation/icons';
import { AVATARS, PLAY_TAGS, TAG_SLOT_UNLOCKS } from '../data/profileCustomization';

// ── Groups ───────────────────────────────────────────────────────────────────

export type AchievementGroupId =
  | 'getting-started'
  | 'streaks'
  | 'milestones'
  | 'wins'
  | 'league'
  | 'tournaments'
  | 'community'
  | 'collection';

/** Group order and medal disc colours (theme tokens; Collection is a literal teal). */
export const ACHIEVEMENT_GROUPS: ReadonlyArray<AchievementGroup & { id: AchievementGroupId }> = [
  { id: 'getting-started', title: 'Getting started', tint: 'primary', order: 10 },
  { id: 'streaks', title: 'Streaks', tint: 'warning', order: 20 },
  { id: 'milestones', title: 'Play milestones', tint: 'success', order: 30 },
  { id: 'wins', title: 'Big wins', tint: 'danger', order: 40 },
  { id: 'league', title: 'League', tint: 'info', order: 50 },
  { id: 'tournaments', title: 'Tournaments', tint: 'rarityRare', order: 60 },
  { id: 'community', title: 'Community', tint: 'primaryDark', order: 70 },
  { id: 'collection', title: 'Collection', tint: '#0d9488', order: 80 },
];

/** Getting started drops to the bottom once all of it is done. */
export const GETTING_STARTED_DONE_ORDER = 90;

// ── Badge catalogue ──────────────────────────────────────────────────────────

export type BadgeDef = {
  /** badges.name, exactly. */
  name: string;
  group: AchievementGroupId;
  glyph: IconName;
  /** One line: how to earn it. */
  how: string;
  /** Awarded per league (award_league_badge); earned instances name the league. */
  perLeague?: boolean;
  /** Can be earned more than once. */
  stacks?: boolean;
  /** Unit for the progress label ("3/5 wins"). Only badges lib/unlockProgress measures. */
  unit?: string;
  /** Not shown until earned. */
  hiddenUntilEarned?: boolean;
};

// Order inside a group is the tie-break after the kit's sort (earned newest
// first, in progress by %, locked), so locked ones read easiest-first.
export const BADGE_DEFS: ReadonlyArray<BadgeDef> = [
  // Getting started
  { name: 'Welcome', group: 'getting-started', glyph: 'wave', how: 'Create your Pickleague account.', hiddenUntilEarned: true },

  // Streaks (the login milestones are built separately)
  { name: 'Hot Streak', group: 'streaks', glyph: 'bolt', how: 'Win 5 matches in a row.', unit: 'wins' },

  // Play milestones
  { name: 'First Rally', group: 'milestones', glyph: 'pickleball', how: 'Play your first match.', unit: 'matches' },
  { name: 'Court Hopper', group: 'milestones', glyph: 'pin', how: 'Play at 5 different courts.', unit: 'courts' },
  { name: 'Globetrotter II', group: 'milestones', glyph: 'globe', how: 'Play at 10 different courts.', unit: 'courts' },
  { name: 'Doubles Dynamo', group: 'milestones', glyph: 'handshake', how: 'Play 20 doubles matches.', unit: 'matches' },
  { name: 'Singles Specialist', group: 'milestones', glyph: 'person', how: 'Play 25 singles matches.', unit: 'matches' },
  { name: 'Century', group: 'milestones', glyph: 'chart', how: 'Play 100 matches. Every further 100 earns it again.', stacks: true, unit: 'matches' },
  { name: 'Top Rated', group: 'milestones', glyph: 'star', how: 'Reach an overall PLUPR of 4.0.' },

  // Big wins (one per qualifying match)
  { name: 'Perfect Game', group: 'wins', glyph: 'target', how: 'Win a match 11-0. Earned again for every shutout.', stacks: true },
  { name: 'Marathon', group: 'wins', glyph: 'hourglass', how: 'Win a game that goes past 11 (12 or more to win).', stacks: true },
  { name: 'Underdog', group: 'wins', glyph: 'dog', how: 'Beat a team rated 0.5+ PLUPR above yours.', stacks: true },
  { name: 'Cinderella', group: 'wins', glyph: 'sparkle', how: 'Beat a team rated 1.0+ PLUPR above yours.', stacks: true },
  { name: 'Triple Crown', group: 'wins', glyph: 'crown', how: 'Win a singles, a gendered doubles and a mixed doubles match on the same day.', stacks: true },

  // League (per league)
  { name: 'Season Crown', group: 'league', glyph: 'crown', how: "Finish #1 in a season's final standings.", perLeague: true },
  { name: 'Season Silver', group: 'league', glyph: 'medal', how: "Finish #2 in a season's final standings.", perLeague: true },
  { name: 'Season Bronze', group: 'league', glyph: 'medal', how: "Finish #3 in a season's final standings.", perLeague: true },
  { name: 'Period Sweeper', group: 'league', glyph: 'sparkle', how: 'Finish #1 in every period of one season.', perLeague: true },
  { name: 'Period Champion', group: 'league', glyph: 'trophy', how: 'Finish #1 when a season period locks in.', perLeague: true },
  { name: 'League Leader', group: 'league', glyph: 'flag', how: "Reach #1 in a league's standings.", perLeague: true },
  { name: 'Hat Trick', group: 'league', glyph: 'celebrate', how: 'Win 3 matches in one day in a league.', perLeague: true },
  { name: 'Dominant', group: 'league', glyph: 'shield', how: 'Win a league match 11-0 or 11-1.', perLeague: true },
  { name: 'Comeback King', group: 'league', glyph: 'repeat', how: 'Score 8 or more points in a league match you lose.', perLeague: true },
  { name: 'Iron Player', group: 'league', glyph: 'dumbbell', how: 'Play league matches on 5 different days.', perLeague: true },
  { name: 'Home Court Hero', group: 'league', glyph: 'home', how: "Win 5 matches at a league's home court.", perLeague: true },
  { name: 'League Regular', group: 'league', glyph: 'calendar', how: 'Play 15 matches in one league.', perLeague: true },

  // Tournaments
  { name: 'Tournament Champion', group: 'tournaments', glyph: 'trophy', how: 'Win a tournament. Earned again for every title.', stacks: true },
  { name: 'Tournament Silver', group: 'tournaments', glyph: 'medal', how: 'Finish 2nd in a tournament. Earned again for every finish.', stacks: true },
  { name: 'Tournament Bronze', group: 'tournaments', glyph: 'medal', how: 'Finish 3rd in a tournament. Earned again for every finish.', stacks: true },
  { name: 'Tournament Veteran I', group: 'tournaments', glyph: 'bracket', how: 'Play 5 tournaments to the end.' },
  { name: 'Tournament Veteran II', group: 'tournaments', glyph: 'bracket', how: 'Play 10 tournaments to the end.' },
  { name: 'Tournament Veteran III', group: 'tournaments', glyph: 'bracket', how: 'Play 25 tournaments to the end.' },

  // Community
  { name: 'Veteran', group: 'community', glyph: 'cake', how: 'Be a Pickleague member for 30 days.', unit: 'days' },
  { name: 'Recruiter', group: 'community', glyph: 'megaphone', how: 'Invite a friend who joins Pickleague.' },
  { name: 'Squad Builder', group: 'community', glyph: 'group', how: 'Invite 5 friends who join Pickleague.' },
  { name: 'Club Builder', group: 'community', glyph: 'store', how: 'Invite 10 friends who join Pickleague.' },
];

const DEF_BY_NAME = new Map(BADGE_DEFS.map(d => [d.name, d]));

export function badgeDef(name: string): BadgeDef | undefined {
  return DEF_BY_NAME.get(name);
}

/** The login-streak milestones claim_daily_login_streak() pays out on. */
export const STREAK_MILESTONES: ReadonlyArray<{ days: number; name: string; glyph: IconName; pickles: number }> = [
  { days: 3, name: '3-Day Streak', glyph: 'sparkle', pickles: 25 },
  { days: 7, name: 'Week Streak', glyph: 'fire', pickles: 100 },
  { days: 30, name: 'Month Streak', glyph: 'calendar-event', pickles: 500 },
  { days: 100, name: '100-Day Streak', glyph: 'rocket', pickles: 2000 },
];

export type FtueStepKey = 'join_league' | 'setup_profile' | 'first_match';

export const FTUE_DEFS: ReadonlyArray<{ step: FtueStepKey; name: string; glyph: IconName; how: string; reward: number }> = [
  { step: 'join_league', name: 'Join a league', glyph: 'group', how: 'Join any league. Worth 500 pickles.', reward: 500 },
  { step: 'setup_profile', name: 'Set up your profile', glyph: 'person', how: 'Pick an avatar, write a tagline or add a play-style tag. Worth 500 pickles.', reward: 500 },
  { step: 'first_match', name: 'Record your first match', glyph: 'pickleball', how: 'Record a match with a score. Worth 1,000 pickles.', reward: 1000 },
];

// ── Inputs ───────────────────────────────────────────────────────────────────

/** A badges row. */
export type CatalogBadge = {
  name: string;
  description: string;
  icon: string;
  category: 'profile' | 'league' | string;
};

/** One player_badges row, flattened. */
export type BadgeAward = {
  id: string;
  badgeName: string;
  earnedAt: string;
  leagueId: string | null;
  leagueName: string | null;
  /** player_badges.source_match_id: the match that earned it, if any. */
  matchId: string | null;
  context: string | null;
  isHidden: boolean;
};

/** A cosmetic_badge Shop purchase. */
export type CollectibleInput = {
  /** player_shop_purchases.id */
  id: string;
  shopItemId: string;
  name: string;
  description: string | null;
  icon: string | null;
  acquiredAt: string;
  isHidden: boolean;
  /** "A gift" or the gift note. */
  note: string | null;
};

export type StreakInput = {
  current: number;
  longest: number;
  /** Milestone days -> the date it was first paid (user_streak_rewards.awarded_date). */
  reachedOn: Readonly<Record<number, string>>;
};

export type FtueInput = Readonly<Record<FtueStepKey, { complete: boolean; claimedAt: string | null }>>;

export type BuildAchievementsInput = {
  catalog: ReadonlyArray<CatalogBadge>;
  awards: ReadonlyArray<BadgeAward>;
  /** Badge name -> progress (own view only). */
  progress?: Readonly<Record<string, AchievementProgress>> | null;
  streak?: StreakInput | null;
  ftue?: FtueInput | null;
  collectibles?: ReadonlyArray<CollectibleInput>;
  /** Another player's page: earned achievements only, no progress. */
  earnedOnly?: boolean;
  /** Name-style rewards that unlock with a badge (badge name -> style name). */
  nameStyles?: Readonly<Record<string, string>>;
  /** Emoji -> glyph for badges the catalogue doesn't know and Shop items. */
  glyphForEmoji?: (emoji: string | null | undefined) => IconName | undefined;
};

export type AchievementKind = 'badge' | 'streak' | 'ftue' | 'collectible';

export type PickleagueAchievementMeta = {
  kind: AchievementKind;
  /** badge: badges.name */
  badgeName?: string;
  /** badge: every earned instance, newest first. */
  awards: BadgeAward[];
  perLeague: boolean;
  stacks: boolean;
  /** What earning it unlocks on the profile / in the Shop. */
  rewards: string[];
  ftueStep?: FtueStepKey;
  /** ftue: done but the pickles not claimed yet. */
  claimable?: boolean;
  ftueReward?: number;
  /** collectible: the purchase. */
  collectible?: CollectibleInput;
  /** streak: the milestone's pickle bonus. */
  streakPickles?: number;
};

export type PickleagueAchievement = Achievement<PickleagueAchievementMeta>;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Every profile reward a badge unlocks: avatars, tag slots, tags, then the name style. */
export function rewardsForBadge(badge: string, nameStyles?: Readonly<Record<string, string>>): string[] {
  const out: string[] = [];
  for (const a of AVATARS) if (a.unlock?.badge === badge) out.push(`${a.name} avatar`);
  for (const u of TAG_SLOT_UNLOCKS) if (u.badge === badge) out.push('+1 tag slot');
  for (const t of PLAY_TAGS) if (t.unlock?.badge === badge) out.push(`${t.label} tag`);
  const style = nameStyles?.[badge];
  if (style) out.push(`${style} name style`);
  return out;
}

export function achievementIdForBadge(name: string): string {
  return `badge:${name}`;
}

function newestFirst(a: BadgeAward, b: BadgeAward): number {
  return (Date.parse(b.earnedAt) || 0) - (Date.parse(a.earnedAt) || 0);
}

/** The first time it was earned: the medal's date. */
function firstEarned(awards: ReadonlyArray<BadgeAward>): string | null {
  let best: string | null = null;
  let bestT = Infinity;
  for (const a of awards) {
    const t = Date.parse(a.earnedAt);
    if (Number.isFinite(t) && t < bestT) { bestT = t; best = a.earnedAt; }
  }
  return best ?? (awards[0]?.earnedAt || null);
}

// ── Build ────────────────────────────────────────────────────────────────────

export type BuiltAchievements = {
  groups: AchievementGroup[];
  achievements: PickleagueAchievement[];
};

export function buildAchievements(input: BuildAchievementsInput): BuiltAchievements {
  const { earnedOnly = false } = input;
  const progress = earnedOnly ? null : input.progress ?? null;
  const out: PickleagueAchievement[] = [];

  const awardsByName = new Map<string, BadgeAward[]>();
  for (const a of input.awards) {
    const list = awardsByName.get(a.badgeName);
    if (list) list.push(a);
    else awardsByName.set(a.badgeName, [a]);
  }
  const catalogByName = new Map(input.catalog.map(b => [b.name, b]));

  // Known badges in catalogue order, then any the catalogue (badges table)
  // has that BADGE_DEFS doesn't, then awarded names in neither.
  const names: string[] = BADGE_DEFS.map(d => d.name);
  for (const b of input.catalog) if (!DEF_BY_NAME.has(b.name)) names.push(b.name);
  for (const n of awardsByName.keys()) if (!names.includes(n)) names.push(n);

  for (const name of names) {
    const def = DEF_BY_NAME.get(name);
    const row = catalogByName.get(name);
    // A def whose row is gone from the live catalogue (retired) shows only if earned.
    const retired = !!def && input.catalog.length > 0 && !row;
    const awards = [...(awardsByName.get(name) ?? [])].sort(newestFirst);
    const earnedAt = awards.length ? firstEarned(awards) : null;
    const group: AchievementGroupId = def?.group ?? (row?.category === 'league' ? 'league' : 'milestones');
    const glyph: IconName = def?.glyph ?? input.glyphForEmoji?.(row?.icon) ?? 'medal';
    const prog = !earnedAt ? progress?.[name] ?? null : null;
    out.push({
      id: achievementIdForBadge(name),
      name,
      description: def?.how ?? row?.description ?? undefined,
      groupId: group,
      glyph,
      earnedAt,
      progress: prog,
      // Silver / bronze finishes wear their own metal (foundation 1.85).
      ...(name === 'Season Silver' ? { tint: 'medalSilver', ringTint: 'medalSilver' } : null),
      ...(name === 'Season Bronze' ? { tint: 'medalBronze', ringTint: 'medalBronze' } : null),
      // "×3" on a badge earned several times (several leagues, stacking wins).
      count: awards.length > 1 ? awards.length : undefined,
      hidden: earnedOnly || retired || !!def?.hiddenUntilEarned,
      meta: {
        kind: 'badge',
        badgeName: name,
        awards,
        perLeague: def?.perLeague ?? row?.category === 'league',
        stacks: !!def?.stacks,
        rewards: rewardsForBadge(name, input.nameStyles),
      },
    });
  }

  // Login streak milestones (own view only: user_login_streaks is own-row RLS).
  if (input.streak && !earnedOnly) {
    const s = input.streak;
    for (const m of STREAK_MILESTONES) {
      const dated = s.reachedOn[m.days];
      // A streak that reached the milestone before its reward row existed has
      // no date; the kit shows an unparseable earnedAt as unlocked, undated.
      const earnedAt = dated ? dated : s.longest >= m.days ? 'reached' : null;
      out.push({
        id: `streak:${m.days}`,
        name: m.name,
        description: `Open Pickleague ${m.days} days in a row. Pays ${m.pickles.toLocaleString('en-US')} pickles.`,
        groupId: 'streaks',
        glyph: m.glyph,
        earnedAt,
        progress: earnedAt ? null : { current: Math.max(0, s.current), target: m.days, unit: 'days' },
        meta: { kind: 'streak', awards: [], perLeague: false, stacks: false, rewards: [], streakPickles: m.pickles },
      });
    }
  }

  // Getting started quests (own view only).
  if (input.ftue && !earnedOnly) {
    for (const d of FTUE_DEFS) {
      const st = input.ftue[d.step];
      const claimed = !!st?.claimedAt;
      const claimable = !!st?.complete && !claimed;
      out.push({
        id: `ftue:${d.step}`,
        name: d.name,
        description: d.how,
        groupId: 'getting-started',
        glyph: d.glyph,
        earnedAt: claimed ? st!.claimedAt : null,
        progress: claimable ? { current: 1, target: 1, label: 'Ready to claim' } : null,
        statusLabel: claimable ? 'Ready to claim' : undefined,
        meta: {
          kind: 'ftue', awards: [], perLeague: false, stacks: false, rewards: [],
          ftueStep: d.step, claimable, ftueReward: d.reward,
        },
      });
    }
  }

  // Shop collectibles: shown only once owned.
  for (const c of input.collectibles ?? []) {
    out.push({
      id: `collectible:${c.id}`,
      name: c.name,
      description: c.description ?? undefined,
      groupId: 'collection',
      glyph: input.glyphForEmoji?.(c.icon) ?? 'gift',
      earnedAt: c.acquiredAt || 'owned',
      hidden: true,
      meta: { kind: 'collectible', awards: [], perLeague: false, stacks: false, rewards: [], collectible: c },
    });
  }

  // Getting started sinks to the bottom once every quest is claimed.
  const gs = out.filter(a => a.groupId === 'getting-started' && !a.hidden);
  const gsDone = gs.length > 0 && gs.every(a => !!a.earnedAt);
  const groups: AchievementGroup[] = ACHIEVEMENT_GROUPS.map(g => {
    if (g.id === 'getting-started' && gsDone) return { ...g, order: GETTING_STARTED_DONE_ORDER };
    if (g.id === 'streaks' && input.streak && !earnedOnly && input.streak.current > 0) {
      const n = input.streak.current;
      return {
        ...g,
        badge: { label: `${n}d`, glyph: 'fire', tint: 'warning', accessibilityLabel: `${n} day streak` },
      };
    }
    return { ...g };
  });

  return { groups, achievements: out };
}

// ── Progress from lib/unlockProgress ─────────────────────────────────────────

/** The fields of lib/unlockProgress's BadgeProgress this needs. */
export type BadgeProgressInput = {
  badge: string;
  current: number;
  target: number;
  pct: number;
  earned: boolean;
  perLeague: boolean;
};

/**
 * computeBadgeProgress() rows -> the kit's progress per badge name. Per-league
 * rows have no account-wide number and are left out. Top Rated shows a
 * percentage: PLUPR is kept inside leagues, so the profile never prints it.
 */
export function progressByBadge(list: ReadonlyArray<BadgeProgressInput>): Record<string, AchievementProgress> {
  const out: Record<string, AchievementProgress> = {};
  for (const p of list) {
    if (p.perLeague || p.earned || !(p.target > 0)) continue;
    if (p.badge === 'Top Rated' || !Number.isInteger(p.target)) {
      const pct = Math.round(Math.max(0, Math.min(1, p.pct)) * 100);
      out[p.badge] = { current: pct, target: 100, label: `${pct}%` };
      continue;
    }
    out[p.badge] = {
      current: Math.max(0, Math.floor(p.current)),
      target: p.target,
      unit: DEF_BY_NAME.get(p.badge)?.unit,
    };
  }
  return out;
}

// ── Summaries ────────────────────────────────────────────────────────────────

/** "12 of 40 unlocked" over every visible achievement (hidden-until-earned ones count once earned). */
export function overallSummary(list: ReadonlyArray<Achievement<any>>): { earned: number; total: number } {
  let earned = 0;
  let total = 0;
  for (const a of list) {
    const isE = typeof a.earnedAt === 'string' && a.earnedAt.length > 0;
    if (a.hidden && !isE) continue;
    total += 1;
    if (isE) earned += 1;
  }
  return { earned, total };
}

/** The badge-backed achievement for a badge name (the Me "Next unlock" row opens on it). */
export function achievementIdForFocus(badgeName: string | null | undefined): string | null {
  return badgeName ? achievementIdForBadge(badgeName) : null;
}

/** Earned instances as display lines: "Fall League · Oct 2, 2026". */
export function awardLines(
  awards: ReadonlyArray<BadgeAward>,
  formatDate: (d: Date) => string,
): { id: string; text: string; matchId: string | null; context: string | null }[] {
  return awards.map(a => {
    const t = Date.parse(a.earnedAt);
    const date = Number.isFinite(t) ? formatDate(new Date(t)) : '';
    const text = [a.leagueName, date].filter(Boolean).join(' · ');
    return { id: a.id, text, matchId: a.matchId, context: a.context };
  });
}

/** Hidden from the public profile = every earned instance hidden. */
export function isHiddenFromProfile(meta: PickleagueAchievementMeta | undefined): boolean {
  if (!meta) return false;
  if (meta.kind === 'collectible') return !!meta.collectible?.isHidden;
  return meta.awards.length > 0 && meta.awards.every(a => a.isHidden);
}
