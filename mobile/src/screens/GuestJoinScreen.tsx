import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ScrollView,
} from 'react-native';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { HAIRLINE, RADIUS, SPACE, webInputFontFloor } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import EmptyState from '../components/EmptyState';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { track } from '../lib/analytics';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { RootStackParamList } from '../types';
import { navigateWhenReady } from '../lib/navigationRef';
import { endPresenceForSignOut } from '../lib/signOutPresence';
import { LoadingState } from '@just-messin-around/expo-foundation/ui';
import { sbCall, friendlySbMessage, signOutSafely } from '@just-messin-around/expo-foundation/supabase';
import { withTimeout } from '@just-messin-around/expo-foundation/platform';

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

/**
 * Landing screen for a guest event-vote invite link (g/:token).
 *
 * - Unauthenticated visitor: shows the invited-names roster, lets them pick/edit
 *   their name, then signs them in anonymously, redeems the invite (temp league
 *   membership + 7-day guest pass), and routes to the event vote.
 * - Already signed-in visitor (e.g. a member who tapped the link): skips the
 *   guest flow entirely and just opens the event — we never overwrite a real
 *   account's name or mark it as a guest.
 */
export default function GuestJoinScreen({ navigation, route }: Props) {
  const { token } = route.params;
  const { colors: c } = useTheme();
  const S = makeStyles(c);

  const [loading, setLoading]   = useState(true);
  const [preview, setPreview]   = useState<Preview | null>(null);
  const [name, setName]         = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]       = useState<string | null>(null);

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
          setPreview({ valid: false, league_name: null, event_id: null, event_title: null, invited_names: null, expires_at: null });
          setLoading(false);
          return;
        }
        setPreview(row);

        // If they're already signed in, don't run the guest flow (it would
        // overwrite a real account's name / mark it a guest) — just open the event
        // as themselves. Events are publicly viewable and voting only needs a
        // session, so a non-member can still participate.
        const { data: { session } } = await supabase.auth.getSession();
        if (session && row.event_id) {
          navigation.replace('EventDetail', { eventId: row.event_id, title: row.event_title ?? 'Event' });
          return;
        }
        setLoading(false);
      } catch {
        setPreview({ valid: false, league_name: null, event_id: null, event_title: null, invited_names: null, expires_at: null });
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Reached from the CTA *and* from the keyboard's Return key, which bypasses
  // the button's `disabled` entirely. Without a flag checked here, a second
  // Return mints a SECOND anonymous account and redeems the invite again.
  const inFlight = useRef(false);

  async function continueAsGuest() {
    if (inFlight.current) return;
    const trimmed = name.trim();
    if (!trimmed) { setError('Enter your name to continue.'); return; }
    inFlight.current = true;
    setSubmitting(true);
    setError(null);

    let signedIn = false;
    let navigated = false;
    try {
      // Signing in swaps the navigator to the logged-in stack and unmounts this
      // screen, so we can't navigate from here directly. redeem returns the event
      // id; we hand it to navigateWhenReady, which delivers once the logged-in
      // stack (and EventDetail) has mounted.
      // Not retried: a retry that lands twice creates two anon accounts.
      const { error: authErr } = await withTimeout(
        supabase.auth.signInAnonymously({ options: { data: { full_name: trimmed } } }),
        20_000,
      );
      if (authErr) throw authErr;
      signedIn = true;
      track('auth.login', { via: 'guest_invite' });

      const data = await sbCall<any>(
        () => supabase.rpc('redeem_guest_invite', { p_token: token, p_name: trimmed }),
        { retries: 2 },
      );
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) throw new Error('This guest invite is no longer valid.');

      navigated = true;
      navigateWhenReady('EventDetail', { eventId: row.event_id, title: row.event_title });
    } catch (e) {
      // Roll back the throwaway anon session so they're not left stranded
      // half-signed-in, and so a retry starts from a clean slate.
      // signOutSafely: the client refuses session removal while offline, so a
      // deliberate rollback has to identify itself or the throwaway anon session
      // would linger and the retry would start dirty. Presence first, under the
      // session being rolled back (bounded, never throws).
      if (signedIn) {
        await endPresenceForSignOut();
        try { await signOutSafely(supabase); } catch { /* already gone */ }
      }
      setError(friendlySbMessage(e, 'Could not start your guest session.'));
    } finally {
      inFlight.current = false;
      // On success this screen is being torn down — leave the spinner up rather
      // than flashing the CTA back to life mid-navigation.
      if (!navigated) setSubmitting(false);
    }
  }

  if (loading) {
    return <LoadingState label="Loading…" />;
  }

  if (!preview?.valid) {
    return (
      <View style={S.centered}>
        <EmptyState
          iconName="block"
          title="Invite not available"
          subtitle="This guest link is invalid or has expired. Ask whoever invited you to send a new one."
        />
      </View>
    );
  }

  const roster = preview.invited_names ?? [];

  return (
    <ScrollView contentContainerStyle={S.container}>
      <Text style={S.kicker}>You're invited to vote</Text>
      <Text style={S.eventTitle}>{preview.event_title}</Text>
      <Text style={S.leagueLine}>in {preview.league_name}</Text>

      <View style={S.card}>
        <Text style={S.prompt}>Who are you?</Text>
        {roster.length > 0 && (
          <View style={S.rosterWrap}>
            {roster.map((n) => {
              const selected = name.trim() === n;
              return (
                <TouchableOpacity
                  key={n}
                  style={[S.rosterChip, selected && S.rosterChipSelected]}
                  onPress={() => { setName(n); setError(null); }}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  aria-pressed={selected}
                >
                  <Text style={[S.rosterChipText, selected && S.rosterChipTextSelected]}>{n}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        <Text style={S.inputLabel}>Your name {roster.length > 0 ? '(tap above or edit)' : ''}</Text>
        <TextInput
          style={[S.input, webInputFontFloor(S.input)]}
          value={name}
          onChangeText={(t) => { setName(t); setError(null); }}
          placeholder="Your name"
          placeholderTextColor={c.textMuted}
          autoCapitalize="words"
          returnKeyType="done"
          onSubmitEditing={continueAsGuest}
        />

        {error && <Text style={S.error}>{error}</Text>}

        <Button
          title="Continue to the vote"
          iconName="arrow-right"
          iconPosition="trailing"
          onPress={continueAsGuest}
          loading={submitting}
          disabled={!name.trim()}
          style={S.cta}
        />
      </View>

      <Text style={S.fine}>
        You'll get a 7-day guest pass to Pickleague for this league. No password needed.
      </Text>
      {/* Anonymous sessions have no credentials — the browser's session
          storage is the only key, so closing this window loses the guest
          account permanently. Say so up front. */}
      <View style={S.warnBox}>
        <Icon name="warning" size={14} color={c.warning} style={S.warnGlyph} />
        <Text style={S.fineWarning}>
          Your guest pass lives in this browser only — if you close this window
          (or use a private/incognito tab), you'll lose access to it and your votes
          can't be changed. Create a free account any time to keep it.
        </Text>
      </View>
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
    rosterWrap:   { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, marginBottom: SPACE.lg },
    rosterChip:   { minHeight: 44, justifyContent: 'center', paddingHorizontal: SPACE.md, borderRadius: RADIUS.pill, borderWidth: HAIRLINE, borderColor: c.border, backgroundColor: c.surfaceAlt },
    rosterChipSelected: { borderColor: c.primary, backgroundColor: c.primaryLight },
    rosterChipText: { ...t.bodySub, fontWeight: FONT.weight.semibold },
    rosterChipTextSelected: { color: c.primary, fontWeight: FONT.weight.heavy },

    inputLabel:   { ...t.fieldLabel, marginBottom: SPACE.xs },
    input:        { minHeight: 44, borderWidth: HAIRLINE, borderColor: c.border, borderRadius: RADIUS.md, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, fontSize: FONT.size.lg, color: c.text, backgroundColor: c.surfaceAlt },
    error:        { ...t.sub, color: c.danger, marginTop: SPACE.sm },

    cta:          { marginTop: SPACE.lg },

    fine:         { ...t.hint, textAlign: 'center', marginTop: SPACE.lg },
    // A warning callout: the glyph carries the warning colour, the words keep
    // body contrast (warning orange on the page is under 3:1 for small text).
    warnBox:      { flexDirection: 'row', alignItems: 'flex-start', gap: SPACE.sm, marginTop: SPACE.sm, padding: SPACE.sm, borderRadius: RADIUS.md, backgroundColor: c.warningLight },
    // Centres the 14 glyph on the first line of 18-line text.
    warnGlyph:    { marginTop: SPACE.xxs },
    fineWarning:  { ...t.sub, flex: 1, color: c.text },
  });
}
