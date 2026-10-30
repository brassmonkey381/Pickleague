// Group sessions for league events and tournaments (supabase/
// migration_group_sessions.sql): every play session whose source is the same
// event or tournament is its group. Pure rules: when Join shows, the server's
// list parsed, and the lines the section and the island say.
import { formatDurationMinutes } from '@just-messin-around/expo-foundation/scheduling/timeWindows';

export type GroupKind = 'event' | 'tournament';

export type GroupPlayer = {
  userId: string;
  name: string;
  avatarUrl: string | null;
  avatarEmoji: string | null;
  avatarBg: string | null;
  startedAt: string;
  /** null: playing now. */
  endedAt: string | null;
  /** Seconds played in the group today (all their sessions in it). */
  playedS: number;
  isMe: boolean;
};

export type GroupSession = {
  canView: boolean;
  canJoin: boolean;
  /** The event's or tournament's name. */
  title: string | null;
  players: GroupPlayer[];
};

export const NO_GROUP: GroupSession = { canView: false, canJoin: false, title: null, players: [] };

/** How long a list read is reused (the section also refreshes on focus and every minute). */
export const GROUP_CACHE_TTL_MS = 60_000;
export const groupSessionKey = (kind: GroupKind, id: string) => `groupSession:${kind}:${id}`;

/** A tournament with no expected length is taken to run this long. */
export const DEFAULT_TOURNAMENT_HOURS = 4;
/** Join opens this long before the start and stays this long after the end. */
const MARGIN_MS = 2 * 3600_000;

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** list_group_session's answer; anything unreadable is "not in it". */
export function parseGroupSession(raw: unknown): GroupSession {
  if (!raw || typeof raw !== 'object') return NO_GROUP;
  const j = raw as Record<string, unknown>;
  const players = Array.isArray(j.players) ? j.players : [];
  return {
    canView: j.can_view === true,
    canJoin: j.can_join === true,
    title: str(j.title),
    players: players.flatMap((p): GroupPlayer[] => {
      if (!p || typeof p !== 'object') return [];
      const r = p as Record<string, unknown>;
      const userId = str(r.user_id);
      const startedAt = str(r.started_at);
      if (!userId || !startedAt) return [];
      return [
        {
          userId,
          name: str(r.full_name)?.trim() || 'A player',
          avatarUrl: str(r.avatar_url),
          avatarEmoji: str(r.avatar_emoji),
          avatarBg: str(r.avatar_bg_color),
          startedAt,
          endedAt: str(r.ended_at),
          playedS: Math.max(0, Number(r.played_s) || 0),
          isMe: r.is_me === true,
        },
      ];
    }),
  };
}

function sameLocalDay(aMs: number, bMs: number): boolean {
  const a = new Date(aMs);
  const b = new Date(bMs);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * Does Join show? On the day it starts (local time), or from 2 hours before
 * the start to 2 hours after the end (an evening that runs past midnight).
 * No start known: only while `live` (a tournament under way with no start
 * time). `endsAt` null: the start plus DEFAULT_TOURNAMENT_HOURS.
 */
export function groupJoinOpen(p: { startsAt: string | null; endsAt?: string | null; nowMs: number; live?: boolean }): boolean {
  const start = p.startsAt ? Date.parse(p.startsAt) : NaN;
  if (!Number.isFinite(start)) return !!p.live;
  const parsedEnd = p.endsAt ? Date.parse(p.endsAt) : NaN;
  const end = Number.isFinite(parsedEnd) && parsedEnd > start ? parsedEnd : start + DEFAULT_TOURNAMENT_HOURS * 3600_000;
  if (p.nowMs >= start - MARGIN_MS && p.nowMs <= end + MARGIN_MS) return true;
  return sameLocalDay(p.nowMs, start) && p.nowMs <= end + MARGIN_MS;
}

/** A tournament's end: its start plus its expected length (or the default). */
export function tournamentEndsAt(startTime: string | null, expectedHours: number | null): string | null {
  if (!startTime) return null;
  const start = Date.parse(startTime);
  if (!Number.isFinite(start)) return null;
  const h = expectedHours && expectedHours > 0 ? expectedHours : DEFAULT_TOURNAMENT_HOURS;
  return new Date(start + h * 3600_000).toISOString();
}

export function playingNow(players: GroupPlayer[]): GroupPlayer[] {
  return players.filter((p) => p.endedAt === null);
}

/** "3 playing now" / "1 playing now" / "No one playing right now". */
export function playingLine(players: GroupPlayer[]): string {
  const n = playingNow(players).length;
  return n === 0 ? 'No one playing right now' : `${n} playing now`;
}

/** Minutes, rounded down, for "Played 1 h 20 min". */
export function playedLabel(seconds: number): string {
  return formatDurationMinutes(Math.floor(Math.max(0, seconds) / 60));
}

/** A row's status: "Playing · since 6:10 PM" or "Played 1 h 20 min". */
export function playerStatus(p: GroupPlayer, clock: (iso: string) => string): string {
  return p.endedAt === null ? `Playing · since ${clock(p.startedAt)}` : `Played ${playedLabel(p.playedS)}`;
}

/** The island's line for a group session: "Ladder Night · 4 playing". */
export function islandGroupLine(title: string, playing: number): string {
  return playing > 1 ? `${title} · ${playing} playing` : title;
}

/** Me first, then the rest as the server ordered them (playing now first). */
export function meFirst(players: GroupPlayer[]): GroupPlayer[] {
  return [...players.filter((p) => p.isMe), ...players.filter((p) => !p.isMe)];
}
