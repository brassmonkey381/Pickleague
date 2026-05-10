import React, { useCallback, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Platform } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { Profile, RootStackParamList } from '../types';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Home'> };

const NAV_ITEMS = [
  { icon: '🏆', label: 'Leagues',     screen: 'Leagues',     params: undefined },
  { icon: '🎾', label: 'Tournaments', screen: 'Tournaments', params: {} },
  { icon: '🏓', label: 'Drill',       screen: 'Drill',       params: undefined },
  { icon: '👤', label: 'Profile',     screen: 'Profile',     params: {} },
  { icon: '⚙️', label: 'Settings',   screen: 'Settings',    params: undefined },
  { icon: '🥒', label: 'About',       screen: 'About',       params: undefined },
] as const;

export default function HomeScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const [profile, setProfile]         = useState<Profile | null>(null);
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

  const s = makeStyles(colors);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: 40 }}>

      {/* ── Hero header ─────────────────────────────── */}
      <View style={s.hero}>
        {/* Decorative balls */}
        <Text style={s.decoBallTL}>🎾</Text>
        <Text style={s.decoBallBR}>🎾</Text>

        {/* Bell */}
        <TouchableOpacity style={s.bellBtn} onPress={() => navigation.navigate('Notifications')}>
          <Text style={s.bellIcon}>🔔</Text>
          {unreadCount > 0 && (
            <View style={s.badge}>
              <Text style={s.badgeText}>{unreadCount > 9 ? '9+' : unreadCount}</Text>
            </View>
          )}
        </TouchableOpacity>

        {/* App title */}
        <View style={s.titleRow}>
          <Text style={s.titleEmoji}>🥒</Text>
          <Text style={s.titleText}>PICKLEAGUE</Text>
        </View>
        <Text style={s.titleSub}>Your recreational league hub</Text>

        {/* Divider */}
        <View style={s.heroDivider} />

        {/* Greeting */}
        <Text style={s.welcomeLabel}>Welcome back,</Text>
        <Text style={s.heroName}>{profile?.full_name ?? '...'}</Text>
      </View>

      {/* ── ELO stats strip ─────────────────────────── */}
      <View style={s.statsCard}>
        <View style={s.statItem}>
          <Text style={s.statEmoji}>⭐</Text>
          <Text style={[s.statValue, { color: colors.primary }]}>{profile?.rating ?? 1000}</Text>
          <Text style={s.statLabel}>Overall ELO</Text>
        </View>
        <View style={s.statDivider} />
        <View style={s.statItem}>
          <Text style={s.statEmoji}>🏓</Text>
          <Text style={s.statValue}>{profile?.singles_rating ?? '—'}</Text>
          <Text style={s.statLabel}>1v1</Text>
        </View>
        <View style={s.statDivider} />
        <View style={s.statItem}>
          <Text style={s.statEmoji}>🤝</Text>
          <Text style={s.statValue}>{profile?.doubles_rating ?? '—'}</Text>
          <Text style={s.statLabel}>2v2 Gend.</Text>
        </View>
        <View style={s.statDivider} />
        <View style={s.statItem}>
          <Text style={s.statEmoji}>♀♂</Text>
          <Text style={s.statValue}>{profile?.mixed_doubles_rating ?? '—'}</Text>
          <Text style={s.statLabel}>2v2 Mixed</Text>
        </View>
      </View>

      {/* ── Nav grid ────────────────────────────────── */}
      <View style={s.grid}>
        {NAV_ITEMS.map(({ icon, label, screen, params }) => (
          <TouchableOpacity
            key={label}
            style={s.card}
            activeOpacity={0.75}
            onPress={() => (navigation.navigate as any)(screen, params)}
          >
            <Text style={s.cardIcon}>{icon}</Text>
            <Text style={s.cardLabel}>{label}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </ScrollView>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    hero: {
      backgroundColor: c.headerBg,
      paddingTop: Platform.OS === 'ios' ? 60 : 48,
      paddingBottom: 28,
      paddingHorizontal: 24,
      overflow: 'hidden',
    },
    decoBallTL: { position: 'absolute', top: -10, left: -8, fontSize: 80, opacity: 0.08 },
    decoBallBR: { position: 'absolute', bottom: -16, right: -8, fontSize: 100, opacity: 0.08 },
    bellBtn:  { position: 'absolute', top: Platform.OS === 'ios' ? 60 : 48, right: 16, padding: 8, zIndex: 10 },
    bellIcon: { fontSize: 22 },
    badge:    { position: 'absolute', top: 4, right: 2, backgroundColor: '#c62828', borderRadius: 9, minWidth: 18, height: 18, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3 },
    badgeText:{ color: '#fff', fontSize: 10, fontWeight: '800' },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
    titleEmoji:{ fontSize: 28 },
    titleText: { fontSize: 28, fontWeight: '900', color: c.headerText, letterSpacing: 5 },
    titleSub:  { fontSize: 13, color: c.headerSub, marginTop: 3, letterSpacing: 0.5 },
    heroDivider: { height: 1, backgroundColor: 'rgba(255,255,255,0.15)', marginVertical: 18 },
    welcomeLabel: { fontSize: 14, color: c.headerSub, fontWeight: '500' },
    heroName:  { fontSize: 30, fontWeight: '800', color: c.headerText, marginTop: 2 },

    statsCard: {
      flexDirection: 'row',
      backgroundColor: c.surface,
      marginHorizontal: 16,
      marginTop: -1,
      borderRadius: 14,
      paddingVertical: 16,
      elevation: 4,
      shadowColor: '#000',
      shadowOpacity: 0.12,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 3 },
    },
    statItem:  { flex: 1, alignItems: 'center', gap: 3 },
    statEmoji: { fontSize: 20 },
    statValue: { fontSize: 20, fontWeight: '800', color: c.text },
    statLabel: { fontSize: 11, color: c.textMuted, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
    statDivider: { width: 1, backgroundColor: c.border, marginVertical: 4 },

    grid:     { flexDirection: 'row', flexWrap: 'wrap', gap: 12, padding: 16, marginTop: 8 },
    card:     {
      width: '47%',
      backgroundColor: c.surface,
      borderRadius: 14,
      paddingVertical: 22,
      alignItems: 'center',
      elevation: 2,
      shadowColor: '#000',
      shadowOpacity: 0.07,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 2 },
    },
    cardIcon:  { fontSize: 38, marginBottom: 8 },
    cardLabel: { fontSize: 14, fontWeight: '700', color: c.text },
  });
}
