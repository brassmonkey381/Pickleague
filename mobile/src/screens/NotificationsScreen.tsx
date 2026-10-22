// Notifications (plan section 8, P3): a compact, filterable, paged list.
//
//   [All] [Requests] [Unread] [Leagues] [Tournaments] [Rewards]   Mark all read
//   TODAY
//   (🏆) Tournament invite: Fall Open                      5m ago   ✕
//        Sam invited you to "Fall Open". Tap to accept or decline,
//        or use invite code ABC-123 if you'd rather join by code.
//   YESTERDAY ...
//
// - Chips are keyed on entity_type / category / push_data.kind, NEVER on the
//   legacy `type` column: every payout, badge and pickle notice is written with
//   type='tournament', so a type chip would file rewards under Tournaments
//   (lib/inboxRequests.ts has the mapping and the generators it came from).
//   Each chip filters on the server, so paging walks that chip's rows.
// - Paged: 50 at a time, "Load more" for the next 50. Paging is by keyset
//   (the last row's created_at + id), not by offset: deleting a row, or
//   reading one under Unread, takes it out of the server's set, and an offset
//   would then skip the rows that moved up into its place. A refresh
//   refetches as many as are showing (up to MAX_REFETCH), so it doesn't snap
//   back to 50.
// - A row whose target was deleted (its league / tournament / event / match /
//   drill is gone) is greyed out with "No longer available", and a tap only
//   marks it read and opens its full text instead of navigating nowhere.
//   Home's bell leaves those out of its dot too (homeData's unreadLive).
// - Every row has a visible delete (✕, a 44 box) BESIDE the card, not inside
//   it: the card is one touchable, so VoiceOver can't reach a button nested in
//   it (and on web it would be a press inside a press). The old hidden
//   long-press delete is gone: it deleted with no confirmation on a slow press.
// - Bodies clamp to 2 lines with a "more" under a long one (the row tap still
//   navigates). A row that has nowhere to go (deleted target or no route)
//   also expands on tap.
// - A failed "mark all read" / delete puts every chip's cached page back as
//   it was (a refetch alone can't, offline, and only covers the current chip).
// - "Clear all" (header right, shown while there is anything to clear) deletes
//   EVERY notification of mine in one delete, behind a ConfirmModal: not just
//   the loaded page or the current chip. It waits for the server (no
//   optimistic wipe: it can't be undone, and a failure leaves the list as it
//   was), then empties every chip's cached page and zeroes Home's cached
//   unread so the bell's dot goes at once (Home also refetches on focus).
//   Pending requests themselves survive: Up next's needs-you items come from
//   their own tables (lib/inboxRequests, lib/agenda), never from notification
//   rows. But the Requests chip IS notification rows, so it empties, and Up
//   next's "+N more" (which lands there) then shows nothing for requests cut
//   past its cap; the confirm says so rather than promising "they stay in Up
//   next". The one thing that lives ONLY in a notification is a league invite
//   code (the invite-code broadcast; tournament codes also make a
//   registration), and the confirm says that too.
//   A list fetch (focus refresh, chip fetch, Load more) still in flight when
//   Clear all lands read its rows before the delete: `clearGen` makes it hand
//   back the cleared page instead of writing the deleted rows back.
// - initialChip ('requests'): Home's Up next "+N more" lands on Requests.
// - A tap goes where the same push would (lib/pushLinks.ts linkOf + routeLink),
//   and an invite with an embedded code auto-redeems first, as before.
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect, type RouteProp } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { sbCall, friendlySbMessage, currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { useCachedQuery, setQueryData, peekQuery } from '@just-messin-around/expo-foundation/cache';
import { ConfirmModal, FilterChipRow, ListCard, SectionHeader, SkeletonList } from '@just-messin-around/expo-foundation/ui';
import { HOME_KEY, type HomeData } from '../components/home/homeData';
import { SPACE, RADIUS, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { RootStackParamList } from '../types';
import { useTheme } from '../lib/ThemeContext';
import { linkOf } from '../lib/pushLinks';
import { routeLink } from '../lib/push';
import { openDiscover } from '../lib/discoverNav';
import { redeemLeagueInvite } from '../data/leagueInvites';
import { entityTileColors, type EntityKind } from '../lib/entityGlyph';
import {
  NOTIFICATION_CHIPS,
  chipServerFilter,
  findMissingTargets,
  groupByDay,
  matchesNotificationChip,
  notificationTime,
  type DayGroupItem,
  type NotificationChip,
} from '../lib/inboxRequests';
import { useStatusMessage } from '../lib/useStatusMessage';
import StatusBanner from '../components/StatusBanner';
import { useRefresh } from '../lib/useRefresh';
import AppRefreshControl from '../components/AppRefreshControl';
import EmptyState from '../components/EmptyState';
import FriendsLink from '../components/FriendsLink';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Notifications'>;
  route: RouteProp<RootStackParamList, 'Notifications'>;
};

type Notification = {
  id: string;
  title: string;
  body: string;
  type: string;
  entity_id: string | null;
  entity_type: string | null;
  /** The generator's preference key (migration_notification_generators.sql). */
  category: string | null;
  is_read: boolean;
  created_at: string;
  /** Generator hints (migration_push_data.sql); kind refines where a tap goes. */
  push_data?: { deep_link?: unknown; kind?: unknown; invite_code?: unknown } | null;
};

/** One chip's loaded list, as cached. */
type NotificationPage = {
  rows: Notification[];
  /** Ids of rows whose target no longer exists. */
  missing: string[];
  /** Rows the server returned (before the client-side chip check): how many
   *  a refresh refetches so the list doesn't shrink. Never an offset. */
  fetched: number;
  /** The last RAW row returned (before the client-side chip check, so the
   *  Requests chip's over-matches can't stall it): the next page starts
   *  strictly after it in (created_at desc, id desc) order. */
  cursor: Cursor | null;
  hasMore: boolean;
  /** Every unread notification (all chips), for "Mark all read". */
  unreadTotal: number;
  /** Every notification (all chips), for "Clear all". Absent in a page cached
   *  before it, or when the count query failed (then only the All chip's
   *  fully loaded rows can stand in for it). */
  total?: number;
};

type Cursor = { created_at: string; id: string };

const PAGE = 50;
/** A refresh refetches what is showing, up to this many rows. */
const MAX_REFETCH = 200;
const COLUMNS = 'id, title, body, type, entity_id, entity_type, category, is_read, created_at, push_data';
// v3: keyset pages (a `cursor`). v2 pages (offset-paged, no cursor) and the
// v1 key ('notifications:list', a bare array) are simply never read again.
const KEY_PREFIX = 'notifications:v3';
const keyFor = (chip: NotificationChip) => `${KEY_PREFIX}:${chip}`;
const DB = { client: supabase, call: sbCall };
/** Every chip's page right after "Clear all". */
const EMPTY_PAGE: NotificationPage = {
  rows: [], missing: [], fetched: 0, cursor: null, hasMore: false, unreadTotal: 0, total: 0,
};
/** Bumped by "Clear all" (before and after its delete). A list fetch that
 *  began before a bump read rows the delete then removed, so its result is
 *  dropped. Since foundation 1.50 the cache also reruns a fetch that a
 *  setQueryData on its key outran, so a chip refresh alone would no longer
 *  write the deleted rows back; this stays because Load more reads outside the
 *  cache and writes with setQueryData, and a fetch that lands before Clear
 *  all's setQueryData is caught here too. Module-level, so it also covers a
 *  fetch still running for another chip's key. */
let clearGen = 0;

/** A chip's rows, newest first, with `id` breaking created_at ties (one
 *  transaction's notifications share now()), so the order is total. The
 *  first `limit`, or with `after`: older than it, or (`tieOf`) its own
 *  timestamp with a lower id. */
function pageQuery(chip: NotificationChip, limit: number, after?: { older: Cursor } | { tieOf: Cursor }) {
  let q = supabase
    .from('notifications')
    .select(COLUMNS)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false });
  if (after && 'tieOf' in after) q = q.eq('created_at', after.tieOf.created_at).lt('id', after.tieOf.id);
  else if (after) q = q.lt('created_at', after.older.created_at);
  const f = chipServerFilter(chip);
  if (f.kind === 'eq') q = q.eq(f.column, f.value);
  else if (f.kind === 'in') q = q.in(f.column, [...f.values]);
  else if (f.kind === 'or') q = q.or(f.filter);
  return q.limit(limit);
}

/** The first `limit` rows, or the `limit` rows after `after`. The keyset
 *  "(created_at, id) < cursor" runs as two plain queries (the cursor's
 *  same-timestamp rows with a lower id, then everything older) merged in
 *  order, rather than one `or`: the Requests chip already spends the
 *  query's `or`. */
async function fetchRaw(chip: NotificationChip, limit: number, after: Cursor | null): Promise<Notification[]> {
  if (!after) return ((await sbCall(() => pageQuery(chip, limit))) ?? []) as Notification[];
  const [ties, older] = await Promise.all([
    sbCall(() => pageQuery(chip, limit, { tieOf: after })),
    sbCall(() => pageQuery(chip, limit, { older: after })),
  ]);
  return [...((ties ?? []) as Notification[]), ...((older ?? []) as Notification[])].slice(0, limit);
}

/** A chip's rows (see fetchRaw), checked against the chip rule and for
 *  deleted targets. The deleted check is soft: a failed lookup leaves rows
 *  normal. */
async function fetchRows(chip: NotificationChip, limit: number, after: Cursor | null) {
  const raw = await fetchRaw(chip, limit, after);
  const rows = raw.filter(n => matchesNotificationChip(n, chip));
  const missing = await findMissingTargets(DB, rows).catch(() => new Set<string>());
  return { raw, rows, missing };
}

/** The keyset position after these raw rows (the last one). */
function cursorOf(raw: readonly Notification[]): Cursor | null {
  const last = raw[raw.length - 1];
  return last ? { created_at: last.created_at, id: last.id } : null;
}

async function loadPage(chip: NotificationChip): Promise<NotificationPage> {
  const gen = clearGen;
  // Keep what is showing on a refresh (the cached page's row count), else one page.
  const showing = peekQuery<NotificationPage>(keyFor(chip))?.fetched ?? PAGE;
  const count = Math.min(MAX_REFETCH, Math.max(PAGE, showing));
  const [{ raw, rows, missing }, unreadRes, totalRes] = await Promise.all([
    fetchRows(chip, count, null),
    supabase.from('notifications').select('id', { count: 'exact', head: true }).eq('is_read', false),
    supabase.from('notifications').select('id', { count: 'exact', head: true }),
  ]);
  // A Clear all landed while this was in flight: these rows were read before
  // the delete, so keep the cleared page rather than writing them back.
  if (gen !== clearGen) return peekQuery<NotificationPage>(keyFor(chip)) ?? EMPTY_PAGE;
  return {
    rows,
    missing: [...missing],
    fetched: raw.length,
    cursor: cursorOf(raw),
    hasMore: raw.length === count,
    unreadTotal: unreadRes.count ?? rows.filter(n => !n.is_read).length,
    total: totalRes.error ? undefined : (totalRes.count ?? undefined),
  };
}

/** A body longer than this (or with a line break) likely runs past 2 lines on
 *  a phone, so it gets a "more". A length check, not onTextLayout: that never
 *  fires on react-native-web, and with numberOfLines set iOS reports only the
 *  visible lines. On a wide web window "more" may show on a body that fits;
 *  the tap then just reads "less". */
const LONG_BODY_CHARS = 70;
const isLongBody = (body: string) => body.length > LONG_BODY_CHARS || body.includes('\n');

/** A row's screen-reader actions: the same delete as its visible ✕. */
const DELETE_ACTIONS = [{ name: 'delete', label: 'Delete' }];

// The invite code on a notice: push_data.invite_code (league invites from
// send_invite_code_to_users, migration_push_actions_match_tournament.sql),
// else the body's "...invite code TOKEN" (older notices and tournament
// invites; format in migration_invite_code_broadcast.sql).
function extractInviteCode(n: { body: string; push_data?: Record<string, unknown> | null }): string | null {
  const fromData = n.push_data?.invite_code;
  if (typeof fromData === 'string' && fromData.trim()) return fromData.trim();
  const m = n.body.match(/invite code ([A-Z0-9-]+)/i);
  return m ? m[1] : null;
}

/** The row's glyph, by entity_type (never `type`). */
function glyphFor(entityType: string | null): { glyph: string; kind: EntityKind } {
  switch (entityType) {
    case 'tournament': return { glyph: '🏆', kind: 'tournament' };
    case 'league': return { glyph: '🎾', kind: 'league' };
    case 'event': return { glyph: '📅', kind: 'event' };
    case 'match': return { glyph: '🏅', kind: 'match' };
    case 'drill': return { glyph: '🏓', kind: 'drill' };
    case 'shop': return { glyph: '🥒', kind: 'pickles' };
    case 'shop_item': return { glyph: '🛒', kind: 'shop' };
    case 'profile': return { glyph: '🎖️', kind: 'player' };
    case 'plupr_history': return { glyph: '📈', kind: 'player' };
    case 'wager':
    case 'wager_on_me': return { glyph: '🎲', kind: 'pickles' };
    case 'friend': return { glyph: '🤝', kind: 'player' };
    default: return { glyph: '📣', kind: 'shop' };
  }
}

export default function NotificationsScreen({ navigation, route }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const status = useStatusMessage();
  // On web the param is in the URL (?initialChip=requests), so it is read by
  // value, then cleared: a refresh after switching chips keeps the user's
  // chip instead of snapping back to Requests.
  const [chip, setChip] = useState<NotificationChip>(
    () => (route.params?.initialChip === 'requests' ? 'requests' : 'all'),
  );
  // Also honours the param arriving on an already-mounted screen (a navigate
  // to a Notifications route that is in the stack updates its params).
  const initialChip = route.params?.initialChip;
  useEffect(() => {
    if (initialChip == null) return;
    if (initialChip === 'requests') setChip('requests');
    navigation.setParams({ initialChip: undefined });
  }, [initialChip, navigation]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [loadingMore, setLoadingMore] = useState(false);

  const query = useCachedQuery<NotificationPage>(keyFor(chip), () => loadPage(chip), {
    ttlMs: 30_000,
    persistMs: 24 * 60 * 60 * 1000,
  });
  const page = query.data;
  const rows = page?.rows ?? [];
  const missing = useMemo(() => new Set(page?.missing ?? []), [page?.missing]);
  // "All quiet here!" is only honest once a fetch actually succeeded — a dead
  // connection with nothing cached gets a retry affordance instead.
  const loadFailed = query.error != null && page === undefined;

  const reload = useCallback(() => query.refresh(), [query.refresh]);
  const refresh = useRefresh(reload);
  useFocusEffect(useCallback(() => { void reload(); }, [reload]));

  // "now" for the day headers and times: re-read with every payload.
  const now = useMemo(() => Date.now(), [page]);
  const items = useMemo(() => groupByDay(rows, now), [rows, now]);

  // Local edits write through every chip's cached list (a row read or deleted
  // under Unread is also read or deleted under All), not component state,
  // which the next revalidation would overwrite.
  function patchAll(
    fn: (n: Notification) => Notification | null,
    unreadDelta: (p: NotificationPage) => number,
    totalDelta = 0,
  ) {
    for (const { value } of NOTIFICATION_CHIPS) {
      const key = keyFor(value);
      const cur = peekQuery<NotificationPage>(key);
      if (!cur) continue;
      const next: Notification[] = [];
      for (const n of cur.rows) {
        const m = fn(n);
        if (m) next.push(m);
      }
      setQueryData(key, {
        ...cur,
        rows: next,
        unreadTotal: Math.max(0, cur.unreadTotal + unreadDelta(cur)),
        total: cur.total == null ? undefined : Math.max(0, cur.total + totalDelta),
      });
    }
  }

  // A failed write puts back every chip's cached page exactly as it was. A
  // refetch alone can't do this offline (it fails too, and the optimistic
  // pages stay, persisted for a day), and it only covers the current chip.
  function snapshotAll(): Array<[string, NotificationPage]> {
    const out: Array<[string, NotificationPage]> = [];
    for (const { value } of NOTIFICATION_CHIPS) {
      const key = keyFor(value);
      const cur = peekQuery<NotificationPage>(key);
      if (cur) out.push([key, cur]);
    }
    return out;
  }
  function restoreAll(snap: ReadonlyArray<[string, NotificationPage]>) {
    for (const [key, saved] of snap) setQueryData(key, saved);
  }

  async function markRead(n: Notification) {
    if (n.is_read) return;
    const id = n.id;
    patchAll(x => (x.id === id ? { ...x, is_read: true } : x), () => -1);
    try {
      await sbCall(() => supabase.from('notifications').update({ is_read: true }).eq('id', id));
    } catch {
      // Roll the optimistic read-state back so the counts stay truthful.
      patchAll(x => (x.id === id ? { ...x, is_read: false } : x), () => 1);
    }
  }

  async function markAllRead() {
    const snap = snapshotAll();
    patchAll(x => (x.is_read ? x : { ...x, is_read: true }), p => -p.unreadTotal);
    try {
      await sbCall(() => supabase.from('notifications').update({ is_read: true }).eq('is_read', false));
    } catch (e) {
      restoreAll(snap);
      status.error(friendlySbMessage(e, "Couldn't mark them read."));
      void reload();
    }
  }

  async function deleteNotification(n: Notification) {
    const id = n.id;
    const wasUnread = !n.is_read;
    const snap = snapshotAll();
    patchAll(x => (x.id === id ? null : x), () => (wasUnread ? -1 : 0), -1);
    try {
      await sbCall(() => supabase.from('notifications').delete().eq('id', id));
    } catch (e) {
      restoreAll(snap);
      status.error(friendlySbMessage(e, "Couldn't delete that notification."));
      void reload();
    }
  }

  // "Clear all": every notification of mine, whatever is loaded or filtered.
  // `clearCount` is the N the confirm shows, read when it opens (null: unknown,
  // so it says "all your notifications"). Without a `total` (a page cached
  // before it, or a failed count) only the All chip's rows can stand in, and
  // only when fully loaded: another chip's rows are a filtered subset, and the
  // delete takes every chip's.
  const [clearCount, setClearCount] = useState<number | null | undefined>(undefined);
  const [clearing, setClearing] = useState(false);
  const confirmOpen = clearCount !== undefined;

  function openClearAll() {
    const p = peekQuery<NotificationPage>(keyFor(chip));
    setClearCount(p?.total ?? (chip === 'all' && p && !p.hasMore ? p.rows.length : null));
  }

  async function clearAll() {
    if (clearing) return;
    setClearing(true);
    // Before the delete is sent, so a fetch whose read races it is dropped too.
    clearGen += 1;
    try {
      const uid = await currentUserId(supabase);
      if (!uid) throw new Error('Not signed in.');
      // One delete, keyed on the owner (RLS "Users delete own notifications"
      // allows exactly these rows), so it reaches past the loaded page.
      await sbCall(() => supabase.from('notifications').delete().eq('user_id', uid));
    } catch (e) {
      // Nothing was touched locally, so the list is already as it was.
      setClearing(false);
      setClearCount(undefined);
      status.error(friendlySbMessage(e, "Couldn't clear your notifications."));
      // The bump above may have dropped a refresh that was in flight.
      void reload();
      return;
    }
    // Again after it: a fetch that started while the delete ran may have read
    // the rows before it committed.
    clearGen += 1;
    // Every chip's page is now empty: set them all (an unvisited chip too, so
    // it doesn't flash a persisted list before its first fetch).
    for (const { value } of NOTIFICATION_CHIPS) setQueryData(keyFor(value), EMPTY_PAGE);
    // Home's bell dot reads its cached unread; zero it now rather than on
    // Home's next focus fetch. The number (what needs you) is not from here.
    const home = peekQuery<HomeData>(HOME_KEY);
    if (home) setQueryData(HOME_KEY, { ...home, unreadCount: 0, unreadLive: 0 });
    setExpanded(new Set());
    setClearing(false);
    setClearCount(undefined);
    status.success('Notifications cleared.');
  }

  async function loadMore() {
    if (!page || !page.hasMore || !page.cursor || loadingMore) return;
    const key = keyFor(chip);
    setLoadingMore(true);
    const gen = clearGen;
    try {
      // One row past the page says whether another page exists, so the last
      // "Load more" is never an empty one.
      const next = await fetchRows(chip, PAGE + 1, page.cursor);
      // Cleared meanwhile: this page's rows are gone on the server.
      if (gen !== clearGen) return;
      const raw = next.raw.slice(0, PAGE);
      const inPage = new Set(raw.map(n => n.id));
      const cur = peekQuery<NotificationPage>(key) ?? page;
      // The keyset never returns a row already shown; this dedupe only covers
      // a refresh that landed while this page was in flight.
      const seen = new Set(cur.rows.map(n => n.id));
      setQueryData(key, {
        ...cur,
        rows: [...cur.rows, ...next.rows.filter(n => inPage.has(n.id) && !seen.has(n.id))],
        missing: [...cur.missing, ...[...next.missing].filter(id => inPage.has(id))],
        fetched: cur.fetched + raw.length,
        cursor: cursorOf(raw) ?? cur.cursor,
        hasMore: next.raw.length > PAGE,
      });
    } catch (e) {
      status.error(friendlySbMessage(e, "Couldn't load more notifications."));
    } finally {
      setLoadingMore(false);
    }
  }

  // League/tournament invite notifications embed a code in their body. Tapping
  // one auto-redeems it and jumps straight to the joined scope's detail. If the
  // redeem fails (revoked/expired/etc.) we fall back to the manual Join-with-Code
  // page so the user can retry. Returns true if it handled an invite code.
  async function tryAutoAcceptInvite(n: Notification): Promise<boolean> {
    const code = extractInviteCode(n);
    if (!code) return false;

    // League codes take the one shared path (data/leagueInvites, also the
    // push's Join button): it treats "already a member" as success.
    if (n.entity_type === 'league') {
      let res: Awaited<ReturnType<typeof redeemLeagueInvite>> | null = null;
      try { res = await redeemLeagueInvite(code); } catch { res = null; }
      if (!res?.joined) {
        openDiscover(navigation, { tab: 'leagues', prefillInviteCode: code });
        return true;
      }
      navigation.navigate('LeagueDetail', { leagueId: res.leagueId, leagueName: res.leagueName ?? 'League' });
      return true;
    }

    // Tournaments: the raw RPC.
    const { data, error } = await supabase.rpc('redeem_invite_code', { p_token: code });
    const row = Array.isArray(data) ? data[0] : data;

    if (error || !row?.success) {
      // Fall back to the current behavior — manual retry on the Leagues
      // Join-with-Code page (Discover's Leagues tab).
      openDiscover(navigation, { tab: 'leagues', prefillInviteCode: code });
      return true;
    }

    // Landing on the joined scope's detail is itself the confirmation. We don't
    // set a success banner here: this screen unmounts on navigate before it
    // could paint (and the banner would otherwise resurface stale on back-nav).
    if (row.scope_type === 'tournament') {
      navigation.navigate('TournamentDetail', { tournamentId: row.scope_id, tournamentName: row.scope_name });
    } else {
      navigation.navigate('LeagueDetail', { leagueId: row.scope_id, leagueName: row.scope_name });
    }
    return true;
  }

  function linkFor(n: Notification): string {
    const deepLink = typeof n.push_data?.deep_link === 'string' ? n.push_data.deep_link : undefined;
    const kind = typeof n.push_data?.kind === 'string' ? n.push_data.kind : undefined;
    return linkOf({ entity_type: n.entity_type, entity_id: n.entity_id, deepLink, kind });
  }

  function toggleExpanded(id: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleTap(n: Notification) {
    void markRead(n);
    // Its target is gone: nothing to open. Show the whole text instead.
    if (missing.has(n.id)) { toggleExpanded(n.id); return; }
    // League/tournament invites carry an embedded code → auto-accept.
    if ((n.entity_type === 'tournament' || n.entity_type === 'league') && (await tryAutoAcceptInvite(n))) return;
    // Everything else goes where the same push would (lib/pushLinks.ts),
    // refined by its kind: a drill chat opens its thread, a join request opens
    // the members screen, an organizer nudge opens the text composer. The wager screens stay gated there
    // (they are not registered while wagering is off). Unrouted: stay here,
    // and show the whole text.
    const link = linkFor(n);
    if (!link || !routeLink(link)) toggleExpanded(n.id);
  }

  const unreadTotal = page?.unreadTotal ?? 0;
  const chipLabel = NOTIFICATION_CHIPS.find(x => x.value === chip)?.label ?? 'All';
  // Anything to clear at all (every chip's rows, not just this chip's). With
  // no total, an empty filtered chip says nothing about the others: show it.
  const canClear = page?.total != null ? page.total > 0 : chip === 'all' ? rows.length > 0 : true;

  // Header right: "Clear all", a real 44 box (RNW ignores hitSlop).
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: canClear
        ? () => (
            <TouchableOpacity
              style={styles.headerAction}
              onPress={openClearAll}
              activeOpacity={0.6}
              accessibilityRole="button"
              accessibilityLabel="Clear all notifications"
            >
              <Text style={[t.meta, { color: c.danger }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
                Clear all
              </Text>
            </TouchableOpacity>
          )
        : undefined,
    });
    // openClearAll reads the live cache, so a stale closure is harmless; t is
    // rebuilt per render from the same colors.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigation, canClear, chip, c]);

  const clearBody =
    (clearCount == null
      ? 'This deletes all your notifications.'
      : clearCount === 1
        ? 'This deletes your 1 notification.'
        : `This deletes all ${clearCount} notifications.`) +
    " This also empties the Requests tab. Pending requests aren't deleted: answer them from Up next on Home" +
    ' or from the league or match screen. A league invite code is only in its notification, so it goes too.';

  const renderItem = ({ item }: { item: DayGroupItem<Notification> }) => {
    if (item.kind === 'header') {
      return <SectionHeader title={item.label} style={styles.dayHeader} />;
    }
    const n = item.row;
    const gone = missing.has(n.id);
    const open = expanded.has(n.id);
    const g = glyphFor(n.entity_type);
    const tile = entityTileColors(g.kind, c);
    const long = isLongBody(n.body);
    const time = notificationTime(n.created_at, now);
    // The ✕ is a SIBLING of the card, not its `trailing`: ListCard is one
    // touchable (accessible by default), so iOS VoiceOver can't focus a button
    // nested in it, and a screen-reader user could not delete at all.
    // The card names itself once, with the whole body (the "more" toggle
    // nested in it is a sighted-user affordance). On web a long row's card is
    // not a role=button: it holds the "more" button, and RNW renders both as
    // <button> (nested buttons are invalid HTML). So it gets no role and no
    // label either (aria-label is prohibited on a generic element); its text
    // and the "more" button read in order.
    // The card also offers "Delete" as a rotor / TalkBack action (native only:
    // RNW drops accessibility actions, so the visible ✕ stays).
    const webLong = long && Platform.OS === 'web';
    const a11yLabel = `${n.is_read ? '' : 'Unread: '}${n.title}, ${time}. ${n.body}${gone ? '. No longer available' : ''}`;
    return (
      <View style={styles.rowWrap}>
        <ListCard
          density="compact"
          align="top"
          style={styles.card}
          onPress={() => { void handleTap(n); }}
          accessibilityRole={webLong ? undefined : 'button'}
          accessibilityLabel={webLong ? undefined : a11yLabel}
          accessibilityActions={DELETE_ACTIONS}
          onAccessibilityAction={(e) => { if (e.nativeEvent.actionName === 'delete') void deleteNotification(n); }}
          leading={
            <View
              style={[styles.tile, { backgroundColor: tile.bg, borderColor: tile.border }, gone && styles.gone]}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              <Text style={styles.glyph} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>{g.glyph}</Text>
            </View>
          }
          title={
            <View style={styles.titleLine}>
              {!n.is_read ? <View style={[styles.unreadDot, { backgroundColor: c.primary }]} /> : null}
              <Text
                style={[t.title, styles.titleText, n.is_read && { color: c.textSub }, gone && styles.gone]}
                numberOfLines={open ? undefined : 1}
              >
                {n.title}
              </Text>
              <Text style={t.meta} numberOfLines={1} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
                {time}
              </Text>
            </View>
          }
          subtitle={
            <View style={gone ? styles.gone : undefined}>
              <Text style={[t.sub, styles.body]} numberOfLines={open ? undefined : 2}>{n.body}</Text>
              {long ? (
                // Nested in the card's touchable on purpose (sighted users tap it;
                // VoiceOver reads the card's whole text anyway): the inner press
                // wins on native, and react-native-web stops the click at the
                // first pressable, so "more" never also navigates. A real 44
                // box: web ignores hitSlop.
                <TouchableOpacity
                  style={styles.moreBox}
                  onPress={() => toggleExpanded(n.id)}
                  activeOpacity={0.6}
                  accessibilityRole="button"
                  accessibilityLabel={open ? 'Show less' : `Show full notification: ${n.title}`}
                >
                  <Text style={[t.meta, { color: c.primary }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
                    {open ? 'less' : 'more'}
                  </Text>
                </TouchableOpacity>
              ) : null}
              {gone ? (
                <Text style={[t.meta, styles.goneNote]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
                  No longer available
                </Text>
              ) : null}
            </View>
          }
        />
        <TouchableOpacity
          style={styles.deleteBox}
          onPress={() => { void deleteNotification(n); }}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel={`Delete notification: ${n.title}`}
        >
          <Text style={[t.title, { color: c.textMuted }]}>✕</Text>
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: c.bg }]}>
      {/* TODO: smoke-test in browser — auto-accept invite toast + deep-link */}
      <StatusBanner status={status.value} style={styles.banner} />
      <FilterChipRow<NotificationChip>
        size="md"
        options={NOTIFICATION_CHIPS.map(x => ({ value: x.value, label: x.label }))}
        value={chip}
        onChange={(v) => { setChip(v); setExpanded(new Set()); }}
        scrollToSelected
        wrapAtWidth={600}
        style={styles.chips}
        trailing={unreadTotal > 0 ? (
          <TouchableOpacity
            style={styles.markAll}
            onPress={() => { void markAllRead(); }}
            accessibilityRole="button"
            accessibilityLabel={`Mark all ${unreadTotal} notifications as read`}
          >
            <Text style={[t.meta, { color: c.primary }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
              Mark all read
            </Text>
          </TouchableOpacity>
        ) : undefined}
      />
      {query.loading && page === undefined && !loadFailed ? (
        <View style={styles.skeleton}><SkeletonList rows={6} variant="row" /></View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={i => i.key}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          refreshControl={<AppRefreshControl {...refresh} />}
          // Requests / Friends: a way to answer friend requests in one place
          // (FriendsLink renders nothing while friends are off).
          ListHeaderComponent={chip === 'requests' || chip === 'friends' ? (
            <FriendsLink style={styles.friendsLink} />
          ) : null}
          ListFooterComponent={page?.hasMore ? (
            <TouchableOpacity
              style={styles.more}
              onPress={() => { void loadMore(); }}
              disabled={loadingMore}
              accessibilityRole="button"
              accessibilityLabel="Load more notifications"
            >
              <Text style={[t.meta, { color: c.primary }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </Text>
            </TouchableOpacity>
          ) : null}
          ListEmptyComponent={
            loadFailed
              ? <EmptyState
                  icon="📡"
                  title="Couldn't load notifications"
                  subtitle={friendlySbMessage(query.error)}
                  actionLabel="Retry"
                  onAction={() => { void reload(); }}
                />
              : chip === 'all'
                ? <EmptyState
                    icon="🔔"
                    title="All quiet here!"
                    subtitle="You'll be notified when brackets are set, invites arrive, and more."
                  />
                : <EmptyState compact title={`Nothing under ${chipLabel}`} />
          }
        />
      )}
      <ConfirmModal
        visible={confirmOpen}
        title="Clear all notifications?"
        body={clearBody}
        primaryLabel="Clear all"
        variant="danger"
        busy={clearing}
        onConfirm={() => { void clearAll(); }}
        onClose={() => { if (!clearing) setClearCount(undefined); }}
      />
    </View>
  );
}

const TILE = 36;

const styles = StyleSheet.create({
  container: { flex: 1 },
  banner: { marginHorizontal: SPACE.lg, marginTop: SPACE.sm },
  chips: { paddingHorizontal: SPACE.lg },
  markAll: { minHeight: 44, minWidth: 44, justifyContent: 'center', paddingHorizontal: SPACE.sm },
  headerAction: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: SPACE.sm },
  skeleton: { paddingHorizontal: SPACE.lg },
  list: { paddingHorizontal: SPACE.lg, paddingBottom: SPACE.xl },
  dayHeader: { marginTop: SPACE.sm },
  friendsLink: { marginTop: SPACE.sm },
  tile: {
    minWidth: TILE,
    minHeight: TILE,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyph: { fontSize: FONT.size.xl, lineHeight: FONT.size.xl + SPACE.xs * 2 },
  // Title, then the time on the same line (the day is in the header above).
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minWidth: 0 },
  titleText: { flexShrink: 1, flexGrow: 1 },
  unreadDot: { width: SPACE.sm, height: SPACE.sm, borderRadius: RADIUS.pill },
  body: { marginTop: SPACE.xxs },
  gone: { opacity: 0.5 },
  goneNote: { marginTop: SPACE.xxs },
  // The card and its ✕ side by side, the ✕ level with the title line (the
  // compact card's top padding + half a title line is about half of 44).
  rowWrap: { flexDirection: 'row', alignItems: 'flex-start' },
  card: { flex: 1, minWidth: 0 },
  // The ✕: a real 44 box (react-native-web ignores hitSlop).
  deleteBox: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  // "more" / "less" under a long body: a real 44 box, hugging its text.
  moreBox: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignSelf: 'flex-start' },
  more: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
});
