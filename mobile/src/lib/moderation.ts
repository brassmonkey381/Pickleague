// Reporting and blocking — the client half of migration_moderation_report_block.sql.
//
// The block itself is enforced in the database (RLS on drill_requests and
// drill_request_messages), so nothing here is load-bearing for safety. What
// this module does is keep the UI honest: a blocked player should not keep
// showing up in search results and rosters after you blocked them.
//
// The blocked set lives in the shared query cache under BLOCKS_KEY, so every
// mounted screen re-renders the moment a block is added or removed.
import { useMemo } from 'react';
import { sbCall, currentUserId } from '@just-messin-around/expo-foundation/supabase';
import {
  cachedFetch, invalidateQueries, peekQuery, useCachedQuery,
} from '@just-messin-around/expo-foundation/cache';
import { supabase } from './supabase';

export const BLOCKS_KEY = 'me:blocks';

/** Blocks change rarely, but a stale one is visible, so keep the window short. */
const BLOCKS_TTL_MS     = 60_000;
const BLOCKS_PERSIST_MS = 7 * 24 * 60 * 60 * 1000;

export type ReportSubjectType =
  | 'profile' | 'avatar' | 'message' | 'league' | 'event' | 'tournament' | 'other';

export type ReportReason =
  | 'harassment' | 'hate' | 'sexual' | 'violence' | 'spam'
  | 'impersonation' | 'cheating' | 'other';

// Order matters: this is the order they appear in the report sheet, most
// serious first. Labels are what the reporter reads, so they say what the
// behaviour looks like rather than naming a policy.
export const REPORT_REASONS: { key: ReportReason; label: string; hint: string }[] = [
  { key: 'harassment',    label: 'Harassment or bullying',   hint: 'Threats, abuse, or repeated unwanted contact' },
  { key: 'hate',          label: 'Hate speech',              hint: 'Attacks based on who someone is' },
  { key: 'sexual',        label: 'Sexual or explicit',       hint: 'Sexual content or unwanted advances' },
  { key: 'violence',      label: 'Violence or threats',      hint: 'Threatening to hurt someone' },
  { key: 'impersonation', label: 'Impersonation',            hint: 'Pretending to be someone else' },
  { key: 'spam',          label: 'Spam or scam',             hint: 'Advertising, links, or fraud' },
  { key: 'cheating',      label: 'Cheating or fake results', hint: 'Made-up scores or manipulated ratings' },
  { key: 'other',         label: 'Something else',           hint: 'Tell us what happened' },
];

export type BlockedPlayer = {
  user_id:    string;
  full_name:  string;
  username:   string | null;
  avatar_url: string | null;
  created_at: string;
};

type BlockRow = {
  blocked_id: string;
  created_at: string;
  blocked: { full_name: string; username: string | null; avatar_url: string | null } | null;
};

async function fetchBlocks(): Promise<BlockedPlayer[]> {
  const uid = await currentUserId(supabase);   // local session read, no round trip
  if (!uid) return [];
  const rows = await sbCall(() => supabase
    .from('user_blocks')
    .select('blocked_id, created_at, blocked:profiles!user_blocks_blocked_id_fkey(full_name, username, avatar_url)')
    .eq('blocker_id', uid)
    .order('created_at', { ascending: false })) as BlockRow[] | null;

  return (rows ?? []).map(r => ({
    user_id:    r.blocked_id,
    full_name:  r.blocked?.full_name ?? 'Blocked player',
    username:   r.blocked?.username ?? null,
    avatar_url: r.blocked?.avatar_url ?? null,
    created_at: r.created_at,
  }));
}

/**
 * Cached list of everyone the signed-in user has blocked.
 * `force` is for pull-to-refresh, which must not be answered from a cache the
 * user just pulled specifically to bypass.
 */
export function loadBlockedPlayers(force = false): Promise<BlockedPlayer[]> {
  return cachedFetch(BLOCKS_KEY, fetchBlocks, {
    ttlMs: force ? 0 : BLOCKS_TTL_MS,
    persistMs: BLOCKS_PERSIST_MS,
  });
}

/**
 * Blocked ids, without waiting on the network when the cache is warm.
 * Screens that only need to filter a list should call this — it returns an
 * empty set rather than throwing if nothing has been loaded yet, and the
 * filtering corrects itself on the next render once the fetch lands.
 */
export function peekBlockedIds(): Set<string> {
  const cached = peekQuery<BlockedPlayer[]>(BLOCKS_KEY);
  return new Set((cached ?? []).map(b => b.user_id));
}

export async function loadBlockedIds(): Promise<Set<string>> {
  return new Set((await loadBlockedPlayers()).map(b => b.user_id));
}

/**
 * Reactive blocked set for lists and menus. Because it reads the same cache
 * key, blocking someone on one screen updates every other mounted screen —
 * no manual refetch wiring.
 */
export function useBlockedIds(): Set<string> {
  const { data } = useCachedQuery<BlockedPlayer[]>(BLOCKS_KEY, fetchBlocks, {
    ttlMs: BLOCKS_TTL_MS,
    persistMs: BLOCKS_PERSIST_MS,
  });
  return useMemo(() => new Set((data ?? []).map(b => b.user_id)), [data]);
}

export async function blockUser(userId: string): Promise<void> {
  const uid = await currentUserId(supabase);
  if (!uid) throw new Error('You need to be signed in to block someone.');
  await sbCall(() => supabase
    .from('user_blocks')
    // Idempotent: blocking twice (a double tap, an offline retry) is not an error.
    .upsert({ blocker_id: uid, blocked_id: userId }, { onConflict: 'blocker_id,blocked_id' }));
  invalidateQueries(BLOCKS_KEY);
}

export async function unblockUser(userId: string): Promise<void> {
  const uid = await currentUserId(supabase);
  if (!uid) throw new Error('You need to be signed in.');
  await sbCall(() => supabase
    .from('user_blocks')
    .delete()
    .eq('blocker_id', uid)
    .eq('blocked_id', userId));
  invalidateQueries(BLOCKS_KEY);
}

export async function isBlocked(userId: string): Promise<boolean> {
  return (await loadBlockedIds()).has(userId);
}

export type ReportInput = {
  subjectUserId: string;
  subjectType:   ReportSubjectType;
  /** Row the content lives in — a drill request, a league — when there is one. */
  subjectId?:    string | null;
  reason:        ReportReason;
  details?:      string | null;
  /**
   * What the reporter was looking at (a name, a message body, a photo URL).
   * Captured here because the author can edit or delete it the moment they are
   * reported, and an empty report cannot be acted on.
   */
  snapshot?:     Record<string, unknown> | null;
};

export async function submitReport(input: ReportInput): Promise<void> {
  const uid = await currentUserId(supabase);
  if (!uid) throw new Error('You need to be signed in to report someone.');
  if (uid === input.subjectUserId) throw new Error("You can't report yourself.");

  const { error } = await supabase.from('content_reports').insert({
    reporter_id:     uid,
    subject_user_id: input.subjectUserId,
    subject_type:    input.subjectType,
    subject_id:      input.subjectId ?? null,
    reason:          input.reason,
    details:         input.details?.trim() || null,
    snapshot:        input.snapshot ?? null,
  });

  // 23505 = the one-open-report-per-subject index. That is not a failure from
  // the reporter's point of view: their report is already in the queue.
  if (error && error.code !== '23505') throw error;
}

/** Support address published in the app, the listing, and the privacy policy. */
export const SUPPORT_EMAIL = 'support@pickleague.club';
