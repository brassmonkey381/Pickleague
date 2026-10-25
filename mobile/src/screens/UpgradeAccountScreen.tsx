import React, { useEffect, useState } from 'react';
import { Text, StyleSheet, KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { sbCall, currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';
import { Gender, RootStackParamList } from '../types';
import { useTheme } from '../lib/ThemeContext';
import { REFERRALS_ENABLED } from '../lib/features';
import { referralStash } from '../data/referrals';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { FilterPill } from '@just-messin-around/expo-foundation/ui';
import { Button, TextField } from '@just-messin-around/expo-foundation/forms';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';

const GENDER_OPTIONS: { value: Gender; label: string }[] = [
  { value: 'male',              label: 'Male' },
  { value: 'female',            label: 'Female' },
  { value: 'other',             label: 'Other' },
  { value: 'prefer-not-to-say', label: 'Prefer not to say' },
];

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'UpgradeAccount'> };

/**
 * Converts an anonymous guest into a real account: collects everything signup
 * does (name, email, password, gender) plus phone, then
 *   1. supabase.auth.updateUser({ email, password, data }) — adds credentials
 *      to the existing anon session (sends a confirmation email; stays signed in)
 *   2. complete_guest_upgrade RPC — finalizes the profile (username/gender/phone),
 *      clears guest flags, makes temporary memberships permanent.
 * Name + phone are pre-filled from the guest profile (phone is captured from the
 * invite when the guest tapped an exact roster name).
 */
export default function UpgradeAccountScreen({ navigation }: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName]   = useState('');
  const [email, setEmail]         = useState('');
  const [password, setPassword]   = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [gender, setGender]       = useState<Gender | null>(null);
  const [phone, setPhone]         = useState('');
  const [loading, setLoading]     = useState(false);
  const [successMessage, setSuccessMessage] = useState('');
  const [errorMessage, setErrorMessage]     = useState('');

  // Pre-fill from the guest profile (name split best-effort; phone if captured).
  useEffect(() => {
    (async () => {
      // LOCAL session read (getUser() is a network call that fails offline).
      const uid = await currentUserId(supabase);
      if (!uid) return;
      // Pre-fill is a nicety; the form still works empty, so each read fails
      // on its own. The phone is in owner-only profile_private, not profiles
      // (migration_anon_audit_fixes.sql).
      const [data, priv] = await Promise.all([
        sbCall(() =>
          supabase.from('profiles').select('full_name, gender').eq('id', uid).maybeSingle(),
        ).catch(() => null),
        sbCall(() =>
          supabase.from('profile_private').select('phone').eq('id', uid).maybeSingle(),
        ).catch(() => null),
      ]);
      if (priv?.phone) setPhone(priv.phone);
      if (!data) return;
      const parts = (data.full_name ?? '').trim().split(/\s+/);
      if (parts[0]) setFirstName(parts[0]);
      if (parts.length > 1) setLastName(parts.slice(1).join(' '));
      if (data.gender && data.gender !== 'prefer-not-to-say') setGender(data.gender as Gender);
    })();
  }, []);

  const passwordsMatch = confirmPassword.length > 0 && password === confirmPassword;
  const passwordsMismatch = confirmPassword.length > 0 && password !== confirmPassword;

  async function upgrade() {
    setSuccessMessage('');
    setErrorMessage('');

    if (!firstName.trim() || !lastName.trim() || !email.trim()) {
      setErrorMessage('Please fill in your name and email.');
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

    setLoading(true);
    try {
      // 1. Add email + password to the anonymous session (sends a confirmation
      //    email; the user stays logged in as the same account). If a prior
      //    attempt already set the email (the RPC below failed and they're
      //    retrying), skip this — re-setting the same email would error — and go
      //    straight to finalizing the profile.
      // getSession is LOCAL. getUser() here was a network call whose offline
      // { user: null } made this look like "no email set yet" on every retry.
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData.session?.user.email) {
        // A referral code this guest arrived with (claim_referral refuses
        // guests, so ReferralHost kept it) rides in on the metadata: the
        // server links and pays it once the new email is confirmed.
        const referral = REFERRALS_ENABLED ? await referralStash.peek() : null;
        const { error: authErr } = await supabase.auth.updateUser({
          email,
          password,
          data: { full_name: fullName, gender, ...(referral ? { referral_code: referral } : {}) },
        });
        if (authErr) {
          setErrorMessage(authErr.message);
          return;
        }
      }

      // 2. Finalize the profile server-side (username/gender/phone, clear guest
      //    flags, make memberships permanent).
      const { error: rpcErr } = await supabase.rpc('complete_guest_upgrade', {
        p_full_name: fullName,
        p_gender:    gender,
        p_phone:     phone.trim() || null,
      });
      if (rpcErr) {
        setErrorMessage(rpcErr.message ?? 'Could not finish setting up your account.');
        return;
      }

      // Refresh claims (and let the guest banner hide) in the background — never
      // await it: refreshSession can stall right after an email change, which
      // would leave the button stuck on "Saving account...".
      void supabase.auth.refreshSession().catch(() => { /* non-fatal */ });

      setSuccessMessage('Account created! Check your email to confirm it — you stay signed in here meanwhile.');
      setTimeout(() => navigation.goBack(), 2500);
    } catch (e: any) {
      // Surface any thrown rejection instead of silently hanging on "Saving…".
      setErrorMessage(e?.message ?? 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  const body = (
    <>
      <View style={S.hero}>
        <Text style={S.heroTitle} accessibilityRole="header">Save Your Account</Text>
        <Text style={S.heroSub}>Add an email & password so you never lose access</Text>
      </View>
      <ScrollView contentContainerStyle={S.container} keyboardShouldPersistTaps="handled">
        <View style={S.nameRow}>
          <TextField
            containerStyle={S.nameInput}
            placeholder="First Name"
            accessibilityLabel="First name"
            value={firstName}
            onChangeText={setFirstName}
          />
          <TextField
            containerStyle={S.nameInput}
            placeholder="Last Name"
            accessibilityLabel="Last name"
            value={lastName}
            onChangeText={setLastName}
          />
        </View>

        <TextField
          placeholder="Email"
          accessibilityLabel="Email"
          autoCapitalize="none"
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
        />

        <TextField
          placeholder="Phone (optional)"
          accessibilityLabel="Phone (optional)"
          keyboardType="phone-pad"
          value={phone}
          onChangeText={setPhone}
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
          value={password}
          onChangeText={setPassword}
        />
        <TextField
          style={passwordsMatch ? S.inputValid : undefined}
          error={passwordsMismatch ? 'Passwords do not match' : undefined}
          placeholder="Confirm Password"
          accessibilityLabel="Confirm password"
          secureTextEntry
          value={confirmPassword}
          onChangeText={setConfirmPassword}
        />
        {passwordsMatch && (
          <View style={S.matchRow}>
            <Icon name="check-mark" size={14} color={c.success} />
            <Text style={S.matchText}>Passwords match</Text>
          </View>
        )}

        {errorMessage ? <Text style={S.errorText}>{errorMessage}</Text> : null}
        {successMessage ? <Text style={S.successText}>{successMessage}</Text> : null}

        <Button title={loading ? 'Saving account...' : 'Create Account'} onPress={upgrade} disabled={loading} style={S.button} />
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
    hero:         { backgroundColor: c.headerBg, paddingTop: SPACE.xl + SPACE.sm, paddingBottom: SPACE.xl, alignItems: 'center', paddingHorizontal: SPACE.xl },
    heroTitle:    { ...t.h1, color: c.headerText, marginBottom: SPACE.xs },
    heroSub:      { ...t.bodySub, color: c.headerSub, textAlign: 'center' },
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
  });
}
