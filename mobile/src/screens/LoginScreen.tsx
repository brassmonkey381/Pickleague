import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  Text, TouchableOpacity, StyleSheet, KeyboardAvoidingView, Platform, View, Image, Pressable, ScrollView,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import GetTheAppButton from '../components/GetTheAppButton';
import { track } from '../lib/analytics';
import { supabase } from '../lib/supabase';
import { RootStackParamList } from '../types';
import { isEmailNotConfirmed, notConfirmedMessage } from '../lib/checkEmail';
import { getAuthLinkNotice, setAuthLinkNotice, subscribeAuthLinkNotice } from '../lib/authLink';
import { resetSentMessage } from '../lib/passwordRecovery';
import { useTheme } from '../lib/ThemeContext';
import { friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { Button, TextField } from '@just-messin-around/expo-foundation/forms';
import { BrandBand, Dialog, StickerBacking } from '@just-messin-around/expo-foundation/ui';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { edgeColor, highlightColors, partStyle } from '@just-messin-around/expo-foundation/theme';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { withTimeout } from '@just-messin-around/expo-foundation/platform';

type Props = NativeStackScreenProps<RootStackParamList, 'Login'>;

const ICON = require('../../assets/icon.png');

/** Sign-in is a single round trip; if the socket hangs, an unbounded await
 * leaves the button on "Signing in..." with force-quit as the only escape. */
const SIGN_IN_TIMEOUT_MS = 20_000;

/** The card's width on a wide window (PKL-031: sign-in as one card). */
const CARD_MAX = 420;

export default function LoginScreen({ navigation, route }: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);
  const t = textStyles(c);
  const insets = useSafeAreaInsets();
  const sticker = partStyle(c, 'button') === 'sticker';
  const hl = highlightColors(c);
  const radius = c.radiusCard ?? 16;

  const [email, setEmail] = useState(route.params?.email ?? '');
  // Opened again from Check your email with an address: fill it in.
  const paramEmail = route.params?.email;
  useEffect(() => { if (paramEmail) setEmail(paramEmail); }, [paramEmail]);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  // A note from the email's link when it couldn't sign the player in (lib/authLink).
  const linkNotice = useSyncExternalStore(subscribeAuthLinkNotice, getAuthLinkNotice, getAuthLinkNotice);
  // Set when the account exists but its email isn't confirmed: offers Check your email.
  const [unconfirmed, setUnconfirmed] = useState<string | null>(null);

  // "Forgot password?" (PKL-031): a reset dialog over the card.
  const [resetOpen, setResetOpen] = useState(false);
  const [resetEmail, setResetEmail] = useState('');
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetSentTo, setResetSentTo] = useState<string | null>(null);

  // `disabled` on the button is not a guard — a keyboard submit or a double tap
  // in the same frame can both enter this before React re-renders.
  const inFlight = useRef(false);

  async function signIn() {
    if (inFlight.current) return;
    setErrorMessage('');
    setUnconfirmed(null);
    if (!email.trim() || !password) {
      setErrorMessage('Please enter your email and password.');
      return;
    }
    inFlight.current = true;
    setLoading(true);
    try {
      const { error } = await withTimeout(
        supabase.auth.signInWithPassword({ email, password }),
        SIGN_IN_TIMEOUT_MS,
      );
      // On success, AppNavigator detects the new session and switches to Home automatically
      if (error && isEmailNotConfirmed(error)) {
        setUnconfirmed(email.trim());
        setErrorMessage(notConfirmedMessage(email.trim()));
      } else if (error) setErrorMessage(friendlySbMessage(error, error.message));
      else { setAuthLinkNotice(null); track('auth.login', { via: 'email' }); }
    } catch (e) {
      // Thrown (not returned) means transport: timeout, DNS, dropped socket.
      // The raw library string is useless here — say what the user can do.
      setErrorMessage(friendlySbMessage(e, 'Could not sign in. Please try again.'));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }

  function openReset() {
    setResetEmail(email.trim());
    setResetError(null);
    setResetSentTo(null);
    setResetOpen(true);
  }

  async function sendReset() {
    const to = resetEmail.trim();
    if (!to || !to.includes('@')) {
      setResetError('Enter the email you signed up with.');
      return;
    }
    setResetBusy(true);
    setResetError(null);
    try {
      // The link lands on the site (Supabase's Site URL), signed in with
      // type=recovery; NewPasswordHost then asks for the new password.
      const { error } = await withTimeout(supabase.auth.resetPasswordForEmail(to), SIGN_IN_TIMEOUT_MS);
      if (error) { setResetError(friendlySbMessage(error, 'Could not send the email. Please try again.')); return; }
      track('auth.reset_requested', {});
      setResetSentTo(to);
    } catch (e) {
      setResetError(friendlySbMessage(e, 'Could not send the email. Please try again.'));
    } finally {
      setResetBusy(false);
    }
  }

  const card = (
    <View style={S.cardWrap}>
      {sticker ? <StickerBacking color={edgeColor(c)} radius={radius} offset={5} /> : null}
      <View style={[S.card, { borderRadius: radius, borderColor: sticker ? edgeColor(c) : c.border }]}>
        <BrandBand color={hl.bg} style={[S.band, { borderTopLeftRadius: radius - 2, borderTopRightRadius: radius - 2 }]}>
          <Image source={ICON} style={[S.icon, { borderColor: edgeColor(c) }]} accessibilityIgnoresInvertColors />
          <View style={S.brandText}>
            <Text style={[t.display, S.wordmark, { color: hl.fg }]} accessibilityRole="header">Pickleague</Text>
            <Text style={[t.sub, { color: hl.fg }]}>Leagues, ladders and games at your courts</Text>
          </View>
        </BrandBand>

        <View style={S.body}>
          <Text style={[t.h1, S.welcome]}>Welcome back</Text>
          <Text style={[t.bodySub, S.lede]}>Sign in to see your matches, leagues and pickles.</Text>

          <TextField
            label="Email"
            accessibilityLabel="Email"
            autoCapitalize="none"
            keyboardType="email-address"
            autoComplete="email"
            textContentType="username"
            value={email}
            onChangeText={setEmail}
          />
          <TextField
            label="Password"
            accessibilityLabel="Password"
            labelAccessory={
              <Pressable onPress={openReset} accessibilityRole="button" style={S.forgot} hitSlop={6}>
                <Text style={[t.sub, S.forgotText]}>Forgot password?</Text>
              </Pressable>
            }
            secureTextEntry={!showPassword}
            autoComplete="current-password"
            textContentType="password"
            value={password}
            onChangeText={setPassword}
            onSubmitEditing={() => { void signIn(); }}
            returnKeyType="go"
            trailingWidth={86}
            trailing={
              <Pressable
                onPress={() => setShowPassword((s) => !s)}
                accessibilityRole="button"
                accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
                style={S.showBtn}
              >
                <Icon name={showPassword ? 'eye-off' : 'eye'} size={16} color={c.text} />
                <Text style={[t.sub, S.showText]}>{showPassword ? 'Hide' : 'Show'}</Text>
              </Pressable>
            }
          />

          {linkNotice && !errorMessage ? <Text style={S.notice}>{linkNotice}</Text> : null}
          {errorMessage ? <Text style={S.errorText} accessibilityLiveRegion="polite">{errorMessage}</Text> : null}
          {unconfirmed ? (
            <TouchableOpacity onPress={() => navigation.navigate('CheckEmail', { email: unconfirmed })} style={S.linkBox} accessibilityRole="button">
              <Text style={S.link}>Check your email</Text>
            </TouchableOpacity>
          ) : null}

          <Button title={loading ? 'Signing in...' : 'Sign in'} onPress={signIn} loading={loading} disabled={loading} style={S.button} />

          <View style={S.newRow}>
            <Text style={[t.bodySub, S.newText]}>New to Pickleague? </Text>
            <Pressable onPress={() => navigation.navigate('Register')} accessibilityRole="button" style={S.createBox}>
              <Text style={[t.body, S.createText]}>Create a free account</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );

  const resetDialog = (
    <Dialog
      visible={resetOpen}
      onClose={() => setResetOpen(false)}
      title="Reset your password"
      busy={resetBusy}
      error={resetError}
      body={resetSentTo ? resetSentMessage(resetSentTo) : "We'll email you a link. Open it on this device or in the app to choose a new password."}
      primary={
        resetSentTo
          ? { label: 'Done', onPress: () => setResetOpen(false) }
          : { label: resetBusy ? 'Sending…' : 'Send reset link', onPress: () => { void sendReset(); }, loading: resetBusy }
      }
      secondary={resetSentTo ? null : undefined}
    >
      {resetSentTo ? null : (
        <TextField
          label="Email"
          value={resetEmail}
          onChangeText={(v) => { setResetEmail(v); setResetError(null); }}
          autoCapitalize="none"
          keyboardType="email-address"
          autoComplete="email"
          autoFocus
          onSubmitEditing={() => { void sendReset(); }}
          returnKeyType="send"
          accessibilityLabel="Email for the reset link"
          containerStyle={S.resetField}
        />
      )}
    </Dialog>
  );

  const page = (
    <ScrollView
      style={S.root}
      contentContainerStyle={[S.scroll, { paddingTop: Math.max(insets.top, SPACE.lg) + SPACE.lg, paddingBottom: insets.bottom + SPACE.xl }]}
      keyboardShouldPersistTaps="handled"
    >
      {card}
      {/* Web only (the component no-ops on native). This is the site root for
          every signed-out visitor, which is where our printed QR codes land —
          so it is the one screen that must carry a visible store link rather
          than relying on the iOS-Safari-only Smart App Banner. */}
      <View style={S.getApp}>
        <GetTheAppButton from="login" />
      </View>
      {resetDialog}
    </ScrollView>
  );

  if (Platform.OS === 'web') return page;

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={S.root}>
      {page}
    </KeyboardAvoidingView>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  const t = textStyles(c);
  return StyleSheet.create({
    root:      { flex: 1, backgroundColor: c.bg },
    scroll:    { flexGrow: 1, justifyContent: 'center', paddingHorizontal: SPACE.lg },
    cardWrap:  { width: '100%', maxWidth: CARD_MAX, alignSelf: 'center' },
    card:      { backgroundColor: c.surface, borderWidth: 2, overflow: 'hidden' },
    band:      { flexDirection: 'row', alignItems: 'center', gap: SPACE.md, paddingHorizontal: SPACE.lg, paddingVertical: SPACE.lg },
    icon:      { width: 52, height: 52, borderRadius: 12, borderWidth: 2 },
    brandText: { flex: 1, minWidth: 0 },
    wordmark:  { lineHeight: 34 },
    body:      { padding: SPACE.lg, paddingTop: SPACE.lg },
    welcome:   { marginBottom: SPACE.xxs },
    lede:      { marginBottom: SPACE.lg },
    forgot:    { minHeight: 24, justifyContent: 'center' },
    forgotText: { color: c.text, fontWeight: '700', textDecorationLine: 'underline' },
    showBtn:   { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 40, paddingHorizontal: 6 },
    showText:  { color: c.text, fontWeight: '700' },
    errorText: { ...t.bodySub, color: c.danger, marginBottom: SPACE.sm, textAlign: 'center' },
    notice:    { ...t.bodySub, marginBottom: SPACE.sm, textAlign: 'center' },
    button:    { marginTop: SPACE.xs },
    // A real 44 box under the button (react-native-web ignores hitSlop).
    linkBox:   { minHeight: 44, justifyContent: 'center', marginBottom: SPACE.xs },
    link:      { ...t.body, textAlign: 'center', color: c.primary },
    newRow:    { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', marginTop: SPACE.md },
    newText:   { textAlign: 'center' },
    createBox: { minHeight: 44, justifyContent: 'center' },
    createText: { color: c.text, fontWeight: '800', textDecorationLine: 'underline' },
    getApp:    { width: '100%', maxWidth: CARD_MAX, alignSelf: 'center', marginTop: SPACE.lg },
    resetField: { marginBottom: 0 },
  });
}
