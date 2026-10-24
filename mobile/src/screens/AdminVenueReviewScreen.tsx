// Godmode-only queue of user-submitted (unconfirmed) venues: confirm to publish
// them as trusted catalog entries, or reject to hide them from search. Mirrors
// Doggle's AdminPlaceReviewScreen. Self-guards via the authoritative
// is_godmode_user() RPC (amIGodmode) — don't rely only on the hidden entry point.
import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { Chip, Panel, SectionHeader } from '@just-messin-around/expo-foundation/ui';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import EmptyState from '../components/EmptyState';
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
      <View style={S.gated}>
        <EmptyState
          iconName="block"
          title="Godmode only"
          subtitle="You don't have access to venue moderation."
          actionLabel="Back"
          onAction={() => navigation.goBack()}
        />
      </View>
    );
  }

  return (
    <ScrollView style={S.screen} contentContainerStyle={S.container}>
      <StatusBanner status={status.value} style={S.banner} />
      <SectionHeader title={`${reviews.length} pending submission${reviews.length === 1 ? '' : 's'}`} />

      {reviews.length === 0 ? (
        <Panel>
          <EmptyState compact iconName="celebrate" title="Nothing to review — the queue is clear." />
        </Panel>
      ) : (
        reviews.map((v) => {
          const acting = actingId === v.id;
          return (
            <Panel key={v.id} style={S.card}>
              <Text style={S.name}>{v.name}</Text>
              <View style={S.chipRow}>
                {(v.sport ?? []).map((s) => (
                  <Chip key={s} size="sm" label={s} />
                ))}
                <Chip size="sm" label={v.kind} />
              </View>
              <Text style={S.meta}>
                {[v.city, v.address].filter(Boolean).join(' · ') || `${v.lat.toFixed(4)}, ${v.lng.toFixed(4)}`}
              </Text>
              <Text style={S.meta}>
                by {v.submitter_name || 'unknown'}
                {v.affirmation_count > 0 ? ` · ${v.affirmation_count} agreed` : ''}
              </Text>
              <View style={S.actions}>
                <Button
                  title="Reject"
                  variant="outline"
                  onPress={() => act(v, 'reject')}
                  disabled={acting}
                  accessibilityLabel={`Reject ${v.name}`}
                  style={S.action}
                />
                <Button
                  title="Confirm"
                  onPress={() => act(v, 'confirm')}
                  loading={acting}
                  accessibilityLabel={`Confirm ${v.name}`}
                  style={S.action}
                />
              </View>
            </Panel>
          );
        })
      )}
    </ScrollView>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  const t = textStyles(c);
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.bg },
    container: { padding: SPACE.lg, paddingBottom: SPACE.xl * 2, flexGrow: 1 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: SPACE.xl, backgroundColor: c.bg },
    gated: { flex: 1, justifyContent: 'center', backgroundColor: c.bg },
    banner: { marginBottom: SPACE.md },
    card: { marginBottom: SPACE.md },
    name: { ...t.title, marginBottom: SPACE.sm },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs, marginBottom: SPACE.sm },
    meta: { ...t.hint, marginBottom: SPACE.xxs },
    actions: { flexDirection: 'row', gap: SPACE.sm, marginTop: SPACE.md },
    action: { flex: 1 },
  });
}
