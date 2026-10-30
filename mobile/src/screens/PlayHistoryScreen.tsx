// Play history (Me › Play history, PKL-011; docs/play-sessions-presence.md
// Phase 2): my ended play sessions, newest first, 30 at a time
// (list_my_play_sessions). Each row: court and kind, day and times, whether it
// counts, its matches. The row's ⋯ discards it (discard_play_session): it
// leaves the list and never counts again, with a confirm first. A server
// without the history SQL says so instead of an error. For 7 days after a
// session ends its row offers Add a match (MatchEntry linked to it) and Add a
// drill (logged and reviewed in one step, log_session_drill), so a session
// can still count (lib/sessionAdds); the list reloads on coming back.
import React, { useCallback, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { classifySbError, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { Badge, ConfirmModal, EmptyState, ErrorState, ListCard } from '@just-messin-around/expo-foundation/ui';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { SPACE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../lib/ThemeContext';
import { useToast } from '../lib/useToast';
import { useRefresh } from '../lib/useRefresh';
import AppRefreshControl from '../components/AppRefreshControl';
import { SkeletonList } from '../components/Skeleton';
import { refusalMessage } from '../lib/refusals';
import { discardPlaySession, getSessionPlayWindows, listMyPlaySessions, listSessionShareMatches, PLAY_HISTORY_PAGE, type PlayHistoryRow } from '../data/playSessions';
import { currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { isImageShareAvailable } from '@just-messin-around/expo-foundation/platform';
import { supabase } from '../lib/supabase';
import PickleShareStudio from '../components/share/PickleShareStudio';
import DrillShareStudio, { type DrillShareTarget } from '../components/share/DrillShareStudio';
import { minutesBetween, playMix, sessionCardModel, sessionTally, type ShareCardModel } from '../lib/shareCards';
import { cardPlayer } from '../lib/finishShare';
import { useBlockedIds } from '../lib/moderation';
import {
  PLAY_KIND_LABEL,
  playHistoryDay,
  matchCountLabel,
  mergeHistory,
  nextHistoryCursor,
  playHistoryStatus,
  playHistoryTitle,
  playHistoryWhen,
} from '../lib/playHistory';
import { openMatchEntryForSession } from '../lib/navigationRef';
import { historyAdds, loggedDrillDraftId } from '../lib/sessionAdds';
import DrillReviewModal, { type ReviewableDrill } from '../components/DrillReviewModal';
import type { RootStackParamList } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'PlayHistory'>;

export default function PlayHistoryScreen(_props: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const toast = useToast();
  const [rows, setRows] = useState<PlayHistoryRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notReady, setNotReady] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [discarding, setDiscarding] = useState<PlayHistoryRow | null>(null);
  const [busy, setBusy] = useState(false);
  // Share a session (PKL-013): its matches load on tap.
  const blocked = useBlockedIds();
  const canShare = isImageShareAvailable();
  const [shareModel, setShareModel] = useState<ShareCardModel | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [sharing, setSharing] = useState<string | null>(null);
  // A drill session gets the drill card (its review, focus, weeks of work).
  const [drillShare, setDrillShare] = useState<DrillShareTarget | null>(null);
  // Add a drill: its review sheet (log_session_drill).
  const [logging, setLogging] = useState<ReviewableDrill | null>(null);
  const openShare = async (r: PlayHistoryRow) => {
    if (sharing) return;
    if (r.kind === 'drill') {
      setDrillShare({ playSessionId: r.id });
      return;
    }
    setSharing(r.id);
    try {
      const me = await currentUserId(supabase);
      const [rows, windows] = await Promise.all([
        me ? listSessionShareMatches(r) : Promise.resolve([]),
        getSessionPlayWindows(r.id),
      ]);
      const tally = me ? sessionTally(rows, me, r) : { games: 0, wins: 0, losses: 0, people: [] as string[] };
      const profiles = new Map<string, { id: string; full_name: string | null; deleted_at?: string | null }>();
      for (const m of rows) for (const p of [m.player1, m.partner1, m.player2, m.partner2]) if (p) profiles.set(p.id, p);
      setShareModel(sessionCardModel({
        court: r.venueName,
        kindLabel: PLAY_KIND_LABEL[r.kind] ?? 'Play',
        date: playHistoryDay(new Date(r.startedAt), new Date()),
        minutes: minutesBetween(r.startedAt, r.endedAt),
        mix: playMix(windows, r.startedAt, r.endedAt),
        games: tally.games,
        wins: tally.games > 0 ? tally.wins : null,
        losses: tally.games > 0 ? tally.losses : null,
        people: tally.people.map((id) => {
          const p = profiles.get(id);
          return cardPlayer({ id, fullName: p?.full_name ?? null, deleted: !!p?.deleted_at }, blocked);
        }),
      }));
      setShareOpen(true);
    } catch (e) {
      toast.error(friendlySbMessage(e, "Couldn't load that session's matches. Try again."));
    } finally {
      setSharing(null);
    }
  };
  // A slower first page never overwrites a newer one.
  const seq = useRef(0);

  const load = useCallback(async () => {
    const token = ++seq.current;
    try {
      const page = await listMyPlaySessions(null);
      if (token !== seq.current) return;
      setRows(page);
      setCursor(nextHistoryCursor(page, PLAY_HISTORY_PAGE));
      setError(null);
      setNotReady(false);
    } catch (e) {
      if (token !== seq.current) return;
      if (classifySbError(e) === 'missingFunction') setNotReady(true);
      else setError(e);
    }
  }, []);
  // On every visit: back from Add a match, the row says whether it counts now.
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  const refresh = useRefresh(load);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await listMyPlaySessions(cursor);
      setRows((prev) => mergeHistory(prev ?? [], page));
      setCursor(nextHistoryCursor(page, PLAY_HISTORY_PAGE));
    } catch {
      // The end of the list stays where it is; scrolling again retries.
    } finally {
      setLoadingMore(false);
    }
  };

  const discard = async () => {
    const row = discarding;
    if (!row) return;
    setBusy(true);
    try {
      await discardPlaySession(row.id);
      setRows((prev) => (prev ?? []).filter((r) => r.id !== row.id));
      setDiscarding(null);
      toast.info('Session discarded');
    } catch (e) {
      setDiscarding(null);
      if (classifySbError(e) === 'missingFunction') {
        toast.error("Discarding sessions isn't ready yet. Try again later.");
      } else {
        toast.error(refusalMessage(e) ?? friendlySbMessage(e, "Couldn't discard that session. Try again."));
      }
      if (refusalMessage(e)) void load();
    } finally {
      setBusy(false);
    }
  };

  const now = Date.now();
  const renderRow = ({ item: r }: { item: PlayHistoryRow }) => {
    const status = playHistoryStatus(r);
    const adds = historyAdds(r, now);
    const matches = matchCountLabel(r.matchCount);
    return (
      <ListCard
        style={S.row}
        title={<Text style={t.title} numberOfLines={2}>{playHistoryTitle(r)}</Text>}
        subtitle={
          <View style={S.sub}>
            <Text style={t.meta} numberOfLines={1}>{playHistoryWhen(r, now)}</Text>
            <View style={S.statusLine}>
              <Badge label={status.label} tone={status.tone} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE} />
              {matches ? <Text style={t.meta}>{matches}</Text> : null}
            </View>
            {status.note ? <Text style={[t.meta, { color: c.textSub }]} numberOfLines={2}>{status.note}</Text> : null}
            {adds.match || adds.drill ? (
              <View style={S.adds}>
                {adds.match ? (
                  <Button
                    title="Add a match"
                    size="sm"
                    variant="outline"
                    iconName="plus"
                    onPress={() => openMatchEntryForSession(r.id)}
                    accessibilityLabel={`Add a match to ${playHistoryTitle(r)}, ${playHistoryWhen(r, now)}`}
                  />
                ) : null}
                {adds.drill ? (
                  <Button
                    title="Add a drill"
                    size="sm"
                    variant="outline"
                    iconName="plus"
                    onPress={() => setLogging({
                      id: loggedDrillDraftId(r.id),
                      partner_name: '',
                      logForPlaySession: r.id,
                      heading: `Your drill · ${playHistoryWhen(r, now)}`,
                    })}
                    accessibilityLabel={`Add a drill to ${playHistoryTitle(r)}, ${playHistoryWhen(r, now)}`}
                  />
                ) : null}
              </View>
            ) : null}
          </View>
        }
        trailing={
          <View style={S.actions}>
          {canShare ? (
            <Pressable
              onPress={() => void openShare(r)}
              hitSlop={8}
              disabled={sharing != null}
              style={({ pressed }) => [S.more, (pressed || sharing === r.id) && { opacity: 0.6 }]}
              accessibilityRole="button"
              accessibilityLabel={`Share ${playHistoryTitle(r)}, ${playHistoryWhen(r, now)}`}
            >
              <Icon name="share" size={18} color={c.primary} />
            </Pressable>
          ) : null}
          <Pressable
            onPress={() => setDiscarding(r)}
            hitSlop={8}
            style={({ pressed }) => [S.more, pressed && { opacity: 0.6 }]}
            accessibilityRole="button"
            accessibilityLabel={`Discard ${playHistoryTitle(r)}, ${playHistoryWhen(r, now)}`}
          >
            <Icon name="trash" size={18} color={c.textMuted} />
          </Pressable>
          </View>
        }
        accessibilityLabel={`${playHistoryTitle(r)}, ${playHistoryWhen(r, now)}, ${status.label}`}
      />
    );
  };

  if (notReady) {
    return (
      <View style={[S.screen, { backgroundColor: c.bg }]}>
        <EmptyState iconName="clock" title="Play history is almost here" subtitle="Your past sessions show here soon. Check back later today." />
      </View>
    );
  }
  if (error && !rows) {
    return (
      <View style={[S.screen, { backgroundColor: c.bg }]}>
        <ErrorState error={error} onRetry={() => void load()} />
      </View>
    );
  }
  if (!rows) {
    return (
      <View style={[S.screen, S.pad, { backgroundColor: c.bg }]}>
        <SkeletonList rows={5} />
      </View>
    );
  }

  return (
    <>
      <FlatList
        style={{ backgroundColor: c.bg }}
        contentContainerStyle={S.pad}
        data={rows}
        keyExtractor={(r) => r.id}
        renderItem={renderRow}
        onEndReached={() => void loadMore()}
        onEndReachedThreshold={0.5}
        refreshControl={<AppRefreshControl {...refresh} />}
        ListHeaderComponent={
          rows.length ? (
            <Text style={[t.meta, S.header, { color: c.textSub }]}>
              A session counts once it lasts 5 minutes and has a match or drill. Add one for up to 7 days after it ends. Discard one you didn't mean to start.
            </Text>
          ) : null
        }
        ListEmptyComponent={
          <EmptyState
            iconName="clock"
            title="No play sessions yet"
            subtitle="Check in at a court or tap Play. Each session shows here once it ends."
          />
        }
      />
      {shareModel ? (
        <PickleShareStudio
          visible={shareOpen}
          onClose={() => setShareOpen(false)}
          title="Share this session"
          model={shareModel}
        />
      ) : null}
      <DrillShareStudio target={drillShare} onClose={() => setDrillShare(null)} />
      <DrillReviewModal
        session={logging}
        onClose={() => setLogging(null)}
        onSubmitted={() => {
          setLogging(null);
          void load();
        }}
        onShare={(drillSessionId) => setTimeout(() => setDrillShare({ drillSessionId }), 350)}
      />
      <ConfirmModal
        visible={!!discarding}
        title="Discard this session?"
        body={discarding
          ? `${playHistoryTitle(discarding)}, ${playHistoryWhen(discarding, now)}. It leaves your history and won't count. Matches you recorded stay.`
          : ''}
        primaryLabel="Discard"
        variant="danger"
        busy={busy}
        onConfirm={() => void discard()}
        onClose={() => { if (!busy) setDiscarding(null); }}
      />
    </>
  );
}

const S = StyleSheet.create({
  screen: { flex: 1 },
  pad: { padding: SPACE.lg, gap: SPACE.sm },
  header: { marginBottom: SPACE.sm },
  row: { marginBottom: SPACE.sm },
  sub: { gap: SPACE.xs, marginTop: SPACE.xs },
  statusLine: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  adds: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, marginTop: SPACE.xs },
  actions: { flexDirection: 'row', alignItems: 'center' },
  more: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
});
