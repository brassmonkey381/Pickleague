import React, { useEffect, useMemo, useState } from 'react';
import {
  Modal, View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, ActivityIndicator,
} from 'react-native';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { AVATARS } from '../data/profileCustomization';

export type MultiPickedUser = {
  id: string;
  full_name: string;
  username: string;
  avatar_id: number | null;
  avatar_emoji: string | null;
  avatar_bg_color: string | null;
};

type Props = {
  visible:         boolean;
  title:           string;
  ctaLabel?:       string;            // defaults to "Send {N} Invites"
  excludeUserIds?: string[];          // hide self / existing members
  busy?:           boolean;
  onConfirm:       (users: MultiPickedUser[]) => void;
  onClose:         () => void;
};

export default function MultiUserPickerModal({
  visible, title, ctaLabel, excludeUserIds, busy = false, onConfirm, onClose,
}: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);

  const [users, setUsers]       = useState<MultiPickedUser[]>([]);
  const [loading, setLoading]   = useState(true);
  const [query, setQuery]       = useState('');
  const [selectedIds, setIds]   = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    setIds(new Set());
    setQuery('');
    supabase
      .from('profiles')
      .select('id, full_name, username, avatar_id, avatar_emoji, avatar_bg_color')
      .order('full_name')
      .limit(500)
      .then(({ data }) => {
        setUsers((data ?? []) as MultiPickedUser[]);
        setLoading(false);
      });
  }, [visible]);

  const exclude = useMemo(() => new Set(excludeUserIds ?? []), [excludeUserIds]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return users.filter(u => {
      if (exclude.has(u.id)) return false;
      if (!q) return true;
      return u.full_name.toLowerCase().includes(q) || u.username.toLowerCase().includes(q);
    });
  }, [users, query, exclude]);

  function toggle(id: string) {
    setIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function submit() {
    if (selectedIds.size === 0 || busy) return;
    onConfirm(users.filter(u => selectedIds.has(u.id)));
  }

  const count = selectedIds.size;
  const label = ctaLabel ?? (count === 0 ? 'Pick at least one' : `Send ${count} Invite${count === 1 ? '' : 's'}`);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={S.root}>
        <View style={S.header}>
          <Text style={S.title}>{title}</Text>
          <TouchableOpacity onPress={onClose} disabled={busy}>
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
            ListEmptyComponent={<Text style={S.empty}>No matches.</Text>}
            renderItem={({ item }) => {
              const cartoon = AVATARS.find(a => a.id === (item.avatar_id ?? 1)) ?? AVATARS[0];
              const emoji   = item.avatar_emoji ?? cartoon.emoji;
              const bg      = item.avatar_bg_color ?? cartoon.bgColor;
              const checked = selectedIds.has(item.id);
              return (
                <TouchableOpacity style={S.row} onPress={() => toggle(item.id)} activeOpacity={0.7}>
                  <View style={[S.avatar, { backgroundColor: bg }]}>
                    <Text style={S.avatarEmoji}>{emoji}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={S.name}>{item.full_name}</Text>
                    <Text style={S.username}>@{item.username}</Text>
                  </View>
                  <View style={[S.checkbox, checked && S.checkboxChecked]}>
                    {checked && <Text style={S.checkmark}>✓</Text>}
                  </View>
                </TouchableOpacity>
              );
            }}
            contentContainerStyle={{ paddingBottom: 100 }}
          />
        )}

        <View style={S.footer}>
          <TouchableOpacity
            style={[S.submitBtn, (count === 0 || busy) && S.submitBtnDim]}
            disabled={count === 0 || busy}
            onPress={submit}
          >
            {busy
              ? <ActivityIndicator color="#fff" />
              : <Text style={S.submitText}>{label}</Text>}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    root:        { flex: 1, backgroundColor: c.bg },
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
    checkbox:    { width: 26, height: 26, borderRadius: 6, borderWidth: 2, borderColor: c.border, alignItems: 'center', justifyContent: 'center', backgroundColor: c.surface },
    checkboxChecked: { borderColor: c.primary, backgroundColor: c.primary },
    checkmark:   { color: '#fff', fontWeight: '800', fontSize: 16 },
    empty:       { textAlign: 'center', color: c.textMuted, marginTop: 60, fontSize: 14 },

    footer:      { position: 'absolute', bottom: 0, left: 0, right: 0, padding: 16, backgroundColor: c.surface, borderTopWidth: 1, borderTopColor: c.border },
    submitBtn:   { backgroundColor: c.primary, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
    submitBtnDim:{ backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
    submitText:  { color: '#fff', fontSize: 15, fontWeight: '800' },
  });
}
