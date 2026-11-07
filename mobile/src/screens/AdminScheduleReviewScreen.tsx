// Godmode-only court schedule review (supabase/migration_court_schedules.sql):
// pages the Monday check saw change, and player suggestions. The check keeps
// only a hash, so a person opens the page and reads it.
//
//   Done: the sessions are right, so that page's sessions count as confirmed.
//   Dismiss: nothing to do.
//
// Mirrors AdminVenueReviewScreen. Self-guards via amIGodmode.
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Panel, SectionHeader, TextLink } from '@just-messin-around/expo-foundation/ui';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import EmptyState from '../components/EmptyState';
import StatusBanner from '../components/StatusBanner';
import { useTheme } from '../lib/ThemeContext';
import { useStatusMessage } from '../lib/useStatusMessage';
import { amIGodmode } from '../data/venueAdmin';
import {
  adminResolveScheduleProposal,
  adminScheduleReview,
  type ScheduleProposal,
  type ScheduleReview,
} from '../data/courtSchedules';
import type { RootStackParamList } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'AdminScheduleReview'>;

function shortDate(iso: string | null): string {
  if (!iso) return 'never';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function AdminScheduleReviewScreen({ navigation }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const status = useStatusMessage();
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [review, setReview] = useState<ScheduleReview | null>(null);
  const [failed, setFailed] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const ok = await amIGodmode();
    setAuthorized(ok);
    if (!ok) return;
    try {
      setReview(await adminScheduleReview());
    } catch (e: any) {
      setFailed(true);
      status.error(e?.message ?? 'Could not load the schedule review.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function resolve(p: ScheduleProposal, next: 'applied' | 'dismissed') {
    setActingId(p.id);
    status.clear();
    try {
      await adminResolveScheduleProposal(p.id, next);
      setReview((r) => (r ? { ...r, proposals: r.proposals.filter((x) => x.id !== p.id) } : r));
    } catch (e: any) {
      status.error(e?.message ?? 'That did not save. Try again.');
    } finally {
      setActingId(null);
    }
  }

  if (authorized === null || (authorized && !review && !failed)) {
    return (
      <View style={[S.center, { backgroundColor: c.bg }]}>
        <ActivityIndicator size="large" color={c.primary} />
      </View>
    );
  }
  if (!authorized) {
    return (
      <View style={[S.center, { backgroundColor: c.bg }]}>
        <EmptyState
          iconName="block"
          title="Godmode only"
          subtitle="You don't have access to schedule review."
          actionLabel="Back"
          onAction={() => navigation.goBack()}
        />
      </View>
    );
  }

  const proposals = review?.proposals ?? [];
  const sources = review?.sources ?? [];
  return (
    <ScrollView style={{ backgroundColor: c.bg }} contentContainerStyle={S.container}>
      <StatusBanner status={status.value} />
      <SectionHeader title="To review" count={String(proposals.length)} />
      {proposals.length === 0 ? (
        <Panel>
          <EmptyState compact iconName="celebrate" title="Nothing to review." />
        </Panel>
      ) : (
        proposals.map((p) => (
          <Panel key={p.id} style={S.card}>
            <Text style={t.title}>
              {p.kind === 'page_changed' ? `${p.source_name ?? 'A page'} changed` : `Suggestion: ${p.venue_name ?? 'a court'}`}
            </Text>
            {p.note ? <Text style={t.body}>{p.note}</Text> : null}
            <Text style={t.meta}>{shortDate(p.created_at)}</Text>
            {p.source_url ? (
              <TextLink label="Open the page" iconName="link" onPress={() => void Linking.openURL(p.source_url as string)} />
            ) : null}
            <View style={S.actions}>
              <Button
                title="Dismiss"
                variant="outline"
                disabled={actingId === p.id}
                onPress={() => void resolve(p, 'dismissed')}
                style={S.action}
              />
              <Button title="Done" loading={actingId === p.id} onPress={() => void resolve(p, 'applied')} style={S.action} />
            </View>
          </Panel>
        ))
      )}

      <SectionHeader title="Pages" count={String(sources.length)} />
      <Panel>
        {sources.map((s) => (
          <View key={s.id} style={S.source}>
            <Text style={t.body}>{s.name}</Text>
            <Text style={t.meta}>
              {s.method === 'manual'
                ? 'Checked by hand'
                : `Checked ${shortDate(s.last_checked_at)}${s.last_status && s.last_status !== 'ok' ? `: ${s.last_status}` : ''}`}
            </Text>
          </View>
        ))}
      </Panel>
    </ScrollView>
  );
}

const S = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: SPACE.lg },
  container: { padding: SPACE.lg, gap: SPACE.sm },
  card: { gap: SPACE.xs },
  actions: { flexDirection: 'row', gap: SPACE.sm, marginTop: SPACE.xs },
  action: { flex: 1 },
  source: { paddingVertical: SPACE.xs },
});
