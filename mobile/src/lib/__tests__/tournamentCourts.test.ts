import { describe, expect, it } from 'vitest';
import {
  byeSlots, byesBefore, byesFor, courtAllowsScoring, courtLabel, courtState, courtStateLine, currentRound,
  parseCourts, playRounds, roundsText, type CourtMatch,
} from '../tournamentCourts';
import { generateRotatingPartners, generateRoundRobin } from '../tournament';

const ROUND = { id: 'r1', label: 'Schedule', round_type: 'winners', round_number: 1 };

/** Saved rows as lock-in writes them: match_order = index, play_round = the draw's round (or null). */
function rows(draw: { round: number; team1: (string | undefined)[]; team2: (string | undefined)[] }[], withRounds: boolean): CourtMatch[] {
  return draw.map((m, i) => ({
    id: `m${i}`, match_order: i, match_type: m.team1.length > 1 ? 'doubles' : 'singles', status: 'pending',
    winner_team: null, round: ROUND, play_round: withRounds ? m.round : null,
    team1_player1: m.team1[0] ?? null, team1_player2: m.team1[1] ?? null,
    team2_player1: m.team2[0] ?? null, team2_player2: m.team2[1] ?? null,
  }));
}
const ten = Array.from({ length: 10 }, (_, i) => `p${i + 1}`);

describe('courts: labels and the typed list', () => {
  it('labels numbers as courts and keeps names', () => {
    expect(courtLabel('4')).toBe('Court 4');
    expect(courtLabel(' Center ')).toBe('Center');
  });
  it('parses commas and new lines, drops blanks, repeats and a typed "Court"', () => {
    expect(parseCourts('1, 2,,Court 3\nCenter, center')).toEqual(['1', '2', '3', 'Center']);
  });
});

describe('byes (PKL-049): rounds from the draw', () => {
  const draw = generateRotatingPartners(ten);
  for (const withRounds of [true, false]) {
    it(`10 players rotating: 10 rounds, 2 byes each (play_round ${withRounds ? 'saved' : 'from the shape'})`, () => {
      const ms = rows(draw, withRounds);
      const rounds = playRounds(ms, 'rotating_partners', 'doubles');
      ms.forEach((m, i) => expect(rounds.get(m.id)).toBe(draw[i].round));
      for (const p of ten) expect(byesFor(ms, rounds, p)).toHaveLength(2);
    });
  }

  it('odd round robin: every player sits out exactly one round, all different', () => {
    const five = ['a', 'b', 'c', 'd', 'e'];
    const ms = rows(generateRoundRobin(five), false);
    const rounds = playRounds(ms, 'round_robin', 'singles');
    const byes = five.map(p => byesFor(ms, rounds, p));
    byes.forEach(b => expect(b).toHaveLength(1));
    expect(new Set(byes.flat()).size).toBe(5);
  });

  it('byesBefore names the bye between two matches, and the opening bye', () => {
    const ms = rows(draw, true);
    const rounds = playRounds(ms, 'rotating_partners', 'doubles');
    for (const p of ten) {
      const byes = byesFor(ms, rounds, p);
      const mine = ms.filter(m => [m.team1_player1, m.team1_player2, m.team2_player1, m.team2_player2].includes(p));
      const told = mine.flatMap(m => byesBefore(ms, rounds, p, m));
      const last = Math.max(...mine.map(m => rounds.get(m.id)!));
      expect(told).toEqual(byes.filter(b => b < last));   // a bye after the last match has no "before"
    }
  });

  it('bye slots sit before the first match of their round; current round = lowest open', () => {
    const ms = rows(draw, true);
    const rounds = playRounds(ms, 'rotating_partners', 'doubles');
    const slots = byeSlots(ms, rounds, 'p1');
    for (const s of slots) expect(rounds.get(s.beforeMatchId!)).toBe(s.round);
    expect(currentRound(ms, rounds)).toBe(1);
    ms[0].status = 'completed'; ms[1].status = 'completed';
    expect(currentRound(ms, rounds)).toBe(2);
  });

  it('rounds text', () => {
    expect(roundsText([4])).toBe('round 4');
    expect(roundsText([4, 5])).toBe('rounds 4 and 5');
    expect(roundsText([3, 4, 5])).toBe('rounds 3, 4 and 5');
  });

  it('other formats have no schedule rounds', () => {
    expect(playRounds(rows(draw, true), 'single_elimination', 'doubles').size).toBe(0);
  });
});

describe('court queue state (PKL-039)', () => {
  const ms = rows(generateRotatingPartners(ten), true);
  const rounds = playRounds(ms, 'rotating_partners', 'doubles');
  const courts = ['1', '2'];
  ms[0].called_at = 't'; ms[0].court = '1';
  ms[1].called_at = 't'; ms[1].court = '2';
  const name = (id: string) => id.toUpperCase();

  it('no courts reserved: free play, anyone in it can score', () => {
    expect(courtState(ms[3], ms, null, rounds)).toEqual({ kind: 'free_play' });
    expect(courtStateLine({ kind: 'free_play' }, name)).toBeNull();
    expect(courtAllowsScoring(ms[3], [], false)).toBe(true);
  });

  it('a called match is on its court', () => {
    expect(courtState(ms[0], ms, courts, rounds)).toEqual({ kind: 'on_court', court: '1' });
    expect(courtStateLine({ kind: 'on_court', court: '1' }, name)).toBe('On Court 1 now. Head there to play.');
  });

  it('a match with a player still on a court waits for that court', () => {
    const busy = ms.slice(2).find(m => courtState(m, ms, courts, rounds).kind === 'waiting_player')!;
    const s = courtState(busy, ms, courts, rounds);
    expect(s.kind).toBe('waiting_player');
    expect(courtStateLine(s, name)).toMatch(/^Waiting for .+'s match on Court [12] to finish\.$/);
  });

  it('only a called match can be scored, unless by the host', () => {
    expect(courtAllowsScoring(ms[2], courts, false)).toBe(false);
    expect(courtAllowsScoring(ms[2], courts, true)).toBe(true);
    expect(courtAllowsScoring(ms[0], courts, false)).toBe(true);
  });

  it('waiting for a free court counts the matches ahead', () => {
    expect(courtStateLine({ kind: 'waiting_court', ahead: 0 }, name)).toBe('Waiting for a free court. You\'re next.');
    expect(courtStateLine({ kind: 'waiting_court', ahead: 2 }, name)).toBe('Waiting for a free court, 2 matches ahead.');
  });
});
