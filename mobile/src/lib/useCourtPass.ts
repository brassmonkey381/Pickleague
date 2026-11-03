// The running Court Pass for the signed-in player: the RPC rows
// (data/rewardTrack), the kit's screen model built from them, and the chip's
// summary. Ported from Doggle's hooks/useParkPass (docs/court-pass.md).
//
// Shared by the Home chip, the My Place link and the Court Pass screen (one
// cache key, so they agree). Re-reads on focus (TTL-guarded). A read can pay a
// reached tier (the server's settle step); the pickles it paid rain once here,
// the first time that tier's payout shows up this run, and tiers from an
// earlier cycle (reached before it ended, paid on this open) get a toast too.
import React from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { cachedFetch, useCachedQuery } from '@just-messin-around/expo-foundation/cache';
import {
  buildRewardTrack,
  type RewardTrackModel,
} from '@just-messin-around/expo-foundation/gamification/rewardTrack';
import {
  REWARD_TRACK_KEY,
  REWARD_TRACK_PERSIST_MS,
  REWARD_TRACK_TTL_MS,
  fetchRewardTrack,
  takeFreshPaid,
  unseenGrants,
  type RewardTrackData,
} from '../data/rewardTrack';
import { rainPayout } from './payoutRain';
import { useToast } from './useToast';
import { COURT_PASS_COPY, earlierRewardsToast, type CourtPassSummary } from './courtPassCopy';

const fetchCurrent = () => fetchRewardTrack(null);
const OPTS = { ttlMs: REWARD_TRACK_TTL_MS, persistMs: REWARD_TRACK_PERSIST_MS };
/** After the screen settles, like Home's reward pop-ups (HomeScreen closeModal). */
const RAIN_DELAY_MS = 350;

// Tiers already rained this app run ('<cycle>:<tier>'), so a payout two
// screens both see rains once.
const rainedGrants = new Set<string>();

/** The kit model for a loaded pass (null between passes). `now` is injectable for tests. */
export function courtPassModel(d: RewardTrackData | null | undefined, now: Date = new Date()): RewardTrackModel | null {
  if (!d?.window) return null;
  return buildRewardTrack({
    tiers: d.tiers,
    rewards: d.rewards,
    grants: d.grants,
    xp: d.me.xp,
    window: d.window,
    now,
    copy: COURT_PASS_COPY,
  });
}

/** The chip's numbers; null when there is nothing to show (no pass, none seeded, or it ended). */
export function courtPassSummary(
  d: RewardTrackData | null | undefined,
  model: RewardTrackModel | null,
): CourtPassSummary | null {
  if (!d) return null;
  if (model && !model.ended && model.rows.length > 0) {
    return {
      kind: 'running',
      tier: model.currentTier,
      xpToNext: model.xpToNext,
      finished: model.finished,
      newCount: unseenGrants(d).length,
    };
  }
  if (d.nextStartsAt) return { kind: 'next', startsAt: d.nextStartsAt };
  return null;
}

export function useCourtPass(opts?: { enabled?: boolean }) {
  const enabled = opts?.enabled !== false;
  const toast = useToast();
  const query = useCachedQuery(REWARD_TRACK_KEY, fetchCurrent, { ...OPTS, enabled });
  const data = query.data ?? null;

  useFocusEffect(
    React.useCallback(() => {
      if (!enabled) return;
      // A failed re-read keeps what's drawn; the screen's QueryState shows a first-load failure.
      void cachedFetch(REWARD_TRACK_KEY, fetchCurrent, OPTS).catch(() => {});
    }, [enabled]),
  );

  // Rain what a server read paid, once per tier per run.
  React.useEffect(() => {
    if (!enabled || !data) return;
    for (const paid of takeFreshPaid()) {
      const fresh = paid.grants.filter((g) => !rainedGrants.has(`${g.cycleId}:${g.tier}`));
      if (fresh.length === 0) continue;
      fresh.forEach((g) => rainedGrants.add(`${g.cycleId}:${g.tier}`));
      rainPayout(paid.pickles, RAIN_DELAY_MS);
      const earlier = fresh.find((g) => g.cycleId !== data.cycle?.id);
      if (earlier) toast.success(earlierRewardsToast(earlier.cycleId));
    }
  }, [data, enabled, toast]);

  const model = React.useMemo(() => courtPassModel(data), [data]);
  const summary = React.useMemo(() => courtPassSummary(data, model), [data, model]);
  return { query, data, model, summary };
}
