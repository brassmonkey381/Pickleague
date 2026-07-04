// Head-to-head computation between two players from raw match rows.
//
// Pure + side-effect free so it's trivial to test and the screen stays thin.
// Team model mirrors the rest of the app: team1 = player1 + partner1,
// team2 = player2 + partner2; `winner_team` is 'team1' | 'team2' | null.

export type H2HMatchRow = {
  id: string;
  match_type: 'singles' | 'doubles';
  player1_id: string;
  partner1_id: string | null;
  player2_id: string;
  partner2_id: string | null;
  player1_score: number | null;
  player2_score: number | null;
  winner_team: 'team1' | 'team2' | null;
  status: string;
  played_at: string;
};

export type H2HMeeting = {
  id: string;
  match_type: 'singles' | 'doubles';
  played_at: string;
  myScore: number | null;
  oppScore: number | null;
  iWon: boolean | null; // null when no decisive winner is recorded
};

export type HeadToHead = {
  opponents: {
    total: number; // decisive meetings on opposite teams
    meWins: number;
    oppWins: number;
    singles: { meWins: number; oppWins: number };
    doubles: { meWins: number; oppWins: number };
    meetings: H2HMeeting[]; // most-recent first (includes undecided)
    streak: { holder: 'me' | 'opp' | null; count: number };
  };
  partners: {
    total: number; // decisive matches on the same team
    wins: number;
    losses: number;
  };
};

// Which team is this user on for this match? 1, 2, or null if not involved.
function teamOf(m: H2HMatchRow, userId: string): 1 | 2 | null {
  if (m.player1_id === userId || m.partner1_id === userId) return 1;
  if (m.player2_id === userId || m.partner2_id === userId) return 2;
  return null;
}

export function computeHeadToHead(
  meId: string,
  oppId: string,
  matches: H2HMatchRow[],
): HeadToHead {
  const h: HeadToHead = {
    opponents: {
      total: 0, meWins: 0, oppWins: 0,
      singles: { meWins: 0, oppWins: 0 },
      doubles: { meWins: 0, oppWins: 0 },
      meetings: [],
      streak: { holder: null, count: 0 },
    },
    partners: { total: 0, wins: 0, losses: 0 },
  };

  // Most-recent first so the meetings list and streak read chronologically.
  const sorted = [...matches].sort(
    (a, b) => new Date(b.played_at).getTime() - new Date(a.played_at).getTime(),
  );

  for (const m of sorted) {
    const myTeam = teamOf(m, meId);
    const oppTeam = teamOf(m, oppId);
    if (myTeam == null || oppTeam == null) continue; // both must be in the match

    const decisive = m.winner_team === 'team1' || m.winner_team === 'team2';
    const iWon = decisive ? m.winner_team === `team${myTeam}` : null;

    if (myTeam === oppTeam) {
      // Played as partners — only tallied when there's a decisive result.
      if (decisive) {
        h.partners.total++;
        if (iWon) h.partners.wins++;
        else h.partners.losses++;
      }
      continue;
    }

    // Opponents.
    const myScore = myTeam === 1 ? m.player1_score : m.player2_score;
    const oppScore = myTeam === 1 ? m.player2_score : m.player1_score;
    h.opponents.meetings.push({
      id: m.id,
      match_type: m.match_type,
      played_at: m.played_at,
      myScore,
      oppScore,
      iWon,
    });

    if (decisive) {
      h.opponents.total++;
      const bucket = m.match_type === 'singles' ? h.opponents.singles : h.opponents.doubles;
      if (iWon) { h.opponents.meWins++; bucket.meWins++; }
      else { h.opponents.oppWins++; bucket.oppWins++; }
    }
  }

  // Current streak: leading run of same winner across decisive meetings.
  for (const meet of h.opponents.meetings) {
    if (meet.iWon == null) continue; // skip undecided without breaking the run
    const holder: 'me' | 'opp' = meet.iWon ? 'me' : 'opp';
    if (h.opponents.streak.holder == null) {
      h.opponents.streak = { holder, count: 1 };
    } else if (h.opponents.streak.holder === holder) {
      h.opponents.streak.count++;
    } else {
      break;
    }
  }

  return h;
}
