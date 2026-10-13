// One-line summaries for the compact Profile (plan section 5, "Profile"):
//   - availabilitySummary: the collapsed Availability section's summary
//     ("Weeknights · 9 hrs/wk"), so the 672px grid only mounts when opened;
//   - nextUnlockTeaser: the status strip ("Next unlock: Ninja avatar 3/5 >")
//     that replaced the ~900px Unlockable Rewards card (or "N more to earn in
//     league play" / "Every unlock earned" once nothing measurable is left).
//
// PURE (no react-native import) so both are unit-tested.
import {
  AVAIL_DAYS,
  SLOTS_PER_DAY,
  TOTAL_CELLS,
  cellIdx,
} from '@just-messin-around/expo-foundation/scheduling/availability';
import { AVATARS, PLAY_TAGS, TAG_SLOT_UNLOCKS } from '../data/profileCustomization';

// ── Availability ─────────────────────────────────────────────────────────────

// Half-hour slot boundaries (slot 10 = 5:00 AM, 24 = noon, 34 = 5:00 PM).
const MORNING_START = 10;
const AFTERNOON_START = 24;
const EVENING_START = 34;

/** A bucket must hold at least this share of the week's hours to be named. */
const NAMED_SHARE = 0.25;

/** "9 hrs/wk", "1 hr/wk", "2.5 hrs/wk". */
export function hoursPerWeekLabel(slots: number): string {
  const hrs = slots * 0.5;
  const text = Number.isInteger(hrs) ? String(hrs) : hrs.toFixed(1);
  return `${text} ${hrs === 1 ? 'hr' : 'hrs'}/wk`;
}

/**
 * FOUNDATION-TODO: this is generic weekly-template math; it belongs next to
 * formatAvailabilitySummary in fdn scheduling/availability (as e.g.
 * `availabilityShortSummary`) once a second app wants it.
 *
 * "Weeknights · 9 hrs/wk", "Weekends · 6 hrs/wk",
 * "Weeknights & weekends · 14 hrs/wk", "Mixed · 3 hrs/wk".
 * Null when nothing is set (or the array isn't the weekly 336-cell template),
 * so the caller can say "Not set" instead of "0 hrs/wk".
 *
 * Buckets: weekday mornings (5 AM-noon), weekday afternoons (noon-5 PM),
 * weeknights (5 PM-5 AM, late night folds in here), weekends (any time). The
 * up-to-two buckets holding at least a quarter of the hours are named, biggest
 * first; a spread-out week reads "Mixed".
 */
export function availabilitySummary(av: readonly boolean[] | null | undefined): string | null {
  if (!av || av.length !== TOTAL_CELLS) return null;
  const buckets = { mornings: 0, afternoons: 0, nights: 0, weekends: 0 };
  let total = 0;
  for (let d = 0; d < AVAIL_DAYS.length; d++) {
    const weekend = d >= 5; // Monday-start: 5 = Sat, 6 = Sun
    for (let s = 0; s < SLOTS_PER_DAY; s++) {
      if (!av[cellIdx(d, s)]) continue;
      total += 1;
      if (weekend) buckets.weekends += 1;
      else if (s >= MORNING_START && s < AFTERNOON_START) buckets.mornings += 1;
      else if (s >= AFTERNOON_START && s < EVENING_START) buckets.afternoons += 1;
      else buckets.nights += 1;
    }
  }
  if (total === 0) return null;

  const names: Record<keyof typeof buckets, string> = {
    nights: 'weeknights',
    weekends: 'weekends',
    mornings: 'weekday mornings',
    afternoons: 'weekday afternoons',
  };
  // Stable order on ties: the order of `names` above.
  const named = (Object.keys(names) as (keyof typeof buckets)[])
    .map((k, order) => ({ k, share: buckets[k] / total, order }))
    .filter(b => b.share >= NAMED_SHARE)
    .sort((a, b) => b.share - a.share || a.order - b.order)
    .slice(0, 2)
    .map(b => names[b.k]);

  const label = named.length === 0 ? 'mixed' : named.join(' & ');
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} · ${hoursPerWeekLabel(total)}`;
}

// ── Next unlock ──────────────────────────────────────────────────────────────

/** The fields of lib/unlockProgress's BadgeProgress this needs (kept
 *  structural so the pure helper doesn't import the Supabase-backed module). */
export type UnlockProgressInput = {
  badge: string;
  current: number;
  target: number;
  pct: number;
  earned: boolean;
  perLeague: boolean;
};

export type NextUnlockTeaser = {
  /** What the badge unlocks: "Ninja avatar", "+1 tag slot", "🔥 Hot Streak Slayer tag",
   *  or "<Badge> badge" when it gates nothing on the profile. */
  reward: string;
  badge: string;
  /** 0..1 */
  pct: number;
  /** "3/5", or a percentage for the PLUPR goal (PLUPR stays inside leagues). */
  valueText: string;
  /** Screen-reader value: "3 of 5" (a reader may say "3/5" as a date). */
  a11yValue: string;
};

/** The profile reward a badge unlocks, avatar first. Null when it gates none. */
export function rewardForBadge(badge: string): string | null {
  const avatar = AVATARS.find(a => a.unlock?.badge === badge);
  if (avatar) return `${avatar.name} avatar`;
  if (TAG_SLOT_UNLOCKS.some(u => u.badge === badge)) return '+1 tag slot';
  const tag = PLAY_TAGS.find(t => t.unlock?.badge === badge);
  if (tag) return `${tag.label} tag`;
  return null;
}

/** What the status strip shows. */
export type NextUnlockResult =
  /** A measurable badge to work toward. */
  | ({ kind: 'next' } & NextUnlockTeaser)
  /** Every account-wide badge is earned, but `remaining` badges can only be
   *  earned in league play (per-league badges have no account-wide progress to
   *  show). Several gate profile rewards (the League Leader avatar, the
   *  Dominant / Hat Trick / Comeback King ... tags), so this must not read
   *  "all earned". */
  | { kind: 'league_only'; remaining: number }
  /** No unearned badge of any kind is left. */
  | { kind: 'all_earned' };

/**
 * The status strip's "next unlock": among badges not yet earned that have an
 * account-wide threshold (per-league badges can't be measured here), the one
 * closest to done — preferring one that unlocks a profile reward. When none is
 * left, says whether league-only badges remain or truly everything is earned.
 */
export function nextUnlockTeaser(progress: readonly UnlockProgressInput[]): NextUnlockResult {
  const open = progress
    .filter(p => !p.earned && !p.perLeague && p.target > 0)
    .sort((a, b) => b.pct - a.pct);
  if (open.length === 0) {
    // Whatever is still unearned can't be measured account-wide; in practice
    // that is the per-league badges.
    const remaining = progress.filter(p => !p.earned).length;
    return remaining > 0 ? { kind: 'league_only', remaining } : { kind: 'all_earned' };
  }
  const pick = open.find(p => rewardForBadge(p.badge) != null) ?? open[0];
  const pct = Math.max(0, Math.min(1, pick.pct));
  // Top Rated's target is a PLUPR value; PLUPR is kept inside leagues, so the
  // profile shows how far along it is, not the rating itself.
  const asPercent = !Number.isInteger(pick.target) || pick.badge === 'Top Rated';
  const current = Math.max(0, Math.floor(pick.current));
  const valueText = asPercent ? `${Math.round(pct * 100)}%` : `${Math.min(current, pick.target)}/${pick.target}`;
  const a11yValue = asPercent
    ? `${Math.round(pct * 100)} percent`
    : `${Math.min(current, pick.target)} of ${pick.target}`;
  return {
    kind: 'next',
    reward: rewardForBadge(pick.badge) ?? `${pick.badge} badge`,
    badge: pick.badge,
    pct,
    valueText,
    a11yValue,
  };
}
