import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Platform, Modal } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { Profile, RootStackParamList } from '../types';
import { isGodmodeUserId } from '../lib/godmode';

// Module-level flag — fires once per app session (resets on app reload).
let godmodeGrantClaimedThisSession = false;

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Home'> };

const NAV_ITEMS = [
  { icon: '🏆', label: 'Leagues',     screen: 'Leagues',     params: undefined },
  { icon: '🎾', label: 'Tournaments', screen: 'Tournaments', params: {} },
  { icon: '🏓', label: 'Drill',       screen: 'Drill',       params: undefined },
  { icon: '🛒', label: 'Pickle Shop', screen: 'Shop',        params: undefined },
  { icon: '😎', label: 'Profile',     screen: 'Profile',     params: {} },
  { icon: '🥒', label: 'About',       screen: 'About',       params: undefined },
] as const;

export default function HomeScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const [profile, setProfile]         = useState<Profile | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const [welcomeBalance, setWelcomeBalance] = useState(0);
  const [godmodeOpen, setGodmodeOpen] = useState(false);
  const [godmodeBalance, setGodmodeBalance] = useState(0);

  useFocusEffect(useCallback(() => {
    loadProfile();
    loadUnread();
  }, []));

  // Claim welcome pickles once per account, on first home visit after signup.
  useEffect(() => { claimWelcomePicklesOnce(); }, []);
  // Godmode users: grant 50k 🥒 once per app session.
  useEffect(() => { claimGodmodeGrantOncePerSession(); }, []);

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

  async function claimWelcomePicklesOnce() {
    const { data, error } = await supabase.rpc('claim_welcome_pickles');
    if (error) return;
    const row = Array.isArray(data) ? data[0] : data;
    if (row?.granted) {
      setWelcomeBalance(row.new_balance ?? 1000);
      setWelcomeOpen(true);
      // Refresh profile so the home pickle balance reflects the new total
      loadProfile();
    }
  }

  async function claimGodmodeGrantOncePerSession() {
    if (godmodeGrantClaimedThisSession) return;
    const { data: { user } } = await supabase.auth.getUser();
    if (!isGodmodeUserId(user?.id)) return;

    godmodeGrantClaimedThisSession = true;
    const { data, error } = await supabase.rpc('claim_godmode_pickles');
    if (error) return;
    const row = Array.isArray(data) ? data[0] : data;
    if (row?.success) {
      setGodmodeBalance(row.new_balance ?? 0);
      setGodmodeOpen(true);
      loadProfile();
    }
  }

  const s = makeStyles(colors);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: 40 }}>

      {/* ── Hero header ─────────────────────────────── */}
      <View style={s.hero}>
        {/* Decorative balls */}
        <Text style={s.decoBallTL}>🎾</Text>
        <Text style={s.decoBallBR}>🎾</Text>

        {/* Settings (top-left) */}
        <TouchableOpacity style={s.settingsBtn} onPress={() => navigation.navigate('Settings')}>
          <Text style={s.settingsIcon}>⚙️</Text>
        </TouchableOpacity>

        {/* Bell (top-right) */}
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

        {/* Greeting — tap your name to open your profile */}
        <Text style={s.welcomeLabel}>Welcome back,</Text>
        <TouchableOpacity onPress={() => navigation.navigate('Profile', {})} activeOpacity={0.6}>
          <Text style={[s.heroName, profile?.name_color ? { color: profile.name_color } : null]}>
            {profile?.full_name ?? '...'}
          </Text>
        </TouchableOpacity>

        {/* Pickle balance */}
        <TouchableOpacity style={s.picklePill} onPress={() => navigation.navigate('Shop')} activeOpacity={0.8}>
          <Text style={s.pickleEmoji}>🥒</Text>
          <Text style={s.pickleValue}>{profile?.pickles ?? 0}</Text>
          <Text style={s.pickleLabel}>pickles · tap to shop</Text>
        </TouchableOpacity>
      </View>

      {/* ── PLUPR stats strip ───────────────────────── */}
      <View style={s.statsCard}>
        <View style={s.statItem}>
          <Text style={s.statEmoji}>⭐</Text>
          <Text style={[s.statValue, { color: colors.primary }]}>{(profile?.rating ?? 3.25).toFixed(2)}</Text>
          <Text style={s.statLabel}>Overall PLUPR</Text>
        </View>
        <View style={s.statDivider} />
        <View style={s.statItem}>
          <Text style={s.statEmoji}>🏓</Text>
          <Text style={s.statValue}>{profile?.singles_rating != null ? profile.singles_rating.toFixed(2) : '—'}</Text>
          <Text style={s.statLabel}>Singles</Text>
        </View>
        <View style={s.statDivider} />
        <View style={s.statItem}>
          <Text style={s.statEmoji}>🤝</Text>
          <Text style={s.statValue}>{profile?.doubles_rating != null ? profile.doubles_rating.toFixed(2) : '—'}</Text>
          <Text style={s.statLabel}>Gendered Doubles</Text>
        </View>
        <View style={s.statDivider} />
        <View style={s.statItem}>
          <Text style={s.statEmoji}>♀♂</Text>
          <Text style={s.statValue}>{profile?.mixed_doubles_rating != null ? profile.mixed_doubles_rating.toFixed(2) : '—'}</Text>
          <Text style={s.statLabel}>Mixed Doubles</Text>
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

      {/* ── Welcome pickles modal ────────────────────────── */}
      <Modal visible={welcomeOpen} transparent animationType="fade" onRequestClose={() => setWelcomeOpen(false)}>
        <View style={s.welcomeBackdrop}>
          <View style={s.welcomeCard}>
            <Text style={s.welcomeEmoji}>🥒</Text>
            <Text style={s.welcomeTitle}>Welcome to Pickleague!</Text>
            <Text style={s.welcomeBody}>
              Here's <Text style={s.welcomeAmount}>1,000 pickles</Text> to get you started.
            </Text>
            <Text style={s.welcomeSub}>
              Spend them in the Pickle Shop on premium avatars, cosmetic badges, or profile flair.
            </Text>
            <Text style={s.welcomeBalance}>Your balance: 🥒 {welcomeBalance}</Text>
            <View style={s.welcomeBtnRow}>
              <TouchableOpacity
                style={[s.welcomeBtn, s.welcomeBtnSecondary]}
                onPress={() => setWelcomeOpen(false)}
              >
                <Text style={s.welcomeBtnSecondaryText}>Later</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={s.welcomeBtn}
                onPress={() => { setWelcomeOpen(false); navigation.navigate('Shop'); }}
              >
                <Text style={s.welcomeBtnText}>Visit Shop</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ── Godmode 50k grant modal ──────────────────────── */}
      <Modal visible={godmodeOpen} transparent animationType="fade" onRequestClose={() => setGodmodeOpen(false)}>
        <View style={s.welcomeBackdrop}>
          <View style={s.welcomeCard}>
            <Text style={s.welcomeEmoji}>🛠️</Text>
            <Text style={s.welcomeTitle}>Godmode session unlocked</Text>
            <Text style={s.welcomeBody}>
              <Text style={s.welcomeAmount}>+50,000 🥒</Text> credited to your account.
            </Text>
            <Text style={s.welcomeSub}>
              Use the Gift Pickles tool in Settings to send pickles to any user, or shop normally.
            </Text>
            <Text style={s.welcomeBalance}>Your balance: 🥒 {godmodeBalance.toLocaleString()}</Text>
            <View style={s.welcomeBtnRow}>
              <TouchableOpacity
                style={[s.welcomeBtn, s.welcomeBtnSecondary]}
                onPress={() => setGodmodeOpen(false)}
              >
                <Text style={s.welcomeBtnSecondaryText}>Dismiss</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={s.welcomeBtn}
                onPress={() => { setGodmodeOpen(false); navigation.navigate('GiftPickles'); }}
              >
                <Text style={s.welcomeBtnText}>Gift Pickles</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
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
    settingsBtn:  { position: 'absolute', top: Platform.OS === 'ios' ? 60 : 48, right: 54, padding: 8, zIndex: 10 },
    settingsIcon: { fontSize: 22 },
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

    picklePill: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      alignSelf: 'flex-start',
      backgroundColor: 'rgba(255,255,255,0.18)',
      paddingHorizontal: 14, paddingVertical: 8,
      borderRadius: 20, marginTop: 12,
      borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)',
    },
    pickleEmoji: { fontSize: 16 },
    pickleValue: { fontSize: 16, fontWeight: '800', color: c.headerText },
    pickleLabel: { fontSize: 12, color: c.headerSub, marginLeft: 4 },

    welcomeBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center', padding: 24 },
    welcomeCard:     { backgroundColor: c.surface, borderRadius: 18, padding: 28, alignItems: 'center', maxWidth: 380, width: '100%', shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 10 },
    welcomeEmoji:    { fontSize: 64, marginBottom: 8 },
    welcomeTitle:    { fontSize: 22, fontWeight: '900', color: c.text, marginBottom: 10, textAlign: 'center' },
    welcomeBody:     { fontSize: 15, color: c.textSub, textAlign: 'center', lineHeight: 22, marginBottom: 6 },
    welcomeAmount:   { fontWeight: '900', color: c.primary, fontSize: 17 },
    welcomeSub:      { fontSize: 13, color: c.textMuted, textAlign: 'center', lineHeight: 19, marginBottom: 14 },
    welcomeBalance:  { fontSize: 14, fontWeight: '700', color: c.primary, marginBottom: 18, backgroundColor: c.primaryLight, paddingHorizontal: 14, paddingVertical: 6, borderRadius: 12, overflow: 'hidden' },
    welcomeBtnRow:   { flexDirection: 'row', gap: 10, width: '100%' },
    welcomeBtn:      { flex: 1, backgroundColor: c.primary, paddingVertical: 12, borderRadius: 12, alignItems: 'center' },
    welcomeBtnText:  { color: '#fff', fontWeight: '800', fontSize: 14 },
    welcomeBtnSecondary: { backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
    welcomeBtnSecondaryText: { color: c.textSub, fontWeight: '700', fontSize: 14 },

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
