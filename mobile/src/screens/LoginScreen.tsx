import React, { useState } from 'react';
import { Text, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView, Platform, View } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { RootStackParamList } from '../types';
import { useTheme } from '../lib/ThemeContext';
import { gs } from '../lib/globalStyles';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Login'> };

export default function LoginScreen({ navigation }: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  async function signIn() {
    setErrorMessage('');
    if (!email.trim() || !password) {
      setErrorMessage('Please enter your email and password.');
      return;
    }
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) {
      setErrorMessage(error.message);
    }
    // On success, AppNavigator detects the new session and switches to Home automatically
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
