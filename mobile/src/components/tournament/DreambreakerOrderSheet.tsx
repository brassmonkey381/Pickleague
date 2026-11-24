// PKL-086: set a team's order of play for a rotating MLP Dreambreaker (all 4 play singles in turn, rotating every 4
// rally points). Open to the team's own players and the tournament's admins, until a score is in; the server
// (mlp_set_dreambreaker_order) checks the same.
import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { BottomSheet } from '@just-messin-around/expo-foundation/ui';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import { FONT } from '@just-messin-around/expo-foundation/typography';
import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import { useTheme } from '../../lib/ThemeContext';
import { supabase } from '../../lib/supabase';
import { shortName } from '../../lib/finishShare';
import { DREAMBREAKER_RULE, moveInOrder } from '../../lib/mlpDreambreaker';
import { explainRefusal } from '../../lib/refusalNotices';

type Props = {
  match: { id: string; db_order_team1: string[]; db_order_team2: string[] } | null;
  team: 1 | 2;
  playerName: (id: string) => string;
  onClose: () => void;
  /** After a save: reload the schedule. */
  onSaved: () => void;
};

export default function DreambreakerOrderSheet({ match, team, playerName, onClose, onSaved }: Props) {
  const { colors: c } = useTheme();
  const [order, setOrder] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setOrder(match ? [...(team === 1 ? match.db_order_team1 : match.db_order_team2)] : []);
    setErr(null);
  }, [match, team]);

  async function save() {
    if (!match) return;
    setBusy(true); setErr(null);
    try {
      await sbCall(() => supabase.rpc('mlp_set_dreambreaker_order', { p_match_id: match.id, p_team: team, p_order: order }));
      onSaved();
      onClose();
    } catch (e) {
      setErr(explainRefusal(e, "Couldn't save the order. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet visible={!!match} onClose={onClose} title="Dreambreaker order of play" subtitle={DREAMBREAKER_RULE}>
      <Text style={[styles.help, { color: c.textMuted }]}>Player 1 serves first. Each player plays 4 rally points, then the next one steps in.</Text>
      {order.map((id, k) => (
        <View key={id} style={[styles.row, { borderColor: c.border }]}>
          <Text style={[styles.num, { color: c.textMuted }]}>{k + 1}</Text>
          <Text style={[styles.name, { color: c.text }]} numberOfLines={1}>{shortName(playerName(id))}</Text>
          <TouchableOpacity disabled={k === 0 || busy} onPress={() => setOrder(o => moveInOrder(o, k, -1))}
            accessibilityRole="button" accessibilityLabel={`Move ${playerName(id)} up`} style={styles.arrow}>
            <Icon name="chevron-up" size={20} color={k === 0 ? c.border : c.primary} />
          </TouchableOpacity>
          <TouchableOpacity disabled={k === order.length - 1 || busy} onPress={() => setOrder(o => moveInOrder(o, k, 1))}
            accessibilityRole="button" accessibilityLabel={`Move ${playerName(id)} down`} style={styles.arrow}>
            <Icon name="chevron-down" size={20} color={k === order.length - 1 ? c.border : c.primary} />
          </TouchableOpacity>
        </View>
      ))}
      {err ? <Text style={[styles.err, { color: c.danger }]}>{err}</Text> : null}
      <TouchableOpacity onPress={save} disabled={busy} accessibilityRole="button"
        style={[styles.save, { backgroundColor: c.primary, opacity: busy ? 0.6 : 1 }]}>
        {busy ? <ActivityIndicator color={c.textInverse} /> : <Text style={[styles.saveText, { color: c.textInverse }]}>Save order</Text>}
      </TouchableOpacity>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  help: { fontSize: FONT.size.sm, marginBottom: SPACE.sm },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: SPACE.xs, borderBottomWidth: StyleSheet.hairlineWidth },
  num: { width: 24, fontSize: FONT.size.md, fontWeight: FONT.weight.bold },
  name: { flex: 1, fontSize: FONT.size.md },
  arrow: { padding: SPACE.xs, minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  err: { fontSize: FONT.size.sm, marginTop: SPACE.sm },
  save: { marginTop: SPACE.md, borderRadius: RADIUS.md, paddingVertical: SPACE.md, alignItems: 'center' },
  saveText: { fontSize: FONT.size.md, fontWeight: FONT.weight.bold },
});
