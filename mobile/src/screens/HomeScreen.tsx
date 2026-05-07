import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Alert } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { Profile, RootStackParamList } from '../types';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Home'> };

export default function HomeScreen({ navigation }: Props) {
  const [profile, setProfile] = useState<Profile | null>(null);

  useEffect(() => {
    loadProfile();
  }, []);

  async function loadProfile() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase.from('profiles').select('*').eq('id', user.id).single();
    setProfile(data);
  }

  async function signOut() {
    await supabase.auth.signOut();
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.welcome}>Welcome back,</Text>
      <Text style={styles.name}>{profile?.full_name ?? '...'}</Text>
      <Text style={styles.rating}>Rating: {profile?.rating ?? 1000}</Text>

      <View style={styles.grid}>
        <TouchableOpacity style={styles.card} onPress={() => navigation.navigate('Leagues')}>
          <Text style={styles.cardIcon}>🏆</Text>
          <Text style={styles.cardLabel}>Leagues</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.card} onPress={() => navigation.navigate('Tournaments', {})}>
          <Text style={styles.cardIcon}>🎾</Text>
          <Text style={styles.cardLabel}>Tournaments</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.card} onPress={() => navigation.navigate('Profile', {})}>
          <Text style={styles.cardIcon}>👤</Text>
          <Text style={styles.cardLabel}>Profile</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity style={styles.signOut} onPress={signOut}>
        <Text style={styles.signOutText}>Sign Out</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, backgroundColor: '#f5f5f5' },
  welcome: { fontSize: 18, color: '#666', marginTop: 24 },
  name: { fontSize: 28, fontWeight: 'bold', color: '#1a1a1a', marginBottom: 4 },
  rating: { fontSize: 16, color: '#2e7d32', fontWeight: '600', marginBottom: 32 },
  grid: { flexDirection: 'row', gap: 16 },
  card: { flex: 1, backgroundColor: '#fff', borderRadius: 12, padding: 24, alignItems: 'center', elevation: 2, shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 8 },
  cardIcon: { fontSize: 36, marginBottom: 8 },
  cardLabel: { fontSize: 16, fontWeight: '600', color: '#333' },
  signOut: { marginTop: 40, padding: 16, alignItems: 'center' },
  signOutText: { color: '#999', fontSize: 15 },
});
