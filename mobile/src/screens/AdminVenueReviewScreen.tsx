// Godmode-only queue of user-submitted (unconfirmed) venues: confirm to publish
// them as trusted catalog entries, or reject to hide them from search. Mirrors
// Doggle's AdminPlaceReviewScreen. Self-guards via the authoritative
// is_godmode_user() RPC (amIGodmode) — don't rely only on the hidden entry point.
import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../lib/ThemeContext';
import { useStatusMessage } from '../lib/useStatusMessage';
import StatusBanner from '../components/StatusBanner';
import type { RootStackParamList } from '../types';
import {
  amIGodmode,
  listAdminVenueReviews,
  adminReviewVenue,
  type VenueReview,
  type VenueReviewAction,
} from '../data/venueAdmin';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'AdminVenueReview'> };

export default function AdminVenueReviewScreen({ navigation }: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);
  const status = useStatusMessage();

  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [reviews, setReviews] = useState<VenueReview[]>([]);
  const [actingId, setActingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const ok = await amIGodmode();
    setAuthorized(ok);
    if (ok) {
      try {
        setReviews(await listAdminVenueReviews());
      } catch (e: any) {
        status.error(e?.message ?? 'Could not load the review queue.');
      }
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function act(venue: VenueReview, action: VenueReviewAction) {
    setActingId(venue.id);
    status.clear();
    try {
      await adminReviewVenue(venue.id, action);
      setReviews((prev) => prev.filter((r) => r.id !== venue.id));
      status.success(action === 'confirm' ? `Confirmed “${venue.name}”` : `Rejected “${venue.name}”`);
    } catch (e: any) {
      status.error(e?.message ?? 'Action failed.');
    } finally {
      setActingId(null);
    }
  }

  if (loading || authorized === null) {
    return (
      <View style={S.center}>
        <ActivityIndicator size="large" color={c.primary} />
      </View>
    );
  }

  if (!authorized) {
    return (
      <View style={S.center}>
        <Text style={S.gatedTitle}>🚫 Godmode only</Text>
        <Text style={S.gatedBody}>You don't have access to venue moderation.</Text>
        <TouchableOpacity style={S.secondaryBtn} onPress={() => navigation.goBack()}>
          <Text style={S.secondaryBtnText}>Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={S.container}>
      <StatusBanner status={status.value} style={S.banner} />
      <Text style={S.sectionHeader}>
        {reviews.length} pending submission{reviews.length === 1 ? '' : 's'}
      </Text>

      {reviews.length === 0 ? (
        <View style={S.emptyCard}>
          <Text style={S.emptyText}>Nothing to review — the queue is clear. 🎉</Text>
        </View>
      ) : (
        reviews.map((v) => {
          const acting = actingId === v.id;
          return (
            <View key={v.id} style={S.card}>
              <Text style={S.name}>{v.name}</Text>
              <View style={S.chipRow}>
                {(v.sport ?? []).map((s) => (
                  <View key={s} style={S.chip}>
                    <Text style={S.chipText}>{s}</Text>
                  </View>
                ))}
                <View style={S.chip}>
                  <Text style={S.chipText}>{v.kind}</Text>
                </View>
              </View>
              <Text style={S.meta}>
                {[v.city, v.address].filter(Boolean).join(' · ') || `${v.lat.toFixed(4)}, ${v.lng.toFixed(4)}`}
              </Text>
              <Text style={S.meta}>
                by {v.submitter_name || 'unknown'}
                {v.affirmation_count > 0 ? ` · ${v.affirmation_count} agreed` : ''}
              </Text>
              <View style={S.actions}>
                <TouchableOpacity
                  style={[S.rejectBtn, acting && S.dim]}
                  onPress={() => act(v, 'reject')}
                  disabled={acting}
                >
                  <Text style={S.rejectBtnText}>Reject</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[S.confirmBtn, acting && S.dim]}
                  onPress={() => act(v, 'confirm')}
                  disabled={acting}
                >
                  {acting ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <Text style={S.confirmBtnText}>Confirm</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          );
        })
      )}
    </ScrollView>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { padding: 16, backgroundColor: c.bg, flexGrow: 1 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, backgroundColor: c.bg },
    banner: { marginBottom: 12 },
    sectionHeader: { fontSize: 13, fontWeight: '800', color: c.textSub, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 10 },
    card: { backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 12, padding: 14, marginBottom: 12 },
    name: { fontSize: 16, fontWeight: '800', color: c.text, marginBottom: 8 },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
    chip: { borderWidth: 1, borderColor: c.border, borderRadius: 14, paddingVertical: 4, paddingHorizontal: 10, backgroundColor: c.bg },
    chipText: { fontSize: 12, color: c.textSub, fontWeight: '600' },
    meta: { fontSize: 13, color: c.textMuted, marginBottom: 2 },
    actions: { flexDirection: 'row', gap: 10, marginTop: 12 },
    rejectBtn: { flex: 1, borderWidth: 1, borderColor: c.border, borderRadius: 10, paddingVertical: 11, alignItems: 'center', backgroundColor: c.surface },
    rejectBtnText: { color: c.textSub, fontWeight: '700', fontSize: 15 },
    confirmBtn: { flex: 1, backgroundColor: c.primary, borderRadius: 10, paddingVertical: 11, alignItems: 'center' },
    confirmBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
    dim: { opacity: 0.5 },
    emptyCard: { backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 12, padding: 24, alignItems: 'center' },
    emptyText: { color: c.textSub, fontSize: 14 },
    gatedTitle: { fontSize: 20, fontWeight: '800', color: c.text, marginBottom: 8 },
    gatedBody: { fontSize: 14, color: c.textSub, marginBottom: 20, textAlign: 'center' },
    secondaryBtn: { borderWidth: 1, borderColor: c.primary, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 20 },
    secondaryBtnText: { color: c.primary, fontWeight: '700' },
  });
}
