// Godmode-only side of moderation: read the report queue and act on it.
// Every function here is refused by the database for anyone but the godmode
// account — the screen's own check is a courtesy, not the boundary.
import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';
import type { ReportReason, ReportSubjectType } from '../lib/moderation';

export type ModerationReport = {
  id:              string;
  reporter_id:     string;
  subject_user_id: string;
  subject_type:    ReportSubjectType;
  subject_id:      string | null;
  reason:          ReportReason;
  details:         string | null;
  snapshot:        Record<string, unknown> | null;
  status:          'open' | 'actioned' | 'dismissed';
  created_at:      string;
  reviewed_at:     string | null;
  resolution:      string | null;
  reporter: { full_name: string; username: string | null } | null;
  subject:  { full_name: string; username: string | null; avatar_url: string | null; tagline: string | null } | null;
};

const SELECT =
  'id, reporter_id, subject_user_id, subject_type, subject_id, reason, details, snapshot, ' +
  'status, created_at, reviewed_at, resolution, ' +
  'reporter:profiles!content_reports_reporter_id_fkey(full_name, username), ' +
  'subject:profiles!content_reports_subject_user_id_fkey(full_name, username, avatar_url, tagline)';

export async function listReports(status: 'open' | 'all' = 'open'): Promise<ModerationReport[]> {
  let q = supabase.from('content_reports').select(SELECT).order('created_at', { ascending: false }).limit(200);
  if (status === 'open') q = q.eq('status', 'open');
  return ((await sbCall(() => q)) ?? []) as unknown as ModerationReport[];
}

/**
 * Clears the profile photo AND deletes the object behind it.
 *
 * Two steps on purpose: storage refuses DELETE on storage.objects from SQL, so
 * the object has to go through the Storage API here while the RPC clears
 * avatar_url and closes the reports. Storage first — if it fails we have not
 * yet told the queue the content is gone.
 */
export async function takeDownAvatar(targetUserId: string, note?: string): Promise<void> {
  await removeAvatarObjects(targetUserId);
  await sbCall(() => supabase.rpc('moderator_take_down_avatar', {
    p_target: targetUserId, p_note: note ?? null,
  }));
}

/**
 * Deletes every object under `avatars/<user id>/`. Permitted for the owner and
 * for the moderator (see migration_avatars_bucket.sql). A missing bucket or an
 * already-empty folder is not an error — the goal state is "no photo".
 */
export async function removeAvatarObjects(userId: string): Promise<void> {
  const { data: files } = await supabase.storage.from('avatars').list(userId);
  if (!files?.length) return;
  await supabase.storage.from('avatars').remove(files.map(f => `${userId}/${f.name}`));
}

/**
 * Deletes the account: credentials gone (they cannot sign back in), profile
 * left as an anonymous tombstone so other players' match history survives.
 * Same machinery as a user deleting themselves.
 */
export async function ejectUser(targetUserId: string, note?: string): Promise<void> {
  await sbCall(() => supabase.rpc('moderator_eject_user', {
    p_target: targetUserId, p_note: note ?? null,
  }));
}

export async function resolveReport(
  reportId: string, status: 'actioned' | 'dismissed', note?: string,
): Promise<void> {
  await sbCall(() => supabase.rpc('moderator_resolve_report', {
    p_report_id: reportId, p_status: status, p_note: note ?? null,
  }));
}

/** Open reports older than this have blown the 24-hour response window. */
export const RESPONSE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isOverdue(report: ModerationReport): boolean {
  return report.status === 'open' &&
    Date.now() - new Date(report.created_at).getTime() > RESPONSE_WINDOW_MS;
}
