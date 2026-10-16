// Court presence privacy (docs/play-sessions-presence.md, decision 1): who sees
// your name when you are at a court, who sees your planned games, and the pause.
//
// PURE: no React, no Supabase, no clock of its own (every function takes
// `now`). The server is the enforcement boundary: a missing presence_settings
// row means the defaults, resolved in SQL, and every level is applied at read
// time by _pl_can_see_presence. This file names the levels for the screens and
// turns the RPC's jsonb into a typed value the screens can trust, so a field
// the server leaves out never reads as `undefined` (a partial jsonb default
// once silently flipped fields in Doggle).
//
// "League-mates" means a CLOSED league you share (leagues.is_open = false),
// both admitted while it was closed: anyone can join an open league instantly,
// so sharing one says nothing, even after it is closed.
import { calendarDayDiff, shortTime } from './agenda';

export type CheckinsLevel = 'everyone' | 'leaguemates' | 'friends' | 'hidden';
export type PlansLevel = 'leaguemates' | 'friends' | 'hidden';

/** get_my_presence_settings() / set_presence_settings() (the full row). */
export type PresenceSettings = {
  checkins_level: CheckinsLevel;
  plans_level: PlansLevel;
  /** While in the future, everyone but you sees "a player". */
  paused_until: string | null;
  /** Set once the one-time consent sheet was accepted (on any device). */
  consent_seen_at: string | null;
  /** Read in Phase 2 (opt-in auto check-in). */
  auto_checkin: boolean;
};

export const DEFAULT_PRESENCE_SETTINGS: PresenceSettings = {
  checkins_level: 'leaguemates',
  plans_level: 'friends',
  paused_until: null,
  consent_seen_at: null,
  auto_checkin: false,
};

export type LevelOption<L extends string> = { value: L; label: string; desc: string };

/** Settings > Privacy > "Who sees me at the courts", in the order shown. */
export const CHECKINS_LEVELS: LevelOption<CheckinsLevel>[] = [
  { value: 'everyone', label: 'Everyone', desc: 'Anyone signed in to Pickleague sees your name at the court.' },
  {
    value: 'leaguemates',
    label: 'Friends and league-mates',
    desc: 'Your friends, and players in a closed league you are both in.',
  },
  { value: 'friends', label: 'Friends', desc: 'Only your friends see your name.' },
  { value: 'hidden', label: 'Hidden', desc: 'Nobody sees your name. You still count as "a player".' },
];

/** "Who sees my planned games". No "Everyone": a plan says where you will be
 *  later, which is more than where you are now. The Settings row ships with
 *  Phase 3 (court_plans); the value is stored and read already. */
export const PLANS_LEVELS: LevelOption<PlansLevel>[] = [
  {
    value: 'leaguemates',
    label: 'Friends and league-mates',
    desc: 'Your friends, and players in a closed league you are both in.',
  },
  { value: 'friends', label: 'Friends', desc: 'Only your friends see the games you plan.' },
  { value: 'hidden', label: 'Hidden', desc: 'Nobody sees the games you plan.' },
];

/** Under the level choices: what "league-mates" means, and what everyone else sees. */
export const LEAGUEMATES_NOTE =
  'League-mates are players in a closed league you share (one you joined by invite or approval). ' +
  "Open leagues don't count: anyone can join them.";

// A blocked pair sees each other only as "a player", like any stranger: left
// out of the count, the one missing would stand out.
export const OTHERS_NOTE = 'Everyone else sees "a player" in the count. Blocked players never see your name.';

function isCheckinsLevel(v: unknown): v is CheckinsLevel {
  return v === 'everyone' || v === 'leaguemates' || v === 'friends' || v === 'hidden';
}

function isPlansLevel(v: unknown): v is PlansLevel {
  return v === 'leaguemates' || v === 'friends' || v === 'hidden';
}

function isoOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && !Number.isNaN(Date.parse(v)) ? v : null;
}

/** The RPC's jsonb as a full PresenceSettings: every field present, an unknown
 *  level read as its default (never as "everyone"). Tolerates a one-row array. */
export function normalizePresenceSettings(raw: unknown): PresenceSettings {
  const row = Array.isArray(raw) ? raw[0] : raw;
  const r = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>;
  return {
    checkins_level: isCheckinsLevel(r.checkins_level) ? r.checkins_level : DEFAULT_PRESENCE_SETTINGS.checkins_level,
    plans_level: isPlansLevel(r.plans_level) ? r.plans_level : DEFAULT_PRESENCE_SETTINGS.plans_level,
    paused_until: isoOrNull(r.paused_until),
    consent_seen_at: isoOrNull(r.consent_seen_at),
    auto_checkin: r.auto_checkin === true,
  };
}

export function checkinsLevelLabel(level: CheckinsLevel): string {
  return CHECKINS_LEVELS.find((o) => o.value === level)?.label ?? 'Friends and league-mates';
}

export function plansLevelLabel(level: PlansLevel): string {
  return PLANS_LEVELS.find((o) => o.value === level)?.label ?? 'Friends';
}

/** The consent sheet's first line: who will see your name at the court. */
export function consentAudienceLine(level: CheckinsLevel): string {
  switch (level) {
    case 'everyone':
      return 'Anyone signed in to Pickleague will see your name at the court.';
    case 'leaguemates':
      return 'Your friends and players in your closed leagues will see your name at the court.';
    case 'friends':
      return 'Only your friends will see your name at the court.';
    case 'hidden':
      return 'Nobody will see your name at the court.';
  }
}

/**
 * After a check-in: who can see you there now, true to the player's own
 * settings (a paused or hidden player is "a player" to everyone else).
 */
export function checkedInVisibilityLine(s: PresenceSettings, nowMs: number): string {
  const until = s.paused_until ? Date.parse(s.paused_until) : NaN;
  if (Number.isFinite(until) && until > nowMs) return 'Sharing is paused, so others see "a player" here.';
  switch (s.checkins_level) {
    case 'everyone':
      return 'Other players can see you are here.';
    case 'leaguemates':
      return 'Your friends and closed-league mates can see you are here.';
    case 'friends':
      return 'Your friends can see you are here.';
    case 'hidden':
      return 'Your name is hidden, so others see "a player" here.';
  }
}

/** The consent sheet's second line: what everyone else sees. */
export function consentOthersLine(level: CheckinsLevel): string {
  return level === 'hidden'
    ? 'You still count as "a player" in how many are playing. Blocked players never see your name.'
    : OTHERS_NOTE;
}

// ── Pause ───────────────────────────────────────────────────────────────────

export type PauseChoice = 'hour' | 'today' | 'day';

/** The "Pause sharing" choices on the checked-in court card, in order. */
export const PAUSE_CHOICES: { value: PauseChoice; label: string }[] = [
  { value: 'hour', label: 'For 1 hour' },
  { value: 'today', label: 'For the rest of today' },
  { value: 'day', label: 'For 24 hours' },
];

const HOUR_MS = 60 * 60_000;

/** When a pause chosen at `now` ends. "Today" ends at the next local midnight
 *  (the device's zone: the day the player is living in). */
export function pauseUntil(choice: PauseChoice, now: Date): Date {
  switch (choice) {
    case 'hour':
      return new Date(now.getTime() + HOUR_MS);
    case 'day':
      return new Date(now.getTime() + 24 * HOUR_MS);
    case 'today':
      return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  }
}

export function isPaused(pausedUntil: string | null | undefined, now: number): boolean {
  if (!pausedUntil) return false;
  const t = Date.parse(pausedUntil);
  return !Number.isNaN(t) && t > now;
}

/** "til 7:30 PM", "til midnight", "til tomorrow 6 PM", "til Thu 6 PM". */
export function pausedUntilLabel(pausedUntil: string, now: number): string {
  const until = new Date(pausedUntil);
  const today = new Date(now);
  const diff = calendarDayDiff(until, today);
  if (diff === 0) return `til ${shortTime(until)}`;
  if (diff === 1 && until.getHours() === 0 && until.getMinutes() === 0) return 'til midnight';
  if (diff === 1) return `til tomorrow ${shortTime(until)}`;
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][until.getDay()];
  return `til ${day} ${shortTime(until)}`;
}
