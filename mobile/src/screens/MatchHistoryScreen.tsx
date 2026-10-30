import React, { useEffect, useState, useMemo, useRef } from 'react';
import { View, Text, FlatList, StyleSheet, Pressable } from 'react-native';
import { RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
// Aliased: this screen already has a `currentUserId` state variable, which would
// otherwise shadow the helper.
import { sbCall, currentUserId as readCurrentUserId, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import {
  ListCard,
  Badge,
  ErrorState,
  SectionHeader,
  FilterSheet,
  FilterChipRow,
  FilterPill,
  FilterSearchField,
  ActiveFilterChips,
  countActiveFilters,
  removeFilterValue,
  resetFilters,
  type FilterSheetGroup,
  type FilterValues,
} from '@just-messin-around/expo-foundation/ui';
import { Button, KeyboardTextInput } from '@just-messin-around/expo-foundation/forms';
import { Icon, type IconName } from '@just-messin-around/expo-foundation/icons';
import { SPACE, RADIUS, HAIRLINE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { Match, RootStackParamList } from '../types';
import { useTheme } from '../lib/ThemeContext';
import { useRefresh } from '../lib/useRefresh';
import AppRefreshControl from '../components/AppRefreshControl';
import { SkeletonList } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';
import StatusBanner from '../components/StatusBanner';
import { displayCourtName } from '../lib/courtNickname';
import { useStatusMessage } from '../lib/useStatusMessage';
import ActionSheetModal from '../components/ActionSheetModal';
import ConfirmModal from '../components/ConfirmModal';
import FlairName from '../components/FlairName';
// Resolves once Unit 1 (wager foundation) merges to master.
import WagerProposeModal from '../components/WagerProposeModal';
import { WAGERS_ENABLED } from '../lib/features';
import type { WagerSubject } from '../lib/wager';
import type { Profile } from '../types';
import { noteGoodMoment } from '../lib/ratingPrompt';
import { explainRefusal } from '../lib/refusalNotices';
import { confirmResultMessage } from '../lib/refusals';
import { entityIcon, joinFacts } from '../lib/entityGlyph';
import { isImageShareAvailable } from '@just-messin-around/expo-foundation/platform';
import PickleShareStudio from '../components/share/PickleShareStudio';
import { matchCardModel, type ShareCardModel } from '../lib/shareCards';
import { cardPlayer, shortName } from '../lib/finishShare';
import { useBlockedIds } from '../lib/moderation';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'MatchHistory'>;
  route: RouteProp<RootStackParamList, 'MatchHistory'>;
};

// A match row plus the league / tournament it was recorded under. The embeds
// are read-only joins on matches.league_id (NOT NULL) and matches.tournament_id
// (an optional display-only tag, migration_matches_tournament_tag.sql); both
// tables are `select using (true)`, so RLS allows them for every viewer.
type HistoryMatch = Match & {
  tournament_id?: string | null;
  league?: { id: string; name: string } | null;
  tournament?: { id: string; name: string } | null;
};

// ── Filters ─────────────────────────────────────────────────────────────
// Every filter lives in one FilterValues record so the foundation FilterSheet,
// ActiveFilterChips and the pure helpers (count / remove / reset) all read the
// same state. null = off. "Mine" is the one quick chip on the row itself.
//
// Filter-pill convention: the league / tournament chip on each card ships with
// the League and Tournament groups here. They replace the old Region pill
// (5 hard-coded Bay Area boxes in the now-deleted lib/regions.ts), which no
// card displayed.
const FILTER_DEFAULTS: FilterValues = {
  player: null,
  recency: null,
  homeAway: null,
  matchType: null,
  doublesCategory: null,
  indoorOutdoor: null,
  league: null,
  tournament: null,
};

// Card-height budget: a compact card is 56-62 at the default text size, and the
// plan's hard cap for match cards is 72. Used as the scroll estimate too.
const MATCH_ROW_ESTIMATE = 66;

/** Pre-applied filters from the route (a PLUPR facet on Home, a push). */
function initialFilters(p: RootStackParamList['MatchHistory'] | undefined): FilterValues {
  return {
    ...FILTER_DEFAULTS,
    matchType: p?.initialMatchType ?? null,
    doublesCategory: p?.initialDoublesCategory ?? null,
  };
}

/** "Oct 3", or "Oct 3, 2025" outside the current year. */
function shortDate(iso: string): string {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
}

type WagerRowCtx = {
  matchId: string;
  team1Label: string;
  team2Label: string;
};

// Renders a 1-or-2-player team with each player's FlairName styling (list mode).
// Falls back to plain "Player" when a profile is missing. Designed to be
// embedded inside a parent <Text>, which carries the text style + numberOfLines.
// TODO: smoke-test in browser — list mode FlairName wire-up
function TeamFlair({
  player,
  partner,
  textStyle,
}: {
  player?: Partial<Profile> | null;
  partner?: Partial<Profile> | null;
  textStyle?: any;
}) {
  if (!player) return <Text style={textStyle}>Player</Text>;
  const playerEl = (
    <FlairName
      name={player.full_name ?? '?'}
      nameColor={player.name_color}
      styleId={player.list_name_style_id ?? null}
      mode="list"
      style={textStyle}
    />
  );
  if (!partner?.full_name) return playerEl;
  return (
    <Text style={textStyle}>
      {playerEl}
      {' & '}
      <FlairName
        name={partner.full_name}
        nameColor={partner.name_color}
        styleId={partner.list_name_style_id ?? null}
        mode="list"
        style={textStyle}
      />
    </Text>
  );
}

export default function MatchHistoryScreen({ navigation, route }: Props) {
  // Defensive: the web path /matches can arrive with no params at all.
  const params = route.params ?? ({ title: 'Match History' } as RootStackParamList['MatchHistory']);
  const { leagueId, userId, initialMyMatchesOnly, highlightMatchId } = params;
  const { colors } = useTheme();
  const S = makeStyles(colors);
  const t = textStyles(colors);
  const [matches, setMatches]       = useState<HistoryMatch[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [loading, setLoading]       = useState(true);
  // Set when a fetch fails. Distinguishes "no matches recorded yet" from
  // "couldn't reach the server" — the same empty view used to serve both.
  const [loadError, setLoadError]   = useState<unknown>(null);
  // Filters start COLLAPSED, always. Pre-applied route filters (the match/
  // push sets "Mine"; Home's facet tiles set a type) show as removable chips
  // on the one-line filter row instead of opening the ~500px panel, which
  // used to push the push's highlighted match below the fold.
  const [sheetOpen, setSheetOpen]   = useState(false);
  const [filters, setFilters]       = useState<FilterValues>(() => initialFilters(params));
  const [myMatchesOnly, setMyMatchesOnly] = useState(!!initialMyMatchesOnly);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  // Deep-link highlight: when arriving from a match-confirm notification, scroll
  // to that match and tint it so the inline Confirm control jumps out. The
  // highlight clears after a couple seconds.
  const listRef = useRef<FlatList<HistoryMatch>>(null);
  // Tracks the highlightMatchId we've already auto-scrolled to, so later filter
  // edits don't re-yank the viewport. `filteredRef` always holds the latest
  // filtered list so deferred scrolls recompute a fresh (never stale) index.
  const scrolledForRef = useRef<string | null>(null);
  const filteredRef = useRef<HistoryMatch[]>([]);
  const [highlightedId, setHighlightedId] = useState<string | null>(highlightMatchId ?? null);

  const status = useStatusMessage();
  const refresh = useRefresh(loadMatches);

  // wagerCtx is the row the user opened the menu for; team labels are frozen
  // there so the UI stays stable if `matches` reloads mid-flow.
  const [wagerCtx, setWagerCtx] = useState<WagerRowCtx | null>(null);
  const [wagerSheetOpen, setWagerSheetOpen] = useState(false);
  const [scoreInput, setScoreInput] = useState<{ t1: string; t2: string } | null>(null);
  const [wagerSubject, setWagerSubject] = useState<WagerSubject | null>(null);

  // ── Share this match (PKL-013): my completed matches, on a binary that can share an image ──
  const blocked = useBlockedIds();
  const canShareImage = isImageShareAvailable();
  const [shareModel, setShareModel] = useState<ShareCardModel | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  function openShare(item: HistoryMatch, me: string) {
    const onTeam1 = isOnTeam1(item, me);
    const asPlayer = (p: { id: string; full_name: string | null; deleted_at?: string | null } | null | undefined) =>
      p ? cardPlayer({ id: p.id, fullName: p.full_name, deleted: !!p.deleted_at }, blocked) : null;
    const meP = onTeam1 ? (item.player1_id === me ? item.player1 : item.partner1) : (item.player2_id === me ? item.player2 : item.partner2);
    const partner = onTeam1 ? (item.player1_id === me ? item.partner1 : item.player1) : (item.player2_id === me ? item.partner2 : item.player2);
    const opps = (onTeam1 ? [item.player2, item.partner2] : [item.player1, item.partner1])
      .map(asPlayer)
      .filter((p): p is NonNullable<typeof p> => !!p);
    setShareModel(matchCardModel({
      doubles: item.match_type === 'doubles',
      won: didWin(item, me),
      myScore: (onTeam1 ? item.player1_score : item.player2_score) ?? 0,
      oppScore: (onTeam1 ? item.player2_score : item.player1_score) ?? 0,
      me: shortName(meP?.full_name),
      partner: item.match_type === 'doubles' ? asPlayer(partner) : null,
      opponents: opps,
      pluprDelta: ratingChange(item, me),
      court: item.location_name ? displayCourtName(item.location_name) : null,
      date: shortDate(item.played_at),
      scope: item.tournament?.name ?? item.league?.name ?? null,
    }));
    setShareOpen(true);
  }

  function openWagerSheet(ctx: WagerRowCtx) {
    setWagerCtx(ctx);
    setWagerSheetOpen(true);
  }

  function startWinnerWager(pickedTeam: 'team1' | 'team2') {
    if (!wagerCtx) return;
    setWagerSubject({
      type: 'match',
      matchId: wagerCtx.matchId,
      teamLabels: { team1: wagerCtx.team1Label, team2: wagerCtx.team2Label },
      pickedTeam,
    });
  }

  function confirmScoreWager() {
    if (!wagerCtx || !scoreInput) return;
    const t1 = parseInt(scoreInput.t1, 10);
    const t2 = parseInt(scoreInput.t2, 10);
    if (!Number.isFinite(t1) || !Number.isFinite(t2) || t1 < 0 || t2 < 0) {
      status.error('Enter valid scores for both teams.');
      return;
    }
    setWagerSubject({
      type: 'match_score',
      matchId: wagerCtx.matchId,
      team1Score: t1,
      team2Score: t2,
      teamLabels: { team1: wagerCtx.team1Label, team2: wagerCtx.team2Label },
    });
    setScoreInput(null);
  }

  useEffect(() => {
    // Local session read — the old getUser() round trip silently resolved to
    // null offline, which flipped every card to the "not my match" perspective.
    readCurrentUserId(supabase).then(setCurrentUserId).catch(() => setCurrentUserId(null));
    loadMatches();
  }, []);

  async function loadMatches() {
    try {
      const data = await sbCall(() => {
        let query = supabase
          .from('matches')
          .select(`
            *,
            player1:profiles!matches_player1_id_fkey(id, full_name, name_color, list_name_style_id, deleted_at),
            partner1:profiles!matches_partner1_id_fkey(id, full_name, name_color, list_name_style_id, deleted_at),
            player2:profiles!matches_player2_id_fkey(id, full_name, name_color, list_name_style_id, deleted_at),
            partner2:profiles!matches_partner2_id_fkey(id, full_name, name_color, list_name_style_id, deleted_at),
            league:leagues(id, name),
            tournament:tournaments(id, name)
          `)
          .order('played_at', { ascending: false });
        if (leagueId) query = query.eq('league_id', leagueId);
        return query;
      });

      let results = (data ?? []) as HistoryMatch[];

      // Filter to only matches involving the target player (including as a doubles partner)
      if (userId) {
        results = results.filter((m) =>
          m.player1_id === userId || m.player2_id === userId ||
          m.partner1_id === userId || m.partner2_id === userId
        );
      }

      setMatches(results);
      setLoadError(null);
    } catch (e) {
      // Leave `matches` alone: a refresh that dies in a dead zone must not
      // empty the history the user was reading.
      setLoadError(e);
    } finally {
      setLoading(false);
    }
  }

  function isOnTeam1(match: Match, uid: string) {
    return match.player1_id === uid || match.partner1_id === uid;
  }

  async function confirmMatch(matchId: string) {
    // One confirm at a time: a second tap while the RPC is in flight would
    // post the same confirmation twice.
    if (confirmingId) return;
    setConfirmingId(matchId);
    const deadline = matches.find((m) => m.id === matchId)?.confirm_deadline ?? null;
    try {
      // Not retried (a retried confirm would read as "already"), but bounded.
      const res = await sbCall(() => supabase.rpc('confirm_match', { p_match_id: matchId }), {
        retries: 0,
        timeoutMs: 15_000,
      });
      // What the confirm did: settled it, or the other team still has to
      // (and by when), or my team had already (rule 11: say which).
      status.success(confirmResultMessage(typeof res === 'string' ? res : 'completed', deadline));
      if (res !== 'already_your_team') noteGoodMoment(); // a settled result is a good moment (rating prompt)
      loadMatches();
    } catch (e) {
      // Why, then what to do: it expired and was removed, it was already
      // confirmed, too late, not a player (lib/refusals).
      status.error(explainRefusal(e, "Couldn't confirm the match. Try again.", { action: 'confirm' }));
      // A match that's gone or settled shouldn't keep its Confirm button.
      loadMatches();
    } finally {
      setConfirmingId(null);
    }
  }

  function didWin(match: Match, uid: string) {
    return isOnTeam1(match, uid) ? match.winner_team === 'team1' : match.winner_team === 'team2';
  }

  function ratingChange(match: Match, uid: string): number | null {
    const onTeam1 = isOnTeam1(match, uid);
    const before = onTeam1 ? match.player1_rating_before : match.player2_rating_before;
    const after  = onTeam1 ? match.player1_rating_after  : match.player2_rating_after;
    if (before == null || after == null) return null;
    return after - before;
  }

  function teamNames(item: Match): { team1: string; team2: string } {
    const isDoubles = item.match_type === 'doubles';
    const team1 = isDoubles && item.partner1?.full_name
      ? `${item.player1?.full_name ?? '?'} & ${item.partner1.full_name}`
      : (item.player1?.full_name ?? 'Team 1');
    const team2 = isDoubles && item.partner2?.full_name
      ? `${item.player2?.full_name ?? '?'} & ${item.partner2.full_name}`
      : (item.player2?.full_name ?? 'Team 2');
    return { team1, team2 };
  }

  // The card's league / tournament chip. A tournament tag is the more specific
  // of the two, so it wins; on a league-scoped history every row would repeat
  // the same league, so the league chip is left off there. `shrink`: a long
  // name ellipsizes inside the chip's slot (metaChip) instead of overflowing it.
  function scopeChip(item: HistoryMatch) {
    if (item.tournament?.name) {
      return <Badge shrink iconName={entityIcon('tournament')} label={item.tournament.name} tone="warning" maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE} />;
    }
    if (!leagueId && item.league?.name) {
      return <Badge shrink iconName={entityIcon('league')} label={item.league.name} tone="brand" maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE} />;
    }
    return null;
  }

  /** Line 2 of every card: [scope chip] facts, one line, ellipsized. Pending
   *  cards pass chip: false, so the chip can't squeeze the countdown out of view. */
  function metaLine(item: HistoryMatch, facts: string, opts?: { chip?: boolean }) {
    const chip = opts?.chip === false ? null : scopeChip(item);
    if (!chip && !facts) return undefined;
    return (
      <View style={S.metaLine}>
        {chip ? <View style={S.metaChip}>{chip}</View> : null}
        {facts ? <Text style={[t.sub, S.metaText]} numberOfLines={1}>{facts}</Text> : null}
      </View>
    );
  }

  // The descriptive tags that used to be three stacked badges, now facts on the
  // meta line. Unknown / unspecified values are left out (content rule 3); the
  // filter sheet can still find them. Words, not glyphs: the line is one
  // ellipsized sentence (the sheet's Home / Away / Indoor / Outdoor pills
  // carry the glyphs).
  function tagFacts(item: Match): (string | null)[] {
    return [
      item.is_home_court == null ? null : item.is_home_court ? 'Home' : 'Away',
      item.is_outdoor === true ? 'Outdoor' : item.is_outdoor === false ? 'Indoor' : null,
      item.match_type === 'doubles' && item.doubles_category === 'mixed' ? 'Mixed' : null,
      item.match_type === 'doubles' && item.doubles_category === 'gendered' ? 'Gendered' : null,
    ];
  }

  // Plain render helpers (not components declared in render), so a re-render
  // updates these in place instead of remounting them.
  function wagerMenu(item: Match) {
    if (!WAGERS_ENABLED) return null;
    const names = teamNames(item);
    return (
      <Pressable
        style={({ pressed }) => [S.menuBox, pressed && S.pressed]}
        accessibilityRole="button"
        accessibilityLabel="Wager options"
        onPress={() => openWagerSheet({ matchId: item.id, team1Label: names.team1, team2Label: names.team2 })}
      >
        <Icon name="more" size={20} color={colors.textSub} />
      </Pressable>
    );
  }

  /** The card's leading tile: W / L as a letter, pending / upcoming as a glyph. */
  function tile(label: string | { iconName: IconName }, tone: 'win' | 'loss' | 'pending' | 'upcoming', a11yLabel?: string) {
    const bg = tone === 'win' ? colors.primary
      : tone === 'loss' ? colors.danger
      : tone === 'pending' ? colors.warningLight
      : colors.infoLight;
    const fg = tone === 'win' || tone === 'loss' ? colors.textInverse
      : tone === 'pending' ? colors.warning
      : colors.info;
    // W/L is the card's only result cue for screen readers (the card isn't
    // pressable, so nothing else announces it). Glyph tiles stay decorative:
    // the pending state is spelled out on the meta line.
    const a11y = a11yLabel
      ? { accessible: true, accessibilityRole: 'text' as const, accessibilityLabel: a11yLabel }
      : { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const };
    return (
      <View style={[S.tile, { backgroundColor: bg }]} {...a11y}>
        {typeof label === 'string' ? (
          <Text style={[S.tileText, { color: fg }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>{label}</Text>
        ) : (
          <Icon name={label.iconName} size={16} color={fg} />
        )}
      </View>
    );
  }

  function renderUpcoming(item: HistoryMatch) {
    const isDoubles = item.match_type === 'doubles';
    let when: string | null = null;
    if (item.scheduled_at) {
      const d = new Date(item.scheduled_at);
      when = `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} · ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
    }
    return (
      <ListCard
        key={item.id}
        density="compact"
        leading={tile({ iconName: entityIcon('season') }, 'upcoming')}
        title={
          <Text style={t.title} numberOfLines={1}>
            <TeamFlair player={item.player1} partner={isDoubles ? item.partner1 : null} textStyle={t.title} />
            {' vs '}
            <TeamFlair player={item.player2} partner={isDoubles ? item.partner2 : null} textStyle={t.title} />
          </Text>
        }
        subtitle={metaLine(item, joinFacts([when, item.location_name ? displayCourtName(item.location_name) : null]))}
        trailing={WAGERS_ENABLED ? wagerMenu(item) : undefined}
      />
    );
  }

  function renderMatch({ item }: { item: HistoryMatch }) {
    // Determine perspective: userId param wins, then fall back to logged-in user IF they're in this match
    const inMatch = (uid: string) =>
      item.player1_id === uid || item.player2_id === uid ||
      item.partner1_id === uid || item.partner2_id === uid;

    const viewAs = userId ?? (currentUserId && inMatch(currentUserId) ? currentUserId : null);

    // Tint on the deep-linked match (cleared after a couple seconds).
    const isHighlighted = item.id === highlightedId;
    const isDoubles = item.match_type === 'doubles';
    const court = item.location_name ? displayCourtName(item.location_name) : null;

    // Pending match — a Confirm button when the viewer's team hasn't confirmed
    // yet. PLUPRs aren't applied until both teams sign off.
    if (item.status === 'pending') {
      const team1Done = !!item.team1_confirmed_by;
      const team2Done = !!item.team2_confirmed_by;
      const callerOnTeam1 = !!currentUserId && (currentUserId === item.player1_id || currentUserId === item.partner1_id);
      const callerOnTeam2 = !!currentUserId && (currentUserId === item.player2_id || currentUserId === item.partner2_id);
      const myTeamConfirmed = (callerOnTeam1 && team1Done) || (callerOnTeam2 && team2Done);
      const canCallerConfirm = (callerOnTeam1 && !team1Done) || (callerOnTeam2 && !team2Done);

      // Deadline countdown
      let deadlineLabel: string | null = null;
      if (item.confirm_deadline) {
        const msLeft = new Date(item.confirm_deadline).getTime() - Date.now();
        if (msLeft > 0) {
          const m = Math.max(1, Math.round(msLeft / 60000));
          deadlineLabel = m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m left` : `${m}m left`;
        } else {
          deadlineLabel = 'expired';
        }
      }

      // Short on purpose: the meta line is one ellipsized line beside the
      // Confirm button. Viewers outside the match get the real per-team state
      // (the recorder's team usually confirms at insert).
      const stateLabel = canCallerConfirm
        ? 'Confirm needed'
        : myTeamConfirmed
          ? 'Waiting on other team'
          : `Team 1 ${team1Done ? 'confirmed' : 'waiting'} · Team 2 ${team2Done ? 'confirmed' : 'waiting'}`;
      // An unconfirmed match is dropped after an hour, so the countdown leads
      // the line and survives truncation.
      const deadlineFact = deadlineLabel === 'expired' ? 'Expired' : deadlineLabel;

      return (
        <ListCard
          density="compact"
          highlighted={isHighlighted}
          leading={tile({ iconName: 'hourglass' }, 'pending')}
          title={
            <Text style={t.title} numberOfLines={1}>
              <TeamFlair player={item.player1} partner={isDoubles ? item.partner1 : null} textStyle={t.title} />
              {' vs '}
              <TeamFlair player={item.player2} partner={isDoubles ? item.partner2 : null} textStyle={t.title} />
            </Text>
          }
          subtitle={metaLine(item, joinFacts([deadlineFact, stateLabel, `${item.player1_score}–${item.player2_score}`]), { chip: false })}
          trailing={
            canCallerConfirm || WAGERS_ENABLED ? (
              <View style={S.trailingRow}>
                {canCallerConfirm ? (
                  <Button
                    size="sm"
                    title="Confirm"
                    onPress={() => confirmMatch(item.id)}
                    loading={confirmingId === item.id}
                    disabled={confirmingId != null}
                  />
                ) : null}
                {wagerMenu(item)}
              </View>
            ) : undefined
          }
          style={canCallerConfirm ? S.actionCard : undefined}
        />
      );
    }

    // League-wide view — always show who won so every card has a result indicator
    if (!viewAs) {
      const team1Won = item.winner_team === 'team1';
      return (
        <ListCard
          density="compact"
          highlighted={isHighlighted}
          leading={tile(team1Won ? 'W' : 'L', team1Won ? 'win' : 'loss', team1Won ? 'Team 1 won' : 'Team 2 won')}
          title={
            <Text style={[t.title, S.loserName]} numberOfLines={1}>
              <TeamFlair player={item.player1} partner={isDoubles ? item.partner1 : null} textStyle={[t.title, team1Won ? S.winnerName : S.loserName]} />
              {' vs '}
              <TeamFlair player={item.player2} partner={isDoubles ? item.partner2 : null} textStyle={[t.title, !team1Won ? S.winnerName : S.loserName]} />
            </Text>
          }
          subtitle={metaLine(item, joinFacts([
            shortDate(item.played_at),
            isDoubles ? 'Doubles' : 'Singles',
            court,
            ...tagFacts(item),
          ]))}
          trailing={<Text style={S.score}>{item.player1_score}–{item.player2_score}</Text>}
        />
      );
    }

    const won      = didWin(item, viewAs);
    const onTeam1  = isOnTeam1(item, viewAs);
    const myScore  = onTeam1 ? item.player1_score : item.player2_score;
    const oppScore = onTeam1 ? item.player2_score : item.player1_score;
    const delta    = ratingChange(item, viewAs);

    // Opponents (both for doubles) on the title; your partner on the meta line.
    const oppPlayer  = onTeam1 ? item.player2  : item.player1;
    const oppPartner = onTeam1 ? item.partner2 : item.partner1;
    const myPartner = onTeam1 ? item.partner1 : item.partner2;

    return (
      <ListCard
        density="compact"
        highlighted={isHighlighted}
        leading={tile(won ? 'W' : 'L', won ? 'win' : 'loss', won ? 'Win' : 'Loss')}
        title={
          <Text style={t.title} numberOfLines={1}>
            {'vs '}
            <TeamFlair player={oppPlayer} partner={isDoubles ? oppPartner : null} textStyle={t.title} />
          </Text>
        }
        subtitle={metaLine(item, joinFacts([
          shortDate(item.played_at),
          isDoubles && myPartner?.full_name ? `with ${myPartner.full_name}` : null,
          court,
          ...tagFacts(item),
        ]))}
        trailing={
          <View style={S.trailingRow}>
            <View style={S.scoreCol}>
              <Text style={S.score}>{myScore}–{oppScore}</Text>
              {delta != null && (
                <Text style={[S.delta, { color: delta >= 0 ? colors.primary : colors.danger }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
                  {delta >= 0 ? '+' : ''}{delta.toFixed(2)}
                </Text>
              )}
            </View>
            {canShareImage && viewAs === currentUserId && item.status === 'completed' ? (
              <Pressable
                style={({ pressed }) => [S.menuBox, pressed && S.pressed]}
                accessibilityRole="button"
                accessibilityLabel="Share this match"
                onPress={() => openShare(item, viewAs)}
              >
                <Icon name="share" size={18} color={colors.primary} />
              </Pressable>
            ) : null}
          </View>
        }
      />
    );
  }

  // League / tournament options come from the matches themselves, with counts,
  // so the sheet never offers a choice that matches nothing.
  const scopeOptions = useMemo(() => {
    const leagues = new Map<string, { label: string; count: number }>();
    const tourns = new Map<string, { label: string; count: number }>();
    for (const m of matches) {
      if (m.league?.id) {
        const e = leagues.get(m.league.id) ?? { label: m.league.name, count: 0 };
        e.count += 1;
        leagues.set(m.league.id, e);
      }
      if (m.tournament?.id) {
        const e = tourns.get(m.tournament.id) ?? { label: m.tournament.name, count: 0 };
        e.count += 1;
        tourns.set(m.tournament.id, e);
      }
    }
    const toOptions = (map: Map<string, { label: string; count: number }>) =>
      [...map.entries()]
        .map(([value, e]) => ({ value, label: e.label, count: e.count }))
        .sort((a, b) => a.label.localeCompare(b.label));
    return { leagues: toOptions(leagues), tournaments: toOptions(tourns) };
  }, [matches]);

  const filterGroups = useMemo<FilterSheetGroup[]>(() => {
    const groups: FilterSheetGroup[] = [
      {
        key: 'player',
        title: 'Player name',
        kind: 'custom',
        render: ({ value, setValue }) => (
          <FilterSearchField
            size="sm"
            value={typeof value === 'string' ? value : ''}
            onChangeText={(text) => setValue(text ? text : null)}
            placeholder="Search by player name…"
            autoCorrect={false}
            autoCapitalize="words"
            returnKeyType="search"
            clearAccessibilityLabel="Clear player name search"
          />
        ),
      },
      {
        key: 'recency',
        title: 'Played',
        kind: 'single',
        options: [
          { value: '3', label: 'Last 3 days' },
          { value: '7', label: 'Last 7 days' },
          { value: '30', label: 'Last 30 days' },
          { value: '90', label: 'Last 90 days' },
        ],
      },
      { key: 'matchType', title: 'Match type', kind: 'single', options: [
        { value: 'singles', label: 'Singles' },
        { value: 'doubles', label: 'Doubles' },
      ] },
      { key: 'doublesCategory', title: 'Doubles category', kind: 'single', options: [
        { value: 'gendered', label: 'Gendered' },
        { value: 'mixed', label: 'Mixed' },
        { value: 'unspecified', label: 'Uncategorized' },
      ] },
      { key: 'homeAway', title: 'Home / away', kind: 'single', options: [
        { value: 'home', label: 'Home', iconName: 'home' },
        { value: 'away', label: 'Away', iconName: 'plane' },
      ] },
      { key: 'indoorOutdoor', title: 'Indoor / outdoor', kind: 'single', options: [
        { value: 'outdoor', label: 'Outdoor', iconName: 'sun' },
        { value: 'indoor', label: 'Indoor', iconName: 'indoor' },
        { value: 'unknown', label: 'Not set' },
      ] },
    ];
    // The League group mirrors the card chip: shown wherever the chip can be
    // (not on a league-scoped history, where every row is the same league).
    if (!leagueId && scopeOptions.leagues.length > 0) {
      groups.push({ key: 'league', title: 'League', kind: 'single', options: scopeOptions.leagues });
    }
    if (scopeOptions.tournaments.length > 0) {
      groups.push({ key: 'tournament', title: 'Tournament', kind: 'single', options: scopeOptions.tournaments });
    }
    return groups;
  }, [leagueId, scopeOptions]);

  const { filtered, upcoming } = useMemo(() => {
    const f = filters;
    const recencyDays = f.recency ? Number(f.recency) : null;
    const cutoff = recencyDays ? Date.now() - recencyDays * 86400000 : null;
    const searchLower = typeof f.player === 'string' ? f.player.trim().toLowerCase() : '';

    const pred = (m: HistoryMatch, opts: { skipDateFilters?: boolean } = {}) => {
      if (f.matchType && m.match_type !== f.matchType) return false;
      if (f.homeAway === 'home' && !m.is_home_court) return false;
      if (f.homeAway === 'away' && m.is_home_court) return false;
      if (f.league && m.league_id !== f.league) return false;
      if (f.tournament && m.tournament_id !== f.tournament) return false;
      if (!opts.skipDateFilters && cutoff && new Date(m.played_at).getTime() < cutoff) return false;
      if (f.indoorOutdoor === 'outdoor' && m.is_outdoor !== true) return false;
      if (f.indoorOutdoor === 'indoor'  && m.is_outdoor !== false) return false;
      if (f.indoorOutdoor === 'unknown' && m.is_outdoor !== null) return false;
      if (f.doublesCategory) {
        if (m.match_type !== 'doubles') return false;
        if (m.doubles_category !== f.doublesCategory) return false;
      }

      // My matches only — show matches where the logged-in user participated
      if (myMatchesOnly && currentUserId) {
        const involved = m.player1_id === currentUserId || m.player2_id === currentUserId ||
                         m.partner1_id === currentUserId || m.partner2_id === currentUserId;
        if (!involved) return false;
      }

      // Player name search — match against all four player names
      if (searchLower) {
        const names = [
          m.player1?.full_name,
          m.partner1?.full_name,
          m.player2?.full_name,
          m.partner2?.full_name,
        ].filter(Boolean).join(' ').toLowerCase();
        if (!names.includes(searchLower)) return false;
      }

      return true;
    };

    // Scheduled (future) matches go above the existing list. We skip the
    // recency filter because that pill is about how recently a match was
    // played — irrelevant to something that hasn't happened yet.
    const upcomingList = matches
      .filter((m) => m.status === 'scheduled' && pred(m, { skipDateFilters: true }))
      .sort((a, b) => {
        const ta = a.scheduled_at ? new Date(a.scheduled_at).getTime() : 0;
        const tb = b.scheduled_at ? new Date(b.scheduled_at).getTime() : 0;
        return ta - tb;
      });

    const rest = matches.filter((m) => m.status !== 'scheduled' && pred(m));

    return { filtered: rest, upcoming: upcomingList };
  }, [matches, filters, myMatchesOnly, currentUserId]);

  // Keep a live handle on the latest filtered list for deferred scrolls.
  filteredRef.current = filtered;

  // TODO: smoke-test in browser — deep-link scroll-to + highlight tint.
  // Scroll to the deep-linked match once it actually appears in the filtered
  // list, then tint it (fades after 2.5s). Depends on `filtered` so it
  // re-checks as the list settles (e.g. `myMatchesOnly` kicks in only after
  // currentUserId resolves). We auto-scroll at most once per target
  // (scrolledForRef) so later user filter edits don't yank the viewport, and
  // the deferred scroll recomputes the index from filteredRef to avoid a stale
  // index if the list changed length in the meantime. With the filters
  // collapsed and ~66px cards, a recent match is usually already in view.
  useEffect(() => {
    if (loading || !highlightMatchId) return;
    if (scrolledForRef.current === highlightMatchId) return;
    if (!filtered.some((m) => m.id === highlightMatchId)) return; // not in list yet — wait for it to settle

    scrolledForRef.current = highlightMatchId;
    setHighlightedId(highlightMatchId);
    const scrollTimer = setTimeout(() => {
      const liveIdx = filteredRef.current.findIndex((m) => m.id === highlightMatchId);
      if (liveIdx >= 0) listRef.current?.scrollToIndex({ index: liveIdx, animated: true, viewPosition: 0.3 });
    }, 200);
    const fadeTimer = setTimeout(() => setHighlightedId(null), 2700);
    return () => { clearTimeout(scrollTimer); clearTimeout(fadeTimer); };
  }, [loading, highlightMatchId, filtered]);

  const sheetFilterCount = countActiveFilters(filters, FILTER_DEFAULTS);
  const anyFilterOn = sheetFilterCount > 0 || myMatchesOnly;

  // An empty "Match history (0)" section never renders under Upcoming (empty
  // sections don't render); with no Upcoming the header stays as the Calendar
  // entry point above the empty state.
  const showHistoryHeader = matches.length > 0 && (filtered.length > 0 || upcoming.length === 0);
  const calendarAction = {
    label: 'Calendar',
    chevron: true,
    a11yLabel: 'View calendar analytics',
    onPress: () => navigation.navigate('CalendarAnalytics', {
      userId,
      leagueId,
      title: params.title + ' Calendar',
    }),
  };

  function clearAllFilters() {
    setFilters(resetFilters(FILTER_DEFAULTS));
    setMyMatchesOnly(false);
  }

  // A failed first load falls through to the list so its pull-to-refresh (and
  // the Retry button below) stay mounted.
  const loadFailed = loadError != null && matches.length === 0;
  if (loading && !loadFailed) {
    return <View style={S.container}><SkeletonList rows={8} variant="row" rowHeight={MATCH_ROW_ESTIMATE} /></View>;
  }

  return (
    <View style={S.container}>
      <StatusBanner status={status.value} style={{ marginHorizontal: SPACE.lg, marginTop: SPACE.sm }} />

      {/* One 44px filter row: the Mine quick chip (league-wide views only),
          a removable chip per applied filter, and Filters (n) pinned right.
          Everything else lives in the sheet. Fixed chrome outside the list
          (no stickyHeaderIndices, which react-native-web mishandles). */}
      <View style={S.filterBar}>
        <FilterChipRow
          multi
          size="md"
          options={!userId ? [{ value: 'mine', label: 'Mine' }] : []}
          values={myMatchesOnly ? ['mine'] : []}
          onChangeValues={(vals) => setMyMatchesOnly(vals.includes('mine'))}
          wrapAtWidth={600}
          leading={
            <ActiveFilterChips
              values={filters}
              defaults={FILTER_DEFAULTS}
              groups={filterGroups}
              formatLabel={(e) => (e.key === 'player' && e.value ? `“${e.value}”` : null)}
              onRemove={(key, value) => setFilters((prev) => removeFilterValue(prev, FILTER_DEFAULTS, key, value))}
              inline
            />
          }
          trailing={
            <FilterPill
              label="Filters"
              count={sheetFilterCount > 0 ? sheetFilterCount : undefined}
              active={sheetFilterCount > 0}
              onPress={() => setSheetOpen(true)}
              accessibilityLabel={sheetFilterCount > 0 ? `Filters, ${sheetFilterCount} on` : 'Filters'}
            />
          }
        />
      </View>

      <FlatList
        ref={listRef}
        data={filtered}
        keyExtractor={(item) => item.id}
        renderItem={renderMatch}
        contentContainerStyle={S.listContent}
        refreshControl={<AppRefreshControl {...refresh} />}
        onScrollToIndexFailed={({ index, averageItemLength }) => {
          // Target row isn't measured yet (it's below the render window). Nudge
          // toward it by estimated offset, then retry. Recompute the index from
          // the live filtered list (by id when deep-linking) so a list that
          // shrank between attempts can't park us on the wrong row.
          listRef.current?.scrollToOffset({ offset: index * (averageItemLength || MATCH_ROW_ESTIMATE), animated: false });
          setTimeout(() => {
            const liveIdx = highlightMatchId
              ? filteredRef.current.findIndex((m) => m.id === highlightMatchId)
              : index;
            if (liveIdx >= 0 && liveIdx < filteredRef.current.length) {
              listRef.current?.scrollToIndex({ index: liveIdx, animated: true, viewPosition: 0.3 });
            }
          }, 120);
        }}
        ListEmptyComponent={
          loadFailed
            ? <ErrorState
                iconName="offline"
                error={loadError}
                message={`Couldn't load match history. ${friendlySbMessage(loadError)}`}
                retryLabel="Retry"
                onRetry={() => { setLoading(true); void loadMatches(); }}
              />
            : upcoming.length > 0
            ? null
            : matches.length > 0 && anyFilterOn
            // Every empty state caused by filters offers the way out.
            ? <EmptyState iconName="search" title="No matches fit these filters" actionLabel="Clear filters" onAction={clearAllFilters} />
            : <EmptyState iconName={entityIcon('match')} title="No matches yet" subtitle="No matches recorded yet." />
        }
        ListHeaderComponent={
          (matches.length > 0 || upcoming.length > 0) ? (
            <View>
              {upcoming.length > 0 && (
                <View style={S.section}>
                  <SectionHeader
                    title="Upcoming"
                    count={upcoming.length}
                    // No history header below (nothing played fits) — Calendar
                    // rides here instead so it stays reachable.
                    action={showHistoryHeader ? undefined : calendarAction}
                  />
                  {upcoming.map(renderUpcoming)}
                </View>
              )}
              {upcoming.length > 0 && filtered.length === 0 && anyFilterOn && (
                // ListEmptyComponent stands down while Upcoming has rows, so
                // the filtered-empty way out renders inline here instead.
                <EmptyState compact iconName="search" title="No matches fit these filters" actionLabel="Clear filters" onAction={clearAllFilters} />
              )}
              {showHistoryHeader && (
                // The old full-width Calendar Analytics button is this header's
                // action now: same destination, 44px instead of ~60.
                <SectionHeader
                  title={upcoming.length > 0 ? 'Match history' : 'Matches'}
                  count={filtered.length > 0 ? filtered.length : undefined}
                  action={calendarAction}
                />
              )}
            </View>
          ) : null
        }
      />

      <FilterSheet
        visible={sheetOpen}
        onClose={() => setSheetOpen(false)}
        groups={filterGroups}
        values={filters}
        defaults={FILTER_DEFAULTS}
        onApply={(next) => setFilters(next)}
      />

      {/* Every wager surface below is gated (lib/features.ts). The state and
          handlers stay put so flipping WAGERS_ENABLED restores the flow. */}
      <ActionSheetModal
        visible={WAGERS_ENABLED && wagerSheetOpen}
        title="Place a wager"
        subtitle={wagerCtx ? `${wagerCtx.team1Label} vs ${wagerCtx.team2Label}` : undefined}
        onClose={() => setWagerSheetOpen(false)}
        actions={wagerCtx ? [
          { label: `Wager: ${wagerCtx.team1Label} wins`, iconName: 'dice', onPress: () => startWinnerWager('team1') },
          { label: `Wager: ${wagerCtx.team2Label} wins`, iconName: 'dice', onPress: () => startWinnerWager('team2') },
          { label: 'Wager: exact score', iconName: 'target', onPress: () => setScoreInput({ t1: '', t2: '' }) },
        ] : []}
      />

      <ConfirmModal
        visible={WAGERS_ENABLED && scoreInput != null}
        title="Wager: exact score"
        body={wagerCtx ? `${wagerCtx.team1Label} vs ${wagerCtx.team2Label}` : undefined}
        primaryLabel="Continue"
        primaryDisabled={!scoreInput || scoreInput.t1.trim() === '' || scoreInput.t2.trim() === ''}
        extraField={scoreInput ? (
          <View>
            <Text style={[t.fieldLabel, S.scoreInputLabel]}>Predicted final score</Text>
            <View style={S.scoreInputRow}>
              <KeyboardTextInput
                style={S.scoreInput}
                value={scoreInput.t1}
                onChangeText={(v) => setScoreInput({ ...scoreInput, t1: v.replace(/[^0-9]/g, '') })}
                keyboardType="number-pad"
                maxLength={3}
                placeholder="0"
                placeholderTextColor={colors.textMuted}
              />
              <Text style={S.scoreInputDash}>–</Text>
              <KeyboardTextInput
                style={S.scoreInput}
                value={scoreInput.t2}
                onChangeText={(v) => setScoreInput({ ...scoreInput, t2: v.replace(/[^0-9]/g, '') })}
                keyboardType="number-pad"
                maxLength={3}
                placeholder="0"
                placeholderTextColor={colors.textMuted}
              />
            </View>
          </View>
        ) : undefined}
        onConfirm={confirmScoreWager}
        onClose={() => setScoreInput(null)}
      />

      {shareModel ? (
        <PickleShareStudio
          visible={shareOpen}
          onClose={() => setShareOpen(false)}
          title="Share this match"
          model={shareModel}
        />
      ) : null}

      <WagerProposeModal
        visible={WAGERS_ENABLED && wagerSubject != null}
        subject={wagerSubject}
        onClose={() => setWagerSubject(null)}
      />
    </View>
  );
}

const TILE = 32;

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  const t = textStyles(c);
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bg },
    filterBar: {
      paddingHorizontal: SPACE.lg,
      backgroundColor: c.surface,
      borderBottomWidth: HAIRLINE,
      borderBottomColor: c.border,
    },
    listContent: { paddingHorizontal: SPACE.lg, paddingTop: SPACE.sm, paddingBottom: SPACE.xl },
    section: { marginBottom: SPACE.xs },

    tile: { width: TILE, height: TILE, borderRadius: TILE / 2, alignItems: 'center', justifyContent: 'center' },
    tileText: { fontSize: FONT.size.base, fontWeight: FONT.weight.heavy },

    // Line 2: [scope chip] facts — one line; the facts give way first.
    metaLine: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, marginTop: SPACE.xxs, minWidth: 0 },
    metaChip: { flexShrink: 1, maxWidth: '55%' },
    metaText: { flex: 1, minWidth: 0 },

    winnerName: { color: c.text },
    loserName: { color: c.textSub },

    scoreCol: { alignItems: 'flex-end', gap: SPACE.xxs },
    score: { ...t.title, color: c.textSub },
    delta: { ...t.meta },

    // A card holding the 44px Confirm box: 4px vertical padding keeps it a
    // 56-62 card instead of 64+ (same trick as EntityRow's action rows).
    actionCard: { paddingVertical: SPACE.xs },
    trailingRow: { flexDirection: 'row', alignItems: 'center' },
    menuBox: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    pressed: { opacity: 0.6 },

    scoreInputRow: { flexDirection: 'row', gap: SPACE.sm, alignItems: 'center', marginTop: SPACE.sm, marginBottom: SPACE.xs },
    scoreInput: {
      flex: 1, borderWidth: HAIRLINE, borderColor: c.border, borderRadius: RADIUS.md, minHeight: 44,
      paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, fontSize: FONT.size.xl, fontWeight: FONT.weight.bold,
      backgroundColor: c.surface, color: c.text, textAlign: 'center',
    },
    scoreInputDash: { fontSize: FONT.size.xl, fontWeight: FONT.weight.heavy, color: c.textMuted },
    scoreInputLabel: { marginTop: SPACE.sm },
  });
}
