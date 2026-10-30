import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavReserve, useScreenBottomInset } from '../lib/appChrome';
import {
  LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent, ScrollView, StyleSheet, Text,
  TouchableOpacity, View,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useIsFocused } from '@react-navigation/native';
import { classifySbError, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { CollapsibleSection, ErrorState, Panel, StickyActionBar } from '@just-messin-around/expo-foundation/ui';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { isImageShareAvailable } from '@just-messin-around/expo-foundation/platform';
import FinishShareStudio from '../components/share/FinishShareStudio';
import { cardPodium, shortName, type FinishShareData } from '../lib/finishShare';
import { useBlockedIds } from '../lib/moderation';
import { SPACE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { RootStackParamList } from '../types';
import { isTournamentPrivileged, requiresPartner, bracketReleaseLabel } from '../lib/tournamentRole';
import { FORMAT_META } from '../lib/tournament';
import { WAGERS_ENABLED } from '../lib/features';
import { trackSectionToggle } from '../lib/analytics';
import { finalRankOf, podiumFromFinalRanks } from '../lib/tournamentStandings';
import AppDateTimePicker from '../components/AppDateTimePicker';
import PicklePotCard from '../components/PicklePotCard';
import DoublesPairSection from '../components/DoublesPairSection';
import MlpTeamSection from '../components/MlpTeamSection';
import MlpPlayoffPreview from '../components/MlpPlayoffPreview';
import TournamentFlowOverview from '../components/TournamentFlowOverview';
import PayoutPreviewModal from '../components/PayoutPreviewModal';
import ConfirmModal from '../components/ConfirmModal';
import StatusBanner from '../components/StatusBanner';
import AppRefreshControl from '../components/AppRefreshControl';
import { SkeletonList } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';
import { picklesLabel } from '../components/PickleAmount';
import { useTheme } from '../lib/ThemeContext';
import { useTournamentDetail } from '../components/tournament/useTournamentDetail';
import { buildFlowStages } from '../components/tournament/flowStages';
import { buildStandings, myStanding } from '../components/tournament/standingsData';
import {
  canRecordMatch, currentSetupStep, doublesPairingDone, doublesPartnerOf, involves, mlpTeamOf, mlpTeamsDone,
  nextMatchFor, opponentsOf, partnerOf, setupSteps, youCardKind,
  EMPTY_SCHEDULE_FILTER, type ScheduleFilter, type ScheduleMatch,
} from '../components/tournament/tournamentModel';
import TournamentIdentity from '../components/tournament/TournamentIdentity';
import TournamentHeaderActions from '../components/tournament/TournamentHeaderActions';
import TournamentYouCard, { youCardView } from '../components/tournament/TournamentYouCard';
import TournamentManageSection, { type ManageGroup, type ManageStep } from '../components/tournament/TournamentManageSection';
import SectionCard from '../components/tournament/SectionCard';
import StandingsSection from '../components/tournament/StandingsSection';
import PlayersSection from '../components/tournament/PlayersSection';
import { PendingRequestsSection, WaitlistSection } from '../components/tournament/RegistrationQueues';
import PoolAssignmentsPreview from '../components/tournament/PoolAssignmentsPreview';
import PoolPlayBracketSection from '../components/tournament/PoolPlayBracketSection';
import GeneratePlayoffSection, { groupPlayPendingCount } from '../components/tournament/GeneratePlayoffSection';
import MatchScheduleSection from '../components/tournament/MatchScheduleSection';
import PreviewScheduleSection from '../components/tournament/PreviewScheduleSection';
import WagerMarket from '../components/tournament/WagerMarket';
import GodmodePanel from '../components/tournament/GodmodePanel';
import EditTournamentModal from '../components/tournament/EditTournamentModal';
import WagerModals from '../components/tournament/WagerModals';
import AlbumSection from '../components/AlbumSection';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'TournamentDetail'>;
  route: RouteProp<RootStackParamList, 'TournamentDetail'>;
};

/** Playoff round types (a playoff exists once one of these rounds does). */
const PLAYOFF_ROUND_TYPES = ['quarterfinals', 'semifinals', 'finals', 'third_place_match'];

/** Section keys for section.toggle analytics and scroll anchors. */
type SectionKey = 'you' | 'schedule' | 'teams' | 'players' | 'pot' | 'wager' | 'playoff' | 'manage' | 'standings';
/** Scroll targets: the sections, plus the StatusBanner under the You card. */
type AnchorKey = SectionKey | 'banner';

// TournamentDetail, UI compaction P5b (plan section 5): ordered sections, no
// in-screen tabs (decision 4). Every detail screen uses the same slots:
//
//   0  header: native title + [Share] [Bookmark]
//   1  identity: status pill + chips (ante included) + 2-line description
//   2  You: the one Emphasis card, by status x role (TournamentYouCard)
//   3  status strip: the stage and how much is played (active / completed)
//   4  registration: Teams/Pairs, Players (collapsed, AvatarPile), Pot, Manage
//      active / completed: flow strip (doubles as the round filter),
//      standings for every format, playoff, Schedule, then Teams, Players,
//      Pot collapsed, Manage
//
// A StickyActionBar repeats the You card's primary action ("Record next
// match", "Request to join", Accept / Decline) once the card scrolls off.
// State, loading and every action still live in useTournamentDetail (P5a);
// the decisions are pure functions in components/tournament/tournamentModel.
export default function TournamentDetailScreen({ navigation, route }: Props) {
  const { tournamentId, focus } = route.params;
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const td = useTournamentDetail({ navigation, tournamentId });
  const isFocused = useIsFocused();
  // The navigator already keeps the bottom bar and the island clear (lib/appChrome).
  const bottomInset = useScreenBottomInset(SPACE.xl);
  const navReserve = useNavReserve();

  // ── Section open state (all hooks above the loading return) ──
  const [manageOpen, setManageOpen] = useState(false);
  const manageAutoOpened = useRef(false);
  const [playersOpen, setPlayersOpen] = useState(false);
  // null = the status/role default (open for approved players and organizers
  // during registration, collapsed otherwise) until the user toggles it.
  const [teamsOpenChoice, setTeamsOpenChoice] = useState<boolean | null>(null);
  const [potOpen, setPotOpen] = useState(false);
  const [playoffOpenChoice, setPlayoffOpenChoice] = useState<boolean | null>(null);
  const [scheduleFilter, setScheduleFilter] = useState<ScheduleFilter>(EMPTY_SCHEDULE_FILTER);
  const [registering, setRegistering] = useState(false);
  const registeringRef = useRef(false);
  const [responding, setResponding] = useState(false);
  const respondingRef = useRef(false);

  // ── Scroll: anchors, the focus param, and the sticky bar ──
  // Each anchor is the onLayout y of a direct child of the scroll content
  // (a content offset). `pendingScroll` is what this visit arrived for
  // (Home's Up next: 'invite' / 'next_match'); it's consumed once, so the
  // focus reloads that follow never jump the user again.
  const scrollRef = useRef<ScrollView>(null);
  const anchors = useRef<Partial<Record<SectionKey, number>>>({});
  const pendingScroll = useRef<'invite' | 'next_match' | 'standings' | null>(
    focus === 'invite' || focus === 'next_match' || focus === 'standings' ? focus : null,
  );
  // A section the user asked to jump to ("Find a partner", "Setup"): opening
  // it changes its size, so its own onLayout (fresh y, on web too) scrolls.
  const pendingReveal = useRef<SectionKey | null>(null);
  // Sticky bar threshold from SIZES only (identity + You card heights):
  // react-native-web's onLayout comes from a ResizeObserver and doesn't fire
  // when a View only MOVES, so a y would go stale when the identity grows.
  const identityH = useRef<number | null>(null);
  const youH = useRef<number | null>(null);
  const pastYou = useRef(false);
  const [stickyVisible, setStickyVisible] = useState(false);

  // The anchored Views themselves, so a jump measures the target at TAP time.
  // The cached onLayout y above goes stale on web whenever something above the
  // target changes height without resizing it (MLP standings landing, the
  // StatusBanner appearing, Playoff toggled, the description's "more").
  const anchorRefs = useRef<Partial<Record<AnchorKey, View | null>>>({});
  const anchorRefSetters = useRef<Partial<Record<AnchorKey, (r: View | null) => void>>>({});
  function anchorRef(key: AnchorKey) {
    // Stable per key, so React doesn't detach / reattach the ref every render.
    let set = anchorRefSetters.current[key];
    if (!set) {
      set = (r: View | null) => { anchorRefs.current[key] = r; };
      anchorRefSetters.current[key] = set;
    }
    return set;
  }

  function scrollToY(y: number) {
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ y: Math.max(0, y - SPACE.sm), animated: true }));
  }
  /** Scroll to an anchor, measured now against the scroll content (native and
   *  web: RNW's measureLayout compares the two nodes' rects at call time). */
  function scrollToAnchor(key: AnchorKey) {
    const cached = () => {
      const y = key === 'banner' ? null : anchors.current[key];
      if (y != null) scrollToY(y);
    };
    const node: any = anchorRefs.current[key];
    const inner = (scrollRef.current as any)?.getInnerViewRef?.();
    if (node && inner && typeof node.measureLayout === 'function') {
      try {
        node.measureLayout(inner, (_x: number, y: number) => scrollToY(y), cached);
        return;
      } catch { /* fall through to the cached y */ }
    }
    cached();
  }
  function consumePendingScroll(key: SectionKey | null) {
    pendingScroll.current = null;
    // Clear the param too, so a web refresh (the param is in the URL) or a
    // re-render doesn't re-arm the scroll.
    navigation.setParams({ focus: undefined });
    if (key != null) scrollToAnchor(key);
  }
  function anchorLayout(key: SectionKey) {
    return (e: LayoutChangeEvent) => {
      anchors.current[key] = e.nativeEvent.layout.y;
      if (key === 'you') { youH.current = e.nativeEvent.layout.height; }
      if (pendingReveal.current === key) {
        pendingReveal.current = null;
        scrollToY(e.nativeEvent.layout.y);
      }
      tryPendingScroll();
    };
  }
  function onIdentityLayout(e: LayoutChangeEvent) {
    identityH.current = e.nativeEvent.layout.height;
    tryPendingScroll();
  }
  function onScroll(e: NativeSyntheticEvent<NativeScrollEvent>) {
    if (identityH.current == null || youH.current == null || youH.current === 0) return;
    // Content padding above the identity, its bottom margin, then the card.
    const past = e.nativeEvent.contentOffset.y > SPACE.lg + identityH.current + SPACE.md + youH.current;
    if (past !== pastYou.current) {
      pastYou.current = past;
      setStickyVisible(past);
    }
  }
  /** Open a collapsible section (if needed) and bring it into view. */
  function reveal(key: SectionKey, isOpen: boolean, open: () => void) {
    if (isOpen) {
      scrollToAnchor(key);
      return;
    }
    pendingReveal.current = key;
    open();
  }

  const tournament = td.tournament;
  useLayoutEffect(() => {
    if (!tournament) return;
    navigation.setOptions({
      headerRight: () => (
        <TournamentHeaderActions
          tournamentId={tournamentId}
          tournamentName={tournament.name}
          registrationOpen={tournament.status === 'registration'}
          onCopied={() => td.status.success('Tournament link copied.')}
        />
      ),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigation, tournamentId, tournament?.name, tournament?.status]);

  // ── Derived data (memoized; safe before the loading return) ──
  const blocked = useBlockedIds();
  const [shareOpen, setShareOpen] = useState(false);
  const registrations = td.registrations;
  const approved = useMemo(() => registrations.filter(r => r.status === 'approved'), [registrations]);
  const myUserId = td.myUserId;
  const myRole = td.myRole;
  const isPriv = isTournamentPrivileged(myRole);
  const isAdmin = myRole === 'admin';
  const standings = useMemo(() => tournament ? buildStandings({
    tournament,
    savedMatches: td.savedMatches,
    savedRounds: td.savedRounds,
    registrations,
    profileNames: td.profileNames,
    profileRatings: td.profileRatings,
    myUserId,
    mlpStandings: td.mlpStandings,
    myMlpTeamId: mlpTeamOf(td.mlpTeams, myUserId)?.id ?? null,
    finalRanks: td.finalRanks,
  }) : null, [tournament, td.savedMatches, td.savedRounds, registrations, td.profileNames,
    td.profileRatings, myUserId, td.mlpStandings, td.mlpTeams, td.finalRanks]);
  const nextMatch = useMemo(
    () => nextMatchFor(td.savedMatches as ScheduleMatch[], myUserId),
    [td.savedMatches, myUserId],
  );

  // Manage opens itself once, on the first load, when a step is waiting.
  useEffect(() => {
    if (manageAutoOpened.current || td.loading || !tournament) return;
    manageAutoOpened.current = true;
    if (!isPriv) return;
    const pendingReqs = registrations.some(r => r.status === 'pending' && r.invited_by == null);
    const payoutDue = tournament.status === 'completed' && (tournament.prize_pool ?? 0) > 0
      && !tournament.champion_payout_applied_at;
    // Group play is finished and the playoff is configured but not drawn:
    // the organizer's next step is in Manage (it used to sit inline).
    const playoffDue = tournament.status === 'active'
      && (tournament.format === 'round_robin' || tournament.format === 'pool_play')
      && (tournament.playoff_format ?? 'none') !== 'none'
      && td.savedMatches.length > 0
      && !td.savedRounds.some((r: any) => PLAYOFF_ROUND_TYPES.includes(r.round_type))
      && groupPlayPendingCount(td.savedRounds, td.savedMatches) === 0;
    if ((tournament.status === 'registration' && pendingReqs) || payoutDue || playoffDue) setManageOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [td.loading, tournament, isPriv, registrations]);

  function tryPendingScroll() {
    const want = pendingScroll.current;
    if (!want || td.loading || !td.tournament) return;
    const tt = td.tournament;
    if (want === 'standings') {
      // Saved's tap: straight to the standings (your row pinned there). No
      // standings section (nothing played yet) leaves the user at the top.
      if (!standings) { consumePendingScroll(null); return; }
      if (anchors.current.standings == null) return;   // its onLayout retries
      consumePendingScroll('standings');
      return;
    }
    if (want === 'invite') {
      // The invite controls are on the You card, right under the identity.
      if (anchors.current.you == null) return;   // not laid out yet; its onLayout retries
      consumePendingScroll('you');
      return;
    }
    // 'next_match': the You card when it shows the next match, otherwise the
    // schedule. Without either the user stays at the top (the safe fallback).
    const scheduleShown = (tt.status === 'active' || tt.status === 'completed') && td.savedMatches.length > 0;
    if (tt.status === 'active' && nextMatch) {
      if (anchors.current.you == null) return;
      consumePendingScroll('you');
      return;
    }
    if (!scheduleShown) { consumePendingScroll(null); return; }
    if (anchors.current.schedule == null) return;
    consumePendingScroll('schedule');
  }
  // Data can land after an anchor's first layout; retry once loading settles.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { tryPendingScroll(); }, [td.loading, td.tournament, td.savedMatches]);

  // Action feedback (the sticky bar's Request to join / Accept / Decline, and
  // Manage's approve / generate / lock-in / playoff at the bottom) lands in the
  // one StatusBanner under the You card. When it arrives while the user is
  // scrolled past that card, bring the banner into view so a failure isn't a
  // silent no-op (useStatusMessage sets a fresh object per message, so this
  // fires once per message).
  const statusValue = td.status.value;
  useEffect(() => {
    if (!statusValue || !pastYou.current) return;
    scrollToAnchor('banner');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusValue]);

  function toggle(section: SectionKey, next: boolean, set: (v: boolean) => void) {
    set(next);
    trackSectionToggle({ screen: 'TournamentDetail', section, open: next });
  }

  if (td.loading) return <View style={{ flex: 1, backgroundColor: c.bg }}><SkeletonList rows={6} /></View>;
  if (!tournament) {
    // Without the tournament row there is nothing to show: say what actually
    // happened and keep pull-to-refresh + Retry mounted (LeagueDetail pattern).
    const missing = td.loadError == null || classifySbError(td.loadError) === 'notFound';
    return (
      <ScrollView style={{ flex: 1, backgroundColor: c.bg }} refreshControl={<AppRefreshControl {...td.refresh} />}>
        {missing ? (
          <EmptyState
            iconName="search"
            title="Tournament not found."
            actionLabel="Retry"
            onAction={() => { void td.load(); }}
          />
        ) : (
          <ErrorState
            iconName="offline"
            error={td.loadError}
            message={`Couldn't load this tournament. ${friendlySbMessage(td.loadError)}`}
            retryLabel="Retry"
            onRetry={() => { void td.load(); }}
          />
        )}
      </ScrollView>
    );
  }

  // ── Registration facts ──
  const status = tournament.status;
  const live = status !== 'completed' && status !== 'cancelled';
  const pending = registrations.filter(r => r.status === 'pending');
  // Pending registrations split: admin-invited (waiting on invitee) vs self-submitted requests.
  const pendingInvited = pending.filter(r => r.invited_by != null);
  const pendingRequests = pending.filter(r => r.invited_by == null);
  // Waitlist: self-requests that arrived while the tournament was full,
  // oldest first (that's the promotion order the DB uses).
  const waitlisted = registrations
    .filter(r => r.status === 'waitlisted')
    .sort((a, b) => new Date(a.registered_at).getTime() - new Date(b.registered_at).getTime());
  const isFull = tournament.max_players != null && approved.length >= tournament.max_players;
  // Public "Players": approved members + outstanding invites. Join requests
  // stay organizer-only (Manage) since nobody has decided on them yet.
  const rosterShown = [...approved, ...pendingInvited];
  const myReg = registrations.find(r => r.user_id === myUserId);
  // Registration deadline (optional, client-enforced): once passed, the
  // Request to Join action is replaced by the closed note.
  const regClosed = tournament.registration_closes_at != null
    && Date.now() >= new Date(tournament.registration_closes_at).getTime();
  const canRegister = !myReg && status === 'registration'
    && tournament.registration_mode === 'request' && !regClosed;
  const isMlp = tournament.format === 'mlp' || tournament.format === 'mlp_random';
  const needsPairs = requiresPartner(tournament.format, tournament.match_type);
  const hasTeams = needsPairs || isMlp;
  const approvedIds = approved.map(r => r.user_id);
  const pairingDone = isMlp ? mlpTeamsDone(td.mlpTeams) : doublesPairingDone(approvedIds, td.doublesPairs);
  const fmt = FORMAT_META[tournament.format];

  // ── Active / completed facts ──
  const scheduleExists = (status === 'active' || status === 'completed') && td.savedMatches.length > 0;
  const flowStages = buildFlowStages({
    tournament, savedRounds: td.savedRounds, savedMatches: td.savedMatches,
    doublesPairs: td.doublesPairs, approved,
  });
  const upcomingStages = (flowStages ?? []).filter(s => !s.exists);
  const playoffExists = td.savedRounds.some((r: any) => PLAYOFF_ROUND_TYPES.includes(r.round_type));
  const mine = myStanding(standings);
  const inSchedule = (td.savedMatches as ScheduleMatch[]).some(m => involves(m, myUserId));
  const playableMatches = (td.savedMatches as ScheduleMatch[]).filter(m => m.match_type !== 'bye'
    && !(m.is_dreambreaker && m.status === 'cancelled'));
  const playedCount = playableMatches.filter(m => m.status === 'completed').length;

  // ── Organizer setup checklist ──
  const steps = setupSteps({
    pendingRequests: pendingRequests.length,
    releaseSet: !!tournament.bracket_release_time,
    needsPairing: hasTeams,
    pairingDone,
    previewReady: !!td.generatedMatches && td.generatedMatches.length > 0,
  });
  const current = currentSetupStep(steps);
  // Generate and Lock in are the admin's alone (Manage says so); a co-admin
  // whose next step is one of them is waiting, not acting.
  const setupWaitingOnAdmin = !isAdmin && (current.step.key === 'generate' || current.step.key === 'lock');

  // ── Navigation helpers ──
  function openRecord(m: ScheduleMatch) {
    navigation.navigate('MatchEntry', {
      leagueId:           tournament!.league_id ?? '',
      tournamentId:       tournament!.id,
      tournamentMatchId:  m.id,
      tournamentName:     tournament!.name,
      prefillMatchType:   (m.match_type as any) ?? undefined,
      prefillTeam1Player: m.team1_player1 ?? undefined,
      prefillTeam1Partner:m.team1_player2 ?? undefined,
      prefillTeam2Player: m.team2_player1 ?? undefined,
      prefillTeam2Partner:m.team2_player2 ?? undefined,
    });
  }
  async function register() {
    if (registeringRef.current) return;
    registeringRef.current = true;
    setRegistering(true);
    try { await td.register(); } finally { registeringRef.current = false; setRegistering(false); }
  }
  // Accept / Decline: one call in flight, so a double tap (card or sticky
  // bar) can't hit the RPC's "Invite already ..." and show a false failure.
  async function respond(accept: boolean) {
    if (!myReg || respondingRef.current) return;
    respondingRef.current = true;
    setResponding(true);
    try { await td.respondToTournamentInvite(myReg.id, accept); } finally { respondingRef.current = false; setResponding(false); }
  }
  const teamsDefaultOpen = status === 'registration' && (isPriv || myReg?.status === 'approved');
  const teamsOpen = teamsOpenChoice ?? teamsDefaultOpen;
  const playoffOpen = playoffOpenChoice ?? (status === 'active' || status === 'completed');
  const openManage = () => reveal('manage', manageOpen, () => setManageOpen(true));
  const openTeams = () => reveal('teams', teamsOpen, () => setTeamsOpenChoice(true));
  const openSchedule = scheduleExists ? () => reveal('schedule', true, () => {}) : null;

  // ── The You card ──
  const kind = youCardKind({
    status,
    isPriv,
    myReg,
    canRegister,
    inviteOnly: tournament.registration_mode === 'invite_only',
    regClosed: regClosed && tournament.registration_mode === 'request',
    inSchedule,
    hasNextMatch: !!nextMatch && canRecordMatch(nextMatch, { isPriv, myUserId }),
    hasFinalRanks: td.finalRanks.length > 0,
  });
  let teamLine: string | null = null;
  let needsPartner = false;
  let findPartnerLabel = 'Find a partner';
  if (needsPairs) {
    const p = doublesPartnerOf(td.doublesPairs, myUserId);
    if (p.found && p.partnerId) teamLine = `Partner: ${td.playerName(p.partnerId)}`;
    else if (tournament.team_creation === 'random') teamLine = 'Partners are drawn by the organizer.';
    else { teamLine = p.found ? 'Your pair still needs a partner.' : 'No partner yet.'; needsPartner = true; }
  } else if (isMlp) {
    const team = mlpTeamOf(td.mlpTeams, myUserId);
    findPartnerLabel = 'Find a team';
    if (team) teamLine = `Team: ${team.name}`;
    else if (tournament.format === 'mlp_random') teamLine = 'Teams are drawn by the organizer.';
    else { teamLine = 'Not on a team yet.'; needsPartner = true; }
  }
  const myRank = finalRankOf(td.finalRanks, myUserId);
  const pool = tournament.prize_pool ?? 0;

  // ── Share my finish (PKL-013): a completed tournament where I have a rank ──
  let shareData: FinishShareData | null = null;
  if (status === 'completed' && myRank != null && myUserId) {
    const profileOf = (id: string) => registrations.find(r => r.user_id === id)?.profile;
    shareData = {
      kind: 'tournament',
      title: tournament.name,
      league: null,
      rank: myRank,
      of: new Set(td.finalRanks.map(r => r.final_rank)).size || null,
      wins: mine ? mine.row.wins : null,
      losses: mine ? mine.row.losses : null,
      me: shortName(profileOf(myUserId)?.full_name ?? td.playerName(myUserId)),
      podium: cardPodium(
        podiumFromFinalRanks(td.finalRanks).map(p => ({
          rank: p.rank,
          players: p.userIds.map(id => ({
            id,
            fullName: profileOf(id)?.full_name ?? td.profileNames[id] ?? null,
            deleted: !!profileOf(id)?.deleted_at,
          })),
        })),
        blocked,
      ),
    };
  }
  const canShareFinish = !!shareData && isImageShareAvailable();
  const view = youCardView(kind, {
    isFull,
    spotsLeft: tournament.max_players != null ? Math.max(0, tournament.max_players - approved.length) : null,
    ante: tournament.pickle_ante ?? 0,
    closesLabel: tournament.registration_closes_at && !regClosed
      ? `closes ${new Date(tournament.registration_closes_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
      : null,
    register,
    registering,
    inviterName: myReg?.invited_by && td.profileNames[myReg.invited_by] ? td.profileNames[myReg.invited_by] : 'An organizer',
    accept: () => respond(true),
    decline: () => respond(false),
    responding,
    waitlistPosition: myReg?.status === 'waitlisted'
      ? Math.max(1, waitlisted.findIndex(r => r.id === myReg.id) + 1)
      : null,
    teamLine,
    needsPartner,
    findPartnerLabel,
    onFindPartner: openTeams,
    // No "not set yet" line for players (plan content rule 3); the organizer
    // has the "Set the release time" step in Manage.
    releaseLine: bracketReleaseLabel(tournament.bracket_release_time) || null,
    setupIndex: current.index,
    setupTotal: steps.length,
    setupLabel: current.step.label,
    setupWaitingOnAdmin,
    onOpenSetup: openManage,
    opponents: nextMatch && myUserId ? opponentsOf(nextMatch, myUserId).map(td.playerName).join(' & ') : '',
    partner: nextMatch && myUserId && partnerOf(nextMatch, myUserId) ? td.playerName(partnerOf(nextMatch, myUserId)!) : null,
    roundLabel: nextMatch?.round?.label ?? null,
    recordLine: mine
      ? `You ${mine.row.wins}-${mine.row.losses} · #${mine.position} of ${mine.of}${mine.table ? ` in ${mine.table}` : ''}`
      : null,
    onRecord: () => { if (nextMatch) openRecord(nextMatch); },
    onOpenSchedule: openSchedule,
    myRank,
    podium: podiumFromFinalRanks(td.finalRanks).map(p => ({
      rank: p.rank,
      names: p.userIds.map(td.playerName).join(' & '),
      isMe: !!myUserId && p.userIds.includes(myUserId),
    })),
    payoutLine: pool > 0
      ? (tournament.champion_payout_applied_at ? `${picklesLabel(pool)} pot paid out` : `${picklesLabel(pool)} pot · payout pending`)
      : null,
    onShare: canShareFinish ? () => setShareOpen(true) : null,
  });

  // ── Sticky bar: the You card's primary action, once the card is off screen ──
  const stickyPrimary = view?.primary
    ? {
        title: kind === 'next_match' ? 'Record next match' : view.primary.title,
        onPress: view.primary.onPress,
        loading: view.primary.loading,
      }
    : kind === 'setup' && !setupWaitingOnAdmin ? { title: 'Open setup', onPress: openManage } : null;
  const stickySecondary = view?.secondary
    ? { title: view.secondary.title, onPress: view.secondary.onPress, variant: 'outline' as const, disabled: view.secondary.disabled }
    : undefined;

  // ── Pot ──
  const ante = tournament.pickle_ante ?? 0;
  const structure = tournament.payout_structure ?? [60, 25, 15];
  // Hidden for non-organizers when there is nothing in it (plan section 5).
  const potShown = isPriv || pool > 0 || ante > 0;
  const potSummary = [picklesLabel(pool), ante > 0 ? `${ante} ante` : null, `${structure.join('/')}% payout`]
    .filter(Boolean).join(' · ');

  // ── Manage ──
  const manageShown = isPriv || td.godmode;
  const manageSteps: ManageStep[] = [];
  if (isPriv && status === 'registration') {
    for (const s of steps) {
      const isCurrent = s.key === current.step.key;
      const base = { key: s.key, label: s.label, done: s.done, current: isCurrent };
      if (s.key === 'approve') {
        manageSteps.push({
          ...base,
          meta: waitlisted.length > 0 ? `${waitlisted.length} on the waitlist` : null,
          content: pendingRequests.length > 0 || waitlisted.length > 0 ? (
            <View style={{ gap: SPACE.sm }}>
              {pendingRequests.length > 0 && (
                <PendingRequestsSection pendingRequests={pendingRequests} approveReg={td.approveReg} rejectReg={td.rejectReg} />
              )}
              {waitlisted.length > 0 && (
                <WaitlistSection waitlisted={waitlisted} approveReg={td.approveReg} rejectReg={td.rejectReg} />
              )}
            </View>
          ) : null,
        });
      } else if (s.key === 'release') {
        manageSteps.push({
          ...base,
          meta: tournament.bracket_release_time
            ? new Date(tournament.bracket_release_time).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
            : 'Players see a countdown to it on their card.',
          actions: td.generatedMatches ? [] : [{
            title: tournament.bracket_release_time ? 'Change' : 'Set time',
            onPress: () => td.setShowReleasePicker(true),
            variant: 'outline',
          }],
        });
      } else if (s.key === 'pair') {
        manageSteps.push({
          ...base,
          meta: isMlp
            ? `${td.mlpTeams.length} team${td.mlpTeams.length === 1 ? '' : 's'}${tournament.format === 'mlp_random' ? ' · draw them in Teams' : ''}`
            : `${td.doublesPairs.filter(p => p.partner_1_id && p.partner_2_id).length} complete pair(s) for ${approved.length} players`,
          actions: [{ title: isMlp ? 'Open Teams' : 'Open Pairs', onPress: openTeams, variant: 'outline' }],
        });
      } else if (s.key === 'generate') {
        const minShort = tournament.min_players != null && approved.length < tournament.min_players;
        manageSteps.push({
          ...base,
          meta: !isAdmin ? 'Only the tournament admin can generate the bracket.'
            : approved.length < 2 ? 'Needs at least 2 approved players.'
            : minShort ? `${approved.length}/${tournament.min_players} minimum players: ${tournament.min_players! - approved.length} more before it can lock in.`
            : null,
          content: td.generatedMatches && td.generatedMatches.length > 0 ? (
            <View style={{ gap: SPACE.sm }}>
              {td.pools && <PoolAssignmentsPreview tournament={tournament} pools={td.pools} playerName={td.playerName} />}
              <PreviewScheduleSection
                generatedMatches={td.generatedMatches}
                myUserId={myUserId}
                myMatchesOnly={td.myMatchesOnly}
                setMyMatchesOnly={td.setMyMatchesOnly}
                playerName={td.playerName}
              />
            </View>
          ) : null,
          actions: isAdmin && approved.length >= 2 ? [{
            title: td.generatedMatches ? 'Re-generate preview' : `Generate ${fmt.label} schedule`,
            onPress: () => { void td.generateBracket(); },
            variant: td.generatedMatches ? 'outline' : 'primary',
          }] : [],
        });
      } else if (s.key === 'lock') {
        manageSteps.push({
          ...base,
          label: isAdmin ? s.label : `${s.label} (admin)`,
          meta: td.generatedMatches ? `Saves the draw and notifies all ${approved.length} players.` : 'After the preview.',
          actions: isAdmin && td.generatedMatches ? [{
            title: td.locking ? 'Locking in…' : 'Lock in & notify',
            onPress: td.lockInBracket,
            loading: td.locking,
          }] : [],
        });
      }
    }
  }
  if (isPriv && status !== 'registration' && (pendingRequests.length > 0 || waitlisted.length > 0)) {
    // Requests left unanswered at lock-in stay 'pending' / 'waitlisted'
    // (doLockIn and the waitlist promoter don't touch them), so organizers
    // can still approve or reject them after registration, as on master.
    manageSteps.push({
      key: 'requests',
      label: `Resolve ${pendingRequests.length + waitlisted.length} leftover request${pendingRequests.length + waitlisted.length === 1 ? '' : 's'}`,
      done: false,
      meta: [
        'Left over from registration',
        pendingRequests.length > 0 ? `${pendingRequests.length} pending` : null,
        waitlisted.length > 0 ? `${waitlisted.length} on the waitlist` : null,
      ].filter(Boolean).join(' · '),
      content: (
        <View style={{ gap: SPACE.sm }}>
          {pendingRequests.length > 0 && (
            <PendingRequestsSection pendingRequests={pendingRequests} approveReg={td.approveReg} rejectReg={td.rejectReg} />
          )}
          {waitlisted.length > 0 && (
            <WaitlistSection waitlisted={waitlisted} approveReg={td.approveReg} rejectReg={td.rejectReg} />
          )}
        </View>
      ),
    });
  }
  if (isPriv && status === 'active') {
    const playoffConfigured = (tournament.format === 'round_robin' || tournament.format === 'pool_play')
      && (tournament.playoff_format ?? 'none') !== 'none';
    if (playoffConfigured && td.savedMatches.length > 0) {
      manageSteps.push({
        key: 'playoff',
        label: playoffExists ? 'Playoff drawn' : 'Generate the playoff',
        done: playoffExists,
        current: !playoffExists,
        content: playoffExists ? null : (
          <GeneratePlayoffSection
            tournament={tournament}
            savedRounds={td.savedRounds}
            savedMatches={td.savedMatches}
            generatingPlayoff={td.generatingPlayoff}
            generatePlayoff={td.generatePlayoff}
          />
        ),
      });
    }
    manageSteps.push({
      key: 'complete',
      label: 'Complete the tournament',
      done: false,
      meta: 'Stops match recording and unlocks the payout.',
      actions: [{ title: 'Complete', onPress: () => td.setShowCompleteConfirm(true), variant: 'outline' }],
    });
  }
  if (isPriv && status === 'completed' && pool > 0) {
    // Every format (it used to sit in the MLP-only card). The server's
    // preview / auto-payout RPCs dispatch by format.
    const paidAt = tournament.champion_payout_applied_at;
    manageSteps.push({
      key: 'payout',
      label: paidAt ? 'Prizes paid out' : 'Pay out prizes',
      done: !!paidAt,
      current: !paidAt,
      meta: paidAt
        ? new Date(paidAt).toLocaleDateString()
        : `Splits ${picklesLabel(pool)} among the finishers · stamps badges · applies the PLUPR bonus`,
      actions: paidAt ? [] : [{ title: 'Review payout', onPress: () => td.setShowPayoutModal(true) }],
    });
  }
  const manageGroups: ManageGroup[] = [{
    key: 'always',
    title: manageSteps.length > 0 ? 'Tournament' : undefined,
    rows: [
      ...(isAdmin && (td.godmode || live) ? [{ key: 'edit', label: 'Edit tournament', onPress: td.openEditModal }] : []),
      ...(isPriv && status === 'registration' ? [
        { key: 'invite', label: 'Invite players', onPress: () => navigation.navigate('TournamentInvitePlayers', { tournamentId, tournamentName: tournament.name }) },
        { key: 'code', label: 'Invite via code', onPress: () => navigation.navigate('TournamentInvite', { tournamentId, tournamentName: tournament.name }) },
      ] : []),
      ...(isPriv ? [{ key: 'roles', label: 'Members & roles', onPress: () => navigation.navigate('TournamentMembers', { tournamentId, tournamentName: tournament.name }) }] : []),
      // Creator; any live status, before payout. The RPC refunds everything.
      ...(isAdmin && live && tournament.champion_payout_applied_at == null ? [{
        key: 'cancel',
        label: 'Cancel tournament',
        meta: 'Refunds everyone',
        danger: true,
        onPress: () => { td.setCancelError(null); td.setShowCancelConfirm(true); },
      }] : []),
    ],
  }];
  const manageSummary = status === 'registration' && isPriv
    ? `Step ${current.index + 1} of ${steps.length}: ${current.step.label}${setupWaitingOnAdmin ? ' (admin)' : ''}`
    : manageSteps.find(s => s.current)?.label
      ?? 'Edit, invite and roles';
  const manageNote = status === 'completed' ? 'This tournament is completed: edits are locked.'
    : status === 'cancelled' ? 'This tournament was cancelled.'
    : null;

  // ── Status strip (active / completed) ──
  const currentStage = flowStages?.find(s => s.exists && s.completed < s.total) ?? null;
  // A tournament can be completed early (admin_complete_tournament leaves the
  // unplayed matches), so "All N" only when every match really was played.
  const allPlayed = playedCount >= playableMatches.length;
  const stripText = status === 'completed' && allPlayed
    ? `All ${playedCount} match${playedCount === 1 ? '' : 'es'} played`
    : `${status !== 'completed' && currentStage ? `${currentStage.label} · ` : ''}${playedCount} of ${playableMatches.length} played`;

  const wagerShown = WAGERS_ENABLED && live && approved.length > 0;
  const mlpPlayoff = isMlp && (tournament.mlp_play_format === 'round_robin_playoff' || tournament.mlp_play_format === 'pool_play_playoff');
  // Round robin / pool play rank the group stage only once a playoff exists
  // (standingsData), so they get MLP's title too. That includes a completed
  // one without settled ranks: its table is still the group stage, not a final.
  const standingsTitle = standings?.groupStage ? 'Group stage'
    : status === 'completed' ? 'Final standings'
    : isMlp && mlpPlayoff && playoffExists ? 'Group stage' : 'Standings';

  const teamsSummary = isMlp
    ? `${td.mlpTeams.length} team${td.mlpTeams.length === 1 ? '' : 's'} formed`
    : `${td.doublesPairs.filter(p => p.partner_1_id && p.partner_2_id).length} pair(s) formed`;
  const teamsSection = hasTeams && status !== 'cancelled' ? (
    <View ref={anchorRef('teams')} onLayout={anchorLayout('teams')}>
      <CollapsibleSection
        compact
        title={isMlp ? 'Teams' : 'Pairs'}
        open={teamsOpen}
        onToggle={() => toggle('teams', !teamsOpen, setTeamsOpenChoice)}
        // collapsedContent, not `summary`: a summary sits inside the toggle,
        // whose label replaces it for screen readers; this sibling is read.
        collapsedContent={teamsSummary}
      >
        {/* `bare`: the section header names the section, so the
            component's own title row is dropped. */}
        {needsPairs ? (
          <DoublesPairSection
            bare
            tournamentId={tournamentId}
            tournamentStatus={status}
            isPriv={isPriv}
            currentUserId={myUserId}
            approvedRegistrations={approved}
            onPairsChanged={() => td.load()}
          />
        ) : (
          <MlpTeamSection
            bare
            tournamentId={tournamentId}
            format={tournament.format as 'mlp' | 'mlp_random'}
            mlpPlayFormat={tournament.mlp_play_format}
            tournamentStatus={status}
            isPriv={isPriv}
            currentUserId={myUserId}
            approvedRegistrations={approved}
            bracketAlreadyGenerated={td.savedMatches.length > 0}
            onTeamsChanged={() => td.load()}
          />
        )}
      </CollapsibleSection>
    </View>
  ) : null;

  const playoffSection = mlpPlayoff && status !== 'cancelled' ? (
    <CollapsibleSection
      compact
      title="Playoff"
      open={playoffOpen}
      onToggle={() => toggle('playoff', !playoffOpen, setPlayoffOpenChoice)}
      collapsedContent={`Top ${tournament.mlp_playoff_teams ?? 4} teams advance`}
    >
      {/* `bare`: the "Playoff" header replaces its own title row. */}
      <MlpPlayoffPreview
        bare
        tournamentId={tournamentId}
        tournamentName={tournament.name}
        leagueId={tournament.league_id ?? ''}
        mlpPlayFormat={tournament.mlp_play_format as 'round_robin_playoff' | 'pool_play_playoff'}
        poolCount={tournament.mlp_pool_count ?? 2}
        playoffTeams={tournament.mlp_playoff_teams ?? 4}
        isAdmin={isPriv}
      />
    </CollapsibleSection>
  ) : null;

  const playersSection = (
    <PlayersSection
      navigation={navigation}
      tournament={tournament}
      tournamentId={tournamentId}
      rosterShown={rosterShown}
      isPriv={isPriv}
      open={playersOpen}
      onToggle={() => toggle('players', !playersOpen, setPlayersOpen)}
    />
  );

  const potSection = potShown ? (
    <CollapsibleSection
      compact
      title="Pot"
      // PicklePotCard is `bare` (no title row, no pool pill), so the header
      // carries the total while open; closed, the summary line has it.
      count={potOpen ? picklesLabel(pool) : undefined}
      open={potOpen}
      onToggle={() => toggle('pot', !potOpen, setPotOpen)}
      collapsedContent={<Text style={t.meta} numberOfLines={1} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>{potSummary}</Text>}
    >
      <PicklePotCard
        bare
        scopeType="tournament"
        scopeId={tournamentId}
        scopeLabel="Tournament"
        pool={pool}
        ante={ante}
        structure={structure}
        isAdmin={isPriv}
        canDistribute={status === 'completed'}
        members={approved.map(r => ({ id: r.user_id, full_name: r.profile?.full_name ?? 'Player' }))}
        onChange={() => td.load()}
      />
    </CollapsibleSection>
  ) : null;

  const wagerSection = wagerShown ? (
    <CollapsibleSection
      compact
      title="Wager market"
      open={td.wagerMarketOpen}
      onToggle={() => toggle('wager', !td.wagerMarketOpen, td.setWagerMarketOpen)}
      collapsedContent="Bet pickles on who finishes on the podium"
    >
      <WagerMarket
        tournament={tournament}
        tournamentId={tournamentId}
        approved={approved}
        wagerMarketShowAll={td.wagerMarketShowAll}
        setWagerMarketShowAll={td.setWagerMarketShowAll}
        wagerMarketSorted={td.wagerMarketSorted}
        setWagerSubject={td.setWagerSubject}
        setWagerOpen={td.setWagerOpen}
      />
    </CollapsibleSection>
  ) : null;

  return (
    <View style={[styles.root, { backgroundColor: c.bg }]}>
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={[styles.content, { paddingBottom: bottomInset }]}
        refreshControl={<AppRefreshControl {...td.refresh} />}
        onScroll={onScroll}
        scrollEventThrottle={32}
      >
        {/* 1 · Identity */}
        <View style={styles.block} onLayout={onIdentityLayout}>
          <TournamentIdentity
            tournament={tournament}
            approvedCount={approved.length}
            isFull={isFull}
            regClosed={regClosed}
            onOpenInfo={() => navigation.navigate('TournamentInfo', { tournamentId, tournamentName: tournament.name })}
            onEdit={isAdmin && (td.godmode || live) ? td.openEditModal : undefined}
          />
        </View>

        {/* 2 · You (the one Emphasis card). Always rendered as a wrapper so
            its anchor exists; empty for kinds with no card. */}
        <View ref={anchorRef('you')} style={view ? styles.block : null} onLayout={anchorLayout('you')}>
          {view ? <TournamentYouCard view={view} /> : null}
        </View>

        {/* collapsable={false}: Android would flatten a style-less wrapper
            away, leaving nothing to measure. */}
        <View ref={anchorRef('banner')} collapsable={false}>
          <StatusBanner status={td.status.value} style={styles.banner} />
        </View>

        {/* 3 · Status strip: the stage and how much is played */}
        {scheduleExists && (
          <View style={styles.block}>
            <Panel padded={false}>
              <TouchableOpacity
                style={styles.strip}
                onPress={() => openSchedule?.()}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={`${stripText}. Open the schedule`}
              >
                <Text style={[t.sub, styles.stripText, { color: c.text }]} numberOfLines={1}>{stripText}</Text>
                <Icon name="chevron-right" size={16} color={c.textMuted} />
              </TouchableOpacity>
            </Panel>
          </View>
        )}

        {status === 'registration' ? (
          <>
            {teamsSection}
            {playoffSection}
            {playersSection}
            {potSection}
            {wagerSection}
          </>
        ) : (
          <>
            {/* Flow strip: each stage card filters the schedule to its round */}
            {flowStages && flowStages.length > 1 && (
              <View style={styles.block}>
                <SectionCard title="Stages">
                  <TournamentFlowOverview
                    stages={flowStages}
                    selectedKey={scheduleFilter.roundId}
                    onPressStage={(key) => {
                      const next = scheduleFilter.roundId === key ? null : key;
                      setScheduleFilter({ ...scheduleFilter, roundId: next });
                      if (next) openSchedule?.();
                    }}
                  />
                </SectionCard>
              </View>
            )}

            {/* Standings for every format, your row pinned */}
            {standings && (
              <View ref={anchorRef('standings')} style={styles.block} onLayout={anchorLayout('standings')}>
                <StandingsSection data={standings} title={standingsTitle} />
              </View>
            )}

            {/* Classic 2-pool tree (renders nothing for other shapes) */}
            {(status === 'active' || status === 'completed') && tournament.format === 'pool_play' && td.savedRounds.length > 0 && (
              <View style={styles.block}>
                <PoolPlayBracketSection
                  tournament={tournament}
                  myUserId={myUserId}
                  savedRounds={td.savedRounds}
                  savedMatches={td.savedMatches}
                  profileNames={td.profileNames}
                  openMatchActionSheetById={td.openMatchActionSheetById}
                />
              </View>
            )}

            {playoffSection}

            {/* Schedule */}
            {scheduleExists && (
              <View ref={anchorRef('schedule')} style={styles.block} onLayout={anchorLayout('schedule')}>
                <MatchScheduleSection
                  navigation={navigation}
                  tournament={tournament}
                  myUserId={myUserId}
                  isPriv={isPriv}
                  upcomingStages={upcomingStages}
                  filter={scheduleFilter}
                  setFilter={setScheduleFilter}
                  onOpenHistory={() => navigation.navigate('TournamentMatchHistory', {
                    tournamentId,
                    title: `${tournament.name} History`,
                  })}
                  savedMatches={td.savedMatches}
                  savedRounds={td.savedRounds}
                  playerName={td.playerName}
                  openMatchActionSheet={td.openMatchActionSheet}
                />
              </View>
            )}

            {teamsSection}
            {playersSection}
            {potSection}
            {wagerSection}
          </>
        )}

        {/* Photos: the tournament's shared album (hidden unless you're in it). */}
        <AlbumSection kind="tournament" id={tournamentId} />

        {/* 6 · Manage (organizers; the developer account's tools) */}
        {manageShown && (
          <View ref={anchorRef('manage')} onLayout={anchorLayout('manage')}>
            <TournamentManageSection
              open={manageOpen}
              onToggle={(next) => toggle('manage', next, setManageOpen)}
              summary={manageSummary}
              note={manageNote}
              steps={manageSteps}
              groups={manageGroups}
              developer={td.godmode ? (
                <GodmodePanel
                  tournament={tournament}
                  generatedMatches={td.generatedMatches}
                  locking={td.locking}
                  doLockIn={td.doLockIn}
                  simulating={td.simulating}
                  simulateFillMatches={td.simulateFillMatches}
                  deleteTournament={td.deleteTournament}
                  godmodeApproveAllInvitees={td.godmodeApproveAllInvitees}
                  godmodeForceCreateTeams={td.godmodeForceCreateTeams}
                  godmodeAutoGeneratePreview={td.godmodeAutoGeneratePreview}
                />
              ) : undefined}
            />
          </View>
        )}
      </ScrollView>

      {/* Last child of the root, outside the ScrollView: the bar is absolutely
          positioned and publishes its height to the bottom chrome slot, which
          lifts PlayIsland above it and pads the list (bottomInset). */}
      <StickyActionBar
        // It sits above the room the navigator keeps clear: its edge counts from the window bottom.
        bottomOffset={navReserve}
        style={navReserve > 0 ? { paddingBottom: SPACE.sm } : undefined}
        visible={stickyVisible && !!stickyPrimary}
        active={isFocused}
        summary={tournament.name}
        primary={stickyPrimary ?? undefined}
        secondary={stickySecondary}
      />

      {shareData ? (
        <FinishShareStudio visible={shareOpen} onClose={() => setShareOpen(false)} data={shareData} />
      ) : null}

      {/* ── Bracket release time picker ── */}
      <AppDateTimePicker
        visible={td.showReleasePicker}
        value={tournament.bracket_release_time ? new Date(tournament.bracket_release_time) : new Date(Date.now() + 86400000)}
        minimumDate={new Date()}
        onChange={td.saveBracketReleaseTime}
        onClose={() => td.setShowReleasePicker(false)}
      />

      {/* ── Edit tournament modal ── */}
      <EditTournamentModal
        showEditModal={td.showEditModal}
        setShowEditModal={td.setShowEditModal}
        saveTournamentEdits={td.saveTournamentEdits}
        editError={td.editError}
        savingEdit={td.savingEdit}
        editName={td.editName} setEditName={td.setEditName}
        editDesc={td.editDesc} setEditDesc={td.setEditDesc}
        editLocation={td.editLocation} setEditLocation={td.setEditLocation}
        editMinPlayers={td.editMinPlayers} setEditMinPlayers={td.setEditMinPlayers}
        editMaxPlayers={td.editMaxPlayers} setEditMaxPlayers={td.setEditMaxPlayers}
        editStartTime={td.editStartTime} setEditStartTime={td.setEditStartTime}
        editLengthHours={td.editLengthHours} setEditLengthHours={td.setEditLengthHours}
        editAnte={td.editAnte} setEditAnte={td.setEditAnte}
        editPayout={td.editPayout} setEditPayout={td.setEditPayout}
        editSeeding={td.editSeeding} setEditSeeding={td.setEditSeeding}
        showStartPicker={td.showStartPicker} setShowStartPicker={td.setShowStartPicker}
      />

      <ConfirmModal
        visible={td.showLockInConfirm}
        title="Lock in bracket?"
        body={`This finalizes the schedule and notifies all ${approved.length} member${approved.length === 1 ? '' : 's'}. You won't be able to regenerate after this.`}
        primaryLabel="Lock In & Notify"
        variant="danger"
        busy={td.locking}
        error={td.lockInError}
        onConfirm={() => td.doLockIn()}
        onClose={() => td.setShowLockInConfirm(false)}
      />

      <ConfirmModal
        visible={td.showCompleteConfirm}
        title="Complete tournament?"
        body="This flips the tournament status to completed. Players can no longer record matches. Payout becomes available."
        primaryLabel="Complete"
        variant="danger"
        busy={td.completing}
        error={td.completeError}
        onConfirm={() => td.confirmCompleteTournament()}
        onClose={() => td.setShowCompleteConfirm(false)}
      />

      <ConfirmModal
        visible={td.showCancelConfirm}
        title={`Cancel "${tournament.name}"?`}
        body="This refunds every ante, pot contribution and open wager to its owner, notifies all participants, and permanently marks the tournament cancelled. Matches already played keep their rating effects."
        primaryLabel="Cancel & Refund Everyone"
        variant="danger"
        busy={td.cancelling}
        error={td.cancelError}
        onConfirm={td.confirmCancelTournament}
        onClose={() => td.setShowCancelConfirm(false)}
      />

      <ConfirmModal
        visible={td.showDeleteConfirm}
        title={`Delete "${tournament.name}"?`}
        body="This permanently removes the tournament and all of its rounds, matches, registrations, and partner requests. This cannot be undone."
        primaryLabel="Delete Tournament"
        variant="danger"
        busy={td.deleting}
        error={td.deleteError}
        onConfirm={td.confirmDeleteTournament}
        onClose={() => td.setShowDeleteConfirm(false)}
      />

      <PayoutPreviewModal
        visible={td.showPayoutModal}
        tournamentId={tournamentId}
        prizePool={pool}
        onClose={() => td.setShowPayoutModal(false)}
        onPaid={() => { td.setShowPayoutModal(false); td.load(); }}
      />

      <WagerModals
        actionSheetOpen={td.actionSheetOpen}
        setActionSheetOpen={td.setActionSheetOpen}
        wagerMatchPick={td.wagerMatchPick}
        setWagerMatchPick={td.setWagerMatchPick}
        openMatchWager={td.openMatchWager}
        exactScoreOpen={td.exactScoreOpen}
        setExactScoreOpen={td.setExactScoreOpen}
        exactScoreError={td.exactScoreError}
        setExactScoreError={td.setExactScoreError}
        submitExactScore={td.submitExactScore}
        exactScoreT1={td.exactScoreT1}
        setExactScoreT1={td.setExactScoreT1}
        exactScoreT2={td.exactScoreT2}
        setExactScoreT2={td.setExactScoreT2}
        wagerOpen={td.wagerOpen}
        setWagerOpen={td.setWagerOpen}
        wagerSubject={td.wagerSubject}
        setWagerSubject={td.setWagerSubject}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  // The screen gutter (SPACE.lg) on every side; sections stack with SPACE.md.
  content: { padding: SPACE.lg },
  block: { marginBottom: SPACE.md },
  banner: { marginBottom: SPACE.md },
  strip: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingHorizontal: SPACE.md },
  stripText: { flex: 1, minWidth: 0 },
});
