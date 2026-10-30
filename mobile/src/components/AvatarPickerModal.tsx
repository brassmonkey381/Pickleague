import React, { useEffect, useRef, useState } from 'react';
import {
  Modal, View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator, Platform, Pressable, useWindowDimensions,
} from 'react-native';
import { CachedImage } from '@just-messin-around/expo-foundation/ui/CachedImage';
import { SPACE, RADIUS, HAIRLINE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import * as ImagePicker from 'expo-image-picker';
import { supabase } from '../lib/supabase';
import { AVATARS, AvatarDef } from '../data/profileCustomization';
import { useTheme } from '../lib/ThemeContext';
import ConfirmModal from './ConfirmModal';
import { sbCall, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { ToastOutlet } from '@just-messin-around/expo-foundation/toast';

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
  /** The Shop item (shop_items.id): what equip_shop_item is called with. */
  itemId?: string;
};

type Props = {
  /** Modal mode only. A page is shown whenever its host renders it. */
  visible: boolean;
  currentAvatarId: number;
  currentPhotoUrl: string | null;
  currentPremium: PremiumAvatar | null;
  earnedBadgeNames: string[];
  userId: string;
  purchasedAvatars: PremiumAvatar[];
  onSave: (avatarId: number, photoUrl: string | null, premium: PremiumAvatar | null) => void;
  /** Modal: Cancel / backdrop / Escape. Page: the back arrow (the host returns
   *  to its form). */
  onClose: () => void;
  /**
   * 'modal' (default): its own Modal with Cancel / Done, as before.
   * 'page': just the picker body, for a host that is already a Modal (the Edit
   * profile sheet), so a second Modal never opens on top (iOS shows one at a
   * time, and a picked avatar used to be lost when the outer form wasn't
   * saved). The header becomes a back arrow; every pick is reported live
   * through `onChange`, so the host's draft is current whenever the user
   * leaves the page. Upload errors show inline instead of in a ConfirmModal,
   * and the host owns Escape / Android back.
   */
  presentation?: 'modal' | 'page';
  /** Every change of the selection (same arguments as onSave), either mode. */
  onChange?: (avatarId: number, photoUrl: string | null, premium: PremiumAvatar | null) => void;
  /** An upload started / finished. A page host uses it to block leaving the
   *  page mid-upload (the result would have nowhere to go). */
  onUploadingChange?: (uploading: boolean) => void;
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
  purchasedAvatars, onSave, onClose, presentation = 'modal', onChange, onUploadingChange,
}: Props) {
  const { colors } = useTheme();
  const { width: winW } = useWindowDimensions();
  const isWeb = Platform.OS === 'web';
  const isPage = presentation === 'page';

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

  // Report every change of the selection (not the initial values). Refs hold
  // the latest callbacks so an inline arrow from the host doesn't re-fire it.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onUploadingRef = useRef(onUploadingChange);
  onUploadingRef.current = onUploadingChange;
  const firstSelection = useRef(true);
  useEffect(() => {
    if (firstSelection.current) { firstSelection.current = false; return; }
    onChangeRef.current?.(selectedId, photoUrl, photoUrl ? null : selectedPremium);
  }, [selectedId, photoUrl, selectedPremium]);
  const firstUploading = useRef(true);
  useEffect(() => {
    if (firstUploading.current) { firstUploading.current = false; return; }
    onUploadingRef.current?.(uploading);
  }, [uploading]);

  function cancelUpload() {
    uploadToken.current += 1;
    uploadInFlight.current = false;
    setUploading(false);
  }

  async function uploadBlob(blob: Blob | ArrayBuffer, rawExt: string) {
    if (uploadInFlight.current) return;
    const token = ++uploadToken.current;
    uploadInFlight.current = true;
    setUploading(true);
    try {
      const ext = (rawExt || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
      // A unique object per upload. The fixed `avatar.<ext>` path used to be
      // overwritten the moment a photo was picked, and the saved avatar_url
      // points at that same object, so a photo picked and then discarded (Edit
      // sheet Cancel) went live for everyone anyway. Now only Save, by writing
      // avatar_url, makes a photo live; EditProfileSheet prunes the leftovers.
      // The storage policies key on the first folder (`<uid>/`), so any name
      // under it is allowed, and moderation removes the whole folder.
      const fileName = `${userId}/avatar-${Date.now()}.${ext}`;
      // upsert:true keeps the sbCall retry idempotent (it reuses this fileName)
      // after a dropped socket. Bounded generously — see UPLOAD_TIMEOUT_MS — so
      // a dead connection can't spin forever.
      await sbCall(() => supabase.storage
        .from('avatars')
        .upload(fileName, blob, { upsert: true, contentType: ext === 'jpg' ? 'image/jpeg' : `image/${ext}` }),
        { retries: 1, timeoutMs: UPLOAD_TIMEOUT_MS });
      if (uploadToken.current !== token) return;
      const { data } = supabase.storage.from('avatars').getPublicUrl(fileName);
      // The URL is unique per upload, so ?t= is no longer needed; harmless.
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
      // The bytes come back as base64: fetch(file://).blob() gives a 0-byte
      // blob on iOS, which uploaded an empty file (a blank avatar after Save).
      base64: true,
    });
    if (result.canceled) return;

    try {
      const asset = result.assets[0];
      const ext = asset.uri.split('.').pop()?.toLowerCase() ?? 'jpg';
      if (!asset.base64) throw new Error('Could not read image.');
      const bin = atob(asset.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      if (!bytes.length) throw new Error('That photo is empty. Pick a different one.');
      await uploadBlob(bytes.buffer, ext);
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

  const pageHeader = isPage ? (
    <View style={S.header}>
      {/* Back keeps the pick (it is already in the host's draft via onChange);
          mid-upload it stops waiting instead, exactly like Cancel below. */}
      <TouchableOpacity
        onPress={uploading ? cancelUpload : onClose}
        style={S.pageBackBtn}
        accessibilityRole="button"
        accessibilityLabel={uploading ? 'Cancel upload' : 'Back'}
      >
        {uploading ? null : <Icon name="chevron-left" size={18} color={colors.primary} />}
        <Text style={S.pageBackText} numberOfLines={1}>{uploading ? 'Cancel upload' : 'Back'}</Text>
      </TouchableOpacity>
      <Text style={S.headerTitle}>Choose Avatar</Text>
      <View style={S.pageBackBtn} />
    </View>
  ) : null;

  const body = (
    <>
      {pageHeader ?? <View style={S.header}>
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
          <Text style={[S.headerBtnText, { color: uploading ? colors.textMuted : colors.primary, fontWeight: FONT.weight.bold }]}>Done</Text>
        </TouchableOpacity>
      </View>}

      {isPage && errorModal ? (
        <View style={S.inlineError}>
          <View style={S.hintBody}>
            <Text style={S.inlineErrorTitle}>{errorModal.title}</Text>
            {errorModal.body ? <Text style={S.inlineErrorText}>{errorModal.body}</Text> : null}
          </View>
          <TouchableOpacity
            onPress={() => setErrorModal(null)}
            style={S.closeBox}
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
          >
            <Icon name="close" size={16} color={colors.textMuted} />
          </TouchableOpacity>
        </View>
      ) : null}

      <ScrollView contentContainerStyle={S.scroll} showsVerticalScrollIndicator={false}>
        <View style={S.previewSection}>
          {photoUrl ? (
            <CachedImage source={{ uri: photoUrl }} style={S.previewPhoto} />
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
              <View style={S.uploadingRow}>
                <Icon name="camera" size={16} color={colors.primary} />
                <Text style={S.photoBtnText}>Upload a Photo</Text>
              </View>
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
            <View style={S.sectionHead}>
              <Icon name="pickle" size={12} color={colors.primary} />
              <Text style={S.sectionLabel}>Premium (from Shop)</Text>
            </View>
            <View style={S.grid}>
              {purchasedAvatars.map(p => {
                const selected = selectedPremium?.slug === p.slug && !photoUrl;
                return (
                  <TouchableOpacity
                    key={p.slug}
                    style={[S.cell, selected && S.cellSelected]}
                    onPress={() => handlePremiumPress(p)}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel={p.name}
                    accessibilityState={{ selected }}
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
                // The lock glyph is hidden from screen readers, so the label says it.
                accessibilityRole="button"
                accessibilityLabel={unlocked ? av.name : `${av.name}, locked`}
                accessibilityState={{ selected }}
              >
                <View style={[S.cellCircle, { backgroundColor: unlocked ? av.bgColor : colors.border }]}>
                  <Text style={[S.cellEmoji, !unlocked && S.cellEmojiLocked]}>
                    {av.emoji}
                  </Text>
                  {!unlocked && (
                    <View style={S.lockOverlay}>
                      <Icon name="lock" size={12} color={colors.textSub} />
                    </View>
                  )}
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
                <View style={S.hintTitleRow}>
                  <Icon name="lock" size={16} color={colors.warning} />
                  <Text style={[S.hintTitle, S.flexShrink]}>{lockedHint.name} is locked</Text>
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
          Unlocked avatars appear when you earn the required badge.
        </Text>
      </ScrollView>
    </>
  );

  if (isPage) {
    // The host is already a Modal: render in place (flex:1 so the ScrollView
    // fills the host's page area). The hidden <input> stays inside `body`.
    return <View style={S.page}>{body}</View>;
  }

  return (
    <Modal
      visible={visible}
      animationType={isWeb ? 'fade' : 'slide'}
      transparent={isWeb}
      presentationStyle={isWeb ? undefined : 'pageSheet'}
      // Escape (web, via RNW's Modal) and Android back: not mid-upload, the
      // outcome would have nowhere to go.
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
      {/* Toasts and the pickle rain show above this Modal. */}
      <ToastOutlet />
    </Modal>
  );
}

// Section 6 scales only: SPACE / RADIUS / HAIRLINE tokens and the textStyles
// presets. The emoji sizes are glyphs inside fixed circles, not text.
function makeStyles(c: ReturnType<typeof useTheme>['colors'], CELL_SIZE: number) {
  const t = textStyles(c);
  return StyleSheet.create({
    root:         { flex: 1, backgroundColor: c.surface },
    page:         { flex: 1, minHeight: 0, backgroundColor: c.surface },
    // Page header buttons: real 44 boxes (react-native-web ignores hitSlop).
    pageBackBtn:  { minWidth: 88, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: SPACE.xxs },
    pageBackText: { ...t.title, color: c.primary },
    backdrop:     { flex: 1, backgroundColor: c.backdrop, justifyContent: 'center', alignItems: 'center', padding: SPACE.lg },
    card:         { width: '100%', maxWidth: WEB_CARD_MAX, maxHeight: '90%', backgroundColor: c.surface, borderRadius: RADIUS.lg, overflow: 'hidden' },

    header:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: SPACE.lg, borderBottomWidth: HAIRLINE, borderBottomColor: c.border },
    headerTitle:  t.title,
    // Modal-mode Cancel / Done: real 44 boxes too.
    headerBtn:    { minWidth: 60, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    headerBtnText:{ ...t.sub, color: c.textMuted },

    // Horizontal padding is the 32 the cell-size math above subtracts.
    scroll:       { padding: SPACE.lg, paddingBottom: SPACE.xl },

    previewSection:{ alignItems: 'center', marginBottom: SPACE.lg },
    previewCircle: { width: 90, height: 90, borderRadius: RADIUS.pill, alignItems: 'center', justifyContent: 'center', marginBottom: SPACE.sm },
    previewPhoto:  { width: 90, height: 90, borderRadius: RADIUS.pill, marginBottom: SPACE.sm },
    previewEmoji:  { fontSize: 48 },
    previewName:   t.sub,

    photoRow:     { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, marginBottom: SPACE.lg },
    photoBtn:     { flex: 1, minHeight: 44, justifyContent: 'center', borderWidth: HAIRLINE, borderColor: c.primary, borderRadius: RADIUS.md, padding: SPACE.md, alignItems: 'center' },
    photoBtnText: { ...t.title, color: c.primary },
    uploadingRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
    removePhotoBtn:  { minHeight: 44, justifyContent: 'center', paddingHorizontal: SPACE.md, paddingVertical: SPACE.md, borderRadius: RADIUS.md, borderWidth: HAIRLINE, borderColor: c.danger },
    removePhotoBtnText: { ...t.sub, color: c.danger },

    orLabel:      { ...t.hint, textAlign: 'center', marginBottom: SPACE.lg },
    sectionHead:  { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, marginBottom: SPACE.sm },
    sectionLabel: t.fieldLabel,

    // gap stays within the 6px per cell the cell-size math leaves, so five
    // cells still fit a row.
    grid:         { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs, justifyContent: 'flex-start', marginBottom: SPACE.md },
    // The 2px outline marks the selected cell (a selection state, not a divider).
    cell:         { width: CELL_SIZE, alignItems: 'center', padding: SPACE.xs, borderRadius: RADIUS.md, borderWidth: 2, borderColor: 'transparent' },
    cellSelected: { borderColor: c.primary, backgroundColor: c.primaryLight },
    cellLocked:   { opacity: 0.65 },
    cellCircle:   { width: CELL_SIZE - 12, height: CELL_SIZE - 12, borderRadius: RADIUS.pill, alignItems: 'center', justifyContent: 'center', marginBottom: SPACE.xs },
    cellEmoji:    { fontSize: 28 },
    cellEmojiLocked: { opacity: 0.5 },
    // The lock sits in a small surface disc on the circle's corner.
    lockOverlay:  {
      position: 'absolute', bottom: -SPACE.xxs, right: -SPACE.xxs, width: 20, height: 20,
      borderRadius: RADIUS.pill, backgroundColor: c.surface, borderWidth: HAIRLINE, borderColor: c.border,
      alignItems: 'center', justifyContent: 'center',
    },
    cellName:     { fontSize: FONT.size.xxs, color: c.textSub, textAlign: 'center', fontWeight: FONT.weight.medium },
    cellNameLocked: { color: c.textMuted },

    hintCard:     { backgroundColor: c.warningLight, borderRadius: RADIUS.md, padding: SPACE.md, marginBottom: SPACE.md, borderWidth: HAIRLINE, borderColor: c.warning },
    hintRow:      { flexDirection: 'row', alignItems: 'flex-start', gap: SPACE.md },
    hintEmoji:    { fontSize: 32, marginTop: SPACE.xxs },
    hintBody:     { flex: 1 },
    hintTitleRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, marginBottom: SPACE.xs },
    hintTitle:    t.title,
    flexShrink:   { flexShrink: 1 },
    hintText:     t.sub,
    hintBold:     { fontWeight: FONT.weight.bold },
    // The close glyph in a real 44 box, pulled into the card's corner padding.
    closeBox:     { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: -SPACE.md, marginRight: -SPACE.md },

    // Page mode: upload errors render inline (no second Modal over the host).
    inlineError:      { flexDirection: 'row', alignItems: 'flex-start', gap: SPACE.sm, marginHorizontal: SPACE.lg, marginTop: SPACE.md, padding: SPACE.md, borderRadius: RADIUS.md, borderWidth: HAIRLINE, borderColor: c.danger, backgroundColor: c.dangerLight },
    inlineErrorTitle: { ...t.title, color: c.danger, marginBottom: SPACE.xxs },
    inlineErrorText:  { ...t.sub, color: c.text },

    footnote:     { ...t.hint, textAlign: 'center', marginTop: SPACE.sm },
  });
}
