import React from 'react';
import { View, Text } from 'react-native';
import { Tournament } from '../../types';
import TournamentBracket from '../TournamentBracket';
import { computeTeamStandings, type TeamStanding } from '../../lib/tournamentStandings';
import { useTournamentDetailStyles } from './styles';
import SectionCard from './SectionCard';
import type { TournamentDetailState } from './useTournamentDetail';

type Props = {
  tournament: Tournament;
  myUserId: string | null;
} & Pick<TournamentDetailState, 'savedRounds' | 'savedMatches' | 'profileNames' | 'openMatchActionSheetById'>;

/**
 * Pool-play playoff tree for the classic 2-pool, top-2-per-pool shape: the
 * advancement rules plus the semis/final tree, filled with the pool leaders
 * and the real semi/final results. The per-pool tables moved to the Standings
 * section in P5b (one standings block for every format), so this renders
 * nothing for any other pool/playoff shape; those get the flow strip.
 */
export default function PoolPlayBracketSection({
  tournament, myUserId, savedRounds, savedMatches, profileNames, openMatchActionSheetById,
}: Props) {
  const { S } = useTournamentDetailStyles();
  const poolRounds = savedRounds.filter((r: any) => r.round_type === 'pool');
  if (poolRounds.length === 0) return null;

  function teamDisplayName(p1: string | null, p2: string | null): string {
    if (!p1) return '?';
    const n1 = profileNames[p1] ?? '?';
    const n2 = p2 ? (profileNames[p2] ?? '?') : null;
    return n2 ? `${n1} & ${n2}` : n1;
  }

  // Pool-scoped tiebreakers: only this pool's matches are tallied and fed to
  // head-to-head, as before the extraction.
  function computeStandings(round: any): TeamStanding[] {
    return computeTeamStandings(
      savedMatches.filter((m: any) => m.round?.id === round.id),
      {
        nameOf: teamDisplayName,
        // The live table's guard: a null partner never matches a signed-out
        // viewer (the pre-P5b pool table read every singles entrant as "me").
        isMe: (p1, p2) => !!myUserId && (p1 === myUserId || p2 === myUserId),
      },
    );
  }

  // Compute standings for the first 2 pools (bracket assumes A & B)
  const standA = poolRounds[0] ? computeStandings(poolRounds[0]) : [];
  const standB = poolRounds[1] ? computeStandings(poolRounds[1]) : [];
  const poolMatchesPlayed = poolRounds.every((r: any) =>
    savedMatches.filter((m: any) => m.round?.id === r.id).every((m: any) => m.status === 'completed')
  );

  // Look up actual playoff matches if they exist
  function findPlayoffMatch(roundType: 'semifinals' | 'finals', orderIdx: number) {
    const rounds = savedRounds.filter((r: any) => r.round_type === roundType);
    if (rounds.length === 0) return null;
    // Use match_order to disambiguate semi-final 1 vs 2 within the same round
    const candidates = savedMatches
      .filter((m: any) => rounds.some((r: any) => r.id === m.round?.id))
      .sort((a: any, b: any) => (a.match_order ?? 0) - (b.match_order ?? 0));
    return candidates[orderIdx] ?? null;
  }

  function winnerOfMatch(m: any | null, fallback?: { name?: string; isMe?: boolean }) {
    if (!m || m.status !== 'completed' || !m.winner_team) return fallback;
    const isT1 = m.winner_team === 'team1';
    const p1 = isT1 ? m.team1_player1 : m.team2_player1;
    const p2 = isT1 ? m.team1_player2 : m.team2_player2;
    if (!p1) return fallback;
    return {
      name: teamDisplayName(p1, p2),
      isMe: !!myUserId && (p1 === myUserId || p2 === myUserId),
    };
  }

  const semi1Match = findPlayoffMatch('semifinals', 0);
  const semi2Match = findPlayoffMatch('semifinals', 1);
  const finalMatch = findPlayoffMatch('finals',     0);

  const a1 = standA[0]; const a2 = standA[1];
  const b1 = standB[0]; const b2 = standB[1];

  const semi1Winner = winnerOfMatch(semi1Match);
  const semi2Winner = winnerOfMatch(semi2Match);
  const finalWinner = winnerOfMatch(finalMatch);

  // The visual tree below is hardcoded to the classic 2-pool shape
  // (A1 vs B2, B1 vs A2 → final). Rendering it for other pool/playoff
  // configs mislabels the feeders and skips whole stages (a 3-pool
  // quarterfinal bracket showed as 2-pool semis). Those configs get
  // the generalized Tournament Flow overview instead.
  const classicTwoPoolTree = poolRounds.length === 2
    && tournament.playoff_format === 'top_2_per_pool';

  if (!classicTwoPoolTree) return null;

  return (
    <SectionCard title="Playoff bracket">
      {/* Advancement criteria */}
      <View style={S.advancementCard}>
        <Text style={S.advancementTitle}>How teams advance</Text>
        <Text style={S.advancementRule}>
          The <Text style={S.bold}>top 2 teams</Text> from each pool advance to the semifinals, ranked by:
        </Text>
        <Text style={S.advancementPoint}>1.  Wins</Text>
        <Text style={S.advancementPoint}>2.  Head-to-head (when exactly 2 are tied)</Text>
        <Text style={S.advancementPoint}>3.  Point differential</Text>
        {poolMatchesPlayed && a1 && b2 && (
          <Text style={S.advancementResultLine}>
            ✓ Pools complete: the top 2 from each pool are seeded into the bracket below.
          </Text>
        )}
      </View>

      <View style={S.bracketDivider} />

      {/* Visual bracket — populated with actual team names + winners where available */}
      <TournamentBracket
        slotA1={{ label: 'Pool A · 1st Place', team: a1?.name, highlight: a1?.isMe }}
        slotB2={{ label: 'Pool B · 2nd Place', team: b2?.name, highlight: b2?.isMe }}
        slotB1={{ label: 'Pool B · 1st Place', team: b1?.name, highlight: b1?.isMe }}
        slotA2={{ label: 'Pool A · 2nd Place', team: a2?.name, highlight: a2?.isMe }}
        semi1={{
          label: semi1Match?.status === 'completed'
            ? `Semi 1: ${semi1Match.team1_score}–${semi1Match.team2_score}`
            : 'Semi-Final 1',
          team: semi1Winner?.name,
          highlight: semi1Winner?.isMe,
          tournamentMatchId: semi1Match?.id,
        }}
        semi2={{
          label: semi2Match?.status === 'completed'
            ? `Semi 2: ${semi2Match.team1_score}–${semi2Match.team2_score}`
            : 'Semi-Final 2',
          team: semi2Winner?.name,
          highlight: semi2Winner?.isMe,
          tournamentMatchId: semi2Match?.id,
        }}
        final={{
          label: finalMatch?.status === 'completed'
            ? `Final: ${finalMatch.team1_score}–${finalMatch.team2_score}`
            : 'Grand Final',
          team: finalWinner?.name,
          highlight: finalWinner?.isMe,
          tournamentMatchId: finalMatch?.id,
        }}
        onPressMatch={openMatchActionSheetById}
      />
    </SectionCard>
  );
}
