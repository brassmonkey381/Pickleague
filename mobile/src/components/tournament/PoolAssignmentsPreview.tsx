import React from 'react';
import { View, Text } from 'react-native';
import { Tournament } from '../../types';
import { useTournamentDetailStyles } from './styles';
import type { TournamentDetailState } from './useTournamentDetail';

/**
 * Pool assignments of the unsaved bracket preview, shown inside Manage's
 * "Generate the preview" step while `pools` is set (only the organizer who
 * generated it has a preview).
 */
export default function PoolAssignmentsPreview({ tournament, pools, playerName }:
  { tournament: Tournament; pools: string[][] } & Pick<TournamentDetailState, 'playerName'>) {
  const { S } = useTournamentDetailStyles();
  return (
    <View>
      <Text style={S.roundLabel}>Pools ({tournament.seeding === 'elo' ? 'PLUPR snake draft' : 'random draw'})</Text>
      <View style={S.poolsRow}>
        {pools.map((pool, pi) => (
          <View key={pi} style={S.poolBlock}>
            <Text style={S.poolLabel}>Pool {String.fromCharCode(65 + pi)}</Text>
            {pool.map(uid => <Text key={uid} style={S.poolPlayer} numberOfLines={1}>{playerName(uid)}</Text>)}
          </View>
        ))}
      </View>
    </View>
  );
}
