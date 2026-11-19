// PKL-037 / 040 / 041 through buildStandings: doubles round robin with a
// medal stage, and rotating partners (per-player).
import { describe, it, expect } from 'vitest';
import { medalStage, type ScheduleMatch } from '../tournamentModel';
import { buildStandings, myPlacement, myStanding, playoffTieBlock } from '../standingsData';

const reg = (user_id: string, seed: number | null = null) => ({
  id: `reg-${user_id}`, tournament_id: 't', user_id, status: 'approved', seed,
  registered_at: '2026-10-01T00:00:00Z', invited_by: null, role: 'member',
}) as any;

describe('doubles round robin with a medal stage', () => {
  const G = { id: 'rG', label: 'Round Robin Schedule', round_type: 'winners', round_number: 1 };
  const F = { id: 'rF', label: 'Finals', round_type: 'finals', round_number: 1000 };
  const T = { id: 'rT', label: 'Third Place Match', round_type: 'third_place_match', round_number: 1100 };
  const teams = [['me', 'p1'], ['b1', 'b2'], ['c1', 'c2'], ['d1', 'd2'], ['e1', 'e2']];
  const nm: Record<string, string> = {
    me: 'Me', p1: 'Pat', b1: 'Bo', b2: 'Bea', c1: 'Cy', c2: 'Cat', d1: 'Di', d2: 'Dan', e1: 'Ed', e2: 'Eve',
  };
  const m = (
    id: string, round: any, t1: string[], t2: string[], winner: 'team1' | 'team2' | null, s1 = 11, s2 = 7,
  ): ScheduleMatch => ({
    id, round, match_order: 0, match_type: 'doubles',
    status: winner ? 'completed' : 'pending', winner_team: winner,
    team1_player1: t1[0], team1_player2: t1[1], team2_player1: t2[0], team2_player2: t2[1],
    team1_score: winner ? s1 : null, team2_score: winner ? s2 : null,
  });
  // Round robin: the lower index always wins, so the RR order is teams[0..4].
  const rr: ScheduleMatch[] = [];
  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) rr.push(m(`g${i}${j}`, G, teams[i], teams[j], 'team1'));
  }
  const regs = Object.keys(nm).map(id => reg(id));
  const build = (matches: ScheduleMatch[], status = 'active', finalRanks: any[] = [], tieRanks: Record<string, number> = {}) => buildStandings({
    tournament: { format: 'round_robin', match_type: 'doubles', status } as any,
    savedMatches: matches, savedRounds: [G, F, T], registrations: regs,
    profileNames: nm, myUserId: 'me',
    mlpStandings: null, myMlpTeamId: null, finalRanks, tieRanks,
  });

  it('before the medal matches: finalists share 1-2, the 3rd place pair 3-4, 5th from the round robin', () => {
    const data = build([...rr, m('f', F, teams[0], teams[1], null), m('t', T, teams[2], teams[3], null)]);
    expect(data?.tables[0].rows.map(r => r.name)).toEqual(['Me & Pat', 'Bo & Bea', 'Cy & Cat', 'Di & Dan', 'Ed & Eve']);
    expect(data?.placement?.rows.map(r => [r.name, r.place, r.from])).toEqual([
      ['Me & Pat', '1-2', 'Final'], ['Bo & Bea', '1-2', 'Final'],
      ['Cy & Cat', '3-4', '3rd place match'], ['Di & Dan', '3-4', '3rd place match'],
      ['Ed & Eve', '5', 'Round robin'],
    ]);
  });

  it('the 3rd place match decides 3 and 4; the RR table ignores the medal matches', () => {
    const data = build([...rr, m('f', F, teams[0], teams[1], 'team2'), m('t', T, teams[2], teams[3], 'team2')]);
    expect(data?.groupStage).toBe(true);
    expect(data?.tables[0].rows.map(r => [r.name, r.wins, r.losses])).toEqual([
      ['Me & Pat', 4, 0], ['Bo & Bea', 3, 1], ['Cy & Cat', 2, 2], ['Di & Dan', 1, 3], ['Ed & Eve', 0, 4],
    ]);
    expect(data?.placement?.rows.map(r => [r.name, r.place])).toEqual([
      ['Bo & Bea', '1'], ['Me & Pat', '2'], ['Di & Dan', '3'], ['Cy & Cat', '4'], ['Ed & Eve', '5'],
    ]);
    // The placement record counts every match; the RR row only RR matches.
    expect(myPlacement(data)).toMatchObject({ place: '2', wins: 4, losses: 1 });
    expect(myStanding(data)).toMatchObject({ position: 1, row: { wins: 4, losses: 0 } });
  });

  it('completed: the placement shows the stored ranks; the RR table keeps the RR order', () => {
    const ranks = ([['b1', 1], ['b2', 1], ['me', 2], ['p1', 2], ['d1', 3], ['d2', 3], ['c1', 4], ['c2', 4], ['e1', 5], ['e2', 5]] as const)
      .map(([user_id, final_rank]) => ({ user_id, final_rank, wins: 0, losses: 0 }));
    const data = build(
      [...rr, m('f', F, teams[0], teams[1], 'team2'), m('t', T, teams[2], teams[3], 'team2')], 'completed', ranks);
    expect(data?.tables[0].rows[0].name).toBe('Me & Pat');
    expect(data?.placement?.settled).toBe(true);
    expect(data?.placement?.rows.map(r => [r.name, r.place, r.from])).toEqual([
      ['Bo & Bea', '1', 'Final'], ['Me & Pat', '2', 'Final'], ['Di & Dan', '3', '3rd place match'],
      ['Cy & Cat', '4', '3rd place match'], ['Ed & Eve', '5', 'Round robin'],
    ]);
  });

  it('medalStage: the Final and the 3rd place match together, whatever their order', () => {
    const st = medalStage([...rr, m('t', T, teams[2], teams[3], null), m('f', F, teams[0], teams[1], null)]);
    expect(st?.final.id).toBe('f');
    expect(st?.third?.id).toBe('t');
    expect(medalStage(rr)).toBeNull();
  });

  it('tie notes for tied doubles teams: point diff, then waiting for the admin (PKL-052)', () => {
    // Bo & Bea beat Me & Pat and lose to Ed & Eve: both pairs end 3-1. Bo &
    // Bea won the meeting, but Me & Pat are +9 to their +7, so Me & Pat lead.
    // Di & Dan and Ed & Eve end 1-3 at -8 each: waiting for the admin.
    const flipped = rr.map(x => (x.id === 'g01' ? m('g01', G, teams[0], teams[1], 'team2', 8, 11)
      : x.id === 'g14' ? m('g14', G, teams[1], teams[4], 'team2', 7, 11) : x));
    const data = build(flipped);
    const tbl = data!.tables[0];
    const ties = tbl.ties ?? {};
    expect(tbl.rows.map(r => r.name)).toEqual(['Me & Pat', 'Bo & Bea', 'Cy & Cat', 'Di & Dan', 'Ed & Eve']);
    expect(ties['me|p1']).toBe('Tied on 3-1 with Bo & Bea; ahead on point diff (+9 vs +7).');
    expect(ties['b1|b2']).toBe('Tied on 3-1 with Me & Pat; behind on point diff (+7 vs +9).');
    expect(ties['d1|d2']).toBe('Tied on 1-3 and -8 with Ed & Eve: waiting for the admin to set the order.');
    expect(ties['c1|c2']).toBeUndefined();
    expect(tbl.rows.filter(r => r.waiting).map(r => r.key)).toEqual(['d1|d2', 'e1|e2']);
    expect(data!.waitingCount).toBe(1);
    expect(tbl.groups?.find(g => g.waiting)).toMatchObject({
      position: 4, record: '1-3 and -8',
      entrants: [{ key: 'd1|d2', tieKeys: ['d1:d2'] }, { key: 'e1|e2', tieKeys: ['e1:e2'] }],
    });
    // Only a playoff that reaches 4th is blocked by it.
    expect(playoffTieBlock(data, 'top_2')).toBeNull();
    expect(playoffTieBlock(data, 'top_4')).toBe('The standings have a tie at 4th: set the tie order first.');

    // The admin orders Ed & Eve ahead.
    const ordered = build(flipped, 'active', [], { 'e1:e2': 1, 'd1:d2': 2 });
    expect(ordered!.tables[0].rows.slice(3).map(r => r.name)).toEqual(['Ed & Eve', 'Di & Dan']);
    expect(ordered!.tables[0].ties?.['d1|d2']).toBe('Tied on 1-3 and -8 with Ed & Eve; order set by the admin.');
    expect(ordered!.waitingCount).toBe(0);
    expect(ordered!.tables[0].rows.some(r => r.waiting)).toBe(false);
    expect(playoffTieBlock(ordered, 'top_4')).toBeNull();
  });

  it('every format shows W-L and point diff: the rule line', () => {
    expect(build(rr)?.note).toMatch(/Wins, then fewer losses, then point differential. A tie after that is ordered by the tournament admin.$/);
  });
});

describe('rotating partners: per-player standings and placement', () => {
  const ids = ['me', 'a', 'b', 'c'];
  const nm: Record<string, string> = { me: 'Me', a: 'Ann', b: 'Bo', c: 'Cy' };
  const R1 = { id: 'r1', label: 'Round 1', round_type: 'winners', round_number: 1 };
  const m = (id: string, t1: string[], t2: string[], winner: 'team1' | 'team2' | null, s1 = 11, s2 = 5): ScheduleMatch => ({
    id, round: R1, match_order: 0, match_type: 'doubles',
    status: winner ? 'completed' : 'pending', winner_team: winner,
    team1_player1: t1[0], team1_player2: t1[1], team2_player1: t2[0], team2_player2: t2[1],
    team1_score: winner ? s1 : null, team2_score: winner ? s2 : null,
  });
  const build = (matches: ScheduleMatch[], status = 'active', finalRanks: any[] = []) => buildStandings({
    tournament: { format: 'rotating_partners', match_type: 'doubles', status } as any,
    savedMatches: matches, savedRounds: [R1], registrations: ids.map(id => reg(id)),
    profileNames: nm, myUserId: 'me',
    mlpStandings: null, myMlpTeamId: null, finalRanks,
  });
  // me+a beat b+c, me+b beat a+c, then a+b beat me+c.
  const played = [
    m('x1', ['me', 'a'], ['b', 'c'], 'team1'),
    m('x2', ['me', 'b'], ['a', 'c'], 'team1', 11, 9),
    m('x3', ['me', 'c'], ['a', 'b'], 'team2', 6, 11),
  ];

  it('tie notes per player: W-L, then point diff (no head-to-head, no PLUPR)', () => {
    const data = build(played);
    expect(data?.kind).toBe('player');
    // me, a and b are all 2-1: point diff decides: a +9, me +3, b +1.
    expect(data?.tables[0].rows.map(r => [r.key, r.pf! - r.pa!])).toEqual([['a', 9], ['me', 3], ['b', 1], ['c', -13]]);
    const tie = data?.tables[0].ties?.me ?? '';
    expect(tie).toBe('Tied on 2-1 with Ann, Bo; placed by point diff (+3 vs +9, +1).');
    expect(data?.tables[0].ties?.c).toBeUndefined();
  });

  it('a placement table once every match is in, then the stored ranks', () => {
    expect(build([...played, m('x4', ['a', 'b'], ['c', 'me'], null)])?.placement).toBeNull();
    const live = build(played);
    expect(live?.placement?.rows.map(r => [r.key, r.place])).toEqual([['a', '1'], ['me', '2'], ['b', '3'], ['c', '4']]);
    const done = build(played, 'completed', [
      { user_id: 'b', final_rank: 1, wins: 2, losses: 1 },
      { user_id: 'me', final_rank: 2, wins: 2, losses: 1 },
      { user_id: 'a', final_rank: 3, wins: 2, losses: 1 },
      { user_id: 'c', final_rank: 4, wins: 0, losses: 3 },
    ]);
    expect(done?.placement?.settled).toBe(true);
    expect(done?.placement?.rows.map(r => r.key)).toEqual(['b', 'me', 'a', 'c']);
    // The standings table itself is not reordered by the stored ranks.
    expect(done?.tables[0].rows.map(r => r.key)).toEqual(['a', 'me', 'b', 'c']);
  });
});
