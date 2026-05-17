import React, { useEffect, useState } from 'react';
import {
  Modal, View, Text, TouchableOpacity, ScrollView, StyleSheet,
  Platform, Pressable,
} from 'react-native';
import { PLAY_TAGS, TagDef } from '../data/profileCustomization';
import { useTheme } from '../lib/ThemeContext';

const FUNNY_COLOR = '#e65100';
const IS_WEB = Platform.OS === 'web';

type Props = {
  visible: boolean;
  selectedTags: string[];
  maxSlots: number;
  earnedBadgeNames: string[];
  onSave: (tags: string[]) => void;
  onClose: () => void;
};

export default function TagPickerModal({
  visible, selectedTags, maxSlots, earnedBadgeNames, onSave, onClose,
}: Props) {
  const { colors } = useTheme();
  const S = makeStyles(colors);
  const [selected, setSelected]         = useState<string[]>(selectedTags);
  const [lockedHint, setLockedHint]     = useState<TagDef | null>(null);

  useEffect(() => {
    if (!IS_WEB || !visible) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, onClose]);

  const isUnlocked = (t: TagDef) =>
    !t.unlock || earnedBadgeNames.includes(t.unlock.badge);

  function toggle(tag: TagDef) {
    if (!isUnlocked(tag)) {
      setLockedHint(tag);
      return;
    }
    setLockedHint(null);
    setSelected(prev => {
      if (prev.includes(tag.slug)) return prev.filter(s => s !== tag.slug);
      if (prev.length >= maxSlots) return prev;
      return [...prev, tag.slug];
    });
  }

  const freeTags       = PLAY_TAGS.filter(t => !t.unlock && !t.funny);
  const funnyTags      = PLAY_TAGS.filter(t => !t.unlock && t.funny);
  const unlockableTags = PLAY_TAGS.filter(t => !!t.unlock);

  function Section({ title, tags, accentColor }: { title: string; tags: TagDef[]; accentColor: string }) {
    return (
      <>
        <Text style={[S.sectionLabel, { color: accentColor }]}>{title}</Text>
        <View style={S.tagsRow}>
          {tags.map(tag => {
            const unlocked = isUnlocked(tag);
            const isOn = selected.includes(tag.slug);
            const atMax = selected.length >= maxSlots && !isOn;
            return (
              <TouchableOpacity
                key={tag.slug}
                style={[
                  S.chip,
                  isOn && S.chipOn,
                  !unlocked && S.chipLocked,
                  atMax && !isOn && !unlocked && S.chipDim,
                  atMax && !isOn && unlocked && S.chipDim,
                ]}
                onPress={() => toggle(tag)}
                activeOpacity={0.7}
              >
                {!unlocked && <Text style={S.chipLock}>🔒 </Text>}
                <Text style={[S.chipText, isOn && S.chipTextOn, !unlocked && S.chipTextLocked]}>
                  {tag.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </>
    );
  }

  const content = (
    <View style={S.root}>
      <View style={S.header}>
        <TouchableOpacity onPress={onClose} style={S.headerBtn}>
          <Text style={S.headerBtnText}>Cancel</Text>
        </TouchableOpacity>
        <View style={S.headerCenter}>
          <Text style={S.headerTitle}>Play Style Tags</Text>
          <Text style={S.slotCount}>{selected.length}/{maxSlots} slots used</Text>
        </View>
        <TouchableOpacity onPress={() => onSave(selected)} style={S.headerBtn}>
          <Text style={[S.headerBtnText, { color: colors.primary, fontWeight: '700' }]}>Done</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={S.scroll} showsVerticalScrollIndicator={false}>
        <View style={S.meterRow}>
          {Array.from({ length: maxSlots }).map((_, i) => (
            <View key={i} style={[S.meterDot, i < selected.length && S.meterDotFilled]} />
          ))}
          <Text style={S.meterHint}>
            {selected.length === maxSlots ? 'All slots filled — tap a tag to deselect' : `Tap tags to select (${maxSlots - selected.length} left)`}
          </Text>
        </View>

        <Section title="Serious" tags={freeTags}  accentColor={colors.primary} />
        <Section title="Funny"   tags={funnyTags}  accentColor={FUNNY_COLOR} />
        <Section title="🔒 Earn by Badge" tags={unlockableTags} accentColor="#7b5ea7" />

        {lockedHint && (
          <View style={S.hintCard}>
            <View style={S.hintRow}>
              <View style={S.hintBody}>
                <Text style={S.hintTitle}>🔒 "{lockedHint.label}" is locked</Text>
                <Text style={S.hintText}>
                  Earn the <Text style={S.hintBold}>{lockedHint.unlock!.badge}</Text> badge:{'\n'}
                  {lockedHint.unlock!.description}
                </Text>
              </View>
              <TouchableOpacity onPress={() => setLockedHint(null)}>
                <Text style={S.hintClose}>✕</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        <Text style={S.footnote}>
          Unlock more tags and tag slots by earning badges.
        </Text>
      </ScrollView>
    </View>
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
        content
      )}
    </Modal>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    root:       { flex: 1, backgroundColor: c.surface },
    backdrop:   {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.5)',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 16,
    },
    card:       {
      width: '100%',
      maxWidth: 520,
      maxHeight: '85%',
      backgroundColor: c.surface,
      borderRadius: 12,
      overflow: 'hidden',
      shadowColor: '#000',
      shadowOpacity: 0.25,
      shadowRadius: 16,
      shadowOffset: { width: 0, height: 8 },
    },
    header:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: 1, borderBottomColor: c.border },
    headerTitle:{ fontSize: 17, fontWeight: '700', color: c.text },
    headerCenter:{ alignItems: 'center', flex: 1 },
    slotCount:  { fontSize: 12, color: c.textMuted, marginTop: 2 },
    headerBtn:  { minWidth: 60, alignItems: 'center' },
    headerBtnText: { fontSize: 15, color: c.textMuted },

    scroll:     { padding: 16, paddingBottom: 40 },

    meterRow:   { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 20, padding: 12, backgroundColor: c.bg, borderRadius: 10 },
    meterDot:   { width: 18, height: 18, borderRadius: 9, backgroundColor: c.border },
    meterDotFilled: { backgroundColor: c.primary },
    meterHint:  { fontSize: 12, color: c.textMuted, flex: 1, marginLeft: 4 },

    sectionLabel:{ fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8, marginTop: 16, marginBottom: 8 },

    tagsRow:    { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    chip:       { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 20, borderWidth: 1.5, borderColor: c.border, backgroundColor: c.surfaceAlt, flexDirection: 'row', alignItems: 'center' },
    chipOn:     { borderColor: c.primary, backgroundColor: c.primaryLight },
    chipLocked: { borderColor: c.border, backgroundColor: c.bg },
    chipDim:    { opacity: 0.5 },
    chipText:   { fontSize: 13, color: c.text, fontWeight: '500' },
    chipTextOn: { color: c.primary, fontWeight: '700' },
    chipTextLocked: { color: c.textMuted },
    chipLock:   { fontSize: 11 },

    hintCard:   { backgroundColor: '#f3e5f5', borderRadius: 12, padding: 14, marginTop: 16, borderWidth: 1, borderColor: '#ce93d8' },
    hintRow:    { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
    hintBody:   { flex: 1 },
    hintTitle:  { fontSize: 14, fontWeight: '700', color: '#4a148c', marginBottom: 4 },
    hintText:   { fontSize: 13, color: '#6a1b9a', lineHeight: 18 },
    hintBold:   { fontWeight: '700' },
    hintClose:  { fontSize: 16, color: c.textMuted, padding: 4 },

    footnote:   { textAlign: 'center', fontSize: 12, color: c.textMuted, marginTop: 24 },
  });
}
