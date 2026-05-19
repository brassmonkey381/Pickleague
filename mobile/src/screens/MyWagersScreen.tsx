import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { RootStackParamList, Wager } from '../types';
import { cancelWager, genericSubjectLabel, WagerStatus } from '../lib/wager';
import ConfirmModal from '../components/ConfirmModal';
import StatusBanner from '../components/StatusBanner';
import { useStatusMessage } from '../lib/useStatusMessage';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'MyWagers'> };

const TABS: { key: WagerStatus; label: string }[] = [
  { key: 'open',      label: 'Open' },
  { key: 'won',       label: 'Won' },
  { key: 'lost',      label: 'Lost' },
  { key: 'cancelled', label: 'Cancelled' },
];

function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'Just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function MyWagersScreen({ navigation: _ }: Props) {
  const { colors: c } = useTheme();
  const S = useMemo(() => makeStyles(c), [c]);
  const status = useStatusMessage();

  const [wagers, setWagers]   = useState<Wager[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab]         = useState<WagerStatus>('open');
  const [cancelTarget, setCancelTarget] = useState<Wager | null>(null);
  const [cancelling, setCancelling] = useState(false);

  useFocusEffect(useCallback(() => { load(); }, []));

  async function load() {
    setLoading(true);
    const { data, error } = await supabase
      .from('wagers')
      .select('*')
      .order('placed_at', { ascending: false });
    if (error) status.error(error.message);
    setWagers((data ?? []) as Wager[]);
    setLoading(false);
  }

  const counts = useMemo(() => {
    const out: Record<WagerStatus, number> = { open: 0, won: 0, lost: 0, cancelled: 0 };
    for (const w of wagers) out[w.status] += 1;
    return out;
  }, [wagers]);

  const visible = useMemo(() => wagers.filter(w => w.status === tab), [wagers, tab]);

  async function confirmCancel() {
    if (!cancelTarget) return;
    setCancelling(true);
    const r = await cancelWager(cancelTarget.id);
    setCancelling(false);
    setCancelTarget(null);
    if (!r.success) {
      status.error(r.message || 'Could not cancel wager.');
      return;
    }
    status.success(r.message || 'Wager cancelled.');
    load();
  }

  function renderItem({ item }: { item: Wager }) {
    const label = genericSubjectLabel(item.subject_type, item.predicate || {});
    const settledLabel = item.settled_at ? timeAgo(item.settled_at) : '';
    const placedLabel  = timeAgo(item.placed_at);

    return (
      <View style={S.row}>
        <View style={{ flex: 1 }}>
          <Text style={S.rowSubject} numberOfLines={2}>{label}</Text>
          <View style={S.metaRow}>
            <Text style={S.metaText}>Stake: <Text style={S.metaValue}>{item.stake} 🥒</Text></Text>
            <Text style={S.metaText}>Odds: <Text style={S.metaValue}>{Number(item.odds).toFixed(2)}×</Text></Text>
            <Text style={S.metaText}>To win: <Text style={S.metaValue}>{item.potential_payout} 🥒</Text></Text>
          </View>
          <Text style={S.timestamp}>
            {item.status === 'open'
              ? `Placed ${placedLabel}`
              : `Placed ${placedLabel} · ${STATUS_LABEL[item.status]} ${settledLabel}`}
          </Text>
        </View>
        {item.status === 'open' && (
          <TouchableOpacity style={S.cancelBtn} onPress={() => setCancelTarget(item)}>
            <Text style={S.cancelBtnText}>Cancel</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <StatusBanner status={status.value} style={{ marginHorizontal: 16, marginTop: 8 }} />

      <View style={S.tabs}>
        {TABS.map(t => (
          <TouchableOpacity
            key={t.key}
            style={[S.tab, tab === t.key && S.tabActive]}
            onPress={() => setTab(t.key)}
            activeOpacity={0.7}
          >
            <Text style={[S.tabText, tab === t.key && S.tabTextActive]}>
              {t.label} {counts[t.key] > 0 ? `(${counts[t.key]})` : ''}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <View style={S.center}><ActivityIndicator color={c.primary} /></View>
      ) : visible.length === 0 ? (
        <View style={S.center}>
          <Text style={S.emptyEmoji}>🎲</Text>
          <Text style={S.emptyTitle}>No {tab} wagers</Text>
          <Text style={S.emptyBody}>
            {tab === 'open'
              ? 'Place a wager from a match or tournament to see it here.'
              : `You don't have any ${tab} wagers yet.`}
          </Text>
        </View>
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(w) => w.id}
          renderItem={renderItem}
          contentContainerStyle={{ padding: 16 }}
          ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
        />
      )}

      <ConfirmModal
        visible={cancelTarget != null}
        title="Cancel wager?"
        body="Your stake will be refunded immediately."
        primaryLabel="Cancel wager"
        cancelLabel="Keep"
        variant="danger"
        busy={cancelling}
        onConfirm={confirmCancel}
        onClose={() => (cancelling ? null : setCancelTarget(null))}
      />
    </View>
  );
}

const STATUS_LABEL: Record<WagerStatus, string> = {
  open: 'Open', won: 'Won', lost: 'Lost', cancelled: 'Cancelled',
};

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    tabs:        { flexDirection: 'row', gap: 6, paddingHorizontal: 16, paddingTop: 12 },
    tab:         { flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 8, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
    tabActive:   { backgroundColor: c.primary, borderColor: c.primary },
    tabText:     { fontSize: 12, fontWeight: '700', color: c.textSub },
    tabTextActive:{ color: '#fff' },

    center:      { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
    emptyEmoji:  { fontSize: 48, marginBottom: 10 },
    emptyTitle:  { fontSize: 18, fontWeight: '800', color: c.text, marginBottom: 6 },
    emptyBody:   { fontSize: 13, color: c.textSub, textAlign: 'center', lineHeight: 19 },

    row:         { flexDirection: 'row', alignItems: 'center', gap: 10,
                   backgroundColor: c.surface, borderRadius: 12, padding: 14,
                   borderWidth: 1, borderColor: c.border },
    rowSubject:  { fontSize: 14, fontWeight: '700', color: c.text, lineHeight: 19 },
    metaRow:     { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 6 },
    metaText:    { fontSize: 12, color: c.textSub },
    metaValue:   { color: c.text, fontWeight: '700' },
    timestamp:   { fontSize: 11, color: c.textMuted, marginTop: 6 },

    cancelBtn:    { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
    cancelBtnText:{ color: c.danger, fontWeight: '700', fontSize: 12 },
  });
}
