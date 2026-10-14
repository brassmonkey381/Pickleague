// "Upcoming drill sessions" on the Drill Requests screen: when, with whom, both
// players' answers, and Confirm / Can't make it in the app (the drill
// reminder and lock-in pushes offer the same two on the lock screen). Once the
// pair has a court, the row reads "We're playing at <court> · <time>".
// 'on_my_way' is the stored value behind "Confirm" (kept for older apps). A reminder tap (or
// Home's Up next drill row) lands here with the session highlighted (focusId);
// the focused row reports its node so the screen can scroll it into view.
//
// Times are starts_at on this device's clock (the same instant the lock-in
// push and Home show). session_date + session_slot is the requester's wall
// clock, so it is only the fallback.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { sbCall, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { Panel, SectionHeader, FilterPill } from '@just-messin-around/expo-foundation/ui';
import { SPACE, HAIRLINE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { durationLabel } from '../lib/drillTime';
import { drillWhenLabel } from '../lib/drillWhen';
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
  req: { location_name: string | null } | null;
};

const BOUND = { retries: 1, timeoutMs: 9_000 };

export default function DrillUpcomingSessions({
  userId,
  focusId,
  refreshKey,
  onFocusedLayout,
}: {
  userId: string | null;
  focusId?: string;
  /** Bump to reload (pull-to-refresh, screen focus). */
  refreshKey: number;
  /** The focused session's row laid out (its node, for measureLayout). */
  onFocusedLayout?: (node: View | null) => void;
}) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);
  const t = textStyles(c);
  const focusedRef = useRef<View>(null);
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
              + ' drill_session_rsvps(user_id, status),'
              + ' req:drill_requests(location_name)',
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
      status.success(next === 'on_my_way' ? "Your partner knows you're confirmed." : "Your partner knows you can't make it.");
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
      <SectionHeader title="Upcoming drills" count={sessions.length} />
      <StatusBanner status={status.value} style={{ marginBottom: SPACE.sm }} />
      {/* One Panel of rows (hairline dividers, no per-row card), section 6. */}
      <Panel padded={false}>
        {sessions.map((s, i) => {
          const iAmP1 = s.player1_id === userId;
          const partnerId = iAmP1 ? s.player2_id : s.player1_id;
          const partner = (iAmP1 ? s.p2?.full_name : s.p1?.full_name) ?? 'your partner';
          const first = partner.split(' ')[0] || partner;
          const rsvps = s.drill_session_rsvps ?? [];
          const mine = rsvps.find((r) => r.user_id === userId)?.status;
          const theirs = rsvps.find((r) => r.user_id === partnerId)?.status;
          const focused = !!focusId && focusId === s.id;
          const busy = saving === s.id;
          const when = drillWhenLabel(s.starts_at, { date: s.session_date, slot: s.session_slot });
          const place = s.req?.location_name;
          return (
            <View
              key={s.id}
              ref={focused ? focusedRef : undefined}
              collapsable={false}
              onLayout={focused && onFocusedLayout ? () => onFocusedLayout(focusedRef.current) : undefined}
              style={[S.row, i < sessions.length - 1 && S.rowDivider, focused && S.rowFocused]}
            >
              <Text style={t.title} numberOfLines={1}>Drill with {partner}</Text>
              <Text style={t.sub} numberOfLines={place ? 2 : 1}>
                {place ? `📍 We're playing at ${place} · ` : ''}{when} · {durationLabel(s.length_minutes ?? 60)}
              </Text>
              <Text
                style={[t.meta, theirs === 'cant_make_it' && { color: c.danger }]}
                numberOfLines={1}
                maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}
              >
                {theirs === 'on_my_way'
                  ? `${first} confirmed`
                  : theirs === 'cant_make_it'
                    ? `${first} can't make it`
                    : `${first} hasn't answered yet`}
              </Text>
              {/* Your answer: a 2-option radio of FilterPills (28 pill, 44 box). */}
              <View style={S.answers} accessibilityRole="radiogroup">
                <FilterPill
                  label={mine === 'on_my_way' ? '✓ Confirmed' : 'Confirm'}
                  active={mine === 'on_my_way'}
                  onPress={busy || mine === 'on_my_way' ? undefined : () => answer(s, 'on_my_way')}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: mine === 'on_my_way', disabled: busy }}
                  accessibilityLabel="Confirm"
                />
                <FilterPill
                  label={mine === 'cant_make_it' ? "✓ Can't make it" : "Can't make it"}
                  active={mine === 'cant_make_it'}
                  onPress={busy || mine === 'cant_make_it' ? undefined : () => answer(s, 'cant_make_it')}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: mine === 'cant_make_it', disabled: busy }}
                  accessibilityLabel="Can't make it"
                />
                {busy ? <ActivityIndicator color={c.primary} /> : null}
              </View>
            </View>
          );
        })}
      </Panel>
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    section: { marginBottom: SPACE.md },
    // Row variant: padding 10/12, hairline divider, no margin.
    row: { paddingVertical: 10, paddingHorizontal: SPACE.md, gap: SPACE.xxs },
    rowDivider: { borderBottomWidth: HAIRLINE, borderBottomColor: c.border },
    rowFocused: { backgroundColor: c.primaryLight },
    answers: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: SPACE.sm },
  });
}
