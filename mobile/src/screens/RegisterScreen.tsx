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
  const [showPassword, setShowPassword] = useState(false);
  const [gender, setGender] = useState<Gender | null>(null);
  // Optional, REFERRALS_ENABLED only: prefilled from an invite link opened on
  // this device; sent in the sign-up metadata, where the server links it.
  const [referralCode, setReferralCode] = useState('');
  // The code field stays behind a link unless an invite already filled it.
  const [referralOpen, setReferralOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  // A double tap in the same frame must not run signUp twice (`disabled` lags a render).
  const inFlight = useRef(false);

  useEffect(() => {
    if (!REFERRALS_ENABLED) return;
    let active = true;
    void referralStash.peek().then((code) => {
      if (active && code) {
        setReferralCode((cur) => cur || code);
        setReferralOpen(true);
      }
    });
    return () => { active = false; };
  }, []);

  async function signUp() {
    if (inFlight.current) return;
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
        // The signup moment. The emitter merges the landing campaign code into props centrally,
        // so a QR-scanned flyer that produced this account is attributable.
        track('account.created', { via: 'email' });
        if (referral) void referralStash.put(referral);
        // One screen that says where the link went (PKL-020), not a bounce to Sign In.
        // navigate, not replace: "Wrong address? Fix it" comes back here with the fields kept.
        navigation.navigate('CheckEmail', { email: email.trim(), referral: !!referral, justSent: true });
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
        <Text style={S.heroTitle} accessibilityRole="header">Join Pickleague</Text>
        <Text style={S.heroSub}>Free. Takes a minute.</Text>
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

        <TextField
          placeholder="Password (6+ characters)"
          accessibilityLabel="Password"
          secureTextEntry={!showPassword}
          autoComplete="new-password"
          textContentType="newPassword"
          value={password}
          onChangeText={setPassword}
        />
        <TouchableOpacity
          onPress={() => setShowPassword((v) => !v)}
          style={S.showRow}
          accessibilityRole="button"
          accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
        >
          <Icon name={showPassword ? 'eye-off' : 'eye'} size={16} color={c.primary} />
          <Text style={S.showText}>{showPassword ? 'Hide password' : 'Show password'}</Text>
        </TouchableOpacity>

        <Text style={S.fieldLabel}>Gender</Text>
        <Text style={S.fieldHint}>For mixed and gendered doubles.</Text>
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

        {REFERRALS_ENABLED && !referralOpen && (
          <TouchableOpacity onPress={() => setReferralOpen(true)} style={S.linkBox} accessibilityRole="button">
            <Text style={S.link}>Have a referral code?</Text>
          </TouchableOpacity>
        )}
        {REFERRALS_ENABLED && referralOpen && (
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

        <Button
          title={loading ? 'Creating account...' : 'Create Account'}
          onPress={signUp}
          disabled={loading}
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
    // Under the nav header, so no status-bar clearance: the Create Account button fits on one phone screen.
    hero:         { backgroundColor: c.headerBg, paddingTop: SPACE.xl, paddingBottom: SPACE.xl, alignItems: 'center', paddingHorizontal: SPACE.xl },
    heroTitle:    { ...t.display, color: c.headerText, marginBottom: SPACE.xs },
    heroSub:      { ...t.body, color: c.headerSub, textAlign: 'center' },
    container:    { flexGrow: 1, padding: SPACE.xl, backgroundColor: c.bg },
    nameRow:      { flexDirection: 'row', gap: SPACE.sm },
    nameInput:    { flex: 1 },
    fieldLabel:   { ...t.fieldLabel, marginBottom: SPACE.xs },
    fieldHint:    t.hint,
    genderRow:    { flexDirection: 'row', flexWrap: 'wrap', columnGap: SPACE.xs, marginBottom: SPACE.sm },
    // Pulled up under the password field (TextField keeps 14 below itself); 44 tall to tap.
    showRow:      { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, marginTop: -SPACE.sm, marginBottom: SPACE.xs, minHeight: 44, alignSelf: 'flex-start' },
    showText:     { ...t.body, color: c.primary },
    errorText:    { ...t.bodySub, color: c.danger, marginBottom: SPACE.md, textAlign: 'center' },
    button:       { marginTop: SPACE.sm },
    // A real 44 box under the button (react-native-web ignores hitSlop).
    linkBox:      { minHeight: 44, justifyContent: 'center', marginTop: SPACE.sm },
    link:         { ...t.body, textAlign: 'center', color: c.primary },
  });
}
