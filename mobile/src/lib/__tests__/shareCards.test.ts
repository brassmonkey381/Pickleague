import { describe, expect, it } from 'vitest';
import {
  SCORE_DISCLAIMER,
  SHARE_BANNER_DEFAULT,
  SHARE_LOOK_IDS,
  SHARE_LOOKS,
  bannerColors,
  bracketCardModel,
  bracketSteps,
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
    expect(m.hero.small).toBe('on the court · 5 games');
    expect(m.stats.map((s) => s.value)).toEqual(['30 min open play · 1 h 15 min closed group', '5 games', 'Record 3-2', 'Oct 27']);
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
      { round: 'Pool A', won: true, score: '11–5', opponents: [pat] },
      { round: 'Final', won: false, score: '9–11', opponents: [pat] },
    ]);
    const m = bracketCardModel({ title: 'Fall Open', rank: 2, of: 8, wins: 1, losses: 1, steps });
    expect(m.hero.big).toBe('2nd place');
    expect(m.showsScores).toBe(true);
    expect(m.rows[0].items[1]).toEqual({ lead: { won: false }, text: 'Final · vs Pat D.', trailing: '9–11' });
  });
});
