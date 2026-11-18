// Tournament matches in Match History (PKL-035).
//
// Match History reads public.matches; a tournament match lives in
// public.tournament_matches. The server's get_tournament_match_history RPC
// (supabase/migration_tournament_match_plupr_history.sql) returns completed
// tournament matches already shaped like a match row (team 1 = player1 +
// partner1, team 2 = player2 + partner2). This turns one RPC row into the
// Match shape the screen renders, so filters, the W/L tile, the score, the
// PLUPR change and the PLUPR chart work unchanged.
//
// plupr_ratings holds every player's overall PLUPR around the match
// ({"<user id>": {before, after, ...}}), partners included, so the PLUPR
// change can be shown for whoever is viewing (a matches row only stores
// player 1 and player 2). It is null for matches completed before the
// migration, which then show no change, like a pending league match.
import type { Match, Profile, DoublesCategory } from '../types';

export type PluprMove = { before?: number | string | null; after?: number | string | null };

/** One get_tournament_match_history row. */
export type TournamentHistoryRow = {
  id: string;
  tournament_id: string;
  tournament_name: string | null;
  league_id: string | null;
  league_name: string | null;
  round_label: string | null;
  match_type: 'singles' | 'doubles';
  doubles_category: DoublesCategory | null;
  player1_id: string;
  partner1_id: string | null;
  player2_id: string;
  partner2_id: string | null;
  player1_score: number | null;
  player2_score: number | null;
  winner_team: 'team1' | 'team2' | null;
  played_at: string;
  game_scores: unknown;
  plupr_ratings: Record<string, PluprMove> | null;
  player1: Partial<Profile> | null;
  partner1: Partial<Profile> | null;
  player2: Partial<Profile> | null;
  partner2: Partial<Profile> | null;
};

/** A Match History row that came from a tournament. */
export type TournamentHistoryMatch = Match & {
  source: 'tournament';
  tournament_id: string;
  tournament: { id: string; name: string };
  league: { id: string; name: string } | null;
  round_label: string | null;
  plupr_ratings: Record<string, PluprMove> | null;
};

const num = (v: number | string | null | undefined): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** The overall PLUPR move for one player in a tournament row, or null. */
export function tournamentRatingChange(row: { plupr_ratings?: Record<string, PluprMove> | null }, uid: string): number | null {
  const m = row.plupr_ratings?.[uid];
  const before = num(m?.before);
  const after = num(m?.after);
  return before == null || after == null ? null : after - before;
}

export function fromTournamentHistoryRow(r: TournamentHistoryRow): TournamentHistoryMatch {
  const move = (id: string | null) => (id ? r.plupr_ratings?.[id] : undefined);
  const asProfile = (p: Partial<Profile> | null) => (p ? (p as Profile) : undefined);
  return {
    id: r.id,
    // A tournament outside a league has none; Match types it as a string.
    league_id: r.league_id ?? '',
    match_type: r.match_type,
    doubles_category: r.match_type === 'doubles' ? r.doubles_category : null,
    player1_id: r.player1_id,
    partner1_id: r.partner1_id,
    player2_id: r.player2_id,
    partner2_id: r.partner2_id,
    player1_score: r.player1_score,
    player2_score: r.player2_score,
    winner_id: null,
    winner_team: r.winner_team,
    status: 'completed',
    team1_confirmed_by: null,
    team2_confirmed_by: null,
    confirm_deadline: null,
    played_at: r.played_at,
    scheduled_at: null,
    player1_rating_before: num(move(r.player1_id)?.before),
    player1_rating_after: num(move(r.player1_id)?.after),
    player2_rating_before: num(move(r.player2_id)?.before),
    player2_rating_after: num(move(r.player2_id)?.after),
    location_name: null,
    location_lat: null,
    location_lng: null,
    is_outdoor: null,
    was_home_court: null,
    is_home_court: null,
    created_at: r.played_at,
    player1: asProfile(r.player1),
    partner1: asProfile(r.partner1),
    player2: asProfile(r.player2),
    partner2: asProfile(r.partner2),
    source: 'tournament',
    tournament_id: r.tournament_id,
    tournament: { id: r.tournament_id, name: r.tournament_name ?? 'Tournament' },
    league: r.league_id ? { id: r.league_id, name: r.league_name ?? '' } : null,
    round_label: r.round_label,
    plupr_ratings: r.plupr_ratings,
  };
}

/** League matches and tournament matches in one list, newest first. */
export function mergeHistory<T extends { played_at: string; id: string }>(a: T[], b: T[]): T[] {
  return [...a, ...b].sort((x, y) => y.played_at.localeCompare(x.played_at) || x.id.localeCompare(y.id));
}
