import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, Switch,
  ActivityIndicator, Alert, TextInput,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { RootStackParamList } from '../types';
import DrillAvailabilityGrid from '../components/DrillAvailabilityGrid';
import { DrillAvailability, pruneStale, totalSlots } from '../lib/drillTime';
import { SHOT_PREFS, PARTNER_PREFS, findShotPref, findPartnerPref } from '../data/drillOptions';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Drill'> };

export default function DrillScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const S = makeStyles(colors);

  const [userId, setUserId]                   = useState<string | null>(null);
  const [enabled, setEnabled]                 = useState(false);
  const [availability, setAvailability]       = useState<DrillAvailability>({});
  const [shotPrefs, setShotPrefs]             = useState<string[]>([]);
  const [partnerPrefs, setPartnerPrefs]       = useState<string[]>([]);
  const [customTags, setCustomTags]           = useState<string[]>([]);
  const [customDraft, setCustomDraft]         = useState('');
  const [pendingCount, setPendingCount]       = useState(0);
  const [scrollLocked, setScrollLocked]       = useState(false);
  const [loading, setLoading]                 = useState(true);
  const [saveStatus, setSaveStatus]           = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useFocusEffect(useCallback(() => { load(); }, []));

  async function load() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    setUserId(user.id);

    const [profileRes, requestsRes] = await Promise.all([
      supabase
        .from('profiles')
        .select('drilling_enabled, drill_availability, drill_shot_prefs, drill_partner_prefs, drill_custom_tags')
        .eq('id', user.id)
        .single(),
      supabase
        .from('drill_requests')
        .select('id', { count: 'exact', head: true })
        .eq('to_user_id', user.id)
        .eq('status', 'pending'),
    ]);

    if (profileRes.data) {
      setEnabled(profileRes.data.drilling_enabled ?? false);
      setAvailability(pruneStale(profileRes.data.drill_availability ?? {}));
      setShotPrefs(profileRes.data.drill_shot_prefs ?? []);
      setPartnerPrefs(profileRes.data.drill_partner_prefs ?? []);
      setCustomTags(profileRes.data.drill_custom_tags ?? []);
    }
    setPendingCount((requestsRes as any).count ?? 0);
    setLoading(false);
  }

  async function persist(updates: Record<string, any>) {
    if (!userId) return;
    setSaveStatus('saving');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const { error } = await supabase
      .from('profiles')
      .update(updates)
      .eq('id', userId);
    if (error) {
      setSaveStatus('error');
      Alert.alert('Save failed', error.message);
    } else {
      setSaveStatus('saved');
      saveTimer.current = setTimeout(() => setSaveStatus('idle'), 1200);
    }
  }

  function toggleEnabled(val: boolean) {
    setEnabled(val);
    persist({ drilling_enabled: val });
  }

  function onAvailabilityChange(av: DrillAvailability) {
    setAvailability(av);
    persist({ drill_availability: av });
  }

  function toggleShotPref(slug: string) {
    const next = shotPrefs.includes(slug)
      ? shotPrefs.filter(s => s !== slug)
      : [...shotPrefs, slug];
    setShotPrefs(next);
    persist({ drill_shot_prefs: next });
  }

  function togglePartnerPref(slug: string) {
    const next = partnerPrefs.includes(slug)
      ? partnerPrefs.filter(s => s !== slug)
      : [...partnerPrefs, slug];
    setPartnerPrefs(next);
    persist({ drill_partner_prefs: next });
  }

  function addCustomTag() {
    const t = customDraft.trim();
    if (!t || customTags.includes(t) || customTags.length >= 12) return;
    const next = [...customTags, t];
    setCustomTags(next);
    setCustomDraft('');
    persist({ drill_custom_tags: next });
  }

  function removeCustomTag(tag: string) {
    const next = customTags.filter(t => t !== tag);
    setCustomTags(next);
    persist({ drill_custom_tags: next });
  }

  if (loading) return <ActivityIndicator style={{ flex: 1, backgroundColor: colors.bg }} size="large" color={colors.primary} />;

  const totalSlotsCount = totalSlots(availability);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ paddingBottom: 60 }}
      scrollEnabled={!scrollLocked}
    >
      {/* Hero */}
      <View style={S.hero}>
        <Text style={S.heroEmoji}>🏓</Text>
        <Text style={S.heroTitle}>Drill Partners</Text>
        <Text style={S.heroSub}>Find someone to grind cross-court dinks with at 7am.</Text>
      </View>

      {/* Opt-in toggle */}
      <View style={S.optInCard}>
        <View style={{ flex: 1, paddingRight: 12 }}>
          <Text style={S.optInLabel}>Open to drilling</Text>
          <Text style={S.optInDesc}>
            {enabled
              ? 'Other players can find you and send drill requests.'
              : 'You\'re hidden. Turn this on to send and receive drill requests.'}
          </Text>
        </View>
        <Switch
          value={enabled}
          onValueChange={toggleEnabled}
          trackColor={{ false: colors.border, true: colors.primary }}
          thumbColor="#fff"
        />
      </View>

      {!enabled ? (
        <View style={S.disabledHint}>
          <Text style={S.disabledHintText}>
            Toggle "Open to drilling" above to set your schedule and find partners.
          </Text>
        </View>
      ) : (
        <>
          {/* Quick actions */}
          <View style={S.actionsRow}>
            <TouchableOpacity
              style={S.actionBtn}
              onPress={() => navigation.navigate('DrillSearch')}
            >
              <Text style={S.actionEmoji}>🔍</Text>
              <Text style={S.actionLabel}>Find Partners</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={S.actionBtn}
              onPress={() => navigation.navigate('DrillRequests')}
            >
              <Text style={S.actionEmoji}>📨</Text>
              <Text style={S.actionLabel}>Requests</Text>
              {pendingCount > 0 && (
                <View style={S.actionBadge}>
                  <Text style={S.actionBadgeText}>{pendingCount > 9 ? '9+' : pendingCount}</Text>
                </View>
              )}
            </TouchableOpacity>
          </View>

          {/* Save status */}
          {saveStatus !== 'idle' && (
            <Text style={[S.saveStatus, saveStatus === 'error' ? { color: colors.danger } : { color: colors.primary }]}>
              {saveStatus === 'saving' ? 'Saving…' : saveStatus === 'saved' ? '✓ Saved' : 'Save failed'}
            </Text>
          )}

          {/* Availability grid */}
          <View style={S.card}>
            <Text style={S.cardTitle}>Your Drill Availability</Text>
            <Text style={S.cardSub}>Next 7 days · drag to paint your free slots</Text>
            <View style={{ marginTop: 10 }}>
              <DrillAvailabilityGrid
                availability={availability}
                onChange={onAvailabilityChange}
                onScrollLock={setScrollLocked}
              />
            </View>
          </View>

          {/* Shot prefs */}
          <View style={S.card}>
            <Text style={S.cardTitle}>Shots You Want to Drill</Text>
            <Text style={S.cardSub}>Pick what you'd like to focus on</Text>
            <View style={S.chipsWrap}>
              {SHOT_PREFS.map(p => {
                const active = shotPrefs.includes(p.slug);
                return (
                  <TouchableOpacity
                    key={p.slug}
                    style={[S.chip, active && S.chipActive]}
                    onPress={() => toggleShotPref(p.slug)}
                    activeOpacity={0.7}
                  >
                    <Text style={[S.chipText, active && S.chipTextActive]}>
                      {p.emoji} {p.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {/* Partner prefs */}
          <View style={S.card}>
            <Text style={S.cardTitle}>Partner Preferences</Text>
            <Text style={S.cardSub}>What you're looking for in a drill partner</Text>
            <View style={S.chipsWrap}>
              {PARTNER_PREFS.map(p => {
                const active = partnerPrefs.includes(p.slug);
                return (
                  <TouchableOpacity
                    key={p.slug}
                    style={[S.chip, active && S.chipActive]}
                    onPress={() => togglePartnerPref(p.slug)}
                    activeOpacity={0.7}
                  >
                    <Text style={[S.chipText, active && S.chipTextActive]}>
                      {p.emoji} {p.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {/* Custom tags */}
          <View style={S.card}>
            <Text style={S.cardTitle}>Custom Tags</Text>
            <Text style={S.cardSub}>Add anything else (max 12)</Text>
            <View style={S.customRow}>
              <TextInput
                style={S.customInput}
                value={customDraft}
                onChangeText={setCustomDraft}
                placeholder="e.g. left-handed, no smashing, etc."
                placeholderTextColor={colors.textMuted}
                onSubmitEditing={addCustomTag}
                returnKeyType="done"
                maxLength={32}
              />
              <TouchableOpacity
                style={[S.addBtn, (!customDraft.trim() || customTags.length >= 12) && S.addBtnDisabled]}
                onPress={addCustomTag}
                disabled={!customDraft.trim() || customTags.length >= 12}
              >
                <Text style={S.addBtnText}>Add</Text>
              </TouchableOpacity>
            </View>
            {customTags.length > 0 && (
              <View style={[S.chipsWrap, { marginTop: 10 }]}>
                {customTags.map(tag => (
                  <TouchableOpacity
                    key={tag}
                    style={S.customChip}
                    onPress={() => removeCustomTag(tag)}
                    activeOpacity={0.7}
                  >
                    <Text style={S.customChipText}>{tag}  ✕</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>
        </>
      )}
    </ScrollView>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    hero:          { backgroundColor: c.headerBg, paddingTop: 24, paddingBottom: 22, paddingHorizontal: 24, alignItems: 'center' },
    heroEmoji:     { fontSize: 44, marginBottom: 4 },
    heroTitle:     { fontSize: 24, fontWeight: '900', color: c.headerText, letterSpacing: 2 },
    heroSub:       { fontSize: 13, color: c.headerSub, marginTop: 4, textAlign: 'center' },

    optInCard:     {
      flexDirection: 'row', alignItems: 'center',
      backgroundColor: c.surface, marginHorizontal: 16, marginTop: 16,
      padding: 16, borderRadius: 14,
      shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 3,
    },
    optInLabel:    { fontSize: 16, fontWeight: '700', color: c.text, marginBottom: 2 },
    optInDesc:     { fontSize: 12, color: c.textSub, lineHeight: 17 },

    disabledHint:  { padding: 32, alignItems: 'center' },
    disabledHintText: { fontSize: 14, color: c.textMuted, textAlign: 'center', lineHeight: 20 },

    actionsRow:    { flexDirection: 'row', gap: 12, paddingHorizontal: 16, marginTop: 14 },
    actionBtn:     {
      flex: 1, backgroundColor: c.surface, borderRadius: 14,
      paddingVertical: 18, alignItems: 'center',
      shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 3,
    },
    actionEmoji:   { fontSize: 28, marginBottom: 4 },
    actionLabel:   { fontSize: 14, fontWeight: '700', color: c.text },
    actionBadge:   { position: 'absolute', top: 12, right: 18, backgroundColor: c.danger, minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 5, alignItems: 'center', justifyContent: 'center' },
    actionBadgeText: { color: '#fff', fontSize: 11, fontWeight: '800' },

    saveStatus:    { textAlign: 'center', fontSize: 12, marginTop: 8, fontWeight: '600' },

    card:          {
      backgroundColor: c.surface, marginHorizontal: 16, marginTop: 14,
      padding: 16, borderRadius: 14,
      shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 3,
    },
    cardTitle:     { fontSize: 15, fontWeight: '700', color: c.text },
    cardSub:       { fontSize: 12, color: c.textMuted, marginTop: 2 },

    chipsWrap:     { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
    chip:          { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 18, borderWidth: 1.5, borderColor: c.border, backgroundColor: c.surfaceAlt },
    chipActive:    { borderColor: c.primary, backgroundColor: c.primaryLight },
    chipText:      { fontSize: 13, color: c.textSub, fontWeight: '500' },
    chipTextActive:{ color: c.primary, fontWeight: '700' },

    customRow:     { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
    customInput:   { flex: 1, borderWidth: 1.5, borderColor: c.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: c.text, backgroundColor: c.surface },
    addBtn:        { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10, backgroundColor: c.primary },
    addBtnDisabled:{ opacity: 0.4 },
    addBtnText:    { color: '#fff', fontSize: 14, fontWeight: '700' },
    customChip:    { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 18, borderWidth: 1.5, borderColor: c.primary, backgroundColor: c.primaryLight },
    customChipText:{ fontSize: 13, color: c.primary, fontWeight: '600' },
  });
}
