import React, { useEffect, useState } from 'react';
import { Text, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { Gender, RootStackParamList } from '../types';
import { useTheme } from '../lib/ThemeContext';

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
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data } = await supabase
        .from('profiles')
        .select('full_name, phone, gender')
        .eq('id', user.id)
        .maybeSingle();
      if (!data) return;
      const parts = (data.full_name ?? '').trim().split(/\s+/);
      if (parts[0]) setFirstName(parts[0]);
      if (parts.length > 1) setLastName(parts.slice(1).join(' '));
      if (data.phone) setPhone(data.phone);
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
      const { data: { user } } = await supabase.auth.getUser();
      if (!user?.email) {
        const { error: authErr } = await supabase.auth.updateUser({
          email,
          password,
          data: { full_name: fullName, gender },
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
        <Text style={S.heroTitle}>Save Your Account</Text>
        <Text style={S.heroSub}>Add an email & password so you never lose access</Text>
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

        <TextInput
          style={S.input}
          placeholder="Phone (optional)"
          placeholderTextColor={c.textMuted}
          keyboardType="phone-pad"
          value={phone}
          onChangeText={setPhone}
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

        <TouchableOpacity style={S.button} onPress={upgrade} disabled={loading}>
          <Text style={S.buttonText}>{loading ? 'Saving account...' : 'Create Account'}</Text>
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
    hero:         { backgroundColor: c.headerBg, paddingTop: 32, paddingBottom: 24, alignItems: 'center', paddingHorizontal: 24 },
    heroTitle:    { fontSize: 26, fontWeight: '800', color: c.headerText, marginBottom: 4 },
    heroSub:      { fontSize: 14, color: c.headerSub, textAlign: 'center' },
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
    buttonText:   { color: '#fff', fontSize: 16, fontWeight: '600' },
  });
}
