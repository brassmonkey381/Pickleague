import AsyncStorage from '@react-native-async-storage/async-storage';
import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import type { StreakMilestone } from '@just-messin-around/expo-foundation/gamification';
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

/** Days 1-7 of a streak build up (Doggle's login bonus); day 8 on pays
 *  DAILY_STREAK_PICKLES. Mirrors `v_sched` in claim_daily_login_streak
 *  (migration_fair_rewards.sql). */
export const LOGIN_BONUS_SCHEDULE = [15, 24, 33, 42, 51, 60, 75];

/** Pickles each day from day 8 on, a little above the first week's average. */
export const DAILY_STREAK_PICKLES = 50;

/** What one streak day pays (before any streak badge). */
export function dailyPicklesFor(day: number): number {
  return day >= 1 && day <= LOGIN_BONUS_SCHEDULE.length ? LOGIN_BONUS_SCHEDULE[day - 1] : DAILY_STREAK_PICKLES;
}

/** The streak badges, each paid once per account (same RPC, same migration;
 *  lib/achievements' STREAK_MILESTONES shows them on the Achievements page). */
const MILESTONE_BONUS: { day: number; bonus: number; label: string }[] = [
  { day: 7, bonus: 200, label: 'Week Streak' },
  { day: 30, bonus: 1000, label: 'Month Streak' },
  { day: 100, bonus: 2500, label: '100-Day Streak' },
  { day: 365, bonus: 10000, label: 'Year Streak' },
];

/** The road map the streak modal shows (the foundation LoginBonusModal's
 *  `roadmap`): each badge day's reward is that day's pickles plus the badge,
 *  as the RPC grants them. (Named apart from the foundation's
 *  buildStreakRoadmap, which builds a different shape.) */
export function streakRoadmapFor(): StreakMilestone[] {
  return MILESTONE_BONUS.map(m => ({ day: m.day, reward: dailyPicklesFor(m.day) + m.bonus, label: m.label }));
}

/** The road map at the RPC's current rates. */
export const STREAK_ROADMAP: StreakMilestone[] = streakRoadmapFor();

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

// ── Per user, per day ────────────────────────────────────────────────────────
// The streak modal opens only when today's reward was actually claimed, and at
// most once per user per calendar day: the in-memory guard above resets on a
// cold start, so without this a second launch the same day could show the
// celebration again for a claim the server already reported. AsyncStorage
// only; a failed read or write never blocks the claim itself.

const SHOWN_DAY_KEY_PREFIX = 'pickleague_streak_modal_day_v1:';

/** Local calendar day, "YYYY-MM-DD" (the user's day, not UTC). */
export function localDayKey(now: Date = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

/** The storage key that remembers the last day this user saw the modal. */
export function streakShownStorageKey(userId: string): string {
  return `${SHOWN_DAY_KEY_PREFIX}${userId}`;
}

/** True when the modal already opened for this user today. */
export async function wasStreakModalShownToday(userId: string, now: Date = new Date()): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(streakShownStorageKey(userId))) === localDayKey(now);
  } catch {
    return false;
  }
}

export async function markStreakModalShownToday(userId: string, now: Date = new Date()): Promise<void> {
  try {
    await AsyncStorage.setItem(streakShownStorageKey(userId), localDayKey(now));
  } catch {
    // Can't remember it: worst case the next launch today shows it again.
  }
}

/** Whether a claim result is worth a modal: only a reward granted just now. */
export function streakRewardClaimable(result: StreakResult | null): result is StreakResult {
  return !!result && result.claimed_today && result.daily_pickles + result.milestone_pickles > 0;
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
  for (const { day: m } of MILESTONE_BONUS) {
    if (streak < m) return { next: m, in: m - streak };
  }
  return { next: null, in: null };
}
