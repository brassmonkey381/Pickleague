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

export async function claimDailyLoginStreak(): Promise<StreakResult | null> {
  const { data, error } = await supabase.rpc('claim_daily_login_streak');
  if (error) return null;
  const row = Array.isArray(data) ? data[0] : data;
  return row ?? null;
}

export function daysToNextMilestone(streak: number): { next: number | null; in: number | null } {
  for (const m of STREAK_MILESTONES) {
    if (streak < m) return { next: m, in: m - streak };
  }
  return { next: null, in: null };
}
