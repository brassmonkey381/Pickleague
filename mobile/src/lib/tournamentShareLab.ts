// PKL-092: made-up tournaments for Godmode's Share card lab, one per edge case the item names: MLP after pool play and
// at the finish, very long team and tournament names, no photo (Team photo falls back to the pattern), lost in the
// semis (a shared 3rd), didn't make the playoff, and a doubles pool play event built from raw rows by storyInputFrom.
import { buildTournamentStory, storyInputFrom, type StoryInput, type StoryMatchup, type TournamentStory } from './tournamentShare';

const P = (name: string) => ({ name, initials: name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() });
const people = (...n: string[]) => n.map(P);
const team = (key: string, name: string, ps = people('Maya R.', 'Jordan L.', 'Priya N.', 'Theo K.')) => ({ key, name, people: ps });
const mu = (stage: StoryMatchup['stage'], a: string, b: string, aS: number | null, bS: number | null, db?: [number, number]): StoryMatchup =>
  ({ stage, a, b, aScore: aS, bScore: bS, winner: aS == null || bS == null ? null : aS > bS ? 'a' : 'b', dreambreaker: db ?? null,
    aPoints: (aS ?? 0) * 11 + (bS ?? 0) * 6, bPoints: (bS ?? 0) * 11 + (aS ?? 0) * 6 });

const LONG_TEAM = 'The Extraordinarily Persistent Kitchen Dwellers of Alameda';
const LONG_TITLE = 'The Very Long Annual Bay Area Mixed Doubles Charity Classic Invitational';

function mlp(long: boolean): StoryInput {
  const tsc = long ? LONG_TEAM : 'Third Shot Club';
  return {
    title: long ? LONG_TITLE : 'Saturday Smash MLP', dateLabel: 'Sat Nov 28', isMlp: true, me: 'TSC',
    entrants: [team('TSC', tsc), team('DD', 'Dink Dynasty'), team('EE', 'Erne Express'), team('KK', 'Kitchen Kings'), team('LC', 'Lob City'), team('PB', 'Paddle Battle')],
    poolLabel: 'Pool A', poolPlace: 1,
    matchups: [mu('pool', 'TSC', 'DD', 3, 1), mu('pool', 'TSC', 'EE', 3, 0), mu('pool', 'DD', 'EE', 1, 3),
      mu('pool', 'KK', 'LC', 3, 2), mu('pool', 'KK', 'PB', 3, 1), mu('pool', 'LC', 'PB', 3, 0),
      mu('semifinals', 'TSC', 'LC', null, null), mu('semifinals', 'KK', 'EE', null, null)],
    hasPlayoff: true, completed: false, finalPlace: null, podium: [],
  };
}
function finished(i: StoryInput, me: string, place: number, poolPlace: number): StoryInput {
  return {
    ...i, me, poolPlace, completed: true, finalPlace: place,
    matchups: [...i.matchups.filter((m) => m.stage === 'pool'),
      mu('semifinals', 'TSC', 'LC', 3, 1), mu('semifinals', 'KK', 'EE', 3, 2, [21, 17]), mu('finals', 'TSC', 'KK', 3, 2, [21, 19])],
    podium: [{ place: 1, keys: ['TSC'] }, { place: 2, keys: ['KK'] }, { place: 3, keys: ['LC', 'EE'] }, { place: 5, keys: ['DD'] }, { place: 6, keys: ['PB'] }],
  };
}

/** Doubles pool play from raw rounds and matches, through storyInputFrom (the screen's path). */
function doublesRaw(): StoryInput {
  const rounds = [
    { id: 'pa', round_type: 'pool', round_number: 1 }, { id: 'pb', round_type: 'pool', round_number: 2 },
    { id: 'sf', round_type: 'semifinals', round_number: 1000 },
  ];
  let n = 0;
  const m = (round_id: string, t1: [string, string], t2: [string, string], s1: number | null, s2: number | null) => ({
    id: `m${++n}`, round_id, status: s1 == null ? 'pending' : 'completed',
    winner_team: (s1 == null || s2 == null ? null : s1 > s2 ? 'team1' : 'team2') as 'team1' | 'team2' | null,
    team1_player1: t1[0], team1_player2: t1[1], team2_player1: t2[0], team2_player2: t2[1], team1_score: s1, team2_score: s2,
  });
  const names: Record<string, string> = { me: 'Brian S.', p: 'Pat D.', a: 'Sam L.', b: 'Lee K.', c: 'Kim R.', d: 'Ana P.', e: 'Ben Q.', f: 'Cal T.', g: 'Dee W.', h: 'Eve M.' };
  return storyInputFrom({
    title: 'Fall Open Doubles', dateLabel: 'Sun Nov 29', format: 'pool_play', hasPlayoff: true, completed: false, myUserId: 'me',
    rounds, matches: [
      m('pa', ['me', 'p'], ['a', 'b'], 11, 7), m('pa', ['me', 'p'], ['g', 'h'], 9, 11), m('pa', ['a', 'b'], ['g', 'h'], 11, 5),
      m('pb', ['c', 'd'], ['e', 'f'], 11, 3),
      m('sf', ['me', 'p'], ['c', 'd'], null, null), m('sf', ['a', 'b'], ['e', 'f'], null, null),
    ],
    player: (id) => P(names[id] ?? 'a player'),
    poolLabel: 'Pool A', poolPlace: 2, finalRanks: [],
  });
}

export type LabStory = { id: string; label: string; story: TournamentStory };

export function labStories(): LabStory[] {
  const base = mlp(false);
  const all: [string, string, StoryInput][] = [
    ['story-mlp-pool', 'MLP after pool play, won Pool A', base],
    ['story-mlp-champ', 'MLP finish, champions (Final 3-2, Dreambreaker)', finished(base, 'TSC', 1, 1)],
    ['story-mlp-semis', 'MLP finish, lost in the semis (shared 3rd)', finished(base, 'LC', 3, 2)],
    ['story-mlp-out', "MLP finish, didn't make the playoff", finished(base, 'PB', 6, 3)],
    ['story-mlp-out-pool', "MLP after pool play, didn't make the playoff", { ...base, me: 'DD', poolPlace: 3 }],
    ['story-long', 'Very long team and tournament names', finished(mlp(true), 'TSC', 1, 1)],
    ['story-doubles', 'Doubles pool play, 2nd in Pool A (raw rows)', doublesRaw()],
  ];
  return all.flatMap(([id, label, input]) => {
    const story = buildTournamentStory(input);
    return story ? [{ id, label, story }] : [];
  });
}
