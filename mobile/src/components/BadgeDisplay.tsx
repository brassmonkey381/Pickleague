import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, Pressable } from 'react-native';
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
    category: 'profile' | 'league';
  };
  league?: { name: string } | null;
};

type Props = {
  badge: BadgeItem;
  isOwner?: boolean;
  onToggleHide?: (id: string, hidden: boolean) => void;
};

export default function BadgeDisplay({ badge, isOwner, onToggleHide }: Props) {
  const { colors: c } = useTheme();
  const styles = makeStyles(c);
  const [showDetail, setShowDetail] = useState(false);
  const hidden = badge.is_hidden;

  const earnedDate = new Date(badge.earned_at).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  });

  return (
    <>
      {/* Badge tile */}
      <TouchableOpacity
        style={[styles.card, hidden && styles.cardHidden]}
        onPress={() => setShowDetail(true)}
        activeOpacity={0.75}
      >
        <Text style={[styles.icon, hidden && styles.iconHidden]}>{badge.badge.icon}</Text>
        <Text style={[styles.name, hidden && styles.nameHidden]} numberOfLines={2}>
          {badge.badge.name}
        </Text>
        {hidden && isOwner && <Text style={styles.hiddenTag}>Hidden</Text>}
        {badge.league?.name && (
          <Text style={styles.leagueTag} numberOfLines={1}>{badge.league.name}</Text>
        )}
      </TouchableOpacity>

      {/* Detail modal */}
      <Modal
        visible={showDetail}
        transparent
        animationType="fade"
        onRequestClose={() => setShowDetail(false)}
      >
        <Pressable style={styles.overlay} onPress={() => setShowDetail(false)}>
          {/* Stop propagation so tapping the card doesn't dismiss */}
          <Pressable style={styles.detailCard} onPress={() => {}}>
            {/* Big icon */}
            <Text style={styles.detailIcon}>{badge.badge.icon}</Text>

            {/* Name + category chip */}
            <View style={styles.detailNameRow}>
              <Text style={styles.detailName}>{badge.badge.name}</Text>
              <View style={[styles.catChip, badge.badge.category === 'league' ? styles.catChipLeague : styles.catChipProfile]}>
                <Text style={[styles.catChipText, badge.badge.category === 'league' ? styles.catChipTextLeague : styles.catChipTextProfile]}>
                  {badge.badge.category === 'league' ? 'League' : 'Profile'}
                </Text>
              </View>
            </View>

            {/* Description */}
            <Text style={styles.detailDesc}>{badge.badge.description}</Text>

            {/* Why earned */}
            {badge.context && (
              <View style={styles.contextBox}>
                <Text style={styles.contextLabel}>Why you earned this</Text>
                <Text style={styles.contextText}>{badge.context}</Text>
              </View>
            )}

            {/* League */}
            {badge.league?.name && (
              <Text style={styles.detailLeague}>🏆 {badge.league.name}</Text>
            )}

            {/* Earned date */}
            <Text style={styles.detailDate}>Earned {earnedDate}</Text>

            {/* Owner: hide/show toggle */}
            {isOwner && (
              <TouchableOpacity
                style={[styles.hideBtn, hidden && styles.showBtn]}
                onPress={() => {
                  onToggleHide?.(badge.id, !hidden);
                  setShowDetail(false);
                }}
              >
                <Text style={[styles.hideBtnText, hidden && styles.showBtnText]}>
                  {hidden ? '👁  Show on profile' : '🙈  Hide from profile'}
                </Text>
              </TouchableOpacity>
            )}

            {/* Dismiss hint */}
            <Text style={styles.dismissHint}>Tap outside to close</Text>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    // Badge tile
    card: {
      width: 84, alignItems: 'center', backgroundColor: c.surface,
      borderRadius: 12, padding: 10, borderWidth: 1.5, borderColor: c.primaryLight,
      margin: 4,
    },
    cardHidden: { backgroundColor: c.bg, borderColor: c.border, opacity: 0.55 },
    icon: { fontSize: 30, marginBottom: 5 },
    iconHidden: { opacity: 0.4 },
    name: { fontSize: 11, fontWeight: '700', color: c.text, textAlign: 'center', lineHeight: 14 },
    nameHidden: { color: c.textMuted },
    hiddenTag: { fontSize: 9, color: c.textMuted, marginTop: 3, fontStyle: 'italic' },
    leagueTag: { fontSize: 9, color: c.primary, marginTop: 3, textAlign: 'center' },

    // Modal overlay
    overlay: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.5)',
      justifyContent: 'center',
      alignItems: 'center',
      padding: 32,
    },

    // Detail card
    detailCard: {
      backgroundColor: c.surface,
      borderRadius: 20,
      padding: 24,
      width: '100%',
      alignItems: 'center',
      shadowColor: '#000',
      shadowOpacity: 0.25,
      shadowRadius: 20,
      elevation: 10,
    },
    detailIcon: { fontSize: 56, marginBottom: 12 },
    detailNameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
    detailName: { fontSize: 20, fontWeight: '800', color: c.text },
    catChip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
    catChipProfile: { backgroundColor: c.primaryLight },
    catChipLeague: { backgroundColor: '#e3f2fd' },
    catChipText: { fontSize: 11, fontWeight: '700' },
    catChipTextProfile: { color: c.primary },
    catChipTextLeague: { color: '#1565c0' },
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
