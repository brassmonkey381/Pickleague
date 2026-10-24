import React, { useEffect, useRef, useState } from 'react';
import { Text, TouchableOpacity, StyleSheet, KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { track } from '../lib/analytics';
import { supabase } from '../lib/supabase';
import { Gender, RootStackParamList } from '../types';
import { useTheme } from '../lib/ThemeContext';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { FilterPill } from '@just-messin-around/expo-foundation/ui';
import { Button, TextField } from '@just-messin-around/expo-foundation/forms';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { withTimeout } from '@just-messin-around/expo-foundation/platform';
import { normalizeReferralCode } from '@just-messin-around/expo-foundation/referrals';
import { REFERRALS_ENABLED } from '../lib/features';
import { REFERRAL_REWARD_PICKLES } from '../lib/referralRules';
import { referralStash } from '../data/referrals';

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
  // Optional, REFERRALS_ENABLED only: prefilled from an invite link opened on
  // this device; sent in the sign-up metadata, where the server links it.
  const [referralCode, setReferralCode] = useState('');
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

  useEffect(() => {
    if (!REFERRALS_ENABLED) return;
    let active = true;
    void referralStash.peek().then((code) => {
      if (active && code) setReferralCode((cur) => cur || code);
    });
    return () => { active = false; };
  }, []);

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

    const typedReferral = REFERRALS_ENABLED ? referralCode.trim() : '';
    const referral = typedReferral ? normalizeReferralCode(typedReferral) : null;
    if (typedReferral && !referral) {
      setErrorMessage('That referral code doesn\'t look right. Check it, or leave it empty.');
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
          options: { data: { username, full_name: fullName, gender, ...(referral ? { referral_code: referral } : {}) } },
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
        if (referral) void referralStash.put(referral);
        setSuccessMessage(referral
          ? `Account created! Confirm your email, then sign in: you and your friend each get ${REFERRAL_REWARD_PICKLES} pickles.`
          : 'Account created! Please check your email to confirm, then sign in.');
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
        <Text style={S.heroTitle} accessibilityRole="header">Create Account</Text>
        <Text style={S.heroSub}>Join your pickleball league today</Text>
      </View>
      <ScrollView contentContainerStyle={S.container} keyboardShouldPersistTaps="handled">
        <View style={S.nameRow}>
          <TextField
            containerStyle={S.nameInput}
            placeholder="First Name"
            accessibilityLabel="First name"
            autoComplete="given-name"
            textContentType="givenName"
            value={firstName}
            onChangeText={setFirstName}
          />
          <TextField
            containerStyle={S.nameInput}
            placeholder="Last Name"
            accessibilityLabel="Last name"
            autoComplete="family-name"
            textContentType="familyName"
            value={lastName}
            onChangeText={setLastName}
          />
        </View>

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

        <Text style={S.fieldLabel}>Gender</Text>
        <Text style={S.fieldHint}>Used to classify doubles matches as Gendered (M+M+M+M / F+F+F+F) or Mixed.</Text>
        <View style={S.genderRow} accessibilityRole="radiogroup" accessibilityLabel="Gender">
          {GENDER_OPTIONS.map((opt) => (
            <FilterPill
              key={opt.value}
              label={opt.label}
              active={gender === opt.value}
              onPress={() => setGender(opt.value)}
              accessibilityRole="radio"
            />
          ))}
        </View>

        <TextField
          placeholder="Password"
          accessibilityLabel="Password"
          secureTextEntry
          autoComplete="new-password"
          textContentType="newPassword"
          value={password}
          onChangeText={setPassword}
        />
        <TextField
          style={passwordsMatch ? S.inputValid : undefined}
          error={passwordsMismatch ? 'Passwords do not match' : undefined}
          placeholder="Confirm Password"
          accessibilityLabel="Confirm password"
          secureTextEntry
          autoComplete="new-password"
          textContentType="newPassword"
          value={confirmPassword}
          onChangeText={setConfirmPassword}
        />
        {passwordsMatch && (
          <View style={S.matchRow}>
            <Icon name="check-mark" size={14} color={c.success} />
            <Text style={S.matchText}>Passwords match</Text>
          </View>
        )}

        {REFERRALS_ENABLED && (
          <>
            <TextField
              label="Referral code (optional)"
              placeholder="From a friend's invite"
              autoCapitalize="none"
              autoCorrect={false}
              value={referralCode}
              onChangeText={setReferralCode}
              maxLength={64}
            />
          </>
        )}

        {errorMessage ? <Text style={S.errorText}>{errorMessage}</Text> : null}
        {successMessage ? <Text style={S.successText}>{successMessage}</Text> : null}

        <Button
          title={loading ? 'Creating account...' : created ? 'Account created' : 'Create Account'}
          onPress={signUp}
          disabled={loading || created}
          style={S.button}
        />

        <TouchableOpacity onPress={() => navigation.goBack()} style={S.linkBox} accessibilityRole="button">
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
  const t = textStyles(c);
  return StyleSheet.create({
    hero:         { backgroundColor: c.headerBg, paddingTop: SPACE.xl * 2 + SPACE.md, paddingBottom: SPACE.xl + SPACE.sm, alignItems: 'center', paddingHorizontal: SPACE.xl },
    heroTitle:    { ...t.display, color: c.headerText, marginBottom: SPACE.xs },
    heroSub:      { ...t.body, color: c.headerSub, textAlign: 'center' },
    container:    { flexGrow: 1, padding: SPACE.xl, backgroundColor: c.bg },
    nameRow:      { flexDirection: 'row', gap: SPACE.sm },
    nameInput:    { flex: 1 },
    fieldLabel:   { ...t.fieldLabel, marginBottom: SPACE.xs },
    fieldHint:    t.hint,
    genderRow:    { flexDirection: 'row', flexWrap: 'wrap', columnGap: SPACE.xs, marginBottom: SPACE.sm },
    inputValid:   { borderColor: c.success },
    // Pulls the match line up under its field (TextField keeps 14 below itself).
    matchRow:     { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, marginTop: -SPACE.sm, marginBottom: SPACE.md },
    matchText:    { ...t.sub, color: c.success, fontWeight: FONT.weight.semibold },
    errorText:    { ...t.bodySub, color: c.danger, marginBottom: SPACE.md, textAlign: 'center' },
    successText:  { ...t.bodySub, color: c.success, marginBottom: SPACE.md, textAlign: 'center', fontWeight: FONT.weight.semibold },
    button:       { marginTop: SPACE.sm },
    // A real 44 box under the button (react-native-web ignores hitSlop).
    linkBox:      { minHeight: 44, justifyContent: 'center', marginTop: SPACE.sm },
    link:         { ...t.body, textAlign: 'center', color: c.primary },
  });
}
