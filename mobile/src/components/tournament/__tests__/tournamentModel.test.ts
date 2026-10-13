import { describe, it, expect } from 'vitest';
import {
  youCardKind, setupSteps, currentSetupStep, filterSchedule, nextMatchFor, canRecordMatch,
  roundStage, hasBothStages, doublesPairingDone, mlpTeamsDone, mlpTeamOf, doublesPartnerOf,
  statusPill, playoffLabel, ordinal, opponentsOf, partnerOf, isScheduleFiltered,
  EMPTY_SCHEDULE_FILTER, type YouCardInput, type ScheduleMatch,
} from '../tournamentModel';
import { buildStandings, myStanding } from '../standingsData';

// ── The You card: every row of the plan's status x role table ───────────────

const base: YouCardInput = {
  status: 'registration',
  isPriv: false,
  myReg: null,
  canRegister: false,
  inviteOnly: false,
  regClosed: false,
  inSchedule: false,
  hasNextMatch: false,
  hasFinalRanks: false,
};

describe('youCardKind', () => {
  it('registration x spectator who can register: join', () => {
    expect(youCardKind({ ...base, canRegister: true })).toBe('join');
  });
  it('registration x spectator, invite-only: a note', () => {
    expect(youCardKind({ ...base, inviteOnly: true })).toBe('invite_only');
  });
  it('registration x spectator after the deadline: closed', () => {
    expect(youCardKind({ ...base, regClosed: true })).toBe('closed');
  });
  it('registration x invitee: Accept / Decline', () => {
    expect(youCardKind({ ...base, myReg: { status: 'pending', invited_by: 'org' } })).toBe('invited');
  });
  it('registration x requester / waitlisted / rejected: one status line each', () => {
    expect(youCardKind({ ...base, myReg: { status: 'pending', invited_by: null } })).toBe('requested');
    expect(youCardKind({ ...base, myReg: { status: 'waitlisted', invited_by: null } })).toBe('waitlisted');
    expect(youCardKind({ ...base, myReg: { status: 'rejected', invited_by: null } })).toBe('rejected');
  });
  it('registration x approved: you are in', () => {
    expect(youCardKind({ ...base, myReg: { status: 'approved', invited_by: null } })).toBe('approved');
  });
  it('registration x admin or co-admin: the setup step wins over their own registration', () => {
    expect(youCardKind({ ...base, isPriv: true, myReg: { status: 'approved', invited_by: null } })).toBe('setup');
  });
  it('active x player: next match, or "playing" when nothing is playable', () => {
    expect(youCardKind({ ...base, status: 'active', inSchedule: true, hasNextMatch: true })).toBe('next_match');
    expect(youCardKind({ ...base, status: 'active', inSchedule: true })).toBe('playing');
    expect(youCardKind({ ...base, status: 'active', myReg: { status: 'approved', invited_by: null } })).toBe('playing');
  });
  it('active x spectator (and a non-playing organizer): no card', () => {
    expect(youCardKind({ ...base, status: 'active' })).toBe('none');
    expect(youCardKind({ ...base, status: 'active', isPriv: true })).toBe('none');
    expect(youCardKind({ ...base, status: 'active', myReg: { status: 'rejected', invited_by: null } })).toBe('none');
  });
  it('active x leftover invite / request / waitlist: still answerable or visible after lock-in', () => {
    expect(youCardKind({ ...base, status: 'active', myReg: { status: 'pending', invited_by: 'org' } })).toBe('invited');
    expect(youCardKind({ ...base, status: 'active', myReg: { status: 'pending', invited_by: null } })).toBe('requested');
    expect(youCardKind({ ...base, status: 'active', myReg: { status: 'waitlisted', invited_by: null } })).toBe('waitlisted');
  });
  it('completed x anyone: finished once settled ranks exist', () => {
    expect(youCardKind({ ...base, status: 'completed', hasFinalRanks: true })).toBe('finished');
    expect(youCardKind({ ...base, status: 'completed', hasFinalRanks: false })).toBe('none');
  });
  it('cancelled: no card, whoever is looking', () => {
    expect(youCardKind({ ...base, status: 'cancelled', isPriv: true, hasFinalRanks: true })).toBe('none');
  });
});

// ── Setup checklist ─────────────────────────────────────────────────────────

describe('setupSteps', () => {
  it('lists the plan order, with Pair teams only when pairing is needed', () => {
    const withPairs = setupSteps({ pendingRequests: 3, releaseSet: false, needsPairing: true, pairingDone: false, previewReady: false });
    expect(withPairs.map(s => s.key)).toEqual(['approve', 'release', 'pair', 'generate', 'lock']);
    expect(withPairs[0].label).toBe('Approve 3 requests');
    const singles = setupSteps({ pendingRequests: 0, releaseSet: true, needsPairing: false, pairingDone: false, previewReady: false });
    expect(singles.map(s => s.key)).toEqual(['approve', 'release', 'generate', 'lock']);
  });
  it('the current step is the first one not done ("Setup 1 of 5 · Approve 3 requests")', () => {
    const s1 = setupSteps({ pendingRequests: 3, releaseSet: false, needsPairing: true, pairingDone: false, previewReady: false });
    expect(currentSetupStep(s1)).toMatchObject({ index: 0, step: { key: 'approve' } });
    const s2 = setupSteps({ pendingRequests: 0, releaseSet: true, needsPairing: false, pairingDone: false, previewReady: true });
    expect(currentSetupStep(s2)).toMatchObject({ index: 3, step: { key: 'lock' } });
  });
  it('the optional release time never holds the checklist once a preview exists', () => {
    const ready = setupSteps({ pendingRequests: 0, releaseSet: false, needsPairing: false, pairingDone: false, previewReady: true });
    expect(currentSetupStep(ready)).toMatchObject({ index: 3, step: { key: 'lock' } });
    const doubles = setupSteps({ pendingRequests: 0, releaseSet: false, needsPairing: true, pairingDone: true, previewReady: true });
    expect(currentSetupStep(doubles)).toMatchObject({ index: 4, step: { key: 'lock' } });
    // Before the preview it still prompts for it.
    const early = setupSteps({ pendingRequests: 0, releaseSet: false, needsPairing: false, pairingDone: false, previewReady: false });
    expect(currentSetupStep(early)).toMatchObject({ index: 1, step: { key: 'release' } });
  });
});

describe('pairing', () => {
  it('doubles: every approved player in a complete pair, at least 2 pairs', () => {
    const pairs = [{ partner_1_id: 'a', partner_2_id: 'b' }, { partner_1_id: 'c', partner_2_id: 'd' }];
    expect(doublesPairingDone(['a', 'b', 'c', 'd'], pairs)).toBe(true);
    expect(doublesPairingDone(['a', 'b', 'c', 'd', 'e'], pairs)).toBe(false);
    expect(doublesPairingDone(['a', 'b'], [pairs[0]])).toBe(false);
    expect(doublesPartnerOf(pairs, 'c')).toEqual({ found: true, partnerId: 'd' });
    expect(doublesPartnerOf([{ partner_1_id: 'x', partner_2_id: null }], 'x')).toEqual({ found: true, partnerId: null });
    expect(doublesPartnerOf(pairs, 'z')).toEqual({ found: false, partnerId: null });
  });
  it('MLP: at least 2 teams, all four slots filled', () => {
    const full = (id: string, p: string) => ({ id, male_1_id: `${p}1`, male_2_id: `${p}2`, female_1_id: `${p}3`, female_2_id: `${p}4` });
    expect(mlpTeamsDone([full('t1', 'a'), full('t2', 'b')])).toBe(true);
    expect(mlpTeamsDone([full('t1', 'a'), { ...full('t2', 'b'), female_2_id: null }])).toBe(false);
    expect(mlpTeamsDone([full('t1', 'a')])).toBe(false);
    expect(mlpTeamOf([full('t1', 'a'), full('t2', 'b')], 'b3')?.id).toBe('t2');
  });
});

// ── Schedule ────────────────────────────────────────────────────────────────

const R = {
  poolA: { id: 'rA', label: 'Pool A', round_type: 'pool', round_number: 1 },
  poolB: { id: 'rB', label: 'Pool B', round_type: 'pool', round_number: 2 },
  semis: { id: 'rS', label: 'Semifinals', round_type: 'semifinals', round_number: 3 },
};
function sm(id: string, round: ScheduleMatch['round'], t1: string[], t2: string[], done: boolean, order = 0): ScheduleMatch {
  return {
    id, round, match_order: order, match_type: t1.length > 1 ? 'doubles' : 'singles',
    status: done ? 'completed' : 'pending', winner_team: done ? 'team1' : null,
    team1_player1: t1[0] ?? null, team1_player2: t1[1] ?? null,
    team2_player1: t2[0] ?? null, team2_player2: t2[1] ?? null,
    team1_score: done ? 11 : null, team2_score: done ? 7 : null,
  };
}
const schedule: ScheduleMatch[] = [
  sm('m1', R.poolA, ['me'], ['a'], true, 0),
  sm('m2', R.poolA, ['b'], ['me'], false, 1),
  sm('m3', R.poolB, ['c'], ['d'], false, 2),
  sm('m4', R.semis, ['me'], ['c'], false, 3),
  { ...sm('m5', R.poolB, ['c'], ['d'], false, 4), is_dreambreaker: true, status: 'cancelled' },
];

describe('filterSchedule', () => {
  const ctx = { myUserId: 'me', format: 'pool_play' };
  it('no filter: everything but a cancelled dreambreaker', () => {
    expect(filterSchedule(schedule, EMPTY_SCHEDULE_FILTER, ctx).map(m => m.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(isScheduleFiltered(EMPTY_SCHEDULE_FILTER)).toBe(false);
  });
  it('Mine, To play and Done AND together', () => {
    expect(filterSchedule(schedule, { ...EMPTY_SCHEDULE_FILTER, mine: true }, ctx).map(m => m.id)).toEqual(['m1', 'm2', 'm4']);
    expect(filterSchedule(schedule, { ...EMPTY_SCHEDULE_FILTER, mine: true, play: 'to_play' }, ctx).map(m => m.id)).toEqual(['m2', 'm4']);
    expect(filterSchedule(schedule, { ...EMPTY_SCHEDULE_FILTER, play: 'done' }, ctx).map(m => m.id)).toEqual(['m1']);
  });
  it('stage chips and the Round pill', () => {
    expect(filterSchedule(schedule, { ...EMPTY_SCHEDULE_FILTER, stage: 'playoff' }, ctx).map(m => m.id)).toEqual(['m4']);
    expect(filterSchedule(schedule, { ...EMPTY_SCHEDULE_FILTER, stage: 'group' }, ctx).map(m => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(filterSchedule(schedule, { ...EMPTY_SCHEDULE_FILTER, roundId: 'rB' }, ctx).map(m => m.id)).toEqual(['m3']);
  });
  it('stage chips only mean something when both stages exist; elimination is all playoff', () => {
    expect(hasBothStages([R.poolA, R.semis], 'pool_play')).toBe(true);
    expect(hasBothStages([R.poolA, R.poolB], 'pool_play')).toBe(false);
    expect(roundStage('winners', 'round_robin')).toBe('group');
    expect(roundStage('winners', 'single_elimination')).toBe('playoff');
    expect(hasBothStages([{ round_type: 'winners' }, { round_type: 'finals' }], 'double_elimination')).toBe(false);
  });
});

describe('next match and who may record', () => {
  it('the earliest playable match of mine, by round then order', () => {
    expect(nextMatchFor(schedule, 'me')?.id).toBe('m2');
    expect(nextMatchFor(schedule, 'nobody')).toBeNull();
    expect(nextMatchFor(schedule, null)).toBeNull();
  });
  it('opponents and partner', () => {
    const d = sm('d1', R.poolA, ['me', 'p'], ['x', 'y'], false);
    expect(opponentsOf(d, 'me')).toEqual(['x', 'y']);
    expect(partnerOf(d, 'me')).toBe('p');
    expect(opponentsOf(d, 'y')).toEqual(['me', 'p']);
  });
  it('a spectator gets no record tap; players and organizers do', () => {
    const m3 = schedule[2];
    expect(canRecordMatch(m3, { isPriv: false, myUserId: 'me' })).toBe(false);
    expect(canRecordMatch(m3, { isPriv: true, myUserId: 'me' })).toBe(true);
    expect(canRecordMatch(schedule[1], { isPriv: false, myUserId: 'me' })).toBe(true);
    // Completed rows are history for everyone.
    expect(canRecordMatch(schedule[0], { isPriv: true, myUserId: 'me' })).toBe(false);
  });
});

// ── Identity ────────────────────────────────────────────────────────────────

describe('identity helpers', () => {
  it('one status pill per status', () => {
    expect(statusPill({ status: 'registration', regClosed: false, isFull: false }).label).toBe('Registration open');
    expect(statusPill({ status: 'registration', regClosed: true, isFull: false }).label).toBe('Registration closed');
    expect(statusPill({ status: 'registration', regClosed: false, isFull: true }).label).toBe('Full · waitlist open');
    expect(statusPill({ status: 'active', regClosed: false, isFull: false }).label).toBe('In progress');
    expect(statusPill({ status: 'completed', regClosed: false, isFull: false }).label).toBe('Completed');
    expect(statusPill({ status: 'cancelled', regClosed: false, isFull: false }).tone).toBe('danger');
  });
  it('playoff label, never "no playoff" filler', () => {
    const t = { format: 'round_robin', mlp_play_format: 'round_robin', mlp_playoff_teams: 4, playoff_format: 'top_4', playoff_third_place: true } as any;
    expect(playoffLabel(t)).toBe('Playoff: top 4 + 3rd');
    expect(playoffLabel({ ...t, playoff_format: 'none' })).toBeNull();
    expect(playoffLabel({ ...t, format: 'single_elimination' })).toBeNull();
    expect(playoffLabel({ ...t, format: 'mlp', mlp_play_format: 'pool_play_playoff', mlp_playoff_teams: 2 })).toBe('Playoff: top 2');
  });
  it('ordinals', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 103].map(ordinal)).toEqual(
      ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '103rd']);
  });
});

// ── Standings for every format ──────────────────────────────────────────────

const reg = (user_id: string, seed: number | null = null) => ({
  id: `reg-${user_id}`, tournament_id: 't', user_id, status: 'approved', seed,
  registered_at: '2026-10-01T00:00:00Z', invited_by: null, role: 'member',
}) as any;
const names = { me: 'Me', a: 'Ann', b: 'Bo', c: 'Cy', d: 'Di' };

describe('buildStandings', () => {
  it('round robin: one canonical table with the viewer marked', () => {
    const data = buildStandings({
      tournament: { format: 'round_robin', match_type: 'singles', status: 'active' },
      savedMatches: [sm('x1', null, ['me'], ['a'], true), sm('x2', null, ['a'], ['b'], true)],
      savedRounds: [],
      registrations: [reg('me'), reg('a'), reg('b')],
      profileNames: names, profileRatings: {}, myUserId: 'me',
      mlpStandings: null, myMlpTeamId: null, finalRanks: [],
    });
    expect(data?.kind).toBe('team');
    expect(data?.tables[0].rows.map(r => r.key)).toEqual(['me', 'a', 'b']);
    expect(myStanding(data)).toMatchObject({ position: 1, of: 3, table: null });
  });
  it('pool play: one table per pool, scoped to the pool', () => {
    const data = buildStandings({
      tournament: { format: 'pool_play', match_type: 'singles', status: 'active' },
      savedMatches: schedule,
      savedRounds: [R.poolA, R.poolB, R.semis],
      registrations: [reg('me'), reg('a'), reg('b'), reg('c'), reg('d')],
      profileNames: names, profileRatings: {}, myUserId: 'me',
      mlpStandings: null, myMlpTeamId: null, finalRanks: [],
    });
    expect(data?.tables.map(t => t.label)).toEqual(['Pool A', 'Pool B']);
    expect(myStanding(data)).toMatchObject({ position: 1, table: 'Pool A' });
  });
  it('completed: the settled order from tournament_final_ranks', () => {
    const data = buildStandings({
      tournament: { format: 'round_robin', match_type: 'singles', status: 'completed' },
      savedMatches: [sm('x1', null, ['me'], ['a'], true), sm('x2', null, ['a'], ['b'], true)],
      savedRounds: [],
      registrations: [reg('me'), reg('a'), reg('b')],
      profileNames: names, profileRatings: {}, myUserId: 'me',
      mlpStandings: null, myMlpTeamId: null,
      finalRanks: [
        { user_id: 'a', final_rank: 1, wins: 1, losses: 1 },
        { user_id: 'me', final_rank: 2, wins: 1, losses: 0 },
        { user_id: 'b', final_rank: 3, wins: 0, losses: 1 },
      ],
    });
    expect(data?.settled).toBe(true);
    expect(data?.tables[0].rows.map(r => r.key)).toEqual(['a', 'me', 'b']);
  });
  it('rotating partners: per-player table', () => {
    const data = buildStandings({
      tournament: { format: 'rotating_partners', match_type: 'doubles', status: 'active' },
      savedMatches: [sm('r1', null, ['me', 'a'], ['b', 'c'], true)],
      savedRounds: [],
      registrations: [reg('me'), reg('a'), reg('b'), reg('c')],
      profileNames: names, profileRatings: {}, myUserId: 'me',
      mlpStandings: null, myMlpTeamId: null, finalRanks: [],
    });
    expect(data?.kind).toBe('player');
    expect(data?.tables[0].rows.slice(0, 2).map(r => r.key).sort()).toEqual(['a', 'me']);
  });
  it('MLP: the RPC rows in display order, the viewer\'s team marked', () => {
    const data = buildStandings({
      tournament: { format: 'mlp', match_type: 'doubles', status: 'active' },
      savedMatches: [], savedRounds: [], registrations: [],
      profileNames: {}, profileRatings: {}, myUserId: 'me',
      mlpStandings: [
        { team_id: 't1', team_name: 'Dinks', seed: 1, pool_letter: null, sub_matches_won: 2, sub_matches_lost: 6 },
        { team_id: 't2', team_name: 'Lobs', seed: 2, pool_letter: null, sub_matches_won: 6, sub_matches_lost: 2 },
      ],
      myMlpTeamId: 't1', finalRanks: [],
    });
    expect(data?.tables[0].rows.map(r => r.key)).toEqual(['t2', 't1']);
    expect(myStanding(data)).toMatchObject({ position: 2, row: { name: 'Dinks' } });
  });
  it('round robin + top 4: the table ranks group play only once the playoff exists', () => {
    const group = { id: 'rG', label: 'Round robin', round_type: 'winners', round_number: 1 };
    const semis = { id: 'rS', label: 'Semifinals', round_type: 'semifinals', round_number: 1000 };
    const groupMatches = [
      sm('g1', group, ['a'], ['me'], true),
      sm('g2', group, ['a'], ['b'], true),
      sm('g3', group, ['me'], ['b'], true),
    ];
    const input = {
      tournament: { format: 'round_robin', match_type: 'singles', status: 'active' } as const,
      registrations: [reg('me'), reg('a'), reg('b')],
      profileNames: names, profileRatings: {}, myUserId: 'me',
      mlpStandings: null, myMlpTeamId: null, finalRanks: [],
    };
    const before = buildStandings({ ...input, savedMatches: groupMatches, savedRounds: [group] });
    // 'me' (1-1) wins a semifinal over 'a' (2-0).
    const after = buildStandings({
      ...input,
      savedMatches: [...groupMatches, sm('s1', semis, ['me'], ['a'], true)],
      savedRounds: [group, semis],
    });
    expect(before?.groupStage).toBe(false);
    expect(after?.groupStage).toBe(true);
    expect(after?.note).toMatch(/^Group stage\./);
    expect(after?.tables[0].rows.map(r => [r.key, r.wins, r.losses]))
      .toEqual(before?.tables[0].rows.map(r => [r.key, r.wins, r.losses]));
    expect(after?.tables[0].rows[0].key).toBe('a');
    expect(myStanding(after)).toMatchObject({ row: { wins: 1, losses: 1 }, position: 2 });
  });
  it('elimination: every round counts (there is no group stage)', () => {
    const qf = { id: 'rQ', label: 'Quarterfinals', round_type: 'quarterfinals', round_number: 1 };
    const sf = { id: 'rS', label: 'Semifinals', round_type: 'semifinals', round_number: 2 };
    const data = buildStandings({
      tournament: { format: 'single_elimination', match_type: 'singles', status: 'active' },
      savedMatches: [sm('q1', qf, ['me'], ['a'], true), sm('s1', sf, ['me'], ['b'], true)],
      savedRounds: [qf, sf],
      registrations: [reg('me'), reg('a'), reg('b')],
      profileNames: names, profileRatings: {}, myUserId: 'me',
      mlpStandings: null, myMlpTeamId: null, finalRanks: [],
    });
    expect(data?.groupStage).toBe(false);
    expect(myStanding(data)).toMatchObject({ row: { wins: 2, losses: 0 } });
  });
  it('nothing to rank: null (the section is not rendered)', () => {
    expect(buildStandings({
      tournament: { format: 'round_robin', match_type: 'singles', status: 'active' },
      savedMatches: [], savedRounds: [], registrations: [], profileNames: {}, profileRatings: {},
      myUserId: null, mlpStandings: null, myMlpTeamId: null, finalRanks: [],
    })).toBeNull();
  });
});
