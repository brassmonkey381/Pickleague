import React, { useEffect, useRef, useState } from 'react';
import { Text, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { track } from '../lib/analytics';
import { supabase } from '../lib/supabase';
import { Gender, RootStackParamList } from '../types';
import { useTheme } from '../lib/ThemeContext';
import { gs } from '../lib/globalStyles';
import { friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { withTimeout } from '@just-messin-around/expo-foundation/platform';

const GENDER_OPTIONS: { value: Gender; label: string }[] = [
  { value: 'male',              label: 'Male' },
  { value: 'female',            label: 'Female' },
  { value: 'other',             label: 'Other' },
  { value: 'prefer-not-to-say', label: 'Prefer not to say' },
];

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Register'> };

const SIGN_UP_TIMEOUT_MS = 25_000;

export default function RegisterScreen({ navigation }: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [gender, setGender] = useState<Gender | null>(null);
  const [loading, setLoading] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  // The account survives this screen; the navigate is deferred so the user can
  // read the confirm-your-email copy. Without a latch the button goes live again
  // for those 3s and a second tap re-runs signUp, replacing the success message
  // with "User already registered" for an account that WAS created.
  const [created, setCreated] = useState(false);
  const inFlight = useRef(false);
  const navTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (navTimer.current) clearTimeout(navTimer.current); }, []);

  const passwordsMatch = confirmPassword.length > 0 && password === confirmPassword;
  const passwordsMismatch = confirmPassword.length > 0 && password !== confirmPassword;

  async function signUp() {
    if (inFlight.current || created) return;
    setSuccessMessage('');
    setErrorMessage('');

    if (!firstName.trim() || !lastName.trim() || !email.trim()) {
      setErrorMessage('Please fill in all fields.');
      return;
    }
    if (!gender) {
      setErrorMessage('Please select your gender — used to classify doubles matches as Gendered or Mixed.');
      return;
    }
    if (password.length < 6) {
      setErrorMessage('Password must be at least 6 characters.');
      return;
    }
    if (!passwordsMatch) {
      setErrorMessage('Passwords do not match.');
      return;
    }

    const fullName = `${firstName.trim()} ${lastName.trim()}`;
    const username = `${firstName.trim().toLowerCase()}${lastName.trim().toLowerCase()}`.replace(/[^a-z0-9]/g, '');

    inFlight.current = true;
    setLoading(true);
    try {
      const { error } = await withTimeout(
        supabase.auth.signUp({
          email,
          password,
          options: { data: { username, full_name: fullName, gender } },
        }),
        SIGN_UP_TIMEOUT_MS,
      );

      if (error) {
        setErrorMessage(friendlySbMessage(error, error.message));
      } else {
        setCreated(true);
        // The signup moment. The emitter merges the landing campaign code into props centrally,
        // so a QR-scanned flyer that produced this account is attributable.
        track('account.created', { via: 'email' });
        setSuccessMessage('Account created! Please check your email to confirm, then sign in.');
        navTimer.current = setTimeout(() => navigation.navigate('Login'), 3000);
      }
    } catch (e) {
      // A timeout here is ambiguous — the account may or may not exist — so send
      // the user to sign-in rather than inviting a retry that would 400.
      setErrorMessage(friendlySbMessage(
        e,
        'Could not reach the server. If you get a confirmation email, your account was created — just sign in.',
      ));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }

  const body = (
    <>
      <View style={S.hero}>
        <Text style={S.heroTitle}>Create Account</Text>
        <Text style={S.heroSub}>Join your pickleball league today</Text>
      </View>
      <ScrollView contentContainerStyle={S.container} keyboardShouldPersistTaps="handled">
        <View style={S.nameRow}>
          <TextInput
            style={[S.input, S.nameInput]}
            placeholder="First Name"
            placeholderTextColor={c.textMuted}
            value={firstName}
            onChangeText={setFirstName}
          />
          <TextInput
            style={[S.input, S.nameInput]}
            placeholder="Last Name"
            placeholderTextColor={c.textMuted}
            value={lastName}
            onChangeText={setLastName}
          />
        </View>

        <TextInput
          style={S.input}
          placeholder="Email"
          placeholderTextColor={c.textMuted}
          autoCapitalize="none"
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
        />

        <Text style={S.fieldLabel}>Gender</Text>
        <Text style={S.fieldHint}>Used to classify doubles matches as Gendered (M+M+M+M / F+F+F+F) or Mixed.</Text>
        <View style={S.genderRow}>
          {GENDER_OPTIONS.map((opt) => (
            <TouchableOpacity
              key={opt.value}
              style={[S.genderPill, gender === opt.value && S.genderPillActive]}
              onPress={() => setGender(opt.value)}
            >
              <Text style={[S.genderPillText, gender === opt.value && S.genderPillTextActive]}>
                {opt.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <TextInput
          style={S.input}
          placeholder="Password"
          placeholderTextColor={c.textMuted}
          secureTextEntry
          value={password}
          onChangeText={setPassword}
        />
        <TextInput
          style={[S.input, passwordsMatch && S.inputValid, passwordsMismatch && S.inputInvalid]}
          placeholder="Confirm Password"
          placeholderTextColor={c.textMuted}
          secureTextEntry
          value={confirmPassword}
          onChangeText={setConfirmPassword}
        />
        {passwordsMatch && <Text style={S.matchText}>Passwords match</Text>}
        {passwordsMismatch && <Text style={S.mismatchText}>Passwords do not match</Text>}

        {errorMessage ? <Text style={S.errorText}>{errorMessage}</Text> : null}
        {successMessage ? <Text style={S.successText}>{successMessage}</Text> : null}

        <TouchableOpacity style={[S.button, (loading || created) && S.buttonDisabled]} onPress={signUp} disabled={loading || created}>
          <Text style={S.buttonText}>
            {loading ? 'Creating account...' : created ? 'Account created' : 'Create Account'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={S.link}>Already have an account? Sign in</Text>
        </TouchableOpacity>
      </ScrollView>
    </>
  );

  if (Platform.OS === 'web') {
    return <View style={{ flex: 1 }}>{body}</View>;
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
      {body}
    </KeyboardAvoidingView>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    hero:         { backgroundColor: c.headerBg, paddingTop: 60, paddingBottom: 32, alignItems: 'center', paddingHorizontal: 24 },
    heroTitle:    { fontSize: 28, fontWeight: '800', color: c.headerText, marginBottom: 4 },
    heroSub:      { fontSize: 15, color: c.headerSub },
    container:    { flexGrow: 1, padding: 24, backgroundColor: c.bg },
    nameRow:      { flexDirection: 'row', gap: 10, marginBottom: 0 },
    nameInput:    { flex: 1 },
    input:        { borderWidth: 1, borderColor: c.border, borderRadius: 10, padding: 14, marginBottom: 12, fontSize: 16, backgroundColor: c.surface, color: c.text },
    inputValid:   { borderColor: c.primary },
    inputInvalid: { borderColor: c.danger },
    fieldLabel:   { fontSize: 13, fontWeight: '700', color: c.textSub, marginBottom: 4, marginTop: 4 },
    fieldHint:    { fontSize: 12, color: c.textMuted, marginBottom: 8 },
    genderRow:    { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
    genderPill:   { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 20, borderWidth: 1.5, borderColor: c.border, backgroundColor: c.surface },
    genderPillActive:     { borderColor: c.primary, backgroundColor: c.primaryLight },
    genderPillText:       { fontSize: 14, color: c.textSub, fontWeight: '600' },
    genderPillTextActive: { color: c.primary, fontWeight: '700' },
    matchText:    { color: c.primary, fontSize: 13, fontWeight: '600', marginBottom: 8, marginLeft: 2 },
    mismatchText: { color: c.danger, fontSize: 13, fontWeight: '600', marginBottom: 8, marginLeft: 2 },
    errorText:    { color: c.danger, fontSize: 14, marginBottom: 12, textAlign: 'center' },
    successText:  { color: c.primary, fontSize: 14, marginBottom: 12, textAlign: 'center', fontWeight: '600' },
    button:       { backgroundColor: c.primary, padding: 16, borderRadius: 10, alignItems: 'center', marginTop: 8 },
    buttonDisabled: { opacity: 0.5 },
    buttonText:   { color: '#fff', fontSize: 16, fontWeight: '600' },
    link:         { textAlign: 'center', color: c.primary, marginTop: 20, fontSize: 15 },
  });
}
