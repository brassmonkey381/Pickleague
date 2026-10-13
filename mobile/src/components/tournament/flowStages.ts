import { Tournament, TournamentRegistration } from '../../types';
import { FlowOverviewStage } from '../TournamentFlowOverview';
import { predictFlow } from '../../lib/tournamentFlow';

// ── Predicted tournament flow ────────────────────────────────
// The full expected stage structure (pools → QF → SF → F, elim rounds, …)
// known at lock-in time. Stages whose DB rounds exist use live data;
// stages the advancement triggers haven't created yet come from
// predictFlow() and render as "upcoming" skeletons.
//
// Moved verbatim from TournamentDetailScreen's render (UI compaction P5a).
export function buildFlowStages({ tournament, savedRounds, savedMatches, doublesPairs, approved }: {
  tournament: Tournament;
  savedRounds: any[];
  savedMatches: any[];
  doublesPairs: { partner_1_id: string | null; partner_2_id: string | null }[];
  approved: TournamentRegistration[];
}): FlowOverviewStage[] | null {
  if (tournament.status !== 'active' && tournament.status !== 'completed') return null;
  if (savedRounds.length === 0) return null;
  const isTeamDoubles = tournament.match_type === 'doubles' && tournament.format !== 'rotating_partners';
  const entrants = isTeamDoubles
    ? doublesPairs.filter((p: any) => p.partner_1_id && p.partner_2_id).length
    : approved.length;
  const actualPoolCount = savedRounds.filter((r: any) => r.round_type === 'pool').length;
  const predicted = predictFlow({
    format: tournament.format,
    playoffFormat: tournament.playoff_format,
    playoffThirdPlace: tournament.playoff_third_place,
    poolCount: actualPoolCount || tournament.pool_count,
    entrants,
  });
  if (!predicted) return null;
  const rounds = [...savedRounds].sort((a: any, b: any) => a.round_number - b.round_number);
  const out: FlowOverviewStage[] = [];
  for (let i = 0; i < Math.max(predicted.length, rounds.length); i++) {
    const r = rounds[i];
    const p = predicted[i];
    if (r) {
      const ms = savedMatches.filter((m: any) =>
        m.round?.id === r.id && !(m.is_dreambreaker && m.status === 'cancelled'));
      out.push({
        key: r.id,
        label: r.label ?? p?.label ?? `Round ${i + 1}`,
        kind: p?.kind ?? (r.round_type === 'pool' ? 'group' : 'playoff'),
        exists: true,
        total: ms.length,
        completed: ms.filter((m: any) => m.status === 'completed').length,
        byes: ms.filter((m: any) => m.match_type === 'bye').length,
      });
    } else {
      out.push({
        key: p.key, label: p.label, kind: p.kind,
        exists: false, total: p.matchCount, completed: 0, byes: p.byes,
      });
    }
  }
  return out;
}
