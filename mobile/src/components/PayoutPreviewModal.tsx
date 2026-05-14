import React, { useEffect, useState } from 'react';
import {
  View, Text, Modal, ScrollView, TouchableOpacity, ActivityIndicator, StyleSheet,
} from 'react-native';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import StatusBanner from './StatusBanner';
import { useStatusMessage } from '../lib/useStatusMessage';

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

const PLACE_EMOJI = ['', '🥇', '🥈', '🥉'];

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
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={S.backdrop}>
        <View style={S.card}>
          <Text style={S.title}>🏆 Pay Out Prizes</Text>
          <Text style={S.sub}>
            Auto-resolves the winning teams from the bracket. Each team receives its
            place's share of the pool (e.g. 1st = 60%), and the team prize is split
            equally among its members. Champion badges and a PLUPR bonus are also applied.
          </Text>
          <Text style={S.sub}>Pool: 🥒 {prizePool}</Text>

          {loading ? (
            <ActivityIndicator style={{ marginVertical: 30 }} color={c.primary} />
          ) : rows.length === 0 ? (
            <View style={S.emptyBox}>
              <Text style={S.emptyText}>
                Can't preview a payout — finals series isn't decided yet (or the bracket isn't an MLP playoff).
              </Text>
            </View>
          ) : (
            <ScrollView style={S.list} contentContainerStyle={{ paddingBottom: 8 }}>
              {rows.map((r, i) => {
                const teamSize = r.uids?.length ?? 0;
                return (
                  <View key={`${r.place}-${r.team_id ?? i}`} style={S.placeCard}>
                    <View style={S.placeHeader}>
                      <Text style={S.placeBadge}>
                        {PLACE_EMOJI[r.place] ?? `#${r.place}`} {r.team_name ?? '—'}
                      </Text>
                      <Text style={S.placeShare}>🥒 {r.pool_share}</Text>
                    </View>
                    <Text style={S.placeMeta}>
                      Team prize 🥒 {r.pool_share} ÷ {teamSize} {teamSize === 1 ? 'player' : 'players'} = 🥒 {r.share_per_user} each · +{r.plupr_bonus} PLUPR · 🏅 Champion badge
                    </Text>
                    <View style={S.userList}>
                      {(r.user_names ?? []).map((n, j) => (
                        <View key={j} style={S.userRow}>
                          <Text style={S.userName} numberOfLines={1}>{n}</Text>
                          <Text style={S.userShare}>+🥒 {r.share_per_user}</Text>
                        </View>
                      ))}
                    </View>
                  </View>
                );
              })}
              <View style={S.totalBox}>
                <Text style={S.totalLabel}>Total distributed</Text>
                <Text style={S.totalValue}>🥒 {totalDistributed}</Text>
              </View>
            </ScrollView>
          )}

          <StatusBanner status={status.value} />

          <View style={S.btnRow}>
            <TouchableOpacity style={[S.btn, S.btnCancel]} onPress={onClose} disabled={busy}>
              <Text style={S.btnCancelText}>Close</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[S.btn, S.btnConfirm, (busy || rows.length === 0) && S.btnDisabled]}
              onPress={confirm}
              disabled={busy || rows.length === 0}
            >
              {busy
                ? <ActivityIndicator color="#fff" />
                : <Text style={S.btnConfirmText}>Confirm Payout</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    backdrop:    { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 16 },
    card:        { backgroundColor: c.surface, borderRadius: 16, padding: 18, maxWidth: 520, width: '100%', alignSelf: 'center', maxHeight: '90%' },
    title:       { fontSize: 19, fontWeight: '900', color: c.text, marginBottom: 4 },
    sub:         { fontSize: 12, color: c.textSub, lineHeight: 17, marginBottom: 4 },

    list:        { marginTop: 10, maxHeight: 400 },
    placeCard:   { backgroundColor: c.surfaceAlt, borderRadius: 12, padding: 12, marginBottom: 10, borderWidth: 1, borderColor: c.border },
    placeHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
    placeBadge:  { fontSize: 15, fontWeight: '900', color: c.text },
    placeShare:  { fontSize: 14, fontWeight: '800', color: c.primary },
    placeMeta:   { fontSize: 11, color: c.textMuted, marginBottom: 8, fontStyle: 'italic' },
    userList:    { gap: 4 },
    userRow:     { flexDirection: 'row', justifyContent: 'space-between', backgroundColor: c.surface, borderRadius: 8, paddingVertical: 6, paddingHorizontal: 10, borderWidth: 1, borderColor: c.border },
    userName:    { flex: 1, fontSize: 13, color: c.text, fontWeight: '600' },
    userShare:   { fontSize: 13, color: c.primary, fontWeight: '800' },

    totalBox:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderTopWidth: 1, borderTopColor: c.border, paddingTop: 10, marginTop: 6 },
    totalLabel:  { fontSize: 13, color: c.textSub, fontWeight: '700' },
    totalValue:  { fontSize: 16, color: c.primary, fontWeight: '900' },

    emptyBox:    { padding: 20, alignItems: 'center' },
    emptyText:   { fontSize: 13, color: c.textMuted, textAlign: 'center', lineHeight: 18 },

    btnRow:      { flexDirection: 'row', gap: 10, marginTop: 14 },
    btn:         { flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
    btnCancel:   { backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
    btnCancelText: { color: c.textSub, fontWeight: '700' },
    btnConfirm:  { backgroundColor: c.primary },
    btnConfirmText: { color: '#fff', fontWeight: '900' },
    btnDisabled: { opacity: 0.5 },
  });
}
