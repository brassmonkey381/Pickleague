import React, { useState, useMemo, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, Pressable, ScrollView } from 'react-native';
import { Icon, EmojiGlyph } from '@just-messin-around/expo-foundation/icons';
import { SPACE, RADIUS, HAIRLINE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../lib/ThemeContext';

export type BadgeItem = {
  id: string;
  badge_id: string;
  is_hidden: boolean;
  earned_at: string;
  context: string | null;
  league_id: string | null;
  badge: {
    name: string;
    description: string;
    icon: string;
    category: 'profile' | 'league' | 'cosmetic';
  };
  league?: { name: string } | null;
};

function categoryLabel(c: BadgeItem['badge']['category']) {
  return c === 'league' ? 'League' : c === 'cosmetic' ? 'Cosmetic' : 'Profile';
}

type Props = {
  // Single representative badge (newest occurrence). If `stack` is supplied,
  // the tile shows a ×N pill and the modal lists every occurrence.
  badge: BadgeItem;
  stack?: BadgeItem[];
  isOwner?: boolean;
  // When stacked, the toggle applies to every instance of the badge.
  onToggleHide?: (ids: string[], hidden: boolean) => void;
};

export default function BadgeDisplay({ badge, stack, isOwner, onToggleHide }: Props) {
  const { colors: c } = useTheme();
  const styles = makeStyles(c);
  const [showDetail, setShowDetail] = useState(false);

  const instances = useMemo(() => {
    const list = stack && stack.length > 0 ? stack : [badge];
    // Newest first
    return [...list].sort((a, b) =>
      new Date(b.earned_at).getTime() - new Date(a.earned_at).getTime()
    );
  }, [stack, badge]);

  const count = instances.length;
  // A group is "hidden" only when every instance is hidden. Anything shown
  // counts as visible — tapping toggles all of them at once.
  const allHidden = instances.every(b => b.is_hidden);

  const earnedDate = new Date(badge.earned_at).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  });

  const closeDetail = useCallback(() => setShowDetail(false), []);

  return (
    <>
      {/* Badge tile */}
      <TouchableOpacity
        style={[styles.card, allHidden && styles.cardHidden]}
        onPress={() => setShowDetail(true)}
        activeOpacity={0.75}
        accessibilityRole="button"
        accessibilityLabel={`${badge.badge.name} badge${count > 1 ? `, earned ${count} times` : ''}${allHidden && isOwner ? ', hidden' : ''}`}
      >
        {/* The stored emoji draws as our glyph when one maps (else the emoji). */}
        <View style={styles.icon}>
          <EmojiGlyph
            emoji={badge.badge.icon}
            size={28}
            color={allHidden ? c.textMuted : c.primary}
            style={allHidden ? styles.iconHidden : undefined}
          />
        </View>
        <Text style={[styles.name, allHidden && styles.nameHidden]} numberOfLines={2}>
          {badge.badge.name}
        </Text>
        {count > 1 && (
          <View style={styles.countPill}>
            <Text style={styles.countPillText}>×{count}</Text>
          </View>
        )}
        {allHidden && isOwner && <Text style={styles.hiddenTag}>Hidden</Text>}
        {count === 1 && badge.league?.name && (
          <Text style={styles.leagueTag} numberOfLines={1}>{badge.league.name}</Text>
        )}
      </TouchableOpacity>

      {/* Detail modal */}
      <Modal
        visible={showDetail}
        transparent
        animationType="fade"
        onRequestClose={closeDetail}
      >
        <Pressable
          style={styles.overlay}
          onPress={(e) => { if (e.target === e.currentTarget) closeDetail(); }}
        >
          <View style={styles.detailCard}>
            <View style={styles.detailIcon}>
              <EmojiGlyph emoji={badge.badge.icon} size={48} color={c.primary} />
            </View>

            <View style={styles.detailNameRow}>
              <Text style={styles.detailName}>{badge.badge.name}</Text>
              {count > 1 && (
                <View style={styles.countChip}>
                  <Text style={styles.countChipText}>×{count}</Text>
                </View>
              )}
              <View style={[
                styles.catChip,
                badge.badge.category === 'league'   && styles.catChipLeague,
                badge.badge.category === 'cosmetic' && styles.catChipCosmetic,
                badge.badge.category === 'profile'  && styles.catChipProfile,
              ]}>
                <Text style={[
                  styles.catChipText,
                  badge.badge.category === 'league'   && styles.catChipTextLeague,
                  badge.badge.category === 'cosmetic' && styles.catChipTextCosmetic,
                  badge.badge.category === 'profile'  && styles.catChipTextProfile,
                ]}>
                  {categoryLabel(badge.badge.category)}
                </Text>
              </View>
            </View>

            <Text style={styles.detailDesc}>{badge.badge.description}</Text>

            {count > 1 ? (
              <ScrollView style={styles.historyBox} contentContainerStyle={styles.historyInner}>
                <Text style={styles.historyLabel}>Earned {count} times</Text>
                {instances.map(inst => {
                  const d = new Date(inst.earned_at).toLocaleDateString(undefined, {
                    month: 'short', day: 'numeric', year: 'numeric',
                  });
                  return (
                    <View key={inst.id} style={styles.historyRow}>
                      <Text style={styles.historyDate}>{d}</Text>
                      <View style={styles.historyMeta}>
                        {inst.context && <Text style={styles.historyContext}>{inst.context}</Text>}
                        {inst.league?.name && (
                          <View style={styles.leagueLine}>
                            <Icon name="pickleball" size={12} color={c.primary} />
                            <Text style={styles.historyLeague} numberOfLines={1}>{inst.league.name}</Text>
                          </View>
                        )}
                      </View>
                    </View>
                  );
                })}
              </ScrollView>
            ) : (
              <>
                {badge.context && (
                  <View style={styles.contextBox}>
                    <Text style={styles.contextLabel}>Why you earned this</Text>
                    <Text style={styles.contextText}>{badge.context}</Text>
                  </View>
                )}
                {badge.league?.name && (
                  <View style={[styles.leagueLine, styles.detailLeagueLine]}>
                    <Icon name="pickleball" size={14} color={c.textMuted} />
                    <Text style={styles.detailLeague} numberOfLines={1}>{badge.league.name}</Text>
                  </View>
                )}
                <Text style={styles.detailDate}>Earned {earnedDate}</Text>
              </>
            )}

            {isOwner && (
              <TouchableOpacity
                style={[styles.hideBtn, allHidden && styles.showBtn]}
                onPress={() => {
                  onToggleHide?.(instances.map(i => i.id), !allHidden);
                  setShowDetail(false);
                }}
                accessibilityRole="button"
              >
                <Icon name={allHidden ? 'eye' : 'eye-off'} size={16} color={allHidden ? c.primary : c.textMuted} />
                <Text style={[styles.hideBtnText, allHidden && styles.showBtnText]}>
                  {allHidden
                    ? (count > 1 ? `Show all (${count}) on profile` : 'Show on profile')
                    : (count > 1 ? `Hide all (${count}) from profile` : 'Hide from profile')}
                </Text>
              </TouchableOpacity>
            )}

            <Text style={styles.dismissHint}>Tap outside to close</Text>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  const t = textStyles(c);
  return StyleSheet.create({
    card: {
      width: 84, alignItems: 'center', backgroundColor: c.surface,
      borderRadius: RADIUS.md, padding: SPACE.sm, borderWidth: HAIRLINE, borderColor: c.primaryLight,
      margin: SPACE.xs, position: 'relative',
    },
    cardHidden: { backgroundColor: c.bg, borderColor: c.border, opacity: 0.55 },
    icon: { height: 32, alignItems: 'center', justifyContent: 'center', marginBottom: SPACE.xs },
    // The emoji fallback only (a glyph is drawn in the muted token instead).
    iconHidden: { opacity: 0.5 },
    name: { fontSize: FONT.size.xs, fontWeight: FONT.weight.bold, color: c.text, textAlign: 'center', lineHeight: 14 },
    nameHidden: { color: c.textMuted },
    hiddenTag: { fontSize: FONT.size.xxs, color: c.textMuted, marginTop: SPACE.xxs, fontStyle: 'italic' },
    leagueTag: { fontSize: FONT.size.xxs, color: c.primary, marginTop: SPACE.xxs, textAlign: 'center' },

    countPill: {
      position: 'absolute', top: -SPACE.xs, right: -SPACE.xs,
      backgroundColor: c.primary, borderRadius: RADIUS.pill,
      paddingHorizontal: SPACE.xs, paddingVertical: SPACE.xxs, minWidth: 22,
      alignItems: 'center', borderWidth: HAIRLINE, borderColor: c.surface,
    },
    countPillText: { color: c.textInverse, fontSize: FONT.size.xs, fontWeight: FONT.weight.heavy },

    overlay: {
      flex: 1, backgroundColor: c.backdrop,
      justifyContent: 'center', alignItems: 'center', padding: SPACE.xl,
    },
    detailCard: {
      backgroundColor: c.surface, borderRadius: RADIUS.lg, padding: SPACE.xl, width: '100%',
      alignItems: 'center', shadowColor: c.shadow, shadowOpacity: 0.25,
      shadowRadius: 20, elevation: 10, maxHeight: '90%',
    },
    detailIcon: { marginBottom: SPACE.md },
    detailNameRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, marginBottom: SPACE.sm, flexWrap: 'wrap', justifyContent: 'center' },
    detailName: t.h2,
    countChip: { paddingHorizontal: SPACE.sm, paddingVertical: SPACE.xxs, borderRadius: RADIUS.pill, backgroundColor: c.primary },
    countChipText: { fontSize: FONT.size.base, fontWeight: FONT.weight.heavy, color: c.textInverse },
    catChip: { paddingHorizontal: SPACE.sm, paddingVertical: SPACE.xxs, borderRadius: RADIUS.pill },
    catChipProfile:  { backgroundColor: c.primaryLight },
    catChipLeague:   { backgroundColor: c.infoLight },
    catChipCosmetic: { backgroundColor: c.rarityRareLight },
    catChipText: { fontSize: FONT.size.xs, fontWeight: FONT.weight.bold },
    catChipTextProfile:  { color: c.primary },
    catChipTextLeague:   { color: c.info },
    catChipTextCosmetic: { color: c.rarityRare },
    detailDesc: {
      fontSize: FONT.size.md, color: c.textSub, textAlign: 'center',
      lineHeight: FONT.line.normal, marginBottom: SPACE.md,
    },
    contextBox: {
      backgroundColor: c.primaryLight, borderRadius: RADIUS.md, padding: SPACE.md,
      width: '100%', marginBottom: SPACE.sm,
    },
    contextLabel: { ...t.label, marginBottom: SPACE.xxs },
    contextText: { fontSize: FONT.size.md, color: c.text },
    leagueLine: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, marginTop: SPACE.xxs },
    detailLeagueLine: { marginTop: 0, marginBottom: SPACE.xs, maxWidth: '100%' },
    detailLeague: { fontSize: FONT.size.base, color: c.textMuted, flexShrink: 1 },
    detailDate: { fontSize: FONT.size.sm, color: c.textMuted, marginBottom: SPACE.lg },

    historyBox: { width: '100%', maxHeight: 240, marginBottom: SPACE.md },
    historyInner: { paddingBottom: SPACE.xs },
    historyLabel: { ...t.label, marginBottom: SPACE.sm },
    historyRow: { flexDirection: 'row', paddingVertical: SPACE.xs, borderBottomWidth: HAIRLINE, borderBottomColor: c.border, gap: SPACE.sm },
    historyDate: { fontSize: FONT.size.sm, color: c.textMuted, width: 90 },
    historyMeta: { flex: 1, minWidth: 0 },
    historyContext: { fontSize: FONT.size.base, color: c.text },
    historyLeague: { fontSize: FONT.size.xs, color: c.primary, flexShrink: 1 },

    hideBtn: {
      flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, minHeight: 44,
      borderWidth: HAIRLINE, borderColor: c.border, borderRadius: RADIUS.pill,
      paddingHorizontal: SPACE.lg, paddingVertical: SPACE.sm, marginBottom: SPACE.md,
    },
    showBtn: { borderColor: c.primary, backgroundColor: c.primaryLight },
    hideBtnText: { fontSize: FONT.size.md, color: c.textMuted, fontWeight: FONT.weight.semibold },
    showBtnText: { color: c.primary },
    dismissHint: { fontSize: FONT.size.xs, color: c.textMuted },
  });
}
