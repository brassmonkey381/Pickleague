import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { RankMedal } from '@just-messin-around/expo-foundation/ui';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { Tournament, TournamentRegistration } from '../../types';
import { useTournamentDetailStyles } from './styles';
import type { TournamentDetailState } from './useTournamentDetail';

// Wager Market table — top 3 finishing ranks, ordered as displayed. Each is
// drawn as a RankMedal (the medal colour with the place on it).
const WAGER_MARKET_RANKS: ReadonlyArray<{ rank: number }> = [
  { rank: 1 },
  { rank: 2 },
  { rank: 3 },
];
const WAGER_MARKET_TOP_N = 12;

type Props = {
  tournament: Tournament;
  tournamentId: string;
  approved: TournamentRegistration[];
} & Pick<TournamentDetailState,
  | 'wagerMarketShowAll' | 'setWagerMarketShowAll'
  | 'wagerMarketSorted' | 'setWagerSubject' | 'setWagerOpen'>;

/**
 * The Wager Market's players × ranks table. It used to sit in the header card
 * behind its own toggle; since P5b it is the body of a collapsed "Wager
 * market" section (the section header is the toggle). The caller gates it
 * (WAGERS_ENABLED, tournament still live, at least one approved player).
 */
export default function WagerMarket({
  tournament, tournamentId, approved,
  wagerMarketShowAll, setWagerMarketShowAll,
  wagerMarketSorted, setWagerSubject, setWagerOpen,
}: Props) {
  const { S } = useTournamentDetailStyles();
  const overLimit = wagerMarketSorted.length > WAGER_MARKET_TOP_N;
  const shown = overLimit && !wagerMarketShowAll
    ? wagerMarketSorted.slice(0, WAGER_MARKET_TOP_N)
    : wagerMarketSorted;
  // Only offer finishing ranks the field can actually produce — no 3rd place
  // in a 2-player tournament.
  const ranks = WAGER_MARKET_RANKS.filter(rc => rc.rank <= approved.length);
  return (
    <View>
      {/* The header takes the rows' gap so each medal sits over its column. */}
      <View style={[S.wagerMarketHeader, L.headerGap]}>
        <Text style={[S.wagerMarketCellLabel, L.playerHead]}>Player</Text>
        {ranks.map(rc => (
          <View key={rc.rank} style={L.medalHead}>
            <RankMedal place={rc.rank} size={18} />
          </View>
        ))}
      </View>
      {shown.map(item => {
        const uname = item.profile?.full_name ?? 'Player';
        const initial = (item.profile?.full_name ?? '?')[0].toUpperCase();
        return (
          <View key={item.id} style={S.wagerMarketRow}>
            <View style={S.wagerMarketPlayerCell}>
              <View style={S.wagerMarketAvatar}>
                <Text style={S.wagerMarketAvatarText}>{initial}</Text>
              </View>
              <Text style={S.wagerMarketName} numberOfLines={1}>{uname}</Text>
            </View>
            {ranks.map(rc => (
              <Pressable
                key={rc.rank}
                style={({ pressed }) => [S.wagerMarketBetBox, pressed && S.pressed]}
                accessibilityRole="button"
                accessibilityLabel={`Bet on ${uname} finishing ${rc.rank === 1 ? 'first' : rc.rank === 2 ? 'second' : 'third'}`}
                onPress={() => {
                  setWagerSubject({
                    type: 'tournament_rank',
                    tournamentId,
                    tournamentName: tournament.name,
                    userId: item.user_id,
                    userName: uname,
                    rank: rc.rank,
                  });
                  setWagerOpen(true);
                }}
              >
                <View style={[S.wagerMarketBetPill, L.betPill]}>
                  <RankMedal place={rc.rank} size={14} />
                  <Text style={S.wagerMarketBetText}>Bet</Text>
                </View>
              </Pressable>
            ))}
          </View>
        );
      })}
      {overLimit && (
        <Pressable
          style={S.wagerMarketToggle}
          accessibilityRole="button"
          onPress={() => setWagerMarketShowAll(v => !v)}
        >
          <Text style={S.wagerMarketToggleText}>
            {wagerMarketShowAll
              ? `Show top ${WAGER_MARKET_TOP_N}`
              : `Show ${wagerMarketSorted.length - WAGER_MARKET_TOP_N} more`}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

// Layout only (colours and type come from the shared tournament styles).
const L = StyleSheet.create({
  headerGap: { gap: SPACE.xs },
  playerHead: { flex: 1, textAlign: 'left' },
  // The bet column's width (wagerMarketBetBox).
  medalHead: { width: 64, alignItems: 'center' },
  betPill: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs },
});
