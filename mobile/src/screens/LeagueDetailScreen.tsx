// A league's home screen, laid out in the one section order every detail
// screen uses (plan section 5):
//
//   0 header ...... league name as the native title; [Share] [Bookmark] on the right
//   1 identity .... (Public) (📍 court · N here ›) (N members) (You: Admin) (ⓘ How it works)
//                   + the description, clamped to 2 lines with "more"
//   2 you ......... quick row [+Record] [Standings] [Events] [Members]
//                   (non-members: the shared LeagueJoinCard + [Standings] [Events] [Members])
//   3 status ...... SeasonStrip: "Fall · Wk 7 of 12 · You #2 · locks Oct 20 ›" + top 3 + your row
//   4 coming up ... votes (needs-you) first, then events and tournaments by date,
//                   max 3, then "Show N more"
//   5 more ........ History · Calendar · Tournaments · Past (n)
//   6 manage ...... every admin action, in one collapsed section
//
// This replaced a stack of tall cards (court banner, info card, role banner,
// season card, champion card, two "upcoming" cards, past seasons, seven option
// cards) that put Record Match at y≈700; the quick row puts it at y≈100-160.
// Once the quick row scrolls away, a StickyActionBar repeats the primary
// action (Record for members, Join/Request for everyone else); PlayIsland
// floats above that bar through the foundation's bottom chrome slot.
//
// Every action that existed before is still here: Record, Members, Events,
// Match history, Calendar, Tournaments, past seasons, How it works, share and
// bookmark (header), join/request (LeagueJoinCard), and in Manage: edit league,
// invite players, start a season, edit the baseline, lock periods / complete
// season (SeasonStandings), join requests (LeagueMembers) and godmode delete.
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ScrollView, View, StyleSheet, Text,
  type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useFocusEffect, useIsFocused } from '@react-navigation/native';
import {
  sbCall, currentUserId, classifySbError, friendlySbMessage,
} from '@just-messin-around/expo-foundation/supabase';
import { StickyActionBar, useBottomChromeInset } from '@just-messin-around/expo-foundation/ui';
import { TextField } from '@just-messin-around/expo-foundation/forms';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { supabase } from '../lib/supabase';
import { getLeagueRole, isPrivileged, LeagueRole } from '../lib/leagueRole';
import { isGodmodeUserId } from '../lib/godmode';
import ConfirmModal from '../components/ConfirmModal';
import ActionSheetModal from '../components/ActionSheetModal';
import { useRefresh } from '../lib/useRefresh';
import AppRefreshControl from '../components/AppRefreshControl';
import { SkeletonList } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';
import { useToast } from '../lib/useToast';
import { League, LeagueSeason, RootStackParamList } from '../types';
import { useTheme } from '../lib/ThemeContext';
import { useTour } from '../lib/TourContext';
import { trackSectionToggle } from '../lib/analytics';
import { useLeagueJoin } from '../lib/useLeagueJoin';
import { tournamentStatusChip } from '../lib/entityGlyph';
import {
  STANDINGS_MATCH_COLUMNS, addDaysIso, livePeriodNumber, localIsoDate, periodWindow, standingsTargetSeasonId,
  summarizeSeason, type SeasonSummary, type StandingsMatch, type StandingsMember,
} from '../lib/seasonSummary';
import LeagueJoinCard from '../components/LeagueJoinCard';
import SeasonStrip from '../components/SeasonStrip';
import LeagueIdentity from '../components/league/LeagueIdentity';
import LeagueQuickRow from '../components/league/LeagueQuickRow';
import LeagueComingUp, { type LeagueChampion, type LeagueComingUpItem } from '../components/league/LeagueComingUp';
import LeagueMoreLinks, { type LeagueMoreLink } from '../components/league/LeagueMoreLinks';
import LeagueManageSection, { type LeagueManageRow } from '../components/league/LeagueManageSection';
import LeagueEditSheet from '../components/league/LeagueEditSheet';
import SeasonSetupSheet from '../components/league/SeasonSetupSheet';
import LeagueHeaderActions from '../components/league/LeagueHeaderActions';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'LeagueDetail'>;
  route: RouteProp<RootStackParamList, 'LeagueDetail'>;
};

type MemberRow = StandingsMember & { role?: string | null };

/** "Jan 5, 2026 → Mar 30, 2026" for a past-season row. */
function seasonRange(s: LeagueSeason): string {
  const f = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  return `${f(s.start_date)} → ${f(s.end_date)}`;
}

export default function LeagueDetailScreen({ navigation, route }: Props) {
  const { leagueId, leagueName: paramName } = route.params;
  const { colors } = useTheme();
  const t = textStyles(colors);
  const toast = useToast();
  const isFocused = useIsFocused();
  const { registerAnchor, unregisterAnchor } = useTour();

  // Spotlight-tour anchor: the quick row's Record tile is the final step of
  // the 'leagues' tour. Registered on layout (the row only renders once the
  // screen has loaded). Harmless if the tour never reaches this step.
  // Held only while this screen is focused: a LeagueDetail left mounted under
  // the stack still measures on native, so blurring (or unmounting) drops the
  // anchor (identity-guarded: never another LeagueDetail's), same as
  // usePlayTour.
  const recordAnchor = useRef<any>(null);
  const focusedRef = useRef(isFocused);
  focusedRef.current = isFocused;
  // Coming back on top (e.g. after another LeagueDetail was pushed and
  // popped) re-claims the step; onLayout does not fire again.
  useEffect(() => {
    if (!isFocused) return;
    if (recordAnchor.current) registerAnchor('leagues', 'record', recordAnchor);
    return () => unregisterAnchor('leagues', 'record', recordAnchor);
  }, [isFocused, registerAnchor, unregisterAnchor]);

  const [myRole, setMyRole]   = useState<LeagueRole>(null);
  // False until a role read actually succeeded. A failed read must not be
  // mistaken for "not a member": that showed existing members a "Join this
  // league" card and quietly dropped every admin control.
  const [roleKnown, setRoleKnown] = useState(false);
  const [league, setLeague]   = useState<League | null>(null);
  // The loaded name wins over the param: a push used to pass its own title
  // ("🎟️ Invite: ...") as the league name, header included. A clean web URL
  // (/leagues/:id) has no param at all, so the header says "League" until the
  // row lands instead of the route name "LeagueDetail".
  const leagueName = league?.name || paramName || '';
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [activeSeason, setActiveSeason] = useState<LeagueSeason | null>(null);
  const [pastSeasons, setPastSeasons]   = useState<LeagueSeason[]>([]);
  const [members, setMembers]           = useState<MemberRow[] | null>(null);
  const [seasonSummary, setSeasonSummary] = useState<SeasonSummary | null>(null);
  // Which season `seasonSummary` describes (SeasonSummary carries no id). A
  // failed strip load may keep the previous summary only for the SAME season,
  // never show season A's ranks and lock date under season B.
  const summarySeasonId = useRef<string | null>(null);
  // Latest strip load: an older, slower load must not overwrite a newer one.
  const stripSeq = useRef(0);
  const [godmode, setGodmode]           = useState(false);
  const [champion, setChampion]         = useState<LeagueChampion | null>(null);
  const [comingUp, setComingUp]         = useState<LeagueComingUpItem[]>([]);
  const [pendingRequests, setPendingRequests] = useState(0);
  const [myRequestPending, setMyRequestPending] = useState(false);

  // Manage: controlled so it can open itself when a step is pending (join
  // requests waiting, a period lock due), until the user toggles it.
  const [manageOpen, setManageOpen] = useState(false);
  const manageTouched = useRef(false);

  const [pastSheetOpen, setPastSheetOpen] = useState(false);
  const [editVisible, setEditVisible]     = useState(false);
  const [seasonModal, setSeasonModal]     = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting]         = useState(false);
  const [deleteError, setDeleteError]   = useState<string | null>(null);

  // Edit-baseline modal for the active season
  const [showBaselineEdit, setShowBaselineEdit] = useState(false);
  const [editBaselineInput, setEditBaselineInput] = useState('');
  const [savingBaseline, setSavingBaseline]     = useState(false);
  const [baselineError, setBaselineError]       = useState<string | null>(null);

  // Sticky bar: shown once the "you" slot (quick row / join card) has scrolled
  // off the top. Kept in a ref too so onScroll only sets state on a change.
  const youBottom = useRef<number | null>(null);
  // The threshold is built from SIZES only (identity height + "you" height):
  // react-native-web's onLayout comes from a ResizeObserver and does not fire
  // when a View only MOVES, so the "you" slot's y goes stale on web when the
  // identity block above grows (roster opened, "more", the presence chip wrap).
  const identityH = useRef<number | null>(null);
  const youH = useRef<number | null>(null);
  const pastYou = useRef(false);
  const [stickyVisible, setStickyVisible] = useState(false);
  const bottomInset = useBottomChromeInset(SPACE.lg);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: leagueName || 'League',
      headerRight: () => (
        <LeagueHeaderActions
          leagueId={leagueId}
          leagueName={leagueName || 'this league'}
          onCopied={() => toast.success('League link copied.')}
        />
      ),
    });
    // toast is stable for the provider's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigation, leagueId, leagueName]);

  useFocusEffect(
    useCallback(() => {
      load();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [leagueId])
  );

  const refresh = useRefresh(load);

  async function load() {
    try {
      const [role, uid, leagueRow, seasonRow, completedRows, memberRows] = await Promise.all([
        // A failed role read reports "unknown", never "not a member".
        getLeagueRole(leagueId).catch(() => 'unknown' as const),
        // Local session read instead of checkGodmode()'s getUser() round trip.
        currentUserId(supabase),
        sbCall(() => supabase.from('leagues').select('*').eq('id', leagueId).single()),
        sbCall(() => supabase.from('league_seasons')
          .select('*')
          .eq('league_id', leagueId)
          .in('status', ['upcoming', 'active'])
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()),
        sbCall(() => supabase.from('league_seasons')
          .select('*')
          .eq('league_id', leagueId)
          .eq('status', 'completed')
          .order('end_date', { ascending: false })),
        // Members (readable by everyone): the "N members" chip and the season
        // strip's names. Decorative, so a failure leaves them out instead of
        // failing the screen.
        sbCall(() => supabase.from('league_members')
          .select('user_id, role, profile:profiles(full_name)')
          .eq('league_id', leagueId))
          .catch(() => null),
      ]);
      if (role !== 'unknown') { setMyRole(role); setRoleKnown(true); }
      const season = (seasonRow as LeagueSeason) ?? null;
      const memberList = memberRows ? (memberRows as unknown as MemberRow[]) : null;
      setLeague(leagueRow as League);
      setActiveSeason(season);
      setPastSeasons((completedRows ?? []) as LeagueSeason[]);
      if (memberList) setMembers(memberList);
      setMyUserId(uid);
      setGodmode(isGodmodeUserId(uid));
      setLoadError(null);

      // Secondary loaders run after the main render. Errors in them are
      // non-fatal: their sections just don't render (or keep what they had).
      const effectiveRole = role === 'unknown' ? myRole : role;
      void loadSeasonStrip(season, uid, memberList);
      void loadLatestChampion();
      void loadComingUp(isPrivileged(effectiveRole));
      void loadRequests(role, uid, memberList);
    } catch (e) {
      // Keep whatever's already rendered; the error only decides what the
      // "no league loaded" branch shows.
      setLoadError(e);
    } finally {
      setLoading(false);
    }
  }

  // ── Season strip ──────────────────────────────────────────────
  async function loadSeasonStrip(season: LeagueSeason | null, uid: string | null, memberList: MemberRow[] | null) {
    const seq = ++stripSeq.current;
    if (!season) { summarySeasonId.current = null; setSeasonSummary(null); return; }
    // The same UTC "today" SeasonStandings uses, so the strip and the screen
    // it opens agree on the live period (see lib/seasonSummary.ts). The lock
    // flag uses the LOCAL date, as SeasonStandings' Lock button does.
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const lockToday = localIsoDate(now);
    const s = season as LeagueSeason & { baseline_plupr?: number | null };
    try {
      const snaps = await sbCall(() => supabase.from('season_snapshots')
        .select('period_number')
        .eq('season_id', season.id));
      const locked = new Set(((snaps ?? []) as { period_number: number }[]).map((r) => r.period_number));
      let matches: StandingsMatch[] = [];
      const period = today >= season.start_date ? livePeriodNumber(season, locked, today) : null;
      if (period != null) {
        const w = periodWindow(season, period, today);
        // A day of slack on each side of the window: summarizeSeason filters
        // with SeasonStandings' exact string compare, so the server bound only
        // has to be wide enough, never exact.
        matches = ((await sbCall(() => supabase.from('matches')
          .select(STANDINGS_MATCH_COLUMNS)
          .eq('league_id', leagueId)
          .gte('played_at', addDaysIso(w.start, -1))
          .lte('played_at', addDaysIso(w.end.slice(0, 10), 2)))) ?? []) as unknown as StandingsMatch[];
      }
      if (seq !== stripSeq.current) return;
      setSeasonSummary(summarizeSeason({
        season: s, lockedPeriods: locked, members: memberList ?? [], matches, myUserId: uid, today, lockToday,
      }));
      summarySeasonId.current = season.id;
    } catch {
      if (seq !== stripSeq.current) return;
      // Keep a strip that was already showing for THIS season; otherwise show
      // the headline without lock or rank facts (unknown is left out, never
      // guessed).
      const fallback: SeasonSummary = {
        ...summarizeSeason({ season: s, lockedPeriods: [], members: [], matches: [], myUserId: uid, today, lockToday }),
        nextLockOn: null,
        lockDue: false,
      };
      const sameSeason = summarySeasonId.current === season.id;
      setSeasonSummary((prev) => (prev && sameSeason ? prev : fallback));
      summarySeasonId.current = season.id;
    }
  }

  // ── Join requests (admins) / my pending request (non-members) ──
  async function loadRequests(role: LeagueRole, uid: string | null, memberList: MemberRow[] | null) {
    try {
      if (isPrivileged(role)) {
        // RLS: admins and co-admins can read their league's requests. Nothing
        // resolves a request when the requester joins another way (redeeming
        // an invite code leaves the row 'pending' forever), so requesters who
        // are already members don't count as waiting; otherwise Manage would
        // flag a stale request and open itself on every visit. If the members
        // read failed, fall back to the raw count.
        const { data } = await supabase.from('league_join_requests')
          .select('user_id')
          .eq('league_id', leagueId)
          .eq('status', 'pending');
        const pending = (data ?? []) as { user_id: string }[];
        const memberIds = memberList ? new Set(memberList.map((m) => m.user_id)) : null;
        setPendingRequests(memberIds ? pending.filter((r) => !memberIds.has(r.user_id)).length : pending.length);
      } else if (role === null && uid) {
        // RLS: a user can read their own requests.
        const { data } = await supabase.from('league_join_requests')
          .select('id')
          .eq('league_id', leagueId)
          .eq('user_id', uid)
          .eq('status', 'pending')
          .maybeSingle();
        setMyRequestPending(!!data);
      }
    } catch {
      // Decorative: the Manage row / "Request sent" state just doesn't show.
    }
  }

  async function loadLatestChampion() {
    // Most recent completed tournament in this league.
    const { data: tour } = await supabase
      .from('tournaments')
      .select('id, name, status')
      .eq('league_id', leagueId)
      .eq('status', 'completed')
      .order('updated_at', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!tour) { setChampion(null); return; }

    // First-place winners from the champion-badges table (MLP auto-payout).
    const { data: badges } = await supabase
      .from('tournament_champion_badges')
      .select('user_id, team_name, team_id')
      .eq('tournament_id', tour.id)
      .eq('place', 1);
    if (!badges || badges.length === 0) { setChampion(null); return; }

    const winnerUids    = badges.map((b: any) => b.user_id);
    // A non-team winner (e.g. singles) has no team_name: null, so the row
    // titles itself "<tournament> champions" instead of "Champions: Champions".
    const rawTeam       = (badges[0] as any).team_name as string | null | undefined;
    const teamName      = rawTeam && rawTeam.trim() ? rawTeam.trim() : null;
    const winningTeamId = (badges[0] as any).team_id ?? null;

    const [profilesRes, standingsRes] = await Promise.all([
      supabase.from('profiles').select('id, full_name').in('id', winnerUids),
      winningTeamId
        ? supabase.rpc('mlp_team_standings', { p_tournament_id: tour.id })
        : Promise.resolve({ data: null } as any),
    ]);

    const names = new Map<string, string>();
    for (const p of (profilesRes.data ?? []) as any[]) if (p.full_name) names.set(p.id, p.full_name);
    // A winner whose profile didn't load is left out rather than shown as "—".
    const winners = winnerUids.map((u: string) => names.get(u)).filter((n: string | undefined): n is string => !!n);

    let record: string | null = null;
    if (winningTeamId && standingsRes?.data) {
      const winRow = (standingsRes.data as any[]).find(r => r.team_id === winningTeamId);
      if (winRow) record = `${winRow.sub_matches_won}-${winRow.sub_matches_lost}`;
    }

    setChampion({
      tournamentName: tour.name,
      teamName,
      winners,
      record,
      onPress: () => navigation.navigate('TournamentDetail', { tournamentId: tour.id, tournamentName: tour.name }),
    });
  }

  async function loadComingUp(privileged: boolean) {
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
      // Scheduled events with a confirmed future slot. We fetch the slot
      // separately rather than via embedded select because the FK on
      // confirmed_slot_id wasn't always present in older schemas: the join
      // would silently return null and drop the row.
      supabase.from('league_events')
        .select('id, title, status, confirmed_slot_id')
        .eq('league_id', leagueId)
        .eq('status', 'scheduled'),
      // Events currently being voted on.
      supabase.from('league_events')
        .select('id, title, status, vote_ends_at')
        .eq('league_id', leagueId)
        .eq('status', 'voting'),
    ]);

    const now = Date.now();
    const items: LeagueComingUpItem[] = [];

    // Tournaments, including those with no start_time yet (registration open,
    // date not picked). Those sort last. Admins see "Date TBD"; everyone else
    // sees what they can act on instead (content rule: no TBD for non-admins).
    for (const tr of ((tRes.data ?? []) as any[])) {
      const ms = tr.start_time ? new Date(tr.start_time).getTime() : null;
      if (ms != null && ms < now) continue;
      items.push({
        key:   `t-${tr.id}`,
        kind:  'tournament',
        title: tr.name,
        when:  ms != null ? fmt(ms) : privileged ? 'Date TBD' : tr.status === 'registration' ? 'Registration open' : 'Starting soon',
        whenMs: ms ?? Number.MAX_SAFE_INTEGER,
        chip:  tournamentStatusChip(tr.status),
        onPress: () => navigation.navigate('TournamentDetail', { tournamentId: tr.id, tournamentName: tr.name }),
      });
    }

    // Resolve confirmed slot starts_at via a second targeted fetch, robust
    // whether or not PostgREST has an FK relationship for the embedded form.
    const scheduledRows = (scheduledRes.data ?? []) as any[];
    const slotIds = scheduledRows.map(ev => ev.confirmed_slot_id).filter(Boolean) as string[];
    const slotStarts = new Map<string, string>();
    if (slotIds.length > 0) {
      const { data: slotRows } = await supabase
        .from('event_slots')
        .select('id, starts_at')
        .in('id', slotIds);
      for (const s of ((slotRows ?? []) as { id: string; starts_at: string }[])) {
        slotStarts.set(s.id, s.starts_at);
      }
    }

    for (const ev of scheduledRows) {
      const startsAt = ev.confirmed_slot_id ? slotStarts.get(ev.confirmed_slot_id) : null;
      if (!startsAt) continue;
      const ms = new Date(startsAt).getTime();
      if (ms < now) continue;
      items.push({
        key:   `e-${ev.id}`,
        kind:  'event',
        title: ev.title,
        when:  fmt(ms),
        whenMs: ms,
        onPress: () => navigation.navigate('EventDetail', { eventId: ev.id, title: ev.title }),
      });
    }

    for (const ev of ((votingRes.data ?? []) as any[])) {
      if (!ev.vote_ends_at) continue;
      const ms = new Date(ev.vote_ends_at).getTime();
      if (ms >= now) {
        // Voting is still open: show the live deadline and land on the vote.
        items.push({
          key:   `v-${ev.id}`,
          kind:  'vote',
          title: ev.title,
          when:  `Voting ends ${fmt(ms)}`,
          whenMs: ms,
          chip:  { label: 'Voting', tone: 'brand' },
          onPress: () => navigation.navigate('EventDetail', { eventId: ev.id, title: ev.title, focus: 'vote' }),
        });
      } else {
        // Voting closed but the event hasn't been finalized into 'scheduled'
        // yet: surface it so admins can act on it. Sorted at "now", above
        // future events.
        items.push({
          key:   `vc-${ev.id}`,
          kind:  'vote',
          title: ev.title,
          when:  privileged ? `Voting closed ${fmt(ms)} · needs finalizing` : `Voting closed ${fmt(ms)}`,
          whenMs: now,
          chip:  { label: 'Vote closed', tone: 'warning' },
          onPress: () => navigation.navigate('EventDetail', { eventId: ev.id, title: ev.title }),
        });
      }
    }

    // Plan section 5 slot 4: needs-you rows first (open votes, and closed votes
    // awaiting finalization, which sit at "now" so they lead the group), each
    // by deadline; then tournaments and play days by date. Without this an open
    // vote with a later deadline falls below the 3-row cap into "Show N more".
    const rank = (it: LeagueComingUpItem) => (it.kind === 'vote' ? 0 : 1);
    items.sort((a, b) => rank(a) - rank(b) || a.whenMs - b.whenMs);
    setComingUp(items);
  }

  // ── Godmode delete ────────────────────────────────────────────
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

  // ── Baseline edit ─────────────────────────────────────────────
  function openBaselineEdit() {
    if (!activeSeason) return;
    setEditBaselineInput(((activeSeason as any).baseline_plupr ?? 3.5).toString());
    setBaselineError(null);
    setShowBaselineEdit(true);
  }

  async function saveBaseline() {
    if (!activeSeason) return;
    setBaselineError(null);
    const v = parseFloat(editBaselineInput);
    if (!Number.isFinite(v) || v < 2 || v > 6.5) {
      setBaselineError('Baseline PLUPR must be between 2.0 and 6.5.');
      return;
    }
    setSavingBaseline(true);
    const { error } = await supabase.from('league_seasons')
      .update({ baseline_plupr: v }).eq('id', activeSeason.id);
    setSavingBaseline(false);
    if (error) { setBaselineError(error.message); return; }
    setShowBaselineEdit(false);
    load();
  }

  // ── Sticky bar ────────────────────────────────────────────────
  function recomputeYouBottom() {
    if (identityH.current == null || youH.current == null) return;
    // container paddingTop + identity + container gap + the "you" slot.
    youBottom.current = SPACE.md + identityH.current + SPACE.md + youH.current;
  }
  function onIdentityLayout(e: LayoutChangeEvent) {
    identityH.current = e.nativeEvent.layout.height;
    recomputeYouBottom();
  }
  function onYouLayout(e: LayoutChangeEvent) {
    youH.current = e.nativeEvent.layout.height;
    recomputeYouBottom();
  }
  function onScroll(e: NativeSyntheticEvent<NativeScrollEvent>) {
    if (youBottom.current == null) return;
    const past = e.nativeEvent.contentOffset.y > youBottom.current;
    if (past !== pastYou.current) {
      pastYou.current = past;
      setStickyVisible(past);
    }
  }

  // The non-member sticky [Join]/[Request] runs its own useLeagueJoin (the
  // card owns another); its copy goes to a toast, and a join reloads the
  // screen, which flips the viewer to a member and removes both.
  const stickyJoin = useLeagueJoin({
    status: { clear() {}, error: toast.error, success: toast.success },
    onJoined: () => load(),
  });

  // Manage opens itself when a step is pending (join requests waiting, a
  // period lock due), unless the user has already opened or closed it.
  const managePending = isPrivileged(myRole) && (pendingRequests > 0 || !!seasonSummary?.lockDue);
  useEffect(() => {
    if (managePending && !manageTouched.current) {
      manageTouched.current = true;
      setManageOpen(true);
    }
  }, [managePending]);

  // ── Render ────────────────────────────────────────────────────

  if (loading) return <View style={[styles.root, { backgroundColor: colors.bg }]}><SkeletonList rows={6} /></View>;
  if (!league) {
    // Without the league row the page is a shell of placeholders: say what
    // actually happened and keep pull-to-refresh mounted.
    const missing = loadError == null || classifySbError(loadError) === 'notFound';
    return (
      <ScrollView contentContainerStyle={styles.container} refreshControl={<AppRefreshControl {...refresh} />}>
        <EmptyState
          icon={missing ? '🔍' : '📡'}
          title={missing ? 'League not found.' : "Couldn't load this league"}
          subtitle={missing ? undefined : friendlySbMessage(loadError)}
          actionLabel="Retry"
          onAction={() => { void load(); }}
        />
      </ScrollView>
    );
  }

  const privileged = isPrivileged(myRole);
  // Only a role read that SUCCEEDED and said "not a member" makes a viewer a
  // non-member. An unreadable role keeps the member layout (with Record).
  const nonMember = roleKnown && !myRole;
  const requested = myRequestPending || stickyJoin.requestedIds.has(leagueId);
  const standingsSeasonId = standingsTargetSeasonId(activeSeason, pastSeasons);
  const memberCount = members ? members.length : null;
  const lockDue = privileged && !!seasonSummary?.lockDue;

  const goStandings = (seasonId: string) =>
    navigation.navigate('SeasonStandings', { seasonId, leagueId, leagueName });
  const goRecord = () => navigation.navigate('MatchEntry', { leagueId });
  const goMembers = () => navigation.navigate('LeagueMembers', { leagueId, leagueName });

  const moreLinks: LeagueMoreLink[] = [
    // Short visible labels keep the line to one 44px row on a 360-390pt phone
    // (plan section 5, slot 5); the a11y labels keep the full names.
    { key: 'history', label: 'History', a11yLabel: 'Match history', onPress: () => navigation.navigate('MatchHistory', { leagueId, title: `${leagueName} History` }) },
    { key: 'calendar', label: 'Calendar', a11yLabel: 'Calendar analytics', onPress: () => navigation.navigate('CalendarAnalytics', { leagueId, title: `${leagueName} Calendar` }) },
    { key: 'tournaments', label: 'Tournaments', onPress: () => navigation.navigate('Tournaments', { leagueId, leagueName }) },
    ...(pastSeasons.length > 0 ? [{
      key: 'past',
      label: `Past (${pastSeasons.length})`,
      a11yLabel: `Past seasons (${pastSeasons.length})`,
      onPress: () => {
        if (pastSeasons.length === 1) goStandings(pastSeasons[0].id);
        else setPastSheetOpen(true);
      },
    }] : []),
  ];

  const baselineValue = (activeSeason as any)?.baseline_plupr;
  const manageRows: LeagueManageRow[] = [
    ...(privileged && pendingRequests > 0 ? [{
      key: 'requests',
      label: `${pendingRequests} join request${pendingRequests === 1 ? '' : 's'}`,
      meta: 'Review',
      attention: true,
      onPress: goMembers,
    }] : []),
    ...(privileged && (godmode || league.is_active) ? [{
      key: 'edit', label: 'Edit league details', onPress: () => setEditVisible(true),
    }] : []),
    ...(privileged ? [{
      key: 'invite',
      label: 'Invite players',
      meta: league.is_open ? null : 'Private: share codes',
      onPress: () => navigation.navigate('Invite', { leagueId, leagueName }),
    }] : []),
    ...(privileged && !activeSeason ? [{
      key: 'season', label: 'Start a season', onPress: () => setSeasonModal(true),
    }] : []),
    ...(privileged && activeSeason ? [
      {
        key: 'periods',
        label: 'Lock periods · complete season',
        meta: lockDue ? 'Lock due' : null,
        attention: lockDue,
        onPress: () => goStandings(activeSeason.id),
      },
      {
        key: 'baseline',
        label: 'Baseline PLUPR',
        meta: `${Number(baselineValue ?? 3.5).toFixed(2)} · Edit`,
        onPress: openBaselineEdit,
      },
    ] : []),
    ...(godmode ? [{
      key: 'delete', label: 'Delete league (godmode)', danger: true, onPress: deleteLeague,
    }] : []),
  ];
  const manageSummary = [
    pendingRequests > 0 && privileged ? `${pendingRequests} join request${pendingRequests === 1 ? '' : 's'}` : null,
    lockDue ? 'Period lock due' : null,
  ].filter(Boolean).join(' · ') || (privileged ? 'Edit, invites, seasons' : 'Developer tools');

  // The sticky bar repeats the "you" slot's one action once it scrolls away.
  // A pending request only counts on a PRIVATE league (as in LeagueJoinCard):
  // if an admin made the league public since, the card offers [Join] and the
  // sticky must repeat it.
  const requestSent = requested && !league.is_open;
  const joinAction = nonMember && !requestSent && !stickyJoin.joinedIds.has(leagueId)
    ? {
        title: league.is_open ? 'Join league' : 'Request to join',
        loading: stickyJoin.isBusy(leagueId),
        onPress: () => {
          if (league.is_open) void stickyJoin.join(leagueId);
          else void stickyJoin.request(leagueId, leagueName);
        },
      }
    : null;
  const stickyPrimary = nonMember ? joinAction : { title: 'Record match', onPress: goRecord };

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <ScrollView
        contentContainerStyle={[styles.container, { paddingBottom: bottomInset }]}
        refreshControl={<AppRefreshControl {...refresh} />}
        onScroll={onScroll}
        scrollEventThrottle={32}
      >
        {/* 1 · Identity (wrapped only to measure its height for the sticky bar) */}
        <View onLayout={onIdentityLayout}>
          <LeagueIdentity
            league={league}
            myRole={myRole}
            memberCount={memberCount}
            privileged={privileged}
            onOpenInfo={() => navigation.navigate('LeagueInfo', { leagueId, leagueName })}
            onSetCourt={privileged && (godmode || league.is_active) ? () => setEditVisible(true) : undefined}
          />
        </View>

        {/* 2 · You: the join card (non-members) and the quick row */}
        <View style={styles.you} onLayout={onYouLayout}>
          <LeagueJoinCard
            leagueId={leagueId}
            leagueName={leagueName}
            isOpen={league.is_open}
            roleKnown={roleKnown}
            isMember={!!myRole && myRole !== 'unknown'}
            requested={requested}
            onJoined={() => load()}
            onRequested={() => setMyRequestPending(true)}
          />
          <LeagueQuickRow
            showRecord={!nonMember}
            onRecord={goRecord}
            recordRef={recordAnchor}
            onRecordLayout={() => { if (focusedRef.current) registerAnchor('leagues', 'record', recordAnchor); }}
            onStandings={standingsSeasonId ? () => goStandings(standingsSeasonId) : null}
            onEvents={() => navigation.navigate('Events', { leagueId, leagueName })}
            onMembers={goMembers}
          />
        </View>

        {/* 3 · Season status strip. While an active season's numbers are
            still loading, render nothing rather than flash an admin the
            "No active season" line. */}
        {!activeSeason || seasonSummary ? (
          <SeasonStrip
            summary={activeSeason ? seasonSummary : null}
            privileged={privileged}
            myUserId={myUserId}
            onOpen={() => { if (activeSeason) goStandings(activeSeason.id); }}
            onStartSeason={() => setSeasonModal(true)}
          />
        ) : null}

        {/* 4 · Coming up (renders nothing when empty) */}
        <LeagueComingUp items={comingUp} champion={champion} />

        {/* 5 · More links, then Manage */}
        <LeagueMoreLinks links={moreLinks} />

        {(privileged || godmode) ? (
          <LeagueManageSection
            open={manageOpen}
            onToggle={(next) => {
              manageTouched.current = true;
              setManageOpen(next);
              trackSectionToggle({ screen: 'LeagueDetail', section: 'manage', open: next });
            }}
            summary={manageSummary}
            rows={manageRows}
            note={!league.is_active && privileged ? 'This league is closed: edits are locked.' : null}
          />
        ) : null}
      </ScrollView>

      {/* Last child of the root, outside the ScrollView: the bar is absolutely
          positioned and publishes its height to the bottom chrome slot, which
          lifts PlayIsland above it and pads the list (bottomInset). */}
      <StickyActionBar
        visible={stickyVisible && !!stickyPrimary}
        active={isFocused}
        summary={leagueName}
        primary={stickyPrimary ?? undefined}
      />

      <ActionSheetModal
        visible={pastSheetOpen}
        title="Past seasons"
        actions={pastSeasons.map((s) => ({
          label: `${s.name} · ${seasonRange(s)}`,
          onPress: () => goStandings(s.id),
        }))}
        onClose={() => setPastSheetOpen(false)}
      />

      <LeagueEditSheet
        visible={editVisible}
        league={league}
        onClose={() => setEditVisible(false)}
        onSaved={(row) => { if (row) setLeague(row); }}
      />

      <SeasonSetupSheet
        visible={seasonModal}
        leagueId={leagueId}
        leagueName={league.name}
        onClose={() => setSeasonModal(false)}
        onCreated={() => { void load(); }}
      />

      <ConfirmModal
        visible={showDeleteConfirm}
        title={`Delete "${league.name}"?`}
        body="This permanently removes the league and all of its members, matches, events, seasons, and tournaments. This cannot be undone."
        primaryLabel="Delete League"
        variant="danger"
        busy={deleting}
        error={deleteError}
        onConfirm={confirmDeleteLeague}
        onClose={() => setShowDeleteConfirm(false)}
      />

      <ConfirmModal
        visible={showBaselineEdit}
        title="Edit Baseline PLUPR"
        body={
          <View>
            <Text style={[t.sub, styles.baselineHint]}>
              Soft-reset target at end of each period. Top-5 finishers keep a small bonus on top
              of this baseline; everyone else snaps clean to it. Allowed: 2.00–6.50.
            </Text>
            <TextField
              value={editBaselineInput}
              onChangeText={setEditBaselineInput}
              keyboardType="decimal-pad"
              placeholder="e.g. 4.5"
            />
          </View>
        }
        primaryLabel="Save"
        busy={savingBaseline}
        error={baselineError}
        onConfirm={() => saveBaseline()}
        onClose={() => setShowBaselineEdit(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  // Top padding is SPACE.md (not the lg gutter) so the quick row's Record
  // stays above y=200 even when the chip row wraps to two lines.
  container: { paddingHorizontal: SPACE.lg, paddingTop: SPACE.md, gap: SPACE.md },
  you: { gap: SPACE.md },
  baselineHint: { marginBottom: SPACE.sm },
});
