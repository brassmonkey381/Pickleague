import React, { useEffect, useMemo, useState } from 'react';
import {
  Modal, View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, ActivityIndicator, Platform, Pressable,
} from 'react-native';
import { useTheme } from '../lib/ThemeContext';

// How a single item renders in the list. Wrappers map their domain object
// (profile, contact, …) to this shape; the base owns all the chrome.
export type MultiSelectRow = {
  id: string;                 // stable key + selection identity
  primary: string;            // main label
  secondary?: string;         // sub label
  left?: React.ReactNode;     // avatar / initial visual
};

type Props<T> = {
  visible:            boolean;
  title:              string;
  items:              T[];
  loading:            boolean;
  /** Map an item to its row presentation. */
  toRow:              (item: T) => MultiSelectRow;
  /** Text matched against the search query. */
  searchText:         (item: T) => string;
  /** CTA label given the current selection count. */
  ctaLabel:           (count: number) => string;
  searchPlaceholder?: string;
  emptyText?:         string;
  /** When set (and not loading), replaces the search/list/footer — e.g. a
   *  "contacts unavailable" notice. The header (title + Cancel) still shows. */
  notice?:            React.ReactNode | null;
  busy?:              boolean;
  onConfirm:          (items: T[]) => void;
  onClose:            () => void;
};

/**
 * Generic multi-select modal: search + checkbox list + confirm footer, with the
 * web (centered card) vs native (pageSheet) chrome. MultiUserPickerModal and
 * ContactPickerModal are thin wrappers that supply data + row rendering.
 */
export default function MultiSelectModal<T>({
  visible, title, items, loading, toRow, searchText, ctaLabel,
  searchPlaceholder, emptyText, notice, busy = false, onConfirm, onClose,
}: Props<T>) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);
  const isWeb = Platform.OS === 'web';

  const [query, setQuery]     = useState('');
  const [selectedIds, setIds] = useState<Set<string>>(new Set());

  // Reset selection + query each time the modal opens.
  useEffect(() => {
    if (!visible) return;
    setIds(new Set());
    setQuery('');
  }, [visible]);

  // Escape key on web.
  useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, onClose]);

  const rows = useMemo(
    () => items.map(item => ({ item, row: toRow(item) })),
    [items, toRow],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(({ item }) => searchText(item).toLowerCase().includes(q));
  }, [rows, query, searchText]);

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
    onConfirm(rows.filter(({ row }) => selectedIds.has(row.id)).map(({ item }) => item));
  }

  const count = selectedIds.size;

  const cardContent = (
    <>
      <View style={S.header}>
        <Text style={S.title}>{title}</Text>
        <TouchableOpacity onPress={onClose} disabled={busy}>
          <Text style={S.close}>Cancel</Text>
        </TouchableOpacity>
      </View>

      {!loading && notice ? (
        <View style={S.noticeWrap}>{notice}</View>
      ) : (
        <>
          <View style={S.searchRow}>
            <TextInput
              style={S.searchInput}
              placeholder={searchPlaceholder ?? 'Search…'}
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
              style={S.list}
              data={filtered}
              keyExtractor={({ row }) => row.id}
              ListEmptyComponent={<Text style={S.empty}>{emptyText ?? 'No matches.'}</Text>}
              renderItem={({ item: { row } }) => {
                const checked = selectedIds.has(row.id);
                return (
                  <TouchableOpacity style={S.row} onPress={() => toggle(row.id)} activeOpacity={0.7}>
                    {row.left != null && <View>{row.left}</View>}
                    <View style={{ flex: 1 }}>
                      <Text style={S.name}>{row.primary}</Text>
                      {row.secondary ? <Text style={S.sub}>{row.secondary}</Text> : null}
                    </View>
                    <View style={[S.checkbox, checked && S.checkboxChecked]}>
                      {checked && <Text style={S.checkmark}>✓</Text>}
                    </View>
                  </TouchableOpacity>
                );
              }}
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
                : <Text style={S.submitText}>{ctaLabel(count)}</Text>}
            </TouchableOpacity>
          </View>
        </>
      )}
    </>
  );

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle={isWeb ? undefined : 'pageSheet'}
      transparent={isWeb}
      onRequestClose={onClose}
    >
      {isWeb ? (
        <Pressable
          style={S.backdrop}
          onPress={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
          <View style={S.card}>{cardContent}</View>
        </Pressable>
      ) : (
        <View style={S.root}>{cardContent}</View>
      )}
    </Modal>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    root:        { flex: 1, backgroundColor: c.bg, flexDirection: 'column' },
    backdrop:    { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: 16 },
    card:        { width: '100%', maxWidth: 480, maxHeight: '85%', backgroundColor: c.bg, borderRadius: 16, overflow: 'hidden', flexDirection: 'column' },
    header:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: 1, borderBottomColor: c.border, backgroundColor: c.surface },
    title:       { fontSize: 17, fontWeight: '800', color: c.text, flex: 1 },
    close:       { fontSize: 14, color: c.primary, fontWeight: '700' },

    noticeWrap:  { padding: 8 },

    searchRow:   { flexDirection: 'row', alignItems: 'center', padding: 12, gap: 8, backgroundColor: c.surface, borderBottomWidth: 1, borderBottomColor: c.border },
    searchInput: { flex: 1, borderWidth: 1, borderColor: c.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: c.text, backgroundColor: c.surface },
    clearBtn:    { paddingHorizontal: 12, paddingVertical: 8 },
    clearBtnText:{ fontSize: 16, color: c.textMuted, fontWeight: '700' },

    list:        { flex: 1 },
    row:         { flexDirection: 'row', alignItems: 'center', padding: 14, borderBottomWidth: 1, borderBottomColor: c.border, backgroundColor: c.surface, gap: 12 },
    name:        { fontSize: 15, fontWeight: '700', color: c.text },
    sub:         { fontSize: 12, color: c.textMuted, marginTop: 1 },
    checkbox:    { width: 26, height: 26, borderRadius: 6, borderWidth: 2, borderColor: c.border, alignItems: 'center', justifyContent: 'center', backgroundColor: c.surface },
    checkboxChecked: { borderColor: c.primary, backgroundColor: c.primary },
    checkmark:   { color: '#fff', fontWeight: '800', fontSize: 16 },
    empty:       { textAlign: 'center', color: c.textMuted, marginTop: 60, fontSize: 14 },

    footer:      { padding: 16, backgroundColor: c.surface, borderTopWidth: 1, borderTopColor: c.border },
    submitBtn:   { backgroundColor: c.primary, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
    submitBtnDim:{ backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
    submitText:  { color: '#fff', fontSize: 15, fontWeight: '800' },
  });
}
