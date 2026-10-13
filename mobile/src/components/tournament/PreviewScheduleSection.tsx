import React from 'react';
import { View, Text } from 'react-native';
import { FilterPill } from '@just-messin-around/expo-foundation/ui';
import { MatchPairing } from '../../lib/tournament';
import { useTournamentDetailStyles } from './styles';
import type { TournamentDetailState } from './useTournamentDetail';

/**
 * The generated (unsaved) bracket preview, rendered inside Manage's "Generate
 * the preview" step (P5b: the preview lives in the step that makes it), with
 * a Mine chip. Round labels come from the generator.
 */
export default function PreviewScheduleSection({
  generatedMatches, myUserId, myMatchesOnly, setMyMatchesOnly, playerName,
}: { generatedMatches: MatchPairing[]; myUserId: string | null }
  & Pick<TournamentDetailState, 'myMatchesOnly' | 'setMyMatchesOnly' | 'playerName'>) {
  const { S } = useTournamentDetailStyles();
  const isMine = (m: MatchPairing) => !!myUserId && (m.team1.includes(myUserId) || m.team2.includes(myUserId));
  const myCount = generatedMatches.filter(isMine).length;
  const previewFiltered = myMatchesOnly ? generatedMatches.filter(isMine) : generatedMatches;
  const rounds = [...new Set(previewFiltered.map(m => m.round))].sort((a, b) => a - b);

  return (
    <View>
      <View style={S.previewBanner}>
        <Text style={S.previewBannerText}>Preview only. Lock in to save it and notify the players.</Text>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Text style={[S.roundLabel, { flex: 1 }]}>
          {previewFiltered.length}{myMatchesOnly ? '' : ` of ${generatedMatches.length}`} matches
        </Text>
        {myCount > 0 && (
          <FilterPill
            label="Mine"
            count={myCount}
            active={myMatchesOnly}
            onPress={() => setMyMatchesOnly(v => !v)}
          />
        )}
      </View>

      {rounds.map(r => (
        <View key={r} style={S.roundBlock}>
          <Text style={S.roundLabel}>
            {generatedMatches.find(m => m.round === r)?.label?.split('·')[0]?.trim() ?? `Round ${r}`}
          </Text>
          {previewFiltered.filter(m => m.round === r).map((m, mi, arr) => {
            const t1 = m.team1.map(playerName).join(' & ');
            const t2 = m.team2.map(playerName).join(' & ');
            const mine = isMine(m);
            return (
              <View key={mi} style={[S.matchRow, mi === arr.length - 1 && S.rowLast, mine && S.matchRowHighlight]}>
                <Text style={S.matchNum}>{mi + 1}</Text>
                <Text style={[S.matchup, mine && S.matchupHighlight]} numberOfLines={1}>{t1}</Text>
                <Text style={S.vs}>vs</Text>
                <Text style={[S.matchup, mine && S.matchupHighlight]} numberOfLines={1}>{t2}</Text>
                {mine && <Text style={S.youTag}>YOU</Text>}
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}
