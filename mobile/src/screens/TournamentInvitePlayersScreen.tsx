// A tournament's "Invite players" (the user, 2026-10-24: "Suggest nearby,
// search all"):
//   suggestions   the players who play near the tournament's venue (else its
//                 league's home court) at the search area's radius, by their
//                 leagues' home courts only (lib/inviteSuggestions); no place
//                 or no one there: near the shared search area; neither: the
//                 old list (anywhere). Always within ±1.5 PLUPR of the
//                 tournament average, closest level first.
//   search        typing a name searches everyone (every page of
//                 discover_players), not just the suggestions.
// Registered or pending players are never offered.
import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { sbCall, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { RootStackParamList } from '../types';
import { AVATARS } from '../data/profileCustomization';
import { formatPlupr } from '../lib/plupr';
import { useRefresh } from '../lib/useRefresh';
import { useSearchArea } from '../lib/useSearchArea';
import { searchAreaKey } from '../lib/searchArea';
import { playerMatchesQuery, playsAtLabel } from '../lib/playersNear';
import {
  firstWithAnyone, suggestedFirst, suggestionSteps, suggestionsHeading, withinLevel,
  type SuggestionSource,
} from '../lib/inviteSuggestions';
import { getInvitePlace, listEveryone, nearForInvite } from '../data/inviteSuggestions';
import AppRefreshControl from '../components/AppRefreshControl';
import { SkeletonList } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';
import { ErrorState } from '@just-messin-around/expo-foundation/ui';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { HAIRLINE, RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'TournamentInvitePlayers'>;
  route: RouteProp<RootStackParamList, 'TournamentInvitePlayers'>;
};

type Candidate = {
  id: string;
  full_name: string;
  username: string;
  rating: number;
  total_matches_played: number;
  avatar_id: number | null;
  avatar_emoji: string | null;
  avatar_bg_color: string | null;
  ratingDiff: number;       // |rating - tournament avg|
  /** Suggested nearby only: "Plays at Lakeside Park · 2 mi". */
  playsAt: string | null;
};

/** One row's invite: done (optimistic) or the reason it failed. */
type InviteState = { invited: boolean; error: string | null };

/** What one load() read, applied together (or not at all, when a newer load started). */
type Loaded = {
  excluded: Set<string>;
  avg: number;
  suggested: Candidate[];
  everyone: Candidate[];
  source: SuggestionSource;
  heading: string | null;
};

/** The suggestions' level band around the tournament average. */
const LEVEL_BAND = 1.5;
const CANDIDATE_COLUMNS = 'id, full_name, username, rating, total_matches_played, avatar_id, avatar_emoji, avatar_bg_color';

function toCandidate(p: any, avg: number, playsAt: string | null = null): Candidate {
  const rating = typeof p.rating === 'number' ? p.rating : avg;
  return {
    id: p.id,
    full_name: p.full_name ?? 'Player',
    username: p.username ?? '',
    rating,
    total_matches_played: p.total_matches_played ?? 0,
    avatar_id: p.avatar_id ?? null,
    avatar_emoji: p.avatar_emoji ?? null,
    avatar_bg_color: p.avatar_bg_color ?? null,
    ratingDiff: Math.abs(rating - avg),
    playsAt,
  };
}

export default function TournamentInvitePlayersScreen({ navigation, route }: Props) {
  const { tournamentId, tournamentName } = route.params;
  const { colors: c } = useTheme();
  const S = makeStyles(c);
  const { area, saved, ready } = useSearchArea();
  const areaKey = searchAreaKey(area);

  const [loading, setLoading]       = useState(true);
  // A failed read must not render as "no eligible players".
  const [loadError, setLoadError]   = useState<string | null>(null);
  const [busy, setBusy]             = useState<string | null>(null);
  const [query, setQuery]           = useState('');
  const [tournamentAvg, setTournamentAvg] = useState<number>(3.25);
  // The suggestions (no search), and everyone (what a search searches).
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [everyone, setEveryone]     = useState<Candidate[]>([]);
  const [source, setSource]         = useState<SuggestionSource>('anywhere');
  const [heading, setHeading]       = useState<string | null>(null);
  const [excluded, setExcluded]     = useState<Set<string>>(new Set());
  const [invites, setInvites]       = useState<Record<string, InviteState>>({});

  const refresh = useRefresh(load);
  // Only the newest load() may set the list: the area can change while one is
  // in flight (the device fix lands after the saved city), and the older read
  // must not finish last and overwrite it.
  const loadSeq = useRef(0);

  // Waits for the search area (lib/useSearchArea's `ready`): the radius and
  // the fallback centre come from it.
  useFocusEffect(useCallback(() => {
    if (ready) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tournamentId, ready, areaKey, saved.radiusMi]));

  async function load() {
    const seq = ++loadSeq.current;
    const newest = () => seq === loadSeq.current;
    setLoading(true);
    try {
      const next = await loadInner();
      if (!newest()) return;
      setExcluded(next.excluded);
      setTournamentAvg(next.avg);
      setCandidates(next.suggested);
      setEveryone(next.everyone);
      setSource(next.source);
      setHeading(next.heading);
      setLoadError(null);
    } catch (e) {
      if (!newest()) return;
      // Critically, a failed registration read would leave `excluded` empty and
      // list players who are ALREADY registered as invitable.
      setLoadError(friendlySbMessage(e));
    } finally {
      if (newest()) setLoading(false);
    }
  }

  async function loadInner(): Promise<Loaded> {
    // 1. Existing tournament registrations (any status) — exclude these.
    const regs = ((await sbCall(() => supabase
      .from('tournament_registrations')
      .select('user_id, status, profile:profiles!tournament_registrations_user_id_fkey(rating)')
      .eq('tournament_id', tournamentId))) ?? []) as any[];
    const excludeIds = new Set<string>(regs.map(r => r.user_id));
    const exclude = [...excludeIds];

    // 2. Tournament average rating (use approved registrants only; fall back to overall).
    const approvedRatings = regs
      .filter(r => r.status === 'approved' && typeof r.profile?.rating === 'number')
      .map(r => r.profile.rating as number);
    const avg = approvedRatings.length
      ? approvedRatings.reduce((a, b) => a + b, 0) / approvedRatings.length
      : 3.25;

    // 3. Everyone (the search; discover_players never offers a deleted
    //    account, nor a test account while God mode hides them) and where the
    //    tournament is.
    const [all, place] = await Promise.all([
      listEveryone<any>(CANDIDATE_COLUMNS, { exclude }),
      getInvitePlace({ type: 'tournament', id: tournamentId }),
    ]);

    // 4. Suggestions: near the venue, else near the search area, within the
    //    level band; else the old list (the 500 nearest the average, ±1.5).
    const hit = await firstWithAnyone(
      suggestionSteps(place, area, saved.radiusMi),
      (step) => nearForInvite(step.circle, exclude),
      (rows) => withinLevel(rows, avg, LEVEL_BAND),
    );
    let suggested: Candidate[];
    let source: SuggestionSource;
    let heading: string | null;
    if (hit) {
      suggested = hit.rows.map(p => toCandidate(p, avg, playsAtLabel(p)));
      source = hit.step.source;
      heading = suggestionsHeading(hit.step.source, hit.step.label, hit.step.circle.radiusMi);
    } else {
      const profs = await sbCall(() => supabase
        .rpc('discover_players', { p_min_rating: avg - LEVEL_BAND, p_max_rating: avg + LEVEL_BAND, p_limit: 500, p_near_rating: avg })
        .select(CANDIDATE_COLUMNS));
      suggested = ((profs ?? []) as any[]).filter(p => !excludeIds.has(p.id)).map(p => toCandidate(p, avg));
      source = 'anywhere';
      heading = null;
    }
    suggested.sort((a, b) => a.ratingDiff - b.ratingDiff);

    return {
      excluded: excludeIds,
      avg,
      suggested,
      everyone: all.filter(p => !excludeIds.has(p.id)).map(p => toCandidate(p, avg)),
      source,
      heading,
    };
  }

  async function invite(c: Candidate) {
    setBusy(c.id);
    // Clear any prior error on this row before retrying.
    setInvites(prev => ({ ...prev, [c.id]: { invited: false, error: null } }));

    let data: unknown;
    try {
      // No auto-retry: inviting charges an ante, and a retried call that
      // already landed would charge twice.
      data = await sbCall(
        () => supabase.rpc('tournament_invite_player', {
          p_tournament_id: tournamentId,
          p_user_id:       c.id,
        }),
        { retries: 0 },
      );
    } catch (e: any) {
      // Surface the failure inline next to the row instead of via Alert —
      // Alert.alert occasionally collapses silently on web in some focus states.
      // eslint-disable-next-line no-console
      console.warn('[tournament_invite_player]', e);
      const msg = e?.message ?? '';
      // Matches the server's error text (which spells pickles with the emoji).
      const friendlier = /only.*has.*🥒|ante is/i.test(msg)
        ? 'They don\'t have enough pickles for the entry ante.'
        : friendlySbMessage(e, 'Could not invite.');
      setInvites(prev => ({ ...prev, [c.id]: { invited: false, error: friendlier } }));
      return;
    } finally {
      setBusy(null);
    }
    const row = Array.isArray(data) ? data[0] : (data as any);
    if (!row?.success) {
      setInvites(prev => ({ ...prev, [c.id]: { invited: false, error: row?.message ?? 'Could not invite.' } }));
      return;
    }
    setInvites(prev => ({ ...prev, [c.id]: { invited: true, error: null } }));
  }

  // No search: the suggestions. A search: everyone whose name or @username
  // matches, the suggested ones first (closest level), then by name.
  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) return candidates;
    const match = (p: Candidate) => playerMatchesQuery(p, q);
    return suggestedFirst(candidates.filter(match), everyone.filter(match));
  }, [candidates, everyone, query]);

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <SkeletonList rows={6} />
      </View>
    );
  }

  if (loadError && candidates.length === 0 && everyone.length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <ErrorState
          iconName="offline"
          error={null}
          message={`Couldn't load players. ${loadError}`}
          onRetry={load}
        />
      </View>
    );
  }

  const hint = source === 'anywhere'
    ? 'Sorted by closest PLUPR to the tournament average. Search finds anyone. Players already registered or pending are filtered out.'
    : `${heading ?? 'Players near the tournament'}, closest PLUPR to the tournament average first. Search finds anyone. Players already registered or pending are filtered out.`;

  return (
    <View style={S.root}>
      <View style={S.header}>
        <Text style={S.headerTitle}>Invite Players</Text>
        <Text style={S.headerSub}>to {tournamentName}</Text>
        <View style={S.infoPills}>
          <View style={S.infoPill}>
            <Text style={S.infoPillLabel}>Avg PLUPR</Text>
            <Text style={S.infoPillValue}>{tournamentAvg.toFixed(2)}</Text>
          </View>
          <View style={S.infoPill}>
            <Text style={S.infoPillLabel}>Already in</Text>
            <Text style={S.infoPillValue}>{excluded.size}</Text>
          </View>
          <View style={S.infoPill}>
            <Text style={S.infoPillLabel}>{source === 'anywhere' ? 'Eligible' : 'Nearby'}</Text>
            <Text style={S.infoPillValue}>{candidates.length}</Text>
          </View>
        </View>
      </View>

      <View style={S.searchRow}>
        <TextInput
          style={S.searchInput}
          placeholder="Search everyone by name or @username…"
          placeholderTextColor={c.textMuted}
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />
        {query.length > 0 && (
          <TouchableOpacity
            style={S.clearBtn}
            onPress={() => setQuery('')}
            accessibilityRole="button"
            accessibilityLabel="Clear search"
          >
            <Icon name="close" size={16} color={c.textMuted} />
          </TouchableOpacity>
        )}
      </View>

      <Text style={S.hint}>{hint}</Text>

      <FlatList
        data={filtered}
        keyExtractor={c => c.id}
        renderItem={({ item }) => {
          const cartoon = AVATARS.find(a => a.id === (item.avatar_id ?? 1)) ?? AVATARS[0];
          const emoji   = item.avatar_emoji ?? cartoon.emoji;
          const bg      = item.avatar_bg_color ?? cartoon.bgColor;
          const ratingDeltaTxt = item.ratingDiff < 0.005
            ? 'same PLUPR'
            : (item.rating - tournamentAvg > 0 ? '+' : '') + (item.rating - tournamentAvg).toFixed(2) + ' vs avg';
          const state = invites[item.id];

          return (
            <View style={S.rowWrap}>
              <View style={S.row}>
                <View style={[S.avatar, { backgroundColor: bg }]}>
                  <Text style={S.avatarEmoji}>{emoji}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={S.name} numberOfLines={1}>{item.full_name}</Text>
                  <Text style={S.sub} numberOfLines={1}>
                    @{item.username} · {formatPlupr(item.rating, item.total_matches_played)} PLUPR · {ratingDeltaTxt}
                  </Text>
                  {item.playsAt ? <Text style={S.playsAt} numberOfLines={1}>{item.playsAt}</Text> : null}
                </View>
                {state?.invited ? (
                  <View style={S.btnDone} accessible accessibilityLabel={`${item.full_name} invited`}>
                    <Icon name="check-mark" size={14} color={c.success} />
                    <Text style={S.btnDoneText}>Invited</Text>
                  </View>
                ) : (
                  <Button
                    size="sm"
                    title="Invite"
                    onPress={() => invite(item)}
                    loading={busy === item.id}
                    style={S.btn}
                    accessibilityLabel={`Invite ${item.full_name}`}
                  />
                )}
              </View>
              {state?.error ? (
                <View style={S.rowError}>
                  <Icon name="warning" size={12} color={c.danger} />
                  <Text style={S.rowErrorText}>{state.error}</Text>
                </View>
              ) : null}
            </View>
          );
        }}
        ListEmptyComponent={
          query
            ? <EmptyState iconName="search" title="No matches" subtitle="No players match that search." />
            : <EmptyState iconName="group" title="No eligible players" subtitle="No eligible players found in the PLUPR band ±1.5 of the tournament average. Search to invite anyone." />
        }
        contentContainerStyle={{ paddingBottom: SPACE.xl * 2 }}
        refreshControl={<AppRefreshControl {...refresh} />}
        keyboardShouldPersistTaps="handled"
      />
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  const t = textStyles(c);
  return StyleSheet.create({
    root:        { flex: 1, backgroundColor: c.bg },

    header:      { backgroundColor: c.surface, padding: SPACE.lg, borderBottomWidth: HAIRLINE, borderBottomColor: c.border },
    headerTitle: t.h2,
    headerSub:   { ...t.sub, marginTop: SPACE.xxs },
    infoPills:   { flexDirection: 'row', gap: SPACE.sm, marginTop: SPACE.md },
    infoPill:    { flex: 1, backgroundColor: c.surfaceAlt, borderRadius: RADIUS.md, paddingVertical: SPACE.sm, paddingHorizontal: SPACE.sm, borderWidth: HAIRLINE, borderColor: c.border, alignItems: 'center' },
    infoPillLabel: { ...t.fieldLabel, fontSize: FONT.size.xxs },
    infoPillValue: { ...t.h3, fontWeight: FONT.weight.heavy, fontVariant: ['tabular-nums'], marginTop: SPACE.xxs },

    searchRow:   { flexDirection: 'row', alignItems: 'center', padding: SPACE.md, gap: SPACE.sm, backgroundColor: c.surface, borderBottomWidth: HAIRLINE, borderBottomColor: c.border },
    searchInput: { flex: 1, borderWidth: HAIRLINE, borderColor: c.border, borderRadius: RADIUS.md, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, minHeight: 44, fontSize: FONT.size.md, color: c.text, backgroundColor: c.surface },
    // 44 tap box (web ignores hitSlop).
    clearBtn:    { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },

    hint: { ...t.caption, paddingHorizontal: SPACE.lg, paddingTop: SPACE.sm, paddingBottom: SPACE.xs, lineHeight: 15 },

    rowWrap:     { borderBottomWidth: HAIRLINE, borderBottomColor: c.border, backgroundColor: c.surface },
    row:         { flexDirection: 'row', alignItems: 'center', paddingVertical: SPACE.sm, paddingHorizontal: SPACE.md, minHeight: 60, gap: SPACE.md },
    rowError:    { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, backgroundColor: c.dangerLight, paddingHorizontal: SPACE.md, paddingVertical: SPACE.xs },
    rowErrorText:{ flex: 1, color: c.danger, fontSize: FONT.size.sm, fontWeight: FONT.weight.semibold },
    avatar:      { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
    avatarEmoji: { fontSize: FONT.size.h2 },
    name:        t.title,
    sub:         { ...t.hint, fontSize: FONT.size.sm, marginTop: SPACE.xxs },
    playsAt:     { ...t.caption, marginTop: SPACE.xxs },

    btn:         { minWidth: 80 },
    btnDone:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACE.xs, minWidth: 80, minHeight: 32, paddingHorizontal: SPACE.md, borderRadius: RADIUS.md, backgroundColor: c.surfaceAlt, borderWidth: HAIRLINE, borderColor: c.border },
    btnDoneText: { color: c.textSub, fontWeight: FONT.weight.bold, fontSize: FONT.size.base },
  });
}
