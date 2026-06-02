import React, { useEffect, useMemo, useState } from 'react';
import {
  Modal, View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, Platform, Pressable,
} from 'react-native';
import { useTheme } from '../lib/ThemeContext';

// status/league_id are carried so callers can filter the candidate list
// (e.g. to active tournaments within the selected league); the modal itself
// only renders id + name.
export type PickableTournament = { id: string; name: string; status?: string; league_id?: string | null };

type Props = {
  visible: boolean;
  tournaments: PickableTournament[];
  selectedId: string | null;
  // null selects the "(none)" option (clears the tag).
  onPick: (id: string | null) => void;
  onClose: () => void;
};

const IS_WEB = Platform.OS === 'web';

// Optional tournament tag picker. Always offers a "(none)" row so the user can
// clear the tag. Candidate list is supplied by the caller (already filtered to
// tournaments all selected players are approved registrants of).
export default function TournamentPickerModal({ visible, tournaments, selectedId, onPick, onClose }: Props) {
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
    if (!q) return tournaments;
    return tournaments.filter(t => t.name.toLowerCase().includes(q));
  }, [tournaments, query]);

  // The "(none)" sentinel row is prepended so it's always available.
  const NONE_ID = '__none__';

  const content = (
    <>
      <View style={S.header}>
        <Text style={S.title}>Tag a tournament</Text>
        <TouchableOpacity onPress={onClose}>
          <Text style={S.close}>Cancel</Text>
        </TouchableOpacity>
      </View>

      <View style={S.searchRow}>
        <TextInput
          style={S.searchInput}
          placeholder="Search tournaments…"
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
        data={[{ id: NONE_ID, name: '(none)' }, ...filtered]}
        keyExtractor={t => t.id}
        ListEmptyComponent={null}
        renderItem={({ item }) => {
          const isNone = item.id === NONE_ID;
          const active = isNone ? !selectedId : item.id === selectedId;
          return (
            <TouchableOpacity
              style={S.row}
              onPress={() => onPick(isNone ? null : item.id)}
              activeOpacity={0.7}
            >
              <Text style={[S.name, isNone && S.noneName]}>{item.name}</Text>
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
    noneName:    { color: c.textMuted, fontStyle: 'italic' },
    checkmark:   { fontSize: 18, fontWeight: '800', color: c.primary },
    empty:       { textAlign: 'center', color: c.textMuted, marginTop: 40, fontSize: 14 },
  });
}
