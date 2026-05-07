import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { Profile, RootStackParamList } from '../types';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Home'> };

export default function HomeScreen({ navigation }: Props) {
  const [profile, setProfile]       = useState<Profile | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);

  useFocusEffect(useCallback(() => {
    loadProfile();
    loadUnread();
  }, []));

  async function loadProfile() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase.from('profiles').select('*').eq('id', user.id).single();
    setProfile(data);
  }

  async function loadUnread() {
    const { count } = await supabase
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('is_read', false);
    setUnreadCount(count ?? 0);
  }

  async function signOut() {
    await supabase.auth.signOut();
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      {/* Bell icon top-right */}
      <TouchableOpacity style={styles.bellBtn} onPress={() => navigation.navigate('Notifications')}>
        <Text style={styles.bellIcon}>🔔</Text>
        {unreadCount > 0 && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{unreadCount > 9 ? '9+' : unreadCount}</Text>
          </View>
        )}
      </TouchableOpacity>

      <Text style={styles.welcome}>Welcome back,</Text>
      <Text style={styles.name}>{profile?.full_name ?? '...'}</Text>
      <View style={styles.eloRow}>
        <Text style={styles.rating}>{profile?.rating ?? 1000} ELO</Text>
        {(profile as any)?.singles_rating !== undefined && (
          <>
            <Text style={styles.eloSep}>·</Text>
            <Text style={styles.eloSplit}>{(profile as any).singles_rating} 1v1</Text>
            <Text style={styles.eloSep}>·</Text>
            <Text style={styles.eloSplit}>{(profile as any).doubles_rating} 2v2</Text>
          </>
        )}
      </View>

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

const GREEN = '#2e7d32';
const styles = StyleSheet.create({
  container: { flexGrow: 1, padding: 24, backgroundColor: '#f5f5f5' },
  bellBtn: { position: 'absolute', top: 20, right: 0, padding: 8 },
  bellIcon: { fontSize: 24 },
  badge: { position: 'absolute', top: 4, right: 2, backgroundColor: '#c62828', borderRadius: 9, minWidth: 18, height: 18, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3 },
  badgeText: { color: '#fff', fontSize: 10, fontWeight: '800' },
  welcome: { fontSize: 18, color: '#666', marginTop: 24 },
  name: { fontSize: 28, fontWeight: 'bold', color: '#1a1a1a', marginBottom: 6 },
  eloRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 32 },
  rating: { fontSize: 16, color: GREEN, fontWeight: '700' },
  eloSep: { fontSize: 14, color: '#ccc' },
  eloSplit: { fontSize: 13, color: '#888', fontWeight: '500' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  card: { width: '47%', backgroundColor: '#fff', borderRadius: 12, padding: 22, alignItems: 'center', elevation: 2, shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 8 },
  cardIcon: { fontSize: 36, marginBottom: 8 },
  cardLabel: { fontSize: 15, fontWeight: '600', color: '#333' },
  signOut: { marginTop: 40, padding: 16, alignItems: 'center' },
  signOutText: { color: '#999', fontSize: 15 },
});
