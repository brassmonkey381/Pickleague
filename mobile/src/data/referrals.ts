// Referrals, the data side (supabase/migration_referrals.sql; Doggle's
// data/referrals.ts + referralPreview.ts). Copy and arithmetic live in
// lib/referralRules.ts. Nothing here runs unless REFERRALS_ENABLED is on:
// every caller is behind the flag.
import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import { DAY_MS, WEEK_MS } from '@just-messin-around/expo-foundation/cache';
import {
  createDeferredInviteClient,
  createReferralStash,
  inviteLink,
} from '@just-messin-around/expo-foundation/referrals';
import { supabase } from '../lib/supabase';
import {
  INVITE_ORIGIN,
  INVITE_SHARE_MESSAGE,
  REFERRAL_STASH_KEY,
  parseReferralStats,
  type ClaimReferralResult,
  type ReferralStats,
} from '../lib/referralRules';

// Per-user singletons read through useCachedQuery. The code never changes; the
// stats change only when an invitee joins (server side), so both cache long.
export const REFERRAL_CODE_KEY = 'me:referral:code';
export const REFERRAL_STATS_KEY = 'me:referral:stats';
export const REFERRAL_CODE_TTL_MS = DAY_MS;
export const REFERRAL_CODE_PERSIST_MS = WEEK_MS;
export const REFERRAL_STATS_TTL_MS = 5 * 60_000;
export const REFERRAL_STATS_PERSIST_MS = DAY_MS;

/** The pending code on this device, from link open to the claim after sign-in. */
export const referralStash = createReferralStash({ key: REFERRAL_STASH_KEY });

/** Click-to-install matching through the two edge functions. */
export const deferredInvites = createDeferredInviteClient({ supabase });

export async function getMyReferralCode(): Promise<string> {
  const data = await sbCall(() => supabase.rpc('my_referral_code'));
  return typeof data === 'string' ? data : '';
}

export async function getMyReferralStats(): Promise<ReferralStats> {
  return parseReferralStats(await sbCall(() => supabase.rpc('my_referral_stats')));
}

/** Link the signed-in account to a code's owner (pays at once when the email is confirmed). */
export async function claimReferral(code: string): Promise<ClaimReferralResult> {
  const data = await sbCall(() => supabase.rpc('claim_referral', { p_code: code }));
  return (data && typeof data === 'object' ? data : { linked: false }) as ClaimReferralResult;
}

export type ReferralPreview = {
  referrer_name: string | null;
  avatar_url: string | null;
  avatar_emoji: string | null;
  avatar_bg_color: string | null;
};

/** Who is inviting (first name and avatar), for the landing. Signed-out callable; null on any miss. */
export async function getReferralPreview(code: string): Promise<ReferralPreview | null> {
  if (!code) return null;
  try {
    const { data, error } = await supabase.rpc('referral_preview', { p_code: code });
    if (error || !data || typeof data !== 'object') return null;
    const r = data as Record<string, unknown>;
    const s = (v: unknown) => (typeof v === 'string' && v ? v : null);
    return {
      referrer_name: s(r.referrer_name),
      avatar_url: s(r.avatar_url),
      avatar_emoji: s(r.avatar_emoji),
      avatar_bg_color: s(r.avatar_bg_color),
    };
  } catch {
    return null;
  }
}

/** https://www.pickleague.club/invite/CODE ('' without a code). */
export function referralInviteUrl(code: string | null | undefined): string {
  return inviteLink(INVITE_ORIGIN, code);
}

/** What the share sheet / clipboard gets. */
export function referralShareContent(code: string): { title: string; message: string; url: string } {
  return { title: 'Join me on Pickleague', message: INVITE_SHARE_MESSAGE, url: referralInviteUrl(code) };
}
