import React, { useRef, useState } from 'react';
import { Text, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView, Platform, View } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { track } from '../lib/analytics';
import { supabase } from '../lib/supabase';
import { RootStackParamList } from '../types';
import { useTheme } from '../lib/ThemeContext';
import { gs } from '../lib/globalStyles';
import { friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
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
        <Text style={S.title}>Pickleague</Text>
        <Text style={S.subtitle}>Pickleball League Manager</Text>
      </View>

      <View style={S.form}>
        <TextInput
          style={S.input}
          placeholder="Email"
          placeholderTextColor={c.textMuted}
          autoCapitalize="none"
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
        />
        <TextInput
          style={S.input}
          placeholder="Password"
          placeholderTextColor={c.textMuted}
          secureTextEntry
          value={password}
          onChangeText={setPassword}
        />

        {errorMessage ? <Text style={S.errorText}>{errorMessage}</Text> : null}

        <TouchableOpacity style={S.button} onPress={signIn} disabled={loading}>
          <Text style={S.buttonText}>{loading ? 'Signing in...' : 'Sign In'}</Text>
        </TouchableOpacity>

        <TouchableOpacity onPress={() => navigation.navigate('Register')}>
          <Text style={S.link}>Don't have an account? Sign up</Text>
        </TouchableOpacity>
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
  return StyleSheet.create({
    root:      { flex: 1, backgroundColor: c.bg },
    hero:      { backgroundColor: c.headerBg, paddingTop: 80, paddingBottom: 48, alignItems: 'center', paddingHorizontal: 24 },
    title:     { fontSize: 36, fontWeight: 'bold', textAlign: 'center', color: c.headerText, marginBottom: 4 },
    subtitle:  { fontSize: 16, textAlign: 'center', color: c.headerSub },
    form:      { flex: 1, justifyContent: 'center', padding: 24 },
    input:     { borderWidth: 1, borderColor: c.border, borderRadius: 10, padding: 14, marginBottom: 12, fontSize: 16, backgroundColor: c.surface, color: c.text },
    errorText: { color: c.danger, fontSize: 14, marginBottom: 10, textAlign: 'center' },
    button:    { backgroundColor: c.primary, padding: 16, borderRadius: 10, alignItems: 'center', marginTop: 8 },
    buttonText:{ color: '#fff', fontSize: 16, fontWeight: '600' },
    link:      { textAlign: 'center', color: c.primary, marginTop: 20, fontSize: 15 },
  });
}
