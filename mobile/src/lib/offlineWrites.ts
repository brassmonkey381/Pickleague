// Which writes are allowed to survive a dead connection.
//
// The foundation's mutation queue is configured in ./supabase, but queueing is
// deliberately opt-in per write, not a blanket policy. A queued write applies at
// an unknown later time, so it is only safe where a delayed apply is
// indistinguishable from an immediate one AND the user's intent is unambiguous.
//
// Queued (here): bookmarks and user preferences. Both are user-scoped, both are
// idempotent server-side (a unique constraint / an upsert), and nothing else
// keys off them — a bookmark that lands two minutes late is simply a bookmark.
//
// NOT queued, on purpose: matches, pickles, wagers, tournament operations,
// invites. A match insert cascades through triggers into PLUPR, per-court
// ratings, pickle ledgers and notifications; replaying one an hour later would
// silently rewrite standings against a state the user can no longer see. Those
// fail loudly instead, which is the honest outcome.
import {
  enqueueMutation,
  registerMutationHandler,
  runOrQueue,
  startMutationQueueService,
} from '@just-messin-around/expo-foundation/cache';
import { isNetworkError } from '@just-messin-around/expo-foundation/platform';
import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from './supabase';

export const MUTATION_BOOKMARK_ADD = 'bookmark:add';
export const MUTATION_BOOKMARK_REMOVE = 'bookmark:remove';
export const MUTATION_PREFS_SAVE = 'prefs:save';

type BookmarkPayload = { userId: string; targetType: string; targetId: string };
type PrefsPayload = { userId: string; prefs: unknown };

/** 23505 = unique violation: the bookmark is already there, which is the goal. */
function isDuplicateRow(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === '23505';
}

async function execBookmarkAdd(p: BookmarkPayload): Promise<void> {
  await sbCall(() =>
    supabase
      .from('bookmarks')
      .insert({ user_id: p.userId, target_type: p.targetType, target_id: p.targetId }),
  );
}

async function execBookmarkRemove(p: BookmarkPayload): Promise<void> {
  await sbCall(() =>
    supabase
      .from('bookmarks')
      .delete()
      .eq('user_id', p.userId)
      .eq('target_type', p.targetType)
      .eq('target_id', p.targetId),
  );
}

async function execPrefsSave(p: PrefsPayload): Promise<void> {
  await sbCall(() =>
    supabase
      .from('user_preferences')
      .upsert({ user_id: p.userId, prefs: p.prefs, updated_at: new Date().toISOString() }),
  );
}

registerMutationHandler(MUTATION_BOOKMARK_ADD, {
  run: (payload) => execBookmarkAdd(payload as BookmarkPayload),
  isAlreadyApplied: isDuplicateRow,
});

registerMutationHandler(MUTATION_BOOKMARK_REMOVE, {
  run: (payload) => execBookmarkRemove(payload as BookmarkPayload),
});

registerMutationHandler(MUTATION_PREFS_SAVE, {
  run: (payload) => execPrefsSave(payload as PrefsPayload),
});

/**
 * Try the bookmark write live; on a TRANSPORT failure queue it instead.
 * `queued: true` still means "the user's intent is recorded" — callers keep
 * their optimistic toggle, and OfflineBanner shows the pending count.
 */
export async function saveBookmarkAdd(p: BookmarkPayload): Promise<{ queued: boolean }> {
  const { queued } = await runOrQueue(MUTATION_BOOKMARK_ADD, p, () => execBookmarkAdd(p));
  return { queued };
}

export async function saveBookmarkRemove(p: BookmarkPayload): Promise<{ queued: boolean }> {
  const { queued } = await runOrQueue(MUTATION_BOOKMARK_REMOVE, p, () => execBookmarkRemove(p));
  return { queued };
}

/**
 * Preferences are last-write-wins, so repeated offline toggles must collapse to
 * the latest payload rather than replaying a sequence of stale blobs — hence
 * `enqueueMutation` with a per-user dedupeKey instead of plain runOrQueue.
 */
export async function savePrefs(p: PrefsPayload): Promise<{ queued: boolean }> {
  try {
    await execPrefsSave(p);
    return { queued: false };
  } catch (e) {
    if (!isNetworkError(e)) throw e;
    await enqueueMutation(MUTATION_PREFS_SAVE, p, { dedupeKey: p.userId });
    return { queued: true };
  }
}

/**
 * Start the background flusher. Called from AppNavigator at boot — importing
 * this module is what registers the handlers above, and handlers must exist
 * before the first flush or queued entries are retained unapplied.
 */
export function startOfflineWrites(): () => void {
  return startMutationQueueService();
}
