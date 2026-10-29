// Pure rules for the season / tournament finish share card (PKL-013,
// components/share/FinishShareStudio.tsx). React-free, so vitest covers them.
//
// Privacy (share-kit scope, corrections 7): the card goes to Instagram, so
// other players appear as "First L." with initials (never their photos), and
// a player you blocked or a deleted account reads "a player".

export type FinishKind = 'season' | 'tournament';

/** A player as the screen knows them; `deleted` = profiles.deleted_at is set. */
export type FinishPlayerIn = { id: string; fullName: string | null | undefined; deleted?: boolean };

export type FinishPlayer = { name: string; initials: string };

export type FinishPodiumPlace = { rank: number; players: FinishPlayer[] };

export type FinishShareData = {
  kind: FinishKind;
  /** The tournament's name, or the season's ("Fall 2026"). */
  title: string;
  /** The league's name on a season card; null on a tournament card. */
  league: string | null;
  rank: number;
  /** How many finished (null: unknown). */
  of: number | null;
  wins: number | null;
  losses: number | null;
  /** My own name, already "First L.". */
  me: string;
  podium: FinishPodiumPlace[];
};

export const ANONYMOUS_PLAYER = 'a player';

/** "Taylor Jordan Smith" -> "Taylor S."; one word stays as is; blank -> "a player". */
export function shortName(full: string | null | undefined): string {
  const parts = (full ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return ANONYMOUS_PLAYER;
  if (parts.length === 1) return parts[0];
  const last = parts[parts.length - 1];
  return `${parts[0]} ${last.charAt(0).toUpperCase()}.`;
}

/** "Taylor Smith" -> "TS"; one word -> its first letter; blank -> "?". */
export function initialsOf(full: string | null | undefined): string {
  const parts = (full ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0].charAt(0);
  const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : '';
  return (first + last).toUpperCase();
}

/** How a player shows on the card: masked when blocked or deleted. */
export function cardPlayer(p: FinishPlayerIn, blocked: ReadonlySet<string>): FinishPlayer {
  if (p.deleted || blocked.has(p.id) || !(p.fullName ?? '').trim()) return { name: ANONYMOUS_PLAYER, initials: '?' };
  return { name: shortName(p.fullName), initials: initialsOf(p.fullName) };
}

/** 1 -> "1st", 2 -> "2nd", 11 -> "11th", 23 -> "23rd". */
export function ordinal(n: number): string {
  const v = n % 100;
  const suffix = v >= 11 && v <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}

/** The medal for a podium place, else null. */
export function medalFor(rank: number): 'gold' | 'silver' | 'bronze' | null {
  return rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : null;
}

/** The card's big line: "Champion", "2nd place", "5th of 12". */
export function placeHeadline(rank: number, of: number | null): string {
  if (rank === 1) return 'Champion';
  if (rank <= 3) return `${ordinal(rank)} place`;
  return of != null && of >= rank ? `${ordinal(rank)} of ${of}` : `${ordinal(rank)} place`;
}

/** "7-3" when both counts are known, else null. */
export function recordLabel(wins: number | null | undefined, losses: number | null | undefined): string | null {
  if (wins == null || losses == null || wins < 0 || losses < 0) return null;
  return `${wins}-${losses}`;
}

/** Podium places 1-3 as the card shows them (ties share a place). */
export function cardPodium(
  places: readonly { rank: number; players: readonly FinishPlayerIn[] }[],
  blocked: ReadonlySet<string>,
): FinishPodiumPlace[] {
  return places
    .filter((p) => p.rank >= 1 && p.rank <= 3 && p.players.length > 0)
    .sort((a, b) => a.rank - b.rank)
    .map((p) => ({ rank: p.rank, players: p.players.map((x) => cardPlayer(x, blocked)) }));
}

/** The share text; the link goes last so it unfurls. */
export function finishShareMessage(d: Pick<FinishShareData, 'kind' | 'title' | 'league' | 'rank' | 'of'>, link: string): string {
  const where = d.kind === 'season' && d.league ? `${d.league} (${d.title})` : d.title;
  const what = d.rank === 1 ? `I won ${where}` : `I finished ${placeHeadline(d.rank, d.of).replace(' place', '')} in ${where}`;
  return `${what} on Pickleague 🥒 ${link}`;
}
