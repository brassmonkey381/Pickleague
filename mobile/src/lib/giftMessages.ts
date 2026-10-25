// Gift notes on shop purchases.
//
// Since migration_anon_audit_rest.sql a gift's note lives in
// player_shop_gift_messages, readable by its sender and recipient only, and
// player_shop_purchases.gift_message is always null (the column stays so older
// builds that select it keep working). This merges the notes back onto the
// purchase rows the screens already render.

export type GiftNote = { purchase_id: string; message: string };

type GiftRow = { id: string; gifted_by_user_id: string | null; gift_message: string | null };

/** The purchase ids worth asking about: gifts that carry no note yet. */
export function giftNoteIds(rows: readonly GiftRow[]): string[] {
  return rows.filter((r) => r.gifted_by_user_id != null && !r.gift_message).map((r) => r.id);
}

/** Each row with its note filled in where one was found; others unchanged. */
export function mergeGiftNotes<T extends GiftRow>(rows: T[], notes: readonly GiftNote[] | null | undefined): T[] {
  if (!notes || notes.length === 0) return rows;
  const byId = new Map(notes.map((n) => [n.purchase_id, n.message]));
  return rows.map((r) => {
    const note = byId.get(r.id);
    return note && !r.gift_message ? { ...r, gift_message: note } : r;
  });
}
