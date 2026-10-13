// One-line summaries for the compact Profile (plan section 5, "Profile"):
//   - nextUnlockTeaser: the status strip ("Next unlock: Ninja avatar 3/5 >")
//     that replaced the ~900px Unlockable Rewards card (or "N more to earn in
//     league play" / "Every unlock earned" once nothing measurable is left).
// The collapsed Availability section's summary ("Weeknights · 9 hrs/wk") is
// the foundation's availabilityShortSummary (/scheduling/availability).
//
// PURE (no react-native import) so it is unit-tested.
import { AVATARS, PLAY_TAGS, TAG_SLOT_UNLOCKS } from '../data/profileCustomization';

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
