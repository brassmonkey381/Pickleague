import React, { useState } from 'react';
import {
  ScrollView, Text, TouchableOpacity, StyleSheet,
  View, ActivityIndicator, Modal, Alert, TextInput,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { getLeagueRole, isPrivileged, LeagueRole, roleLabel, roleBadgeColor } from '../lib/leagueRole';
import { checkGodmode } from '../lib/godmode';
import { getRegionName } from '../lib/regions';
import CourtPicker, { CourtResult } from '../components/CourtPicker';
import AppDateTimePicker from '../components/AppDateTimePicker';
import ConfirmModal from '../components/ConfirmModal';
import { League, LeagueSeason, RootStackParamList } from '../types';
import { useTheme } from '../lib/ThemeContext';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'LeagueDetail'>;
  route: RouteProp<RootStackParamList, 'LeagueDetail'>;
};
type Option = { icon: string; label: string; sub: string; onPress: () => void; adminOnly?: boolean };

type LatestChampion = {
  tournamentId:   string;
  tournamentName: string;
  teamName:       string;
  winners:        string[];      // full names
  record:         string | null; // "12-4" or null when no record data
};

type ComingUpItem = {
  key:    string;
  kind:   'tournament' | 'event';
  icon:   string;
  title:  string;
  whenLabel: string;
  whenMs: number;
  badge?: string;        // e.g. "Voting"
  onPress: () => void;
};

const WEEK_PRESETS    = [3, 6, 12] as const;
const LOCK_PRESETS    = [1, 2, 4]  as const;

function formatRoster(names: string[]): string {
  if (names.length === 0) return 'the champions';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

export default function LeagueDetailScreen({ navigation, route }: Props) {
  const { leagueId, leagueName } = route.params;
  const { colors } = useTheme();
  const S = makeStyles(colors);

  const [myRole, setMyRole]   = useState<LeagueRole>(null);
  const [league, setLeague]   = useState<League | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeSeason, setActiveSeason] = useState<LeagueSeason | null>(null);
  const [pastSeasons, setPastSeasons]   = useState<LeagueSeason[]>([]);
  const [godmode, setGodmode]           = useState(false);
  const [latestChampion, setLatestChampion] = useState<LatestChampion | null>(null);
  const [upcomingTournaments, setUpcomingTournaments] = useState<ComingUpItem[]>([]);
  const [upcomingEvents, setUpcomingEvents]           = useState<ComingUpItem[]>([]);
  const [comingUpLoaded, setComingUpLoaded]           = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting]         = useState(false);
  const [deleteError, setDeleteError]   = useState<string | null>(null);

  // League edit modal
  const [editVisible, setEditVisible]   = useState(false);
  const [pendingName, setPendingName]   = useState('');
  const [pendingDesc, setPendingDesc]   = useState('');
  const [pendingIsOpen, setPendingIsOpen] = useState(true);
  const [pendingCourt, setPendingCourt] = useState<CourtResult | null>(null);
  const [saving, setSaving]             = useState(false);

  // Season setup modal
  const [seasonModal, setSeasonModal]         = useState(false);
  const [seasonName, setSeasonName]           = useState('');
  const [seasonStart, setSeasonStart]         = useState(new Date());
  const [showDatePicker, setShowDatePicker]   = useState(false);
  const [totalWeeks, setTotalWeeks]           = useState(12);
  const [customWeeks, setCustomWeeks]         = useState('');
  const [lockWeeks, setLockWeeks]             = useState(2);
  const [customLock, setCustomLock]           = useState('');
  const [creatingSeasonFlag, setCreatingSeasonFlag] = useState(false);

  useFocusEffect(
    React.useCallback(() => {
      load();
    }, [leagueId])
  );

  async function load() {
    const [role, leagueRes, seasonRes, completedRes, godmodeResult] = await Promise.all([
      getLeagueRole(leagueId),
      supabase.from('leagues').select('*').eq('id', leagueId).single(),
      supabase.from('league_seasons')
        .select('*')
        .eq('league_id', leagueId)
        .in('status', ['upcoming', 'active'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase.from('league_seasons')
        .select('*')
        .eq('league_id', leagueId)
        .eq('status', 'completed')
        .order('end_date', { ascending: false }),
      checkGodmode(),
    ]);
    setMyRole(role);
    setLeague(leagueRes.data as League);
    setActiveSeason((seasonRes.data as LeagueSeason) ?? null);
    setPastSeasons((completedRes.data ?? []) as LeagueSeason[]);
    setGodmode(godmodeResult);
    setLoading(false);

    // Fire the league-recap + coming-up loaders in parallel after the main
    // render. Errors here are non-fatal — the cards just won't render.
    void loadLatestChampion();
    void loadComingUp();
  }

  async function loadLatestChampion() {
    // Most recent completed tournament in this league.
    const { data: t } = await supabase
      .from('tournaments')
      .select('id, name, status')
      .eq('league_id', leagueId)
      .eq('status', 'completed')
      .order('updated_at', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!t) { setLatestChampion(null); return; }

    // First-place winners from the champion-badges table (MLP auto-payout).
    const { data: badges } = await supabase
      .from('tournament_champion_badges')
      .select('user_id, team_name, team_id')
      .eq('tournament_id', t.id)
      .eq('place', 1);
    if (!badges || badges.length === 0) { setLatestChampion(null); return; }

    const winnerUids  = badges.map((b: any) => b.user_id);
    const teamName    = (badges[0] as any).team_name ?? 'Champions';
    const winningTeamId = (badges[0] as any).team_id ?? null;

    const [profilesRes, standingsRes] = await Promise.all([
      supabase.from('profiles').select('id, full_name').in('id', winnerUids),
      winningTeamId
        ? supabase.rpc('mlp_team_standings', { p_tournament_id: t.id })
        : Promise.resolve({ data: null } as any),
    ]);

    const nameMap: Record<string, string> = {};
    for (const p of (profilesRes.data ?? []) as any[]) nameMap[p.id] = p.full_name ?? '—';
    const winners = winnerUids.map((u: string) => nameMap[u] ?? '—');

    let record: string | null = null;
    if (winningTeamId && standingsRes?.data) {
      const winRow = (standingsRes.data as any[]).find(r => r.team_id === winningTeamId);
      if (winRow) record = `${winRow.sub_matches_won}-${winRow.sub_matches_lost}`;
    }

    setLatestChampion({
      tournamentId: t.id,
      tournamentName: t.name,
      teamName,
      winners,
      record,
    });
  }

  async function loadComingUp() {
    const fmt = (ms: number) => new Date(ms).toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });

    const [tRes, scheduledRes, votingRes] = await Promise.all([
      supabase.from('tournaments')
        .select('id, name, start_time, status')
        .eq('league_id', leagueId)
        .in('status', ['registration', 'active'])
        .order('start_time', { ascending: true, nullsFirst: false })
        .limit(5),
      // Scheduled events with a confirmed future slot.
      supabase.from('league_events')
        .select('id, title, status, confirmed_slot_id, event_slots:event_slots!league_events_confirmed_slot_id_fkey(starts_at)')
        .eq('league_id', leagueId)
        .eq('status', 'scheduled'),
      // Events currently being voted on.
      supabase.from('league_events')
        .select('id, title, status, vote_ends_at')
        .eq('league_id', leagueId)
        .eq('status', 'voting'),
    ]);

    // Tournaments
    const tItems: ComingUpItem[] = [];
    for (const t of ((tRes.data ?? []) as any[])) {
      if (!t.start_time) continue;
      const ms = new Date(t.start_time).getTime();
      if (ms < Date.now()) continue;
      tItems.push({
        key:   `t-${t.id}`,
        kind:  'tournament',
        icon:  '🎾',
        title: t.name,
        whenLabel: fmt(ms),
        whenMs: ms,
        onPress: () => navigation.navigate('TournamentDetail', { tournamentId: t.id, tournamentName: t.name }),
      });
    }
    tItems.sort((a, b) => a.whenMs - b.whenMs);

    // Events: scheduled (with future slot) + voting (with vote_ends_at in future)
    const eItems: ComingUpItem[] = [];

    for (const ev of ((scheduledRes.data ?? []) as any[])) {
      const slot = Array.isArray(ev.event_slots) ? ev.event_slots[0] : ev.event_slots;
      if (!slot?.starts_at) continue;
      const ms = new Date(slot.starts_at).getTime();
      if (ms < Date.now()) continue;
      eItems.push({
        key:   `e-${ev.id}`,
        kind:  'event',
        icon:  '📅',
        title: ev.title,
        whenLabel: fmt(ms),
        whenMs: ms,
        onPress: () => navigation.navigate('EventDetail', { eventId: ev.id, title: ev.title }),
      });
    }

    for (const ev of ((votingRes.data ?? []) as any[])) {
      if (!ev.vote_ends_at) continue;
      const ms = new Date(ev.vote_ends_at).getTime();
      if (ms < Date.now()) continue;
      eItems.push({
        key:   `v-${ev.id}`,
        kind:  'event',
        icon:  '🗳️',
        title: ev.title,
        whenLabel: `Voting ends ${fmt(ms)}`,
        whenMs: ms,
        badge: 'Voting',
        onPress: () => navigation.navigate('EventDetail', { eventId: ev.id, title: ev.title }),
      });
    }
    eItems.sort((a, b) => a.whenMs - b.whenMs);

    setUpcomingTournaments(tItems.slice(0, 2));
    setUpcomingEvents(eItems.slice(0, 3));
    setComingUpLoaded(true);
  }

  function deleteLeague() {
    if (!league) return;
    setDeleteError(null);
    setShowDeleteConfirm(true);
  }
  async function confirmDeleteLeague() {
    if (!league) return;
    setDeleting(true);
    setDeleteError(null);
    // Prefer the SECURITY DEFINER RPC (bypasses RLS). Fall back to direct delete.
    const rpc = await supabase.rpc('godmode_delete_league', { p_league_id: league.id });
    if (rpc.error) {
      const msg = rpc.error.message ?? '';
      const looksMissing = /does not exist|Could not find the function|PGRST202/i.test(msg);
      if (looksMissing) {
        const fallback = await supabase.from('leagues').delete().eq('id', league.id).select();
        if (fallback.error) {
          setDeleteError(fallback.error.message);
          setDeleting(false);
          return;
        }
        if (!fallback.data || fallback.data.length === 0) {
          setDeleteError('No rows were deleted. Run supabase/migration_add_godmode_delete_rpc.sql.');
          setDeleting(false);
          return;
        }
      } else {
        setDeleteError(msg || 'Delete failed.');
        setDeleting(false);
        return;
      }
    }
    setDeleting(false);
    setShowDeleteConfirm(false);
    navigation.goBack();
  }

  async function saveLeagueChanges() {
    if (!league) return;
    const trimmedName = pendingName.trim();
    if (!trimmedName) { Alert.alert('', 'League name is required.'); return; }

    setSaving(true);
    const newCourtName = pendingCourt?.name ?? null;
    const homeCourtChanged = newCourtName !== league.home_court;

    const { error } = await supabase.from('leagues').update({
      name:           trimmedName,
      description:    pendingDesc.trim() || null,
      is_open:        pendingIsOpen,
      home_court:     newCourtName,
      home_court_lat: pendingCourt?.lat ?? null,
      home_court_lng: pendingCourt?.lng ?? null,
    }).eq('id', leagueId);
    if (error) { Alert.alert('Error', error.message); setSaving(false); return; }

    // Re-derive is_home_court on existing matches only if home court changed
    if (homeCourtChanged) {
      const { data: allMatches } = await supabase.from('matches').select('id, location_name').eq('league_id', leagueId);
      if (allMatches) {
        for (const m of allMatches) {
          const isHome = !!(m.location_name && newCourtName && m.location_name === newCourtName);
          await supabase.from('matches').update({ is_home_court: isHome }).eq('id', m.id);
        }
      }
    }

    setSaving(false);
    setEditVisible(false);
    const { data } = await supabase.from('leagues').select('*').eq('id', leagueId).single();
    setLeague(data as League);
  }

  function openEdit() {
    if (!league) return;
    setPendingName(league.name);
    setPendingDesc(league.description ?? '');
    setPendingIsOpen(league.is_open);
    setPendingCourt(
      league.home_court
        ? { name: league.home_court, address: '', lat: league.home_court_lat ?? 0, lng: league.home_court_lng ?? 0, placeId: '' }
        : null
    );
    setEditVisible(true);
  }

  // ── Season creation ───────────────────────────────────────────

  function openSeasonModal() {
    // Auto-suggest a season name based on how many exist
    supabase.from('league_seasons').select('id', { count: 'exact', head: true }).eq('league_id', leagueId)
      .then(({ count }) => setSeasonName(`Season ${(count ?? 0) + 1}`));
    setSeasonStart(new Date());
    setTotalWeeks(12);
    setLockWeeks(2);
    setCustomWeeks('');
    setCustomLock('');
    setSeasonModal(true);
  }

  const effectiveWeeks = totalWeeks === 0 ? parseInt(customWeeks || '0', 10) : totalWeeks;
  const effectiveLock  = lockWeeks  === 0 ? parseInt(customLock  || '0', 10) : lockWeeks;

  function computeLockDates(): Date[] {
    if (!effectiveWeeks || !effectiveLock) return [];
    const dates: Date[] = [];
    const periods = Math.floor(effectiveWeeks / effectiveLock);
    for (let i = 1; i <= periods; i++) {
      const d = new Date(seasonStart);
      d.setDate(d.getDate() + i * effectiveLock * 7);
      dates.push(d);
    }
    return dates;
  }

  async function createSeason() {
    if (!seasonName.trim()) return Alert.alert('', 'Please enter a season name.');
    if (!effectiveWeeks || effectiveWeeks < 1) return Alert.alert('', 'Please set a valid duration.');
    if (!effectiveLock || effectiveLock < 1)  return Alert.alert('', 'Please set a valid lock frequency.');
    if (effectiveLock > effectiveWeeks)        return Alert.alert('', 'Lock frequency cannot exceed season length.');

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    setCreatingSeasonFlag(true);
    const startStr = seasonStart.toISOString().split('T')[0];
    const endDate  = new Date(seasonStart);
    endDate.setDate(endDate.getDate() + effectiveWeeks * 7);
    const endStr   = endDate.toISOString().split('T')[0];

    const { error } = await supabase.from('league_seasons').insert({
      league_id:            leagueId,
      name:                 seasonName.trim(),
      start_date:           startStr,
      end_date:             endStr,
      total_weeks:          effectiveWeeks,
      lock_frequency_weeks: effectiveLock,
      status:               new Date() >= seasonStart ? 'active' : 'upcoming',
      created_by:           user.id,
    });
    setCreatingSeasonFlag(false);
    if (error) { Alert.alert('Error', error.message); return; }
    setSeasonModal(false);
    load();
  }

  // ── Data ──────────────────────────────────────────────────────

  if (loading) return <ActivityIndicator style={{ flex: 1 }} size="large" color={colors.primary} />;

  const privileged = isPrivileged(myRole);
  const isAdmin    = myRole === 'admin';
  const region     = getRegionName(league?.home_court_lat ?? null, league?.home_court_lng ?? null);

  const options: Option[] = [
    {
      icon: '🏓', label: 'Record Match',
      sub: 'Enter a singles or doubles result',
      onPress: () => navigation.navigate('MatchEntry', { leagueId }),
    },
    {
      icon: '🗳️', label: 'Schedule & Events',
      sub: privileged ? 'Propose play sessions, vote on availability' : 'View upcoming events and vote',
      onPress: () => navigation.navigate('Events', { leagueId, leagueName }),
    },
    {
      icon: '📜', label: 'Match History',
      sub: 'All completed matches with dates & scores',
      onPress: () => navigation.navigate('MatchHistory', { leagueId, title: `${leagueName} History` }),
    },
    {
      icon: '🗓️', label: 'Calendar Analytics',
      sub: 'W-L records and PLUPR changes by day',
      onPress: () => navigation.navigate('CalendarAnalytics', { leagueId, title: `${leagueName} Calendar` }),
    },
    {
      icon: '👥', label: 'Members',
      sub: privileged ? 'View members, manage roles, find players' : 'View league members',
      onPress: () => navigation.navigate('LeagueMembers', { leagueId, leagueName }),
    },
    {
      icon: '🎾', label: 'Tournaments',
      sub: 'Create and manage tournaments',
      onPress: () => navigation.navigate('Tournaments', { leagueId, leagueName }),
    },
    ...(privileged ? [{
      icon: '✉️', label: 'Invite Players',
      sub: !league?.is_open ? 'League is private — share invite codes' : 'Share invite codes',
      onPress: () => navigation.navigate('Invite', { leagueId, leagueName }),
      adminOnly: true,
    }] : []),
  ];

  const lockDates = seasonModal ? computeLockDates() : [];

  return (
    <ScrollView contentContainerStyle={S.container}>

      {/* ── Home court banner ──────────────────────────────────── */}
      <View style={S.courtBanner}>
        <Text style={S.courtIcon}>📍</Text>
        <View style={S.courtInfo}>
          <Text style={S.courtLabel}>Home Court</Text>
          <Text style={S.courtName} numberOfLines={1}>{league?.home_court ?? 'Not set'}</Text>
          {region && <Text style={S.courtRegion}>{region}</Text>}
        </View>
      </View>

      {/* ── League description + privacy ───────────────────────── */}
      <View style={S.infoCard}>
        <View style={S.infoHeader}>
          <View style={[S.privacyBadge, league?.is_open ? S.privacyPublic : S.privacyPrivate]}>
            <Text style={[S.privacyText, league?.is_open ? S.privacyPublicText : S.privacyPrivateText]}>
              {league?.is_open ? '🌐 Public' : '🔒 Private'}
            </Text>
          </View>
          {privileged && (godmode || league?.is_active) && (
            <TouchableOpacity style={S.editLeagueBtn} onPress={openEdit}>
              <Text style={S.editLeagueText}>Edit League</Text>
            </TouchableOpacity>
          )}
        </View>
        {!league?.is_active && (
          <View style={S.closedBanner}>
            <Text style={S.closedBannerText}>🔒 This league is closed — edits are locked.</Text>
          </View>
        )}
        <Text style={league?.description ? S.descText : S.descPlaceholder}>
          {league?.description ?? (privileged ? 'No description yet — tap "Edit League" to add one.' : 'No description.')}
        </Text>
        <TouchableOpacity
          style={S.howItWorksLink}
          onPress={() => navigation.navigate('LeagueInfo', { leagueId, leagueName })}
        >
          <Text style={S.howItWorksText}>ℹ️ How this league works →</Text>
        </TouchableOpacity>
      </View>

      {/* ── Role badge ─────────────────────────────────────────── */}
      {myRole && (
        <View style={[S.roleBanner, { backgroundColor: roleBadgeColor(myRole) + '18', borderColor: roleBadgeColor(myRole) + '44' }]}>
          <Text style={[S.roleText, { color: roleBadgeColor(myRole) }]}>
            Your role: {roleLabel(myRole)}
          </Text>
        </View>
      )}

      {/* ── Active season card ─────────────────────────────────── */}
      {activeSeason ? (
        <View style={S.seasonCard}>
          <View style={S.seasonCardTop}>
            <View>
              <Text style={S.seasonCardLabel}>Active Season</Text>
              <Text style={S.seasonCardName}>{activeSeason.name}</Text>
            </View>
            <View style={[S.seasonStatusBadge, activeSeason.status === 'active' ? S.seasonBadgeActive : S.seasonBadgeUpcoming]}>
              <Text style={[S.seasonStatusText, activeSeason.status === 'active' ? S.seasonBadgeActiveText : S.seasonBadgeUpcomingText]}>
                {activeSeason.status === 'active' ? 'Active' : 'Upcoming'}
              </Text>
            </View>
          </View>
          <Text style={S.seasonCardMeta}>
            {activeSeason.total_weeks} weeks · every {activeSeason.lock_frequency_weeks}w lock-in · {activeSeason.total_periods} periods
          </Text>
          <Text style={S.seasonCardDates}>
            {new Date(activeSeason.start_date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            {' → '}
            {new Date(activeSeason.end_date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
          </Text>
          <TouchableOpacity
            style={S.seasonViewBtn}
            onPress={() => navigation.navigate('SeasonStandings', { seasonId: activeSeason.id, leagueId, leagueName })}
          >
            <Text style={S.seasonViewBtnText}>View Season Standings & Controls →</Text>
          </TouchableOpacity>
        </View>
      ) : privileged ? (
        <TouchableOpacity style={S.noSeasonCard} onPress={openSeasonModal}>
          <Text style={S.noSeasonIcon}>🏆</Text>
          <View style={S.noSeasonText}>
            <Text style={S.noSeasonTitle}>No Active Season</Text>
            <Text style={S.noSeasonSub}>Start a season to track standings over time with periodic rankings lock-in and end-of-period PLUPR resets.</Text>
          </View>
          <Text style={S.noSeasonCta}>Start →</Text>
        </TouchableOpacity>
      ) : null}

      {/* ── Latest tournament champion ─────────────────────────── */}
      {latestChampion && (
        <TouchableOpacity
          style={S.championCard}
          onPress={() => navigation.navigate('TournamentDetail', {
            tournamentId: latestChampion.tournamentId,
            tournamentName: latestChampion.tournamentName,
          })}
          activeOpacity={0.85}
        >
          <Text style={S.championLabel}>🏆 Latest Tournament Champion</Text>
          <Text style={S.championLead}>
            <Text style={S.championTeam}>{latestChampion.teamName}</Text>
            {' '}took home {latestChampion.tournamentName}!
          </Text>
          {latestChampion.record && (
            <Text style={S.championRecord}>Final record: {latestChampion.record}</Text>
          )}
          <Text style={S.championRoster}>
            🎉 Congrats to {formatRoster(latestChampion.winners)}!
          </Text>
          <Text style={S.championLink}>View tournament →</Text>
        </TouchableOpacity>
      )}

      {/* ── Upcoming tournaments ───────────────────────────────── */}
      {comingUpLoaded && (
        <View style={S.comingUpCard}>
          <Text style={S.comingUpHeader}>🎾 Upcoming Tournaments</Text>
          {upcomingTournaments.length === 0 ? (
            <Text style={S.comingUpEmpty}>No upcoming tournaments.</Text>
          ) : (
            upcomingTournaments.map(item => (
              <TouchableOpacity
                key={item.key}
                style={S.comingUpRow}
                onPress={item.onPress}
                activeOpacity={0.7}
              >
                <Text style={S.comingUpIcon}>{item.icon}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={S.comingUpTitle}>{item.title}</Text>
                  <Text style={S.comingUpWhen}>{item.whenLabel}</Text>
                </View>
                {item.badge && (
                  <View style={S.comingUpBadge}>
                    <Text style={S.comingUpBadgeText}>{item.badge}</Text>
                  </View>
                )}
                <Text style={S.comingUpChevron}>›</Text>
              </TouchableOpacity>
            ))
          )}
        </View>
      )}

      {/* ── Upcoming events (scheduled + currently voting) ─────── */}
      {comingUpLoaded && (
        <View style={S.comingUpCard}>
          <Text style={S.comingUpHeader}>📅 Upcoming Events</Text>
          {upcomingEvents.length === 0 ? (
            <Text style={S.comingUpEmpty}>No upcoming events.</Text>
          ) : (
            upcomingEvents.map(item => (
              <TouchableOpacity
                key={item.key}
                style={S.comingUpRow}
                onPress={item.onPress}
                activeOpacity={0.7}
              >
                <Text style={S.comingUpIcon}>{item.icon}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={S.comingUpTitle}>{item.title}</Text>
                  <Text style={S.comingUpWhen}>{item.whenLabel}</Text>
                </View>
                {item.badge && (
                  <View style={S.comingUpBadge}>
                    <Text style={S.comingUpBadgeText}>{item.badge}</Text>
                  </View>
                )}
                <Text style={S.comingUpChevron}>›</Text>
              </TouchableOpacity>
            ))
          )}
        </View>
      )}

      {/* ── Past seasons ───────────────────────────────────────── */}
      {pastSeasons.length > 0 && (
        <View style={S.pastSeasonsCard}>
          <Text style={S.pastSeasonsHeader}>Past Seasons ({pastSeasons.length})</Text>
          {pastSeasons.map(s => (
            <TouchableOpacity
              key={s.id}
              style={S.pastSeasonRow}
              onPress={() => navigation.navigate('SeasonStandings', { seasonId: s.id, leagueId, leagueName })}
              activeOpacity={0.7}
            >
              <Text style={S.pastSeasonTrophy}>🏁</Text>
              <View style={{ flex: 1 }}>
                <Text style={S.pastSeasonName}>{s.name}</Text>
                <Text style={S.pastSeasonMeta}>
                  {new Date(s.start_date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                  {' → '}
                  {new Date(s.end_date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                  {'  ·  '}{s.total_periods} periods
                </Text>
              </View>
              <Text style={S.pastSeasonChevron}>›</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* ── Option cards ───────────────────────────────────────── */}
      {options.map((opt) => (
        <TouchableOpacity key={opt.label} style={S.card} onPress={opt.onPress}>
          <Text style={S.cardIcon}>{opt.icon}</Text>
          <View style={S.cardText}>
            <Text style={S.label}>{opt.label}</Text>
            <Text style={S.sub}>{opt.sub}</Text>
          </View>
          {opt.adminOnly && (
            <View style={S.adminTag}>
              <Text style={S.adminTagText}>Admin</Text>
            </View>
          )}
        </TouchableOpacity>
      ))}

      {/* ── Godmode delete ─────────────────────────────────────── */}
      {godmode && (
        <TouchableOpacity style={S.dangerBtn} onPress={deleteLeague} activeOpacity={0.85}>
          <Text style={S.dangerBtnText}>🗑  Delete League (godmode)</Text>
          <Text style={S.dangerBtnSub}>Removes the league and everything cascaded under it.</Text>
        </TouchableOpacity>
      )}

      {/* ── Edit league modal ──────────────────────────────────── */}
      <Modal visible={editVisible} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setEditVisible(false)}>
        <ScrollView contentContainerStyle={S.modal} keyboardShouldPersistTaps="handled">
          <Text style={S.modalTitle}>Edit League</Text>

          <Text style={S.fieldLabel}>Name</Text>
          <TextInput
            style={S.input}
            value={pendingName}
            onChangeText={setPendingName}
            placeholder="League name"
            placeholderTextColor={colors.textMuted}
            maxLength={80}
          />

          <Text style={S.fieldLabel}>Description</Text>
          <TextInput
            style={[S.input, S.inputMultiline]}
            value={pendingDesc}
            onChangeText={setPendingDesc}
            placeholder="What's this league about?"
            placeholderTextColor={colors.textMuted}
            multiline
            numberOfLines={4}
            maxLength={500}
          />

          <Text style={S.fieldLabel}>Privacy</Text>
          <View style={S.privacyRow}>
            <TouchableOpacity
              style={[S.privacyOption, pendingIsOpen && S.privacyOptionActive]}
              onPress={() => setPendingIsOpen(true)}
              activeOpacity={0.8}
            >
              <Text style={[S.privacyOptionTitle, pendingIsOpen && S.privacyOptionTitleActive]}>🌐 Public</Text>
              <Text style={S.privacyOptionSub}>Anyone can join freely</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[S.privacyOption, !pendingIsOpen && S.privacyOptionActive]}
              onPress={() => setPendingIsOpen(false)}
              activeOpacity={0.8}
            >
              <Text style={[S.privacyOptionTitle, !pendingIsOpen && S.privacyOptionTitleActive]}>🔒 Private</Text>
              <Text style={S.privacyOptionSub}>Invite or request only</Text>
            </TouchableOpacity>
          </View>

          <Text style={S.fieldLabel}>Home Court</Text>
          <Text style={S.modalHint}>
            Changing the home court updates the home/away status of all past matches in this league.
          </Text>
          <CourtPicker value={pendingCourt} onSelect={setPendingCourt} active={editVisible} showNoneOption placeholder="Search for the home court…" />
          {!pendingCourt && (
            <View style={S.warning}><Text style={S.warningText}>⚠️ Without a home court every match entry requires a location.</Text></View>
          )}

          <TouchableOpacity style={[S.saveBtn, saving && S.saveBtnDisabled]} onPress={saveLeagueChanges} disabled={saving}>
            <Text style={S.saveBtnText}>{saving ? 'Saving…' : 'Save Changes'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={S.cancelBtn} onPress={() => setEditVisible(false)}>
            <Text style={S.cancelBtnText}>Cancel</Text>
          </TouchableOpacity>
        </ScrollView>
      </Modal>

      {/* ── Create season modal ────────────────────────────────── */}
      <Modal visible={seasonModal} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setSeasonModal(false)}>
        <ScrollView contentContainerStyle={S.modal} keyboardShouldPersistTaps="handled">
          <Text style={S.modalTitle}>🏆 Start a New Season</Text>

          {/* Season name */}
          <Text style={S.fieldLabel}>Season Name</Text>
          <TextInput
            style={S.input}
            value={seasonName}
            onChangeText={setSeasonName}
            placeholder="e.g. Season 1, Spring 2025"
            placeholderTextColor={colors.textMuted}
          />

          {/* Start date */}
          <Text style={S.fieldLabel}>Start Date</Text>
          <TouchableOpacity style={S.dateBtn} onPress={() => setShowDatePicker(true)}>
            <Text style={S.dateBtnText}>
              📅 {seasonStart.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}
            </Text>
          </TouchableOpacity>

          {/* Duration presets */}
          <Text style={S.fieldLabel}>Season Length</Text>
          <View style={S.presetRow}>
            {WEEK_PRESETS.map(w => (
              <TouchableOpacity
                key={w}
                style={[S.presetBtn, totalWeeks === w && S.presetBtnActive]}
                onPress={() => { setTotalWeeks(w); setCustomWeeks(''); }}
              >
                <Text style={[S.presetBtnText, totalWeeks === w && S.presetBtnTextActive]}>{w} weeks</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              style={[S.presetBtn, totalWeeks === 0 && S.presetBtnActive]}
              onPress={() => setTotalWeeks(0)}
            >
              <Text style={[S.presetBtnText, totalWeeks === 0 && S.presetBtnTextActive]}>Custom</Text>
            </TouchableOpacity>
          </View>
          {totalWeeks === 0 && (
            <TextInput
              style={S.input}
              value={customWeeks}
              onChangeText={setCustomWeeks}
              keyboardType="number-pad"
              placeholder="Enter number of weeks"
              placeholderTextColor={colors.textMuted}
            />
          )}

          {/* Lock frequency presets */}
          <Text style={S.fieldLabel}>Lock-In Frequency</Text>
          <Text style={S.fieldHint}>How often standings are frozen as a snapshot</Text>
          <View style={S.presetRow}>
            {LOCK_PRESETS.map(w => (
              <TouchableOpacity
                key={w}
                style={[S.presetBtn, lockWeeks === w && S.presetBtnActive]}
                onPress={() => { setLockWeeks(w); setCustomLock(''); }}
              >
                <Text style={[S.presetBtnText, lockWeeks === w && S.presetBtnTextActive]}>
                  Every {w}w
                </Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              style={[S.presetBtn, lockWeeks === 0 && S.presetBtnActive]}
              onPress={() => setLockWeeks(0)}
            >
              <Text style={[S.presetBtnText, lockWeeks === 0 && S.presetBtnTextActive]}>Custom</Text>
            </TouchableOpacity>
          </View>
          {lockWeeks === 0 && (
            <TextInput
              style={S.input}
              value={customLock}
              onChangeText={setCustomLock}
              keyboardType="number-pad"
              placeholder="Enter lock frequency in weeks"
              placeholderTextColor={colors.textMuted}
            />
          )}

          {/* Lock-in schedule preview */}
          {lockDates.length > 0 && (
            <View style={S.previewBox}>
              <Text style={S.previewTitle}>
                {lockDates.length} lock-in period{lockDates.length !== 1 ? 's' : ''} · final standings = median rank
              </Text>
              {lockDates.map((d, i) => (
                <Text key={i} style={S.previewLine}>
                  Period {i + 1}: {d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                  {i === lockDates.length - 1 ? '  ← season ends' : ''}
                </Text>
              ))}
              <Text style={S.previewReset}>
                PLUPR soft-reset after each period: top 5 players carry rank bonuses (+0.40/+0.275/+0.175/+0.10/+0.05), everyone else resets to 3.250.
              </Text>
            </View>
          )}

          <TouchableOpacity
            style={[S.saveBtn, creatingSeasonFlag && S.saveBtnDisabled]}
            onPress={createSeason}
            disabled={creatingSeasonFlag}
          >
            <Text style={S.saveBtnText}>{creatingSeasonFlag ? 'Creating…' : 'Create Season'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={S.cancelBtn} onPress={() => setSeasonModal(false)}>
            <Text style={S.cancelBtnText}>Cancel</Text>
          </TouchableOpacity>
        </ScrollView>
      </Modal>

      {/* Date picker for season start */}
      <AppDateTimePicker
        visible={showDatePicker}
        value={seasonStart}
        minimumDate={new Date()}
        onChange={d => setSeasonStart(d)}
        onClose={() => setShowDatePicker(false)}
      />

      <ConfirmModal
        visible={showDeleteConfirm}
        title={`Delete "${league?.name ?? ''}"?`}
        body="This permanently removes the league and all of its members, matches, events, seasons, and tournaments. This cannot be undone."
        primaryLabel="Delete League"
        variant="danger"
        busy={deleting}
        error={deleteError}
        onConfirm={confirmDeleteLeague}
        onClose={() => setShowDeleteConfirm(false)}
      />
    </ScrollView>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container:  { padding: 16, gap: 10 },

    courtBanner:    { backgroundColor: c.surface, borderRadius: 14, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: c.primaryLight, elevation: 2, shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
    courtIcon:      { fontSize: 24 },
    courtInfo:      { flex: 1 },
    courtLabel:     { fontSize: 11, color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.8, fontWeight: '700' },
    courtName:      { fontSize: 15, fontWeight: '700', color: c.text, marginTop: 1 },
    courtRegion:    { fontSize: 12, color: c.textMuted, marginTop: 1 },
    editCourtBtn:   { borderWidth: 1, borderColor: c.primary, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 5 },
    editCourtText:  { fontSize: 13, color: c.primary, fontWeight: '600' },

    infoCard:       { backgroundColor: c.surface, borderRadius: 14, padding: 14, gap: 10, elevation: 2, shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
    infoHeader:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
    privacyBadge:   { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 12 },
    privacyPublic:  { backgroundColor: c.primaryLight },
    privacyPrivate: { backgroundColor: '#fff8e1' },
    privacyText:    { fontSize: 12, fontWeight: '700' },
    privacyPublicText:  { color: c.primary },
    privacyPrivateText: { color: '#b8860b' },
    editLeagueBtn:  { borderWidth: 1, borderColor: c.primary, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 5 },
    editLeagueText: { fontSize: 13, color: c.primary, fontWeight: '600' },
    descText:       { fontSize: 14, color: c.text, lineHeight: 20 },
    descPlaceholder:{ fontSize: 13, color: c.textMuted, fontStyle: 'italic' },
    howItWorksLink: { paddingTop: 6, borderTopWidth: 1, borderTopColor: c.border },
    howItWorksText: { fontSize: 13, color: c.primary, fontWeight: '600' },
    closedBanner:   { backgroundColor: '#fff8e1', borderRadius: 10, padding: 10, borderWidth: 1, borderColor: '#ffe082' },
    closedBannerText: { fontSize: 13, color: '#b8860b', fontWeight: '600' },
    dangerBtn:      { backgroundColor: c.surface, borderRadius: 14, padding: 16, borderWidth: 1.5, borderColor: c.danger + '88', marginTop: 8 },
    dangerBtnText:  { fontSize: 15, fontWeight: '800', color: c.danger },
    dangerBtnSub:   { fontSize: 12, color: c.textMuted, marginTop: 4 },

    roleBanner:     { borderRadius: 10, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 8 },
    roleText:       { fontSize: 13, fontWeight: '700' },

    // Season cards
    seasonCard:         { backgroundColor: c.surface, borderRadius: 14, padding: 16, borderWidth: 1.5, borderColor: c.primary + '44', elevation: 2, shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
    seasonCardTop:      { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 4 },
    seasonCardLabel:    { fontSize: 10, color: c.primary, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8 },
    seasonCardName:     { fontSize: 18, fontWeight: '800', color: c.text, marginTop: 1 },
    seasonStatusBadge:  { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10 },
    seasonBadgeActive:  { backgroundColor: c.primaryLight },
    seasonBadgeUpcoming:{ backgroundColor: '#fff8e1' },
    seasonStatusText:   { fontSize: 12, fontWeight: '700' },
    seasonBadgeActiveText:  { color: c.primary },
    seasonBadgeUpcomingText: { color: '#b8860b' },
    seasonCardMeta:     { fontSize: 12, color: c.textMuted, marginBottom: 2 },
    seasonCardDates:    { fontSize: 13, color: c.textSub, fontWeight: '600', marginBottom: 12 },
    seasonViewBtn:      { backgroundColor: c.primary, borderRadius: 10, paddingVertical: 11, paddingHorizontal: 16, alignItems: 'center' },
    seasonViewBtnText:  { color: '#fff', fontWeight: '700', fontSize: 14 },

    noSeasonCard:       { backgroundColor: c.surfaceAlt, borderRadius: 14, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1.5, borderColor: c.border, borderStyle: 'dashed' },
    noSeasonIcon:       { fontSize: 28 },
    noSeasonText:       { flex: 1 },
    noSeasonTitle:      { fontSize: 15, fontWeight: '700', color: c.text, marginBottom: 2 },
    noSeasonSub:        { fontSize: 12, color: c.textMuted, lineHeight: 16 },
    noSeasonCta:        { fontSize: 15, color: c.primary, fontWeight: '700' },

    championCard:       { backgroundColor: '#fff8e1', borderRadius: 14, padding: 16, marginTop: 12, borderWidth: 1.5, borderColor: '#e6c875', elevation: 2, shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
    championLabel:      { fontSize: 12, fontWeight: '800', color: '#8a6d00', textTransform: 'uppercase', letterSpacing: 0.7, marginBottom: 6 },
    championLead:       { fontSize: 15, color: c.text, lineHeight: 21, marginBottom: 4 },
    championTeam:       { fontWeight: '900', color: '#a7740a' },
    championRecord:     { fontSize: 13, fontWeight: '700', color: c.textSub, marginBottom: 4 },
    championRoster:     { fontSize: 13, color: c.textSub, lineHeight: 19 },
    championLink:       { fontSize: 13, fontWeight: '700', color: c.primary, marginTop: 8 },

    comingUpCard:       { backgroundColor: c.surface, borderRadius: 14, padding: 14, marginTop: 12, elevation: 2, shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
    comingUpHeader:     { fontSize: 12, fontWeight: '800', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.7, marginBottom: 6 },
    comingUpRow:        { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderTopWidth: 1, borderTopColor: c.bg, gap: 12 },
    comingUpIcon:       { fontSize: 22 },
    comingUpTitle:      { fontSize: 15, fontWeight: '700', color: c.text },
    comingUpWhen:       { fontSize: 12, color: c.textMuted, marginTop: 2 },
    comingUpChevron:    { fontSize: 22, color: c.textMuted, fontWeight: '600' },
    comingUpEmpty:      { fontSize: 13, color: c.textMuted, fontStyle: 'italic', paddingVertical: 8 },
    comingUpBadge:      { backgroundColor: '#fff3cd', borderColor: '#d4a72c', borderWidth: 1, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3, marginRight: 6 },
    comingUpBadgeText:  { fontSize: 10, fontWeight: '800', color: '#8a6d00', textTransform: 'uppercase', letterSpacing: 0.4 },

    pastSeasonsCard:    { backgroundColor: c.surface, borderRadius: 14, padding: 14, marginTop: 12, elevation: 2, shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
    pastSeasonsHeader:  { fontSize: 12, fontWeight: '700', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 },
    pastSeasonRow:      { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderTopWidth: 1, borderTopColor: c.bg, gap: 12 },
    pastSeasonTrophy:   { fontSize: 22 },
    pastSeasonName:     { fontSize: 15, fontWeight: '700', color: c.text },
    pastSeasonMeta:     { fontSize: 12, color: c.textMuted, marginTop: 2 },
    pastSeasonChevron:  { fontSize: 22, color: c.textMuted, fontWeight: '600' },

    card:           { backgroundColor: c.surface, borderRadius: 14, padding: 16, elevation: 2, shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, flexDirection: 'row', alignItems: 'center' },
    cardIcon:       { fontSize: 26, marginRight: 14 },
    cardText:       { flex: 1 },
    label:          { fontSize: 16, fontWeight: '700', color: c.text },
    sub:            { fontSize: 13, color: c.textSub, marginTop: 2 },
    adminTag:       { backgroundColor: '#fff8e1', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, borderWidth: 1, borderColor: '#ffe082' },
    adminTagText:   { fontSize: 11, fontWeight: '700', color: '#b8860b' },

    // Modals (shared)
    modal:          { padding: 24, paddingTop: 48, flexGrow: 1, backgroundColor: c.surface },
    modalTitle:     { fontSize: 22, fontWeight: '800', color: c.text, marginBottom: 6 },
    modalHint:      { fontSize: 14, color: c.textSub, lineHeight: 20, marginBottom: 20 },
    fieldLabel:     { fontSize: 13, fontWeight: '700', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.8, marginTop: 18, marginBottom: 6 },
    fieldHint:      { fontSize: 12, color: c.textMuted, marginTop: -4, marginBottom: 8 },
    input:          { borderWidth: 1, borderColor: c.border, borderRadius: 12, padding: 14, fontSize: 16, marginBottom: 4, backgroundColor: c.surface, color: c.text },
    inputMultiline: { minHeight: 96, textAlignVertical: 'top' },
    privacyRow:     { flexDirection: 'row', gap: 10 },
    privacyOption:  { flex: 1, borderWidth: 1.5, borderColor: c.border, borderRadius: 12, padding: 12, backgroundColor: c.bg },
    privacyOptionActive:      { borderColor: c.primary, backgroundColor: c.primaryLight },
    privacyOptionTitle:       { fontSize: 14, fontWeight: '700', color: c.textSub, marginBottom: 4 },
    privacyOptionTitleActive: { color: c.primary },
    privacyOptionSub:         { fontSize: 12, color: c.textMuted, lineHeight: 16 },
    dateBtn:        { borderWidth: 1, borderColor: c.border, borderRadius: 12, padding: 14 },
    dateBtnText:    { fontSize: 15, color: c.text },
    presetRow:      { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
    presetBtn:      { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, borderWidth: 1.5, borderColor: c.border, backgroundColor: c.bg },
    presetBtnActive:{ borderColor: c.primary, backgroundColor: c.primaryLight },
    presetBtnText:  { fontSize: 13, fontWeight: '600', color: c.textSub },
    presetBtnTextActive: { color: c.primary },
    previewBox:     { backgroundColor: c.primaryLight, borderRadius: 12, padding: 14, marginTop: 16, borderWidth: 1, borderColor: c.primary + '44' },
    previewTitle:   { fontSize: 13, fontWeight: '700', color: c.primary, marginBottom: 8 },
    previewLine:    { fontSize: 13, color: c.text, marginBottom: 3 },
    previewReset:   { fontSize: 12, color: c.textSub, marginTop: 8, lineHeight: 17 },
    warning:        { backgroundColor: '#fff8e1', borderRadius: 8, padding: 10, marginTop: 10, borderWidth: 1, borderColor: '#ffe082' },
    warningText:    { fontSize: 13, color: '#b8860b' },
    saveBtn:        { backgroundColor: c.primary, padding: 16, borderRadius: 10, alignItems: 'center', marginTop: 24 },
    saveBtnDisabled:{ backgroundColor: c.primary + '80' },
    saveBtnText:    { color: '#fff', fontSize: 16, fontWeight: '700' },
    cancelBtn:      { padding: 14, alignItems: 'center' },
    cancelBtnText:  { color: c.textMuted, fontSize: 15 },
  });
}
