import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, Pressable, ScrollView, Platform } from 'react-native';
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

  useEffect(() => {
    if (Platform.OS !== 'web' || !showDetail) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeDetail(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showDetail, closeDetail]);

  return (
    <>
      {/* Badge tile */}
      <TouchableOpacity
        style={[styles.card, allHidden && styles.cardHidden]}
        onPress={() => setShowDetail(true)}
        activeOpacity={0.75}
      >
        <Text style={[styles.icon, allHidden && styles.iconHidden]}>{badge.badge.icon}</Text>
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
            <Text style={styles.detailIcon}>{badge.badge.icon}</Text>

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
                          <Text style={styles.historyLeague}>🏆 {inst.league.name}</Text>
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
                  <Text style={styles.detailLeague}>🏆 {badge.league.name}</Text>
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
              >
                <Text style={[styles.hideBtnText, allHidden && styles.showBtnText]}>
                  {allHidden
                    ? (count > 1 ? `👁  Show all (${count}) on profile` : '👁  Show on profile')
                    : (count > 1 ? `🙈  Hide all (${count}) from profile` : '🙈  Hide from profile')}
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
  return StyleSheet.create({
    card: {
      width: 84, alignItems: 'center', backgroundColor: c.surface,
      borderRadius: 12, padding: 10, borderWidth: 1.5, borderColor: c.primaryLight,
      margin: 4, position: 'relative',
    },
    cardHidden: { backgroundColor: c.bg, borderColor: c.border, opacity: 0.55 },
    icon: { fontSize: 30, marginBottom: 5 },
    iconHidden: { opacity: 0.4 },
    name: { fontSize: 11, fontWeight: '700', color: c.text, textAlign: 'center', lineHeight: 14 },
    nameHidden: { color: c.textMuted },
    hiddenTag: { fontSize: 9, color: c.textMuted, marginTop: 3, fontStyle: 'italic' },
    leagueTag: { fontSize: 9, color: c.primary, marginTop: 3, textAlign: 'center' },

    countPill: {
      position: 'absolute', top: -6, right: -6,
      backgroundColor: c.primary, borderRadius: 10,
      paddingHorizontal: 6, paddingVertical: 2, minWidth: 22,
      alignItems: 'center', borderWidth: 1.5, borderColor: c.surface,
    },
    countPillText: { color: '#fff', fontSize: 11, fontWeight: '800' },

    overlay: {
      flex: 1, backgroundColor: 'rgba(0,0,0,0.5)',
      justifyContent: 'center', alignItems: 'center', padding: 32,
    },
    detailCard: {
      backgroundColor: c.surface, borderRadius: 20, padding: 24, width: '100%',
      alignItems: 'center', shadowColor: '#000', shadowOpacity: 0.25,
      shadowRadius: 20, elevation: 10, maxHeight: '90%',
    },
    detailIcon: { fontSize: 56, marginBottom: 12 },
    detailNameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap', justifyContent: 'center' },
    detailName: { fontSize: 20, fontWeight: '800', color: c.text },
    countChip: { paddingHorizontal: 9, paddingVertical: 3, borderRadius: 10, backgroundColor: c.primary },
    countChipText: { fontSize: 13, fontWeight: '800', color: '#fff' },
    catChip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
    catChipProfile:  { backgroundColor: c.primaryLight },
    catChipLeague:   { backgroundColor: '#e3f2fd' },
    catChipCosmetic: { backgroundColor: '#fce4ec' },
    catChipText: { fontSize: 11, fontWeight: '700' },
    catChipTextProfile:  { color: c.primary },
    catChipTextLeague:   { color: '#1565c0' },
    catChipTextCosmetic: { color: '#ad1457' },
    detailDesc: {
      fontSize: 14, color: c.textSub, textAlign: 'center',
      lineHeight: 20, marginBottom: 14,
    },
    contextBox: {
      backgroundColor: c.primaryLight, borderRadius: 10, padding: 12,
      width: '100%', marginBottom: 10,
    },
    contextLabel: { fontSize: 11, fontWeight: '700', color: c.primary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 3 },
    contextText: { fontSize: 14, color: c.text },
    detailLeague: { fontSize: 13, color: c.textMuted, marginBottom: 4 },
    detailDate: { fontSize: 12, color: c.textMuted, marginBottom: 16 },

    historyBox: { width: '100%', maxHeight: 240, marginBottom: 12 },
    historyInner: { paddingBottom: 4 },
    historyLabel: { fontSize: 11, fontWeight: '700', color: c.primary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
    historyRow: { flexDirection: 'row', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: c.border, gap: 10 },
    historyDate: { fontSize: 12, color: c.textMuted, width: 90 },
    historyMeta: { flex: 1 },
    historyContext: { fontSize: 13, color: c.text },
    historyLeague: { fontSize: 11, color: c.primary, marginTop: 2 },

    hideBtn: {
      borderWidth: 1.5, borderColor: c.border, borderRadius: 20,
      paddingHorizontal: 16, paddingVertical: 8, marginBottom: 12,
    },
    showBtn: { borderColor: c.primary, backgroundColor: c.primaryLight },
    hideBtnText: { fontSize: 14, color: c.textMuted, fontWeight: '600' },
    showBtnText: { color: c.primary },
    dismissHint: { fontSize: 11, color: c.textMuted },
  });
}
