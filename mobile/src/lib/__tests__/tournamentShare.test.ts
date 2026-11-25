// PKL-092: the tournament share cards' words, held to Brian's mocks (rows 2-3) and the two-stage rule.
import { describe, expect, it } from 'vitest';
import { buildTournamentStory, type StoryInput, type StoryMatchup } from '../tournamentShare';

const P = (name: string) => ({ name, initials: name.slice(0, 2).toUpperCase() });
const team = (key: string, name: string) => ({ key, name, people: [P('Maya R.'), P('Jordan L.'), P('Priya N.'), P('Theo K.')] });
const entrants = [team('TSC', 'Third Shot Club'), team('DD', 'Dink Dynasty'), team('EE', 'Erne Express'),
  team('KK', 'Kitchen Kings'), team('LC', 'Lob City'), team('PB', 'Paddle Battle')];
const mu = (stage: StoryMatchup['stage'], a: string, b: string, aS: number | null, bS: number | null, db?: [number, number]): StoryMatchup =>
  ({ stage, a, b, aScore: aS, bScore: bS, winner: aS == null || bS == null ? null : aS > bS ? 'a' : 'b', dreambreaker: db ?? null,
    aPoints: (aS ?? 0) * 11, bPoints: (bS ?? 0) * 11 });
const pools = [mu('pool', 'TSC', 'DD', 3, 1), mu('pool', 'TSC', 'EE', 3, 0), mu('pool', 'DD', 'EE', 1, 3),
  mu('pool', 'KK', 'LC', 3, 2), mu('pool', 'KK', 'PB', 3, 1), mu('pool', 'LC', 'PB', 3, 0)];
const base: StoryInput = {
  title: 'Saturday Smash MLP', dateLabel: 'Sat Nov 28', isMlp: true, me: 'TSC', entrants,
  poolLabel: 'Pool A', poolPlace: 1, matchups: [...pools, mu('semifinals', 'TSC', 'LC', null, null), mu('semifinals', 'KK', 'EE', null, null)],
  hasPlayoff: true, completed: false, finalPlace: null, podium: [],
};

describe('PKL-092 after pool play (mock ShareMid)', () => {
  const s = buildTournamentStory(base)!;
  it('A Scorecard', () => {
    expect(s.moment).toBe('pool');
    expect(s.kicker).toBe('Saturday Smash MLP, Pool A');
    expect(s.headline).toBe('Into the semis.');
    expect(s.stats.map((x) => `${x.value} ${x.label}`)).toEqual(['2-0 Matchups', '6-1 Games', '+55 Points']);
    expect(s.rows.map((r) => `${r.lead} ${r.text} ${r.score ?? ''}`.trim())).toEqual(['W Dink Dynasty 3-1', 'W Erne Express 3-0', 'next Next: Semifinal v Lob City']);
  });
  it('B Bracket, C Poster, D Team photo', () => {
    expect(s.bracketHeadline).toBe('Pool A, won. Semis next.');
    expect(s.columns.map((c) => c.stage)).toEqual(['Semifinals', 'Final']);
    expect(s.columns[0].pairs[0].mine).toBe(true);
    expect(s.bracketFoot).toBe('2-0 in pool play, 6 games to 1');
    expect([s.posterBig, s.posterLine]).toEqual(['2-0', 'Undefeated. On to the semis.']);
    expect(s.banner).toBe('POOL A WINNERS');
    expect(s.photoSub).toBe('Saturday Smash MLP, 2-0 in pool play, semifinal next');
    expect(s.members).toBe('Maya, Jordan, Priya, Theo');
  });
  it("didn't make the playoff: no next row, pool play done", () => {
    const t = buildTournamentStory({ ...base, me: 'DD', poolPlace: 3 })!;
    expect([t.headline, t.bracketHeadline, t.posterLine, t.banner]).toEqual(['Pool play done.', 'Pool A, 3rd. Pool play done.', 'Pool play done.', 'POOL A, 3RD']);
    expect(t.rows.every((r) => r.lead !== 'next')).toBe(true);
  });
  it('no middle dots and no tie words', () => {
    expect(JSON.stringify(s)).not.toMatch(/·|tied|\bT-\d/i);
  });
  it('pools not finished: nothing to share yet', () => {
    expect(buildTournamentStory({ ...base, matchups: [...pools.slice(0, 5), mu('pool', 'LC', 'PB', null, null)] })).toBeNull();
  });
});

describe('PKL-092 the finish (mock ShareFinal)', () => {
  const done: StoryInput = {
    ...base, completed: true, finalPlace: 1,
    matchups: [...pools, mu('semifinals', 'TSC', 'LC', 3, 1), mu('semifinals', 'KK', 'EE', 3, 2), mu('finals', 'TSC', 'KK', 3, 2, [21, 19])],
    podium: [{ place: 1, keys: ['TSC'] }, { place: 2, keys: ['KK'] }, { place: 3, keys: ['LC', 'EE'] }, { place: 5, keys: ['DD'] }, { place: 6, keys: ['PB'] }],
  };
  const s = buildTournamentStory(done)!;
  it('champion: A, B, C', () => {
    expect([s.kicker, s.headline]).toEqual(['Saturday Smash MLP, Champions', '4-0. Title won.']);
    expect(s.rows.map((r) => `${r.text} ${r.score}`)).toEqual(['Pool, Dink Dynasty 3-1', 'Pool, Erne Express 3-0', 'Semifinal, Lob City 3-1', 'Final, Kitchen Kings 3-2']);
    expect(s.note).toBe('Final decided in the Dreambreaker, 21-19');
    expect(s.bracketHeadline).toBe('Champions.');
    expect(s.bracketFoot).toBe('Final 3-2, Dreambreaker 21-19');
    expect([s.posterTop, s.posterBig, s.posterLine]).toEqual(['CHAMPS', '3-2', 'over Kitchen Kings. Won the Dreambreaker 21-19.']);
    expect(s.banner).toBe('CHAMPIONS');
  });
  it('D podium: the shared 3rd shows both teams and no 4th (Brian 2026-11-25)', () => {
    expect(s.podium).toEqual([{ place: 1, names: ['Third Shot Club'] }, { place: 2, names: ['Kitchen Kings'] }, { place: 3, names: ['Lob City', 'Erne Express'] }]);
  });
  it('lost in the semis: 3rd place from the playoff, not the pool record', () => {
    const t = buildTournamentStory({ ...done, me: 'LC', poolPlace: 2, finalPlace: 3 })!;
    expect([t.headline, t.posterBig, t.posterLine, t.banner]).toEqual(['3rd place.', '3rd', 'Out in the semifinals.', '3RD PLACE']);
    expect(t.bracketSub).toBe('Lob City, semifinals');
    expect(s.bracketSub).toBe('Third Shot Club, through the bracket');
  });
  it('runner-up and a non-qualifier', () => {
    expect(buildTournamentStory({ ...done, me: 'KK', finalPlace: 2 })!.posterLine).toBe('Lost the Final 2-3.');
    const t = buildTournamentStory({ ...done, me: 'PB', poolPlace: 3, finalPlace: 6 })!;
    expect([t.headline, t.posterLine]).toEqual(['6th place.', "Pool A 3rd, 0-2. Didn't reach the playoff."]);
  });
  it('singles: match scores in points, player names', () => {
    const ents = [{ key: 'ana', name: 'Ana P.', people: [P('Ana P.')] }, { key: 'ben', name: 'Ben Q.', people: [P('Ben Q.')] }];
    const t = buildTournamentStory({
      ...base, isMlp: false, me: 'ana', entrants: ents, poolLabel: null, poolPlace: 1, completed: true, finalPlace: 1,
      matchups: [{ stage: 'pool', a: 'ana', b: 'ben', aScore: 11, bScore: 6, winner: 'a', aPoints: 11, bPoints: 6 },
        { stage: 'finals', a: 'ana', b: 'ben', aScore: 11, bScore: 8, winner: 'a', aPoints: 11, bPoints: 8 }],
      podium: [{ place: 1, keys: ['ana'] }, { place: 2, keys: ['ben'] }],
    })!;
    expect(t.stats.map((x) => `${x.value} ${x.label}`)).toEqual(['2-0 Record', '+8 Points']);
    expect([t.posterBig, t.posterLine]).toEqual(['11-8', 'over Ben Q.']);
  });
  it('very long names stay whole in the data (the layouts clip them)', () => {
    const long = 'The Very Long Annual Bay Area Mixed Doubles Charity Classic Invitational';
    expect(buildTournamentStory({ ...done, title: long })!.kicker.startsWith(long)).toBe(true);
  });
});

describe('PKL-092 the Godmode lab', () => {
  it('every edge case builds, with no middle dots or tie words', async () => {
    const { labStories } = await import('../tournamentShareLab');
    const xs = labStories();
    expect(xs.map((x) => x.id)).toEqual(['story-mlp-pool', 'story-mlp-champ', 'story-mlp-semis', 'story-mlp-out', 'story-mlp-out-pool', 'story-long', 'story-doubles']);
    for (const x of xs) expect(JSON.stringify(x.story)).not.toMatch(/·|tied/i);
  });
  it('raw rows through storyInputFrom: doubles pairs, points, the semifinal next', async () => {
    const { labStories } = await import('../tournamentShareLab');
    const d = labStories().find((x) => x.id === 'story-doubles')!.story;
    expect(d.me.name).toBe('Brian S. & Pat D.');
    expect(d.stats.map((x) => `${x.value} ${x.label}`)).toEqual(['1-1 Record', '+2 Points']);
    expect(d.rows.map((r) => `${r.lead} ${r.text} ${r.score ?? ''}`.trim())).toEqual(['W Sam L. & Lee K. 11-7', 'L Dee W. & Eve M. 9-11', 'next Next: Semifinal v Kim R. & Ana P.']);
    expect(d.banner).toBe('POOL A, 2ND');
  });
});
