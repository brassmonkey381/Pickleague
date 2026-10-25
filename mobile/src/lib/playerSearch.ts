// Player search by name (the user, 2026-10-24): typing a NAME finds anyone,
// with the players near the search area listed first; with no name typed the
// list stays the nearby list. The pure half (data/playerSearch has the read).
//
// The server answers with search_players (supabase/migration_search_players.sql):
// everyone whose name or @username contains the query, blocks both ways and
// test accounts left out; a place ONLY for the players discover_players_near
// places in the area (their leagues' home courts), and those first. Everyone
// else comes back unplaced (distance_m null), so the split below is by that.
//
// PURE: no React, no Supabase.
import type { NearPlayer } from './playersNear';

/** Letters a name search needs (the server refuses fewer). */
export const MIN_SEARCH_CHARS = 2;

/** How long typing must pause before a name search goes out. */
export const SEARCH_DEBOUNCE_MS = 300;

/**
 * The query to send, or null while it is too short to search everyone: a
 * leading @ is ignored and spaces trimmed (the server's own rule).
 */
export function searchableQuery(raw: string | null | undefined): string | null {
  const q = (raw ?? '').trim().replace(/^@/, '').trim();
  return q.length >= MIN_SEARCH_CHARS ? q.slice(0, 80) : null;
}

export type SearchSection<P> = { key: 'near' | 'everywhere'; title: string | null; rows: P[] };

/**
 * The results in two groups: "Near <area>" (the placed rows, in the server's
 * order: nearest first) then "Everywhere else". Empty groups are dropped.
 * With no area there is one group and no heading (nobody can be near).
 */
export function groupSearchResults<P extends Pick<NearPlayer, 'distance_m'>>(
  rows: readonly P[],
  areaLabel: string | null,
  hasArea: boolean,
): SearchSection<P>[] {
  if (!hasArea) return rows.length ? [{ key: 'everywhere', title: null, rows: [...rows] }] : [];
  const near = rows.filter((r) => r.distance_m != null);
  const rest = rows.filter((r) => r.distance_m == null);
  const out: SearchSection<P>[] = [];
  const where = areaLabel?.trim() || 'your area';
  if (near.length) out.push({ key: 'near', title: `Near ${where}`, rows: near });
  if (rest.length) {
    out.push({ key: 'everywhere', title: near.length ? 'Everywhere else' : `Everywhere else (no one near ${where})`, rows: rest });
  }
  return out;
}

/** The search's empty state: what was looked for and what to try. */
export function searchEmptyCopy(query: string): { title: string; subtitle: string } {
  return {
    title: `No players match "${query}"`,
    subtitle: 'Check the spelling, or try part of a name or their @username.',
  };
}

/** The hint under a one-letter query (the nearby list is filtered meanwhile). */
export const SHORT_QUERY_HINT = `Type ${MIN_SEARCH_CHARS} or more letters to search every player.`;
