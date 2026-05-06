import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, ActivityIndicator, ScrollView } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { Profile, PlayerLocationRating, RootStackParamList } from '../types';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Profile'> };

export default function ProfileScreen({ navigation }: Props) {
  const [profile, setProfile]           = useState<Profile | null>(null);
  const [locationRatings, setLocationRatings] = useState<PlayerLocationRating[]>([]);
  const [username, setUsername]         = useState('');
  const [loading, setLoading]           = useState(true);
  const [saving, setSaving]             = useState(false);
  const [userId, setUserId]             = useState<string | null>(null);

  useEffect(() => { loadProfile(); }, []);

  async function loadProfile() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    setUserId(user.id);

    const [profileRes, locRes] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', user.id).single(),
      supabase.from('player_location_ratings')
        .select('*')
        .eq('user_id', user.id)
        .order('rating', { ascending: false }),
    ]);

    if (profileRes.data) { setProfile(profileRes.data); setUsername(profileRes.data.username); }
    setLocationRatings((locRes.data ?? []) as PlayerLocationRating[]);
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
    .split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2) ?? '?';

  const singlesRating = profile?.singles_rating ?? profile?.rating ?? 1000;
  const doublesRating = profile?.doubles_rating ?? profile?.rating ?? 1000;

  // Group location ratings by location name
  const locationGroups: Record<string, { singles?: PlayerLocationRating; doubles?: PlayerLocationRating }> = {};
  for (const r of locationRatings) {
    if (!locationGroups[r.location_name]) locationGroups[r.location_name] = {};
    locationGroups[r.location_name][r.match_type] = r;
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      {/* Avatar + name */}
      <View style={styles.avatarSection}>
        <View style={styles.avatar}>
          <Text style={styles.avatarInitials}>{initials}</Text>
        </View>
        <Text style={styles.fullName}>{profile?.full_name}</Text>
      </View>

      {/* ELO breakdown */}
      <View style={styles.eloCard}>
        <Text style={styles.eloCardTitle}>ELO Ratings</Text>
        <View style={styles.eloRow}>
          <View style={styles.eloItem}>
            <Text style={styles.eloValue}>{profile?.rating ?? 1000}</Text>
            <Text style={styles.eloLabel}>Overall</Text>
          </View>
          <View style={styles.eloDivider} />
          <View style={styles.eloItem}>
            <Text style={styles.eloValue}>{singlesRating}</Text>
            <Text style={styles.eloLabel}>Singles</Text>
          </View>
          <View style={styles.eloDivider} />
          <View style={styles.eloItem}>
            <Text style={styles.eloValue}>{doublesRating}</Text>
            <Text style={styles.eloLabel}>Doubles</Text>
          </View>
        </View>
      </View>

      {/* Location ratings */}
      {Object.keys(locationGroups).length > 0 && (
        <View style={styles.locationCard}>
          <Text style={styles.locationTitle}>Court Ratings</Text>
          {Object.entries(locationGroups).map(([loc, ratings]) => (
            <View key={loc} style={styles.locationRow}>
              <Text style={styles.locationName} numberOfLines={1}>📍 {loc}</Text>
              <View style={styles.locationRatings}>
                {ratings.singles && (
                  <View style={styles.locRatingPill}>
                    <Text style={styles.locRatingValue}>{ratings.singles.rating}</Text>
                    <Text style={styles.locRatingType}>1v1</Text>
                    <Text style={styles.locRatingRecord}>{ratings.singles.wins}W-{ratings.singles.losses}L</Text>
                  </View>
                )}
                {ratings.doubles && (
                  <View style={[styles.locRatingPill, styles.locRatingPillDoubles]}>
                    <Text style={styles.locRatingValue}>{ratings.doubles.rating}</Text>
                    <Text style={styles.locRatingType}>2v2</Text>
                    <Text style={styles.locRatingRecord}>{ratings.doubles.wins}W-{ratings.doubles.losses}L</Text>
                  </View>
                )}
              </View>
            </View>
          ))}
        </View>
      )}

      {/* Editable username */}
      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>Username</Text>
        <TextInput style={styles.input} value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} placeholder="your handle" />
        <Text style={styles.fieldHint}>This is how you appear in league standings.</Text>
      </View>

      <TouchableOpacity style={styles.button} onPress={saveProfile} disabled={saving}>
        <Text style={styles.buttonText}>{saving ? 'Saving...' : 'Save Changes'}</Text>
      </TouchableOpacity>

      <View style={styles.divider} />

      <TouchableOpacity style={styles.secondaryCard} onPress={() => userId && navigation.navigate('MatchHistory', { userId, title: 'My Match History' })}>
        <Text style={styles.secondaryIcon}>📜</Text>
        <View>
          <Text style={styles.secondaryLabel}>Match History</Text>
          <Text style={styles.secondarySub}>All your results with dates & ELO changes</Text>
        </View>
      </TouchableOpacity>

      <TouchableOpacity style={styles.secondaryCard} onPress={() => userId && navigation.navigate('CalendarAnalytics', { userId, title: 'My Calendar' })}>
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
  avatarSection: { alignItems: 'center', marginBottom: 20 },
  avatar: { width: 90, height: 90, borderRadius: 45, backgroundColor: '#e8f5e9', alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  avatarInitials: { fontSize: 34, fontWeight: '800', color: GREEN },
  fullName: { fontSize: 24, fontWeight: '700', color: '#1a1a1a' },

  eloCard: { backgroundColor: '#f9f9f9', borderRadius: 12, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: '#eee' },
  eloCardTitle: { fontSize: 12, fontWeight: '700', color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12 },
  eloRow: { flexDirection: 'row', alignItems: 'center' },
  eloItem: { flex: 1, alignItems: 'center' },
  eloValue: { fontSize: 26, fontWeight: '800', color: GREEN },
  eloLabel: { fontSize: 12, color: '#888', marginTop: 2 },
  eloDivider: { width: 1, height: 36, backgroundColor: '#e0e0e0' },

  locationCard: { backgroundColor: '#f9f9f9', borderRadius: 12, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: '#eee' },
  locationTitle: { fontSize: 12, fontWeight: '700', color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 },
  locationRow: { marginBottom: 10 },
  locationName: { fontSize: 13, fontWeight: '600', color: '#444', marginBottom: 5 },
  locationRatings: { flexDirection: 'row', gap: 8 },
  locRatingPill: { backgroundColor: '#e8f5e9', borderRadius: 8, padding: 8, alignItems: 'center', minWidth: 72 },
  locRatingPillDoubles: { backgroundColor: '#e3f2fd' },
  locRatingValue: { fontSize: 18, fontWeight: '800', color: '#1a1a1a' },
  locRatingType: { fontSize: 10, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 1 },
  locRatingRecord: { fontSize: 11, color: '#666', marginTop: 2 },

  fieldGroup: { marginBottom: 4, marginTop: 8 },
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
