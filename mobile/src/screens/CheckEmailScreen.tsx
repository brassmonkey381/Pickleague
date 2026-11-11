// After Create Account (PKL-020): "Check your email". The email carries a code
// (supabase/templates/confirm-signup.html) that signs the player in right here.
// Supabase won't sign an account in until its email is confirmed, so this one
// screen holds the player instead of bouncing them to Sign In: the code box,
// Open Mail (iOS), Resend with a cooldown, fix the address, and Sign In with the
// email filled in for anyone who tapped the link instead.
// Rules and copy: lib/checkEmail.ts.
import React, { useEffect, useRef, useState } from 'react';
import { Linking, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Button, TextField } from '@just-messin-around/expo-foundation/forms';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { withTimeout } from '@just-messin-around/expo-foundation/platform';
import { supabase } from '../lib/supabase';
import { track } from '../lib/analytics';
import { useTheme } from '../lib/ThemeContext';
import { REFERRAL_REWARD_PICKLES } from '../lib/referralRules';
import {
  CHECK_EMAIL_HELP,
  CHECK_EMAIL_TITLE,
  CODE_LABEL,
  CODE_MAX,
  checkEmailBody,
  cleanCode,
  codeErrorMessage,
  codeReady,
  mailAppUrl,
  referralLine,
  resendLabel,
  resendWaitS,
  resentMessage,
} from '../lib/checkEmail';
import type { RootStackParamList } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'CheckEmail'>;

const RESEND_TIMEOUT_MS = 20_000;

export default function CheckEmailScreen({ navigation, route }: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);
  const email = route.params?.email ?? '';
  // A web link passes params as strings.
  const referral = String(route.params?.referral) === 'true';
  // From Create Account the link was just sent; from Sign In it may be old.
  const [lastSentMs, setLastSentMs] = useState<number | null>(route.params?.justSent ? Date.now() : null);
  const [nowMs, setNowMs] = useState(Date.now());
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const inFlight = useRef(false);
  const [code, setCode] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const confirmFlight = useRef(false);
  const mailUrl = mailAppUrl(Platform.OS);
  const waitS = resendWaitS(lastSentMs, nowMs);

  // Tick once a second only while the cooldown runs.
  useEffect(() => {
    if (waitS <= 0) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [waitS > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  // The code signs the player in here: verifyOtp confirms the email and starts
  // the session, and AppNavigator switches to Home on its own.
  async function confirmCode() {
    if (confirmFlight.current || !codeReady(code) || !email) return;
    confirmFlight.current = true;
    setConfirming(true);
    setCodeError(null);
    try {
      const { error } = await withTimeout(supabase.auth.verifyOtp({ email, token: code, type: 'email' }), RESEND_TIMEOUT_MS);
      if (error) setCodeError(codeErrorMessage(error) ?? friendlySbMessage(error, error.message));
      else track('auth.confirmed', { via: 'code' });
    } catch (e) {
      setCodeError(friendlySbMessage(e, 'Could not check the code. Please try again.'));
    } finally {
      confirmFlight.current = false;
      setConfirming(false);
    }
  }

  async function resend() {
    if (inFlight.current || waitS > 0 || !email) return;
    inFlight.current = true;
    setSending(true);
    setNote(null);
    try {
      const { error } = await withTimeout(supabase.auth.resend({ type: 'signup', email }), RESEND_TIMEOUT_MS);
      if (error) setNote({ ok: false, text: friendlySbMessage(error, error.message) });
      else {
        const t = Date.now();
        setLastSentMs(t);
        setNowMs(t);
        setNote({ ok: true, text: resentMessage(email) });
        track('auth.confirm_resent', {});
      }
    } catch (e) {
      setNote({ ok: false, text: friendlySbMessage(e, 'Could not send it. Please try again.') });
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  return (
    <ScrollView style={S.root} contentContainerStyle={S.container}>
      <View style={S.hero}>
        <View style={S.iconCircle}>
          <Icon name="mail" size={32} color={c.headerText} />
        </View>
        <Text style={S.heroTitle} accessibilityRole="header">{CHECK_EMAIL_TITLE}</Text>
      </View>

      <View style={S.body}>
        <Text style={S.text}>{checkEmailBody(email)}</Text>
        {referral ? <Text style={S.sub}>{referralLine(REFERRAL_REWARD_PICKLES)}</Text> : null}

        <TextField
          label={CODE_LABEL}
          placeholder="123456"
          accessibilityLabel={CODE_LABEL}
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          autoComplete="one-time-code"
          maxLength={CODE_MAX + 4}
          value={code}
          onChangeText={(s) => setCode(cleanCode(s))}
          onSubmitEditing={confirmCode}
          style={S.codeInput}
        />
        {codeError ? <Text style={[S.note, { color: c.danger }]}>{codeError}</Text> : null}
        <Button
          title={confirming ? 'Checking...' : 'Confirm'}
          onPress={confirmCode}
          disabled={confirming || !codeReady(code)}
          style={S.button}
        />
        {mailUrl ? (
          <Button
            title="Open Mail"
            iconName="mail"
            variant="outline"
            onPress={() => { void Linking.openURL(mailUrl).catch(() => {}); }}
            style={S.button}
          />
        ) : null}
        <Button
          title={resendLabel(waitS, sending)}
          variant="outline"
          onPress={resend}
          disabled={sending || waitS > 0 || !email}
          style={S.button}
        />
        {note ? <Text style={[S.note, { color: note.ok ? c.success : c.danger }]}>{note.text}</Text> : null}

        <TouchableOpacity onPress={() => navigation.navigate('Login', { email })} style={S.linkBox} accessibilityRole="button">
          <Text style={S.link}>Already confirmed? Sign in</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => navigation.navigate('Register')} style={S.linkBox} accessibilityRole="button">
          <Text style={S.link}>Wrong address? Fix it</Text>
        </TouchableOpacity>
        <Text style={S.help}>{CHECK_EMAIL_HELP}</Text>
      </View>
    </ScrollView>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  const t = textStyles(c);
  return StyleSheet.create({
    root:       { flex: 1, backgroundColor: c.bg },
    container:  { flexGrow: 1 },
    hero:       { backgroundColor: c.headerBg, paddingTop: SPACE.xl * 2 + SPACE.md, paddingBottom: SPACE.xl, alignItems: 'center', paddingHorizontal: SPACE.xl, gap: SPACE.sm },
    iconCircle: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: c.headerText },
    heroTitle:  { ...t.display, color: c.headerText, textAlign: 'center' },
    body:       { padding: SPACE.xl, gap: SPACE.sm },
    text:       { ...t.body, textAlign: 'center' },
    sub:        { ...t.bodySub, textAlign: 'center' },
    button:     { marginTop: SPACE.xs },
    codeInput:  { fontSize: 24, letterSpacing: 6, textAlign: 'center' },
    note:       { ...t.bodySub, textAlign: 'center' },
    // A real 44 box (react-native-web ignores hitSlop).
    linkBox:    { minHeight: 44, justifyContent: 'center', marginTop: SPACE.sm },
    link:       { ...t.body, textAlign: 'center', color: c.primary },
    help:       { ...t.hint, textAlign: 'center' },
  });
}
