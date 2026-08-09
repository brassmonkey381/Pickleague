import { sbCall, currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from './supabase';
import { saveBookmarkAdd, saveBookmarkRemove } from './offlineWrites';

// Identity here comes from currentUserId (a LOCAL session read). getUser() is a
// network round trip, so on flaky WiFi every function below decided the user was
// signed out and quietly reported "no bookmarks" / "not bookmarked".

export type BookmarkTargetType =
  | 'tournament'
  | 'league'
  | 'event'
  | 'drill_session'
  | 'profile';

export type Bookmark = {
  user_id: string;
  target_type: BookmarkTargetType;
  target_id: string;
  created_at: string;
};

/** True only when the row is definitely stored — callers revert their optimistic toggle on false. */
export async function addBookmark(targetType: BookmarkTargetType, targetId: string): Promise<boolean> {
  const userId = await currentUserId(supabase);
  if (!userId) return false;
  try {
    // Queued on a transport failure (see ./offlineWrites): a bookmark is
    // user-scoped and idempotent, so applying it late is indistinguishable from
    // applying it now. The optimistic toggle stands either way.
    await saveBookmarkAdd({ userId, targetType, targetId });
    return true;
  } catch (e: any) {
    // 23505 = unique violation (already bookmarked) — the desired end state.
    return e?.code === '23505';
  }
}

/** True only when the row is definitely gone. */
export async function removeBookmark(targetType: BookmarkTargetType, targetId: string): Promise<boolean> {
  const userId = await currentUserId(supabase);
  if (!userId) return false;
  try {
    await saveBookmarkRemove({ userId, targetType, targetId });
    return true;
  } catch {
    return false;
  }
}

/**
 * Throws when the state can't be read. A bookmarked item rendering as
 * un-bookmarked invites the user to "re-add" it, so callers must show an
 * indeterminate icon rather than guess false.
 */
export async function isBookmarked(targetType: BookmarkTargetType, targetId: string): Promise<boolean> {
  const userId = await currentUserId(supabase);
  if (!userId) return false;
  const data = await sbCall(() =>
    supabase
      .from('bookmarks')
      .select('user_id')
      .eq('user_id', userId)
      .eq('target_type', targetType)
      .eq('target_id', targetId)
      .maybeSingle(),
  );
  return !!data;
}

/**
 * Throws when the list can't be read — "the fetch failed" must not render as
 * "you have no bookmarks", which is what swallowing the error produced.
 */
export async function listBookmarks(): Promise<Bookmark[]> {
  const userId = await currentUserId(supabase);
  if (!userId) return [];
  const data = await sbCall(() =>
    supabase
      .from('bookmarks')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false }),
  );
  return (data ?? []) as Bookmark[];
}
