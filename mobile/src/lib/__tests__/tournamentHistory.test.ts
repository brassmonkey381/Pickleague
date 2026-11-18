import { describe, it, expect } from 'vitest';
import {
  fromTournamentHistoryRow,
  mergeHistory,
  tournamentRatingChange,
  type TournamentHistoryRow,
} from '../tournamentHistory';
import { ratingSeries } from '../ratingHistory';

function row(over: Partial<TournamentHistoryRow> = {}): TournamentHistoryRow {
  return {
    id: 'tm1',
    tournament_id: 't1',
    tournament_name: 'Fall Open',
    league_id: 'l1',
    league_name: 'Alameda League',
    round_label: 'Rotating Partners Schedule',
    match_type: 'doubles',
    doubles_category: 'gendered',
    player1_id: 'a', partner1_id: 'b', player2_id: 'c', partner2_id: 'd',
    player1_score: 11, player2_score: 7,
    winner_team: 'team1',
    played_at: '2026-11-18T20:00:00Z',
    game_scores: null,
    plupr_ratings: {
      a: { before: '3.250', after: '3.400' },
      b: { before: 3.1, after: 3.25 },
      c: { before: 3.5, after: 3.35 },
      d: { before: 3.0, after: 2.85 },
    },
    player1: { id: 'a', full_name: 'Ann' },
    partner1: { id: 'b', full_name: 'Ben' },
    player2: { id: 'c', full_name: 'Cy' },
    partner2: { id: 'd', full_name: 'Di' },
    ...over,
  };
}

describe('fromTournamentHistoryRow', () => {
  it('maps teams, score, result and the tournament / league tags', () => {
    const m = fromTournamentHistoryRow(row());
    expect(m.status).toBe('completed');
    expect([m.player1_id, m.partner1_id, m.player2_id, m.partner2_id]).toEqual(['a', 'b', 'c', 'd']);
    expect([m.player1_score, m.player2_score, m.winner_team]).toEqual([11, 7, 'team1']);
    expect(m.tournament).toEqual({ id: 't1', name: 'Fall Open' });
    expect(m.tournament_id).toBe('t1');
    expect(m.league).toEqual({ id: 'l1', name: 'Alameda League' });
    expect(m.league_id).toBe('l1');
    expect(m.doubles_category).toBe('gendered');
    expect(m.player2?.full_name).toBe('Cy');
    expect(m.source).toBe('tournament');
  });

  it('fills player 1 / 2 ratings so the W/L card and the PLUPR chart work', () => {
    const m = fromTournamentHistoryRow(row());
    expect(m.player1_rating_before).toBeCloseTo(3.25);
    expect(m.player1_rating_after).toBeCloseTo(3.4);
    expect(m.player2_rating_after).toBeCloseTo(3.35);
    expect(ratingSeries([m], 'a')).toEqual([{ matchId: 'tm1', at: '2026-11-18T20:00:00Z', rating: 3.4 }]);
  });

  it('a standalone tournament has no league', () => {
    const m = fromTournamentHistoryRow(row({ league_id: null, league_name: null }));
    expect(m.league).toBeNull();
    expect(m.league_id).toBe('');
  });

  it('a match from before the migration shows no PLUPR change', () => {
    const m = fromTournamentHistoryRow(row({ plupr_ratings: null }));
    expect(m.player1_rating_before).toBeNull();
    expect(tournamentRatingChange(m, 'a')).toBeNull();
  });

  it('singles carry no doubles category', () => {
    const m = fromTournamentHistoryRow(row({ match_type: 'singles', partner1_id: null, partner2_id: null, doubles_category: null }));
    expect(m.doubles_category).toBeNull();
  });
});

describe('tournamentRatingChange', () => {
  it('gives every player their own move, partners included', () => {
    const m = fromTournamentHistoryRow(row());
    expect(tournamentRatingChange(m, 'a')).toBeCloseTo(0.15);
    expect(tournamentRatingChange(m, 'b')).toBeCloseTo(0.15);
    expect(tournamentRatingChange(m, 'd')).toBeCloseTo(-0.15);
    expect(tournamentRatingChange(m, 'zz')).toBeNull();
  });
});

describe('mergeHistory', () => {
  it('interleaves league and tournament matches newest first', () => {
    const a = [{ id: 'm2', played_at: '2026-11-18T21:00:00Z' }, { id: 'm1', played_at: '2026-11-17T10:00:00Z' }];
    const b = [{ id: 't1', played_at: '2026-11-18T20:00:00Z' }];
    expect(mergeHistory(a, b).map(x => x.id)).toEqual(['m2', 't1', 'm1']);
  });
});
