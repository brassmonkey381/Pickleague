import React, { useEffect, useMemo, useState } from 'react';
import {
  Modal, View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, ActivityIndicator, Platform, Pressable,
} from 'react-native';
import { useTheme } from '../lib/ThemeContext';
import { loadDeviceContacts, DeviceContact } from '../lib/contacts';

type Props = {
  visible:   boolean;
  busy?:     boolean;
  onConfirm: (contacts: DeviceContact[]) => void;
  onClose:   () => void;
};

/**
 * Multi-select picker over the device's phone contacts, used to choose who to
 * group-text a guest event-vote invite. Structurally mirrors MultiUserPickerModal
 * but sources rows from expo-contacts instead of the profiles table.
 */
export default function ContactPickerModal({ visible, busy = false, onConfirm, onClose }: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);
  const isWeb = Platform.OS === 'web';

  const [contacts, setContacts] = useState<DeviceContact[]>([]);
  const [available, setAvailable] = useState(true);
  const [loading, setLoading]   = useState(true);
  const [query, setQuery]       = useState('');
  const [selectedIds, setIds]   = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    setIds(new Set());
    setQuery('');
    loadDeviceContacts().then(({ available, contacts }) => {
      setAvailable(available);
      setContacts(contacts);
      setLoading(false);
    });
  }, [visible]);

  // Escape key on web
  useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter(c => c.name.toLowerCase().includes(q) || c.phone.includes(q));
  }, [contacts, query]);

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
    onConfirm(contacts.filter(c => selectedIds.has(c.id)));
  }

  const count = selectedIds.size;
  const label = count === 0 ? 'Pick at least one' : `Text ${count} Guest${count === 1 ? '' : 's'}`;

  const cardContent = (
    <>
      <View style={S.header}>
        <Text style={S.title}>Invite guests to vote</Text>
        <TouchableOpacity onPress={onClose} disabled={busy}>
          <Text style={S.close}>Cancel</Text>
        </TouchableOpacity>
      </View>

      {!loading && !available ? (
        <View style={S.noticeWrap}>
          <Text style={S.noticeIcon}>📇</Text>
          <Text style={S.noticeTitle}>Contacts unavailable</Text>
          <Text style={S.noticeBody}>
            {isWeb
              ? 'Picking contacts works in the mobile app. On the web you can still share the invite link manually.'
              : 'Allow Contacts access for Pickleague in your device settings to pick guests to invite.'}
          </Text>
        </View>
      ) : (
        <>
          <View style={S.searchRow}>
            <TextInput
              style={S.searchInput}
              placeholder="Search contacts…"
              placeholderTextColor={c.textMuted}
              value={query}
              onChangeText={setQuery}
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
              keyExtractor={c => c.id}
              ListEmptyComponent={<Text style={S.empty}>No contacts with a phone number.</Text>}
              renderItem={({ item }) => {
                const checked = selectedIds.has(item.id);
                return (
                  <TouchableOpacity style={S.row} onPress={() => toggle(item.id)} activeOpacity={0.7}>
                    <View style={S.avatar}>
                      <Text style={S.avatarInitial}>{item.name[0]?.toUpperCase() ?? '?'}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={S.name}>{item.name}</Text>
                      <Text style={S.phone}>{item.phone}</Text>
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
                : <Text style={S.submitText}>{label}</Text>}
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

    noticeWrap:  { alignItems: 'center', padding: 32, gap: 8 },
    noticeIcon:  { fontSize: 40 },
    noticeTitle: { fontSize: 16, fontWeight: '800', color: c.text },
    noticeBody:  { fontSize: 13, color: c.textMuted, textAlign: 'center', lineHeight: 19 },

    searchRow:   { flexDirection: 'row', alignItems: 'center', padding: 12, gap: 8, backgroundColor: c.surface, borderBottomWidth: 1, borderBottomColor: c.border },
    searchInput: { flex: 1, borderWidth: 1, borderColor: c.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: c.text, backgroundColor: c.surface },
    clearBtn:    { paddingHorizontal: 12, paddingVertical: 8 },
    clearBtnText:{ fontSize: 16, color: c.textMuted, fontWeight: '700' },

    list:        { flex: 1 },
    row:         { flexDirection: 'row', alignItems: 'center', padding: 14, borderBottomWidth: 1, borderBottomColor: c.border, backgroundColor: c.surface, gap: 12 },
    avatar:      { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: c.primaryLight },
    avatarInitial: { fontSize: 16, fontWeight: '700', color: c.primary },
    name:        { fontSize: 15, fontWeight: '700', color: c.text },
    phone:       { fontSize: 12, color: c.textMuted, marginTop: 1 },
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
