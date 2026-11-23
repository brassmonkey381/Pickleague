import { describe, expect, it } from 'vitest';
import {
  SCORE_DISCLAIMER,
  SHARE_BANNER_DEFAULT,
  SHARE_LOOK_IDS,
  SHARE_LOOKS,
  bannerColors,
  bracketCardModel,
  bracketSteps,
  bracketOverview,
  eventCardModel,
  finishCardModel,
  initialsFromShort,
  joinPeople,
  matchCardModel,
  pluprDeltaLabel,
  sessionCardModel,
  sessionTally,
  shareCardMessage,
  shareDefaultDetails,
  shareDetailOptions,
  shareTemplatesFor,
  shareToastText,
  type BracketMatchIn,
  type SessionMatchIn,
} from '../shareCards';
import { finishShareMessage, type FinishShareData } from '../finishShare';

const pat = { name: 'Pat D.', initials: 'PD' };
const sam = { name: 'Sam L.', initials: 'SL' };

describe('options', () => {
  it('offers five looks with Doggle-style layouts by photo count', () => {
    expect(SHARE_LOOK_IDS).toHaveLength(5);
    for (const id of SHARE_LOOK_IDS) expect(SHARE_LOOKS[id].ground).toMatch(/^#/);
    expect(shareTemplatesFor(0)).toEqual(['poster', 'big', 'scorecard']);
    expect(shareTemplatesFor(1)).toEqual(['photo-full', 'photo-panel', 'polaroid']);
    expect(shareTemplatesFor(3)).toEqual(['strip', 'grid', 'duo', 'polaroid', 'photo-full']);
  });
  it('only photo layouts with text over the photo have a banner', () => {
    expect(Object.keys(SHARE_BANNER_DEFAULT).sort()).toEqual(['grid', 'photo-full', 'strip']);
    expect(bannerColors('brand', SHARE_LOOKS.ball).bg).toBe(SHARE_LOOKS.ball.ground);
    expect(bannerColors('solid', SHARE_LOOKS.court).bg).toBe('#000000');
    expect(bannerColors('light', SHARE_LOOKS.court).ink).toBe('#1d2b22');
  });
  it('says where to paste the link', () => {
    expect(shareToastText({ invite: true, aspect: 'story', reward: '500' })).toContain('Link sticker');
    expect(shareToastText({ invite: false, aspect: 'post', reward: '500' })).toContain('bio');
  });
});

describe('helpers', () => {
  it('joins people and formats a PLUPR change', () => {
    expect(joinPeople([])).toBe('a player');
    expect(joinPeople([pat, sam])).toBe('Pat D. & Sam L.');
    expect(pluprDeltaLabel(0.123)).toBe('+0.12');
    expect(pluprDeltaLabel(-0.08)).toBe('−0.08');
    expect(pluprDeltaLabel(null)).toBeNull();
    expect(initialsFromShort('Brian S.')).toBe('BS');
    expect(initialsFromShort('Cher')).toBe('C');
  });
});

describe('finish card', () => {
  const data: FinishShareData = {
    kind: 'season', title: 'Fall 2026', league: 'Lakeside', rank: 2, of: 10, wins: 7, losses: 3, me: 'Brian S.',
    podium: [{ rank: 1, players: [pat] }, { rank: 2, players: [sam] }],
  };
  it('keeps the old message and starts with the podium off', () => {
    const m = finishCardModel(data);
    expect(shareCardMessage(m, 'https://x')).toBe(finishShareMessage(data, 'https://x'));
    expect(m.hero.big).toBe('2nd place');
    expect(m.hero.medal).toBe(2);
    expect(shareDefaultDetails(m)).toEqual({ record: true, podium: false });
    expect(m.showsScores).toBe(false);
  });
});

describe('match card', () => {
  const m = matchCardModel({
    doubles: true, won: true, myScore: 11, oppScore: 7, me: 'Brian S.', partner: pat, opponents: [sam],
    pluprDelta: 0.04, court: 'Lakeside', date: 'Oct 27', scope: 'Fall league',
  });
  it('leads with the score and carries the disclaimer flag', () => {
    expect(m.hero.big).toBe('11–7');
    expect(m.title).toBe('vs Sam L.');
    expect(m.showsScores).toBe(true);
    expect(shareDetailOptions(m).map((o) => o.id)).toEqual(['plupr', 'date', 'court', 'players']);
    expect(m.rows[0].items[0].people?.map((p) => p.name)).toEqual(['Brian S.', 'Pat D.']);
    expect(SCORE_DISCLAIMER).toBe(
      'Always ask your teammates and opponents if they are OK with you posting their scores to social media.',
    );
  });
});

describe('play session card', () => {
  const session = { id: 's1', startedAt: '2026-10-27T17:00:00Z', endedAt: '2026-10-27T19:00:00Z' };
  const base: SessionMatchIn = {
    status: 'completed', winner_team: 'team1', player1_id: 'me', partner1_id: 'a', player2_id: 'b', partner2_id: 'c',
    play_session_id: null, created_at: '2026-10-27T18:00:00Z',
  };
  it('tallies my matches in the session window once', () => {
    const t = sessionTally([
      base,
      { ...base, winner_team: 'team2', play_session_id: 's1', created_at: '2026-10-28T18:00:00Z' },
      { ...base, play_session_id: 'other' },
      { ...base, created_at: '2026-10-27T22:00:00Z' },
      { ...base, status: 'pending' },
      { ...base, player1_id: 'x' },
    ], 'me', session);
    expect(t).toEqual({ games: 2, wins: 1, losses: 1, people: ['a', 'b', 'c'] });
  });
  it('reads the length big and hides empty stats', () => {
    const m = sessionCardModel({ court: 'Lakeside', kindLabel: 'Open play', date: 'Today', minutes: 115, mix: [], games: 0, wins: null, losses: null, people: [] });
    expect(m.hero.big).toBe('1 h 55 min');
    expect(m.hero.small).toBe('on the court');
    expect(shareDetailOptions(m).map((o) => o.id)).toEqual(['type', 'court', 'date']);
    expect(m.stats.find((s) => s.id === 'type')?.value).toBe('Open play');
    expect(shareDefaultDetails(m)).toEqual({ type: true, court: false, date: true });
    expect(m.showsScores).toBe(false);
  });
  it('says the type of play from the windows, games and record', () => {
    const m = sessionCardModel({
      court: null, kindLabel: 'Open play', date: 'Oct 27', minutes: 105,
      mix: [{ mode: 'open', minutes: 30 }, { mode: 'closed', minutes: 75 }],
      games: 5, wins: 3, losses: 2, people: [],
    });
    expect(m.title).toBe('Pickleball');
    expect(m.hero.small).toBe('on the court, 5 games');
    expect(m.stats.map((s) => s.value)).toEqual(['30 min open play, 1 h 15 min closed group', '5 games', 'Record 3-2', 'Oct 27']);
  });
  it('starts the type chip off when the title already says it (no court, one mode)', () => {
    const m = sessionCardModel({ court: null, kindLabel: 'Open play', date: 'Today', minutes: 38, mix: [], games: 0, wins: null, losses: null, people: [] });
    expect(m.title).toBe('Open play');
    expect(shareDefaultDetails(m)).toEqual({ type: false, date: true });
  });
});

describe('event card', () => {
  it('counts who came', () => {
    expect(eventCardModel({ title: 'Ladder night', league: null, court: null, date: 'Sat, Oct 25', count: 12 }).hero.big).toBe('12');
    expect(eventCardModel({ title: 'Ladder night', league: null, court: null, date: 'Sat, Oct 25', count: 0 }).hero.big).toBe('I was there');
  });
});

describe('bracket card', () => {
  it('PKL-062: a doubles path row is just the short names, no round or tournament title', () => {
    const name = (id: string) => ({ name: ({ p: 'QA 2', a: 'QA 3', b: 'QA 8' } as Record<string, string>)[id] ?? id, initials: '?' });
    const steps = bracketSteps([{ id: 'd', status: 'completed', winner_team: 'team1', team1_player1: 'me', team1_player2: 'p',
      team2_player1: 'a', team2_player2: 'b', team1_score: 11, team2_score: 4, round: { label: 'Rotating Partners Schedule', round_number: 1 } }], 'me', name);
    const row = bracketCardModel({ title: 'R7', rank: null, of: null, wins: 1, losses: 0, steps }).rows[0].items[0];
    expect(row.text).toBe('w/ QA 2 v QA 3 & QA 8');
    expect(row.text).not.toMatch(/Rotating|Schedule|R7/);
    expect(row.wrap).toBe(true);
  });

  const mk = (over: Partial<BracketMatchIn>): BracketMatchIn => ({
    id: 'm', status: 'completed', winner_team: 'team1', team1_player1: 'me', team1_player2: null,
    team2_player1: 'o', team2_player2: null, team1_score: 11, team2_score: 5, round: { label: 'Pool A', round_number: 1 }, ...over,
  });
  it('walks my completed matches in round order, my score first', () => {
    const steps = bracketSteps([
      mk({ id: '2', round: { label: 'Final', round_number: 3 }, winner_team: 'team1', team1_player1: 'o', team2_player1: 'me', team1_score: 11, team2_score: 9 }),
      mk({ id: '1' }),
      mk({ id: '3', status: 'scheduled' }),
      mk({ id: '4', team1_player1: 'x' }),
    ], 'me', () => pat);
    expect(steps).toEqual([
      { round: 'Pool A', won: true, score: '11–5', partner: null, opponents: [pat] },
      { round: 'Final', won: false, score: '9–11', partner: null, opponents: [pat] },
    ]);
    const m = bracketCardModel({ title: 'Fall Open', rank: 2, of: 8, wins: 1, losses: 1, steps });
    expect(m.hero.big).toBe('2nd place');
    expect(m.showsScores).toBe(true);
    expect(m.rows[0].items[1]).toEqual({ lead: { won: false }, text: 'v Pat D.', trailing: '9–11', wrap: true });
  });
});

describe('bracket overview (PKL-063, PKL-065): right at any point of the tournament', () => {
  const R = [
    { id: 'pa', label: 'Pool A', round_type: 'pool', round_number: 1 },
    { id: 'pb', label: 'Pool B', round_type: 'pool', round_number: 2 },
    { id: 'sf', label: 'Semifinals', round_type: 'semifinals', round_number: 1000 },
    { id: 'f', label: 'Finals', round_type: 'finals', round_number: 1100 },
    { id: 'tp', label: 'Third Place Match', round_type: 'third_place_match', round_number: 1150 },
  ];
  const m = (id: string, round_id: string, t1: [string, string], t2: [string, string], s1: number | null, s2: number | null) => ({
    id, round_id, status: s1 == null ? 'scheduled' : 'completed',
    winner_team: s1 == null ? null : (s1 > (s2 ?? 0) ? 'team1' : 'team2') as 'team1' | 'team2' | null,
    team1_player1: t1[0], team1_player2: t1[1], team2_player1: t2[0], team2_player2: t2[1], team1_score: s1, team2_score: s2,
  });
  const expected = ['Semifinals', 'Finals', 'Third Place Match'];
  // Pool A: me+p, a+b, g+h. Pool B: c+d, e+f.
  const pools = (s: (number | null)[]) => [
    m('1', 'pa', ['me', 'p'], ['a', 'b'], s[0], s[0] == null ? null : 7),
    m('2', 'pa', ['me', 'p'], ['g', 'h'], s[1], s[1] == null ? null : 9),
    m('3', 'pa', ['a', 'b'], ['g', 'h'], s[2], s[2] == null ? null : 5),
    m('4', 'pb', ['c', 'd'], ['e', 'f'], s[3], s[3] == null ? null : 3),
  ];

  it('just drawn: nothing scored, every stage named, the playoff still to play', () => {
    const ov = bracketOverview(R, pools([null, null, null, null]), 'me', { groupLabel: 'Pool play', expected });
    expect(ov.stages).toEqual([
      { label: 'Pool play', state: 'now', mine: 'in', note: '0-0', sub: '0 of 2 played · 2 to go' },
      { label: 'Semifinals', state: 'next', mine: null, note: 'still to play', sub: null },
      { label: 'Third Place Match', state: 'next', mine: null, note: 'still to play', sub: null },
      { label: 'Finals', state: 'next', mine: null, note: 'still to play', sub: null },
    ]);
    expect(ov.here).toBe(0);
  });

  it('mid-pools: W-L, the standing now, played / to go', () => {
    const ov = bracketOverview(R, pools([11, null, 11, 11]), 'me', { groupLabel: 'Pool play', expected });
    expect(ov.stages[0]).toEqual({ label: 'Pool play', state: 'now', mine: 'in', note: '1-0 · 1st now', sub: '1 of 2 played · 1 to go' });
    expect(ov.stages.slice(1).every((x) => x.state === 'next')).toBe(true);
  });

  it('mid-playoff: pools done with my place, my semifinal won, the final being played', () => {
    const ms = [...pools([11, 11, 11, 11]),
      m('5', 'sf', ['me', 'p'], ['e', 'f'], 11, 8), m('6', 'sf', ['c', 'd'], ['a', 'b'], 11, 4),
      m('7', 'f', ['me', 'p'], ['c', 'd'], null, null)];
    const ov = bracketOverview(R, ms, 'me', { groupLabel: 'Pool play', expected });
    expect(ov.stages.map((x) => [x.label, x.state, x.mine, x.note])).toEqual([
      ['Pool play', 'done', null, '2-0 · 1st in Pool A'],
      ['Semifinals', 'done', 'won', 'W 11–8'],
      ['Third Place Match', 'next', null, 'still to play'],
      ['Finals', 'now', 'in', 'Playing'],
    ]);
    expect(ov.here).toBe(3);
  });

  it('finished: every stage done, the final place last', () => {
    const ms = [...pools([11, 11, 11, 11]),
      m('5', 'sf', ['me', 'p'], ['e', 'f'], 11, 8), m('6', 'sf', ['c', 'd'], ['a', 'b'], 11, 4),
      m('7', 'f', ['me', 'p'], ['c', 'd'], 9, 11), m('8', 'tp', ['e', 'f'], ['a', 'b'], 11, 6)];
    const ov = bracketOverview(R, ms, 'me', { groupLabel: 'Pool play', expected, final: { rank: 2, of: 4 } });
    expect(ov.stages.map((x) => [x.label, x.state, x.note])).toEqual([
      ['Pool play', 'done', '2-0 · 1st in Pool A'],
      ['Semifinals', 'done', 'W 11–8'],
      ['Third Place Match', 'done', null],
      ['Finals', 'done', 'L 9–11'],
      ['Final place', 'done', '2nd of 4'],
    ]);
    expect(ov.stages[3].mine).toBe('lost');
    expect(ov.here).toBe(3);
  });

  it('rotating partners mid-run: per-player standing, played / to go, an unknown playoff as one stage', () => {
    const ms = [
      { ...m('1', 'w', ['me', 'p'], ['a', 'b'], 11, 4), play_round: 1 },
      { ...m('2', 'w', ['me', 'a'], ['p', 'b'], null, null), play_round: 2 },
    ];
    const ov = bracketOverview([{ id: 'w', label: 'Rotating Partners Schedule', round_type: 'winners', round_number: 1 }], ms, 'me',
      { groupLabel: 'Rotating partners', perPlayer: true, playoffAhead: true });
    expect(ov.stages).toEqual([
      { label: 'Rotating partners', state: 'now', mine: 'in', note: '1-0 · T-1st now', sub: '1 of 2 played · 1 to go' },
      { label: 'Playoff', state: 'next', mine: null, note: 'still to play', sub: null },
    ]);
    expect(ov.here).toBe(0);
  });

  it('the Bracket layout is offered for bracket cards only', () => {
    expect(shareTemplatesFor(0, 'bracket')).toContain('overview');
    expect(shareTemplatesFor(0, 'match')).not.toContain('overview');
  });
});
