import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  ActivityIndicator, TextInput,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { sbCall, currentUserId, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';
import { drillCalledOff } from '../lib/agenda';
import { useTheme } from '../lib/ThemeContext';
import { DrillSession, RootStackParamList } from '../types';
import DrillAvailabilityGrid from '../components/DrillAvailabilityGrid';
import StatusBanner from '../components/StatusBanner';
import DrillReviewModal from '../components/DrillReviewModal';
import { useStatusMessage } from '../lib/useStatusMessage';
import { isoDate, rollingDates, durationLabel, spanToDailyOverlays, toWeeklyTemplate, WEEKLY_CELLS } from '../lib/drillTime';
import { drillWhenRangeLabel } from '../lib/drillWhen';
import { SHOT_PREFS, PARTNER_PREFS, type DrillPref } from '../data/drillOptions';
import { useRefresh } from '../lib/useRefresh';
import AppRefreshControl from '../components/AppRefreshControl';
import { SkeletonList } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';
import { Chip, ErrorState, Panel, SegmentedToggle, ShortcutGrid, ThemedSwitch } from '@just-messin-around/expo-foundation/ui';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';

type SessionWithPartner = DrillSession & { partner_id: string; partner_name: string; reviewed: boolean; calledOff: boolean };

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Drill'> };

export default function DrillScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const S = makeStyles(colors);
  const t = textStyles(colors);

  const [userId, setUserId]                   = useState<string | null>(null);
  const [enabled, setEnabled]                 = useState(false);
  const [availability, setAvailability]       = useState<boolean[]>(() => Array(WEEKLY_CELLS).fill(false));
  const [shotPrefs, setShotPrefs]             = useState<string[]>([]);
  const [partnerPrefs, setPartnerPrefs]       = useState<string[]>([]);
  const [customTags, setCustomTags]           = useState<string[]>([]);
  const [customDraft, setCustomDraft]         = useState('');
  const [pendingCount, setPendingCount]       = useState(0);
  const [scrollLocked, setScrollLocked]       = useState(false);
  const [loading, setLoading]                 = useState(true);
  // A failed read must not render as "drilling off, no sessions".
  const [loadError, setLoadError]             = useState<string | null>(null);
  const [loadedOnce, setLoadedOnce]           = useState(false);
  const [saveStatus, setSaveStatus]           = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [sessions, setSessions]               = useState<SessionWithPartner[]>([]);
  const [sessionFilter, setSessionFilter]     = useState<'upcoming' | 'past'>('upcoming');
  const [scheduledMatches, setScheduledMatches] = useState<{ date: string; slot: number; length_minutes: number }[]>([]);
  const [reviewTarget, setReviewTarget]       = useState<SessionWithPartner | null>(null);

  const status = useStatusMessage();
  const refresh = useRefresh(load);

  useFocusEffect(useCallback(() => { load(); }, []));

  async function load() {
    try {
      await loadInner();
      setLoadError(null);
      setLoadedOnce(true);
    } catch (e) {
      // Preferences rendering as "off" / sessions as "none" on a failed read is
      // indistinguishable from the user never having set anything up.
      setLoadError(friendlySbMessage(e, 'Try again in a moment.'));
    } finally {
      // Always: the old `if (!user) return` and the happy-path-only
      // setLoading(false) both left the screen spinning.
      setLoading(false);
    }
  }

  async function loadInner() {
    // LOCAL session read (getUser() is a network call that fails offline).
    const uid = await currentUserId(supabase);
    if (!uid) return;
    setUserId(uid);

    const [profileRes, requestsRes, sessionsRes, matchesRes, tournamentsRes] = await Promise.all([
      supabase
        .from('profiles')
        .select('drilling_enabled, drill_availability, drill_shot_prefs, drill_partner_prefs, drill_custom_tags')
        .eq('id', uid)
        .single(),
      supabase
        .from('drill_requests')
        .select('id', { count: 'exact', head: true })
        .eq('to_user_id', uid)
        .eq('status', 'pending'),
      supabase
        .from('drill_sessions')
        .select(`
          *,
          p1:profiles!drill_sessions_player1_id_fkey(id, full_name),
          p2:profiles!drill_sessions_player2_id_fkey(id, full_name),
          drill_session_reviews(user_id),
          drill_session_rsvps(user_id, status)
        `)
        .or(`player1_id.eq.${uid},player2_id.eq.${uid}`)
        .order('session_date')
        .order('session_slot'),
      // Scheduled matches I'm part of (any of the 4 player slots), still upcoming.
      supabase
        .from('matches')
        .select('scheduled_at, player1_id, partner1_id, player2_id, partner2_id, status')
        .eq('status', 'scheduled')
        .gte('scheduled_at', new Date().toISOString())
        .or(`player1_id.eq.${uid},partner1_id.eq.${uid},player2_id.eq.${uid},partner2_id.eq.${uid}`),
      // Tournaments I'm approved into that have a known start time + expected length.
      supabase
        .from('tournament_registrations')
        .select('tournament:tournaments(start_time, expected_length_hours, status)')
        .eq('user_id', uid)
        .eq('status', 'approved'),
    ]);

    // Fail loud instead of rendering a failed read as "nothing configured".
    const firstError = [profileRes, requestsRes, sessionsRes, matchesRes, tournamentsRes]
      .map(r => (r as { error?: unknown }).error)
      .find(Boolean);
    if (firstError) throw firstError;

    if (profileRes.data) {
      setEnabled(profileRes.data.drilling_enabled ?? false);
      setAvailability(toWeeklyTemplate(profileRes.data.drill_availability ?? []));
      setShotPrefs(profileRes.data.drill_shot_prefs ?? []);
      setPartnerPrefs(profileRes.data.drill_partner_prefs ?? []);
      setCustomTags(profileRes.data.drill_custom_tags ?? []);
    }
    setPendingCount((requestsRes as any).count ?? 0);

    const rows = ((sessionsRes as any).data ?? []) as any[];
    setSessions(rows.map(r => ({
      ...r,
      partner_id: r.player1_id === uid ? r.player2_id : r.player1_id,
      partner_name: r.player1_id === uid ? (r.p2?.full_name ?? 'Unknown') : (r.p1?.full_name ?? 'Unknown'),
      reviewed: (r.drill_session_reviews ?? []).some((rv: any) => rv.user_id === uid),
      calledOff: drillCalledOff(r.drill_session_rsvps),
    })));

    // Build the red overlay list:
    //  - Scheduled matches: 60-min default since `matches` has no length yet.
    //  - Tournaments I'm approved into: full expected window, split per-day
    //    so weekend-long events paint each day's cells correctly.
    const matchRows = ((matchesRes as any).data ?? []) as { scheduled_at: string | null }[];
    const matchOverlays = matchRows
      .filter(m => m.scheduled_at != null)
      .map(m => {
        const d = new Date(m.scheduled_at as string);
        const slot = d.getHours() * 2 + (d.getMinutes() >= 30 ? 1 : 0);
        return { date: isoDate(d), slot, length_minutes: 60 };
      });

    const tRows = ((tournamentsRes as any).data ?? []) as { tournament: { start_time: string | null; expected_length_hours: number | null; status: string } | null }[];
    const tournamentOverlays = tRows.flatMap(r => {
      const t = r.tournament;
      if (!t || !t.start_time || t.expected_length_hours == null) return [];
      if (t.status === 'completed' || t.status === 'cancelled') return [];
      return spanToDailyOverlays(new Date(t.start_time), Number(t.expected_length_hours));
    });

    setScheduledMatches([...matchOverlays, ...tournamentOverlays]);
  }

  async function persist(updates: Record<string, any>) {
    if (!userId) return;
    const uid = userId;
    setSaveStatus('saving');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    try {
      // Retried through a flaky connection: these are idempotent column
      // writes, and a silently dropped one leaves the UI showing a preference
      // that isn't stored — the user finds out weeks later.
      await sbCall(() => supabase.from('profiles').update(updates).eq('id', uid));
      setSaveStatus('saved');
      saveTimer.current = setTimeout(() => setSaveStatus('idle'), 1200);
    } catch (e) {
      setSaveStatus('error');
      status.error(`Save failed: ${friendlySbMessage(e)}`);
    }
  }

  function toggleEnabled(val: boolean) {
    setEnabled(val);
    persist({ drilling_enabled: val });
  }

  function onAvailabilityChange(av: boolean[]) {
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
    const tag = customDraft.trim();
    if (!tag || customTags.includes(tag) || customTags.length >= 12) return;
    const next = [...customTags, tag];
    setCustomTags(next);
    setCustomDraft('');
    persist({ drill_custom_tags: next });
  }

  function removeCustomTag(tag: string) {
    const next = customTags.filter(x => x !== tag);
    setCustomTags(next);
    persist({ drill_custom_tags: next });
  }

  if (loading) return <View style={{ flex: 1, backgroundColor: colors.bg }}><SkeletonList rows={6} /></View>;

  // Only when we have nothing to show — a refresh that fails keeps the last
  // good screen rather than replacing it with an error.
  if (loadError && !loadedOnce) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <ErrorState
          iconName="offline"
          error={loadError}
          message={`Couldn't load drilling. ${loadError}`}
          onRetry={() => { setLoading(true); void load(); }}
        />
      </View>
    );
  }

  const today = isoDate(new Date());
  const upcomingSessions = sessions.filter(s => s.session_date >= today);
  const pastSessions     = sessions.filter(s => s.session_date <  today).reverse();
  const visibleSessions  = sessionFilter === 'upcoming' ? upcomingSessions : pastSessions;

  // Paint the grid (warning amber) for upcoming sessions inside the rolling 7-day window.
  const visibleDates = new Set(rollingDates());
  const confirmedSlots = upcomingSessions
    .filter(s => visibleDates.has(s.session_date))
    .map(s => ({ date: s.session_date, slot: s.session_slot, length_minutes: s.length_minutes }));
  // Red-paint scheduled matches inside the same window.
  const matchOverlay = scheduledMatches.filter(m => visibleDates.has(m.date));

  // One preference chip: the glyph + label, brand-tinted when picked.
  const prefChip = (p: DrillPref, active: boolean, onToggle: () => void) => (
    <Chip
      key={p.slug}
      label={p.label}
      iconName={p.iconName}
      tone={active ? 'brand' : 'neutral'}
      selected={active}
      onPress={onToggle}
      accessibilityRole="button"
    />
  );

  return (
    <>
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={S.scrollContent}
      scrollEnabled={!scrollLocked}
      refreshControl={<AppRefreshControl {...refresh} />}
    >
      {/* Hero */}
      <View style={S.hero}>
        <Icon name="paddle" size={48} color={colors.headerText} style={S.heroGlyph} />
        <Text style={[t.h1, { color: colors.headerText }]}>Drill Partners</Text>
        <Text style={[t.sub, S.heroSub]}>Find someone to grind cross-court dinks with at 7am.</Text>
      </View>

      <StatusBanner status={status.value} style={S.gutter} />

      {/* Opt-in toggle */}
      <Panel style={[S.card, S.optInCard]}>
        <View style={S.flex}>
          <Text style={t.title}>Open to drilling</Text>
          <Text style={[t.sub, S.optInDesc]}>
            {enabled
              ? 'Other players can find you and send drill requests.'
              : 'You\'re hidden. Turn this on to send and receive drill requests.'}
          </Text>
        </View>
        <ThemedSwitch
          value={enabled}
          onValueChange={toggleEnabled}
          accessibilityLabel="Open to drilling"
        />
      </Panel>

      {!enabled ? (
        <View style={S.disabledHint}>
          <Text style={[t.hint, S.center]}>
            Toggle "Open to drilling" above to set your schedule and find partners.
          </Text>
        </View>
      ) : (
        <>
          {/* Quick actions */}
          <View style={[S.gutter, S.actions]}>
            <ShortcutGrid
              columns={2}
              tileRadius={RADIUS.lg}
              items={[
                {
                  key: 'find',
                  label: 'Find Partners',
                  a11y: 'Find drill partners',
                  iconName: 'search',
                  onPress: () => navigation.navigate('DrillSearch'),
                },
                {
                  key: 'requests',
                  label: 'Requests',
                  a11y: pendingCount > 0 ? `Requests, ${pendingCount} pending` : 'Requests',
                  onPress: () => navigation.navigate('DrillRequests'),
                  glyph: (
                    <View>
                      <Icon name="mail" size={24} color={colors.primary} />
                      {pendingCount > 0 && (
                        <View style={S.actionBadge}>
                          <Text style={t.badge}>{pendingCount > 9 ? '9+' : pendingCount}</Text>
                        </View>
                      )}
                    </View>
                  ),
                },
              ]}
            />
          </View>

          {/* Save status */}
          {saveStatus !== 'idle' && (
            <View style={S.saveStatus}>
              {saveStatus === 'saved' ? <Icon name="check-mark" size={12} color={colors.primary} /> : null}
              <Text style={[t.meta, { color: saveStatus === 'error' ? colors.danger : colors.primary }]}>
                {saveStatus === 'saving' ? 'Saving…' : saveStatus === 'saved' ? 'Saved' : 'Save failed'}
              </Text>
            </View>
          )}

          {/* Drill sessions card */}
          <Panel style={S.card}>
            <View style={S.sessionsHeader}>
              <Text style={t.title}>Drill Sessions</Text>
              <SegmentedToggle
                size="sm"
                showZero
                value={sessionFilter}
                onChange={setSessionFilter}
                options={[
                  { value: 'upcoming', label: 'Upcoming', count: upcomingSessions.length },
                  { value: 'past', label: 'Past', count: pastSessions.length },
                ]}
              />
            </View>
            {visibleSessions.length === 0 ? (
              <EmptyState
                iconName="paddle"
                title={sessionFilter === 'upcoming' ? 'No upcoming sessions yet' : 'No past sessions yet'}
                subtitle={sessionFilter === 'upcoming'
                  ? 'Find a partner and accept a request to schedule one.'
                  : undefined}
              />
            ) : (
              <View style={S.sessionList}>
                {visibleSessions.map(s => (
                  <View key={s.id} style={S.sessionRow}>
                    <View style={[S.sessionDot, sessionFilter === 'past' && S.sessionDotPast]} />
                    <View style={S.flex}>
                      <Text style={t.title} numberOfLines={1}>{s.partner_name}</Text>
                      <Text style={t.sub}>
                        {/* starts_at on this device's clock; the wall-clock slot is the fallback. */}
                        {drillWhenRangeLabel(s.starts_at, { date: s.session_date, slot: s.session_slot }, s.length_minutes ?? 60)} · {durationLabel(s.length_minutes ?? 60)}
                      </Text>
                    </View>
                    {sessionFilter === 'past' && (
                      s.reviewed ? (
                        <View style={S.inline}>
                          <Icon name="check-mark" size={12} color={colors.success} />
                          <Text style={t.meta}>Reviewed</Text>
                        </View>
                      ) : s.calledOff ? (
                        <Text style={t.meta}>Called off</Text>
                      ) : (
                        <Button
                          size="sm"
                          iconName="edit"
                          title="Review"
                          onPress={() => setReviewTarget(s)}
                          accessibilityLabel={`Review your drill with ${s.partner_name}`}
                        />
                      )
                    )}
                  </View>
                ))}
              </View>
            )}
          </Panel>

          {/* Availability grid */}
          <Panel style={S.card}>
            <Text style={t.title}>Your Drill Availability</Text>
            <Text style={[t.hint, S.cardSub]}>Recurring weekly · drag to paint your usual free slots · amber = drill · red = match/tournament (next 7 days)</Text>
            <View style={S.gridWrap}>
              <DrillAvailabilityGrid
                availability={availability}
                onChange={onAvailabilityChange}
                onScrollLock={setScrollLocked}
                confirmedSlots={confirmedSlots}
                scheduledMatchSlots={matchOverlay}
              />
            </View>
          </Panel>

          {/* Shot prefs */}
          <Panel style={S.card}>
            <Text style={t.title}>Shots You Want to Drill</Text>
            <Text style={[t.hint, S.cardSub]}>Pick what you'd like to focus on</Text>
            <View style={S.chipsWrap}>
              {SHOT_PREFS.map(p => prefChip(p, shotPrefs.includes(p.slug), () => toggleShotPref(p.slug)))}
            </View>
          </Panel>

          {/* Partner prefs */}
          <Panel style={S.card}>
            <Text style={t.title}>Partner Preferences</Text>
            <Text style={[t.hint, S.cardSub]}>What you're looking for in a drill partner</Text>
            <View style={S.chipsWrap}>
              {PARTNER_PREFS.map(p => prefChip(p, partnerPrefs.includes(p.slug), () => togglePartnerPref(p.slug)))}
            </View>
          </Panel>

          {/* Custom tags */}
          <Panel style={S.card}>
            <Text style={t.title}>Custom Tags</Text>
            <Text style={[t.hint, S.cardSub]}>Add anything else (max 12)</Text>
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
              <Button
                size="sm"
                title="Add"
                onPress={addCustomTag}
                disabled={!customDraft.trim() || customTags.length >= 12}
              />
            </View>
            {customTags.length > 0 && (
              <View style={S.chipsWrap}>
                {customTags.map(tag => (
                  <TouchableOpacity
                    key={tag}
                    style={S.customChip}
                    onPress={() => removeCustomTag(tag)}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove tag ${tag}`}
                  >
                    <Text style={[t.sub, S.customChipText]}>{tag}</Text>
                    <Icon name="close" size={12} color={colors.primary} />
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </Panel>
        </>
      )}
    </ScrollView>
    <DrillReviewModal
      session={reviewTarget}
      onSubmitted={(sessionId, earned) => {
        setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, reviewed: true } : s));
        setReviewTarget(null);
        // null: an earlier try saved it and its answer was lost (amount unknown).
        status.success(earned != null ? `+${earned} pickles earned!` : 'Your review was saved.');
      }}
      onClose={() => setReviewTarget(null)}
    />
    </>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    // Clears the floating nav bar.
    scrollContent: { paddingBottom: SPACE.xl * 2 + SPACE.md },
    gutter:        { marginHorizontal: SPACE.lg },
    flex:          { flex: 1, minWidth: 0 },
    center:        { textAlign: 'center' },
    inline:        { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs },

    hero:          { backgroundColor: c.headerBg, paddingVertical: SPACE.xl, paddingHorizontal: SPACE.xl, alignItems: 'center' },
    heroGlyph:     { marginBottom: SPACE.sm },
    heroSub:       { color: c.headerSub, marginTop: SPACE.xs, textAlign: 'center' },

    card:          { marginHorizontal: SPACE.lg, marginTop: SPACE.md },
    optInCard:     { flexDirection: 'row', alignItems: 'center', gap: SPACE.md, marginTop: SPACE.lg },
    optInDesc:     { marginTop: SPACE.xxs },

    disabledHint:  { padding: SPACE.xl, alignItems: 'center' },

    actions:       { marginTop: SPACE.md },
    actionBadge:   {
      position: 'absolute', top: -(SPACE.xs + SPACE.xxs), right: -SPACE.md,
      backgroundColor: c.danger, minWidth: 18, height: 18, borderRadius: RADIUS.pill,
      paddingHorizontal: SPACE.xs, alignItems: 'center', justifyContent: 'center',
    },

    saveStatus:    { flexDirection: 'row', alignItems: 'center', alignSelf: 'center', gap: SPACE.xs, marginTop: SPACE.sm },

    cardSub:       { marginTop: SPACE.xxs },
    gridWrap:      { marginTop: SPACE.sm },

    chipsWrap:     { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, marginTop: SPACE.md },

    customRow:     { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, marginTop: SPACE.md },
    customInput:   {
      flex: 1, minHeight: 44, borderWidth: 1.5, borderColor: c.border, borderRadius: RADIUS.md,
      paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, fontSize: FONT.size.md, color: c.text, backgroundColor: c.surface,
    },
    customChip:    {
      flexDirection: 'row', alignItems: 'center', gap: SPACE.xs,
      minHeight: 32, paddingHorizontal: SPACE.md, paddingVertical: SPACE.xs,
      borderRadius: RADIUS.pill, borderWidth: 1.5, borderColor: c.primary, backgroundColor: c.primaryLight,
    },
    customChipText:{ color: c.primary, fontWeight: FONT.weight.semibold },

    sessionsHeader:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: SPACE.sm },
    sessionList:       { marginTop: SPACE.md, gap: SPACE.sm },
    sessionRow:        { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 44, paddingVertical: SPACE.sm, paddingHorizontal: SPACE.md, backgroundColor: c.surfaceAlt, borderRadius: RADIUS.md },
    sessionDot:        { width: 10, height: 10, borderRadius: RADIUS.pill, backgroundColor: c.warning },
    sessionDotPast:    { backgroundColor: c.textMuted },
  });
}
