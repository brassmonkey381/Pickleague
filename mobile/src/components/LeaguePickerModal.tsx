import React, { useEffect, useMemo, useState } from 'react';
import {
  Modal, View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, Platform, Pressable,
} from 'react-native';
import { useTheme } from '../lib/ThemeContext';

export type PickableLeague = { id: string; name: string };

type Props = {
  visible: boolean;
  leagues: PickableLeague[];
  selectedId: string | null;
  onPick: (id: string) => void;
  onClose: () => void;
};

const IS_WEB = Platform.OS === 'web';

// Simple league picker following UserPickerModal's web-centered / mobile-sheet
// pattern. The candidate list is supplied by the caller (already filtered to
// leagues all selected players belong to).
export default function LeaguePickerModal({ visible, leagues, selectedId, onPick, onClose }: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!IS_WEB || !visible) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return leagues;
    return leagues.filter(l => l.name.toLowerCase().includes(q));
  }, [leagues, query]);

  const content = (
    <>
      <View style={S.header}>
        <Text style={S.title}>Choose a league</Text>
        <TouchableOpacity onPress={onClose}>
          <Text style={S.close}>Cancel</Text>
        </TouchableOpacity>
      </View>

      <View style={S.searchRow}>
        <TextInput
          style={S.searchInput}
          placeholder="Search leagues…"
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

      <FlatList
        data={filtered}
        keyExtractor={l => l.id}
        ListEmptyComponent={
          <Text style={S.empty}>
            {leagues.length === 0
              ? 'No league has all the selected players as members.'
              : 'No matches.'}
          </Text>
        }
        renderItem={({ item }) => {
          const active = item.id === selectedId;
          return (
            <TouchableOpacity style={S.row} onPress={() => onPick(item.id)} activeOpacity={0.7}>
              <Text style={S.name}>{item.name}</Text>
              {active && <Text style={S.checkmark}>✓</Text>}
            </TouchableOpacity>
          );
        }}
        contentContainerStyle={{ paddingBottom: 40 }}
      />
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
    backdrop:    { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: 16 },
    card:        { width: '100%', maxWidth: 480, maxHeight: '85%', backgroundColor: c.bg, borderRadius: 14, overflow: 'hidden', borderWidth: 1, borderColor: c.border },
    header:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: 1, borderBottomColor: c.border, backgroundColor: c.surface },
    title:       { fontSize: 17, fontWeight: '800', color: c.text, flex: 1 },
    close:       { fontSize: 14, color: c.primary, fontWeight: '700' },
    searchRow:   { flexDirection: 'row', alignItems: 'center', padding: 12, gap: 8, backgroundColor: c.surface, borderBottomWidth: 1, borderBottomColor: c.border },
    searchInput: { flex: 1, borderWidth: 1, borderColor: c.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: c.text, backgroundColor: c.surface },
    clearBtn:    { paddingHorizontal: 12, paddingVertical: 8 },
    clearBtnText:{ fontSize: 16, color: c.textMuted, fontWeight: '700' },
    row:         { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 14, borderBottomWidth: 1, borderBottomColor: c.border, backgroundColor: c.surface, gap: 12 },
    name:        { fontSize: 15, fontWeight: '700', color: c.text, flex: 1 },
    checkmark:   { fontSize: 18, fontWeight: '800', color: c.primary },
    empty:       { textAlign: 'center', color: c.textMuted, marginTop: 40, fontSize: 14, paddingHorizontal: 24, lineHeight: 20 },
  });
}
