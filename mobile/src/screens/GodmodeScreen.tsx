import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ActivityIndicator, ScrollView,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { RootStackParamList } from '../types';
import { isGodmodeUserId } from '../lib/godmode';
import StatusBanner from '../components/StatusBanner';
import { useStatusMessage } from '../lib/useStatusMessage';
import { setClipboard } from '../lib/clipboard';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Godmode'> };

type CreatedAccount = {
  user_id: string;
  email: string;
  password: string;
  username: string;
  full_name: string;
};

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function splitName(fullName: string): { first: string; last: string } {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 0) return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

export default function GodmodeScreen({ navigation }: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);

  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [fullName, setFullName] = useState('');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedAccount[]>([]);
  const status = useStatusMessage();

  useFocusEffect(useCallback(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      setAuthorized(isGodmodeUserId(user?.id));
    })();
  }, []));

  const { first, last } = splitName(fullName);
  const previewEmail = first && last ? `${slug(first)}.${slug(last)}@pickleague.test` : '';
  const previewUsername = first && last ? `${slug(first)}${slug(last)}` : '';
  const canSubmit = !!first && !!last && !creating;

  async function createAccount() {
    if (!canSubmit) return;
    status.clear();
    setCreating(true);
    const { data, error } = await supabase.functions.invoke<CreatedAccount>(
      'godmode-create-user',
      { body: { first_name: first, last_name: last } },
    );
    setCreating(false);
    if (error) { status.error(error.message); return; }
    if (!data?.user_id) { status.error('Edge function returned no user_id'); return; }
    setCreated(prev => [data, ...prev].slice(0, 10));
    setFullName('');
    status.success(`Created ${data.full_name} (${data.email})`);
  }

  async function copy(text: string, label: string) {
    try {
      await setClipboard(text);
      status.success(`${label} copied`);
    } catch (err) {
      status.error(err instanceof Error ? err.message : String(err));
    }
  }

  if (authorized === false) {
    return (
      <View style={S.gated}>
        <Text style={S.gatedTitle}>🚫 Godmode only</Text>
        <Text style={S.gatedBody}>This area is restricted.</Text>
      </View>
    );
  }
  if (authorized === null) return null;

  return (
    <ScrollView contentContainerStyle={S.container}>
      <Text style={S.hint}>
        Admin-only utilities. Anything risky should go behind a confirm. Feel free
        to keep stacking sections here as needs come up.
      </Text>

      <StatusBanner status={status.value} style={S.banner} />

      <Text style={S.sectionHeader}>Quick-create test account</Text>
      <View style={S.card}>
        <Text style={S.label}>Full name</Text>
        <TextInput
          style={S.input}
          placeholder="e.g. Justin Lucas"
          placeholderTextColor={c.textMuted}
          value={fullName}
          onChangeText={setFullName}
          autoCapitalize="words"
          autoCorrect={false}
        />

        {previewEmail ? (
          <View style={S.previewBox}>
            <PreviewRow label="Email"    value={previewEmail}    colors={c} />
            <PreviewRow label="Username" value={previewUsername} colors={c} />
            <PreviewRow label="Password" value="Pickle123!"      colors={c} />
            <Text style={S.previewNote}>Email is pre-confirmed — usable on first sign-in.</Text>
          </View>
        ) : (
          <Text style={S.placeholderHint}>Enter a first and last name to preview.</Text>
        )}

        <TouchableOpacity
          style={[S.primaryBtn, !canSubmit && S.primaryBtnDim]}
          onPress={createAccount}
          disabled={!canSubmit}
        >
          {creating
            ? <ActivityIndicator color="#fff" size="small" />
            : <Text style={S.primaryBtnText}>Create account</Text>}
        </TouchableOpacity>
      </View>

      {created.length > 0 && (
        <>
          <Text style={S.sectionHeader}>Recently created (this session)</Text>
          <View style={S.card}>
            {created.map((acct, i) => (
              <View key={acct.user_id} style={[S.acctRow, i === created.length - 1 && S.acctRowLast]}>
                <Text style={S.acctName}>{acct.full_name}</Text>
                <View style={S.acctMetaRow}>
                  <Text style={S.acctMeta} numberOfLines={1}>{acct.email}</Text>
                  <TouchableOpacity onPress={() => copy(acct.email, 'Email')} style={S.copyBtn}>
                    <Text style={S.copyBtnText}>Copy</Text>
                  </TouchableOpacity>
                </View>
                <View style={S.acctMetaRow}>
                  <Text style={S.acctMeta} numberOfLines={1}>Password: {acct.password}</Text>
                  <TouchableOpacity onPress={() => copy(acct.password, 'Password')} style={S.copyBtn}>
                    <Text style={S.copyBtnText}>Copy</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </View>
        </>
      )}

      <Text style={S.sectionHeader}>Coming soon</Text>
      <View style={[S.card, S.tbdCard]}>
        <Text style={S.tbdText}>
          More admin utilities can land here. Suggestions: bulk-create accounts,
          impersonate user, reset PLUPR, force-close a tournament, dump DB stats.
        </Text>
      </View>

      <View style={{ height: 48 }} />
    </ScrollView>
  );
}

function PreviewRow({
  label, value, colors,
}: { label: string; value: string; colors: ReturnType<typeof useTheme>['colors'] }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}>
      <Text style={{ color: colors.textSub, fontSize: 13, fontWeight: '600', width: 88 }}>{label}</Text>
      <Text style={{ flex: 1, color: colors.text, fontSize: 13, fontFamily: 'monospace' }} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container:        { padding: 16, backgroundColor: c.bg, flexGrow: 1 },
    hint:             { color: c.textMuted, fontSize: 13, marginBottom: 12, lineHeight: 18 },
    banner:           { marginBottom: 12 },
    sectionHeader:    { fontSize: 13, fontWeight: '800', color: c.textSub, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 8, marginBottom: 8 },
    card:             { backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 12, padding: 16, marginBottom: 16 },
    label:            { fontSize: 13, fontWeight: '700', color: c.textSub, marginBottom: 6 },
    input:            { borderWidth: 1, borderColor: c.border, borderRadius: 10, padding: 12, fontSize: 15, backgroundColor: c.bg, color: c.text },
    previewBox:       { marginTop: 12, padding: 12, backgroundColor: c.bg, borderRadius: 10, borderWidth: 1, borderColor: c.border },
    previewNote:      { color: c.textMuted, fontSize: 12, marginTop: 8, fontStyle: 'italic' },
    placeholderHint:  { color: c.textMuted, fontSize: 13, marginTop: 12, fontStyle: 'italic' },
    primaryBtn:       { marginTop: 14, backgroundColor: c.primary, paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
    primaryBtnDim:    { opacity: 0.5 },
    primaryBtnText:   { color: '#fff', fontSize: 15, fontWeight: '700' },
    acctRow:          { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.border },
    acctRowLast:      { borderBottomWidth: 0 },
    acctName:         { fontSize: 15, fontWeight: '700', color: c.text, marginBottom: 4 },
    acctMetaRow:      { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 2 },
    acctMeta:         { flex: 1, fontSize: 13, color: c.textSub, fontFamily: 'monospace' },
    copyBtn:          { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, borderWidth: 1, borderColor: c.border, backgroundColor: c.bg },
    copyBtnText:      { fontSize: 12, fontWeight: '700', color: c.primary },
    tbdCard:          { borderStyle: 'dashed' },
    tbdText:          { color: c.textMuted, fontSize: 13, lineHeight: 18 },
    gated:            { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: c.bg },
    gatedTitle:       { fontSize: 18, fontWeight: '800', color: c.text, marginBottom: 8 },
    gatedBody:        { color: c.textMuted, fontSize: 14 },
  });
}
