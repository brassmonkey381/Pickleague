// Referral copy and arithmetic (supabase/migration_referrals.sql pays these
// amounts). PURE (no React Native, no kit imports), so vitest covers it
// (lib/__tests__/referralRules.test.ts); lib/referrals.ts is the data side.

/** What each side gets once the new account confirms its email. */
export const REFERRAL_REWARD_PICKLES = 2500;

/** Referrer milestones: badge at each count, bonus pickles at some. */
export const REFERRAL_MILESTONES: readonly { joined: number; badge: string; bonus: number }[] = [
  { joined: 1, badge: 'Recruiter', bonus: 0 },
  { joined: 5, badge: 'Squad Builder', bonus: 2500 },
  { joined: 10, badge: 'Club Builder', bonus: 5000 },
];

/** Every invite link points here (both origins are in the linking prefixes and
 *  the associated domains; www is the one the Open Graph cards use). */
export const INVITE_ORIGIN = 'https://www.pickleague.club';

/** Where the pending code waits on this device (localStorage on web). */
export const REFERRAL_STASH_KEY = 'pickleague:pendingReferral';

/** The share text before the link. */
export const INVITE_SHARE_MESSAGE = `Join me on Pickleague — sign up with my link and we both get ${REFERRAL_REWARD_PICKLES} pickles`;

/** What claim_referral answers. */
export type ClaimReferralResult = {
  linked: boolean;
  reason?: 'guest' | 'self' | 'already_referred' | 'too_old' | 'unknown_code' | 'no_code' | 'no_profile' | 'signed_out' | string | null;
  referrer_name?: string | null;
  /** True when this claim (or an earlier one) paid. */
  rewarded?: boolean | null;
  /** Linked earlier to the same referrer (e.g. the code rode in on sign-up). */
  already?: boolean | null;
};

/** What my_referral_stats answers. */
export type ReferralStats = { invited: number; joined: number; pending: number; pickles_earned: number };

export const ZERO_REFERRAL_STATS: ReferralStats = { invited: 0, joined: 0, pending: 0, pickles_earned: 0 };

/** Coerce an RPC answer into stats (missing or bad numbers read 0). */
export function parseReferralStats(raw: unknown): ReferralStats {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
  return { invited: n(o.invited), joined: n(o.joined), pending: n(o.pending), pickles_earned: n(o.pickles_earned) };
}

/** The toast after a claim, or null when there is nothing to say (refusals are silent, as in Doggle). */
export function claimToastText(r: ClaimReferralResult | null | undefined): string | null {
  if (!r?.linked) return null;
  const who = r.referrer_name?.trim();
  const by = who ? `Referred by ${who}` : 'Referred by a friend';
  return r.rewarded
    ? `${by} — you both got ${REFERRAL_REWARD_PICKLES} pickles!`
    : `${by} — confirm your email to get ${REFERRAL_REWARD_PICKLES} pickles`;
}

/** Pickles this claim paid me just now, to rain: 0 when it didn't pay, or an earlier claim did. */
export function claimRainPickles(r: ClaimReferralResult | null | undefined): number {
  return r?.linked && r.rewarded && !r.already ? REFERRAL_REWARD_PICKLES : 0;
}

/** A claim answer that should keep the stashed code for later: a guest, who
 *  qualifies only after upgrading to a real account. */
export function keepReferralForLater(r: ClaimReferralResult | null | undefined): boolean {
  return r?.reason === 'guest';
}

/** The next milestone line for the Invite & Earn card, or null past the last. */
export function nextMilestoneText(joined: number): string | null {
  const next = REFERRAL_MILESTONES.find((m) => m.joined > joined && m.bonus > 0);
  if (!next) return null;
  const left = next.joined - joined;
  return `${left} more friend${left === 1 ? '' : 's'} to the ${next.badge} badge and +${next.bonus} bonus pickles`;
}

/** The reward line on the card and the landing. */
export function referralRewardLine(): string {
  return `When a friend signs up with your link and confirms their email, you both get ${REFERRAL_REWARD_PICKLES} pickles.`;
}
