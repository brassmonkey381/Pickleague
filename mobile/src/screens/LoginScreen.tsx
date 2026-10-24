import React, { useRef, useState } from 'react';
import { Text, TouchableOpacity, StyleSheet, KeyboardAvoidingView, Platform, View } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import GetTheAppButton from '../components/GetTheAppButton';
import { track } from '../lib/analytics';
import { supabase } from '../lib/supabase';
import { RootStackParamList } from '../types';
import { useTheme } from '../lib/ThemeContext';
import { friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { Button, TextField } from '@just-messin-around/expo-foundation/forms';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { withTimeout } from '@just-messin-around/expo-foundation/platform';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Login'> };

/** Sign-in is a single round trip; if the socket hangs, an unbounded await
 * leaves the button on "Signing in..." with force-quit as the only escape. */
const SIGN_IN_TIMEOUT_MS = 20_000;

export default function LoginScreen({ navigation }: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  // `disabled` on the button is not a guard — a keyboard submit or a double tap
  // in the same frame can both enter this before React re-renders.
  const inFlight = useRef(false);

  async function signIn() {
    if (inFlight.current) return;
    setErrorMessage('');
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
      if (error) setErrorMessage(friendlySbMessage(error, error.message));
      else track('auth.login', { via: 'email' });
    } catch (e) {
      // Thrown (not returned) means transport: timeout, DNS, dropped socket.
      // The raw library string is useless here — say what the user can do.
      setErrorMessage(friendlySbMessage(e, 'Could not sign in. Please try again.'));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }

  const content = (
    <>
      <View style={S.hero}>
        <Text style={S.title} accessibilityRole="header">Pickleague</Text>
        <Text style={S.subtitle}>Pickleball League Manager</Text>
      </View>

      <View style={S.form}>
        <TextField
          placeholder="Email"
          accessibilityLabel="Email"
          autoCapitalize="none"
          keyboardType="email-address"
          autoComplete="email"
          textContentType="username"
          value={email}
          onChangeText={setEmail}
        />
        <TextField
          placeholder="Password"
          accessibilityLabel="Password"
          secureTextEntry
          autoComplete="current-password"
          textContentType="password"
          value={password}
          onChangeText={setPassword}
        />

        {errorMessage ? <Text style={S.errorText}>{errorMessage}</Text> : null}

        <Button title={loading ? 'Signing in...' : 'Sign In'} onPress={signIn} disabled={loading} style={S.button} />

        <TouchableOpacity onPress={() => navigation.navigate('Register')} style={S.linkBox} accessibilityRole="button">
          <Text style={S.link}>Don't have an account? Sign up</Text>
        </TouchableOpacity>

        {/* Web only (the component no-ops on native). This is the site root for
            every signed-out visitor, which is where our printed QR codes land —
            so it is the one screen that must carry a visible store link rather
            than relying on the iOS-Safari-only Smart App Banner. */}
        <GetTheAppButton from="login" />
      </View>
    </>
  );

  if (Platform.OS === 'web') {
    return <View style={S.root}>{content}</View>;
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={S.root}>
      {content}
    </KeyboardAvoidingView>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  const t = textStyles(c);
  return StyleSheet.create({
    root:      { flex: 1, backgroundColor: c.bg },
    // 80 on top clears the status bar on the header colour.
    hero:      { backgroundColor: c.headerBg, paddingTop: SPACE.xl * 3 + SPACE.sm, paddingBottom: SPACE.xl * 2, alignItems: 'center', paddingHorizontal: SPACE.xl },
    title:     { ...t.display, textAlign: 'center', color: c.headerText, marginBottom: SPACE.xs },
    subtitle:  { ...t.body, textAlign: 'center', color: c.headerSub },
    form:      { flex: 1, justifyContent: 'center', padding: SPACE.xl },
    errorText: { ...t.bodySub, color: c.danger, marginBottom: SPACE.sm, textAlign: 'center' },
    button:    { marginTop: SPACE.sm },
    // A real 44 box under the button (react-native-web ignores hitSlop).
    linkBox:   { minHeight: 44, justifyContent: 'center', marginTop: SPACE.sm },
    link:      { ...t.body, textAlign: 'center', color: c.primary },
  });
}
