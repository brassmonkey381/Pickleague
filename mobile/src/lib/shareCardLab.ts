// Godmode › Share card lab (PKL-013): every share card with made-up data, the
// edge cases included (very long names, no games, no court, a champion, a
// loss), so the studio can be checked on a phone without real matches. Pure:
// the lab screen opens PickleShareStudio on these, and a test runs each
// through the model helpers.
import {
  bracketCardModel,
  drillCardModel,
  eventCardModel,
  finishCardModel,
  groupCardModel,
  matchCardModel,
  sessionCardModel,
  type ShareCardModel,
} from './shareCards';

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
          { round: 'Pool A · Round 1', won: true, score: '11–4', opponents: [sam, lee] },
          { round: 'Pool A · Round 2', won: false, score: '8–11', opponents: [kim, anon] },
          { round: 'Pool A · Round 3', won: true, score: '11–9', opponents: [longName] },
          { round: 'Quarterfinal', won: true, score: '11–6', opponents: [pat, sam] },
          { round: 'Semifinal', won: true, score: '15–13', opponents: [lee, kim] },
          { round: 'Final', won: false, score: '9–11', opponents: [sam, pat] },
        ],
      }),
    },
  ];
}
