import { describe, expect, it } from 'vitest';
import { waitReason, type WaitMatch } from '../waitReason';

let n = 0;
const rnd = (type: string, num: number, tag = '') => ({ id: `${type}${num}${tag}`, label: null, round_type: type, round_number: num });
const mk = (round: ReturnType<typeof rnd>, a: string[], b: string[], o: Partial<WaitMatch> = {}): WaitMatch => ({
  id: `m${n++}`, round_id: round.id, round, status: 'pending', winner_team: null, match_order: n,
  team1_player1: a[0], team1_player2: a[1] ?? null, team2_player1: b[0], team2_player2: b[1] ?? null, ...o,
});
const won = (w: 'team1' | 'team2'): Partial<WaitMatch> => ({ status: 'completed', winner_team: w });

// MLP: 4 teams of 4 players
const T: Record<string, string[]> = { TSC: ['t1', 't2', 't3', 't4'], KK: ['k1', 'k2', 'k3', 'k4'], EE: ['e1', 'e2', 'e3', 'e4'], LC: ['l1', 'l2', 'l3', 'l4'] };
const teamName = (ps: string[]) => Object.keys(T).find(k => T[k].includes(ps[0])) ?? '?';
/** A meeting: 4 games + a Dreambreaker; results like ['team1','team2',...] (undefined = pending). */
function meeting(round: ReturnType<typeof rnd>, a: string, b: string, res: ('team1' | 'team2' | undefined)[], db: 'pending' | 'cancelled' | 'team1' | 'team2' = 'pending', o: Partial<WaitMatch> = {}) {
  const slots = [[0, 1], [2, 3], [0, 2], [1, 3]];
  const games = slots.map(([x, y], i) => mk(round, [T[a][x], T[a][y]], [T[b][x], T[b][y]], res[i] ? won(res[i]!) : {}));
  const d = mk(round, [T[a][0]], [T[b][0]], { is_dreambreaker: true, ...(db === 'pending' ? o : db === 'cancelled' ? { status: 'cancelled' } : won(db)) });
  return [...games, d];
}

describe('PKL-091 why no match right now', () => {
  it('MLP semifinal won, the other semifinal at 2-2 with the Dreambreaker on court: names it and links to it', () => {
    const sf = rnd('semifinals', 1001, 'a'), sf2 = rnd('semifinals', 1001, 'b');
    const ms = [
      ...meeting(sf, 'TSC', 'LC', ['team1', 'team1', 'team1', undefined], 'cancelled'),
      ...meeting(sf2, 'KK', 'EE', ['team1', 'team2', 'team1', 'team2'], 'pending', { called_at: '2026-11-25T03:00:00Z', court: '1' }),
    ];
    const w = waitReason({ format: 'mlp', isMlp: true, hasPlayoff: true, me: T.TSC, matches: ms, nameOf: teamName })!;
    expect(w.title).toBe('Your team is in the Final');
    expect(w.line).toBe('It starts when Semifinal 2: KK v EE, 2-2, Dreambreaker on Court 1 ends.');
    expect(w.matchId).toBe(ms[5].id);
  });

  it('MLP semifinal lost: out, watch the Final', () => {
    const sf = rnd('semifinals', 1001, 'a'), sf2 = rnd('semifinals', 1001, 'b'), fin = rnd('finals', 1002);
    const ms = [
      ...meeting(sf, 'TSC', 'LC', ['team2', 'team2', 'team2', undefined], 'cancelled'),
      ...meeting(sf2, 'KK', 'EE', ['team1', 'team1', 'team1', undefined], 'cancelled'),
      ...meeting(fin, 'LC', 'KK', ['team1', 'team2', 'team1', undefined]),
    ];
    const w = waitReason({ format: 'mlp', isMlp: true, hasPlayoff: true, me: T.TSC, matches: ms, nameOf: teamName })!;
    expect(w.title).toBe('Your team is out');
    expect(w.line).toBe('Watch the Final: LC v KK, 2-1');
  });

  it('MLP pool play: my matchups done, others still going, counts them', () => {
    const r1 = rnd('pool', 1), r2 = rnd('pool', 2);
    const ms = [
      ...meeting(r1, 'TSC', 'KK', ['team1', 'team1', 'team1', 'team2'], 'cancelled'),
      ...meeting(r2, 'EE', 'LC', ['team1', 'team2', undefined, undefined]),
    ];
    const w = waitReason({ format: 'mlp', isMlp: true, hasPlayoff: true, me: T.TSC, matches: ms, nameOf: teamName })!;
    expect(w.title).toBe('Your matchups are done');
    expect(w.line).toBe('1 more matchup to finish before the playoff draw. Now: EE v LC, 1-1');
  });

  it('a match of mine is open: no wait reason (the next-match card shows)', () => {
    const r1 = rnd('winners', 1);
    const ms = [mk(r1, ['a'], ['b']), mk(r1, ['c'], ['d'])];
    expect(waitReason({ format: 'round_robin', isMlp: false, hasPlayoff: false, me: ['a'], matches: ms, nameOf: p => p.join(' & ') })).toBeNull();
  });

  it('singles round robin: my matches done, 2 left, no playoff', () => {
    const r1 = rnd('winners', 1);
    const ms = [mk(r1, ['a'], ['b'], won('team1')), mk(r1, ['c'], ['d'], { called_at: 'x', court: '2' }), mk(r1, ['b'], ['d'])];
    const w = waitReason({ format: 'round_robin', isMlp: false, hasPlayoff: false, me: ['a'], matches: ms, nameOf: p => p.join(' & ') })!;
    expect(w.title).toBe('Your matches are done');
    expect(w.line).toBe('2 more matches to finish. Now: c v d, on Court 2 now');
  });

  it('bracket: won my quarterfinal, waiting on the other two', () => {
    const qf = rnd('quarterfinals', 1000);
    const ms = [mk(qf, ['a'], ['b'], won('team1')), mk(qf, ['c'], ['d'], won('team2')), mk(qf, ['e'], ['f']), mk(qf, ['g'], ['h'])];
    const w = waitReason({ format: 'round_robin', isMlp: false, hasPlayoff: true, me: ['a'], matches: ms, nameOf: p => p.join(' & ') })!;
    expect(w.title).toBe('You\'re in the Semifinals');
    expect(w.line).toBe('It starts when 2 more matches end.');
  });

  it('third place match lost: finished 4th; Final lost: finished 2nd', () => {
    const tp = rnd('third_place_match', 1003), fin = rnd('finals', 1002);
    const ms = [mk(tp, ['a'], ['b'], won('team2')), mk(fin, ['c'], ['d'], won('team1'))];
    const nm = (p: string[]) => p.join(' & ');
    expect(waitReason({ format: 'round_robin', isMlp: false, hasPlayoff: true, me: ['a'], matches: ms, nameOf: nm })!.title).toBe('You finished 4th');
    expect(waitReason({ format: 'round_robin', isMlp: false, hasPlayoff: true, me: ['d'], matches: ms, nameOf: nm })!.title).toBe('You finished 2nd');
  });

  it('round robin done, playoff drawn without me', () => {
    const r1 = rnd('winners', 1), sf = rnd('semifinals', 1000);
    const ms = [mk(r1, ['a'], ['b'], won('team2')), mk(sf, ['b'], ['c'])];
    const w = waitReason({ format: 'round_robin', isMlp: false, hasPlayoff: true, me: ['a'], matches: ms, nameOf: p => p.join(' & ') })!;
    expect(w.title).toBe('You didn\'t make the playoff');
    expect(w.line).toBe('Watch the Semifinal: b v c');
  });

  it('single elimination: lost round 1, out', () => {
    const r1 = rnd('winners', 1);
    const ms = [mk(r1, ['a'], ['b'], won('team2')), mk(r1, ['c'], ['d'])];
    const w = waitReason({ format: 'single_elimination', isMlp: false, hasPlayoff: false, me: ['a'], matches: ms, nameOf: p => p.join(' & ') })!;
    expect(w.title).toBe('You\'re out');
    expect(w.line).toBe('Watch Round 1, match 2: c v d');
  });
});
