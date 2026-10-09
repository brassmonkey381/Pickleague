// "N players here now" at one court, with their PLUPR. Refreshes every minute
// while visible. A failed load shows a line saying so rather than "nobody here".
import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { usePollWhileActive } from '@just-messin-around/expo-foundation/hooks';
import { useTheme } from '../lib/ThemeContext';
import { formatPluprShort } from '../lib/plupr';
import { getPlayersHere, type PlayerHere } from '../data/venueCheckins';

type Props = {
  venueId: string;
  /** One summary line only (league screen), no roster. */
  compact?: boolean;
  /** Label for the compact line, e.g. the court name. */
  venueName?: string;
};

export default function PlayersHereList({ venueId, compact, venueName }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const [players, setPlayers] = useState<PlayerHere[] | null>(null);
  const [failed, setFailed] = useState(false);

  usePollWhileActive(
    async () => {
      try {
        setPlayers(await getPlayersHere(venueId));
        setFailed(false);
      } catch {
        setFailed(true);
      }
    },
    60_000,
    venueId,
  );

  if (failed && !players) return <Text style={[t.sub, S.top]}>Couldn't load who's here.</Text>;
  if (!players) return null;
  const n = players.length;
  const where = venueName ? ` at ${venueName}` : ' here';
  const summary = n === 0 ? `No one checked in${where} right now` : `${n} player${n === 1 ? '' : 's'}${where} now`;

  if (compact) return <Text style={[t.bodySub, S.top]}>🟢 {summary}</Text>;
  return (
    <View style={S.top}>
      <Text style={t.bodySub}>{summary}</Text>
      {players.slice(0, 12).map((p) => (
        <View key={p.checkin_id} style={S.row}>
          <Text style={[t.body, S.name]} numberOfLines={1}>
            {p.avatar_emoji ? `${p.avatar_emoji} ` : ''}
            {p.full_name ?? 'Player'}
          </Text>
          <Text style={t.sub}>PLUPR {formatPluprShort(p.doubles_rating ?? p.rating, undefined)}</Text>
        </View>
      ))}
      {n > 12 ? <Text style={t.sub}>and {n - 12} more</Text> : null}
    </View>
  );
}

const S = StyleSheet.create({
  top: { marginTop: 10 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4, gap: 8 },
  name: { flex: 1 },
});
