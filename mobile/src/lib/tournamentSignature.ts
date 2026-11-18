/** PKL-038: the change signature lib/tournamentLive.ts polls. Pure. */
export type SigMatch = {
  id: string;
  status: string | null;
  winner_team: string | null;
  team1_score: number | null;
  team2_score: number | null;
  team1_player1: string | null;
  team1_player2?: string | null;
  team2_player1: string | null;
  team2_player2?: string | null;
};

/**
 * A string that changes whenever anything a tournament screen shows changes:
 * a score, a status, a newly drawn match or round (the playoff), a side being
 * filled in, or the tournament's own status. Order-independent.
 */
export function tournamentSignature(
  matches: SigMatch[],
  roundIds: string[],
  tournamentStatus: string | null,
): string {
  const ms = [...matches]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(m => [m.id, m.status, m.winner_team, m.team1_score, m.team2_score,
      m.team1_player1, m.team1_player2, m.team2_player1, m.team2_player2].join(','))
    .join(';');
  return `${tournamentStatus ?? ''}|${[...roundIds].sort().join(',')}|${ms}`;
}
