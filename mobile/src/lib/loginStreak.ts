import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from './supabase';

export type StreakResult = {
  claimed_today: boolean;
  streak_before: number;
  streak_after: number;
  daily_pickles: number;
  milestone_pickles: number;
  milestone_label: string | null;
  used_freeze: boolean;
  freezes_remaining: number;
  longest_streak: number;
};

export const STREAK_MILESTONES = [3, 7, 30, 100] as const;

let shownForUserId: string | null = null;

export function markStreakShown(userId: string): void {
  shownForUserId = userId;
}

export function hasStreakBeenShown(userId: string): boolean {
  return shownForUserId === userId;
}

// Called when the active auth user changes so the modal pops again on next focus.
export function resetStreakShown(): void {
  shownForUserId = null;
}

/**
 * Claims today's streak. Retried on transient network failures — the RPC is
 * day-idempotent (a second call returns claimed_today), so a request that
 * actually landed can't double-credit, and losing a streak because the WiFi
 * blipped on app open is a real user-visible loss.
 */
export async function claimDailyLoginStreak(): Promise<StreakResult | null> {
  try {
    const data = await sbCall(() => supabase.rpc('claim_daily_login_streak'));
    const row = Array.isArray(data) ? data[0] : data;
    return row ?? null;
  } catch {
    return null;
  }
}

export function daysToNextMilestone(streak: number): { next: number | null; in: number | null } {
  for (const m of STREAK_MILESTONES) {
    if (streak < m) return { next: m, in: m - streak };
  }
  return { next: null, in: null };
}
