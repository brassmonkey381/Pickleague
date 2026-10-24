import React, { useEffect, useRef, useState } from 'react';
import {
  Modal, View, Text, TouchableOpacity, ScrollView, StyleSheet,
  Platform, Pressable,
} from 'react-native';
import { SPACE, RADIUS, HAIRLINE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { Icon, type IconName } from '@just-messin-around/expo-foundation/icons';
import { PLAY_TAGS, TagDef } from '../data/profileCustomization';
import { useTheme } from '../lib/ThemeContext';

const IS_WEB = Platform.OS === 'web';

type Props = {
  /** Modal mode only. A page is shown whenever its host renders it. */
  visible: boolean;
  selectedTags: string[];
  maxSlots: number;
  earnedBadgeNames: string[];
  onSave: (tags: string[]) => void;
  /** Modal: Cancel / backdrop / Escape. Page: the back arrow. */
  onClose: () => void;
  /**
   * 'modal' (default): its own Modal with Cancel / Done, as before.
   * 'page': just the picker, for a host that is already a Modal (the Edit
   * profile sheet), so no second Modal opens on top. The header becomes a back
   * arrow, every toggle is reported live through `onChange`, and the host owns
   * Escape / Android back.
   */
  presentation?: 'modal' | 'page';
  /** Every change of the selection, either mode. */
  onChange?: (tags: string[]) => void;
};

export default function TagPickerModal({
  visible, selectedTags, maxSlots, earnedBadgeNames, onSave, onClose,
  presentation = 'modal', onChange,
}: Props) {
  const { colors } = useTheme();
  const S = makeStyles(colors);
  const isPage = presentation === 'page';
  // Tag accents from the theme (were hex): funny = warning orange, the
  // badge-earned group = the rare purple.
  const FUNNY_COLOR = colors.warning;
  const [selected, setSelected]         = useState<string[]>(selectedTags);
  const [lockedHint, setLockedHint]     = useState<TagDef | null>(null);

  // Report every change (not the initial value); the ref keeps an inline arrow
  // from the host from re-firing it.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const firstChange = useRef(true);
  useEffect(() => {
    if (firstChange.current) { firstChange.current = false; return; }
    onChangeRef.current?.(selected);
  }, [selected]);

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

  function Section({ title, tags, accentColor, iconName }: { title: string; tags: TagDef[]; accentColor: string; iconName?: IconName }) {
    return (
      <>
        <View style={S.sectionHead}>
          {iconName ? <Icon name={iconName} size={12} color={accentColor} /> : null}
          <Text style={[S.sectionLabel, { color: accentColor }]}>{title}</Text>
        </View>
        <View style={S.tagsRow}>
          {tags.map(tag => {
            const unlocked = isUnlocked(tag);
            const isOn = selected.includes(tag.slug);
            const atMax = selected.length >= maxSlots && !isOn;
            return (
              <TouchableOpacity
                key={tag.slug}
                style={S.chipBox}
                onPress={() => toggle(tag)}
                activeOpacity={0.7}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: isOn }}
                accessibilityLabel={unlocked ? tag.label : `${tag.label}, locked`}
              >
                <View
                  style={[
                    S.chip,
                    isOn && S.chipOn,
                    !unlocked && S.chipLocked,
                    atMax && !isOn && !unlocked && S.chipDim,
                    atMax && !isOn && unlocked && S.chipDim,
                  ]}
                >
                  {!unlocked && <Icon name="lock" size={12} color={colors.textMuted} />}
                  <Text style={[S.chipText, isOn && S.chipTextOn, !unlocked && S.chipTextLocked]}>
                    {tag.label}
                  </Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      </>
    );
  }

  const content = (
    <View style={isPage ? S.page : S.root}>
      {isPage ? (
        // Back keeps the selection: it is already in the host's draft (onChange).
        <View style={S.header}>
          <TouchableOpacity
            onPress={onClose}
            style={S.pageBackBtn}
            accessibilityRole="button"
            accessibilityLabel="Back"
          >
            <Icon name="chevron-left" size={18} color={colors.primary} />
            <Text style={S.pageBackText}>Back</Text>
          </TouchableOpacity>
          <View style={S.headerCenter}>
            <Text style={S.headerTitle}>Play Style Tags</Text>
            <Text style={S.slotCount}>{selected.length}/{maxSlots} slots used</Text>
          </View>
          <View style={S.pageBackBtn} />
        </View>
      ) : (
        <View style={S.header}>
          <TouchableOpacity onPress={onClose} style={S.headerBtn}>
            <Text style={S.headerBtnText}>Cancel</Text>
          </TouchableOpacity>
          <View style={S.headerCenter}>
            <Text style={S.headerTitle}>Play Style Tags</Text>
            <Text style={S.slotCount}>{selected.length}/{maxSlots} slots used</Text>
          </View>
          <TouchableOpacity onPress={() => onSave(selected)} style={S.headerBtn}>
            <Text style={[S.headerBtnText, { color: colors.primary, fontWeight: FONT.weight.bold }]}>Done</Text>
          </TouchableOpacity>
        </View>
      )}

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
        <Section title="Earn by Badge" iconName="lock" tags={unlockableTags} accentColor={colors.rarityRare} />

        {lockedHint && (
          <View style={S.hintCard}>
            <View style={S.hintRow}>
              <View style={S.hintBody}>
                <View style={S.hintTitleRow}>
                  <Icon name="lock" size={16} color={colors.rarityRare} />
                  <Text style={[S.hintTitle, S.flexShrink]}>"{lockedHint.label}" is locked</Text>
                </View>
                <Text style={S.hintText}>
                  Earn the <Text style={S.hintBold}>{lockedHint.unlock!.badge}</Text> badge:{'\n'}
                  {lockedHint.unlock!.description}
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => setLockedHint(null)}
                style={S.closeBox}
                accessibilityRole="button"
                accessibilityLabel="Dismiss"
              >
                <Icon name="close" size={16} color={colors.textMuted} />
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

  // The host is already a Modal: render in place.
  if (isPage) return content;

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

// Section 6 scales only: SPACE / RADIUS / HAIRLINE tokens and the textStyles
// presets (title 15/700, sub 13, meta 12/600, fieldLabel/label 11 caps).
function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  const t = textStyles(c);
  return StyleSheet.create({
    root:       { flex: 1, backgroundColor: c.surface },
    page:       { flex: 1, minHeight: 0, backgroundColor: c.surface },
    // Page header buttons: real 44 boxes (react-native-web ignores hitSlop).
    pageBackBtn:{ minWidth: 72, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: SPACE.xxs },
    pageBackText:{ ...t.title, color: c.primary },
    backdrop:   {
      flex: 1,
      backgroundColor: c.backdrop,
      alignItems: 'center',
      justifyContent: 'center',
      padding: SPACE.lg,
    },
    card:       {
      width: '100%',
      maxWidth: 520,
      maxHeight: '85%',
      backgroundColor: c.surface,
      borderRadius: RADIUS.lg,
      overflow: 'hidden',
      // An overlay card: the one place a shadow is allowed. Its colour is the
      // theme's backdrop tint rather than a hex.
      shadowColor: c.backdrop,
      shadowOpacity: 0.25,
      shadowRadius: 16,
      shadowOffset: { width: 0, height: 8 },
    },
    header:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: SPACE.lg, borderBottomWidth: HAIRLINE, borderBottomColor: c.border },
    headerTitle:t.title,
    headerCenter:{ alignItems: 'center', flex: 1 },
    slotCount:  { ...t.meta, marginTop: SPACE.xxs },
    // Modal-mode Cancel / Done: real 44 boxes too.
    headerBtn:  { minWidth: 60, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    headerBtnText: { ...t.sub, color: c.textMuted },

    scroll:     { padding: SPACE.lg, paddingBottom: SPACE.xl },

    meterRow:   { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, marginBottom: SPACE.lg, padding: SPACE.md, backgroundColor: c.bg, borderRadius: RADIUS.md },
    meterDot:   { width: 18, height: 18, borderRadius: RADIUS.pill, backgroundColor: c.border },
    meterDotFilled: { backgroundColor: c.primary },
    meterHint:  { ...t.hint, flex: 1, marginLeft: SPACE.xs },

    // Colour comes from each section's accent.
    sectionHead: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, marginTop: SPACE.lg, marginBottom: SPACE.sm },
    sectionLabel:t.label,

    // Chips sit in 44-tall boxes; the column gap shrinks so rows stay as tight as
    // before (the box's transparent padding does the spacing).
    tagsRow:    { flexDirection: 'row', flexWrap: 'wrap', columnGap: SPACE.sm, rowGap: 0 },
    chipBox:    { minHeight: 44, justifyContent: 'center' },
    chip:       { paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, borderRadius: RADIUS.pill, borderWidth: HAIRLINE, borderColor: c.border, backgroundColor: c.surfaceAlt, flexDirection: 'row', alignItems: 'center', gap: SPACE.xs },
    chipOn:     { borderColor: c.primary, backgroundColor: c.primaryLight },
    chipLocked: { borderColor: c.border, backgroundColor: c.bg },
    chipDim:    { opacity: 0.5 },
    chipText:   { ...t.sub, color: c.text },
    chipTextOn: { color: c.primary, fontWeight: FONT.weight.bold },
    chipTextLocked: { color: c.textMuted },

    hintCard:   { backgroundColor: c.rarityRareLight, borderRadius: RADIUS.md, padding: SPACE.md, marginTop: SPACE.lg, borderWidth: HAIRLINE, borderColor: c.rarityRare },
    hintRow:    { flexDirection: 'row', alignItems: 'flex-start', gap: SPACE.sm },
    hintBody:   { flex: 1 },
    hintTitleRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, marginBottom: SPACE.xs },
    hintTitle:  t.title,
    flexShrink: { flexShrink: 1 },
    hintText:   t.sub,
    hintBold:   { fontWeight: FONT.weight.bold },
    // The close glyph in a real 44 box, pulled into the card's corner padding.
    closeBox:   { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: -SPACE.md, marginRight: -SPACE.md },

    footnote:   { ...t.hint, textAlign: 'center', marginTop: SPACE.xl },
  });
}
