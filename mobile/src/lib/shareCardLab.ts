// Godmode › Share card lab (PKL-013): every share card with made-up data, the
// edge cases included (very long names, no games, no court, a champion, a
// loss), so the studio can be checked on a phone without real matches. Pure:
// the lab screen opens PickleShareStudio on these, and a test runs each
// through the model helpers.
import {
  bracketCardModel,
  bracketOverview,
  drillCardModel,
  eventCardModel,
  finishCardModel,
  groupCardModel,
  matchCardModel,
  sessionCardModel,
  type ShareCardModel,
} from './shareCards';
import { labTournaments } from './tournamentSlidesLab';

const pat = { name: 'Pat D.', initials: 'PD' };
const sam = { name: 'Sam L.', initials: 'SL' };
const lee = { name: 'Lee K.', initials: 'LK' };
const kim = { name: 'Kim R.', initials: 'KR' };
const longName = { name: 'Maximiliana-Josephine V.', initials: 'MV' };
const anon = { name: 'a player', initials: '?' };

export type LabSample = { id: string; group: string; label: string; title: string; model: ShareCardModel };

/** Photos for the "with 4 photos" switch (stock court shots; the lab only). */
export const LAB_PHOTOS: string[] = [
  'https://picsum.photos/seed/pickleague-court-1/900/1100',
  'https://picsum.photos/seed/pickleague-court-2/900/1100',
  'https://picsum.photos/seed/pickleague-court-3/900/1100',
  'https://picsum.photos/seed/pickleague-court-4/900/1100',
];

const weeks = [0, 45, 60, 0, 90, 75, 120, 95];

export function labSamples(): LabSample[] {
  return [
    {
      id: 'finish-champ', group: 'Finish', label: 'Season champion', title: 'Share your finish',
      model: finishCardModel({
        kind: 'season', title: 'Fall 2026', league: 'Alameda Evening League', rank: 1, of: 24, wins: 18, losses: 3, me: 'Brian S.',
        podium: [{ rank: 1, players: [{ name: 'Brian S.', initials: 'BS' }] }, { rank: 2, players: [pat] }, { rank: 3, players: [sam, lee] }],
      }),
    },
    {
      id: 'finish-long', group: 'Finish', label: '7th of 32, long names', title: 'Share your finish',
      model: finishCardModel({
        kind: 'tournament', title: 'The Very Long Annual Bay Area Mixed Doubles Charity Classic Invitational', league: null,
        rank: 7, of: 32, wins: null, losses: null, me: 'Maximiliana-Josephine V.', podium: [],
      }),
    },
    {
      id: 'match-win', group: 'Match', label: 'Doubles win, PLUPR up', title: 'Share this match',
      model: matchCardModel({
        doubles: true, won: true, myScore: 11, oppScore: 7, me: 'Brian S.', partner: pat, opponents: [sam, lee],
        pluprDelta: 0.12, court: 'Lakeside Park', date: 'Oct 27', scope: 'Alameda Evening League',
      }),
    },
    {
      id: 'match-loss-long', group: 'Match', label: 'Singles loss, long names, no court', title: 'Share this match',
      model: matchCardModel({
        doubles: false, won: false, myScore: 9, oppScore: 11, me: 'Brian S.', partner: null, opponents: [longName],
        pluprDelta: -0.08, court: null, date: 'Oct 12, 2025', scope: null,
      }),
    },
    {
      id: 'session-mixed', group: 'Session', label: 'Open + closed, 7 games', title: 'Share this session',
      model: sessionCardModel({
        court: 'Lakeside Park', kindLabel: 'Open play', date: 'Today', minutes: 125,
        mix: [{ mode: 'closed', minutes: 45 }, { mode: 'open', minutes: 80 }],
        games: 7, wins: 5, losses: 2, people: [pat, sam, lee, kim, longName, anon],
      }),
    },
    {
      id: 'session-empty', group: 'Session', label: 'No games, no court', title: 'Share this session',
      model: sessionCardModel({ court: null, kindLabel: 'Open play', date: 'Yesterday', minutes: 38, mix: [], games: 0, wins: null, losses: null, people: [] }),
    },
    {
      id: 'drill-full', group: 'Drill', label: 'Drill: review, focus, streak', title: 'Share your drill',
      model: drillCardModel({
        partner: pat, court: 'Lakeside Park', date: 'Today', minutes: 95,
        focus: ['Third-shot drops', 'Kitchen-line volleys', 'Resets', 'Footwork & movement', 'Serves'],
        review: {
          rating: 4,
          facets: [
            { label: 'Consistency', stars: 4 }, { label: 'Effort', stars: 5 }, { label: 'Organization', stars: 3 },
            { label: 'Intentionality', stars: 4 }, { label: 'Fun', stars: 5 },
          ],
          notes: 'Drops were landing by the end. Need to stay lower on resets and stop popping the ball up when they speed it up at my feet.',
        },
        stats: { monthCount: 6, monthMinutes: 540, weeks, weekStreak: 4 },
      }),
    },
    {
      id: 'drill-bare', group: 'Drill', label: 'Drill: no timer, no review', title: 'Share your drill',
      model: drillCardModel({
        partner: longName, court: null, date: 'Oct 3', minutes: null, focus: [], review: null,
        stats: { monthCount: 0, monthMinutes: 0, weeks: [0, 0, 0, 0, 0, 0, 0, 0], weekStreak: 0 },
      }),
    },
    {
      id: 'event', group: 'Event', label: 'Event, 18 came', title: 'Share this event',
      model: eventCardModel({ title: 'Saturday Round Robin', league: 'Alameda Evening League', court: 'Lakeside Park', date: 'Sat, Oct 25', count: 18 }),
    },
    {
      id: 'event-empty', group: 'Event', label: 'Event, long title, no count', title: 'Share this event',
      model: eventCardModel({ title: 'Beginner-Friendly Thursday Night Under-the-Lights Social and Clinic', league: null, court: null, date: 'Thu, Oct 30', count: 0 }),
    },
    {
      id: 'group-big', group: 'Group', label: 'Group session, 14 played', title: 'Share the group session',
      model: groupCardModel({
        title: 'Saturday Round Robin', over: 'Alameda Evening League', court: 'Lakeside Park', date: 'Today', myMinutes: 135,
        people: [{ name: 'Brian S.', initials: 'BS' }, pat, sam, lee, kim, longName, anon,
          { name: 'Ana P.', initials: 'AP' }, { name: 'Raj T.', initials: 'RT' }, { name: 'Jo W.', initials: 'JW' },
          { name: 'Mo F.', initials: 'MF' }, { name: 'Lu C.', initials: 'LC' }, { name: 'Bo H.', initials: 'BH' }, { name: 'Cy N.', initials: 'CN' }],
      }),
    },
    {
      id: 'group-small', group: 'Group', label: 'Group session, just me, long title', title: 'Share the group session',
      model: groupCardModel({
        title: 'The Very Long Annual Bay Area Mixed Doubles Charity Classic Invitational', over: 'Tournament', court: null,
        date: 'Sat, Oct 25', myMinutes: 52, people: [longName],
      }),
    },
    {
      id: 'bracket', group: 'Bracket', label: 'Bracket, 6 rounds', title: 'Share my bracket',
      model: bracketCardModel({
        title: 'Summer Smash MLP', rank: 2, of: 16, wins: 5, losses: 2,
        steps: [
          { round: 'Pool A, Round 1', won: true, score: '11–4', partner: kim, opponents: [sam, lee] },
          { round: 'Pool A, Round 2', won: false, score: '8–11', opponents: [kim, anon] },
          { round: 'Pool A, Round 3', won: true, score: '11–9', opponents: [longName] },
          { round: 'Quarterfinal', won: true, score: '11–6', opponents: [pat, sam] },
          { round: 'Semifinal', won: true, score: '15–13', partner: longName, opponents: [lee, kim] },
          { round: 'Final', won: false, score: '9–11', opponents: [sam, pat] },
        ],
        // PKL-063: the "Bracket" layout
        overview: {
          stages: [
            { label: 'Pool play', state: 'done', mine: null, note: '3-1, 1st in Pool A' },
            { label: 'Quarterfinals', state: 'done', mine: 'won', note: 'W 11–6' },
            { label: 'Semifinals', state: 'done', mine: 'won', note: 'W 15–13' },
            { label: 'Finals', state: 'done', mine: 'lost', note: 'L 9–11' },
            { label: 'Final place', state: 'done', mine: null, note: '2nd of 16' },
          ],
          here: 3,
        },
      }),
    },
    // PKL-065: the Bracket layout at each point of a pool play tournament (built by the real bracketOverview)
    ...labStages().map(([id, label, ov, rec]) => ({
      id, group: 'Bracket', label, title: 'Share my bracket',
      model: bracketCardModel({ title: 'Fall Open (pools + playoff)', rank: null, of: null, wins: rec[0], losses: rec[1], steps: [], overview: ov }),
    })),
    // PKL-070: the whole tournament as 1-3 slides (the 'Slide N' layouts), built by the real builders
    ...labTournaments().map((t) => ({
      id: `slides-${t.id}`, group: 'Slides', label: t.label, title: 'Share my bracket',
      model: bracketCardModel({ title: t.input.title, rank: t.rank, of: t.of, wins: t.wins, losses: t.losses, steps: [], slides: t.slides }),
    })),
  ];
}

/** PKL-065: one pool play tournament (2 pools, top 2 per pool, third place) at three points, for the Bracket layout. */
function labStages(): [string, string, ReturnType<typeof bracketOverview>, [number, number]][] {
  const R = [
    { id: 'pa', label: 'Pool A', round_type: 'pool', round_number: 1 },
    { id: 'pb', label: 'Pool B', round_type: 'pool', round_number: 2 },
    { id: 'sf', label: 'Semifinals', round_type: 'semifinals', round_number: 1000 },
    { id: 'f', label: 'Finals', round_type: 'finals', round_number: 1100 },
  ];
  const m = (id: string, round_id: string, t1: [string, string], t2: [string, string], s1: number | null, s2: number | null) => ({
    id, round_id, status: s1 == null ? 'scheduled' : 'completed',
    winner_team: (s1 == null ? null : s1 > (s2 ?? 0) ? 'team1' : 'team2') as 'team1' | 'team2' | null,
    team1_player1: t1[0], team1_player2: t1[1], team2_player1: t2[0], team2_player2: t2[1], team1_score: s1, team2_score: s2,
  });
  const pools = (s: (number | null)[]) => [
    m('1', 'pa', ['me', 'p'], ['a', 'b'], s[0], s[0] == null ? null : 7),
    m('2', 'pa', ['me', 'p'], ['g', 'h'], s[1], s[1] == null ? null : 9),
    m('3', 'pa', ['me', 'p'], ['i', 'j'], s[2], s[2] == null ? null : 4),
    m('4', 'pa', ['a', 'b'], ['g', 'h'], s[3], s[3] == null ? null : 5),
    m('5', 'pb', ['c', 'd'], ['e', 'f'], s[4], s[4] == null ? null : 3),
  ];
  const expected = ['Semifinals', 'Finals', 'Third Place Match'];
  const o = { groupLabel: 'Pool play', expected };
  return [
    ['bracket-drawn', 'Bracket layout: just drawn', bracketOverview(R, pools([null, null, null, null, null]), 'me', o), [0, 0]],
    ['bracket-midpools', 'Bracket layout: mid-pools', bracketOverview(R, pools([11, 8, null, 11, 11]), 'me', o), [1, 1]],
    ['bracket-midplayoff', 'Bracket layout: mid-playoff', bracketOverview(R, [...pools([11, 11, 11, 11, 11]),
      m('6', 'sf', ['me', 'p'], ['e', 'f'], 11, 8), m('7', 'sf', ['c', 'd'], ['a', 'b'], null, null)], 'me', o), [4, 0]],
  ];
}
