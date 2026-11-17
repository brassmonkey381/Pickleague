// The pot's Contribute dialog (PKL-031): quick amounts and the "Pot after"
// line. A contribution adds exactly its amount to the pot (no house bonus
// since migration_pickle_economy_guards.sql). PURE, so vitest reads it.

export type AmountChip = { label: string; value: number };

const QUICK = [50, 100, 250];

/** 50 / 100 / 250 that fit the balance, then Max (the whole balance). Unknown balance: the three. */
export function contributeAmounts(balance?: number | null): AmountChip[] {
  if (balance == null) return QUICK.map((v) => ({ label: String(v), value: v }));
  if (balance <= 0) return [];
  const fit = QUICK.filter((v) => v < balance).map((v) => ({ label: String(v), value: v }));
  return [...fit, { label: 'Max', value: balance }];
}

/** "Pot after: 3,600. You keep 1,140." */
export function potAfterLine(pool: number, amount: number, balance?: number | null): string {
  const after = `Pot after: ${(pool + amount).toLocaleString('en-US')}.`;
  return balance == null ? after : `${after} You keep ${Math.max(0, balance - amount).toLocaleString('en-US')}.`;
}
