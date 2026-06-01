import React, { useEffect, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ActivityIndicator, ScrollView,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { RootStackParamList } from '../types';
import { setPendingNavigation, flushPendingNavigation } from '../lib/navigationRef';

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
      const { data, error } = await supabase.rpc('get_guest_invite_preview', { p_token: token });
      const row = (Array.isArray(data) ? data[0] : data) as Preview | undefined;
      if (error || !row?.valid) {
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
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function continueAsGuest() {
    const trimmed = name.trim();
    if (!trimmed) { setError('Enter your name to continue.'); return; }
    setSubmitting(true);
    setError(null);

    // Stash the destination BEFORE sign-in: signing in swaps the navigator to the
    // logged-in stack and unmounts this screen, so we can't navigate from here.
    // We don't yet know the event id; redeem returns it, but the stack swap may
    // race — so we set a placeholder and overwrite after redeem, then flush.
    const { error: authErr } = await supabase.auth.signInAnonymously({
      options: { data: { full_name: trimmed } },
    });
    if (authErr) {
      setSubmitting(false);
      setError(authErr.message ?? 'Could not start your guest session.');
      return;
    }

    const { data, error: redeemErr } = await supabase.rpc('redeem_guest_invite', {
      p_token: token,
      p_name:  trimmed,
    });
    const row = Array.isArray(data) ? data[0] : data;
    if (redeemErr || !row) {
      // Roll back the throwaway anon session so they're not left stranded.
      await supabase.auth.signOut();
      setSubmitting(false);
      setError(redeemErr?.message ?? 'This guest invite is no longer valid.');
      return;
    }

    setPendingNavigation('EventDetail', { eventId: row.event_id, title: row.event_title });
    flushPendingNavigation();
  }

  if (loading) {
    return <ActivityIndicator style={{ flex: 1 }} size="large" color={c.primary} />;
  }

  if (!preview?.valid) {
    return (
      <View style={S.centered}>
        <Text style={S.emoji}>🚫</Text>
        <Text style={S.invalidTitle}>Invite not available</Text>
        <Text style={S.invalidBody}>
          This guest link is invalid or has expired. Ask whoever invited you to send a new one.
        </Text>
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
                >
                  <Text style={[S.rosterChipText, selected && S.rosterChipTextSelected]}>{n}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        <Text style={S.inputLabel}>Your name {roster.length > 0 ? '(tap above or edit)' : ''}</Text>
        <TextInput
          style={S.input}
          value={name}
          onChangeText={(t) => { setName(t); setError(null); }}
          placeholder="Your name"
          placeholderTextColor={c.textMuted}
          autoCapitalize="words"
          returnKeyType="done"
          onSubmitEditing={continueAsGuest}
        />

        {error && <Text style={S.error}>{error}</Text>}

        <TouchableOpacity
          style={[S.cta, (submitting || !name.trim()) && S.ctaDim]}
          disabled={submitting || !name.trim()}
          onPress={continueAsGuest}
        >
          {submitting
            ? <ActivityIndicator color="#fff" />
            : <Text style={S.ctaText}>Continue to the vote →</Text>}
        </TouchableOpacity>
      </View>

      <Text style={S.fine}>
        You'll get a 7-day guest pass to Pickleague for this league. No password needed.
      </Text>
    </ScrollView>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container:    { padding: 24, flexGrow: 1, backgroundColor: c.bg, justifyContent: 'center' },
    centered:     { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, backgroundColor: c.bg },
    emoji:        { fontSize: 48, marginBottom: 12 },
    invalidTitle: { fontSize: 18, fontWeight: '800', color: c.text, marginBottom: 6 },
    invalidBody:  { fontSize: 14, color: c.textMuted, textAlign: 'center', lineHeight: 20 },

    kicker:       { fontSize: 13, color: c.textMuted, textTransform: 'uppercase', letterSpacing: 1, textAlign: 'center' },
    eventTitle:   { fontSize: 26, fontWeight: '900', color: c.text, textAlign: 'center', marginTop: 6 },
    leagueLine:   { fontSize: 15, color: c.textSub, textAlign: 'center', marginTop: 4, marginBottom: 20 },

    card:         { backgroundColor: c.surface, borderRadius: 16, padding: 20, borderWidth: 1, borderColor: c.border },
    prompt:       { fontSize: 16, fontWeight: '800', color: c.text, marginBottom: 12 },
    rosterWrap:   { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 },
    rosterChip:   { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 20, borderWidth: 1.5, borderColor: c.border, backgroundColor: c.surfaceAlt },
    rosterChipSelected: { borderColor: c.primary, backgroundColor: c.primaryLight },
    rosterChipText: { fontSize: 14, fontWeight: '600', color: c.textSub },
    rosterChipTextSelected: { color: c.primary, fontWeight: '800' },

    inputLabel:   { fontSize: 12, color: c.textMuted, marginBottom: 6 },
    input:        { borderWidth: 1, borderColor: c.border, borderRadius: 10, padding: 12, fontSize: 16, color: c.text, backgroundColor: c.surfaceAlt },
    error:        { color: c.danger, fontSize: 13, marginTop: 10 },

    cta:          { backgroundColor: c.primary, borderRadius: 12, paddingVertical: 15, alignItems: 'center', marginTop: 18 },
    ctaDim:       { opacity: 0.5 },
    ctaText:      { color: '#fff', fontSize: 16, fontWeight: '800' },

    fine:         { fontSize: 12, color: c.textMuted, textAlign: 'center', marginTop: 18, lineHeight: 18 },
  });
}
