// PKL-052: the tournament admin orders entrants still level on W-L and point
// diff. One block per level group, move up / down buttons, and a Save per
// group that sends that group's entrant keys in the new order
// (set_tournament_tie_order). Waiting groups come first.
import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { BottomSheet } from '@just-messin-around/expo-foundation/ui';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { HAIRLINE, RADIUS, SPACE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';
import type { TieGroupView } from './standingsData';

type Props = {
  visible: boolean;
  onClose: () => void;
  groups: TieGroupView[];
  /** Saves one group's order (server entrant keys, first place first). */
  onSave: (tieKeys: string[]) => Promise<void>;
};

const ordinal = (n: number) => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${s}`;
};

export default function TieOrderSheet({ visible, onClose, groups, onSave }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const sorted = [...groups].sort((a, b) => Number(b.waiting) - Number(a.waiting));
  // Working order per group: entrant keys.
  const [order, setOrder] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reset the working order on open and whenever the groups really change
  // (a reload after a save), not on every parent render.
  const sig = groups.map(g => `${g.key}=${g.entrants.map(e => e.key).join(',')}`).join('|');
  useEffect(() => {
    if (!visible) return;
    const o: Record<string, string[]> = {};
    for (const g of groups) o[g.key] = g.entrants.map(e => e.key);
    setOrder(o);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, sig]);

  const move = (gKey: string, idx: number, dir: -1 | 1) => {
    setOrder(prev => {
      const list = [...(prev[gKey] ?? [])];
      const j = idx + dir;
      if (j < 0 || j >= list.length) return prev;
      [list[idx], list[j]] = [list[j], list[idx]];
      return { ...prev, [gKey]: list };
    });
  };

  const save = async (g: TieGroupView) => {
    const byKey = new Map(g.entrants.map(e => [e.key, e]));
    const keys = (order[g.key] ?? g.entrants.map(e => e.key)).flatMap(k => byKey.get(k)?.tieKeys ?? []);
    setSaving(g.key);
    setError(null);
    try {
      await onSave(keys);
    } catch (e: any) {
      setError(e?.message ?? 'Could not save the tie order.');
    } finally {
      setSaving(null);
    }
  };

  return (
    <BottomSheet visible={visible} onClose={onClose} title="Tie order" subtitle="Still level on W-L and point differential. Put them in finishing order.">
      <ScrollView contentContainerStyle={styles.body}>
        {error ? <Text style={[t.meta, { color: c.danger }]}>{error}</Text> : null}
        {sorted.length === 0 ? <Text style={t.hint}>No ties to order.</Text> : null}
        {sorted.map(g => {
          const byKey = new Map(g.entrants.map(e => [e.key, e]));
          const list = order[g.key] ?? g.entrants.map(e => e.key);
          return (
            <View key={g.key} style={[styles.group, { borderColor: c.border }]}>
              <Text style={t.label}>
                {g.table ? `${g.table}: ` : ''}tied at {ordinal(g.position)} on {g.record}
              </Text>
              <Text style={[t.meta, { color: g.waiting ? c.danger : c.textSub }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
                {g.waiting ? 'Waiting for your order.' : 'Order set. You can change it.'}
              </Text>
              {list.map((k, idx) => (
                <View key={k} style={[styles.row, { borderBottomColor: c.border }, idx === list.length - 1 && styles.lastRow]}>
                  <Text style={[t.sub, styles.place, { color: c.textSub }]}>{g.position + idx}</Text>
                  <Text style={[t.sub, styles.name, { color: c.text }]} numberOfLines={2}>{byKey.get(k)?.name ?? '?'}</Text>
                  <TouchableOpacity
                    style={styles.btn}
                    onPress={() => move(g.key, idx, -1)}
                    disabled={idx === 0}
                    accessibilityRole="button"
                    accessibilityLabel={`Move ${byKey.get(k)?.name ?? ''} up`}
                  >
                    <Icon name="chevron-up" size={20} color={idx === 0 ? c.textMuted : c.primary} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.btn}
                    onPress={() => move(g.key, idx, 1)}
                    disabled={idx === list.length - 1}
                    accessibilityRole="button"
                    accessibilityLabel={`Move ${byKey.get(k)?.name ?? ''} down`}
                  >
                    <Icon name="chevron-down" size={20} color={idx === list.length - 1 ? c.textMuted : c.primary} />
                  </TouchableOpacity>
                </View>
              ))}
              <Button
                size="sm"
                title="Save this order"
                onPress={() => save(g)}
                loading={saving === g.key}
                disabled={saving != null}
                style={styles.save}
              />
            </View>
          );
        })}
      </ScrollView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: SPACE.md, paddingBottom: SPACE.md },
  group: { borderWidth: HAIRLINE, borderRadius: RADIUS.md, padding: SPACE.sm, gap: SPACE.xs },
  row: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, borderBottomWidth: HAIRLINE },
  lastRow: { borderBottomWidth: 0 },
  place: { width: 24 },
  name: { flex: 1, minWidth: 0 },
  btn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  save: { alignSelf: 'flex-start', marginTop: SPACE.xs },
});
