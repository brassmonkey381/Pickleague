import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Platform, Modal, Pressable, useWindowDimensions } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { sbCall, currentUserId, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { useCachedQuery, setQueryData } from '@just-messin-around/expo-foundation/cache';
import { useTheme } from '../lib/ThemeContext';
import { DrillSession, Profile, RootStackParamList } from '../types';
import { isoDate, slotRangeLabel } from '../lib/drillTime';
import { formatPlupr } from '../lib/plupr';
import FlairName from '../components/FlairName';
import StreakModal from '../components/StreakModal';
import FtueChecklistCard from '../components/FtueChecklistCard';
import GuestUpgradeBanner from '../components/GuestUpgradeBanner';
import DuprImportBanner from '../components/DuprImportBanner';
import ClosestUnlocksCard from '../components/ClosestUnlocksCard';
import { DumbbellIcon, BallIcon } from '../components/PickleIcons';
import BookmarkButton from '../components/BookmarkButton';
import { useRefresh } from '../lib/useRefresh';
import AppRefreshControl from '../components/AppRefreshControl';
import EmptyState from '../components/EmptyState';
import { SkeletonList } from '../components/Skeleton';
import {
  claimDailyLoginStreak,
  hasStreakBeenShown,
  markStreakShown,
  StreakResult,
} from '../lib/loginStreak';
import { WAGERS_ENABLED } from '../lib/features';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Home'> };

type NavItem = { icon: React.ReactNode; label: string; screen: any; params: any };
const NAV_ITEMS: NavItem[] = [
  { icon: <BallIcon size={32} />,  label: 'Play',        screen: 'Play',        params: undefined },
  { icon: <DumbbellIcon size={32} />, label: 'Drill',    screen: 'Drill',       params: undefined },
  { icon: '🛒',                    label: 'Pickle Shop', screen: 'Shop',        params: undefined },
  { icon: '😎',                    label: 'Profile',     screen: 'Profile',     params: {} },
  // The Wagers tile is gated (see lib/features.ts) - the MyWagers screen is
  // not registered while WAGERS_ENABLED is false, so leaving the tile in
  // would navigate nowhere.
  ...(WAGERS_ENABLED
    ? [{ icon: '🎲', label: 'Wagers', screen: 'MyWagers', params: undefined } as NavItem]
    : []),
  // Defaults to this user's own matches, matching where a tapped match push
  // lands (resolvePushTarget in lib/push) — the tile and the notification
  // should not disagree about what "match history" means.
  { icon: '📋', label: 'Match History', screen: 'MatchHistory',
    params: { title: 'Match History', initialMyMatchesOnly: true } },
  // About stays last: it is the reference tile, not somewhere you go to act.
  { icon: '🥒',                    label: 'About',       screen: 'About',       params: undefined },
];

// Tournaments — registered (active) + open-registration the user could join.
type TournamentRow = {
  id: string; name: string;
  start_time: string | null;
  status: 'registration' | 'active' | 'completed' | 'cancelled' | string;
  league_id: string | null;
  my_status?: 'approved' | 'pending' | null;
};

// Upcoming league events (voting open, or scheduled and not yet started)
// from leagues the user is a member of.
type UpcomingEventRow = {
  id: string;
  title: string;
  league_id: string;
  status: 'voting' | 'scheduled';
  vote_ends_at: string | null;
  starts_at: string | null;
};

// Everything the home screen paints, fetched as one unit. Bundling it is what
// lets the screen tell "still loading / couldn't reach the server" apart from
// "you really have nothing going on" — and what stops a failed pull-to-refresh
// from reporting a balance of 0 pickles as fact.
type HomeData = {
  profile: Profile | null;
  unreadCount: number;
  inLeague: boolean;
  drillsToday: (DrillSession & { partner_name: string })[];
  myTournaments: TournamentRow[];
  openTournaments: TournamentRow[];
  upcomingEvents: UpcomingEventRow[];
};

const EMPTY_HOME: HomeData = {
  profile: null, unreadCount: 0, inLeague: false, drillsToday: [],
  myTournaments: [], openTournaments: [], upcomingEvents: [],
};

const HOME_KEY = 'home:overview';

// One pass over everything the home screen shows. The old version fired
// supabase.auth.getUser() five times per focus (a network round trip each) and
// ran the events lookup as four strictly serial requests; on a weak connection
// that was enough for the whole screen to fall back to a signed-out-looking
// blank. Identity is now a local session read, and only the genuinely dependent
// steps (events need my league ids, slots need the event rows) stay sequential.
async function loadHome(): Promise<HomeData> {
  const uid = await currentUserId(supabase);
  if (!uid) return EMPTY_HOME;

  const today = isoDate(new Date());
  const [profile, unreadRes, memberRows, drillRows, regRows, openRows] = await Promise.all([
    sbCall(() => supabase.from('profiles').select('*').eq('id', uid).single()),
    supabase.from('notifications').select('*', { count: 'exact', head: true }).eq('is_read', false),
    // Mirrors FtueChecklistCard's membership check, and doubles as the league
    // filter for upcoming events (it used to be fetched twice).
    sbCall(() => supabase.from('league_members').select('league_id').eq('user_id', uid)),
    sbCall(() => supabase
      .from('drill_sessions')
      .select(`
        *,
        p1:profiles!drill_sessions_player1_id_fkey(id, full_name),
        p2:profiles!drill_sessions_player2_id_fkey(id, full_name)
      `)
      .eq('session_date', today)
      .or(`player1_id.eq.${uid},player2_id.eq.${uid}`)
      .order('session_slot')),
    // Tournaments I'm registered for (still active or in registration).
    sbCall(() => supabase
      .from('tournament_registrations')
      .select('status, tournament:tournaments(id, name, start_time, status, league_id)')
      .eq('user_id', uid)
      .in('status', ['approved', 'pending'])),
    sbCall(() => supabase
      .from('tournaments')
      .select('id, name, start_time, status, league_id')
      .eq('status', 'registration')
      .order('start_time', { ascending: true, nullsFirst: false })
      .limit(25)),
  ]);

  // Hide drill sessions I've already dismissed today.
  const drillsToday = ((drillRows ?? []) as any[])
    .filter(r => !(r.reminder_dismissed_by ?? []).includes(uid))
    .map(r => ({
      ...r,
      partner_name: r.player1_id === uid ? r.p2?.full_name ?? 'your partner' : r.p1?.full_name ?? 'your partner',
    }));

  const myTournaments: TournamentRow[] = [];
  for (const r of ((regRows ?? []) as any[])) {
    const t = r.tournament as TournamentRow | null;
    if (!t || t.status === 'completed' || t.status === 'cancelled') continue;
    myTournaments.push({ ...t, my_status: r.status });
  }
  myTournaments.sort((a, b) => {
    const ams = a.start_time ? new Date(a.start_time).getTime() : Number.MAX_SAFE_INTEGER;
    const bms = b.start_time ? new Date(b.start_time).getTime() : Number.MAX_SAFE_INTEGER;
    return ams - bms;
  });

  // Open-registration tournaments I haven't joined yet.
  const myIds = new Set(myTournaments.map(t => t.id));
  const openTournaments = ((openRows ?? []) as TournamentRow[]).filter(t => !myIds.has(t.id));

  const leagueIds = ((memberRows ?? []) as { league_id: string }[]).map(r => r.league_id);
  const upcomingEvents = leagueIds.length > 0 ? await loadUpcomingEvents(leagueIds) : [];

  return {
    profile: (profile ?? null) as Profile | null,
    unreadCount: unreadRes.count ?? 0,
    inLeague: leagueIds.length > 0,
    drillsToday,
    myTournaments,
    openTournaments,
    upcomingEvents,
  };
}

async function loadUpcomingEvents(leagueIds: string[]): Promise<UpcomingEventRow[]> {
  const nowIso = new Date().toISOString();
  const rows = ((await sbCall(() => supabase
    .from('league_events')
    .select(`id, title, league_id, status, vote_ends_at, confirmed_slot_id`)
    .in('league_id', leagueIds)
    .in('status', ['voting', 'scheduled'])
    .order('vote_ends_at', { ascending: true }))) ?? []) as any[];

  // For scheduled events, look up the confirmed slot's start time.
  const confirmedSlotIds = rows
    .filter(r => r.status === 'scheduled' && r.confirmed_slot_id)
    .map(r => r.confirmed_slot_id);
  const slotMap = new Map<string, string>();
  if (confirmedSlotIds.length) {
    const slotRows = await sbCall(() => supabase
      .from('event_slots')
      .select('id, starts_at')
      .in('id', confirmedSlotIds));
    for (const s of ((slotRows ?? []) as any[])) slotMap.set(s.id, s.starts_at);
  }

  const upcoming: UpcomingEventRow[] = [];
  for (const r of rows) {
    if (r.status === 'voting') {
      if (!r.vote_ends_at || r.vote_ends_at < nowIso) continue;
      upcoming.push({ id: r.id, title: r.title, league_id: r.league_id, status: 'voting', vote_ends_at: r.vote_ends_at, starts_at: null });
    } else {
      const starts = r.confirmed_slot_id ? slotMap.get(r.confirmed_slot_id) ?? null : null;
      if (!starts || starts < nowIso) continue;
      upcoming.push({ id: r.id, title: r.title, league_id: r.league_id, status: 'scheduled', vote_ends_at: null, starts_at: starts });
    }
  }
  // Sort by the earliest relevant timestamp (vote_ends or starts_at).
  upcoming.sort((a, b) => {
    const at = a.starts_at ?? a.vote_ends_at ?? '';
    const bt = b.starts_at ?? b.vote_ends_at ?? '';
    return at.localeCompare(bt);
  });
  return upcoming;
}

export default function HomeScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const [welcomeBalance, setWelcomeBalance] = useState(0);
  const [streakOpen, setStreakOpen] = useState(false);
  const [streakResult, setStreakResult] = useState<StreakResult | null>(null);

  const query = useCachedQuery<HomeData>(HOME_KEY, loadHome, {
    ttlMs: 30_000,
    persistMs: 24 * 60 * 60 * 1000,
  });
  const {
    profile, unreadCount, inLeague, drillsToday,
    myTournaments, openTournaments, upcomingEvents,
  } = query.data ?? EMPTY_HOME;
  const loadFailed = query.error != null && query.data === undefined;

  const reload = useCallback(() => query.refresh(), [query.refresh]);
  useFocusEffect(useCallback(() => { void reload(); }, [reload]));

  const refresh = useRefresh(reload);

  // Local patches (welcome pickles, FTUE claim, dismissed drill reminder) write
  // through the cache so the next revalidation doesn't clobber them mid-flight.
  function patchHome(fn: (d: HomeData) => HomeData) {
    setQueryData(HOME_KEY, fn(query.data ?? EMPTY_HOME));
  }

  // Claim welcome pickles once per account, on first home visit after signup.
  useEffect(() => { claimWelcomePicklesOnce(); }, []);
  // Daily login streak: pop once per app session per user. Idempotent RPC.
  useEffect(() => { showStreakOncePerSession(); }, []);

  // Web: close info modals on Escape key.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    if (!welcomeOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (welcomeOpen) setWelcomeOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [welcomeOpen]);

  async function dismissDrillReminder(session: DrillSession) {
    const uid = await currentUserId(supabase);
    if (!uid) return;
    const next = Array.from(new Set([...(session.reminder_dismissed_by ?? []), uid]));
    patchHome(d => ({ ...d, drillsToday: d.drillsToday.filter(s => s.id !== session.id) }));
    try {
      await sbCall(() => supabase
        .from('drill_sessions')
        .update({ reminder_dismissed_by: next })
        .eq('id', session.id));
    } catch {
      // Couldn't persist the dismissal — the banner returns on the next load.
    }
  }

  // Both grants below fire on mount, while loadHome's very first request is
  // still in flight — and cachedFetch dedupes a concurrent refresh onto that
  // already-running request instead of starting a new one (queryCache.ts:
  // `const running = inflight.get(key); if (running) return running`). That
  // check sits above the TTL logic, so refresh()'s ttlMs:0 cannot bypass it.
  //
  // A single reload() here therefore resolved with the PRE-grant profile and
  // cached it, which is why a brand-new account showed 🥒 0 in the header until
  // some other screen forced its own fetch. Drain the in-flight request first,
  // then force a genuinely fresh one.
  //
  // Deliberately a refetch rather than patching the balance in from the RPC's
  // return value: the streak RPC reports what it granted, not the new total, so
  // patching means adding to a balance that may already include the grant.
  // Refetching cannot double-count.
  const reloadAfterGrant = useCallback(async () => {
    try { await reload(); } catch { /* joins the in-flight fetch; the retry covers it */ }
    try { await reload(); } catch { /* offline — focus revalidation catches up */ }
  }, [reload]);

  // Revalidate as the pop-ups go away too. The grant's own refetch above should
  // already have landed, but dismissing is the moment the header becomes visible
  // and worth being right — and this is the fallback if that refetch was still
  // in flight or the device was offline when it ran.
  const closeWelcome = useCallback(() => { setWelcomeOpen(false); void reload(); }, [reload]);
  const closeStreak = useCallback(() => { setStreakOpen(false); void reload(); }, [reload]);

  async function claimWelcomePicklesOnce() {
    const { data, error } = await supabase.rpc('claim_welcome_pickles');
    if (error) return;
    const row = Array.isArray(data) ? data[0] : data;
    if (row?.granted) {
      setWelcomeBalance(row.new_balance ?? 1000);
      setWelcomeOpen(true);
      void reloadAfterGrant();
    }
  }

  async function showStreakOncePerSession() {
    const uid = await currentUserId(supabase);
    if (!uid) return;
    if (hasStreakBeenShown(uid)) return;
    markStreakShown(uid);
    const result = await claimDailyLoginStreak();
    if (!result) return;
    setStreakResult(result);
    setStreakOpen(true);
    if (result.claimed_today) void reloadAfterGrant();
  }

  // Wide layouts (web / tablet) lay the 4 PLUPR tiles in a single row; phones
  // get a roomy 2×2. 600px is the breakpoint between the two.
  const { width } = useWindowDimensions();
  const wideStats = width >= 600;
  const s = makeStyles(colors, wideStats);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ paddingBottom: 40 }}
      refreshControl={<AppRefreshControl {...refresh} />}
    >

      {/* ── Hero header ─────────────────────────────── */}
      <View style={s.hero}>
        {/* Decorative balls */}
        <View style={s.decoBallTL}><BallIcon size={80} /></View>
        <View style={s.decoBallBR}><BallIcon size={100} /></View>

        {/* Settings (top-left) */}
        <TouchableOpacity
          style={s.settingsBtn}
          onPress={() => navigation.navigate('Settings')}
          accessibilityRole="button"
          accessibilityLabel="Settings"
        >
          <Text style={s.settingsIcon}>⚙️</Text>
        </TouchableOpacity>

        {/* Bell (top-right) */}
        <TouchableOpacity
          style={s.bellBtn}
          onPress={() => navigation.navigate('Notifications')}
          accessibilityRole="button"
          accessibilityLabel="Notifications"
        >
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

        {/* Greeting (left) + pickle balance (right) */}
        <View style={s.greetingRow}>
          <View style={s.greetingLeft}>
            {/* tap your name to open your profile */}
            <Text style={s.welcomeLabel}>Welcome back,</Text>
            <TouchableOpacity onPress={() => navigation.navigate('Profile', {})} activeOpacity={0.6}>
              {/* TODO: smoke-test in browser — hero name renders with profile_name_style_id */}
              <FlairName
                style={s.heroName}
                nameColor={profile?.name_color}
                styleId={profile?.profile_name_style_id}
                mode="hero"
                name={profile?.full_name?.trim().split(/\s+/)[0] ?? '...'}
              />
            </TouchableOpacity>
          </View>

          {/* Pickle balance — to the right of the greeting; count on top,
              "pickles · tap to shop" beneath it. (PLUPR tiles previously lived
              here; they're intentionally hidden — kept contained within a league.) */}
          <TouchableOpacity style={s.picklePill} onPress={() => navigation.navigate('Shop')} activeOpacity={0.8}>
            <View style={s.pickleTopRow}>
              <Text style={s.pickleEmoji}>🥒</Text>
              {/* Until the profile actually lands, the balance is unknown — "0"
                  would be a claim we can't back up (and one users act on). */}
              <Text style={s.pickleValue}>{profile ? profile.pickles ?? 0 : '—'}</Text>
            </View>
            <Text style={s.pickleLabel}>pickles · tap to shop</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Guest? Nudge to save the account (self-hides for real users). */}
      <GuestUpgradeBanner />

      {/* Confirmed email on an imported DUPR roster? Offer to carry the rating
          over (self-hides when there's no match or it's already imported). */}
      <DuprImportBanner />

      {/* ── First-time-user checklist (hides once all steps claimed) ── */}
      {/* TODO: smoke-test in browser */}
      <FtueChecklistCard
        profile={profile}
        navigation={navigation}
        onClaimed={(newBalance) => patchHome(d => ({
          ...d,
          profile: d.profile ? { ...d.profile, pickles: newBalance } : d.profile,
        }))}
      />

      {/* ── Upcoming (tournaments + events + drill sessions) ── */}
      <View style={s.tournamentSection}>
        <View style={s.tournamentSectionHeader}>
          <Text style={s.tournamentSectionTitle}>📅 Upcoming events</Text>
          <TouchableOpacity
            onPress={() => navigation.navigate('Bookmarks')}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel="Bookmarks"
          >
            <Text style={s.bookmarkIcon}>🔖</Text>
          </TouchableOpacity>
        </View>

        {/* "No upcoming events" is only true once a fetch has succeeded —
            otherwise the section says so plainly and offers a retry. */}
        {loadFailed ? (
          <EmptyState
            icon="📡"
            title="Couldn't load your schedule"
            subtitle={friendlySbMessage(query.error)}
            actionLabel="Retry"
            onAction={() => { void reload(); }}
          />
        ) : query.loading ? (
          <SkeletonList rows={3} />
        ) : myTournaments.length === 0 && openTournaments.length === 0 && upcomingEvents.length === 0 && drillsToday.length === 0 ? (
          <EmptyState icon="📅" title="No upcoming events" subtitle="Tournaments, league events, and drill sessions you join will show up here." />
        ) : (
          <>
            {myTournaments.slice(0, 3).map(t => (
              <TouchableOpacity
                key={`mine-${t.id}`}
                style={s.tournamentRow}
                activeOpacity={0.7}
                onPress={() => navigation.navigate('TournamentDetail', { tournamentId: t.id, tournamentName: t.name })}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.tournamentRowName} numberOfLines={1}>🏆 {t.name}</Text>
                  <Text style={s.tournamentRowMeta}>
                    {t.start_time
                      ? new Date(t.start_time).toLocaleString(undefined, { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })
                      : 'Date TBD'}
                    {' · '}
                    {t.my_status === 'pending' ? '📨 Invited' : t.status === 'registration' ? '✓ Registered' : '✓ Active'}
                  </Text>
                </View>
              </TouchableOpacity>
            ))}

            {upcomingEvents.slice(0, 4).map(e => (
              <TouchableOpacity
                key={`event-${e.id}`}
                style={s.tournamentRow}
                activeOpacity={0.7}
                onPress={() => navigation.navigate('EventDetail', { eventId: e.id, title: e.title })}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.tournamentRowName} numberOfLines={1}>📅 {e.title}</Text>
                  <Text style={s.tournamentRowMeta}>
                    {e.status === 'voting'
                      ? `🗳️ Voting · ends ${new Date(e.vote_ends_at!).toLocaleDateString()}`
                      : e.starts_at
                        ? `✓ Scheduled · ${new Date(e.starts_at).toLocaleString(undefined, { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })}`
                        : '✓ Scheduled'}
                  </Text>
                </View>
              </TouchableOpacity>
            ))}

            {drillsToday.slice(0, 3).map(d => (
              <TouchableOpacity
                key={`drill-${d.id}`}
                style={[s.tournamentRow, { flexDirection: 'row', alignItems: 'center' }]}
                activeOpacity={0.7}
                onPress={() => navigation.navigate('DrillRequests')}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.tournamentRowName} numberOfLines={1}>🏓 Drill with {d.partner_name}</Text>
                  <Text style={s.tournamentRowMeta}>
                    Today · {slotRangeLabel(d.session_slot, d.length_minutes ?? 60)}
                  </Text>
                </View>
                <BookmarkButton targetType="drill_session" targetId={d.id} size={18} />
              </TouchableOpacity>
            ))}

            {openTournaments.length > 0 && (
              <>
                <Text style={s.tournamentSubheading}>Open registration</Text>
                {openTournaments.slice(0, 4).map(t => (
                  <TouchableOpacity
                    key={`open-${t.id}`}
                    style={s.tournamentRow}
                    activeOpacity={0.7}
                    onPress={() => navigation.navigate('TournamentDetail', { tournamentId: t.id, tournamentName: t.name })}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={s.tournamentRowName} numberOfLines={1}>🏆 {t.name}</Text>
                      <Text style={s.tournamentRowMeta}>
                        {t.start_time
                          ? new Date(t.start_time).toLocaleString(undefined, { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })
                          : 'Date TBD'}
                        {' · '}Tap to register
                      </Text>
                    </View>
                  </TouchableOpacity>
                ))}
              </>
            )}
          </>
        )}
      </View>

      {/* ── Today's drill session reminders ───────────────── */}
      {drillsToday.map(s2 => (
        <TouchableOpacity
          key={s2.id}
          style={s.drillBanner}
          onPress={() => navigation.navigate('DrillRequests')}
          activeOpacity={0.85}
        >
          <View style={s.drillBannerEmoji}><DumbbellIcon size={28} color="#ffffff" /></View>
          <View style={{ flex: 1 }}>
            <Text style={s.drillBannerTitle}>Drill with {s2.partner_name} today!</Text>
            <Text style={s.drillBannerSub}>{slotRangeLabel(s2.session_slot, s2.length_minutes ?? 60)} · tap for details</Text>
          </View>
          <TouchableOpacity
            onPress={(e) => { e.stopPropagation(); dismissDrillReminder(s2); }}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            accessibilityRole="button"
            accessibilityLabel="Dismiss drill reminder"
          >
            <Text style={s.drillBannerClose}>✕</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      ))}

      {/* ── Record a Match (only when the user is in a league) ── */}
      {/* TODO: smoke-test in browser */}
      {inLeague && (
        <TouchableOpacity
          style={s.recordCard}
          activeOpacity={0.85}
          onPress={() => navigation.navigate('MatchEntry', { fromHome: true })}
        >
          <Text style={s.recordIcon}>📝</Text>
          <View style={{ flex: 1 }}>
            <Text style={s.recordTitle}>Record a Match</Text>
            <Text style={s.recordSub}>Log your latest result</Text>
          </View>
          <Text style={s.recordChevron}>›</Text>
        </TouchableOpacity>
      )}

      {/* ── Nav grid ────────────────────────────────── */}
      <View style={s.grid}>
        {NAV_ITEMS.map(({ icon, label, screen, params }) => (
          <TouchableOpacity
            key={label}
            style={s.card}
            activeOpacity={0.75}
            onPress={() => (navigation.navigate as any)(screen, params)}
          >
            {typeof icon === 'string'
              ? <Text style={s.cardIcon}>{icon}</Text>
              : <View style={{ marginBottom: 4, alignItems: 'center', justifyContent: 'center' }}>{icon}</View>}
            <Text style={s.cardLabel}>{label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* ── Closest unlocks (hides when nothing global remains) ── */}
      {/* TODO: smoke-test in browser */}
      <ClosestUnlocksCard userId={profile?.id ?? null} navigation={navigation} />

      {/* ── Welcome pickles modal ────────────────────────── */}
      <Modal visible={welcomeOpen} transparent animationType="fade" onRequestClose={closeWelcome}>
        <Pressable
          style={s.welcomeBackdrop}
          onPress={(e) => { if (e.target === e.currentTarget) closeWelcome(); }}
        >
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
                onPress={closeWelcome}
              >
                <Text style={s.welcomeBtnSecondaryText}>Later</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={s.welcomeBtn}
                onPress={() => { closeWelcome(); navigation.navigate('Shop'); }}
              >
                <Text style={s.welcomeBtnText}>Visit Shop</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Pressable>
      </Modal>

      {/* ── Daily login streak ─────────────────────────── */}
      <StreakModal
        visible={streakOpen}
        result={streakResult}
        onClose={closeStreak}
      />
    </ScrollView>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors'], wideStats: boolean) {
  return StyleSheet.create({
    hero: {
      backgroundColor: c.headerBg,
      paddingTop: Platform.OS === 'ios' ? 60 : 48,
      paddingBottom: 28,
      paddingHorizontal: 24,
      overflow: 'hidden',
    },
    decoBallTL: { position: 'absolute', top: -10, left: -8, opacity: 0.12 },
    decoBallBR: { position: 'absolute', bottom: -16, right: -8, opacity: 0.12 },
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

    // Hero greeting laid out beside the PLUPR quick-stats grid (name + pickles
    // on the left, a 2×2 grid of rating tiles pinned to the right). The grid
    // keeps its size (flexShrink 0) while the greeting flexes to fill the rest —
    // tiles are a touch larger on wide/web layouts and compact on phones so the
    // name always has room.
    greetingRow:  { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
    greetingLeft: { flex: 1, minWidth: 0 },
    pluprGrid:    {
      flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end',
      flexShrink: 0, width: wideStats ? 2 * 96 + 8 : 2 * 78 + 8,
    },
    pluprTile:    {
      width: wideStats ? 96 : 78, alignItems: 'center', paddingVertical: 8, paddingHorizontal: 6,
      borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.12)',
      borderWidth: 1, borderColor: 'rgba(255,255,255,0.20)',
    },
    pluprValue:   { fontSize: wideStats ? 18 : 17, fontWeight: '800', color: c.headerText },
    pluprLabel:   { fontSize: wideStats ? 11 : 10, color: c.headerSub, fontWeight: '600', marginTop: 2, textAlign: 'center' },

    picklePill: {
      alignItems: 'center',
      alignSelf: 'flex-start',
      backgroundColor: 'rgba(255,255,255,0.18)',
      paddingHorizontal: 16, paddingVertical: 8,
      borderRadius: 16,
      borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)',
    },
    pickleTopRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    pickleEmoji: { fontSize: 16 },
    pickleValue: { fontSize: 16, fontWeight: '800', color: c.headerText },
    pickleLabel: { fontSize: 12, color: c.headerSub, marginTop: 2 },

    drillBanner: {
      flexDirection: 'row', alignItems: 'center', gap: 12,
      backgroundColor: c.primaryLight,
      borderLeftWidth: 4, borderLeftColor: c.primary,
      paddingHorizontal: 14, paddingVertical: 12,
      marginHorizontal: 14, marginTop: 12, borderRadius: 10,
    },
    drillBannerEmoji: { width: 34, height: 34, justifyContent: 'center', alignItems: 'center' },
    drillBannerTitle: { fontSize: 14, fontWeight: '800', color: c.text },
    drillBannerSub:   { fontSize: 12, color: c.textSub, marginTop: 1 },
    drillBannerClose: { fontSize: 18, fontWeight: '700', color: c.textMuted, paddingHorizontal: 6 },

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

    recordCard: {
      flexDirection: 'row', alignItems: 'center', gap: 12,
      marginHorizontal: 16, marginTop: 16,
      paddingHorizontal: 16, paddingVertical: 16,
      borderRadius: 14,
      backgroundColor: '#fff8e1', borderWidth: 1.5, borderColor: '#ffe082',
      elevation: 2, shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
    },
    recordIcon:    { fontSize: 30 },
    recordTitle:   { fontSize: 17, fontWeight: '800', color: '#b8860b' },
    recordSub:     { fontSize: 13, color: '#b8860b', marginTop: 2, opacity: 0.85 },
    recordChevron: { fontSize: 26, color: '#b8860b', fontWeight: '700' },

    grid:     { flexDirection: 'row', flexWrap: 'wrap', gap: 12, padding: 16, marginTop: 8 },

    tournamentSection:       { marginHorizontal: 16, marginTop: 12, padding: 14, borderRadius: 14, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
    tournamentSectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
    tournamentSectionTitle:  { fontSize: 15, fontWeight: '800', color: c.text },
    tournamentViewAll:       { fontSize: 13, fontWeight: '700', color: c.primary },
    bookmarkIcon:            { fontSize: 22 },
    upcomingEmpty:           { fontSize: 13, color: c.textMuted, fontStyle: 'italic', paddingVertical: 6 },
    tournamentSubheading:    { fontSize: 11, fontWeight: '800', color: c.textSub, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 10, marginBottom: 4 },
    tournamentRow:           { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.border },
    tournamentRowName:       { fontSize: 14, fontWeight: '700', color: c.text },
    tournamentRowMeta:       { fontSize: 12, color: c.textSub, marginTop: 2 },
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
