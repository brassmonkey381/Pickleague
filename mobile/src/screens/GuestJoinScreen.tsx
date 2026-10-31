import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { HAIRLINE, RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import EmptyState from '../components/EmptyState';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { track } from '../lib/analytics';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { RootStackParamList } from '../types';
import { getGuestInviteSlots, guestVoteStash, joinGuestInvite, type GuestSlot } from '../lib/guestVote';
import { explainRefusal } from '../lib/refusalNotices';
import { LoadingState } from '@just-messin-around/expo-foundation/ui';
import { sbCall } from '@just-messin-around/expo-foundation/supabase';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'GuestJoin'>;
  route:      RouteProp<RootStackParamList, 'GuestJoin'>;
};

type Preview = {
  valid: boolean;
  league_name: string | null;
  event_id: string | null;
  event_title: string | null;
  invited_names: string[] | null;
  expires_at: string | null;
};

const INVALID: Preview = { valid: false, league_name: null, event_id: null, event_title: null, invited_names: null, expires_at: null };

/** "Sat, Nov 8 · 6:00 PM" */
function slotLabel(startsAt: string): string {
  const d = new Date(startsAt);
  return `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} · ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

/**
 * Landing screen for a guest event-vote invite link (g/:token).
 *
 * Voting needs an account (supabase/migration_guest_votes_need_account.sql).
 * - Signed out: shows the event and its times. "Sign up to vote" and "I already
 *   have an account" keep the token (lib/guestVote), and the first sign-in
 *   joins the league and opens the vote, even after confirming the email.
 * - Signed in with an account: joins the invite's league until the link
 *   expires (a full membership is kept) and opens the event.
 * - A guest session from before: opens the event; its banner offers the
 *   account that voting now needs.
 */
export default function GuestJoinScreen({ navigation, route }: Props) {
  const { token } = route.params;
  const { colors: c } = useTheme();
  const S = makeStyles(c);

  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [slots, setSlots]     = useState<GuestSlot[]>([]);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      // Shared invite links are opened on whatever connection the guest happens
      // to have; an unbounded preview call leaves the link spinning forever with
      // nothing on screen. Bounded + retried, then always resolve to a state.
      try {
        const data = await sbCall(
          () => supabase.rpc('get_guest_invite_preview', { p_token: token }),
        ) as Preview[] | Preview | null;
        const row = (Array.isArray(data) ? data[0] : data) as Preview | undefined;
        if (!row?.valid) {
          setPreview(INVALID);
          setLoading(false);
          return;
        }
        setPreview(row);

        const { data: { session } } = await supabase.auth.getSession();
        if (session && row.event_id) {
          if (!session.user.is_anonymous) {
            // Join the league first: a closed league's times are members-only.
            try {
              await joinGuestInvite(token);
            } catch (e) {
              setError(explainRefusal(e, 'Could not open the vote. Try the link again.'));
              setLoading(false);
              return;
            }
          }
          navigation.replace('EventDetail', { eventId: row.event_id, title: row.event_title ?? 'Event' });
          return;
        }
        setSlots(await getGuestInviteSlots(token));
        setLoading(false);
      } catch {
        setPreview(INVALID);
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function go(screen: 'Register' | 'Login') {
    await guestVoteStash.put(token);
    track('guest_vote.account_cta', { screen });
    navigation.navigate(screen);
  }

  if (loading) {
    return <LoadingState label="Loading…" />;
  }

  if (!preview?.valid || error) {
    return (
      <View style={S.centered}>
        <EmptyState
          iconName="block"
          title="Invite not available"
          subtitle={error ?? 'This guest link is invalid or has expired. Ask whoever invited you to send a new one.'}
        />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={S.container}>
      <Text style={S.kicker}>You're invited to vote</Text>
      <Text style={S.eventTitle}>{preview.event_title}</Text>
      <Text style={S.leagueLine}>in {preview.league_name}</Text>

      <View style={S.card}>
        {slots.length > 0 && (
          <>
            <Text style={S.prompt}>Times to vote on</Text>
            <View style={S.slotList}>
              {slots.map((s) => (
                <View key={s.starts_at} style={S.slotRow}>
                  <Icon name="calendar" size={16} color={c.textSub} />
                  <Text style={S.slotText}>{slotLabel(s.starts_at)}</Text>
                </View>
              ))}
            </View>
          </>
        )}

        <Button
          title="Sign up to vote"
          iconName="arrow-right"
          iconPosition="trailing"
          onPress={() => { void go('Register'); }}
          style={S.cta}
        />
        <Button
          title="I already have an account"
          variant="outline"
          onPress={() => { void go('Login'); }}
          style={S.ctaSecond}
        />
      </View>

      <Text style={S.fine}>
        Voting needs a free Pickleague account, so every vote is a real player and you can change yours from any device. Sign up, confirm your email, then sign in: the vote opens.
      </Text>
    </ScrollView>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  const t = textStyles(c);
  return StyleSheet.create({
    container:    { padding: SPACE.xl, flexGrow: 1, backgroundColor: c.bg, justifyContent: 'center' },
    centered:     { flex: 1, justifyContent: 'center', backgroundColor: c.bg },

    kicker:       { ...t.hint, textTransform: 'uppercase', letterSpacing: 1, textAlign: 'center' },
    eventTitle:   { ...t.h1, textAlign: 'center', marginTop: SPACE.xs },
    leagueLine:   { ...t.body, color: c.textSub, textAlign: 'center', marginTop: SPACE.xs, marginBottom: SPACE.lg },

    card:         { backgroundColor: c.surface, borderRadius: RADIUS.lg, padding: SPACE.lg, borderWidth: HAIRLINE, borderColor: c.border },
    prompt:       { ...t.h3, marginBottom: SPACE.md },
    slotList:     { gap: SPACE.sm, marginBottom: SPACE.sm },
    slotRow:      { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 32 },
    slotText:     { ...t.body, flex: 1 },

    cta:          { marginTop: SPACE.md },
    ctaSecond:    { marginTop: SPACE.sm },

    fine:         { ...t.hint, textAlign: 'center', marginTop: SPACE.lg },
  });
}
