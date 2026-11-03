// Court Pass (the monthly reward track, docs/court-pass.md): the two client
// RPCs in supabase/migration_court_pass_xp.sql, mapped onto the kit's
// reward-track types (lib/rewardTrackRows) so screens hand the rows straight
// to buildRewardTrack. Ported from Doggle's data/rewardTrack.
//
// get_reward_track also settles: before it answers, it pays every tier the
// caller has reached but wasn't paid for (pickles as a gold 'Court Pass tier
// N' ledger row, items into player_shop_purchases / home_owned_items), and
// says what it paid in `paid`. So a read can move pickles: this file drops
// the caches that show them, and hands the payout to lib/useCourtPass (which
// rains it) through takeFreshPaid(). Only a read from the server does: a copy
// the cache restored from disk never rains a second time.
import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import { cachedFetch, invalidateQueries } from '@just-messin-around/expo-foundation/cache';
import { supabase } from '../lib/supabase';
import { isServerRefusal, refusalMessage } from '../lib/refusals';
import { mapRewardTrack, unseenGrants, type RewardTrackData, type TrackPaid } from '../lib/rewardTrackRows';
import { HOME_KEY } from '../components/home/homeData';
import { PICKLE_CALENDAR_CACHE_KEY } from './pickleLedger';
import { invalidateMyPlace } from './myPlace';

export { mapRewardTrack, unseenGrants };
export type { CourtTrackReward, RewardTrackCycle, RewardTrackData, TrackPaid } from '../lib/rewardTrackRows';

/** Viewer-owned (`me:` prefix), so the auth-bound cache drops it on sign-out. */
export const REWARD_TRACK_KEY = 'me:rewardTrack';
/** Short: XP moves with every match, and a read is what pays a reached tier. */
export const REWARD_TRACK_TTL_MS = 60_000;
/** The chip draws from disk on a cold start, then re-reads. */
export const REWARD_TRACK_PERSIST_MS = 24 * 60 * 60 * 1000;

const BOUND = { timeoutMs: 9_000 };

/** A refusal (pl:<code>) keeps the server's words; a known older text gets the app's. */
async function call(build: Parameters<typeof sbCall<unknown>>[0]): Promise<unknown> {
  try {
    return await sbCall(build, BOUND);
  } catch (e) {
    if (isServerRefusal(e)) throw e;
    const copy = refusalMessage(e);
    throw copy ? new Error(copy) : e;
  }
}

// What reads from the server paid and nobody has rained yet (oldest first).
const freshPaid: TrackPaid[] = [];

/** Payouts from server reads since the last call, emptied (lib/useCourtPass rains them). */
export function takeFreshPaid(): TrackPaid[] {
  return freshPaid.splice(0, freshPaid.length);
}

/** One uncached read (it also pays any reached tier). */
export async function fetchRewardTrack(cycleId?: string | null): Promise<RewardTrackData> {
  const mapped = mapRewardTrack(await call(() => supabase.rpc('get_reward_track', { p_cycle: cycleId ?? null })));
  const { paid } = mapped;
  if (paid.grants.length > 0) {
    freshPaid.push(paid);
    if (paid.pickles > 0) {
      // The balance other screens show: Home's greeting, and the pickle ledger.
      invalidateQueries(HOME_KEY);
      invalidateQueries(PICKLE_CALENDAR_CACHE_KEY);
    }
    // A decor tier is in my room's owned list now.
    if (paid.grants.some((g) => g.kind === 'home_item')) invalidateMyPlace();
  }
  return mapped;
}

/** The running pass, cached briefly (the Home chip, My Place and the screen share it). */
export async function getRewardTrack(): Promise<RewardTrackData> {
  return cachedFetch(REWARD_TRACK_KEY, () => fetchRewardTrack(null), {
    ttlMs: REWARD_TRACK_TTL_MS,
    persistMs: REWARD_TRACK_PERSIST_MS,
  });
}

/** Mark this pass's new rewards as shown (after the celebration). */
export async function markTrackRewardsSeen(cycleId: string): Promise<void> {
  await call(() => supabase.rpc('mark_track_rewards_seen', { p_cycle: cycleId }));
  invalidateQueries(REWARD_TRACK_KEY);
}

export function invalidateRewardTrack(): void {
  invalidateQueries(REWARD_TRACK_KEY);
}
