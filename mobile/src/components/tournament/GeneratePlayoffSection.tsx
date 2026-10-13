import React from 'react';
import { View, Text } from 'react-native';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { Tournament } from '../../types';
import { useTournamentDetailStyles } from './styles';
import type { TournamentDetailState } from './useTournamentDetail';

type Props = { tournament: Tournament }
  & Pick<TournamentDetailState, 'savedRounds' | 'savedMatches' | 'generatingPlayoff' | 'generatePlayoff'>;

/** Group-play matches still to finish before the playoff can be drawn. */
export function groupPlayPendingCount(savedRounds: any[], savedMatches: any[]): number {
  return savedMatches.filter((m: any) => {
    const r = savedRounds.find((r: any) => r.id === m.round?.id);
    if (!r) return false;
    return !['quarterfinals', 'semifinals', 'finals', 'third_place_match', 'consolation', 'losers'].includes(r.round_type)
      && m.status !== 'completed';
  }).length;
}

/**
 * Organizer: Generate Playoff Bracket for round robin / pool play with a
 * playoff configured and none generated yet (the caller gates it). Since P5b
 * it is the body of Manage's active-stage "Generate playoff" step; the action
 * itself is useTournamentDetail.generatePlayoff.
 */
export default function GeneratePlayoffSection({
  tournament, savedRounds, savedMatches, generatingPlayoff, generatePlayoff,
}: Props) {
  const { S } = useTournamentDetailStyles();
  const groupPlayPending = groupPlayPendingCount(savedRounds, savedMatches);
  const ready = groupPlayPending === 0;
  const sizeLabel =
    tournament.playoff_format === 'top_2' ? 'Top 2 (final + 3rd place)' :
    tournament.playoff_format === 'top_4' ? 'Top 4 (semis + final)' :
    tournament.playoff_format === 'top_8' ? 'Top 8 (quarters + semis + final)' :
    tournament.playoff_format === 'top_1_per_pool' ? 'Top 1 per pool' :
    tournament.playoff_format === 'top_2_per_pool' ? 'Top 2 per pool' :
    tournament.playoff_format;

  return (
    <View style={{ gap: SPACE.xs }}>
      <Text style={S.note}>
        {sizeLabel}.
        {ready
          ? ' All group-play matches are complete.'
          : ` Waiting on ${groupPlayPending} group-play match${groupPlayPending === 1 ? '' : 'es'}.`}
      </Text>
      <Button
        size="sm"
        title="Generate playoff bracket"
        onPress={() => generatePlayoff(ready)}
        disabled={!ready}
        loading={generatingPlayoff}
        style={{ alignSelf: 'flex-start' }}
      />
    </View>
  );
}
