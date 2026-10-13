// Pure decisions behind TournamentDetail's section layout (UI compaction P5b,
// plan section 5 "Tournament: the You card by status x role"). No React, no
// Supabase: the screen gathers the facts, these functions decide what shows,
// and components/tournament/__tests__/tournamentModel.test.ts walks every row
// of the plan's table.
import type { Tournament, TournamentRegistration } from '../../types';

// ── Rounds and stages ───────────────────────────────────────────────────────

/** Formats whose whole draw is one elimination bracket (no group stage). */
const ELIM_FORMATS: ReadonlySet<string> = new Set(['single_elimination', 'double_elimination']);

/** round_type values of a group stage, for formats that have one. */
const GROUP_ROUND_TYPES: ReadonlySet<string> = new Set(['pool', 'winners']);

export type RoundStage = 'group' | 'playoff';

/**
 * Which stage a tournament_rounds row belongs to. 'pool' and 'winners' rounds
 * are the group stage of round robin / pool play / MLP / rotating partners;
 * quarterfinals, semifinals, finals, third place and grand final are the
 * playoff. An elimination format is one bracket, so every round is 'playoff'.
 */
export function roundStage(roundType: string | null | undefined, format: string): RoundStage {
  if (ELIM_FORMATS.has(format)) return 'playoff';
  return roundType && GROUP_ROUND_TYPES.has(roundType) ? 'group' : 'playoff';
}

// ── Schedule ────────────────────────────────────────────────────────────────

/** A saved tournament_matches row as the schedule reads it (select '*'). */
export type ScheduleMatch = {
  id: string;
  match_order?: number | null;
  match_type?: string | null;
  status: string;
  winner_team: 'team1' | 'team2' | null;
  team1_player1: string | null;
  team1_player2: string | null;
  team2_player1: string | null;
  team2_player2: string | null;
  team1_score?: number | null;
  team2_score?: number | null;
  is_dreambreaker?: boolean | null;
  round?: { id: string; label: string | null; round_type: string; round_number: number } | null;
};

export type SchedulePlay = 'all' | 'to_play' | 'done';
export type ScheduleStage = 'all' | RoundStage;

export type ScheduleFilter = {
  /** Only matches the viewer plays in. */
  mine: boolean;
  /** To play = not yet completed; Done = completed. Exclusive. */
  play: SchedulePlay;
  stage: ScheduleStage;
  /** One tournament_rounds row (the Round pill, or a tapped flow card). */
  roundId: string | null;
};

export const EMPTY_SCHEDULE_FILTER: ScheduleFilter = { mine: false, play: 'all', stage: 'all', roundId: null };

export function isScheduleFiltered(f: ScheduleFilter): boolean {
  return f.mine || f.play !== 'all' || f.stage !== 'all' || f.roundId != null;
}

export function involves(m: ScheduleMatch, userId: string | null | undefined): boolean {
  if (!userId) return false;
  return m.team1_player1 === userId || m.team1_player2 === userId
    || m.team2_player1 === userId || m.team2_player2 === userId;
}

/** A cancelled dreambreaker never gets played (the meeting was decided 3-1 or
 *  4-0), so it is never listed. A pending one still is: the 2-2 tie needs it. */
export function visibleScheduleMatches<M extends ScheduleMatch>(matches: M[]): M[] {
  return matches.filter(m => !(m.is_dreambreaker && m.status === 'cancelled'));
}

/** Apply the Schedule chips, stage chips and Round pill (AND-ed). */
export function filterSchedule<M extends ScheduleMatch>(
  matches: M[],
  f: ScheduleFilter,
  ctx: { myUserId: string | null; format: string },
): M[] {
  return visibleScheduleMatches(matches).filter(m => {
    if (f.mine && !involves(m, ctx.myUserId)) return false;
    const done = m.status === 'completed';
    if (f.play === 'to_play' && (done || m.match_type === 'bye')) return false;
    if (f.play === 'done' && !done) return false;
    if (f.stage !== 'all' && roundStage(m.round?.round_type, ctx.format) !== f.stage) return false;
    if (f.roundId != null && m.round?.id !== f.roundId) return false;
    return true;
  });
}

/** Both group and playoff rounds exist, so the stage chips mean something. */
export function hasBothStages(rounds: { round_type: string }[], format: string): boolean {
  let group = false;
  let playoff = false;
  for (const r of rounds) {
    if (roundStage(r.round_type, format) === 'group') group = true;
    else playoff = true;
  }
  return group && playoff;
}

/** A match that can be played now: not completed, not a bye, both sides set. */
export function isPlayable(m: ScheduleMatch): boolean {
  return m.status !== 'completed' && m.status !== 'cancelled' && m.match_type !== 'bye'
    && !!m.team1_player1 && !!m.team2_player1;
}

/**
 * The viewer's next match: the earliest playable match they are in, by round
 * then schedule order. null when they have none left (or aren't playing).
 */
export function nextMatchFor<M extends ScheduleMatch>(matches: M[], userId: string | null): M | null {
  if (!userId) return null;
  const mine = visibleScheduleMatches(matches).filter(m => isPlayable(m) && involves(m, userId));
  mine.sort((a, b) =>
    (a.round?.round_number ?? 999) - (b.round?.round_number ?? 999)
    || (a.match_order ?? 0) - (b.match_order ?? 0));
  return mine[0] ?? null;
}

/** The viewer's opponents in a match (the other side), or [] if not in it. */
export function opponentsOf(m: ScheduleMatch, userId: string): string[] {
  const onTeam1 = m.team1_player1 === userId || m.team1_player2 === userId;
  const other = onTeam1 ? [m.team2_player1, m.team2_player2] : [m.team1_player1, m.team1_player2];
  return other.filter(Boolean) as string[];
}

/** The viewer's partner in a doubles match, or null. */
export function partnerOf(m: ScheduleMatch, userId: string): string | null {
  if (m.team1_player1 === userId) return m.team1_player2;
  if (m.team1_player2 === userId) return m.team1_player1;
  if (m.team2_player1 === userId) return m.team2_player2;
  if (m.team2_player2 === userId) return m.team2_player1;
  return null;
}

/**
 * Who may open a match to record its score. RLS lets the tournament creator
 * and the match's own players update tournament_matches; co-admins keep the
 * tap they always had. A spectator gets no record chevron (plan section 8, P5b).
 */
export function canRecordMatch(m: ScheduleMatch, ctx: { isPriv: boolean; myUserId: string | null }): boolean {
  if (!isPlayable(m)) return false;
  return ctx.isPriv || involves(m, ctx.myUserId);
}

// ── The "You" card ──────────────────────────────────────────────────────────

export type YouCardKind =
  | 'none'
  // Registration
  | 'join'          // spectator who can request (or join the waitlist)
  | 'invite_only'   // spectator, invite-only tournament
  | 'closed'        // spectator, the registration deadline has passed
  | 'invited'       // an organizer invited the viewer: Accept / Decline
  | 'requested'     // the viewer's request is waiting on an organizer
  | 'waitlisted'
  | 'rejected'
  | 'approved'      // "You're in"
  | 'setup'         // admin / co-admin: the setup checklist's next step
  // Active
  | 'next_match'    // a player with a match to play
  | 'playing'       // a player with nothing to play right now
  // Completed
  | 'finished';

export type YouCardInput = {
  status: Tournament['status'];
  isPriv: boolean;
  myReg: Pick<TournamentRegistration, 'status' | 'invited_by'> | null | undefined;
  canRegister: boolean;
  inviteOnly: boolean;
  regClosed: boolean;
  /** The viewer appears in at least one saved match. */
  inSchedule: boolean;
  hasNextMatch: boolean;
  /** Settled ranks exist (tournament_final_ranks has rows). */
  hasFinalRanks: boolean;
};

/** The plan's status x role table, one row per branch. */
export function youCardKind(i: YouCardInput): YouCardKind {
  if (i.status === 'cancelled') return 'none';
  if (i.status === 'completed') return i.hasFinalRanks ? 'finished' : 'none';
  if (i.status === 'active') {
    if (i.hasNextMatch) return 'next_match';
    if (i.inSchedule || i.myReg?.status === 'approved') return 'playing';
    // Lock-in leaves pending / waitlisted rows alone and the invite RPC has no
    // status check, so a leftover invitee can still Accept / Decline (Home's
    // "Respond" lands here) and a requester still sees where they stand.
    const reg = i.myReg;
    if (reg?.status === 'pending' && reg.invited_by) return 'invited';
    if (reg?.status === 'pending') return 'requested';
    if (reg?.status === 'waitlisted') return 'waitlisted';
    return 'none';  // spectator: stage progress lives in the status strip
  }
  // Registration
  if (i.isPriv) return 'setup';
  const reg = i.myReg;
  if (reg) {
    if (reg.status === 'pending' && reg.invited_by) return 'invited';
    if (reg.status === 'approved') return 'approved';
    if (reg.status === 'pending') return 'requested';
    if (reg.status === 'waitlisted') return 'waitlisted';
    if (reg.status === 'rejected') return 'rejected';
  }
  if (i.canRegister) return 'join';
  if (i.inviteOnly) return 'invite_only';
  if (i.regClosed) return 'closed';
  return 'none';
}

// ── Organizer setup checklist (registration) ────────────────────────────────

export type SetupStepKey = 'approve' | 'release' | 'pair' | 'generate' | 'lock';

export type SetupStep = { key: SetupStepKey; label: string; done: boolean };

/**
 * Manage's registration checklist, in the plan's order: approve requests, set
 * the release time, pair teams (doubles / MLP only), generate the preview,
 * lock in & notify. A tournament still in registration is never locked, so
 * the last step is never done here.
 */
export function setupSteps(i: {
  pendingRequests: number;
  releaseSet: boolean;
  needsPairing: boolean;
  pairingDone: boolean;
  previewReady: boolean;
}): SetupStep[] {
  const steps: SetupStep[] = [
    {
      key: 'approve',
      label: i.pendingRequests > 0
        ? `Approve ${i.pendingRequests} request${i.pendingRequests === 1 ? '' : 's'}`
        : 'Approve requests',
      done: i.pendingRequests === 0,
    },
    // Optional: lock-in never requires a release time, and the screen hides
    // its picker once a preview exists (master's !generatedMatches gate), so
    // the step must not hold the checklist after generation.
    { key: 'release', label: 'Set the release time', done: i.releaseSet || i.previewReady },
  ];
  if (i.needsPairing) steps.push({ key: 'pair', label: 'Pair teams', done: i.pairingDone });
  steps.push({ key: 'generate', label: 'Generate the preview', done: i.previewReady });
  steps.push({ key: 'lock', label: 'Lock in & notify', done: false });
  return steps;
}

/** The step to show on the You card: the first one not done. */
export function currentSetupStep(steps: SetupStep[]): { step: SetupStep; index: number } {
  const index = Math.max(0, steps.findIndex(s => !s.done));
  return { step: steps[index], index };
}

/**
 * Every approved player sits in a complete doubles pair, and there are at
 * least two pairs (the same rule generateBracket enforces before the draw).
 */
export function doublesPairingDone(
  approvedIds: string[],
  pairs: { partner_1_id: string | null; partner_2_id: string | null }[],
): boolean {
  const approved = new Set(approvedIds);
  const paired = new Set<string>();
  let complete = 0;
  for (const p of pairs) {
    if (p.partner_1_id && p.partner_2_id && approved.has(p.partner_1_id) && approved.has(p.partner_2_id)) {
      paired.add(p.partner_1_id);
      paired.add(p.partner_2_id);
      complete++;
    }
  }
  return complete >= 2 && approvedIds.every(id => paired.has(id));
}

export type MlpTeamSlots = {
  id: string;
  male_1_id: string | null; male_2_id: string | null;
  female_1_id: string | null; female_2_id: string | null;
};

/** At least two MLP teams, every one with all four slots filled. */
export function mlpTeamsDone(teams: MlpTeamSlots[]): boolean {
  return teams.length >= 2
    && teams.every(t => !!(t.male_1_id && t.male_2_id && t.female_1_id && t.female_2_id));
}

/** The viewer's MLP team, or null. */
export function mlpTeamOf<T extends MlpTeamSlots>(teams: T[], userId: string | null): T | null {
  if (!userId) return null;
  return teams.find(t =>
    t.male_1_id === userId || t.male_2_id === userId
    || t.female_1_id === userId || t.female_2_id === userId) ?? null;
}

/** The viewer's doubles partner from doubles_pairs, or null. */
export function doublesPartnerOf(
  pairs: { partner_1_id: string | null; partner_2_id: string | null }[],
  userId: string | null,
): { found: boolean; partnerId: string | null } {
  if (!userId) return { found: false, partnerId: null };
  for (const p of pairs) {
    if (p.partner_1_id === userId) return { found: true, partnerId: p.partner_2_id };
    if (p.partner_2_id === userId) return { found: true, partnerId: p.partner_1_id };
  }
  return { found: false, partnerId: null };
}

// ── Identity ────────────────────────────────────────────────────────────────

export type StatusPill = { label: string; tone: 'brand' | 'success' | 'warning' | 'danger' | 'neutral' };

/** The one status pill that replaces the three closure banners. */
export function statusPill(i: { status: Tournament['status']; regClosed: boolean; isFull: boolean }): StatusPill {
  switch (i.status) {
    case 'registration':
      if (i.regClosed) return { label: 'Registration closed', tone: 'warning' };
      if (i.isFull) return { label: 'Full · waitlist open', tone: 'warning' };
      return { label: 'Registration open', tone: 'brand' };
    case 'active': return { label: 'In progress', tone: 'success' };
    case 'completed': return { label: 'Completed', tone: 'neutral' };
    default: return { label: 'Cancelled', tone: 'danger' };
  }
}

/** The playoff chip text, or null when the format has none worth naming. */
export function playoffLabel(t: Pick<Tournament,
  'format' | 'mlp_play_format' | 'mlp_playoff_teams' | 'playoff_format' | 'playoff_third_place'>): string | null {
  const f = t.format;
  // Elimination: the bracket IS the playoff.
  if (f === 'single_elimination' || f === 'double_elimination') return null;
  if (f === 'rotating_partners') return null;
  if (f === 'mlp' || f === 'mlp_random') {
    const mpf = t.mlp_play_format;
    if (mpf === 'round_robin_playoff' || mpf === 'pool_play_playoff') return `Playoff: top ${t.mlp_playoff_teams}`;
    return null;
  }
  const pf = t.playoff_format ?? 'none';
  const third = t.playoff_third_place ? ' + 3rd' : '';
  if (pf === 'top_2') return 'Playoff: top 2 + 3rd';
  if (pf === 'top_4') return `Playoff: top 4${third}`;
  if (pf === 'top_8') return `Playoff: top 8${third}`;
  if (pf === 'top_1_per_pool') return 'Playoff: top 1 per pool';
  if (pf === 'top_2_per_pool') return 'Playoff: top 2 per pool';
  return null;
}

/** "1st" / "2nd" / "3rd" / "4th"… */
export function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}
