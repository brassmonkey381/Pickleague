import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal, View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, ActivityIndicator, Platform, Pressable,
} from 'react-native';
import { friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { ErrorState } from '@just-messin-around/expo-foundation/ui';
import { HAIRLINE, RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { isServerRefusal } from '../lib/refusals';
import { useTheme } from '../lib/ThemeContext';
import { AVATARS } from '../data/profileCustomization';
import { listEveryone } from '../data/inviteSuggestions';
import { SEARCH_DEBOUNCE_MS, SHORT_QUERY_HINT, searchEmptyCopy, searchableQuery } from '../lib/playerSearch';
import EmptyState from './EmptyState';
import { ToastOutlet } from '@just-messin-around/expo-foundation/toast';

export type PickedUser = {
  id: string;
  full_name: string;
  username: string;
  avatar_id: number | null;
  avatar_emoji: string | null;
  avatar_bg_color: string | null;
  /** A line under the @username ("Plays at Lakeside Park · 2 mi"). */
  detail?: string | null;
  /** A group heading ("Near Alameda, CA", "Everywhere else"): shown above the
   *  first row of each run of rows with the same section. */
  section?: string | null;
};

type Props = {
  visible: boolean;
  title: string;
  excludeUserIds?: string[];     // hide self / already-owners
  /** Only people who can answer: leaves out unclaimed DUPR placeholders (472
   *  of 524 profiles; claiming one deletes it) and guest passes. Friends >
   *  Find sets it; every other picker keeps listing them. */
  realPeopleOnly?: boolean;
  /** Who to list instead of everyone (discover_players): Discover's Players
   *  search passes the players near its search area. Changing `loadKey`
   *  reloads it. */
  load?: () => Promise<PickedUser[]>;
  loadKey?: string;
  /** A line under the title ("Players near Alameda, CA · 5 mi"). */
  subtitle?: string | null;
  /** Searches by name (Discover's Players: everyone, the players near the
   *  area first). Set, a query of 2+ letters goes here (debounced) instead of
   *  filtering the loaded list; shorter, the loaded list is filtered. */
  search?: (query: string) => Promise<PickedUser[]>;
  onPick: (u: PickedUser) => void;
  onClose: () => void;
};

const IS_WEB = Platform.OS === 'web';

/** Why the player list didn't load, and what to do. A server refusal already
 *  says both; anything else (offline, a server not updated yet) gets a retry hint. */
function loadProblem(e: unknown): string {
  if (isServerRefusal(e)) return friendlySbMessage(e);
  return `${friendlySbMessage(e, "Couldn't load players.")} Check your connection, then tap Try again.`;
}

export default function UserPickerModal({
  visible, title, excludeUserIds, realPeopleOnly = false, load, loadKey, subtitle, search, onPick, onClose,
}: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);
  const t = textStyles(c);
  const [users, setUsers]     = useState<PickedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery]     = useState('');
  // Why the list didn't load (null: it did). Shown instead of "No matches."
  // so a failed read never looks like an empty search.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt]     = useState(0);

  useEffect(() => {
    if (!visible) return;
    let live = true;
    setLoading(true);
    setLoadError(null);
    // discover_players (migration_hide_test_accounts.sql): never deleted
    // accounts ([deleted account] tombstones keep shared match history intact,
    // they are not people you can pick), test accounts left out while God mode
    // hides them. Every page past its 500-row cap (data/inviteSuggestions'
    // listEveryone), so a name late in the alphabet is still found (the user,
    // 2026-10-24: "search all"). realPeopleOnly also leaves out unclaimed
    // placeholders and guest passes.
    if (load) {
      load().then((rows) => {
        if (!live) return;
        setUsers(rows);
        setLoading(false);
      }, (e: unknown) => {
        if (!live) return;
        setUsers([]);
        setLoadError(loadProblem(e));
        setLoading(false);
      });
      return () => { live = false; };
    }
    listEveryone<PickedUser>('id, full_name, username, avatar_id, avatar_emoji, avatar_bg_color', { realPeopleOnly })
      .then((rows) => {
        if (!live) return;
        // By name: each page is the next names after the ids already read.
        setUsers(rows);
        setLoading(false);
      }, (e: unknown) => {
        if (!live) return;
        setUsers([]);
        setLoadError(loadProblem(e));
        setLoading(false);
      });
    return () => { live = false; };
    // `load` is read when the key changes, not on every render's new closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, realPeopleOnly, attempt, loadKey, !!load]);

  // ── Name search (only with `search`) ──
  const searchQ = search ? searchableQuery(query) : null;
  const [found, setFound] = useState<{ q: string; rows: PickedUser[] } | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchAttempt, setSearchAttempt] = useState(0);
  const searchRef = useRef(search);
  searchRef.current = search;
  useEffect(() => {
    if (!visible || !searchQ || !searchRef.current) {
      setFound(null);
      setSearchError(null);
      return;
    }
    let live = true;
    setSearchError(null);
    const timer = setTimeout(() => {
      searchRef.current!(searchQ).then(
        (rows) => { if (live) setFound({ q: searchQ, rows }); },
        (e: unknown) => {
          if (!live) return;
          setFound({ q: searchQ, rows: [] });
          setSearchError(loadProblem(e));
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => { live = false; clearTimeout(timer); };
  }, [visible, searchQ, searchAttempt, loadKey]);
  // The results for what is typed now; older ones stay up (dimmed by the
  // spinner) until the new ones land, so the list doesn't flash empty.
  const searching = !!searchQ && found?.q !== searchQ && !searchError;

  const exclude = useMemo(() => new Set(excludeUserIds ?? []), [excludeUserIds]);

  const filtered = useMemo(() => {
    if (searchQ) return (found?.rows ?? []).filter(u => !exclude.has(u.id));
    const q = query.trim().toLowerCase();
    return users.filter(u => {
      if (exclude.has(u.id)) return false;
      if (!q) return true;
      return (u.full_name ?? '').toLowerCase().includes(q) || (u.username ?? '').toLowerCase().includes(q.replace(/^@/, ''));
    });
  }, [users, query, exclude, searchQ, found]);

  const listHint = !search ? null
    : query.trim().replace(/^@/, '').trim().length === 1 ? SHORT_QUERY_HINT
    : !query.trim() ? 'Type a name to search every player.'
    : null;

  const content = (
    <>
      <View style={S.header}>
        <View style={S.headerText}>
          <Text style={t.h3} accessibilityRole="header">{title}</Text>
          {subtitle ? <Text style={S.username} numberOfLines={1}>{subtitle}</Text> : null}
        </View>
        <TouchableOpacity onPress={onClose} style={S.close} accessibilityRole="button">
          <Text style={[t.title, { color: c.primary }]}>Cancel</Text>
        </TouchableOpacity>
      </View>

      <View style={S.searchRow}>
        <TextInput
          style={S.searchInput}
          placeholder="Search by name or @username…"
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

      {(searchQ ? searching && !found : loading) ? (
        <ActivityIndicator size="large" color={c.primary} style={S.spinner} />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={u => u.id}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={listHint || (searchQ && searching)
            ? (
              <View style={S.hintRow}>
                {searchQ && searching ? <ActivityIndicator size="small" color={c.primary} /> : null}
                <Text style={[t.hint, S.flexText]}>{searchQ && searching ? 'Searching every player…' : listHint}</Text>
              </View>
            )
            : null}
          ListEmptyComponent={searchQ
            ? (searchError
              ? <ErrorState
                  iconName="offline"
                  error={null}
                  message={searchError}
                  onRetry={() => setSearchAttempt(n => n + 1)}
                />
              : searching ? null
              : <EmptyState iconName="search" {...searchEmptyCopy(searchQ)} />)
            : loadError
            // A failed read is never "No matches": the message says why, with a retry.
            ? <ErrorState
                iconName="offline"
                error={null}
                message={loadError}
                onRetry={() => setAttempt(n => n + 1)}
              />
            : <EmptyState
                iconName="search"
                title="No matches."
                subtitle={load && !query.trim()
                  ? (search ? 'No one plays here yet. Try a wider radius, or type a name to search every player.' : 'No one plays here yet. Try a wider radius.')
                  : undefined}
              />}
          renderItem={({ item, index }) => {
            const cartoon = AVATARS.find(a => a.id === (item.avatar_id ?? 1)) ?? AVATARS[0];
            const emoji   = item.avatar_emoji ?? cartoon.emoji;
            const bg      = item.avatar_bg_color ?? cartoon.bgColor;
            const heading = item.section && (index === 0 || filtered[index - 1]?.section !== item.section) ? item.section : null;
            return (
              <>
              {heading ? (
                <Text style={[t.label, S.section]} accessibilityRole="header">{heading}</Text>
              ) : null}
              <TouchableOpacity
                style={S.row}
                onPress={() => onPick(item)}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={`${item.full_name}, @${item.username}${item.detail ? `, ${item.detail}` : ''}`}
              >
                <View style={[S.avatar, { backgroundColor: bg }]}>
                  <Text style={S.avatarEmoji}>{emoji}</Text>
                </View>
                <View style={S.rowText}>
                  <Text style={t.title}>{item.full_name}</Text>
                  <Text style={S.username}>@{item.username}</Text>
                  {item.detail ? <Text style={S.username} numberOfLines={1}>{item.detail}</Text> : null}
                </View>
                <Icon name="chevron-right" size={16} color={c.textMuted} />
              </TouchableOpacity>
              </>
            );
          }}
          contentContainerStyle={S.listContent}
        />
      )}
    </>
  );

  return (
    <Modal
      visible={visible}
      animationType={IS_WEB ? 'fade' : 'slide'}
      presentationStyle={IS_WEB ? undefined : 'pageSheet'}
      transparent={IS_WEB}
      onRequestClose={onClose}
    >
      {IS_WEB ? (
        <Pressable
          style={S.backdrop}
          onPress={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
          <View style={S.card}>{content}</View>
        </Pressable>
      ) : (
        <View style={S.root}>{content}</View>
      )}
      {/* Toasts and the pickle rain show above this Modal. */}
      <ToastOutlet />
    </Modal>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    root:        { flex: 1, backgroundColor: c.bg },
    backdrop:    {
      flex: 1,
      backgroundColor: c.backdrop,
      alignItems: 'center',
      justifyContent: 'center',
      padding: SPACE.lg,
    },
    card:        {
      width: '100%',
      maxWidth: 480,
      maxHeight: '85%',
      backgroundColor: c.bg,
      borderRadius: RADIUS.lg,
      overflow: 'hidden',
      borderWidth: HAIRLINE,
      borderColor: c.border,
    },
    header:      { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingVertical: SPACE.sm, paddingLeft: SPACE.lg, paddingRight: SPACE.xs, borderBottomWidth: HAIRLINE, borderBottomColor: c.border, backgroundColor: c.surface },
    headerText:  { flex: 1, minWidth: 0 },
    // Cancel: a real 44 box (react-native-web ignores hitSlop).
    close:       { minHeight: 44, minWidth: 44, paddingHorizontal: SPACE.md, alignItems: 'center', justifyContent: 'center' },

    searchRow:   { flexDirection: 'row', alignItems: 'center', padding: SPACE.md, gap: SPACE.xs, backgroundColor: c.surface, borderBottomWidth: HAIRLINE, borderBottomColor: c.border },
    searchInput: { flex: 1, minHeight: 44, borderWidth: HAIRLINE, borderColor: c.border, borderRadius: RADIUS.md, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, fontSize: FONT.size.md, color: c.text, backgroundColor: c.surfaceAlt },
    clearBtn:    { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },

    spinner:     { marginTop: SPACE.xl * 2 },
    hintRow:     { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingHorizontal: SPACE.lg, paddingVertical: SPACE.sm },
    flexText:    { flex: 1, minWidth: 0 },
    section:     { paddingHorizontal: SPACE.lg, paddingTop: SPACE.md, paddingBottom: SPACE.xs },
    listContent: { paddingBottom: SPACE.xl * 2 },
    row:         { flexDirection: 'row', alignItems: 'center', paddingVertical: SPACE.md, paddingHorizontal: SPACE.lg, borderBottomWidth: HAIRLINE, borderBottomColor: c.border, backgroundColor: c.surface, gap: SPACE.md },
    rowText:     { flex: 1, minWidth: 0 },
    avatar:      { width: 38, height: 38, borderRadius: RADIUS.pill, alignItems: 'center', justifyContent: 'center' },
    // The player's own avatar emoji (user content, kept as chosen).
    avatarEmoji: { fontSize: FONT.size.h2 },
    username:    { ...textStyles(c).hint, marginTop: SPACE.xxs / 2 },
  });
}
