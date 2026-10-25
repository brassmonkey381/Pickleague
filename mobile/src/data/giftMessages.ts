import { supabase } from '../lib/supabase';
import { giftNoteIds, mergeGiftNotes, type GiftNote } from '../lib/giftMessages';

/**
 * Fill in the notes of gifted purchases from player_shop_gift_messages (the
 * sender and the recipient read a note; anyone else gets none, and the row
 * shows "A gift"). Best-effort: a failed read, or a database without the table
 * yet, leaves the rows as they came.
 */
export async function withGiftNotes<T extends { id: string; gifted_by_user_id: string | null; gift_message: string | null }>(
  rows: T[],
): Promise<T[]> {
  const ids = giftNoteIds(rows);
  if (ids.length === 0) return rows;
  try {
    const { data, error } = await supabase
      .from('player_shop_gift_messages')
      .select('purchase_id, message')
      .in('purchase_id', ids);
    if (error) return rows;
    return mergeGiftNotes(rows, (data ?? []) as GiftNote[]);
  } catch {
    return rows;
  }
}
