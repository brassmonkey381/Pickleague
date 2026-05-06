import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, ActivityIndicator, ScrollView } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { Profile, RootStackParamList } from '../types';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Profile'> };

export default function ProfileScreen({ navigation }: Props) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [username, setUsername] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => { loadProfile(); }, []);

  async function loadProfile() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    setUserId(user.id);
    const { data } = await supabase.from('profiles').select('*').eq('id', user.id).single();
    if (data) { setProfile(data); setUsername(data.username); }
    setLoading(false);
  }

  async function saveProfile() {
    if (!userId) return;
    setSaving(true);
    const { error } = await supabase.from('profiles').update({ username }).eq('id', userId);
    if (error) Alert.alert('Error', error.message);
    else Alert.alert('Saved!');
    setSaving(false);
  }

  if (loading) return <ActivityIndicator style={{ flex: 1 }} size="large" color="#2e7d32" />;

  const initials = profile?.full_name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) ?? '?';

  return (
    <ScrollView contentContainerStyle={styles.container}>
      {/* Avatar + name */}
      <View style={styles.avatarSection}>
        <View style={styles.avatar}>
          <Text style={styles.avatarInitials}>{initials}</Text>
        </View>
        <Text style={styles.fullName}>{profile?.full_name}</Text>
        <Text style={styles.ratingBadge}>{profile?.rating ?? 1000} ELO</Text>
      </View>

      {/* Editable username */}
      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>Username</Text>
        <TextInput
          style={styles.input}
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="your handle"
        />
        <Text style={styles.fieldHint}>This is how you appear in league standings.</Text>
      </View>

      <TouchableOpacity style={styles.button} onPress={saveProfile} disabled={saving}>
        <Text style={styles.buttonText}>{saving ? 'Saving...' : 'Save Changes'}</Text>
      </TouchableOpacity>

      <View style={styles.divider} />

      <TouchableOpacity
        style={styles.secondaryCard}
        onPress={() => userId && navigation.navigate('MatchHistory', { userId, title: 'My Match History' })}
      >
        <Text style={styles.secondaryIcon}>📜</Text>
        <View>
          <Text style={styles.secondaryLabel}>Match History</Text>
          <Text style={styles.secondarySub}>All your results with dates & ELO changes</Text>
        </View>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.secondaryCard}
        onPress={() => userId && navigation.navigate('CalendarAnalytics', { userId, title: 'My Calendar' })}
      >
        <Text style={styles.secondaryIcon}>🗓️</Text>
        <View>
          <Text style={styles.secondaryLabel}>Calendar Analytics</Text>
          <Text style={styles.secondarySub}>W-L and ELO changes by day</Text>
        </View>
      </TouchableOpacity>
    </ScrollView>
  );
}

const GREEN = '#2e7d32';
const styles = StyleSheet.create({
  container: { padding: 24, backgroundColor: '#fff', flexGrow: 1 },
  avatarSection: { alignItems: 'center', marginBottom: 32 },
  avatar: {
    width: 90, height: 90, borderRadius: 45,
    backgroundColor: '#e8f5e9',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 12,
  },
  avatarInitials: { fontSize: 34, fontWeight: '800', color: GREEN },
  fullName: { fontSize: 24, fontWeight: '700', color: '#1a1a1a', marginBottom: 6 },
  ratingBadge: {
    backgroundColor: '#e8f5e9', color: GREEN,
    fontWeight: '700', fontSize: 14,
    paddingHorizontal: 14, paddingVertical: 5,
    borderRadius: 20,
  },
  fieldGroup: { marginBottom: 4 },
  fieldLabel: { fontSize: 13, fontWeight: '600', color: '#555', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 },
  input: { borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 14, fontSize: 16 },
  fieldHint: { fontSize: 12, color: '#aaa', marginTop: 5 },
  button: { backgroundColor: GREEN, padding: 16, borderRadius: 8, alignItems: 'center', marginTop: 20 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  divider: { height: 1, backgroundColor: '#eee', marginVertical: 28 },
  secondaryCard: { flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: '#f9f9f9', borderRadius: 10, padding: 16, marginBottom: 12 },
  secondaryIcon: { fontSize: 28 },
  secondaryLabel: { fontSize: 16, fontWeight: '700', color: '#1a1a1a' },
  secondarySub: { fontSize: 13, color: '#666', marginTop: 2 },
});
