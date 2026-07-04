import { describe, it, expect } from 'vitest';
import { computeHeadToHead, H2HMatchRow } from '../headToHead';

const ME = 'me';
const OPP = 'opp';

// Minimal match-row builder. Defaults to a decisive singles match.
function match(p: Partial<H2HMatchRow>): H2HMatchRow {
  return {
    id: Math.random().toString(36).slice(2),
    match_type: 'singles',
    player1_id: ME,
    partner1_id: null,
    player2_id: OPP,
    partner2_id: null,
    player1_score: 11,
    player2_score: 7,
    winner_team: 'team1',
    status: 'completed',
    played_at: '2026-01-01T00:00:00Z',
    ...p,
  };
}

describe('computeHeadToHead', () => {
  it('tallies opponent wins/losses from each side', () => {
    const h = computeHeadToHead(ME, OPP, [
      match({ winner_team: 'team1' }),                       // me wins
      match({ winner_team: 'team2' }),                       // opp wins
      match({ player1_id: OPP, player2_id: ME, winner_team: 'team2' }), // me is team2, team2 wins → me wins
    ]);
    expect(h.opponents.total).toBe(3);
    expect(h.opponents.meWins).toBe(2);
    expect(h.opponents.oppWins).toBe(1);
  });

  it('records score from the caller’s perspective regardless of slot', () => {
    const h = computeHeadToHead(ME, OPP, [
      // me sits in team2, so my score is player2_score.
      match({ player1_id: OPP, player2_id: ME, player1_score: 9, player2_score: 11, winner_team: 'team2' }),
    ]);
    expect(h.opponents.meetings[0].myScore).toBe(11);
    expect(h.opponents.meetings[0].oppScore).toBe(9);
    expect(h.opponents.meetings[0].iWon).toBe(true);
  });

  it('counts same-team matches as partnerships, not opponent meetings', () => {
    const h = computeHeadToHead(ME, OPP, [
      match({ match_type: 'doubles', player1_id: ME, partner1_id: OPP, player2_id: 'x', partner2_id: 'y', winner_team: 'team1' }), // win together
      match({ match_type: 'doubles', player1_id: ME, partner1_id: OPP, player2_id: 'x', partner2_id: 'y', winner_team: 'team2' }), // loss together
    ]);
    expect(h.opponents.total).toBe(0);
    expect(h.partners.total).toBe(2);
    expect(h.partners.wins).toBe(1);
    expect(h.partners.losses).toBe(1);
  });

  it('splits the record by match type', () => {
    const h = computeHeadToHead(ME, OPP, [
      match({ match_type: 'singles', winner_team: 'team1' }),
      match({ match_type: 'doubles', player2_id: OPP, partner1_id: 'a', partner2_id: 'b', winner_team: 'team2' }),
    ]);
    expect(h.opponents.singles).toEqual({ meWins: 1, oppWins: 0 });
    expect(h.opponents.doubles).toEqual({ meWins: 0, oppWins: 1 });
  });

  it('computes the current win streak from most-recent meetings', () => {
    const h = computeHeadToHead(ME, OPP, [
      match({ played_at: '2026-03-01T00:00:00Z', winner_team: 'team1' }), // most recent: me
      match({ played_at: '2026-02-01T00:00:00Z', winner_team: 'team1' }), // me
      match({ played_at: '2026-01-01T00:00:00Z', winner_team: 'team2' }), // opp (breaks)
    ]);
    expect(h.opponents.streak).toEqual({ holder: 'me', count: 2 });
  });

  it('ignores matches that do not involve both players', () => {
    const h = computeHeadToHead(ME, OPP, [
      match({ player2_id: 'someone-else' }), // opp not present
    ]);
    expect(h.opponents.total).toBe(0);
    expect(h.opponents.meetings).toHaveLength(0);
  });

  it('lists undecided meetings but excludes them from the record and streak', () => {
    const h = computeHeadToHead(ME, OPP, [
      match({ played_at: '2026-03-01T00:00:00Z', winner_team: null }),    // undecided, most recent
      match({ played_at: '2026-02-01T00:00:00Z', winner_team: 'team1' }), // me wins
    ]);
    expect(h.opponents.total).toBe(1);
    expect(h.opponents.meetings).toHaveLength(2);
    expect(h.opponents.meetings[0].iWon).toBeNull();
    // Undecided most-recent meeting is skipped, not treated as a streak break.
    expect(h.opponents.streak).toEqual({ holder: 'me', count: 1 });
  });
});
