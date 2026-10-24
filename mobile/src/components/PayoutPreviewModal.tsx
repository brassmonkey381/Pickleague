import React, { useEffect, useState } from 'react';
import {
  View, Text, Modal, ScrollView, ActivityIndicator, StyleSheet,
  Pressable, Platform,
} from 'react-native';
import { RankMedal } from '@just-messin-around/expo-foundation/ui';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { HAIRLINE, RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import StatusBanner from './StatusBanner';
import { useStatusMessage } from '../lib/useStatusMessage';
import { PickleAmount, picklesLabel } from './PickleAmount';

type PreviewRow = {
  place:           number;
  team_id:         string | null;
  team_name:       string | null;
  uids:            string[] | null;
  user_names:      string[] | null;
  pool_share:      number;
  share_per_user:  number;
  plupr_bonus:     number;
};

type Props = {
  visible: boolean;
  tournamentId: string;
  prizePool: number;
  onClose: () => void;
  onPaid: () => void;
};

export default function PayoutPreviewModal({ visible, tournamentId, prizePool, onClose, onPaid }: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);
  const status = useStatusMessage();

  const [rows, setRows]       = useState<PreviewRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy]       = useState(false);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    (async () => {
      setLoading(true);
      status.clear();
      const { data, error } = await supabase.rpc('preview_tournament_payout', {
        p_tournament_id: tournamentId,
      });
      if (!alive) return;
      setLoading(false);
      if (error) {
        console.warn('[PayoutPreviewModal] preview error', error);
        status.errorFromRpc(error, 'supabase/migration_universal_tournament_payout.sql');
        setRows([]);
        return;
      }
      setRows((data ?? []) as PreviewRow[]);
    })();
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, tournamentId]);

  async function confirm() {
    setBusy(true);
    status.clear();
    const { data, error } = await supabase.rpc('auto_payout_tournament', {
      p_tournament_id: tournamentId,
    });
    setBusy(false);
    if (error) {
      console.warn('[PayoutPreviewModal] payout error', error);
      status.errorFromRpc(error, 'supabase/migration_universal_tournament_payout.sql');
      return;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.success) {
      status.error(row?.message ?? 'Payout failed.');
      return;
    }
    status.success(row.message ?? 'Prizes paid out.');
    onPaid();
  }

  const totalDistributed = rows.reduce(
    (sum, r) => sum + (r.share_per_user || 0) * (r.uids?.length ?? 0),
    0,
  );

  return (
    // Escape (web) and Android back both arrive here; neither closes mid-payout.
    <Modal visible={visible} transparent animationType="slide" onRequestClose={() => { if (!busy) onClose(); }}>
      <Pressable
        style={S.backdrop}
        onPress={Platform.OS === 'web' ? (e: any) => {
          if (busy) return;
          if (e.target === e.currentTarget) onClose();
        } : undefined}
      >
        <View style={S.card}>
          <View style={S.titleRow}>
            <Icon name="trophy" size={20} color={c.rarityLegendary} />
            <Text style={S.title} accessibilityRole="header">Pay Out Prizes</Text>
          </View>
          <Text style={S.sub}>
            Auto-resolves the winning teams from the bracket. Each team receives its
            place's share of the pool (e.g. 1st = 60%), and the team prize is split
            equally among its members. Champion badges and a PLUPR bonus are also applied.
          </Text>
          <View style={S.poolRow}>
            <Text style={S.subInline}>Pool:</Text>
            <PickleAmount amount={prizePool} preset="sub" color={c.text} iconColor={c.primary} />
          </View>

          {loading ? (
            <ActivityIndicator style={S.spinner} color={c.primary} />
          ) : rows.length === 0 ? (
            <View style={S.emptyBox}>
              <Text style={S.emptyText}>
                Can't preview a payout — finals series isn't decided yet (or the bracket isn't an MLP playoff).
              </Text>
            </View>
          ) : (
            <ScrollView style={S.list} contentContainerStyle={{ paddingBottom: SPACE.sm }}>
              {rows.map((r, i) => {
                const teamSize = r.uids?.length ?? 0;
                return (
                  <View key={`${r.place}-${r.team_id ?? i}`} style={S.placeCard}>
                    <View style={S.placeHeader}>
                      <View style={S.placeBadgeRow}>
                        <RankMedal place={r.place} />
                        <Text style={S.placeBadge} numberOfLines={1}>{r.team_name ?? '—'}</Text>
                      </View>
                      <PickleAmount amount={r.pool_share} preset="title" textStyle={S.heavy} />
                    </View>
                    <Text style={S.placeMeta}>
                      Team prize {picklesLabel(r.pool_share)} ÷ {teamSize} {teamSize === 1 ? 'player' : 'players'} = {picklesLabel(r.share_per_user)} each · +{r.plupr_bonus} PLUPR · Champion badge
                    </Text>
                    <View style={S.userList}>
                      {(r.user_names ?? []).map((n, j) => (
                        <View key={j} style={S.userRow}>
                          <Text style={S.userName} numberOfLines={1}>{n}</Text>
                          <PickleAmount amount={r.share_per_user} prefix="+" preset="sub" textStyle={S.heavy} />
                        </View>
                      ))}
                    </View>
                  </View>
                );
              })}
              <View style={S.totalBox}>
                <Text style={S.totalLabel}>Total distributed</Text>
                <PickleAmount amount={totalDistributed} preset="h3" textStyle={S.black} />
              </View>
            </ScrollView>
          )}

          <StatusBanner status={status.value} />

          <View style={S.btnRow}>
            <Button title="Close" variant="outline" onPress={onClose} disabled={busy} style={S.btn} />
            <Button
              title="Confirm Payout"
              onPress={confirm}
              loading={busy}
              disabled={rows.length === 0}
              style={S.btn}
            />
          </View>
        </View>
      </Pressable>
    </Modal>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  const t = textStyles(c);
  return StyleSheet.create({
    backdrop:    { flex: 1, backgroundColor: c.backdrop, justifyContent: 'center', padding: SPACE.lg },
    card:        { backgroundColor: c.surface, borderRadius: RADIUS.lg, padding: SPACE.lg, maxWidth: 520, width: '100%', alignSelf: 'center', maxHeight: '90%', flexDirection: 'column' },
    titleRow:    { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, marginBottom: SPACE.xs },
    title:       { ...t.h3, fontWeight: FONT.weight.heavy, flexShrink: 1 },
    sub:         { ...t.sub, marginBottom: SPACE.xs },
    subInline:   t.sub,
    poolRow:     { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, marginBottom: SPACE.xs },
    spinner:     { marginVertical: SPACE.xl },

    list:        { marginTop: SPACE.sm, flex: 1 },
    placeCard:   { backgroundColor: c.surfaceAlt, borderRadius: RADIUS.md, padding: SPACE.md, marginBottom: SPACE.sm, borderWidth: HAIRLINE, borderColor: c.border },
    placeHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: SPACE.sm, marginBottom: SPACE.xs },
    placeBadgeRow: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
    placeBadge:  { ...t.title, fontWeight: FONT.weight.black, flexShrink: 1 },
    heavy:       { fontWeight: FONT.weight.heavy },
    black:       { fontWeight: FONT.weight.black },
    placeMeta:   { ...t.caption, marginBottom: SPACE.sm, fontStyle: 'italic' },
    userList:    { gap: SPACE.xs },
    userRow:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: SPACE.sm, backgroundColor: c.surface, borderRadius: RADIUS.sm, paddingVertical: SPACE.xs, paddingHorizontal: SPACE.sm, borderWidth: HAIRLINE, borderColor: c.border },
    userName:    { flex: 1, fontSize: FONT.size.base, color: c.text, fontWeight: FONT.weight.semibold },

    totalBox:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderTopWidth: HAIRLINE, borderTopColor: c.border, paddingTop: SPACE.sm, marginTop: SPACE.xs },
    totalLabel:  { ...t.sub, fontWeight: FONT.weight.bold },

    emptyBox:    { padding: SPACE.lg, alignItems: 'center' },
    emptyText:   { ...t.hint, textAlign: 'center' },

    btnRow:      { flexDirection: 'row', gap: SPACE.sm, marginTop: SPACE.md },
    btn:         { flex: 1 },
  });
}
