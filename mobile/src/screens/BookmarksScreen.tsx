// Saved: the fast path to the standings you care about (2026-10-22).
//
//   LEAGUES                                   your saved leagues, FIRST
//   [ball] Tuesday Ladder          [League] [bookmark] >
//          You #3 of 16 · Fall 2026 · P7  <- tap: that season's standings, at my row
//   YOUR LEAGUES  Tap Save to keep them here  leagues I play in but haven't saved
//   [ball] Thursday Doubles                   [star-outline Save]
//   TOURNAMENTS / EVENTS / DRILLS / PEOPLE    as before; a tournament opens on
//                                             its standings ("Finished #2 of 8")
//
// One tap from Saved to a league's current standings (it used to be Saved ->
// league -> Standings), and Saved is one tap from Home's top bar and from Me's
// header. The standing lines are batched across every league on the screen
// (lib/savedStandingsData) and cached, so the reload on every focus is cheap.
// They are decorative: a failed standings read keeps the old subtitle and the
// tap falls back to the league page. Suggestions never save without a tap.
import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { sbCall, friendlySbMessage, currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { SectionHeader, ErrorState } from '@just-messin-around/expo-foundation/ui';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { SPACE, RADIUS, HAIRLINE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { FONT } from '@just-messin-around/expo-foundation/typography';
import { supabase } from '../lib/supabase';
import { useToast } from '../lib/useToast';
import { useTheme } from '../lib/ThemeContext';
import { RootStackParamList } from '../types';
import { addBookmark, listBookmarks, removeBookmark, Bookmark, BookmarkTargetType } from '../lib/bookmarks';
import { useRefresh } from '../lib/useRefresh';
import AppRefreshControl from '../components/AppRefreshControl';
import { SkeletonList } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';
import EntityRow, { type EntityRowChip } from '../components/EntityRow';
import { joinFacts, tournamentStatusChip, type EntityKind } from '../lib/entityGlyph';
import { displayCourtName } from '../lib/courtNickname';
import { dateLabel, dateSubLabel, durationLabel } from '../lib/drillTime';
import { drillWhen } from '../lib/drillWhen';
import {
  leagueSuggestions, savedStandingA11y, savedStandingLine, savedStandingsParams, tournamentFinishLine,
  type SavedStanding, type TournamentFinish,
} from '../lib/savedStandings';
import {
  listMyLeagues, loadSavedStandings, loadTournamentFinishes, type MyLeague,
} from '../lib/savedStandingsData';
import { track } from '../lib/analytics';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Bookmarks'> };

type EnrichedBookmark = Bookmark & {
  title: string;
  subtitle?: string | null;
  /** At most one status chip next to the title (content rule 2 allows two). */
  chip?: EntityRowChip | null;
  missing?: boolean;
};

// Each group's glyph comes from the one entity map (lib/entityGlyph), so a
// saved league shows the same ball here as on Home and Play.
const TYPE_META: Record<BookmarkTargetType, { kind: EntityKind; label: string }> = {
  tournament:    { kind: 'tournament', label: 'Tournaments' },
  league:        { kind: 'league',     label: 'Leagues' },
  event:         { kind: 'event',      label: 'Events' },
  drill_session: { kind: 'drill',      label: 'Drill sessions' },
  profile:       { kind: 'player',     label: 'People' },
};

// Leagues first: their standings are what Saved is opened for.
const TYPE_ORDER: BookmarkTargetType[] = ['league', 'tournament', 'event', 'drill_session', 'profile'];

export default function BookmarksScreen({ navigation }: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);
  const toast = useToast();

  const [loading, setLoading] = useState(true);
  const [items, setItems]     = useState<EnrichedBookmark[]>([]);
  // A failed load must not render as "No bookmarks yet" — that reads as data
  // loss to someone who saved a dozen things.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded]       = useState(false);
  // Decorative extras: empty on a failed read, never an error screen.
  const [standings, setStandings]     = useState<Record<string, SavedStanding>>({});
  const [finishes, setFinishes]       = useState<Map<string, TournamentFinish>>(new Map());
  const [suggestions, setSuggestions] = useState<MyLeague[]>([]);

  const refresh = useRefresh(() => load(true));

  useFocusEffect(useCallback(() => { load(); }, []));

  async function load(force = false) {
    setLoading(true);
    try {
      const uid = await currentUserId(supabase);
      const [rows, mine] = await Promise.all([
        listBookmarks(),
        listMyLeagues(uid).catch(() => [] as MyLeague[]),
      ]);
      const savedLeagueIds = rows.filter(r => r.target_type === 'league').map(r => r.target_id);
      const suggested = leagueSuggestions(mine, new Set(savedLeagueIds));
      const tournamentIds = rows.filter(r => r.target_type === 'tournament').map(r => r.target_id);
      // Started now, applied after the list paints: the lines are decoration,
      // so the rows don't wait on up to three more round trips.
      const extras = Promise.all([
        loadSavedStandings([...savedLeagueIds, ...suggested.map(l => l.id)], uid, { force })
          .catch(() => ({} as Record<string, SavedStanding>)),
        loadTournamentFinishes(tournamentIds, uid, { force })
          .catch(() => new Map<string, TournamentFinish>()),
      ]);
      const enriched = await enrich(rows);
      setItems(enriched);
      setSuggestions(suggested);
      setLoaded(true);
      setLoadError(null);
      setLoading(false);
      const [st, fin] = await extras;
      setStandings(st);
      setFinishes(fin);
    } catch (e) {
      setLoadError(friendlySbMessage(e, "Couldn't load your bookmarks."));
    } finally {
      // Always: an early return on the error path left the skeleton spinning.
      setLoading(false);
    }
  }

  async function handleRemove(b: EnrichedBookmark) {
    setItems(prev => prev.filter(x => !(x.target_type === b.target_type && x.target_id === b.target_id)));
    const ok = await removeBookmark(b.target_type, b.target_id);
    // The row is still there — put it back rather than let the list lie until
    // the next load quietly resurrects it.
    if (!ok) {
      setItems(prev => (prev.some(x => x.target_type === b.target_type && x.target_id === b.target_id)
        ? prev
        : [...prev, b]));
      toast.error("Couldn't remove that bookmark — check your connection.");
    }
  }

  /** ☆ on a suggestion: it moves up into Leagues at once; a failed save puts it back. */
  async function handleSaveSuggestion(l: MyLeague) {
    track('saved_suggestion_save', { league_id: l.id });
    const row: EnrichedBookmark = {
      user_id: '', target_type: 'league', target_id: l.id, created_at: new Date().toISOString(),
      title: l.name, subtitle: displayCourtName(l.home_court) || null,
    };
    setSuggestions(prev => prev.filter(x => x.id !== l.id));
    setItems(prev => [row, ...prev]);
    const ok = await addBookmark('league', l.id);
    if (!ok) {
      setItems(prev => prev.filter(x => !(x.target_type === 'league' && x.target_id === l.id)));
      setSuggestions(prev => (prev.some(x => x.id === l.id) ? prev : [l, ...prev]));
      toast.error(`Couldn't save ${l.name} — check your connection.`);
    }
  }

  /** A league row's tap: its standings (at my row) when it has a season, else the league. */
  function openLeague(leagueId: string, name: string, from: 'saved' | 'suggested') {
    const st = standings[leagueId];
    track('saved_league_open', { from, to: st?.seasonId ? 'standings' : 'league', kind: st?.kind ?? null });
    const params = savedStandingsParams(st, leagueId, name);
    if (params) {
      navigation.navigate('SeasonStandings', params);
    } else {
      navigation.navigate('LeagueDetail', { leagueId, leagueName: name });
    }
  }

  function handleTap(b: EnrichedBookmark) {
    if (b.missing) return;
    switch (b.target_type) {
      case 'tournament':
        // Opens on its standings (your row pinned there); the top when there are none yet.
        navigation.navigate('TournamentDetail', { tournamentId: b.target_id, tournamentName: b.title, focus: 'standings' });
        break;
      case 'league':
        openLeague(b.target_id, b.title, 'saved');
        break;
      case 'event':
        navigation.navigate('EventDetail', { eventId: b.target_id, title: b.title });
        break;
      case 'drill_session':
        navigation.navigate('DrillRequests');
        break;
      case 'profile':
        navigation.navigate('PlayerProfile', { userId: b.target_id, userName: b.title });
        break;
    }
  }

  /** The row's subtitle: my standing for a league / finish for a tournament, else what enrich() found. */
  function subtitleFor(b: EnrichedBookmark): string | null | undefined {
    if (b.missing) return b.subtitle;
    if (b.target_type === 'league') {
      const st = standings[b.target_id];
      return (st && savedStandingLine(st)) || b.subtitle;
    }
    if (b.target_type === 'tournament') return tournamentFinishLine(finishes.get(b.target_id)) || b.subtitle;
    return b.subtitle;
  }

  const grouped = useMemo(() => {
    const map: Record<BookmarkTargetType, EnrichedBookmark[]> = {
      tournament: [], league: [], event: [], drill_session: [], profile: [],
    };
    for (const b of items) map[b.target_type].push(b);
    return map;
  }, [items]);

  // Only the very first load shows the skeleton. A refocus reload (this screen
  // reloads on every focus) keeps the list on screen instead of blanking it,
  // which also keeps a just-tapped remove from flashing the whole page. A retry
  // after a failed first load shows it too, so "Try again" visibly responds.
  if (loading && !loaded) {
    return (
      <View style={S.screen}>
        <SkeletonList rows={6} variant="row" />
      </View>
    );
  }

  if (loadError && !loaded) {
    return (
      <View style={S.screen}>
        <ErrorState
          iconName="offline"
          error={loadError}
          message={`Couldn't load your bookmarks. ${loadError}`}
          onRetry={() => load(true)}
        />
      </View>
    );
  }

  if (items.length === 0 && suggestions.length === 0) {
    return (
      <View style={S.screen}>
        <EmptyState
          iconName="bookmark"
          title="No bookmarks yet"
          subtitle="Tap the bookmark icon on any tournament, league, event, drill session or player profile to save it here."
        />
      </View>
    );
  }

  const suggestionsBlock = suggestions.length > 0 ? (
    <View key="suggested" style={S.group}>
      <SectionHeader title="Your leagues" count="Tap Save to keep them here" />
      {suggestions.map(l => {
        const st = standings[l.id];
        const line = (st && savedStandingLine(st)) || displayCourtName(l.home_court) || null;
        return (
          <EntityRow
            key={`suggested-${l.id}`}
            kind="league"
            title={l.name}
            subtitle={line}
            onPress={() => openLeague(l.id, l.name, 'suggested')}
            action={
              <Pressable
                onPress={() => { void handleSaveSuggestion(l); }}
                style={({ pressed }) => [S.saveBox, { borderColor: c.border }, pressed && S.pressed]}
                accessibilityRole="button"
                accessibilityLabel={`Save ${l.name} to Saved`}
                hitSlop={4}
              >
                <Icon name="star-outline" size={14} color={c.textMuted} />
                <Text style={[S.saveText, { color: c.text }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>Save</Text>
              </Pressable>
            }
          />
        );
      })}
    </View>
  ) : null;

  return (
    <ScrollView style={S.screen} contentContainerStyle={S.content} refreshControl={<AppRefreshControl {...refresh} />}>
      {/* With no saved league yet, the suggestions lead the page. */}
      {grouped.league.length === 0 ? suggestionsBlock : null}
      {TYPE_ORDER.map(t => {
        const list = grouped[t];
        // Empty groups don't render (content rule 4).
        if (list.length === 0) return null;
        const meta = TYPE_META[t];
        return (
          <React.Fragment key={t}>
            <View style={S.group}>
              <SectionHeader title={meta.label} count={list.length} />
              {list.map(b => {
                const st = t === 'league' ? standings[b.target_id] : undefined;
                const opensStandings = !!st?.seasonId && !b.missing;
                const a11yLine = st ? savedStandingA11y(st) : null;
                return (
                  <EntityRow
                    key={`${b.target_type}-${b.target_id}`}
                    kind={meta.kind}
                    title={b.title}
                    subtitle={subtitleFor(b)}
                    chips={b.chip ? [b.chip] : undefined}
                    onPress={b.missing ? undefined : () => handleTap(b)}
                    // A deleted target reads as gone, not as a live row whose tap
                    // does nothing. Opacity doesn't block touches, so remove works.
                    style={b.missing ? S.missingRow : undefined}
                    // The trailing slot holds the remove button and, for a row that
                    // still opens something, the chevron. The buttons are their own
                    // 44x44 pressables nested in the row's pressable; react-native-web
                    // stops the click there, so they never also open the row.
                    action={
                      <View style={S.trailing}>
                        {opensStandings ? (
                          // The row opens the standings; the league page is one tap here.
                          <Pressable
                            onPress={() => navigation.navigate('LeagueDetail', { leagueId: b.target_id, leagueName: b.title })}
                            style={({ pressed }) => [S.removeBox, pressed && S.pressed]}
                            accessibilityRole="button"
                            accessibilityLabel={`Open ${b.title} league page`}
                          >
                            <Text style={[S.leagueLink, { color: c.textSub }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>League</Text>
                          </Pressable>
                        ) : null}
                        <Pressable
                          onPress={() => handleRemove(b)}
                          style={({ pressed }) => [S.removeBox, pressed && S.pressed]}
                          accessibilityRole="button"
                          accessibilityLabel={`Remove ${b.title} from bookmarks`}
                        >
                          <Icon name="bookmark" size={20} color={c.primary} />
                        </Pressable>
                        {b.missing ? null : (
                          <Pressable
                            onPress={() => handleTap(b)}
                            // 24 px wide box; slop on the trailing side only (the bookmark sits
                            // to its left) brings the target to 44 without widening the row.
                            hitSlop={{ right: 20 }}
                            style={({ pressed }) => [S.chevronBox, pressed && S.pressed]}
                            accessibilityRole="button"
                            accessibilityLabel={opensStandings
                              ? `${b.title} standings${a11yLine ? `, ${a11yLine}` : ''}`
                              : `Open ${b.title}`}
                          >
                            <Icon name="chevron-right" size={20} color={c.textMuted} />
                          </Pressable>
                        )}
                      </View>
                    }
                  />
                );
              })}
            </View>
            {t === 'league' ? suggestionsBlock : null}
          </React.Fragment>
        );
      })}
    </ScrollView>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    screen:      { flex: 1, backgroundColor: c.bg },
    content:     { paddingHorizontal: SPACE.lg, paddingTop: SPACE.sm, paddingBottom: SPACE.xl },
    group:       { marginBottom: SPACE.xs },
    missingRow:  { opacity: 0.55 },
    trailing:    { flexDirection: 'row', alignItems: 'center' },
    removeBox:   { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    chevronBox:  { minWidth: 24, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    saveBox:     {
      minWidth: 44, minHeight: 36, paddingHorizontal: SPACE.sm, borderWidth: HAIRLINE, borderRadius: RADIUS.pill,
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACE.xs,
    },
    saveText:    { fontSize: FONT.size.sm, fontWeight: FONT.weight.bold },
    leagueLink:  { fontSize: FONT.size.sm, fontWeight: FONT.weight.semibold },
    pressed:     { opacity: 0.6 },
  });
}

/** "Oct 3, 6:30 PM" for a timestamp; null when there is no date (a row never says TBD). */
function shortWhen(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Event status as a row chip; null for anything unrecognised (never a raw enum). */
function eventStatusChip(status: string | null | undefined): EntityRowChip | null {
  switch (status) {
    case 'voting':    return { label: 'Voting', tone: 'info' };
    case 'scheduled': return { label: 'Scheduled', tone: 'success' };
    case 'cancelled': return { label: 'Cancelled', tone: 'danger' };
    default:          return null;
  }
}

async function enrich(rows: Bookmark[]): Promise<EnrichedBookmark[]> {
  const byType: Record<BookmarkTargetType, string[]> = {
    tournament: [], league: [], event: [], drill_session: [], profile: [],
  };
  for (const r of rows) byType[r.target_type].push(r.target_id);

  // sbCall (throws) rather than a discarded `error`: a failed lookup used to
  // come back as an empty list, and every bookmark in that section then
  // rendered as deleted — the worst possible lie about a failed fetch.
  // The throw propagates to load(), which shows a retry.
  const [tRes, lRes, eRes, dRes, pRes] = await Promise.all([
    byType.tournament.length
      ? sbCall(() => supabase.from('tournaments').select('id, name, start_time, status').in('id', byType.tournament))
      : Promise.resolve([] as any[]),
    byType.league.length
      ? sbCall(() => supabase.from('leagues').select('id, name, home_court').in('id', byType.league))
      : Promise.resolve([] as any[]),
    byType.event.length
      ? sbCall(() => supabase.from('league_events').select('id, title, status, vote_ends_at').in('id', byType.event))
      : Promise.resolve([] as any[]),
    byType.drill_session.length
      ? sbCall(() => supabase.from('drill_sessions').select('id, session_date, session_slot, length_minutes, starts_at').in('id', byType.drill_session))
      : Promise.resolve([] as any[]),
    byType.profile.length
      ? sbCall(() => supabase.from('profiles').select('id, full_name, tagline').in('id', byType.profile))
      : Promise.resolve([] as any[]),
  ]);

  const tMap = new Map<string, any>(((tRes ?? []) as any[]).map(r => [r.id, r]));
  const lMap = new Map<string, any>(((lRes ?? []) as any[]).map(r => [r.id, r]));
  const eMap = new Map<string, any>(((eRes ?? []) as any[]).map(r => [r.id, r]));
  const dMap = new Map<string, any>(((dRes ?? []) as any[]).map(r => [r.id, r]));
  const pMap = new Map<string, any>(((pRes ?? []) as any[]).map(r => [r.id, r]));

  // A target that is gone stays listed (so it can be removed) but greyed: no
  // chevron, no navigation.
  const gone = (b: Bookmark, what: string): EnrichedBookmark =>
    ({ ...b, title: `Deleted ${what}`, subtitle: 'No longer available', missing: true });

  return rows.map(b => {
    switch (b.target_type) {
      case 'tournament': {
        const t = tMap.get(b.target_id);
        if (!t) return gone(b, 'tournament');
        return { ...b, title: t.name, subtitle: shortWhen(t.start_time), chip: tournamentStatusChip(t.status) };
      }
      case 'league': {
        const l = lMap.get(b.target_id);
        if (!l) return gone(b, 'league');
        return { ...b, title: l.name, subtitle: displayCourtName(l.home_court) || null };
      }
      case 'event': {
        const e = eMap.get(b.target_id);
        if (!e) return gone(b, 'event');
        const ends = e.status === 'voting' ? shortWhen(e.vote_ends_at) : null;
        return { ...b, title: e.title, subtitle: ends ? `Vote ends ${ends}` : null, chip: eventStatusChip(e.status) };
      }
      case 'drill_session': {
        const d = dMap.get(b.target_id);
        if (!d) return gone(b, 'drill session');
        // starts_at on this device's clock; the wall-clock slot is the fallback.
        const w = d.session_date && d.session_slot != null
          ? drillWhen(d.starts_at, { date: d.session_date, slot: d.session_slot })
          : null;
        const day = w ? `${dateLabel(w.date)} ${dateSubLabel(w.date)}` : null;
        return {
          ...b,
          title: day ? `Drill ${day}` : 'Drill session',
          subtitle: joinFacts([
            w ? w.time : null,
            d.length_minutes ? durationLabel(d.length_minutes) : null,
          ]) || null,
        };
      }
      case 'profile': {
        const p = pMap.get(b.target_id);
        if (!p) return gone(b, 'profile');
        return { ...b, title: p.full_name ?? 'Player', subtitle: p.tagline ?? null };
      }
    }
  });
}
