// MatchEntry "Here now" (PKL-011; docs/play-sessions-presence.md Phase 2): the
// players checked in at the match's court (court_presence, named rows only)
// who can be picked. Tapping one fills the next empty player slot; the
// player picker lists them first.

export type MatchSlot = 'p1' | 'partner1' | 'p2' | 'partner2';

type Member = { id: string; full_name?: string | null };

/** Pickable players checked in here and not picked yet, by name. */
export function hereChoices(
  members: readonly Member[],
  hereIds: ReadonlySet<string>,
  picked: readonly string[],
): { id: string; name: string }[] {
  return members
    .filter((m) => hereIds.has(m.id) && !picked.includes(m.id))
    .map((m) => ({ id: m.id, name: m.full_name || 'Player' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The first empty slot, team 1 first (singles: no partners); null when all are full. */
export function nextEmptySlot(
  matchType: 'singles' | 'doubles',
  slots: Record<MatchSlot, string>,
): MatchSlot | null {
  const order: MatchSlot[] = matchType === 'singles' ? ['p1', 'p2'] : ['p1', 'partner1', 'p2', 'partner2'];
  return order.find((s) => !slots[s]) ?? null;
}

/** Picker rows with the players here first, marked " · here". */
export function hereFirst<T extends { id: string; name: string }>(items: readonly T[], hereIds: ReadonlySet<string>): T[] {
  if (hereIds.size === 0) return [...items];
  const here = items.filter((i) => hereIds.has(i.id)).map((i) => ({ ...i, name: `${i.name} · here` }));
  return [...here, ...items.filter((i) => !hereIds.has(i.id))];
}
