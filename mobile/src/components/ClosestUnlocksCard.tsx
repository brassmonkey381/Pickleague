import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../lib/ThemeContext';
import { RootStackParamList } from '../types';
import { computeBadgeProgress, BadgeProgress } from '../lib/unlockProgress';

// TODO: smoke-test in browser — verify the 1–2 nearest unlocks render with a
// filled progress bar + label, the card taps through to UnlockProgress, and
// the card disappears when nothing non-perLeague remains to earn.

type Props = {
  userId: string | null;
  navigation: NativeStackNavigationProp<RootStackParamList, 'Home'>;
};

// Thin filled/empty progress bar matching the ProgressRow style in
// UnlockProgressScreen — kept visually consistent across surfaces.
function ProgressRow({ row, c }: { row: BadgeProgress; c: ReturnType<typeof useTheme>['colors'] }) {
  const filled = Math.max(row.pct, 0.02);
  const empty = 1 - filled;
  return (
    <View style={{ marginBottom: 10 }}>
      <Text style={{ fontSize: 13, fontWeight: '700', color: c.text }}>{row.badge}</Text>
      <View style={{ flexDirection: 'row', height: 5, borderRadius: 3, overflow: 'hidden', marginTop: 5, marginBottom: 3, backgroundColor: c.border }}>
        <View style={{ backgroundColor: c.primary, flex: filled }} />
        {empty > 0 && <View style={{ backgroundColor: c.border, flex: empty }} />}
      </View>
      <Text style={{ fontSize: 11, color: c.textSub, fontWeight: '600' }}>{row.label}</Text>
    </View>
  );
}

export default function ClosestUnlocksCard({ userId, navigation }: Props) {
  const { colors } = useTheme();
  const s = makeStyles(colors);
  const [rows, setRows] = useState<BadgeProgress[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (!userId) { setRows([]); return; }
    (async () => {
      const all = await computeBadgeProgress(userId);
      if (cancelled) return;
      // Nearest not-yet-earned badges with a real global threshold. The lib
      // already sorts closest-first, so take the top 2.
      const closest = all.filter(p => !p.earned && !p.perLeague).slice(0, 2);
      setRows(closest);
    })();
    return () => { cancelled = true; };
  }, [userId]);

  if (rows.length === 0) return null;

  return (
    <TouchableOpacity
      style={s.card}
      activeOpacity={0.85}
      onPress={() => navigation.navigate('UnlockProgress')}
    >
      <View style={s.headerRow}>
        <Text style={s.title}>🔓 Closest unlocks</Text>
        <Text style={s.viewAll}>View all →</Text>
      </View>
      {rows.map(row => (
        <ProgressRow key={row.badge} row={row} c={colors} />
      ))}
    </TouchableOpacity>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    card: {
      marginHorizontal: 16,
      marginTop: 12,
      padding: 14,
      borderRadius: 14,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
    },
    headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
    title: { fontSize: 15, fontWeight: '800', color: c.text },
    viewAll: { fontSize: 13, fontWeight: '700', color: c.primary },
  });
}
