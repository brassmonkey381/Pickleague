// The daily login streak celebration: Pickleague's StreakResult mapped onto the
// foundation's LoginBonusModal (hero number, itemised reward, road map, stats).
// Replaces the hand-rolled StreakModal (plan section 3, rule 6). Home opens it
// only when today's reward was just claimed, once per user per day
// (lib/loginStreak: streakRewardClaimable + wasStreakModalShownToday), and
// never while another modal is up (HomeScreen's modal queue).
import React from 'react';
import { LoginBonusModal, type LoginBonusReward } from '@just-messin-around/expo-foundation/gamification';
import { streakRoadmapFor, DAILY_STREAK_PICKLES, type StreakResult } from '../../lib/loginStreak';

type Props = {
  visible: boolean;
  result: StreakResult | null;
  onClose: () => void;
};

const pickles = (n: number) => `+${n} 🥒`;

export default function StreakBonusModal({ visible, result, onClose }: Props) {
  if (!result) return null;
  const rewards: LoginBonusReward[] = [{ label: 'Daily login', amount: result.daily_pickles }];
  if (result.milestone_pickles > 0) {
    rewards.push({ label: `🎉 ${result.milestone_label ?? 'Milestone'}`, amount: result.milestone_pickles, emphasis: true });
  }
  return (
    <LoginBonusModal
      visible={visible}
      day={result.streak_after}
      awarded={result.daily_pickles + result.milestone_pickles}
      streak={result.streak_after}
      hero
      rewards={rewards}
      alreadyClaimed={!result.claimed_today}
      claimedMessage="Come back tomorrow to extend your streak."
      message={result.used_freeze ? '❄️ Used a streak freeze to bridge a missed day.' : undefined}
      // daily_pickles is 0 on an already-claimed result; fall back to the rate.
      roadmap={streakRoadmapFor(result.daily_pickles || DAILY_STREAK_PICKLES)}
      stats={[
        { label: 'Longest', value: result.longest_streak },
        { label: 'Freezes left', value: result.freezes_remaining },
      ]}
      formatAmount={pickles}
      ctaLabel={result.claimed_today ? 'Sweet!' : 'Got it'}
      dismissOnBackdrop
      onClose={onClose}
    />
  );
}
