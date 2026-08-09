import React, { useEffect, useRef, useState } from 'react';
import {
  Modal, View, Text, TouchableOpacity, ScrollView, StyleSheet,
  Image, ActivityIndicator, Platform, Pressable, useWindowDimensions,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { supabase } from '../lib/supabase';
import { AVATARS, AvatarDef } from '../data/profileCustomization';
import { useTheme } from '../lib/ThemeContext';
import ConfirmModal from './ConfirmModal';
import { sbCall, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';

const COLS = 5;
const WEB_CARD_MAX = 560;

/** Avatars render at ~100px; anything bigger is bandwidth the user pays for. */
const AVATAR_MAX_DIM = 512;
/** Matches the native picker's `quality: 0.8`. */
const AVATAR_JPEG_QUALITY = 0.8;
/** Refuse before decoding — a 40MP phone photo can OOM the canvas step. */
const WEB_MAX_INPUT_BYTES = 20 * 1024 * 1024;
/**
 * Uploads are legitimately slow on a phone connection, so this is deliberately
 * generous — it exists only so a dead socket eventually surfaces instead of
 * spinning until the OS TCP timeout.
 */
const UPLOAD_TIMEOUT_MS = 120_000;

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

/**
 * Downscale + re-encode a picked file to a small JPEG so the web path costs
 * roughly what the native path does. Web-only: the sole caller is the
 * <input type="file"> handler, which only exists under react-native-web.
 * Resolves null when the image can't be decoded so the caller can fall back to
 * the original rather than blocking the user.
 */
function shrinkImageForWeb(file: File): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      const url = URL.createObjectURL(file);
      const img = new window.Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, AVATAR_MAX_DIM / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (!ctx) { resolve(null); return; }
          ctx.drawImage(img, 0, 0, w, h);
          canvas.toBlob((b) => resolve(b), 'image/jpeg', AVATAR_JPEG_QUALITY);
        } catch {
          resolve(null);
        } finally {
          URL.revokeObjectURL(url);
        }
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    } catch {
      resolve(null);
    }
  });
}

export default function AvatarPickerModal({
  visible, currentAvatarId, currentPhotoUrl, currentPremium, earnedBadgeNames, userId,
  purchasedAvatars, onSave, onClose,
}: Props) {
  const { colors } = useTheme();
  const { width: winW } = useWindowDimensions();
  const isWeb = Platform.OS === 'web';

  // Card has horizontal padding=16 each side (32 total); native uses full width.
  const cardWidth = isWeb ? Math.min(winW, WEB_CARD_MAX) : winW;
  const cellSize = Math.max(56, Math.floor((cardWidth - 32) / COLS) - 6);

  const S = makeStyles(colors, cellSize);
  const [selectedId, setSelectedId]                 = useState(currentAvatarId);
  const [photoUrl, setPhotoUrl]                     = useState(currentPhotoUrl);
  const [selectedPremium, setSelectedPremium]       = useState<PremiumAvatar | null>(currentPremium);
  const [lockedHint, setLockedHint]                 = useState<AvatarDef | null>(null);
  const [uploading, setUploading]                   = useState(false);
  const [errorModal, setErrorModal]                 = useState<{ title: string; body: string } | null>(null);

  const fileInputRef = useRef<any>(null);
  const uploadInFlight = useRef(false);
  // Bumped when the user walks away from a slow upload. The request can't be
  // aborted, so instead every upload carries a token and only the current one
  // is allowed to touch state — otherwise an abandoned upload landing late
  // would clobber the photo (or the spinner) of the one that replaced it.
  const uploadToken = useRef(0);

  const isUnlocked = (av: AvatarDef) =>
    !av.unlock || earnedBadgeNames.includes(av.unlock.badge);

  useEffect(() => {
    if (!isWeb || !visible) return;
    // Escape must not dismiss mid-upload — the outcome would have nowhere to go.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !uploadInFlight.current) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, onClose, isWeb]);

  function cancelUpload() {
    uploadToken.current += 1;
    uploadInFlight.current = false;
    setUploading(false);
  }

  async function uploadBlob(blob: Blob, rawExt: string) {
    if (uploadInFlight.current) return;
    const token = ++uploadToken.current;
    uploadInFlight.current = true;
    setUploading(true);
    try {
      const ext = (rawExt || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
      const fileName = `${userId}/avatar.${ext}`;
      // upsert:true makes the object path idempotent, so a retry after a dropped
      // socket overwrites rather than duplicating. Bounded generously — see
      // UPLOAD_TIMEOUT_MS — so a dead connection can't spin forever.
      await sbCall(() => supabase.storage
        .from('avatars')
        .upload(fileName, blob, { upsert: true, contentType: `image/${ext}` }),
        { retries: 1, timeoutMs: UPLOAD_TIMEOUT_MS });
      if (uploadToken.current !== token) return;
      const { data } = supabase.storage.from('avatars').getPublicUrl(fileName);
      setPhotoUrl(`${data.publicUrl}?t=${Date.now()}`);
    } catch (e) {
      if (uploadToken.current !== token) return;
      setErrorModal({
        title: 'Upload failed',
        body: friendlySbMessage(e, 'Check that the "avatars" storage bucket exists in Supabase.'),
      });
    } finally {
      if (uploadToken.current === token) {
        uploadInFlight.current = false;
        setUploading(false);
      }
    }
  }

  async function pickPhotoNative() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setErrorModal({
        title: 'Permission needed',
        body: 'Allow photo library access to upload a profile photo.',
      });
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });
    if (result.canceled) return;

    try {
      const uri = result.assets[0].uri;
      const ext = uri.split('.').pop()?.toLowerCase() ?? 'jpg';
      const response = await fetch(uri);
      const blob = await response.blob();
      await uploadBlob(blob, ext);
    } catch (e: any) {
      setErrorModal({ title: 'Upload failed', body: e?.message ?? 'Could not read image.' });
    }
  }

  function pickPhoto() {
    if (uploadInFlight.current) return;
    if (isWeb) fileInputRef.current?.click?.();
    else pickPhotoNative();
  }

  async function onWebFileChange(e: any) {
    const file: File | undefined = e?.target?.files?.[0];
    // Reset so picking the same file twice still fires onChange.
    try { e.target.value = ''; } catch {}
    if (!file) return;
    // The native picker downsizes and re-encodes at quality 0.8; the web <input>
    // handed the raw file straight to storage, so a 12MP phone photo was
    // uploaded whole over whatever connection the user had.
    if (file.size > WEB_MAX_INPUT_BYTES) {
      setErrorModal({
        title: 'Image too large',
        body: `That file is ${(file.size / 1024 / 1024).toFixed(0)}MB. Please pick one under ${WEB_MAX_INPUT_BYTES / 1024 / 1024}MB.`,
      });
      return;
    }
    const shrunk = await shrinkImageForWeb(file);
    if (shrunk) { await uploadBlob(shrunk, 'jpg'); return; }
    // Decode failed (exotic format, canvas blocked) — fall back to the original
    // rather than refusing to let the user set a photo at all.
    const ext = file.name.split('.').pop() || file.type.split('/')[1] || 'jpg';
    await uploadBlob(file, ext);
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

  // React.createElement (vs JSX <input>) avoids DOM types leaking into .tsx.
  const hiddenFileInput = isWeb
    ? React.createElement('input', {
        ref: fileInputRef,
        type: 'file',
        accept: 'image/*',
        onChange: onWebFileChange,
        style: { display: 'none' },
      })
    : null;

  const body = (
    <>
      <View style={S.header}>
        {/* Dismissing mid-upload left the outcome with nowhere to be reported,
            so Cancel stops waiting on the upload instead of closing the modal —
            the user is never trapped, and never silently left without a photo. */}
        <TouchableOpacity onPress={uploading ? cancelUpload : onClose} style={S.headerBtn}>
          <Text style={S.headerBtnText}>{uploading ? 'Cancel upload' : 'Cancel'}</Text>
        </TouchableOpacity>
        <Text style={S.headerTitle}>Choose Avatar</Text>
        <TouchableOpacity
          onPress={() => onSave(selectedId, photoUrl, photoUrl ? null : selectedPremium)}
          style={S.headerBtn}
          disabled={uploading}
        >
          <Text style={[S.headerBtnText, { color: uploading ? colors.textMuted : colors.primary, fontWeight: '700' }]}>Done</Text>
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
              <View style={S.uploadingRow}>
                <ActivityIndicator size="small" color={colors.primary} />
                <Text style={S.photoBtnText}>Uploading…</Text>
              </View>
            ) : (
              <Text style={S.photoBtnText}>📷  Upload a Photo</Text>
            )}
          </TouchableOpacity>
          {photoUrl && !uploading && (
            <TouchableOpacity style={S.removePhotoBtn} onPress={removePhoto}>
              <Text style={S.removePhotoBtnText}>Remove</Text>
            </TouchableOpacity>
          )}
          {hiddenFileInput}
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
    </>
  );

  return (
    <Modal
      visible={visible}
      animationType={isWeb ? 'fade' : 'slide'}
      transparent={isWeb}
      presentationStyle={isWeb ? undefined : 'pageSheet'}
      onRequestClose={() => { if (!uploading) onClose(); }}
    >
      {isWeb ? (
        <Pressable
          style={S.backdrop}
          onPress={(e: any) => { if (e.target === e.currentTarget && !uploading) onClose(); }}
        >
          <View style={S.card}>{body}</View>
        </Pressable>
      ) : (
        <View style={S.root}>{body}</View>
      )}

      <ConfirmModal
        visible={!!errorModal}
        title={errorModal?.title ?? ''}
        body={errorModal?.body}
        primaryLabel="OK"
        cancelLabel="Dismiss"
        onConfirm={() => setErrorModal(null)}
        onClose={() => setErrorModal(null)}
      />
    </Modal>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors'], CELL_SIZE: number) {
  return StyleSheet.create({
    root:         { flex: 1, backgroundColor: c.surface },
    backdrop:     { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 16 },
    card:         { width: '100%', maxWidth: WEB_CARD_MAX, maxHeight: '90%', backgroundColor: c.surface, borderRadius: 14, overflow: 'hidden' },

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
    uploadingRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
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
