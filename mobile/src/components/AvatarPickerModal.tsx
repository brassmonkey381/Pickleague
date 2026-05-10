import React, { useState } from 'react';
import {
  Modal, View, Text, TouchableOpacity, ScrollView, StyleSheet,
  Image, ActivityIndicator, Alert,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { supabase } from '../lib/supabase';
import { AVATARS, AvatarDef } from '../data/profileCustomization';
import { useTheme } from '../lib/ThemeContext';

const COLS = 5;

export type PremiumAvatar = {
  slug: string;
  name: string;
  emoji: string;
  bgColor: string;
};

type Props = {
  visible: boolean;
  currentAvatarId: number;
  currentPhotoUrl: string | null;
  currentPremium: PremiumAvatar | null;
  earnedBadgeNames: string[];
  userId: string;
  purchasedAvatars: PremiumAvatar[];
  onSave: (avatarId: number, photoUrl: string | null, premium: PremiumAvatar | null) => void;
  onClose: () => void;
};

export default function AvatarPickerModal({
  visible, currentAvatarId, currentPhotoUrl, currentPremium, earnedBadgeNames, userId,
  purchasedAvatars, onSave, onClose,
}: Props) {
  const { colors } = useTheme();
  const S = makeStyles(colors);
  const [selectedId, setSelectedId]                 = useState(currentAvatarId);
  const [photoUrl, setPhotoUrl]                     = useState(currentPhotoUrl);
  const [selectedPremium, setSelectedPremium]       = useState<PremiumAvatar | null>(currentPremium);
  const [lockedHint, setLockedHint]                 = useState<AvatarDef | null>(null);
  const [uploading, setUploading]                   = useState(false);

  const isUnlocked = (av: AvatarDef) =>
    !av.unlock || earnedBadgeNames.includes(av.unlock.badge);

  async function pickPhoto() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission needed', 'Allow photo library access to upload a profile photo.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });
    if (result.canceled) return;

    setUploading(true);
    try {
      const uri = result.assets[0].uri;
      const ext = uri.split('.').pop()?.toLowerCase() ?? 'jpg';
      const fileName = `${userId}/avatar.${ext}`;
      const response = await fetch(uri);
      const blob = await response.blob();
      const { error: uploadErr } = await supabase.storage
        .from('avatars')
        .upload(fileName, blob, { upsert: true, contentType: `image/${ext}` });
      if (uploadErr) throw uploadErr;
      const { data } = supabase.storage.from('avatars').getPublicUrl(fileName);
      setPhotoUrl(`${data.publicUrl}?t=${Date.now()}`);
    } catch (e: any) {
      Alert.alert('Upload failed', e.message ?? 'Check that the "avatars" storage bucket exists in Supabase.');
    } finally {
      setUploading(false);
    }
  }

  function removePhoto() {
    setPhotoUrl(null);
  }

  function handleAvatarPress(av: AvatarDef) {
    if (!isUnlocked(av)) {
      setLockedHint(av);
      return;
    }
    setLockedHint(null);
    setSelectedId(av.id);
    setSelectedPremium(null);
    if (photoUrl) setPhotoUrl(null);
  }

  function handlePremiumPress(p: PremiumAvatar) {
    setLockedHint(null);
    setSelectedPremium(p);
    if (photoUrl) setPhotoUrl(null);
  }

  const cartoonPreview = AVATARS.find(a => a.id === selectedId) ?? AVATARS[0];
  const previewEmoji   = selectedPremium ? selectedPremium.emoji   : cartoonPreview.emoji;
  const previewBg      = selectedPremium ? selectedPremium.bgColor : cartoonPreview.bgColor;
  const previewName    = photoUrl ? 'Your Photo' : selectedPremium ? selectedPremium.name : cartoonPreview.name;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={S.root}>
        <View style={S.header}>
          <TouchableOpacity onPress={onClose} style={S.headerBtn}>
            <Text style={S.headerBtnText}>Cancel</Text>
          </TouchableOpacity>
          <Text style={S.headerTitle}>Choose Avatar</Text>
          <TouchableOpacity onPress={() => onSave(selectedId, photoUrl, photoUrl ? null : selectedPremium)} style={S.headerBtn}>
            <Text style={[S.headerBtnText, { color: colors.primary, fontWeight: '700' }]}>Done</Text>
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={S.scroll} showsVerticalScrollIndicator={false}>
          <View style={S.previewSection}>
            {photoUrl ? (
              <Image source={{ uri: photoUrl }} style={S.previewPhoto} />
            ) : (
              <View style={[S.previewCircle, { backgroundColor: previewBg }]}>
                <Text style={S.previewEmoji}>{previewEmoji}</Text>
              </View>
            )}
            <Text style={S.previewName}>{previewName}</Text>
          </View>

          <View style={S.photoRow}>
            <TouchableOpacity style={S.photoBtn} onPress={pickPhoto} disabled={uploading}>
              {uploading ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : (
                <Text style={S.photoBtnText}>📷  Upload a Photo</Text>
              )}
            </TouchableOpacity>
            {photoUrl && (
              <TouchableOpacity style={S.removePhotoBtn} onPress={removePhoto}>
                <Text style={S.removePhotoBtnText}>Remove</Text>
              </TouchableOpacity>
            )}
          </View>

          {purchasedAvatars.length > 0 && (
            <>
              <Text style={S.sectionLabel}>🥒 Premium (from Shop)</Text>
              <View style={S.grid}>
                {purchasedAvatars.map(p => {
                  const selected = selectedPremium?.slug === p.slug && !photoUrl;
                  return (
                    <TouchableOpacity
                      key={p.slug}
                      style={[S.cell, selected && S.cellSelected]}
                      onPress={() => handlePremiumPress(p)}
                      activeOpacity={0.7}
                    >
                      <View style={[S.cellCircle, { backgroundColor: p.bgColor }]}>
                        <Text style={S.cellEmoji}>{p.emoji}</Text>
                      </View>
                      <Text style={S.cellName} numberOfLines={1}>{p.name}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </>
          )}

          <Text style={S.orLabel}>— or pick a cartoon avatar —</Text>

          <View style={S.grid}>
            {AVATARS.map(av => {
              const unlocked = isUnlocked(av);
              const selected = av.id === selectedId && !photoUrl && !selectedPremium;
              return (
                <TouchableOpacity
                  key={av.id}
                  style={[
                    S.cell,
                    selected && S.cellSelected,
                    !unlocked && S.cellLocked,
                  ]}
                  onPress={() => handleAvatarPress(av)}
                  activeOpacity={0.7}
                >
                  <View style={[S.cellCircle, { backgroundColor: unlocked ? av.bgColor : colors.border }]}>
                    <Text style={[S.cellEmoji, !unlocked && S.cellEmojiLocked]}>
                      {av.emoji}
                    </Text>
                    {!unlocked && <Text style={S.lockOverlay}>🔒</Text>}
                  </View>
                  <Text style={[S.cellName, !unlocked && S.cellNameLocked]} numberOfLines={1}>
                    {av.name}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {lockedHint && (
            <View style={S.hintCard}>
              <View style={S.hintRow}>
                <Text style={S.hintEmoji}>{lockedHint.emoji}</Text>
                <View style={S.hintBody}>
                  <Text style={S.hintTitle}>🔒 {lockedHint.name} is locked</Text>
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
            Unlocked avatars appear when you earn the required badge.
          </Text>
        </ScrollView>
      </View>
    </Modal>
  );
}

const CELL_SIZE = Math.floor(320 / COLS) - 4;

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    root:         { flex: 1, backgroundColor: c.surface },
    header:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: 1, borderBottomColor: c.border },
    headerTitle:  { fontSize: 17, fontWeight: '700', color: c.text },
    headerBtn:    { minWidth: 60, alignItems: 'center' },
    headerBtnText:{ fontSize: 15, color: c.textMuted },

    scroll:       { padding: 16, paddingBottom: 40 },

    previewSection:{ alignItems: 'center', marginBottom: 20 },
    previewCircle: { width: 90, height: 90, borderRadius: 45, alignItems: 'center', justifyContent: 'center', marginBottom: 8, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.12, shadowRadius: 4, elevation: 3 },
    previewPhoto:  { width: 90, height: 90, borderRadius: 45, marginBottom: 8 },
    previewEmoji:  { fontSize: 48 },
    previewName:   { fontSize: 14, color: c.textSub, fontWeight: '600' },

    photoRow:     { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 16 },
    photoBtn:     { flex: 1, borderWidth: 1.5, borderColor: c.primary, borderRadius: 10, padding: 12, alignItems: 'center' },
    photoBtnText: { fontSize: 15, color: c.primary, fontWeight: '600' },
    removePhotoBtn:  { paddingHorizontal: 14, paddingVertical: 12, borderRadius: 10, borderWidth: 1.5, borderColor: c.danger },
    removePhotoBtnText: { fontSize: 13, color: c.danger, fontWeight: '600' },

    orLabel:      { textAlign: 'center', fontSize: 13, color: c.textMuted, marginBottom: 16 },
    sectionLabel: { fontSize: 13, fontWeight: '700', color: c.textSub, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 },

    grid:         { flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-start', marginBottom: 12 },
    cell:         { width: CELL_SIZE, alignItems: 'center', padding: 4, borderRadius: 12, borderWidth: 2, borderColor: 'transparent' },
    cellSelected: { borderColor: c.primary, backgroundColor: c.primaryLight },
    cellLocked:   { opacity: 0.65 },
    cellCircle:   { width: CELL_SIZE - 12, height: CELL_SIZE - 12, borderRadius: (CELL_SIZE - 12) / 2, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
    cellEmoji:    { fontSize: 28 },
    cellEmojiLocked: { opacity: 0.5 },
    lockOverlay:  { position: 'absolute', bottom: -2, right: -2, fontSize: 13 },
    cellName:     { fontSize: 10, color: c.textSub, textAlign: 'center', fontWeight: '500' },
    cellNameLocked: { color: c.textMuted },

    hintCard:     { backgroundColor: '#fff8e1', borderRadius: 12, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: '#ffe082' },
    hintRow:      { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
    hintEmoji:    { fontSize: 32, marginTop: 2 },
    hintBody:     { flex: 1 },
    hintTitle:    { fontSize: 14, fontWeight: '700', color: '#5d4037', marginBottom: 4 },
    hintText:     { fontSize: 13, color: '#795548', lineHeight: 18 },
    hintBold:     { fontWeight: '700' },
    hintClose:    { fontSize: 16, color: c.textMuted, padding: 4 },

    footnote:     { textAlign: 'center', fontSize: 12, color: c.textMuted, marginTop: 8 },
  });
}
