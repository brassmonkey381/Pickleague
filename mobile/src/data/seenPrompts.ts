// Per-account "seen" flags for one-time guides (`user_seen_prompts`,
// supabase/migration_seen_prompts.sql), so a guide auto-shows once per ACCOUNT
// (across devices and reinstalls), not per device. Ported from Doggle's
// data/seenPrompts.ts. First user: the Instagram Story link guide before the
// first finish-card share (PKL-013).
//
// A guide must never block or crash the share it decorates, so every call here
// is best-effort: DB failures fall back to an AsyncStorage mirror (which also
// serves offline sessions and the time before the table is live) rather than
// throwing.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';
import { track } from '../lib/analytics';

const MIRROR_KEY = 'pickleague_seen_prompts_mirror_v1';

/** The Story link sticker guide shown before the first finish-card share. */
export const SHARE_LINK_GUIDE_KEY = 'share_link_sticker_guide';

async function loadMirror(): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(MIRROR_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

async function saveMirror(keys: Set<string>): Promise<void> {
  try {
    await AsyncStorage.setItem(MIRROR_KEY, JSON.stringify([...keys]));
  } catch {
    // best-effort: the DB copy is the source of truth
  }
}

/** Every prompt key the signed-in account has seen. Falls back to the local
 *  mirror when signed out or the read fails. */
export async function loadSeenPromptKeys(): Promise<Set<string>> {
  try {
    const id = await currentUserId(supabase);
    if (!id) return loadMirror();
    // best-effort read: a guide must not throw, so not an sbCall site
    const { data, error } = await supabase.from('user_seen_prompts').select('key').eq('user_id', id);
    if (error || !data) return loadMirror();
    const keys = new Set((data as { key: string }[]).map((r) => r.key));
    // Keep what this device already knows (a mark that never reached the DB).
    for (const k of await loadMirror()) keys.add(k);
    await saveMirror(keys);
    return keys;
  } catch {
    return loadMirror();
  }
}

export async function markPromptSeen(key: string): Promise<void> {
  const mirror = await loadMirror();
  mirror.add(key);
  await saveMirror(mirror);
  try {
    const id = await currentUserId(supabase);
    if (!id) return;
    // best-effort write: a failed insert means the guide may show once more on
    // another device; the mirror already suppresses it here
    await supabase
      .from('user_seen_prompts')
      .upsert({ user_id: id, key }, { onConflict: 'user_id,key', ignoreDuplicates: true });
  } catch {
    // best-effort (see above)
  }
}

/** Forget every seen flag for this account so each guide shows once more. */
export async function resetSeenPrompts(): Promise<void> {
  await saveMirror(new Set());
  try {
    const id = await currentUserId(supabase);
    if (!id) return;
    await supabase.from('user_seen_prompts').delete().eq('user_id', id);
  } catch {
    // best-effort (see above)
  }
}

/** True when this account hasn't seen the guide yet (also on any error). */
export async function shouldShowGuide(key: string): Promise<boolean> {
  try {
    const show = !(await loadSeenPromptKeys()).has(key);
    if (show) track('prompt.shown', { key });
    return show;
  } catch {
    return true;
  }
}

/** Record the answer and never show the guide again. Best-effort, never throws. */
export async function markGuideSeen(key: string, answer: 'accepted' | 'dismissed'): Promise<void> {
  track('prompt.answered', { key, answer });
  try {
    await markPromptSeen(key);
  } catch {
    // best-effort (see above)
  }
}
