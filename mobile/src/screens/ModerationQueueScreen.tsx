// Godmode-only report queue. This is the half of Guideline 1.2 that Apple
// cannot see in the binary but asks about anyway: reports have to be acted on
// within 24 hours, by removing the content and ejecting the author. Self-guards
// via the authoritative is_godmode_user() RPC — the hidden Settings entry point
// is not the boundary. Mirrors AdminVenueReviewScreen.
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, Image,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { useTheme } from '../lib/ThemeContext';
import { useStatusMessage } from '../lib/useStatusMessage';
import StatusBanner from '../components/StatusBanner';
import ConfirmModal from '../components/ConfirmModal';
import EmptyState from '../components/EmptyState';
import type { RootStackParamList } from '../types';
import { amIGodmode } from '../data/venueAdmin';
import { REPORT_REASONS } from '../lib/moderation';
import {
  listReports, takeDownAvatar, ejectUser, resolveReport, isOverdue,
  type ModerationReport,
} from '../data/moderationAdmin';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'ModerationQueue'> };
type Pending = { report: ModerationReport; action: 'avatar' | 'eject' };

export default function ModerationQueueScreen({ navigation }: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);
  const status = useStatusMessage();

  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [loading, setLoading]       = useState(true);
  const [showAll, setShowAll]       = useState(false);
  const [reports, setReports]       = useState<ModerationReport[]>([]);
  const [actingId, setActingId]     = useState<string | null>(null);
  const [pending, setPending]       = useState<Pending | null>(null);

  const load = useCallback(async (all: boolean) => {
    setLoading(true);
    const ok = await amIGodmode();
    setAuthorized(ok);
    if (ok) {
      try {
        setReports(await listReports(all ? 'all' : 'open'));
      } catch (e) {
        status.error(friendlySbMessage(e, 'Could not load the report queue.'));
      }
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(showAll); }, [load, showAll]);

  async function run(p: Pending) {
    setActingId(p.report.id);
    status.clear();
    try {
      if (p.action === 'avatar') {
        await takeDownAvatar(p.report.subject_user_id, 'Profile photo removed after report');
        status.success('Photo removed and the report closed.');
      } else {
        await ejectUser(p.report.subject_user_id, 'Account removed after report');
        status.success('Account removed and the report closed.');
      }
      setPending(null);
      await load(showAll);
    } catch (e) {
      status.error(friendlySbMessage(e, "That action didn't go through."));
    } finally {
      setActingId(null);
    }
  }

  async function dismiss(r: ModerationReport) {
    setActingId(r.id);
    try {
      await resolveReport(r.id, 'dismissed', 'No action needed');
      status.success('Report dismissed.');
      await load(showAll);
    } catch (e) {
      status.error(friendlySbMessage(e, "Couldn't dismiss that report."));
    } finally {
      setActingId(null);
    }
  }

  if (loading && authorized === null) {
    return <View style={S.center}><ActivityIndicator size="large" color={c.primary} /></View>;
  }
  if (authorized === false) {
    return (
      <View style={S.center}>
        <EmptyState icon="🔒" title="Not authorised" subtitle="This queue is godmode-only." />
      </View>
    );
  }

  const open = reports.filter(r => r.status === 'open');
  const overdue = open.filter(isOverdue).length;

  return (
    <ScrollView style={S.page} contentContainerStyle={S.content}>
      <StatusBanner status={status.value} />

      <View style={S.summary}>
        <Text style={S.summaryNum}>{open.length}</Text>
        <Text style={S.summaryLabel}>open {open.length === 1 ? 'report' : 'reports'}</Text>
        {overdue > 0 && (
          <View style={S.overduePill}>
            <Text style={S.overdueText}>{overdue} past 24h</Text>
          </View>
        )}
      </View>

      <TouchableOpacity style={S.toggle} onPress={() => setShowAll(v => !v)}>
        <Text style={S.toggleText}>{showAll ? 'Show open only' : 'Show resolved too'}</Text>
      </TouchableOpacity>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 24 }} color={c.primary} />
      ) : reports.length === 0 ? (
        <EmptyState
          icon="✅"
          title="Nothing to review"
          subtitle="Reports filed from a player's ⋯ menu land here."
        />
      ) : (
        reports.map(r => {
          const reason = REPORT_REASONS.find(x => x.key === r.reason)?.label ?? r.reason;
          const busy   = actingId === r.id;
          const snap   = r.snapshot ?? {};
          return (
            <View key={r.id} style={[S.card, isOverdue(r) && S.cardOverdue]}>
              <View style={S.cardTop}>
                <Text style={S.reason}>{reason}</Text>
                <Text style={S.when}>{new Date(r.created_at).toLocaleString()}</Text>
              </View>

              <TouchableOpacity
                style={S.subjectRow}
                onPress={() => navigation.navigate('PlayerProfile', { userId: r.subject_user_id, userName: r.subject?.full_name ?? 'Player' })}
              >
                {r.subject?.avatar_url
                  ? <Image source={{ uri: r.subject.avatar_url }} style={S.avatar} />
                  : <View style={[S.avatar, S.avatarFallback]}><Text>👤</Text></View>}
                <View style={{ flex: 1 }}>
                  <Text style={S.subjectName}>{r.subject?.full_name ?? 'Unknown player'}</Text>
                  <Text style={S.meta}>
                    reported by {r.reporter?.full_name ?? 'someone'} · {r.subject_type}
                  </Text>
                </View>
              </TouchableOpacity>

              {r.details ? <Text style={S.details}>“{r.details}”</Text> : null}

              {Object.keys(snap).length > 0 && (
                <View style={S.snapBox}>
                  <Text style={S.snapLabel}>What they saw</Text>
                  <Text style={S.snapText} numberOfLines={12}>
                    {JSON.stringify(snap, null, 2)}
                  </Text>
                </View>
              )}

              {r.status !== 'open' ? (
                <Text style={S.resolved}>
                  {r.status === 'actioned' ? '✅ Actioned' : '➖ Dismissed'}
                  {r.resolution ? ` — ${r.resolution}` : ''}
                </Text>
              ) : busy ? (
                <ActivityIndicator style={{ marginTop: 10 }} color={c.primary} />
              ) : (
                <View style={S.actions}>
                  <TouchableOpacity style={S.btn} onPress={() => { void dismiss(r); }}>
                    <Text style={S.btnText}>Dismiss</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[S.btn, S.btnWarn]}
                    onPress={() => setPending({ report: r, action: 'avatar' })}
                  >
                    <Text style={[S.btnText, S.btnWarnText]}>Remove photo</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[S.btn, S.btnDanger]}
                    onPress={() => setPending({ report: r, action: 'eject' })}
                  >
                    <Text style={[S.btnText, S.btnDangerText]}>Remove account</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          );
        })
      )}

      <ConfirmModal
        visible={pending != null}
        title={pending?.action === 'eject' ? 'Remove this account?' : 'Remove this photo?'}
        body={pending?.action === 'eject'
          ? `${pending?.report.subject?.full_name ?? 'This player'} will be signed out and unable to sign in again. `
            + 'Their profile becomes "[deleted account]" and their matches stay in other players\' histories. '
            + 'This cannot be undone.'
          : `${pending?.report.subject?.full_name ?? 'This player'}'s profile photo will be deleted from storage, `
            + 'not just unlinked. They can upload a new one.'}
        primaryLabel={pending?.action === 'eject' ? 'Remove account' : 'Remove photo'}
        variant="danger"
        busy={actingId != null}
        onConfirm={() => { if (pending) void run(pending); }}
        onClose={() => { if (!actingId) setPending(null); }}
      />
      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    page:        { flex: 1, backgroundColor: c.bg },
    content:     { padding: 16 },
    center:      { flex: 1, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center', padding: 24 },
    summary:     { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginBottom: 10 },
    summaryNum:  { fontSize: 32, fontWeight: '900', color: c.text },
    summaryLabel:{ fontSize: 14, color: c.textMuted, flex: 1 },
    overduePill: { backgroundColor: c.dangerLight, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 4 },
    overdueText: { color: c.danger, fontWeight: '800', fontSize: 12 },
    toggle:      { alignSelf: 'flex-start', marginBottom: 12 },
    toggleText:  { color: c.primary, fontWeight: '700', fontSize: 13 },
    card:        { backgroundColor: c.surface, borderRadius: 14, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: c.border },
    cardOverdue: { borderColor: c.danger, borderWidth: 1.5 },
    cardTop:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
    reason:      { fontSize: 15, fontWeight: '800', color: c.text },
    when:        { fontSize: 11, color: c.textMuted },
    subjectRow:  { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
    avatar:      { width: 36, height: 36, borderRadius: 18 },
    avatarFallback: { backgroundColor: c.surfaceAlt, alignItems: 'center', justifyContent: 'center' },
    subjectName: { fontSize: 15, fontWeight: '700', color: c.text },
    meta:        { fontSize: 12, color: c.textMuted, marginTop: 1 },
    details:     { fontSize: 14, color: c.textSub, fontStyle: 'italic', marginBottom: 8 },
    snapBox:     { backgroundColor: c.surfaceAlt, borderRadius: 10, padding: 10, marginBottom: 10 },
    snapLabel:   { fontSize: 11, fontWeight: '800', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 4 },
    snapText:    { fontSize: 12, color: c.textSub, fontFamily: 'monospace' },
    resolved:    { fontSize: 13, color: c.textMuted, marginTop: 4 },
    actions:     { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
    btn:         { paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10, borderWidth: 1.5, borderColor: c.border },
    btnText:     { fontSize: 13, fontWeight: '700', color: c.textSub },
    btnWarn:     { borderColor: c.primary },
    btnWarnText: { color: c.primary },
    btnDanger:   { borderColor: c.danger, backgroundColor: c.dangerLight },
    btnDangerText: { color: c.danger },
  });
}
