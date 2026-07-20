import React, { useEffect, useMemo, useState } from 'react';
import {
  Modal, View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, ActivityIndicator, Platform, Pressable,
} from 'react-native';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { AVATARS } from '../data/profileCustomization';
import EmptyState from './EmptyState';

export type PickedUser = {
  id: string;
  full_name: string;
  username: string;
  avatar_id: number | null;
  avatar_emoji: string | null;
  avatar_bg_color: string | null;
};

type Props = {
  visible: boolean;
  title: string;
  excludeUserIds?: string[];     // hide self / already-owners
  onPick: (u: PickedUser) => void;
  onClose: () => void;
};

const IS_WEB = Platform.OS === 'web';

export default function UserPickerModal({ visible, title, excludeUserIds, onPick, onClose }: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);
  const [users, setUsers]     = useState<PickedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery]     = useState('');

  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    supabase
      .from('profiles')
      .select('id, full_name, username, avatar_id, avatar_emoji, avatar_bg_color')
      .order('full_name')
      .limit(500)
      .then(({ data }) => {
        setUsers((data ?? []) as PickedUser[]);
        setLoading(false);
      });
  }, [visible]);

  useEffect(() => {
    if (!IS_WEB || !visible) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, onClose]);

  const exclude = useMemo(() => new Set(excludeUserIds ?? []), [excludeUserIds]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return users.filter(u => {
      if (exclude.has(u.id)) return false;
      if (!q) return true;
      return u.full_name.toLowerCase().includes(q) || u.username.toLowerCase().includes(q);
    });
  }, [users, query, exclude]);

  const content = (
    <>
      <View style={S.header}>
        <Text style={S.title}>{title}</Text>
        <TouchableOpacity onPress={onClose}>
          <Text style={S.close}>Cancel</Text>
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
          <TouchableOpacity style={S.clearBtn} onPress={() => setQuery('')}>
            <Text style={S.clearBtnText}>✕</Text>
          </TouchableOpacity>
        )}
      </View>

      {loading ? (
        <ActivityIndicator size="large" color={c.primary} style={{ marginTop: 60 }} />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={u => u.id}
          ListEmptyComponent={<EmptyState icon="🔍" title="No matches." />}
          renderItem={({ item }) => {
            const cartoon = AVATARS.find(a => a.id === (item.avatar_id ?? 1)) ?? AVATARS[0];
            const emoji   = item.avatar_emoji ?? cartoon.emoji;
            const bg      = item.avatar_bg_color ?? cartoon.bgColor;
            return (
              <TouchableOpacity style={S.row} onPress={() => onPick(item)} activeOpacity={0.7}>
                <View style={[S.avatar, { backgroundColor: bg }]}>
                  <Text style={S.avatarEmoji}>{emoji}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={S.name}>{item.full_name}</Text>
                  <Text style={S.username}>@{item.username}</Text>
                </View>
                <Text style={S.chevron}>›</Text>
              </TouchableOpacity>
            );
          }}
          contentContainerStyle={{ paddingBottom: 40 }}
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
    </Modal>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    root:        { flex: 1, backgroundColor: c.bg },
    backdrop:    {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.5)',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 16,
    },
    card:        {
      width: '100%',
      maxWidth: 480,
      maxHeight: '85%',
      backgroundColor: c.bg,
      borderRadius: 14,
      overflow: 'hidden',
      borderWidth: 1,
      borderColor: c.border,
    },
    header:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: 1, borderBottomColor: c.border, backgroundColor: c.surface },
    title:       { fontSize: 17, fontWeight: '800', color: c.text, flex: 1 },
    close:       { fontSize: 14, color: c.primary, fontWeight: '700' },

    searchRow:   { flexDirection: 'row', alignItems: 'center', padding: 12, gap: 8, backgroundColor: c.surface, borderBottomWidth: 1, borderBottomColor: c.border },
    searchInput: { flex: 1, borderWidth: 1, borderColor: c.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: c.text, backgroundColor: c.surface },
    clearBtn:    { paddingHorizontal: 12, paddingVertical: 8 },
    clearBtnText:{ fontSize: 16, color: c.textMuted, fontWeight: '700' },

    row:         { flexDirection: 'row', alignItems: 'center', padding: 14, borderBottomWidth: 1, borderBottomColor: c.border, backgroundColor: c.surface, gap: 12 },
    avatar:      { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
    avatarEmoji: { fontSize: 20 },
    name:        { fontSize: 15, fontWeight: '700', color: c.text },
    username:    { fontSize: 12, color: c.textMuted, marginTop: 1 },
    chevron:     { fontSize: 20, color: c.textMuted },
  });
}
