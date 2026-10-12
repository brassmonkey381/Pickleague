// "Upcoming drill sessions" on the Drill Requests screen: when, with whom, both
// players' answers, and On my way / Can't make it in the app (the drill
// reminder push offers the same two on the lock screen). A reminder tap lands
// here with the session highlighted (focusId).
//
// Times come from the session's wall-clock slot (session_date + session_slot),
// the same labels the request showed, so they never depend on starts_at.
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { sbCall, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { dateLabel, dateSubLabel, durationLabel, slotLabel } from '../lib/drillTime';
import { useStatusMessage } from '../lib/useStatusMessage';
import StatusBanner from './StatusBanner';

type Rsvp = 'on_my_way' | 'cant_make_it';

type SessionRow = {
  id: string;
  player1_id: string;
  player2_id: string;
  session_date: string;
  session_slot: number;
  length_minutes: number | null;
  starts_at: string | null;
  p1: { full_name: string | null } | null;
  p2: { full_name: string | null } | null;
  drill_session_rsvps: { user_id: string; status: Rsvp }[] | null;
};

const BOUND = { retries: 1, timeoutMs: 9_000 };

export default function DrillUpcomingSessions({
  userId,
  focusId,
  refreshKey,
}: {
  userId: string | null;
  focusId?: string;
  /** Bump to reload (pull-to-refresh, screen focus). */
  refreshKey: number;
}) {
  const { colors } = useTheme();
  const S = makeStyles(colors);
  const status = useStatusMessage();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [saving, setSaving] = useState<string | null>(null); // session id being answered

  const load = useCallback(async () => {
    if (!userId) return;
    try {
      // Started up to 30 minutes ago still counts: the same window the
      // reminder buttons use.
      const since = new Date(Date.now() - 30 * 60_000).toISOString();
      const data = await sbCall(
        () =>
          supabase
            .from('drill_sessions')
            .select(
              'id, player1_id, player2_id, session_date, session_slot, length_minutes, starts_at,'
              + ' p1:profiles!drill_sessions_player1_id_fkey(full_name),'
              + ' p2:profiles!drill_sessions_player2_id_fkey(full_name),'
              + ' drill_session_rsvps(user_id, status)',
            )
            .or(`player1_id.eq.${userId},player2_id.eq.${userId}`)
            .gt('starts_at', since)
            .order('starts_at')
            .limit(10),
        BOUND,
      );
      setSessions((data ?? []) as unknown as SessionRow[]);
    } catch {
      // Secondary section: keep whatever we last showed.
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function answer(s: SessionRow, next: Rsvp) {
    if (saving) return;
    setSaving(s.id);
    status.clear();
    try {
      // Idempotent: the RPC returns 'already' for the same answer.
      await sbCall(() => supabase.rpc('rsvp_drill_session', { p_session: s.id, p_status: next }), BOUND);
      status.success(next === 'on_my_way' ? 'Your partner knows you are on the way.' : "Your partner knows you can't make it.");
      await load();
    } catch (e) {
      status.error(friendlySbMessage(e, "Couldn't send that. Tap again to retry."));
    } finally {
      setSaving(null);
    }
  }

  if (!userId || sessions.length === 0) return null;

  return (
    <View style={S.section}>
      <Text style={S.title}>🥒 Upcoming drill sessions</Text>
      <StatusBanner status={status.value} style={{ marginBottom: 8 }} />
      {sessions.map((s) => {
        const iAmP1 = s.player1_id === userId;
        const partnerId = iAmP1 ? s.player2_id : s.player1_id;
        const partner = (iAmP1 ? s.p2?.full_name : s.p1?.full_name) ?? 'your partner';
        const first = partner.split(' ')[0] || partner;
        const rsvps = s.drill_session_rsvps ?? [];
        const mine = rsvps.find((r) => r.user_id === userId)?.status;
        const theirs = rsvps.find((r) => r.user_id === partnerId)?.status;
        const focused = !!focusId && focusId === s.id;
        const busy = saving === s.id;
        return (
          <View key={s.id} style={[S.card, focused && S.cardFocused]}>
            <Text style={S.name}>Drill with {partner}</Text>
            <Text style={S.sub}>
              {dateLabel(s.session_date)} {dateSubLabel(s.session_date)} · {slotLabel(s.session_slot)} · {durationLabel(s.length_minutes ?? 60)}
            </Text>
            <Text style={[S.partner, theirs === 'cant_make_it' && S.partnerOut]}>
              {theirs === 'on_my_way'
                ? `${first} is on the way`
                : theirs === 'cant_make_it'
                  ? `${first} can't make it`
                  : `${first} hasn't answered yet`}
            </Text>
            <View style={S.row}>
              <TouchableOpacity
                style={[S.btn, mine === 'on_my_way' && S.btnOn]}
                onPress={() => answer(s, 'on_my_way')}
                disabled={busy || mine === 'on_my_way'}
                accessibilityRole="button"
                accessibilityState={{ selected: mine === 'on_my_way', disabled: busy }}
              >
                <Text style={[S.btnText, mine === 'on_my_way' && S.btnTextOn]}>
                  {mine === 'on_my_way' ? '✓ On my way' : 'On my way'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[S.btn, mine === 'cant_make_it' && S.btnOut]}
                onPress={() => answer(s, 'cant_make_it')}
                disabled={busy || mine === 'cant_make_it'}
                accessibilityRole="button"
                accessibilityState={{ selected: mine === 'cant_make_it', disabled: busy }}
              >
                <Text style={[S.btnText, mine === 'cant_make_it' && S.btnTextOut]}>
                  {mine === 'cant_make_it' ? "✓ Can't make it" : "Can't make it"}
                </Text>
              </TouchableOpacity>
              {busy ? <ActivityIndicator color={colors.primary} /> : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    section: { marginBottom: 14 },
    title: { fontSize: 15, fontWeight: '800', color: c.text, marginBottom: 8 },
    card: { backgroundColor: c.surface, borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: c.border },
    cardFocused: { borderColor: c.primary, borderWidth: 2, backgroundColor: c.primaryLight },
    name: { fontSize: 15, fontWeight: '800', color: c.text },
    sub: { fontSize: 12, color: c.textSub, marginTop: 2 },
    partner: { fontSize: 12, color: c.textMuted, marginTop: 6 },
    partnerOut: { color: c.danger, fontWeight: '700' },
    row: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
    btn: { flex: 1, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: c.border, alignItems: 'center', backgroundColor: c.bg },
    btnOn: { backgroundColor: c.successLight, borderColor: c.success },
    btnOut: { backgroundColor: c.dangerLight, borderColor: c.danger },
    btnText: { fontSize: 13, fontWeight: '700', color: c.text },
    btnTextOn: { color: c.success },
    btnTextOut: { color: c.danger },
  });
}
