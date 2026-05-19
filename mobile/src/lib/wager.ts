import { supabase } from './supabase';

/**
 * Wagering — typed subjects + thin RPC wrappers.
 *
 * v1 subjects:
 *   - match / tournament_match  → winner team
 *   - match_score / tournament_match_score → exact final score
 *   - tournament_rank → finishing rank in a tournament (rank=1 in v1)
 *   - period_rank → rank in a specific season period (rank=1 in v1)
 *   - season_rank → rank at season completion
 *
 * The screen-side code builds a `WagerSubject` and hands it to the modal
 * (or to placeWager() directly). This module translates that into the
 * (subject_type, subject_id, predicate) tuple the RPCs expect — keeping
 * the DB contract a single source of truth.
 */
export type WagerSubject =
  | { type: 'match';                  matchId: string;            teamLabels: { team1: string; team2: string }; pickedTeam: 'team1' | 'team2' }
  | { type: 'tournament_match';       tournamentMatchId: string;  teamLabels: { team1: string; team2: string }; pickedTeam: 'team1' | 'team2' }
  | { type: 'match_score';            matchId: string;            team1Score: number; team2Score: number; teamLabels: { team1: string; team2: string } }
  | { type: 'tournament_match_score'; tournamentMatchId: string;  team1Score: number; team2Score: number; teamLabels: { team1: string; team2: string } }
  | { type: 'tournament_rank';        tournamentId: string;       tournamentName: string; userId: string; userName: string; rank: number }
  | { type: 'period_rank';            seasonId: string;           periodNumber: number; userId: string; userName: string; rank: number }
  | { type: 'season_rank';            seasonId: string;           userId: string; userName: string; rank: number };

export type WagerStatus = 'open' | 'won' | 'lost' | 'cancelled';
export type WagerSubjectType = WagerSubject['type'];

export type SubjectTuple = {
  subject_type: WagerSubjectType;
  subject_id: string;
  predicate: Record<string, any>;
};

/** Translate a typed subject into the RPC tuple. */
export function toSubjectTuple(s: WagerSubject): SubjectTuple {
  switch (s.type) {
    case 'match':
      return { subject_type: 'match', subject_id: s.matchId, predicate: { winner_team: s.pickedTeam } };
    case 'tournament_match':
      return { subject_type: 'tournament_match', subject_id: s.tournamentMatchId, predicate: { winner_team: s.pickedTeam } };
    case 'match_score':
      return { subject_type: 'match_score', subject_id: s.matchId, predicate: { team1_score: s.team1Score, team2_score: s.team2Score } };
    case 'tournament_match_score':
      return { subject_type: 'tournament_match_score', subject_id: s.tournamentMatchId, predicate: { team1_score: s.team1Score, team2_score: s.team2Score } };
    case 'tournament_rank':
      return { subject_type: 'tournament_rank', subject_id: s.tournamentId, predicate: { user_id: s.userId, rank: s.rank } };
    case 'period_rank':
      return { subject_type: 'period_rank', subject_id: s.seasonId, predicate: { period_number: s.periodNumber, user_id: s.userId, rank: s.rank } };
    case 'season_rank':
      return { subject_type: 'season_rank', subject_id: s.seasonId, predicate: { user_id: s.userId, rank: s.rank } };
  }
}

/** Human-readable summary used in modals + history rows. */
export function subjectLabel(s: WagerSubject): string {
  switch (s.type) {
    case 'match':
      return `${s.teamLabels[s.pickedTeam]} to win vs ${s.teamLabels[s.pickedTeam === 'team1' ? 'team2' : 'team1']}`;
    case 'tournament_match':
      return `${s.teamLabels[s.pickedTeam]} to win vs ${s.teamLabels[s.pickedTeam === 'team1' ? 'team2' : 'team1']} (tournament)`;
    case 'match_score':
      return `Final score ${s.team1Score}–${s.team2Score} (${s.teamLabels.team1} vs ${s.teamLabels.team2})`;
    case 'tournament_match_score':
      return `Final score ${s.team1Score}–${s.team2Score} (${s.teamLabels.team1} vs ${s.teamLabels.team2}, tournament)`;
    case 'tournament_rank':
      return `${s.userName} to finish ${ordinal(s.rank)} in ${s.tournamentName}`;
    case 'period_rank':
      return `${s.userName} to finish ${ordinal(s.rank)} in Period ${s.periodNumber}`;
    case 'season_rank':
      return `${s.userName} to finish ${ordinal(s.rank)} for the season`;
  }
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/**
 * Best-effort label for a stored wager row (when only subject_type +
 * predicate are known). Falls back to a generic phrasing — full detail
 * requires supplemental lookups the caller is free to do.
 */
export function genericSubjectLabel(
  subject_type: WagerSubjectType,
  predicate: Record<string, any>,
): string {
  switch (subject_type) {
    case 'match':            return `Match · ${predicate?.winner_team ?? '?'} to win`;
    case 'tournament_match': return `Tournament match · ${predicate?.winner_team ?? '?'} to win`;
    case 'match_score':      return `Match final score · ${predicate?.team1_score}-${predicate?.team2_score}`;
    case 'tournament_match_score': return `Tournament match final score · ${predicate?.team1_score}-${predicate?.team2_score}`;
    case 'tournament_rank':  return `Tournament rank · ${ordinal(predicate?.rank ?? 1)}`;
    case 'period_rank':      return `Period ${predicate?.period_number ?? '?'} rank · ${ordinal(predicate?.rank ?? 1)}`;
    case 'season_rank':      return `Season rank · ${ordinal(predicate?.rank ?? 1)}`;
    default:                 return 'Wager';
  }
}

export type OddsResult = { probability: number; odds: number };

export async function fetchOdds(s: WagerSubject): Promise<OddsResult | null> {
  const t = toSubjectTuple(s);
  const { data, error } = await supabase.rpc('calculate_wager_odds', {
    p_subject_type: t.subject_type,
    p_subject_id:   t.subject_id,
    p_predicate:    t.predicate,
  });
  if (error) return null;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;
  const probability = Number(row.probability);
  const odds        = Number(row.odds);
  if (Number.isNaN(probability) || Number.isNaN(odds)) return null;
  return { probability, odds };
}

export type PlaceWagerResult = {
  success: boolean;
  wager_id: string | null;
  odds: number | null;
  potential_payout: number | null;
  balance: number | null;
  message: string;
};

export async function placeWager(s: WagerSubject, stake: number): Promise<PlaceWagerResult> {
  const t = toSubjectTuple(s);
  const { data, error } = await supabase.rpc('place_wager', {
    p_subject_type: t.subject_type,
    p_subject_id:   t.subject_id,
    p_predicate:    t.predicate,
    p_stake:        stake,
  });
  if (error) {
    return { success: false, wager_id: null, odds: null, potential_payout: null, balance: null, message: error.message };
  }
  const row = Array.isArray(data) ? data[0] : data;
  return {
    success: !!row?.success,
    wager_id: row?.wager_id ?? null,
    odds: row?.odds != null ? Number(row.odds) : null,
    potential_payout: row?.potential_payout ?? null,
    balance: row?.balance ?? null,
    message: row?.message ?? '',
  };
}

export type CancelWagerResult = {
  success: boolean;
  refunded: number;
  balance: number | null;
  message: string;
};

export async function cancelWager(wagerId: string): Promise<CancelWagerResult> {
  const { data, error } = await supabase.rpc('cancel_wager', { p_wager_id: wagerId });
  if (error) {
    return { success: false, refunded: 0, balance: null, message: error.message };
  }
  const row = Array.isArray(data) ? data[0] : data;
  return {
    success: !!row?.success,
    refunded: row?.refunded ?? 0,
    balance: row?.balance ?? null,
    message: row?.message ?? '',
  };
}
