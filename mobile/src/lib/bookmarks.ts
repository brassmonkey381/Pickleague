import { supabase } from './supabase';

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

export async function addBookmark(targetType: BookmarkTargetType, targetId: string): Promise<boolean> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  const { error } = await supabase
    .from('bookmarks')
    .insert({ user_id: user.id, target_type: targetType, target_id: targetId });
  // 23505 = unique violation (already bookmarked) — treat as success.
  if (error && error.code !== '23505') return false;
  return true;
}

export async function removeBookmark(targetType: BookmarkTargetType, targetId: string): Promise<boolean> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  const { error } = await supabase
    .from('bookmarks')
    .delete()
    .eq('user_id', user.id)
    .eq('target_type', targetType)
    .eq('target_id', targetId);
  return !error;
}

export async function isBookmarked(targetType: BookmarkTargetType, targetId: string): Promise<boolean> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  const { data } = await supabase
    .from('bookmarks')
    .select('user_id')
    .eq('user_id', user.id)
    .eq('target_type', targetType)
    .eq('target_id', targetId)
    .maybeSingle();
  return !!data;
}

export async function listBookmarks(): Promise<Bookmark[]> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];
  const { data } = await supabase
    .from('bookmarks')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });
  return (data ?? []) as Bookmark[];
}
