// Godmode-only report queue. This is the half of Guideline 1.2 that Apple
// cannot see in the binary but asks about anyway: reports have to be acted on
// within 24 hours, by removing the content and ejecting the author. Self-guards
// via the authoritative is_godmode_user() RPC — the hidden Settings entry point
// is not the boundary. Mirrors AdminVenueReviewScreen.
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator,
} from 'react-native';
import { CachedImage } from '@just-messin-around/expo-foundation/ui/CachedImage';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { useTheme } from '../lib/ThemeContext';
import { useStatusMessage } from '../lib/useStatusMessage';
import StatusBanner from '../components/StatusBanner';
import ConfirmModal from '../components/ConfirmModal';
import EmptyState from '../components/EmptyState';
import { Chip, ErrorState, Panel, TextLink } from '@just-messin-around/expo-foundation/ui';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { HAIRLINE, RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
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

  // A failed load must not read as "Nothing to review", and a failed godmode
  // check must not leave the first-load spinner up forever (it used to sit
  // outside the try, so a throw skipped setLoading(false)).
  const [loadError, setLoadError] = useState<unknown>(null);

  const load = useCallback(async (all: boolean) => {
    setLoading(true);
    try {
      const ok = await amIGodmode();
      setAuthorized(ok);
      if (ok) {
        setReports(await listReports(all ? 'all' : 'open'));
      }
      setLoadError(null);
    } catch (e) {
      setLoadError(e);
      status.error(friendlySbMessage(e, 'Could not load the report queue.'));
    } finally {
      setLoading(false);
    }
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
  if (authorized === null && loadError) {
    return (
      <View style={S.center}>
        <ErrorState error={loadError} onRetry={() => { void load(showAll); }} />
      </View>
    );
  }
  if (authorized === false) {
    return (
      <View style={S.center}>
        <EmptyState iconName="lock" title="Not authorised" subtitle="This queue is godmode-only." />
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
        {overdue > 0 && <Chip size="sm" tone="danger" label={`${overdue} past 24h`} align="center" />}
      </View>

      <TextLink
        label={showAll ? 'Show open only' : 'Show resolved too'}
        size="sub"
        onPress={() => setShowAll(v => !v)}
      />

      {loading ? (
        <ActivityIndicator style={S.spinner} color={c.primary} />
      ) : reports.length === 0 && loadError ? (
        <ErrorState error={loadError} onRetry={() => { void load(showAll); }} compact />
      ) : reports.length === 0 ? (
        <EmptyState
          iconName="check"
          title="Nothing to review"
          subtitle="Reports filed from a player's More menu land here."
        />
      ) : (
        reports.map(r => {
          const reason = REPORT_REASONS.find(x => x.key === r.reason)?.label ?? r.reason;
          const busy   = actingId === r.id;
          const snap   = r.snapshot ?? {};
          return (
            <Panel key={r.id} style={[S.card, isOverdue(r) && S.cardOverdue]}>
              <View style={S.cardTop}>
                <Text style={S.reason}>{reason}</Text>
                <Text style={S.when}>{new Date(r.created_at).toLocaleString()}</Text>
              </View>

              <TouchableOpacity
                style={S.subjectRow}
                onPress={() => navigation.navigate('PlayerProfile', { userId: r.subject_user_id, userName: r.subject?.full_name ?? 'Player' })}
                accessibilityRole="button"
                accessibilityLabel={`Open ${r.subject?.full_name ?? 'this player'}'s profile`}
              >
                {r.subject?.avatar_url
                  ? <CachedImage source={{ uri: r.subject.avatar_url }} style={S.avatar} />
                  : <View style={[S.avatar, S.avatarFallback]}><Icon name="person" size={18} color={c.textMuted} /></View>}
                <View style={S.flex}>
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
                <View style={S.resolvedRow}>
                  {r.status === 'actioned'
                    ? <Icon name="check" size={14} color={c.success} />
                    : <Icon name="minus" size={14} color={c.textMuted} />}
                  <Text style={S.resolved}>
                    {r.status === 'actioned' ? 'Actioned' : 'Dismissed'}
                    {r.resolution ? ` — ${r.resolution}` : ''}
                  </Text>
                </View>
              ) : busy ? (
                <ActivityIndicator style={S.busy} color={c.primary} />
              ) : (
                <View style={S.actions}>
                  <TouchableOpacity style={S.btn} onPress={() => { void dismiss(r); }} accessibilityRole="button">
                    <Text style={S.btnText}>Dismiss</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[S.btn, S.btnWarn]}
                    onPress={() => setPending({ report: r, action: 'avatar' })}
                    accessibilityRole="button"
                  >
                    <Text style={[S.btnText, S.btnWarnText]}>Remove photo</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[S.btn, S.btnDanger]}
                    onPress={() => setPending({ report: r, action: 'eject' })}
                    accessibilityRole="button"
                  >
                    <Text style={[S.btnText, S.btnDangerText]}>Remove account</Text>
                  </TouchableOpacity>
                </View>
              )}
            </Panel>
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
    </ScrollView>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  const t = textStyles(c);
  return StyleSheet.create({
    page:        { flex: 1, backgroundColor: c.bg },
    content:     { padding: SPACE.lg, paddingBottom: SPACE.xl * 2 },
    center:      { flex: 1, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center', padding: SPACE.xl },
    flex:        { flex: 1, minWidth: 0 },
    spinner:     { marginTop: SPACE.xl },
    busy:        { marginTop: SPACE.sm },
    summary:     { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, marginTop: SPACE.sm },
    summaryNum:  t.display,
    summaryLabel:{ ...t.bodySub, color: c.textMuted, flex: 1 },
    card:        { marginBottom: SPACE.md },
    cardOverdue: { borderColor: c.danger },
    cardTop:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: SPACE.sm, marginBottom: SPACE.sm },
    reason:      t.title,
    when:        t.caption,
    subjectRow:  { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 44, marginBottom: SPACE.sm },
    avatar:      { width: 36, height: 36, borderRadius: RADIUS.pill },
    avatarFallback: { backgroundColor: c.surfaceAlt, alignItems: 'center', justifyContent: 'center' },
    subjectName: t.title,
    meta:        { ...t.hint, marginTop: SPACE.xxs / 2 },
    details:     { ...t.bodySub, fontStyle: 'italic', marginBottom: SPACE.sm },
    snapBox:     { backgroundColor: c.surfaceAlt, borderRadius: RADIUS.md, padding: SPACE.sm, marginBottom: SPACE.sm },
    snapLabel:   { ...t.fieldLabel, marginBottom: SPACE.xs },
    snapText:    { fontSize: FONT.size.sm, color: c.textSub, fontFamily: 'monospace' },
    resolvedRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, marginTop: SPACE.xs },
    resolved:    { ...t.hint, flexShrink: 1 },
    actions:     { flexDirection: 'row', gap: SPACE.sm, flexWrap: 'wrap' },
    btn:         { minHeight: 44, justifyContent: 'center', paddingHorizontal: SPACE.md, borderRadius: RADIUS.md, borderWidth: HAIRLINE, borderColor: c.border },
    btnText:     { ...t.sub, fontWeight: FONT.weight.bold },
    btnWarn:     { borderColor: c.primary },
    btnWarnText: { color: c.primary },
    btnDanger:   { borderColor: c.danger, backgroundColor: c.dangerLight },
    btnDangerText: { color: c.danger },
  });
}
